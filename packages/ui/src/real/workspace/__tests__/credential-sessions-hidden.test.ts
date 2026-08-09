/**
 * A CREDENTIAL LOGIN TERMINAL IS NOT WORK, and this package's session lists
 * must not show it as such (082, architect Ruling 16).
 *
 * WHY THIS PACKAGE GETS ITS OWN TEST. `packages/ui` is the legacy surface and
 * it is still served — `main.tsx:43` registers BOTH screens that list sessions
 * (`TM8_VIEWS = { sessions: SessionsScreen, workspace: WorkspaceScreen }`), so
 * a filter that covered only the new UI would leave login terminals visible on
 * the surface nobody remembered to check. Both call paths were measured before
 * this was written rather than assumed from a grep.
 *
 * THE ASYMMETRY IS THE POINT. `isWork` is deliberately the INVERSE of the SQL
 * predicate: server SQL tests `session_kind = 'agent'` because the column is
 * NOT NULL, while here the field is optional and a row from a node predating
 * 082 carries none. The last test below pins that directly, because the
 * failure mode of getting it backwards is invisible on fresh data — every
 * ordinary session silently disappears, but only for users on an older payload.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '../../../collab-v2/types/contract';
import { groupSessions, isWork } from '../useSessions';

function session(id: string, state: Record<string, unknown>): EntitySummary {
  return {
    id,
    spaceId: 'space-1',
    kind: 'work_session' as EntitySummary['kind'],
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-08T00:00:00.000Z',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'owner', kind: 'member', displayName: 'Owner', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: state as EntitySummary['state'],
    badges: {},
  };
}

describe('credential login terminals are not work sessions', () => {
  it('excludes a session explicitly marked credential', () => {
    expect(isWork(session('login', { status: 'running', sessionKind: 'credential' }))).toBe(false);
  });

  it('includes a session explicitly marked agent', () => {
    expect(isWork(session('work', { status: 'running', sessionKind: 'agent' }))).toBe(true);
  });

  /**
   * THE FROZEN-SERVER CASE. A node predating 082, or a row hydrated from a
   * payload cached before the column shipped, has NO `sessionKind`. Absence
   * must mean VISIBLE: fail open, because the cost of showing a login terminal
   * is clutter while the cost of the inverse is every real session vanishing.
   *
   * If someone ever "tidies" `!== 'credential'` into `=== 'agent'`, this is the
   * test that goes red.
   */
  it('KEEPS a session with no sessionKind at all', () => {
    expect(isWork(session('legacy', { status: 'running' }))).toBe(true);
    expect(isWork(session('legacy-null', { status: 'running', sessionKind: null }))).toBe(true);
  });

  it('keeps the live/finished split complementary once filtered', () => {
    const rows = [
      session('a', { status: 'running' }),
      session('b', { status: 'exited' }),
      session('login', { status: 'running', sessionKind: 'credential' }),
    ].filter(isWork);

    const { live, finished } = groupSessions(rows);
    expect(live.map((s) => s.id)).toEqual(['a']);
    expect(finished.map((s) => s.id)).toEqual(['b']);
    // Every surviving row lands in exactly one bucket — the property the
    // counts beside these lists depend on.
    expect(live.length + finished.length).toBe(rows.length);
  });
});
