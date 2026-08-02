/**
 * Home presets are SERVER-defined and FAITHFUL: each CollectionResult returned
 * by getHome carries a query that re-executes to exactly the same items, so
 * the Home screen re-runs/paginates presets instead of hand-building scoped
 * queries — and the real-backend swap stays honest.
 */
import { describe, expect, it } from 'vitest';
import { createRig } from './helpers';

const PRESETS = ['readyToPull', 'inFlight', 'needsMe'] as const;

describe('getHome preset query parity', () => {
  it('re-executing each preset query reproduces the preset items', async () => {
    const { facade, ids } = createRig();
    const snap = await facade.getHome(ids.space);
    for (const key of PRESETS) {
      const preset = snap[key];
      const rerun = await facade.queryCollection(preset.query);
      expect(rerun.page.items.map((i) => i.id), `preset ${key}`).toEqual(preset.page.items.map((i) => i.id));
    }
  });

  it('stays faithful after the world changes', async () => {
    const { facade, ids } = createRig();
    await facade.setWork(ids.t102, { status: 'working', actorId: ids.subhang });
    const snap = await facade.getHome(ids.space);
    expect(snap.inFlight.page.items.map((i) => i.id)).toContain(ids.t102);
    for (const key of PRESETS) {
      const preset = snap[key];
      const rerun = await facade.queryCollection(preset.query);
      expect(rerun.page.items.map((i) => i.id), `preset ${key}`).toEqual(preset.page.items.map((i) => i.id));
    }
  });

  it('actor scope rides IN the returned filters, not in post-processing', async () => {
    const { facade, ids } = createRig();
    const snap = await facade.getHome(ids.space);
    expect(snap.readyToPull.query.filters?.readyToPull).toBe(true);
    expect(snap.readyToPull.query.filters?.assigneeIds).toContain(ids.subhang);
    expect(snap.inFlight.query.filters?.inFlightForActorId).toBe(ids.subhang);
    expect(snap.needsMe.query.filters?.needsActorId).toBe(ids.subhang);
    // Every inFlight row is an open-ended task (never done/cancelled).
    for (const item of snap.inFlight.page.items) {
      expect(item.kind).toBe('task');
      if (item.state.kind === 'task') expect(['done', 'cancelled']).not.toContain(item.state.workStatus);
    }
  });
});
