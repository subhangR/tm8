// @vitest-environment jsdom
/**
 * THE CRAFT TOP BAR (doc 01a1255d §3): `[selected craft ▾] · [Home | craft 1 | craft 2 …]`.
 *
 *  · the ▾ lists Home first, then every craft; picking navigates;
 *  · the craft on screen opens a tab; tabs are the viewer's, persisted;
 *  · × closes a tab (never the craft) and moves the selection right, left, or Home;
 *  · the server port reads the open rows in position order and follows the push;
 *  · the socket routes `craft.workspace(s)` frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { CraftWorkspace, CraftWorkspaceCommandInput, EntityId } from '@tm8/contract';
import type { CraftWorkspacesPort } from '../data/seam';
import type { CraftWorkspacePushFrame } from '../data/real/socket';
import { parseFrame } from '../data/real/socket';
import { CraftHeaderSwitcher } from './CraftHeaderSwitcher';
import {
  craftTabsKey,
  localOpenCraftsPort,
  neighbourAfterClose,
  openIdsOf,
  serverOpenCraftsPort,
  withClosed,
  withOpened,
} from './craft-open-tabs';
import { fixtureCraftsSource } from './crafts-source';

const id = (n: number) => `019f98a0-aaaa-bbbb-cccc-${String(n).padStart(12, '0')}` as EntityId;
const KEY = craftTabsKey('node', 'space', 'viewer');

function seeded() {
  return fixtureCraftsSource([
    { id: id(1), title: 'Pricing launch', pages: [{ kind: 'doc' }] },
    { id: id(2), title: 'Onboarding', pages: [] },
    { id: id(3), title: 'Roadmap', pages: [{ kind: 'graph' }, { kind: 'doc' }] },
  ]);
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function mount(current: EntityId | null, handlers = { home: vi.fn(), craft: vi.fn() }, source = seeded()) {
  const port = localOpenCraftsPort(KEY);
  const view = render(
    <CraftHeaderSwitcher
      source={source}
      openCrafts={port}
      currentCraftId={current}
      onOpenHome={handlers.home}
      onOpenCraft={handlers.craft}
    />,
  );
  return { view, handlers, port };
}

const tabTitles = (view: ReturnType<typeof render>) =>
  view.queryAllByTestId('craft-tab').map((tab) => tab.querySelector('[role="tab"]')?.textContent);

describe('the craft switcher', () => {
  it('lists Home first, then every craft', async () => {
    const { view } = mount(id(2));
    await waitFor(() => expect(view.getByTestId('craft-switcher-trigger').textContent).toContain('Onboarding'));
    fireEvent.click(view.getByTestId('craft-switcher-trigger'));
    const pop = view.getByTestId('craft-switcher-pop');
    await waitFor(() => expect(view.getAllByTestId('craft-switcher-row')).toHaveLength(3));
    const rows = [...pop.querySelectorAll('[role="menuitem"]')].map((row) => row.querySelector('.crf-hsw__name')?.textContent);
    expect(rows).toEqual(['Home', 'Pricing launch', 'Onboarding', 'Roadmap']);
  });

  it('says Home on Home, and picking routes', async () => {
    const { view, handlers } = mount(null);
    expect(view.getByTestId('craft-switcher-trigger').textContent).toContain('Home');
    fireEvent.click(view.getByTestId('craft-switcher-trigger'));
    await waitFor(() => expect(view.getAllByTestId('craft-switcher-row')).toHaveLength(3));
    fireEvent.click(view.getAllByTestId('craft-switcher-row')[2]!);
    expect(handlers.craft).toHaveBeenCalledWith(id(3));
    expect(view.queryByTestId('craft-switcher-pop')).toBeNull();
  });

  it('picking Home from a craft goes home', async () => {
    const { view, handlers } = mount(id(1));
    fireEvent.click(view.getByTestId('craft-switcher-trigger'));
    fireEvent.click(view.getByTestId('craft-switcher-home'));
    expect(handlers.home).toHaveBeenCalledTimes(1);
  });
});

describe('the open-craft tabs', () => {
  it('opens a tab for the craft on screen, after Home, and keeps it across a reload', async () => {
    const first = mount(id(1));
    await waitFor(() => expect(tabTitles(first.view)).toEqual(['Pricing launch']));
    expect(first.view.getByTestId('craft-tab-home').textContent).toBe('Home');
    first.view.rerender(
      <CraftHeaderSwitcher
        source={seeded()}
        openCrafts={first.port}
        currentCraftId={id(3)}
        onOpenHome={vi.fn()}
        onOpenCraft={vi.fn()}
      />,
    );
    await waitFor(() => expect(tabTitles(first.view)).toEqual(['Pricing launch', 'Roadmap']));
    cleanup();
    // A reload: a fresh mount on Home reads the same tabs back.
    const again = mount(null);
    await waitFor(() => expect(tabTitles(again.view)).toEqual(['Pricing launch', 'Roadmap']));
    expect(again.view.getByTestId('craft-tab-home').getAttribute('aria-selected')).toBe('true');
  });

  it('closing the selected tab selects its right neighbour, and the craft stays in the list', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ids: [id(1), id(2), id(3)] }));
    const source = seeded();
    const { view, handlers } = mount(id(2), undefined, source);
    await waitFor(() => expect(tabTitles(view)).toEqual(['Pricing launch', 'Onboarding', 'Roadmap']));
    fireEvent.click(view.getAllByTestId('craft-tab-close')[1]!);
    expect(handlers.craft).toHaveBeenCalledWith(id(3));
    await waitFor(() => expect(tabTitles(view)).toEqual(['Pricing launch', 'Roadmap']));
    expect((await source.list()).map((card) => card.id)).toContain(id(2));
    expect(JSON.parse(localStorage.getItem(KEY)!).ids).toEqual([id(1), id(3)]);
  });

  it('closing the last tab while on it goes Home; closing another tab does not navigate', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ids: [id(1), id(2)] }));
    const { view, handlers } = mount(id(1));
    await waitFor(() => expect(tabTitles(view)).toHaveLength(2));
    fireEvent.click(view.getAllByTestId('craft-tab-close')[1]!);
    expect(handlers.craft).not.toHaveBeenCalled();
    expect(handlers.home).not.toHaveBeenCalled();
    await waitFor(() => expect(tabTitles(view)).toEqual(['Pricing launch']));
    fireEvent.click(view.getAllByTestId('craft-tab-close')[0]!);
    expect(handlers.home).toHaveBeenCalledTimes(1);
  });

  it('draws no tab for a craft that is gone', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ids: [id(1), id(9)] }));
    const { view } = mount(null);
    await waitFor(() => expect(tabTitles(view)).toEqual(['Pricing launch']));
  });
});

describe('the pure rules', () => {
  it('open appends once, close drops, neighbour prefers the right', () => {
    expect(withOpened(['a'], 'b')).toEqual(['a', 'b']);
    expect(withOpened(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(withClosed(['a', 'b'], 'a')).toEqual(['b']);
    expect(neighbourAfterClose(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbourAfterClose(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbourAfterClose(['a'], 'a')).toBeNull();
  });
});

function row(craftId: string, open: boolean, position: number): CraftWorkspace {
  return {
    workspaceId: `ws-${craftId}`,
    craftId,
    revision: 1,
    open,
    position,
    state: { tabs: [{ id: craftId, kind: 'craft', entityId: craftId, pinned: true }], activeTabId: craftId },
    updatedAt: null,
    lastAgentChange: null,
  };
}

describe('the server port', () => {
  function fakePort(items: CraftWorkspace[]) {
    const subs = new Set<(frame: CraftWorkspacePushFrame) => void>();
    const commands: { craftId: string; input: CraftWorkspaceCommandInput }[] = [];
    const port: CraftWorkspacesPort = {
      list: async () => ({ items, openCap: 30 }),
      get: async (_s, craftId) => items.find((item) => item.craftId === craftId) ?? row(craftId, false, 0),
      command: async (_s, craftId, input) => {
        commands.push({ craftId, input });
        return { requestId: input.requestId, status: 'applied', workspace: row(craftId, true, 0) };
      },
      onPush: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    return { port, commands, push: (frame: CraftWorkspacePushFrame) => subs.forEach((cb) => cb(frame)) };
  }

  it('reads the open rows in position order', async () => {
    const { port } = fakePort([row('c', true, 2), row('a', true, 0), row('b', false, 1)]);
    expect(await serverOpenCraftsPort(port, 'space').read()).toEqual(['a', 'c']);
    expect(openIdsOf([row('x', false, 0)])).toEqual([]);
  });

  it('opens and closes through craft.open / craft.close', async () => {
    const { port, commands } = fakePort([]);
    const open = serverOpenCraftsPort(port, 'space');
    await open.open('a');
    await open.close('a');
    expect(commands.map((c) => [c.craftId, c.input.command])).toEqual([
      ['a', 'craft.open'],
      ['a', 'craft.close'],
    ]);
    expect(commands[0]!.input.requestId).not.toBe(commands[1]!.input.requestId);
  });

  it('follows the craft.workspaces push for its own space only', async () => {
    const { port, push } = fakePort([]);
    const seen: (readonly string[])[] = [];
    const off = serverOpenCraftsPort(port, 'space').subscribe((ids) => seen.push(ids));
    act(() => {
      push({ type: 'craft.workspaces', spaceId: 'other', items: [row('z', true, 0)] });
      push({ type: 'craft.workspace', spaceId: 'space', workspace: row('y', true, 0) });
      push({ type: 'craft.workspaces', spaceId: 'space', items: [row('b', true, 1), row('a', true, 0)] });
    });
    off();
    expect(seen).toEqual([['a', 'b']]);
  });
});

describe('the socket', () => {
  it('routes craft.workspace and craft.workspaces frames, and refuses malformed ones', () => {
    expect(parseFrame({ type: 'craft.workspaces', spaceId: 's', items: [] }).kind).toBe('craft-workspace');
    expect(parseFrame({ type: 'craft.workspace', spaceId: 's', workspace: row('a', true, 0) }).kind).toBe('craft-workspace');
    expect(parseFrame({ type: 'craft.workspaces', spaceId: 's' }).kind).toBe('malformed');
    expect(parseFrame({ type: 'craft.workspace', items: [] }).kind).toBe('malformed');
  });
});
