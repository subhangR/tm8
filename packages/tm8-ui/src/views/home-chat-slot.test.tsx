// @vitest-environment jsdom
/**
 * HOME HOSTS THE ENTITY CHAT SLOT (entity chat 01a0da4e §3.1, Q4, Q7),
 * driven through the COMPOSED app:
 *
 *   · the slot is a THIRD column after the Trail — rail · list · entity ·
 *     chat — on the shared `PanelResizer`, 420 by default, width remembered;
 *   · the shell's interim dock stands aside on Home (`surfaceHostsChatSlot`);
 *   · Q4: walking the Trail, re-rooting it from A and switching A's root do
 *     NOT touch the slot — it stays pinned to its subject until closed.
 *
 * jsdom applies no stylesheet, so the <1200px overlay is pinned on the sheet's
 * SOURCE below, paired with the DOM structure asserted here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { GateApp } from './GateApp';
import { HOME_CHAT_COLUMN_MIN_VIEWPORT, HOME_CHAT_DEFAULT } from './HomeView';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { surfaceHostsChatSlot } from '../entity-chat';

const SPACE = 'sp-atelier';
let storage: Map<string, string>;
const innerWidth = window.innerWidth;

beforeEach(() => {
  storage = new Map<string, string>();
  const store = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: (i: number) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  /* jsdom cannot measure the row, so the solver falls back to the window: a
     wide one, so the column's ceiling is not what decides its width. */
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  resetNav();
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

async function openTask(view: ReturnType<typeof render>): Promise<EntityId> {
  fireEvent.click(within(view.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ }));
  const list = await waitFor(() => view.getByTestId('tch-hosted-list'));
  fireEvent.click(within(list).getByRole('tab', { name: /^In Progress/ }));
  fireEvent.click(await waitFor(() => within(list).getByText('Session tree guide lines')));
  await waitFor(() => view.getByTestId('tch-center-override'));
  const id = navStore.getState().stack[0];
  expect(id).toBeTruthy();
  return id as EntityId;
}

