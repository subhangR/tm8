import { describe, expect, it } from 'vitest';
import { homeRailGroups } from './home-rail';
import {
  composeEntityNavigation,
  entityNavigationLabel,
  summarizeEntityNavigation,
} from './entity-navigation';

describe('the shared entity-navigation projection', () => {
  it('preserves the registry-derived Work, Library, and People hierarchy', () => {
    const groups = composeEntityNavigation(homeRailGroups(), () => undefined);

    expect(groups.slice(0, 3).map((group) => group.label)).toEqual(['Work', 'Library', 'People']);
    expect(groups.slice(0, 3).map((group) => group.items.map((item) => item.config.kind))).toEqual([
      ['task', 'work_session', 'doc', 'project', 'pull_request', 'worktree', 'commit'],
      ['file', 'artifact', 'memory', 'collection', 'spell', 'skill', 'loop'],
      ['team_member', 'member', 'channel'],
    ]);
  });

  it('keeps a partial counter unknown instead of publishing a false group total', () => {
    const groups = composeEntityNavigation(
      homeRailGroups(),
      (kind) => (kind === 'task' ? { total: 4, unseen: 1 } : undefined),
    );

    expect(groups[0]?.items[0]?.counts).toEqual({ total: 4, unseen: 1 });
    expect(groups[0]?.total).toBeUndefined();
    expect(summarizeEntityNavigation(groups).total).toBeUndefined();
  });

  it('aggregates exact counts and registry-declared live populations', () => {
    const groups = composeEntityNavigation(
      homeRailGroups(),
      () => ({ total: 3, unseen: 1 }),
      (config) => (config.list.liveTreatment ? 2 : undefined),
    );

    const kinds = groups.reduce((sum, group) => sum + group.items.length, 0);
    const announcing = groups.reduce(
      (sum, group) => sum + group.items.filter((item) => item.config.announcesNew).length,
      0,
    );
    expect(summarizeEntityNavigation(groups)).toEqual({
      kinds,
      total: kinds * 3,
      // EVERY kind was handed `unseen: 1`; only the announcing ones contribute.
      // The total is unaffected — suppression removes a claim to be news, not a
      // row from the inventory.
      unseen: announcing,
      live: 2,
    });
  });

  it('only registry-declared kinds can announce something as new', () => {
    // The defect: measured on prod 2026-08-30 every kind's server-side unseen
    // count was saturated (commit 223/223, pull_request 133/133), so the
    // dashboard drew a "new" badge on all nineteen rows permanently. Migration
    // 175 makes the count honest for kinds a member actually opens; this gate
    // is what stops the rest — derived and imported records nobody opens
    // row-by-row — from claiming to be news at all.
    const groups = composeEntityNavigation(homeRailGroups(), () => ({ total: 9, unseen: 7 }));
    const items = groups.flatMap((group) => group.items);

    expect(items.filter((item) => item.counts!.unseen > 0).map((item) => item.config.kind)).toEqual([
      'task',
      'work_session',
      'channel',
    ]);
    // Suppressed kinds keep their TOTAL and lose only the claim. Absent would
    // have been wrong here: it means "the server did not answer", and would
    // have taken the total away too.
    for (const item of items) {
      expect(item.counts!.total).toBe(9);
    }
  });

  it('states every visible counter in the row accessible name', () => {
    const item = composeEntityNavigation(
      homeRailGroups(),
      () => ({ total: 12, unseen: 3 }),
      (config) => (config.list.liveTreatment ? 2 : undefined),
    )[0]!.items[1]!;

    expect(entityNavigationLabel(item)).toBe('Sessions, 12 total, 3 new, 2 live');
  });
});
