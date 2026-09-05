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
      // `chat` LEADS Work since 2026-09-05 (task 01a070c4): the Chats tab left
      // the top row and its door is the rail row this projection draws.
      ['chat', 'task', 'work_session', 'doc', 'project', 'pull_request', 'worktree', 'commit'],
      ['file', 'artifact', 'memory', 'collection', 'spell', 'skill', 'loop'],
      ['team_member', 'member', 'channel'],
    ]);
  });

  it('keeps a partial counter unknown instead of publishing a false group total', () => {
    const groups = composeEntityNavigation(
      homeRailGroups(),
      (kind) => (kind === 'task' ? { total: 4, unseen: 1 } : undefined),
    );

    // BY KIND, not by position: the counter above is keyed on `task`, and a
    // row joining the Work group ahead of it must not silently re-point this
    // assertion at a kind the reader never named.
    const task = groups[0]?.items.find((item) => item.config.kind === 'task');
    expect(task?.counts).toEqual({ total: 4, unseen: 1 });
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
    expect(summarizeEntityNavigation(groups)).toEqual({
      kinds,
      total: kinds * 3,
      unseen: kinds,
      live: 2,
    });
  });

  it('states every visible counter in the row accessible name', () => {
    // Named by KIND for the same reason as the test above: this asserts what
    // `work_session`'s row says, not what the second row of Work happens to be.
    const item = composeEntityNavigation(
      homeRailGroups(),
      () => ({ total: 12, unseen: 3 }),
      (config) => (config.list.liveTreatment ? 2 : undefined),
    )[0]!.items.find((row) => row.config.kind === 'work_session')!;

    expect(entityNavigationLabel(item)).toBe('Sessions, 12 total, 3 new, 2 live');
  });
});
