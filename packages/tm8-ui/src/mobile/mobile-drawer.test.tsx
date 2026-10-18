// @vitest-environment jsdom
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DRAWER_RECENT_LIMIT, MobileDrawer, accountInitial, drawerForest, resetDrawerOpenState } from './MobileDrawer';
import { DEFAULT_WORKSPACE_RAIL_PINS, getRailStore, resetRailStores } from '../tab-workspace/runtime/railStore';
import { MobileSurfaceProvider } from './surface';
import { DRAWER_TREE_KINDS, getKind } from '../domain';
import type { EntityId, EntitySummary } from '@tm8/contract';

/**
 * THE DRAWER v3 CONTRACT (mockup 01a14ccd-5cac, task 01a14ccc): ＋ New chat,
 * then the tree kinds as collapsible sections, collapsed by default; an open
 * section shows its recent items, an item with children expands in place, and
 * See all opens the phone list. jsdom sees no layout, so these assert what is
 * in the DOM and what fires — the 360/390/430 geometry is a browser question.
 */

const NOOP = () => undefined;
const [CHAT, SESSION, DOC, TASK] = DRAWER_TREE_KINDS as [string, string, string, string];

let seq = 0;
function row(kind: string, over: Partial<EntitySummary> = {}): EntitySummary {
  seq += 1;
  return {
    id: `${kind}-${seq}` as EntityId,
    kind,
    title: `${kind} ${seq}`,
    parentId: null,
    activityAt: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
    deletedAt: null,
    state: {},
    ...over,
  } as unknown as EntitySummary;
}

function mountDrawer(over: Partial<Parameters<typeof MobileDrawer>[0]> = {}) {
  return render(
    <MobileSurfaceProvider sheetHost={document.body}>
      <MobileDrawer
        spaceLabel="tm8"
        activeTarget={null}
        navigateTo={NOOP}
        countsFor={() => undefined}
        rowsOf={() => []}
        ensureKind={NOOP}
        onOpenEntity={NOOP}
        onOpenChat={NOOP}
        onOpenChats={NOOP}
        onNewThread={NOOP}
        onDismiss={NOOP}
        {...over}
      />
    </MobileSurfaceProvider>,
  );
}

const header = (view: ReturnType<typeof render>, kind: string) =>
  view.getByTestId(`mobile-drawer-kind-${kind}`);

beforeEach(() => {
  window.localStorage.clear();
  resetRailStores();
  resetDrawerOpenState();
});
afterEach(() => window.localStorage.clear());

