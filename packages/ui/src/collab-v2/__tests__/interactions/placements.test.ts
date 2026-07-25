/**
 * Every drop = ONE placements command: optimistic apply → reconcile →
 * undo round-trip (5-minute TTL on the manual clock), typed-error rollback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeUndo, resolveDrop, runPlacement, runUndo, sourceRef, targetRef,
  useUndoStore,
} from '../../interactions';
import { useGraphStore } from '../../stores';
import { CollabError, isCollabError } from '../../types/contract';
import {
  createRig, ingest, resetStores, toastMessages, type InteractionRig,
} from './helpers';

let rig: InteractionRig;

beforeEach(() => {
  resetStores();
  rig = createRig();
});

async function place(sourceId: string, targetId: string, surface: 'channel'|'task'|'actor'|'composer'|'parent-zone', pick = 0) {
  const [source, target] = await Promise.all([
    rig.facade.getEntity(sourceId), rig.facade.getEntity(targetId),
  ]);
  const src = sourceRef(source);
  const tgt = targetRef(target, surface);
  const options = resolveDrop(src, tgt);
  expect(options.length).toBeGreaterThan(pick);
  return runPlacement(rig.facade, { source: src, target: tgt, option: options[pick] });
}

describe('drop → one placements command', () => {
  it('attach lands exactly one placements call and registers the undo token', async () => {
    const spy = vi.spyOn(rig.facade, 'placements');
    const outcome = await place(rig.ids.docRollout, rig.ids.chDesign, 'channel');
    expect(outcome.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      sourceId: rig.ids.docRollout, targetId: rig.ids.chDesign, intent: 'attach',
    });
    expect(spy.mock.calls[0][0].clientMutationId).toBeTruthy();
    const undo = useUndoStore.getState().entry;
    expect(undo?.label).toContain('Attached');
    expect(toastMessages().some((m) => m.includes('Attached'))).toBe(true);
  });

  it('attach-with-embed posts the card message through the same single command', async () => {
    const spy = vi.spyOn(rig.facade, 'placements');
    const before = await rig.facade.getMessages(rig.ids.chDesign);
    const outcome = await place(rig.ids.docRollout, rig.ids.chDesign, 'channel', 1);
    expect(outcome.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].embedMessage).toBe('');
    const after = await rig.facade.getMessages(rig.ids.chDesign);
    expect(after.items.length).toBe(before.items.length + 1);
  });

  it('subtask/reparent applies the parent optimistically and reconciles', async () => {
    const [child] = await ingest(rig, rig.ids.t108);
    expect(child.parentId).toBe(rig.ids.t100);
    const outcome = await place(rig.ids.t108, rig.ids.t104, 'task', 2); // subtask
    expect(outcome.ok).toBe(true);
    expect(useGraphStore.getState().entities[rig.ids.t108].parentId).toBe(rig.ids.t104);
    expect(Object.keys(useGraphStore.getState().optimistic)).toEqual([]); // reconciled
    const server = await rig.facade.getEntity(rig.ids.t108);
    expect(server.parentId).toBe(rig.ids.t104);
  });
});

describe('undo round-trip (DEV-11, manual clock)', () => {
  it('redeems the token: the edge is gone and the pill clears', async () => {
    await place(rig.ids.docRollout, rig.ids.chDesign, 'channel');
    const conns = await rig.facade.getConnections(rig.ids.docRollout);
    expect(JSON.stringify(conns)).toContain(rig.ids.chDesign);

    expect(activeUndo(rig.now)).not.toBeNull();
    const ok = await runUndo(rig.facade, rig.now);
    expect(ok).toBe(true);
    expect(useUndoStore.getState().entry).toBeNull();
    const after = await rig.facade.getConnections(rig.ids.docRollout);
    expect(JSON.stringify(after)).not.toContain(rig.ids.chDesign);
    expect(toastMessages().some((m) => m.startsWith('Undone'))).toBe(true);
  });

  it('expires after 5 minutes: activeUndo hides it and the facade rejects', async () => {
    await place(rig.ids.docRollout, rig.ids.chDesign, 'channel');
    const entry = useUndoStore.getState().entry;
    expect(entry).not.toBeNull();

    rig.clock.advanceMinutes(6);
    expect(activeUndo(rig.now)).toBeNull();
    // The raw token is equally dead server-side (invariant_violation).
    await expect(rig.facade.undo(entry!.token)).rejects.toSatisfy(
      (e: unknown) => isCollabError(e) && e.code === 'invariant_violation',
    );
  });

  it('a second placement replaces the held token (newest wins)', async () => {
    await place(rig.ids.docRollout, rig.ids.chDesign, 'channel');
    const first = useUndoStore.getState().entry;
    await place(rig.ids.fileWireframes, rig.ids.t104, 'task');
    const second = useUndoStore.getState().entry;
    expect(second?.token).not.toBe(first?.token);
    expect(second?.label).toContain('Attached');
  });
});

describe('typed-error rollback', () => {
  it('invariant_violation rolls back the optimistic parent and toasts generically', async () => {
    await ingest(rig, rig.ids.t108);
    rig.facade.failNextWith(new CollabError('invariant_violation', 'cycle'));
    const outcome = await place(rig.ids.t108, rig.ids.t104, 'task', 2);
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBeUndefined();
    expect(useGraphStore.getState().entities[rig.ids.t108].parentId).toBe(rig.ids.t100);
    expect(toastMessages().some((m) => m.includes('failed'))).toBe(true);
    expect(useUndoStore.getState().entry).toBeNull();
  });

  it('forbidden also rolls back without a conflict payload', async () => {
    await ingest(rig, rig.ids.t108);
    rig.facade.failNextWith(new CollabError('forbidden', 'nope'));
    const outcome = await place(rig.ids.t108, rig.ids.t104, 'task', 2);
    expect(outcome.ok).toBe(false);
    expect(useGraphStore.getState().entities[rig.ids.t108].parentId).toBe(rig.ids.t100);
  });
});
