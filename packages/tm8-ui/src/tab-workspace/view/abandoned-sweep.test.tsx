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

let n = 0;
function setup(versions: Record<string, number>) {
  n += 1;
  const runtime = createWorkspaceRuntime(`sweep-${n}`, `space-${n}`, createWorkspaceStore(`sweep-${n}`, `space-${n}`));
  runtime.setHooks({ viewMounted: () => true, userTyping: () => false });
  const deleteEntity = vi.fn(() => Promise.resolve({}));
  const data = {
    seam: { commands: { deleteEntity } },
    reconcileCommand: vi.fn(),
    detailOf: (id: string) => (id in versions ? { version: versions[id] } : null),
  } as unknown as WorkspaceGateHandles['data'];
  renderHook(() => useAbandonedSweep(runtime, data));
  const open = (entityId: string) =>
    runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId }, source: 'click' });
  const close = (entityId: string) => {
    const tab = Object.values(runtime.store.getState().tabs).find((t) => t.type === 'entity' && t.entityId === entityId)!;
    runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'click' });
  };
  return { deleteEntity, open, close, versions };
}

function arrive(id: string, version: number | null) {
  markFreshDoc(id, 'Untitled task');
  noteFreshArrived(id, version);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const id of ['t1', 't2', 'd1']) forgetFreshDoc(id);
});

describe('the abandoned sweep', () => {
  it('deletes an untouched record once its tab has been gone for the grace period', async () => {
    const s = setup({ t1: 1 });
    arrive('t1', 1);
    s.open('t1');
    s.close('t1');
    expect(s.deleteEntity).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS); });
    expect(s.deleteEntity).toHaveBeenCalledWith('t1', expect.anything());
  });

  it('keeps one whose version moved while the tab was closing (a description save in flight)', async () => {
    const s = setup({ t1: 1 });
    arrive('t1', 1);
    s.open('t1');
    s.close('t1');
    s.versions.t1 = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS); });
    expect(s.deleteEntity).not.toHaveBeenCalled();
  });

  it('keeps one that was named, and one still held by a tab', async () => {
    const s = setup({ t1: 1, t2: 1 });
    arrive('t1', 1);
    arrive('t2', 1);
    noteFreshDocEmpty('t1', false);
    s.open('t1');
    s.open('t2');
    s.close('t1');
    await act(async () => { await vi.advanceTimersByTimeAsync(GRACE_MS * 2); });
    expect(s.deleteEntity).not.toHaveBeenCalled();
  });

  it('a doc, whose editor reports every edit, goes as soon as its tab does', () => {
    const s = setup({});
    arrive('d1', null);
    s.open('d1');
    s.close('d1');
    expect(s.deleteEntity).toHaveBeenCalledWith('d1', expect.anything());
  });
});