describe('MobileDrawer v3 — New chat, then collapsible trees', () => {
  it('opens with ＋ New chat first, then Chats, Sessions, Docs, Tasks — all collapsed', () => {
    const view = mountDrawer();
    const trees = view.getByTestId('mobile-drawer-trees');
    const heads = within(trees).getAllByRole('button');
    expect(heads.map((el) => el.textContent)).toEqual(
      [CHAT, SESSION, DOC, TASK].map((kind) => `▸${getKind(kind).labelPlural}`),
    );
    expect(heads.every((el) => el.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(view.queryAllByTestId('mobile-drawer-item')).toHaveLength(0);
    /* ＋ New chat precedes every tree in document order. */
    const newChat = view.getByTestId('mobile-drawer-new-chat');
    expect(newChat.textContent).toBe('New chat');
    expect(newChat.compareDocumentPosition(trees) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('New chat runs the shell verb', () => {
    const onNewThread = vi.fn();
    const view = mountDrawer({ onNewThread });
    fireEvent.click(view.getByTestId('mobile-drawer-new-chat'));
    expect(onNewThread).toHaveBeenCalledTimes(1);
  });

  it('draws Needs you · N under New chat only when something is waiting, and opens the sheet', () => {
    expect(mountDrawer({ onOpenAttention: NOOP, needsYouCount: 0 }).queryByTestId('mobile-drawer-needs-you')).toBeNull();
    resetDrawerOpenState();
    const onOpenAttention = vi.fn();
    const onDismiss = vi.fn();
    const view = mountDrawer({ onOpenAttention, onDismiss, needsYouCount: 3 });
    const rows = view.getAllByTestId('mobile-drawer-needs-you');
    const row = rows[rows.length - 1]!;
    expect(row.textContent).toBe('Needs you3');
    expect(row.getAttribute('aria-label')).toBe('Needs you: 3 waiting');
    const newChat = view.getAllByTestId('mobile-drawer-new-chat').pop()!;
    const trees = view.getAllByTestId('mobile-drawer-trees').pop()!;
    expect(newChat.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(trees) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenAttention).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Home, Work and Inbox leave the drawer; the other views wait behind All kinds', () => {
    const view = mountDrawer();
    const text = () => view.baseElement.textContent ?? '';
    for (const word of ['Inbox', 'Work']) expect(text()).not.toMatch(new RegExp(`\\b${word}\\b`));
    expect(text()).not.toContain('Board');
    fireEvent.click(view.getByTestId('mobile-drawer-all-kinds'));
    expect(text()).toContain('Board');
    expect(text()).not.toMatch(/\bInbox\b/);
  });

  it('a section opens on tap, hydrates its kind, and shows the most recent roots', () => {
    const ensureKind = vi.fn();
    const roots = Array.from({ length: DRAWER_RECENT_LIMIT + 2 }, () => row(DOC));
    const child = row(DOC, { parentId: roots[roots.length - 1]!.id });
    const view = mountDrawer({ ensureKind, rowsOf: (kind) => (kind === DOC ? [...roots, child] : []) });
    expect(ensureKind).not.toHaveBeenCalled();

    fireEvent.click(header(view, DOC));
    expect(header(view, DOC).getAttribute('aria-expanded')).toBe('true');
    expect(ensureKind).toHaveBeenCalledWith(DOC);
    const items = view.getAllByTestId('mobile-drawer-item').map((el) => el.querySelector('.mdrawer__title')?.textContent);
    /* Newest first, capped, and the child is NOT drawn as a root. */
    expect(items).toEqual(roots.slice().reverse().slice(0, DRAWER_RECENT_LIMIT).map((r) => r.title));
    expect(items).not.toContain(child.title);
    expect(view.getByTestId(`mobile-drawer-see-all-${DOC}`).textContent).toContain('See all');

    fireEvent.click(header(view, DOC));
    expect(view.queryAllByTestId('mobile-drawer-item')).toHaveLength(0);
  });

  it('an item with children expands in place, and expanding never dismisses', () => {
    const onDismiss = vi.fn();
    const root = row(SESSION, { title: 'Coordinator' });
    const workers = [row(SESSION, { parentId: root.id, title: 'Lane A' }), row(SESSION, { parentId: root.id, title: 'Lane B' })];
    const view = mountDrawer({ onDismiss, rowsOf: (kind) => (kind === SESSION ? [root, ...workers] : []) });
    fireEvent.click(header(view, SESSION));
    expect(view.queryByText('Lane A')).toBeNull();
    expect(view.getByText(/2 sub-/)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Expand Coordinator' }));
    expect(view.getByText('Lane A')).toBeTruthy();
    expect(view.getByText('Lane B')).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('remembers what is open across a close and reopen, and starts collapsed', () => {
    const first = mountDrawer();
    fireEvent.click(header(first, TASK));
    first.unmount();
    const second = mountDrawer();
    expect(header(second, TASK).getAttribute('aria-expanded')).toBe('true');
    expect(header(second, DOC).getAttribute('aria-expanded')).toBe('false');
  });

  it('tapping an item opens it and dismisses; a chat opens in the chat screen', () => {
    const onOpenEntity = vi.fn();
    const onOpenChat = vi.fn();
    const onDismiss = vi.fn();
    const task = row(TASK, { title: 'Fix rounding' });
    const chat = row(CHAT, { title: 'Billing question' });
    const view = mountDrawer({
      onOpenEntity,
      onOpenChat,
      onDismiss,
      rowsOf: (kind) => (kind === TASK ? [task] : kind === CHAT ? [chat] : []),
    });
    fireEvent.click(header(view, TASK));
    fireEvent.click(view.getByText('Fix rounding'));
    expect(onOpenEntity).toHaveBeenCalledWith(task.id, TASK);
    fireEvent.click(header(view, CHAT));
    fireEvent.click(view.getByText('Billing question'));
    expect(onOpenChat).toHaveBeenCalledWith(chat.id);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('See all opens the phone list route; for Chats it opens the conversation list', () => {
    const navigateTo = vi.fn();
    const onOpenChats = vi.fn();
    const onDismiss = vi.fn();
    const view = mountDrawer({ navigateTo, onOpenChats, onDismiss });
    fireEvent.click(header(view, TASK));
    fireEvent.click(view.getByTestId(`mobile-drawer-see-all-${TASK}`));
    expect(navigateTo).toHaveBeenCalledWith({ type: 'kind', ref: TASK });
    fireEvent.click(header(view, CHAT));
    fireEvent.click(view.getByTestId(`mobile-drawer-see-all-${CHAT}`));
    expect(onOpenChats).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('an open section with nothing loaded says Loading, and only a counted zero says none', () => {
    const view = mountDrawer({ countsFor: (kind) => (kind === DOC ? { total: 0, unseen: 0 } : undefined) });
    fireEvent.click(header(view, DOC));
    fireEvent.click(header(view, TASK));
    expect(view.baseElement.textContent).toContain(`No ${getKind(DOC).labelPlural.toLowerCase()} yet`);
    expect(view.baseElement.textContent).toContain('Loading…');
  });

  it('a header draws the total, unread as a dot, and nothing when nobody counted', () => {
    const view = mountDrawer({
      countsFor: (kind) => (kind === TASK ? { total: 9, unseen: 9 } : kind === DOC ? { total: 0, unseen: 0 } : undefined),
    });
    const task = header(view, TASK);
    expect(task.querySelector('.mdrawer__total')?.textContent).toBe('9');
    expect(task.querySelector('.mdrawer__unseen-dot')?.getAttribute('aria-label')).toBe('9 unread');
    expect(task.querySelector('.mdrawer__unseen-dot')?.textContent).toBe('');
    expect(header(view, DOC).querySelector('.mdrawer__total')?.textContent).toBe('0');
    expect(header(view, DOC).querySelector('.mdrawer__unseen-dot')).toBeNull();
    expect(header(view, SESSION).querySelector('.mdrawer__total')).toBeNull();
  });

  it('Pinned draws the rail pins as trees, skipping kinds already drawn above', () => {
    const view = mountDrawer({ spaceId: 'space-drawer-v3' });
    const pinned = Array.from(view.baseElement.querySelectorAll('.mdrawer__label')).find(
      (el) => el.textContent === 'Pinned',
    );
    expect(pinned).toBeTruthy();
    const kinds = Array.from(pinned!.parentElement!.querySelectorAll('.mdrawer__tree')).map((el) =>
      el.getAttribute('data-kind'),
    );
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of DRAWER_TREE_KINDS) expect(kinds).not.toContain(kind);
  });
});

describe('MobileDrawer v3 — the Pin kinds sheet', () => {
  const SPACE = 'space-pin-kinds';
  const pinnedKindsIn = (view: ReturnType<typeof render>) =>
    Array.from(view.getByTestId('mobile-drawer-pinned').querySelectorAll('.mdrawer__tree')).map((el) =>
      el.getAttribute('data-kind'),
    );
  /* A kind the default pins leave out, so pinning it is a visible change. */
  const unpinnedKind = () =>
    within(document.body.querySelector('[data-testid="mobile-pin-kinds"]') as HTMLElement)
      .getAllByRole('switch')
      .find((el) => el.getAttribute('aria-checked') === 'false')!;

  it('opens from the foot\'s Pin kinds, not from a row in Pinned, over the drawer', () => {
    const view = mountDrawer({ spaceId: SPACE });
    const pinKinds = view.getByTestId('mobile-drawer-pin-kinds');
    /* MOVED, not copied: one trigger, in the foot, and none left in Pinned. */
    expect(view.getAllByText('Pin kinds')).toHaveLength(1);
    expect(view.getByTestId('mobile-drawer-foot').contains(pinKinds)).toBe(true);
    expect(view.getByTestId('mobile-drawer-pinned').contains(pinKinds)).toBe(false);
    expect(view.queryByTestId('mobile-pin-kinds')).toBeNull();

    fireEvent.click(pinKinds);
    const sheet = view.getByTestId('mobile-pin-kinds');
    expect(within(sheet).getByRole('dialog', { name: 'Pin kinds' })).toBeTruthy();
    /* The drawer stays mounted underneath, and the sheet comes after it in the
       host — the order the z-index rule relies on. */
    const drawer = view.getByTestId('mobile-drawer');
    expect(drawer.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the four tree kinds as always shown, and every other kind as a switch', () => {
    const view = mountDrawer({ spaceId: SPACE });
    fireEvent.click(view.getByTestId('mobile-drawer-pin-kinds'));
    const sheet = view.getByTestId('mobile-pin-kinds');
    const fixed = Array.from(sheet.querySelectorAll('li.mpins__row')).map((el) => el.getAttribute('data-kind'));
    expect(fixed).toEqual([CHAT, SESSION, DOC, TASK]);
    expect(within(sheet).getAllByText('always shown')).toHaveLength(4);
    const switches = within(sheet).getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(0);
    for (const el of switches) expect(DRAWER_TREE_KINDS).not.toContain(el.getAttribute('data-kind'));
    /* The default rail pins read as on. */
    for (const el of switches) {
      const kind = el.getAttribute('data-kind')!;
      expect(el.getAttribute('aria-checked')).toBe(String(DEFAULT_WORKSPACE_RAIL_PINS.includes(kind)));
    }
  });

  it('a switch toggles the desktop rail pin, and Pinned follows while the sheet is open', () => {
    const view = mountDrawer({ spaceId: SPACE });
    fireEvent.click(view.getByTestId('mobile-drawer-pin-kinds'));
    const toggle = unpinnedKind();
    const kind = toggle.getAttribute('data-kind')!;
    expect(pinnedKindsIn(view)).not.toContain(kind);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(getRailStore(SPACE).getState().pins).toContain(kind);
    expect(pinnedKindsIn(view)).toContain(kind);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(getRailStore(SPACE).getState().pins).not.toContain(kind);
    expect(pinnedKindsIn(view)).not.toContain(kind);
  });

  it('a pin made on the desktop rail shows in an open drawer', () => {
    const view = mountDrawer({ spaceId: SPACE });
    fireEvent.click(view.getByTestId('mobile-drawer-pin-kinds'));
    const kind = unpinnedKind().getAttribute('data-kind')!;
    act(() => {
      getRailStore(SPACE).getState().togglePin(kind);
    });
    expect(pinnedKindsIn(view)).toContain(kind);
  });

  it('Escape closes the sheet only, and focus returns to the Pin kinds row', () => {
    const onDismiss = vi.fn();
    const view = mountDrawer({ spaceId: SPACE, onDismiss });
    const pinKinds = view.getByTestId('mobile-drawer-pin-kinds');
    fireEvent.click(pinKinds);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByTestId('mobile-pin-kinds')).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pinKinds);
  });

  it('tapping the sheet backdrop closes the sheet, not the drawer', () => {
    const onDismiss = vi.fn();
    const view = mountDrawer({ spaceId: SPACE, onDismiss });
    fireEvent.click(view.getByTestId('mobile-drawer-pin-kinds'));
    fireEvent.click(view.getByTestId('mobile-pin-kinds'));
    expect(view.queryByTestId('mobile-pin-kinds')).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a pinned kind\'s See all resets to its phone list through the drawer\'s navigate', () => {
    const navigateTo = vi.fn();
    const onDismiss = vi.fn();
    const view = mountDrawer({ spaceId: SPACE, navigateTo, onDismiss });
    const kind = pinnedKindsIn(view)[0]!;
    fireEvent.click(header(view, kind));
    fireEvent.click(view.getByTestId(`mobile-drawer-see-all-${kind}`));
    expect(navigateTo).toHaveBeenCalledWith({ type: 'kind', ref: kind });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('draws no Pinned section without a Space, and no Pin kinds either', () => {
    const view = mountDrawer();
    expect(view.queryByTestId('mobile-drawer-pinned')).toBeNull();
    expect(view.queryByTestId('mobile-drawer-pin-kinds')).toBeNull();
  });

  it('draws no empty Pinned heading when nothing is pinned', () => {
    const store = getRailStore(SPACE);
    for (const kind of [...store.getState().pins]) store.getState().togglePin(kind);
    const view = mountDrawer({ spaceId: SPACE });
    expect(view.queryByTestId('mobile-drawer-pinned')).toBeNull();
    expect(view.getByTestId('mobile-drawer-pin-kinds')).toBeTruthy();
  });
});

describe('MobileDrawer — the foot (t-drawer-footer)', () => {
  const SPACE = 'space-foot';

  it('draws Pin kinds · Settings · Craft mode · avatar, in that order, outside the scroll', () => {
    const view = mountDrawer({ spaceId: SPACE, onOpenAccount: NOOP, accountName: 'Subhang' });
    const foot = view.getByTestId('mobile-drawer-foot');
    const order = Array.from(foot.children).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'mobile-drawer-pin-kinds',
      'mobile-drawer-settings',
      'mobile-drawer-craft',
      'mobile-drawer-account',
    ]);
    expect(view.baseElement.querySelector('.mdrawer__scroll')!.contains(foot)).toBe(false);
    expect(within(foot).getByText('Craft mode')).toBeTruthy();
  });

  it('Settings goes through the drawer\'s navigate and dismisses', () => {
    const navigateTo = vi.fn();
    const onDismiss = vi.fn();
    const view = mountDrawer({ navigateTo, onDismiss });
    fireEvent.click(view.getByTestId('mobile-drawer-settings'));
    expect(navigateTo).toHaveBeenCalledWith({ type: 'view', ref: 'settings' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Craft mode is a destination: the craft view, as desktop\'s work.craft.toggle', () => {
    const navigateTo = vi.fn();
    const onDismiss = vi.fn();
    const view = mountDrawer({ navigateTo, onDismiss });
    fireEvent.click(view.getByTestId('mobile-drawer-craft'));
    expect(navigateTo).toHaveBeenCalledWith({ type: 'view', ref: 'craft' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('marks the foot destination being shown as current', () => {
    const view = mountDrawer({ activeTarget: { type: 'view', ref: 'craft' } });
    expect(view.getByTestId('mobile-drawer-craft').getAttribute('aria-current')).toBe('page');
    expect(view.getByTestId('mobile-drawer-settings').getAttribute('aria-current')).toBeNull();
  });

  it('the avatar draws the name\'s initial and opens the account sheet', () => {
    const onOpenAccount = vi.fn();
    const onDismiss = vi.fn();
    const view = mountDrawer({ onOpenAccount, onDismiss, accountName: 'subhang' });
    const avatar = view.getByTestId('mobile-drawer-account');
    expect(avatar.textContent).toBe('S');
    expect(avatar.getAttribute('aria-label')).toBe('Account: subhang');
    fireEvent.click(avatar);
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('draws no avatar when there is no account to open', () => {
    const view = mountDrawer();
    expect(view.queryByTestId('mobile-drawer-account')).toBeNull();
  });

  it('Help left the foot for All kinds; Craft is drawn once, in the foot', () => {
    const view = mountDrawer();
    const foot = view.getByTestId('mobile-drawer-foot');
    expect(foot.textContent).not.toContain('Help');
    expect(view.baseElement.textContent).not.toContain('Help');
    fireEvent.click(view.getByTestId('mobile-drawer-all-kinds'));
    const help = view.getByRole('button', { name: 'Help' });
    expect(foot.contains(help)).toBe(false);
    expect(view.queryAllByRole('button', { name: /^Craft( mode)?$/ })).toHaveLength(1);
  });
});

describe('accountInitial', () => {
  it('takes the first letter or digit, upper-cased, and nothing from nothing', () => {
    expect(accountInitial('subhang')).toBe('S');
    expect(accountInitial('  @ada')).toBe('A');
    expect(accountInitial('7of9')).toBe('7');
    expect(accountInitial('')).toBeNull();
    expect(accountInitial(undefined)).toBeNull();
  });
});

describe('drawerForest', () => {
  it('hangs loaded children under their parent and keeps orphans as roots', () => {
    const root = row(TASK);
    const sub = row(TASK, { parentId: root.id });
    const orphan = row(TASK, { parentId: 'not-loaded' as EntityId });
    const gone = row(TASK, { deletedAt: '2026-10-01T00:00:00Z' });
    const forest = drawerForest([root, sub, orphan, gone]);
    expect(forest.roots.map((r) => r.id)).toEqual([orphan.id, root.id]);
    expect(forest.childrenOf(root.id).map((r) => r.id)).toEqual([sub.id]);
  });
});
