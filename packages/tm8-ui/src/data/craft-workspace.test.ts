import { describe, expect, it } from 'vitest';
import type { CraftWorkspace } from '@tm8/contract';
import { applyCraftTabCommand, defaultCraftWorkspace, memoryCraftWorkspacesPort } from './craft-workspace';

/** The tab commands' pure rules — what the window shows before the node answers. */
const CRAFT = 'craft-1';

function opened(...ids: string[]): CraftWorkspace {
  let ws = defaultCraftWorkspace(CRAFT);
  for (const id of ids) ws = applyCraftTabCommand(ws, 'tabs.open', { kind: 'doc', entityId: id }).workspace;
  return ws;
}
const order = (ws: CraftWorkspace) => ws.state.tabs.map((tab) => tab.entityId);
const active = (ws: CraftWorkspace) => ws.state.tabs.find((tab) => tab.id === ws.state.activeTabId)!.entityId;

describe('applyCraftTabCommand', () => {
  it('starts on the pinned overview, and opens a page as a new active tab', () => {
    const ws = opened('a', 'b');
    expect(order(ws)).toEqual([CRAFT, 'a', 'b']);
    expect(active(ws)).toBe('b');
    expect(ws.revision).toBe(2);
  });

  it('opening an open page focuses its tab, and is a no-op when it is already active', () => {
    const ws = opened('a', 'b');
    const focus = applyCraftTabCommand(ws, 'tabs.open', { kind: 'doc', entityId: 'a' });
    expect(focus).toMatchObject({ status: 'applied', outcome: 'reused' });
    expect(order(focus.workspace)).toEqual([CRAFT, 'a', 'b']);
    expect(active(focus.workspace)).toBe('a');
    expect(applyCraftTabCommand(focus.workspace, 'tabs.open', { kind: 'doc', entityId: 'a' }).status).toBe('no_op');
  });

  it('folds the old design kind into craft, and refuses kinds that are not tabs', () => {
    const ws = applyCraftTabCommand(defaultCraftWorkspace(CRAFT), 'tabs.open', { kind: 'design', entityId: 'n' }).workspace;
    expect(ws.state.tabs[1]!.kind).toBe('craft');
    expect(applyCraftTabCommand(ws, 'tabs.open', { kind: 'task', entityId: 't' })).toMatchObject({ status: 'rejected', reason: 'unsupported_kind' });
  });

  it('refuses an entity that is not a page, when the pages are known', () => {
    const result = applyCraftTabCommand(defaultCraftWorkspace(CRAFT), 'tabs.open', { kind: 'doc', entityId: 'x' }, (id) => id === 'a');
    expect(result).toMatchObject({ status: 'rejected', reason: 'not_a_page' });
  });

  it('never closes or moves the overview, nor puts a tab before it', () => {
    const ws = opened('a', 'b');
    expect(applyCraftTabCommand(ws, 'tabs.close', { tabId: CRAFT }).reason).toBe('pinned');
    expect(applyCraftTabCommand(ws, 'tabs.move', { tabId: CRAFT, beforeTabId: null }).reason).toBe('pinned');
    const b = ws.state.tabs[2]!.id;
    expect(applyCraftTabCommand(ws, 'tabs.move', { tabId: b, beforeTabId: CRAFT }).reason).toBe('pinned');
  });

  it('closing the active tab selects its right neighbour, else its left', () => {
    const ws = opened('a', 'b', 'c');
    const middle = applyCraftTabCommand(applyCraftTabCommand(ws, 'tabs.activate', { entityId: 'b' }).workspace, 'tabs.close', { entityId: 'b' }).workspace;
    expect(order(middle)).toEqual([CRAFT, 'a', 'c']);
    expect(active(middle)).toBe('c');
    const last = applyCraftTabCommand(middle, 'tabs.close', { entityId: 'c' }).workspace;
    expect(active(last)).toBe('a');
  });

  it('moves a tab before another, or last', () => {
    const ws = opened('a', 'b', 'c');
    const [, a, , c] = ws.state.tabs;
    expect(order(applyCraftTabCommand(ws, 'tabs.move', { tabId: c!.id, beforeTabId: a!.id }).workspace)).toEqual([CRAFT, 'c', 'a', 'b']);
    expect(order(applyCraftTabCommand(ws, 'tabs.move', { tabId: a!.id, beforeTabId: null }).workspace)).toEqual([CRAFT, 'b', 'c', 'a']);
    expect(applyCraftTabCommand(ws, 'tabs.move', { tabId: c!.id, beforeTabId: null }).status).toBe('no_op');
  });

  it('stops at the tab cap', () => {
    const ws = opened(...Array.from({ length: 49 }, (_, i) => `p${i}`));
    expect(ws.state.tabs).toHaveLength(50);
    expect(applyCraftTabCommand(ws, 'tabs.open', { kind: 'doc', entityId: 'one-more' }).reason).toBe('tab_limit');
  });
});

describe('memoryCraftWorkspacesPort', () => {
  it('serves the default, keeps each write, pushes it, and refuses a stale revision', async () => {
    const port = memoryCraftWorkspacesPort();
    const frames: unknown[] = [];
    port.onPush((frame) => frames.push(frame));
    expect((await port.get('s', CRAFT)).revision).toBe(0);
    const result = await port.command('s', CRAFT, { requestId: 'r', command: 'tabs.open', args: { kind: 'graph', entityId: 'g' } });
    expect(result.status).toBe('applied');
    expect(order(await port.get('s', CRAFT))).toEqual([CRAFT, 'g']);
    expect(frames).toHaveLength(1);
    const stale = await port.command('s', CRAFT, { requestId: 'r2', command: 'tabs.close', args: { entityId: 'g' }, expectedRevision: 0 });
    expect(stale.status).toBe('conflict');
  });
});
