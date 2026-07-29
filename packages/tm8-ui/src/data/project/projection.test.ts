/**
 * The list projection, pure — `membershipOf` and `projectRows`.
 *
 * These two functions are the whole create → event → screen loop with React
 * removed, and they are tested here rather than only through the hook because
 * the interesting cases are about JUDGEMENT, not rendering: what the client is
 * entitled to conclude about a server-side filter from an entity summary
 * alone. `src/views/live-event-loop.test.tsx` asserts the same behaviour
 * through the real hook; this file asserts the rules one at a time so a
 * failure names the rule.
 *
 * THE RULE UNDER TEST, in one sentence: a client may hide a row it can prove
 * the filter excludes, may show a row it can prove the filter includes, and
 * must do NEITHER when it cannot tell.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import { membershipOf, projectRows } from './domain-store';

const SPACE = 'spc-1' as SpaceId;

function summary(id: string, over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: id as EntityId,
    spaceId: SPACE,
    kind: 'task',
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-29T10:00:00.000Z',
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me' },
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'task', workStatus: 'open', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } },
    badges: {},
    ...over,
  } as EntitySummary;
}

const done = (id: string) =>
  summary(id, {
    state: { kind: 'task', workStatus: 'done', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } } as EntitySummary['state'],
  });

const table = (list: EntitySummary[]): Record<EntityId, EntitySummary> =>
  Object.fromEntries(list.map((s) => [s.id, s])) as Record<EntityId, EntitySummary>;

describe('membershipOf — the three answers', () => {
  it('decides a status clause both ways', () => {
    expect(membershipOf({ workStatus: ['open'] }, summary('a'))).toBe('in');
    expect(membershipOf({ workStatus: ['open'] }, done('a'))).toBe('out');
  });

  it('refuses to decide a clause it cannot evaluate', () => {
    // `readyToPull` is a server-side judgement; no field of a summary answers
    // it. Answering 'in' would put a row in a tier it may not belong to, and
    // answering 'out' would hide one the server returned. Neither is available.
    expect(membershipOf({ readyToPull: true }, summary('a'))).toBe('unknown');
    expect(membershipOf({ assigneeIds: ['act-1'] }, summary('a'))).toBe('unknown');
    expect(membershipOf({ axes: { area: ['x'] } }, summary('a'))).toBe('unknown');
  });

  it('one undecidable clause makes the WHOLE filter undecidable', () => {
    // Not "evaluate what we can and hope": a row that passes the workStatus
    // half of `{workStatus, readyToPull}` has not passed the filter.
    expect(membershipOf({ workStatus: ['open'], readyToPull: true }, summary('a'))).toBe('unknown');
  });

  it('treats a MISSING deleted clause as exclude, which is what the server does', () => {
    // collections.ts:248 — `f.deleted ?? 'exclude'`. An unfiltered list is not
    // "everything"; reading it that way would make deleted rows appear in
    // every list the moment a delete event arrived.
    expect(membershipOf(undefined, summary('a', { deletedAt: '2026-07-29T11:00:00.000Z' }))).toBe('out');
    expect(membershipOf({}, summary('a', { deletedAt: '2026-07-29T11:00:00.000Z' }))).toBe('out');
    expect(membershipOf({ deleted: 'include' }, summary('a', { deletedAt: '2026-07-29T11:00:00.000Z' }))).toBe('in');
    expect(membershipOf({ deleted: 'only' }, summary('a'))).toBe('out');
  });

  it('a NULL state axis never matches a status filter', () => {
    // The contract says so for sessionStatus and the same holds for
    // workStatus: a doc has no work status, so it is OUT of `Open`, not
    // waved through it.
    const doc = summary('d', { kind: 'doc', state: { kind: 'doc', format: 'markdown', childCount: 0 } as EntitySummary['state'] });
    expect(membershipOf({ workStatus: ['open'] }, doc)).toBe('out');
  });
});

describe('projectRows — a server-ordered read kept current by the stream', () => {
  const ordered = ['a', 'b'] as EntityId[];

  it('re-reads every row from the store, so an edit is visible without a read', () => {
    const entities = table([summary('a', { title: 'renamed' }), summary('b')]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: undefined });
    expect(out.map((r) => r.title)).toEqual(['renamed', 'b']);
  });

  it('drops a row the filter now excludes', () => {
    const entities = table([done('a'), summary('b')]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: { workStatus: ['open'] } });
    expect(out.map((r) => r.id)).toEqual(['b']);
  });

  it('adds an arrival at the HEAD — the server’s own activityAt_desc order', () => {
    const entities = table([
      summary('a'),
      summary('b'),
      summary('new', { activityAt: '2026-07-29T11:00:00.000Z' }),
    ]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: { workStatus: ['open'] } });
    expect(out.map((r) => r.id)).toEqual(['new', 'a', 'b']);
  });

  it('never adds an arrival to a filter it cannot evaluate', () => {
    const entities = table([summary('a'), summary('b'), summary('new')]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: { readyToPull: true } });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('never removes a row from a filter it cannot evaluate', () => {
    // The mirror of the case above, and the more dangerous one: an
    // over-eager 'out' would empty a panel that the server had populated.
    const entities = table([done('a'), summary('b')]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: { readyToPull: true } });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps arrivals inside their own kind and their own space', () => {
    const entities = table([
      summary('a'),
      summary('b'),
      summary('other-kind', { kind: 'doc', state: { kind: 'doc', format: 'markdown', childCount: 0 } as EntitySummary['state'] }),
      summary('other-space', { spaceId: 'spc-2' as SpaceId }),
    ]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: undefined });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns the base array untouched when nothing arrived', () => {
    // Cheap, and it is what keeps `rowsFor` from handing out a fresh identity
    // on every render for the overwhelmingly common case.
    const entities = table([summary('a'), summary('b')]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: undefined });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('skips an id the store has never been told about rather than rendering a hole', () => {
    const entities = table([summary('b')]);
    const out = projectRows({ ordered, entities, kind: 'task', spaceId: SPACE, filter: undefined });
    expect(out.map((r) => r.id)).toEqual(['b']);
  });
});
