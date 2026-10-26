// @vitest-environment jsdom
/**
 * The abandoned-record sweep: what New made at once and nobody wrote in is
 * deleted once no tab holds it — and nothing anyone wrote in ever is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { forgetFreshDoc, markFreshDoc, noteFreshArrived, noteFreshDocEmpty } from '../../doc-edit';
import { GRACE_MS, useAbandonedSweep } from './useAbandonedSweep';
import type { WorkspaceGateHandles } from './context';

interface Row {
  version?: number;
  children?: number;
  edges?: string[];
  unreadable?: boolean;
}

/** What the server says about the record when the sweep reads it again. */
function detail(id: string, row: Row) {
  return {
    entity: { id },
    version: row.version ?? 1,
    hierarchy: { children: { items: Array.from({ length: row.children ?? 0 }, (_, i) => ({ id: `${id}-c${i}` })), nextCursor: null } },
    connections: {
      outgoing: ['authored_from', ...(row.edges ?? [])].map((type) => ({ type, edges: [{ id: `${id}-${type}` }] })),
      incoming: [{ type: 'assigned_to', edges: [{ id: `${id}-assigned` }] }],
    },
  };
}

let n = 0;
function setup(rows: Record<string, Row>) {
  n += 1;
  const runtime = createWorkspaceRuntime(`sweep-${n}`, `space-${n}`, createWorkspaceStore(`sweep-${n}`, `space-${n}`));
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  const deleteEntity = vi.fn(() => Promise.resolve({}));
  const data = {
    seam: {
      entity: (id: string) => {
        const row = rows[id] ?? {};
        return row.unreadable ? Promise.reject(new Error('offline')) : Promise.resolve(detail(id, row));
      },
      commands: { deleteEntity },
    },
    reconcileCommand: vi.fn(),
  } as unknown as WorkspaceGateHandles['data'];
  renderHook(() => useAbandonedSweep(runtime, data));
  const open = (entityId: string) =>
    runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId }, source: 'click' });
  const close = (entityId: string) => {
    const tab = Object.values(runtime.store.getState().tabs).find((t) => t.type === 'entity' && t.entityId === entityId)!;
    runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'click' });
  };
  return { deleteEntity, open, close, rows };
}

function arrive(id: string, version: number | null) {
  markFreshDoc(id, 'Untitled task');
  noteFreshArrived(id, version);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const id of ['t1', 't2', 'd1', 'd2']) forgetFreshDoc(id);
});

describe('the abandoned sweep', () => {
  it('deletes an untouched record once its tab has been gone for the grace period', async () => {
    const s = setup({ t1: { version: 1 } });
    arrive('t1', 1);
    s.open('t1');
    s.close('t1');
    expect(s.deleteEntity).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS); });
    expect(s.deleteEntity).toHaveBeenCalledWith('t1', expect.anything());
  });

  it('keeps one whose version moved while the tab was closing (a description save in flight)', async () => {
    const s = setup({ t1: { version: 1 } });
    arrive('t1', 1);
    s.open('t1');
    s.close('t1');
    s.rows.t1.version = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS); });
    expect(s.deleteEntity).not.toHaveBeenCalled();
  });

  it('keeps one that was named, and one still held by a tab', async () => {
    const s = setup({ t1: { version: 1 }, t2: { version: 1 } });
    arrive('t1', 1);
    arrive('t2', 1);
    noteFreshDocEmpty('t1', false);
    s.open('t1');
    s.open('t2');
    s.close('t1');
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS * 2); });
    expect(s.deleteEntity).not.toHaveBeenCalled();
  });

  it('a doc, whose editor reports every edit, goes as soon as its tab does', async () => {
    const s = setup({});
    arrive('d1', null);
    s.open('d1');
    s.close('d1');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(s.deleteEntity).toHaveBeenCalledWith('d1', expect.anything());
  });

  it('keeps one with a subtask, or a doc attached, though its own version never moved', async () => {
    const s = setup({ t1: { version: 1, children: 1 }, t2: { version: 1, edges: ['attached_to'] }, d1: { edges: ['relates_to'] } });
    arrive('t1', 1);
    arrive('t2', 1);
    arrive('d1', null);
    for (const id of ['t1', 't2', 'd1']) {
      s.open(id);
      s.close(id);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS); });
    expect(s.deleteEntity).not.toHaveBeenCalled();
  });

  it('keeps one it cannot read back', async () => {
    const s = setup({ d1: { unreadable: true } });
    arrive('d1', null);
    s.open('d1');
    s.close('d1');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(s.deleteEntity).not.toHaveBeenCalled();
  });
});