describe('Home hosts the chat slot as a third column (§3.1)', () => {
  it('draws the slot AFTER the Trail, on a resizer at 420, and the dock stands aside', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/home`)} />);
    await waitFor(() => view.getByTestId('home-page'));
    const task = await openTask(view);
    expect(view.queryByTestId('hp-chat-column')).toBeNull();

    navStore.getState().openChat({ about: task, thread: 'new' });

    const column = await waitFor(() => view.getByTestId('hp-chat-column'));
    expect(view.queryByTestId('entity-chat-dock')).toBeNull();
    /* The entity is still readable beside it, and the column is the LAST
       region of the row: rail · list · entity · chat. */
    expect(view.getByTestId('tch-center-override')).toBeTruthy();
    const host = column.parentElement!;
    expect(host.classList.contains('hp-host')).toBe(true);
    const page = view.getByTestId('home-page');
    expect(page.compareDocumentPosition(column) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(column.querySelector('.ecp')).toBeTruthy();

    const separator = within(view.getByTestId('hp-chat-separator')).getByRole('separator', {
      name: 'Resize Chat panel',
    });
    expect(separator.getAttribute('aria-valuenow')).toBe(String(HOME_CHAT_DEFAULT));
    expect(host.style.getPropertyValue('--hp-chat')).toBe(`${HOME_CHAT_DEFAULT}px`);
    expect(host.getAttribute('data-chat-open')).toBe('true');

    /* Closing takes the column away, and the row's marker with it. */
    navStore.getState().closeChat();
    await waitFor(() => expect(view.queryByTestId('hp-chat-column')).toBeNull());
    expect(host.hasAttribute('data-chat-open')).toBe(false);
  });

  it('a `new` slot is the COMPOSER, never the space\'s newest chat about something else', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/home`)} />);
    await waitFor(() => view.getByTestId('home-page'));
    const task = await openTask(view);
    navStore.getState().openChat({ about: task, thread: 'new' });
    const column = await waitFor(() => view.getByTestId('hp-chat-column'));
    /* Mounted through `EntityChatSlot`: the new-chat settings card (§3.4,
       lane C) comes first — the fixture space has no chat default — and
       Start chat hands over to a surface that cold-starts on the composer; a
       bare chat surface would open the latest thread instead. */
    fireEvent.click(await within(column).findByTestId('new-chat-start', {}, { timeout: 5000 }));
    await waitFor(() => within(column).getByPlaceholderText('What are we doing?'), { timeout: 5000 });
    expect(within(column).queryByPlaceholderText('Type a message…')).toBeNull();
    expect(within(column).queryByTestId('chat-about-relation')).toBeNull();
    expect(navStore.getState().chat).toEqual({ about: task, thread: 'new' });
  });

  it('remembers the width the viewer drags it to', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/home`)} />);
    await waitFor(() => view.getByTestId('home-page'));
    const task = await openTask(view);
    navStore.getState().openChat({ about: task, thread: 'new' });
    const separator = await waitFor(() =>
      within(view.getByTestId('hp-chat-separator')).getByRole('separator'),
    );
    /* The column is to the RIGHT of its handle: a step left widens it. */
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    await waitFor(() => expect(separator.getAttribute('aria-valuenow')).toBe('436'));
    expect(storage.get('tm8ui.panel-width.home.chat')).toBe('436');

    navStore.getState().closeChat();
    navStore.getState().openChat({ about: task, thread: 'new' });
    const again = await waitFor(() =>
      within(view.getByTestId('hp-chat-separator')).getByRole('separator'),
    );
    expect(again.getAttribute('aria-valuenow')).toBe('436');
  });
});

describe('the slot is PINNED on Home (Q4)', () => {
  it('walking the Trail, re-rooting it and switching A leave the slot where it is', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('home-page'));
    const task = await openTask(view);
    const slot = { about: task, thread: 'new' as const };
    navStore.getState().openChat(slot);
    await waitFor(() => view.getByTestId('hp-chat-column'));
    await waitFor(() => expect(target.getHash()).toContain('ca='));

    const other = 'ent-trail-hop' as EntityId;
    const pinned = async () => {
      expect(navStore.getState().chat).toEqual(slot);
      await waitFor(() => view.getByTestId('hp-chat-column'));
    };

    /* Along the Trail: a hop, a crumb back, Esc back to the root. */
    navStore.getState().trailPush(other);
    await pinned();
    navStore.getState().cursorTo(task);
    await pinned();
    fireEvent.keyDown(document, { key: 'Escape' });
    await pinned();
    /* Re-rooting from column A. */
    navStore.getState().openCenter(other);
    await pinned();
    /* Switching A's root through the rail — a navigation, not a Trail verb. */
    fireEvent.click(within(view.getByTestId('home-rail')).getByRole('button', { name: /^Docs/ }));
    await waitFor(() => expect(target.getHash()).toContain('/home/k/docs'));
    await pinned();
    expect(target.getHash()).toContain('ca=');
  });
});

describe('surfaceHostsChatSlot', () => {
  it('is true for Home and Work (lane E) — the dock still covers every other surface', () => {
    expect(surfaceHostsChatSlot({ view: 'home' })).toBe(true);
    expect(surfaceHostsChatSlot({ view: 'home', root: { type: 'chats', threadId: null } })).toBe(true);
    expect(surfaceHostsChatSlot({ view: 'workspace' })).toBe(true);
    expect(surfaceHostsChatSlot({ view: 'inbox' })).toBe(false);
    expect(surfaceHostsChatSlot({ view: 'feed' })).toBe(false);
  });
});

/* THE BREAKPOINT lives in the stylesheet, which no vitest applies: pin that
   the narrow rule exists, sits at the constant, and turns the column into an
   overlay (absolute, right-anchored, no separator) rather than a squeeze. */
describe('home-page.css: the chat column becomes an overlay under ~1200px (Q7)', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'home-page', 'home-page.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  function mediaBlock(query: string): string {
    const start = css.indexOf(`@media (${query})`);
    expect(start, query).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error('unterminated @media');
  }

  function rule(block: string, selector: string): string {
    const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(block);
    expect(match, selector).not.toBeNull();
    return match![1]!;
  }

  it('the wide layout is an in-row column at --hp-chat', () => {
    const wide = rule(css, '.cv2-root .hp-chatcol');
    expect(wide).toMatch(/flex:\s*none/);
    expect(wide).toMatch(/width:\s*var\(--hp-chat,/);
    expect(wide).not.toMatch(/position:\s*absolute/);
  });

  it('below the breakpoint it is an absolute sheet from the right, with no separator', () => {
    const narrow = mediaBlock(`max-width: ${HOME_CHAT_COLUMN_MIN_VIEWPORT - 1}px`);
    const sheet = rule(narrow, '.cv2-root .hp-chatcol');
    expect(sheet).toMatch(/position:\s*absolute/);
    expect(sheet).toMatch(/right:\s*0/);
    expect(sheet).toMatch(/z-index:/);
    expect(rule(narrow, '.cv2-root .hp-chatsep')).toMatch(/display:\s*none/);
    /* The sheet's anchor: `.hp-host` is the positioning context. */
    expect(css).toMatch(/\.cv2-root \.hp-host \{ position: relative; \}/);
  });
});
