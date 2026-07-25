/**
 * 409 version_conflict reconciliation: rollback is clean, the server's
 * `current` truth is adopted everywhere, and the toast names the editor
 * ("edited by X just now") — no merge dialogs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveDrop, runPlacement, sourceRef, targetRef, useUndoStore,
} from '../../interactions';
import { useGraphStore } from '../../stores';
import { useToastStore } from '../../subsystems/live';
import { CollabError, type EntityDetail } from '../../types/contract';
import { createRig, ingest, resetStores, toastMessages, type InteractionRig } from './helpers';

let rig: InteractionRig;

beforeEach(() => {
  resetStores();
  rig = createRig();
});

async function reparentPlacement(childId: string, parentId: string) {
  const [child, parent] = await Promise.all([
    rig.facade.getEntity(childId), rig.facade.getEntity(parentId),
  ]);
  const src = sourceRef(child);
  const tgt = targetRef(parent, 'parent-zone');
  const [option] = resolveDrop(src, tgt);
  return runPlacement(rig.facade, { source: src, target: tgt, option });
}

describe('simulated 409 rolls back cleanly', () => {
  it('adopts the server current, reverts the optimistic patch, toasts the editor', async () => {
    await ingest(rig, rig.ids.t103a);
    const before = useGraphStore.getState().entities[rig.ids.t103a];
    expect(before.parentId).toBe(rig.ids.t103);

    // Someone else bumped the child a moment ago — the server rejects with
    // its truth attached (a fresher version of the same entity).
    const current: EntityDetail = {
      ...(await rig.facade.getEntity(rig.ids.t103a)),
      version: before.version + 3,
    };
    rig.facade.failNextWith(new CollabError('version_conflict', 'stale', { current }));

    const outcome = await reparentPlacement(rig.ids.t103a, rig.ids.t104);
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict?.version).toBe(before.version + 3);

    const after = useGraphStore.getState().entities[rig.ids.t103a];
    expect(after.parentId).toBe(rig.ids.t103);        // optimistic move reverted
    expect(after.version).toBe(before.version + 3);   // server truth adopted
    expect(Object.keys(useGraphStore.getState().optimistic)).toEqual([]);

    const conflictToast = toastMessages().find((m) => m.includes('just now'));
    expect(conflictToast).toBeTruthy();
    expect(conflictToast).toMatch(/^Edited by .+ just now/);
    expect(useUndoStore.getState().entry).toBeNull(); // nothing to undo
  });

  it('names the last actor from the entity activity when available', async () => {
    const current = await rig.facade.getEntity(rig.ids.t103a);
    const activity = await rig.facade.getActivity(rig.ids.t103a);
    const expected = activity.items[0]?.actor?.displayName ?? 'someone';

    rig.facade.failNextWith(new CollabError('version_conflict', 'stale', { current }));
    await reparentPlacement(rig.ids.t103a, rig.ids.t104);

    expect(toastMessages().some((m) => m.includes(`Edited by ${expected} just now`))).toBe(true);
  });

  it('shows exactly one error toast per conflict', async () => {
    const current = await rig.facade.getEntity(rig.ids.t103a);
    rig.facade.failNextWith(new CollabError('version_conflict', 'stale', { current }));
    await reparentPlacement(rig.ids.t103a, rig.ids.t104);
    expect(useToastStore.getState().toasts.filter((t) => t.kind === 'error')).toHaveLength(1);
  });
});
