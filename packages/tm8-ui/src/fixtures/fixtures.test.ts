import { describe, expect, it } from 'vitest';
import { EntityDetailSchema, EntitySummarySchema, type CoreEntityKind } from '@tm8/contract';
import {
  authoredFromSessionByEntity,
  fixtureDetails,
  fixtureSummaries,
  homeActivityLoadEarlierReason,
  homeActivityPage,
  collectionEmpty,
  messageAgentNullProvenance,
  presenceViewersByEntity,
  sessionStale,
  taskTombstone,
  taskUuidTitle,
  teamMemberForge,
  teamMemberScout,
  sessionLive,
  sessionTeammateEdges,
} from './index';

/*
 * A HAND-WRITTEN LITERAL, and that is the hazard rather than the design.
 *
 * `domain/registry.test.ts` derives its list from `CoreEntityKindSchema.options`
 * and so reds the moment the contract grows a kind. This one does not — it has
 * sat at the original fifteen while `voice_channel`, `memory`, `worktree`,
 * `artifact`, `loop` and `graph` each landed, silently covering none of them.
 * So a new kind gets fixture coverage only if someone adds it BY HAND, which
 * is exactly what a green suite here will not tell you.
 *
 * `container` is added because migration 177 landed it. The six missing kinds
 * above are a PRE-EXISTING gap and are deliberately not closed here: each needs
 * its own summary and detail fixture, which is a wave of its own and not this
 * lane's. Recorded rather than quietly widened.
 */
const CORE_KINDS: CoreEntityKind[] = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
  'work_session', 'collection', 'project', 'interaction_profile',
  'container',
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

  it('covers every kind in CORE_KINDS plus a custom kind', () => {
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
    expect(taskUuidTitle.state.kind === 'task' && taskUuidTitle.state.status === 'in_review').toBe(true);

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

  it('D7.1 — home activity pages disabled-with-reason: more history, no cursor', () => {
    expect(homeActivityPage.total).toBeGreaterThan(homeActivityPage.items.length);
    expect(homeActivityPage.nextCursor).toBeNull();
    expect(homeActivityLoadEarlierReason.length).toBeGreaterThan(0);
  });

  it('D7.2 — presence is measured-empty on every keyed entity (hollow-value)', () => {
    const keys = Object.keys(presenceViewersByEntity);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(presenceViewersByEntity[k]).toHaveLength(0);
  });

  it('D7.3 — authored_from is null everywhere (hollow provenance chips)', () => {
    const keys = Object.keys(authoredFromSessionByEntity);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(authoredFromSessionByEntity[k]).toBeNull();
  });

  it('C-5 — null-provenance message is AGENT-authored (chip expected, value null)', () => {
    expect(messageAgentNullProvenance.createdBy.isAgent).toBe(true);
    expect(messageAgentNullProvenance.kind).toBe('message');
    expect(authoredFromSessionByEntity[messageAgentNullProvenance.id]).toBeNull();
    expect(messageAgentNullProvenance.id in authoredFromSessionByEntity).toBe(true);
  });

  it('capacity edges: session → team_member relates_to exists on BOTH sides', () => {
    // Launch capacity derives from these EDGES, not from `createdBy` — the
    // contract never states whether createdBy records the persona or the
    // initiating human, so joining on it would be a guess. An edge is an
    // explicit statement of the relationship.
    for (const [who, tmId] of [['forge', teamMemberForge.id], ['scout', teamMemberScout.id]] as const) {
      const tm = fixtureDetails[tmId];
      const incoming = tm?.connections.incoming.flatMap((g) => g.edges) ?? [];
      const ran = incoming.filter((e) => e.type === 'relates_to');
      expect(ran.length, `${who} has a session edge`).toBeGreaterThan(0);
      expect(ran[0]!.target.id, `${who} edge points at the teammate`).toBe(tmId);
    }
  });

  it('capacity counts LIVE sessions, not record-running ones — both halves present', () => {
    // THE POINT OF THE FIXTURE. forge's edge points at a session the liveness
    // snapshot lists as live; scout's points at one whose RECORD says running
    // but which is stale. A capacity line counting record-running sessions
    // would report scout busy; counting the liveness intersection reports it
    // free. Without both halves in the data, the two implementations are
    // indistinguishable — which is exactly the bug class this suite exists for.
    expect(sessionLive.state.kind === 'work_session' && sessionLive.state.status).toBe('running');
    expect(sessionStale.state.kind === 'work_session' && sessionStale.state.status).toBe('running');
    // identical records; only the seam verdict separates them
    expect(sessionTeammateEdges.forge.source.id).toBe(sessionLive.id);
    expect(sessionTeammateEdges.scout.source.id).toBe(sessionStale.id);
  });

  it('D9 — the new edges are wire-shaped: endpoints are snapshots, not back-references', () => {
    for (const e of Object.values(sessionTeammateEdges)) {
      expect(Object.keys(e.source.badges)).toHaveLength(0);
      expect(Object.keys(e.target.badges)).toHaveLength(0);
    }
  });

  it('C-5 — empty collection: itemCount 0 and detail items []', () => {
    expect(collectionEmpty.state.kind === 'collection' && collectionEmpty.state.itemCount === 0).toBe(true);
    const d = fixtureDetails[collectionEmpty.id];
    expect(d && d.content.kind === 'collection' && d.content.items).toHaveLength(0);
  });
});
