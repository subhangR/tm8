import { describe, expect, it } from 'vitest';
import { EntityDetailSchema, EntitySummarySchema, type CoreEntityKind } from '@tm8/contract';
import { fixtureDetails, fixtureSummaries, sessionStale, taskTombstone, taskUuidTitle } from './index';

const CORE_KINDS: CoreEntityKind[] = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
  'work_session', 'collection', 'project', 'interaction_profile',
];

describe('fixture dataset', () => {
  it('every summary validates against the contract zod schema', () => {
    for (const s of fixtureSummaries) {
      const r = EntitySummarySchema.safeParse(s);
      expect(r.success, `${s.id}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true);
    }
  });

  it('every detail validates and agrees with its summary kind', () => {
    for (const [id, d] of Object.entries(fixtureDetails)) {
      const r = EntityDetailSchema.safeParse(d);
      expect(r.success, `${id}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true);
      expect(d.content.kind, `${id}: content.kind must match entity kind`).toBe(d.kind);
    }
  });

  it('covers all 15 core kinds plus a custom kind', () => {
    const kinds = new Set(fixtureSummaries.map((s) => s.kind));
    for (const k of CORE_KINDS) expect(kinds.has(k), `missing core kind ${k}`).toBe(true);
    expect([...kinds].some((k) => k.startsWith('c:')), 'missing a custom c:* kind').toBe(true);
  });

  it('covers every core kind with a detail too', () => {
    const kinds = new Set(Object.values(fixtureDetails).map((d) => d.kind));
    for (const k of CORE_KINDS) expect(kinds.has(k), `missing detail for core kind ${k}`).toBe(true);
  });

  it('carries the worst-case row: UUID-length title', () => {
    expect(taskUuidTitle.title).toHaveLength(36);
    expect(taskUuidTitle.title.includes(' ')).toBe(false);
  });

  it('carries every honesty state', () => {
    // stale session: running per record, but activity is old — no live proof
    expect(sessionStale.state.kind === 'work_session' && sessionStale.state.status === 'running').toBe(true);
    expect(sessionStale.activityAt < '2026-07-28T11:30:00.000Z').toBe(true);

    // NEEDS YOU: in_review + viewer-held pull
    expect(taskUuidTitle.state.kind === 'task' && taskUuidTitle.state.workStatus === 'in_review').toBe(true);

    // delivery facets: contentStale-only, discussionMoved-only, and both
    const pulls = taskUuidTitle.badges.pulls ?? [];
    expect(pulls.some((p) => p.contentStale && !p.discussionMoved)).toBe(true);
    expect(pulls.some((p) => !p.contentStale && p.discussionMoved)).toBe(true);
    expect(pulls.some((p) => p.contentStale && p.discussionMoved)).toBe(true);

    // tombstone
    expect(taskTombstone.deletedAt).not.toBeNull();

    // blocked + restricted + live-work badges exist somewhere in the roster
    expect(fixtureSummaries.some((s) => s.badges.blocked)).toBe(true);
    expect(fixtureSummaries.some((s) => s.badges.restricted)).toBe(true);
    expect(fixtureSummaries.some((s) => (s.badges.workingActors ?? []).length > 0)).toBe(true);
  });
});
