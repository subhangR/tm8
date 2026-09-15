/**
 * 186 — memory full-text search, against the REAL chain and the REAL reader.
 *
 * What the JavaScript substring search could not do, proved one property at a
 * time:
 *   1. every field is searched — a memory is found by a word that appears ONLY
 *      in `does_not_establish`, and a hit in the statement outranks the same
 *      word in the boundary;
 *   2. a superseded memory resolves to its live chain head, once, even when
 *      the head no longer contains the word that matched;
 *   3. marks ride along — an open dispute shows, an answered one clears;
 *   4. visibility is `internal.entity_readable`, not the caller's role: as
 *      tm8_app, a member of another space and a caller with no identity get
 *      nothing, while the member gets the rows. Red/green pairs throughout,
 *      because "the hidden thing is hidden" passes against a function that
 *      returns nothing at all;
 *   5. the expression index is actually matched by the expression the function
 *      uses, read from the plan with sequential scans disabled;
 *   6. the facade handler carries the caller's claims to the function and
 *      renders the contract shape.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError, type MemorySearchResult } from '@tm8/contract';
import { PgDb } from '../../src/db/client.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { memoriesSearch } from '../../src/facade/handlers/memories.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** Member of the space under test. */
const MEMBER = 'mem-search-member';
/** A second member of the SAME space — an independent author for `verifies`. */
const OTHER = 'mem-search-other';
/** A real identity that is a member of a DIFFERENT space only. */
const OUTSIDER = 'mem-search-outsider';

interface Fixture {
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  otherMemberId: string;
  outsiderMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** Resolved by SUFFIX, not number: the ordinal is the one unstable part of a migration filename. */
function migrationBySuffix(files: readonly string[], suffix: string): string {
  const matches = files.filter((f) => f.endsWith(suffix));
  expect(matches, `exactly one migration ending ${suffix}`).toHaveLength(1);
  return matches[0]!;
}

/** Seeding runs as the graph owner — it is setup, never the thing under test. */
async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/**
 * The product's own posture: `tm8_app` with the claims a request binds.
 * `identity === null` leaves the identity claim UNSET — a distinct case from
 * "set to an identity nobody has".
 */
async function asIdentity<T>(identity: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    if (identity !== null) {
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [identity]);
    }
    await client.query(
      `select set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'memory-search-pg', true),
              set_config('tm8.auth_kind', '', true)`,
    );
    return fn(client);
  });
}

interface SearchRow {
  entity_id: string;
  statement: string;
  subject_scope: string;
  does_not_establish: string;
  rank: number;
  marks: string[];
}

async function searchAs(
  identity: string | null,
  spaceId: string,
  query: string | null,
  limit: number | null = 20,
): Promise<SearchRow[]> {
  return asIdentity(identity, async (client) => (
    await client.query<SearchRow>(
      `select entity_id, statement, subject_scope, does_not_establish, rank, marks
         from public.search_memories($1, $2, $3)`,
      [spaceId, query, limit],
    )
  ).rows);
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const f = (await client.query<Fixture>(
      `select internal.new_id()::text "spaceId", internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "otherMemberId",
              internal.new_id()::text "outsiderMemberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Member'), ($2, 'Other'), ($3, 'Outsider')`,
      [MEMBER, OTHER, OUTSIDER],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Search space', $3), ($2, 'Another space', $4)`,
      [f.spaceId, f.otherSpaceId, MEMBER, OUTSIDER],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by) values
       ($1, $4, 'member', null, 0, $1),
       ($2, $4, 'member', null, 1, $2),
       ($3, $5, 'member', null, 0, $3)`,
      [f.memberId, f.otherMemberId, f.outsiderMemberId, f.spaceId, f.otherSpaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $4, $6, 'owner', 'Member'),
       ($2, $4, $7, 'member', 'Other'),
       ($3, $5, $8, 'owner', 'Outsider')`,
      [f.memberId, f.otherMemberId, f.outsiderMemberId, f.spaceId, f.otherSpaceId, MEMBER, OTHER, OUTSIDER],
    );
    return f;
  });
}

interface MemoryFields {
  statement: string;
  mechanism?: string;
  subjectScope?: string;
  doesNotEstablish?: string;
}

/** A memory entity + detail row, minted directly as the graph owner. */
async function mintMemory(
  fields: MemoryFields,
  options: { spaceId?: string; createdBy?: string } = {},
): Promise<string> {
  const spaceId = options.spaceId ?? fixture.spaceId;
  const createdBy = options.createdBy ?? (spaceId === fixture.spaceId ? fixture.memberId : fixture.outsiderMemberId);
  return asOwner(async (client) => {
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
       values ($1, $2, 'memory', null, 0, $3)`,
      [id, spaceId, createdBy],
    );
    await client.query(
      `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish)
       values ($1, $2, $3, $4, $5)`,
      [
        id,
        fields.statement,
        fields.mechanism ?? 'seeded directly by the test',
        fields.subjectScope ?? 'this scratch database',
        fields.doesNotEstablish ?? 'anything beyond this test',
      ],
    );
    return id;
  });
}

async function drawEdge(src: string, dst: string, type: string, props: Record<string, unknown>): Promise<string> {
  return asOwner(async (client) => (
    await client.query<{ id: string }>(
      `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [fixture.spaceId, src, dst, type, JSON.stringify(props), fixture.memberId],
    )
  ).rows[0]!.id);
}

/** A word nobody else uses, so a test never matches another test's memory. */
let nonce = 0;
function unique(word: string): string {
  nonce += 1;
  return `${word}${nonce}x`;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('memory_search');
  const files = migrationFiles();
  migrationBySuffix(files, '_memory_fulltext_search.sql');
  database.apply(files);
  fixture = await seed();
});

afterAll(async () => {
  await database?.destroy();
});

describe('186 lands what the read needs', () => {
  it('adds the expression index and a SECURITY DEFINER search function', async () => {
    const index = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'memories' and indexname = 'memories_search_document_idx'`,
    );
    expect(index[0]?.indexdef).toContain('USING gin (internal.memory_search_document(statement, mechanism, subject_scope, does_not_establish))');
    const fn = await database.query<{ prosecdef: boolean; provolatile: string }>(
      `select prosecdef, provolatile from pg_proc where proname = 'search_memories'`,
    );
    expect(fn).toEqual([{ prosecdef: true, provolatile: 's' }]);
  });

  it('is callable by tm8_app alone — PUBLIC\'s default EXECUTE is revoked', async () => {
    // A definer function that bypasses row policies must not be reachable by
    // every role on the cluster. PostgreSQL grants EXECUTE to PUBLIC on
    // creation; the migration revokes it before granting the one reader.
    // `tm8_delivery_worker` stands in for "any other role": its grant list is
    // pinned elsewhere (w2-execution.pg.test.ts) and must not grow.
    const rows = await database.query<{ app: boolean; worker: boolean; anyone: boolean }>(
      `select has_function_privilege('tm8_app', 'public.search_memories(uuid, text, integer)', 'EXECUTE') as app,
              has_function_privilege('tm8_delivery_worker', 'public.search_memories(uuid, text, integer)', 'EXECUTE') as worker,
              has_function_privilege('public.search_memories(uuid, text, integer)', 'EXECUTE') as anyone`,
    );
    expect(rows[0]).toMatchObject({ app: true, worker: false });
  });

  it('the function searches through the SAME expression the index is built on, and the planner matches it', async () => {
    // The body carries the index expression verbatim; and, as the role the
    // definer body runs as, that expression reaches the index. Sequential scans
    // are disabled so a tiny table cannot hide a mismatch behind a cheap scan
    // — with the expression mismatched the plan would still be a Seq Scan.
    const body = (await database.query<{ def: string }>(
      `select pg_get_functiondef('public.search_memories'::regproc) as def`,
    ))[0]!.def;
    const expression = 'internal.memory_search_document(m.statement, m.mechanism, m.subject_scope, m.does_not_establish) @@ q.tsq';
    expect(body).toContain(expression);

    const plan = await asOwner(async (client) => {
      await client.query('set local enable_seqscan = off');
      return (await client.query<{ 'QUERY PLAN': string }>(
        `explain select entity_id from public.memories m
          where internal.memory_search_document(m.statement, m.mechanism, m.subject_scope, m.does_not_establish)
                @@ websearch_to_tsquery('english', 'anything')`,
      )).rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('Bitmap Index Scan on memories_search_document_idx');
  });
});

describe('every field is searched', () => {
  it('finds a memory by a word that appears ONLY in does_not_establish', async () => {
    const word = unique('pghba');
    const id = await mintMemory({
      statement: 'the cluster listens on 5442',
      doesNotEstablish: `the ${word} reload behaviour`,
    });
    const rows = await searchAs(MEMBER, fixture.spaceId, word);
    expect(rows.map((r) => r.entity_id)).toEqual([id]);
    // The row carries the boundary, not only the statement, so a reader sees
    // WHY it matched.
    expect(rows[0]!.does_not_establish).toContain(word);
  });

  it('finds a memory by a word that appears only in mechanism, and one only in subject_scope', async () => {
    const mech = unique('probedsocket');
    const scope = unique('stagingnode');
    const byMechanism = await mintMemory({ statement: 'a plain claim', mechanism: `${mech} on the host` });
    const byScope = await mintMemory({ statement: 'another plain claim', subjectScope: `the ${scope} only` });
    expect((await searchAs(MEMBER, fixture.spaceId, mech)).map((r) => r.entity_id)).toEqual([byMechanism]);
    expect((await searchAs(MEMBER, fixture.spaceId, scope)).map((r) => r.entity_id)).toEqual([byScope]);
  });

  it('ranks a hit in the statement above the same word found only in the boundary', async () => {
    const word = unique('reloadword');
    const inBoundary = await mintMemory({ statement: 'listens on 5442', doesNotEstablish: `the ${word} behaviour` });
    const inStatement = await mintMemory({ statement: `the deploy needs a ${word}` });
    const rows = await searchAs(MEMBER, fixture.spaceId, word);
    expect(rows.map((r) => r.entity_id)).toEqual([inStatement, inBoundary]);
    expect(rows[0]!.rank).toBeGreaterThan(rows[1]!.rank);
  });

  it('answers an empty list, never an error, when the query has no searchable words', async () => {
    expect(await searchAs(MEMBER, fixture.spaceId, 'the')).toEqual([]);
    expect(await searchAs(MEMBER, fixture.spaceId, '   ')).toEqual([]);
    expect(await searchAs(MEMBER, fixture.spaceId, '')).toEqual([]);
    expect(await searchAs(MEMBER, fixture.spaceId, null)).toEqual([]);
  });

  it('bounds the page whatever the caller asks for', async () => {
    const word = unique('bounded');
    await mintMemory({ statement: `${word} one` });
    await mintMemory({ statement: `${word} two` });
    await mintMemory({ statement: `${word} three` });
    expect(await searchAs(MEMBER, fixture.spaceId, word, 2)).toHaveLength(2);
    // Below one is a request for nothing; null is "the default".
    expect(await searchAs(MEMBER, fixture.spaceId, word, 0)).toHaveLength(1);
    expect(await searchAs(MEMBER, fixture.spaceId, word, null)).toHaveLength(3);
  });

  it('never returns a deleted memory', async () => {
    const word = unique('deletedword');
    const live = await mintMemory({ statement: `${word} still here` });
    const gone = await mintMemory({ statement: `${word} removed` });
    await asOwner((client) => client.query('update public.entities set deleted_at = now() where id = $1', [gone]));
    expect((await searchAs(MEMBER, fixture.spaceId, word)).map((r) => r.entity_id)).toEqual([live]);
  });
});

describe('a superseded memory resolves to its chain head', () => {
  it('answers the head, once, with no superseded mark — even when only the predecessor matched', async () => {
    const word = unique('portword');
    const wrong = await mintMemory({ statement: `the ${word} is 5432` });
    const right = await mintMemory({ statement: `the socket is 5442` });
    await drawEdge(right, wrong, 'supersedes', { reason: 'checked the cluster' });

    const rows = await searchAs(MEMBER, fixture.spaceId, word);
    expect(rows.map((r) => r.entity_id)).toEqual([right]);
    expect(rows[0]!.statement).toBe('the socket is 5442');
    expect(rows[0]!.marks).not.toContain('superseded');
  });

  it('collapses two hits on one chain into one row', async () => {
    const word = unique('bothword');
    const wrong = await mintMemory({ statement: `${word} was 5432` });
    const right = await mintMemory({ statement: `${word} is 5442` });
    await drawEdge(right, wrong, 'supersedes', { reason: 'remeasured' });
    expect((await searchAs(MEMBER, fixture.spaceId, word)).map((r) => r.entity_id)).toEqual([right]);
  });

  it('walks a chain of more than one step to the latest head', async () => {
    const word = unique('chainword');
    const first = await mintMemory({ statement: `${word} first claim` });
    const second = await mintMemory({ statement: 'second claim' });
    const third = await mintMemory({ statement: 'third claim' });
    await drawEdge(second, first, 'supersedes', { reason: 'step one' });
    await drawEdge(third, second, 'supersedes', { reason: 'step two' });
    expect((await searchAs(MEMBER, fixture.spaceId, word)).map((r) => r.entity_id)).toEqual([third]);
  });

  it('does not follow a deleted successor: the last live memory is the head', async () => {
    const word = unique('retracted');
    const original = await mintMemory({ statement: `${word} original` });
    const retracted = await mintMemory({ statement: `${word} retracted correction` });
    await drawEdge(retracted, original, 'supersedes', { reason: 'later withdrawn' });
    await asOwner((client) => client.query('update public.entities set deleted_at = now() where id = $1', [retracted]));
    const rows = await searchAs(MEMBER, fixture.spaceId, word);
    expect(rows.map((r) => r.entity_id)).toEqual([original]);
    expect(rows[0]!.marks).toEqual([]);
  });
});

describe('marks ride along', () => {
  it('shows an open dispute, and clears it once a verification answers it at the current version', async () => {
    const word = unique('contested');
    const claim = await mintMemory({ statement: `${word} claim` });
    const evidence = await mintMemory({ statement: 'the counter-measurement' }, { createdBy: fixture.otherMemberId });
    const disputeId = await drawEdge(evidence, claim, 'disputes', {
      quote: `${word} claim`, expected: 'x', observed: 'y', pinnedVersion: 1,
    });
    expect((await searchAs(MEMBER, fixture.spaceId, word))[0]!.marks).toEqual(['disputed']);

    // Independent author (OTHER's member row), current version pinned, the
    // dispute named — the 056 verification guard admits this and nothing less.
    await drawEdge(evidence, claim, 'verifies', {
      mechanism: 're-measured', answers: [disputeId], pinnedVersion: 1, independenceBasis: 'actor',
    });
    expect((await searchAs(MEMBER, fixture.spaceId, word))[0]!.marks).toEqual(['verified']);
  });

  it('an unmarked memory carries no marks — absence is not "verified"', async () => {
    const word = unique('unmarked');
    await mintMemory({ statement: `${word} claim` });
    expect((await searchAs(MEMBER, fixture.spaceId, word))[0]!.marks).toEqual([]);
  });
});

describe('visibility is entity_readable, whatever the role', () => {
  it('a member of another space gets nothing from this space, and still finds their own', async () => {
    const word = unique('secretword');
    const mine = await mintMemory({ statement: `${word} in the member space` });
    const theirs = await mintMemory({ statement: `${word} in the outsider space` }, { spaceId: fixture.otherSpaceId });

    // Red/green: the member sees theirs, the outsider sees nothing of it...
    expect((await searchAs(MEMBER, fixture.spaceId, word)).map((r) => r.entity_id)).toEqual([mine]);
    expect(await searchAs(OUTSIDER, fixture.spaceId, word)).toEqual([]);
    // ...and the outsider's OWN space still answers, so "nothing" is not the
    // function returning nothing for everyone.
    expect((await searchAs(OUTSIDER, fixture.otherSpaceId, word)).map((r) => r.entity_id)).toEqual([theirs]);
    expect(await searchAs(MEMBER, fixture.otherSpaceId, word)).toEqual([]);
  });

  it('a caller with no identity gets nothing — the definer function fails closed', async () => {
    const word = unique('noidentity');
    await mintMemory({ statement: `${word} claim` });
    expect(await searchAs(MEMBER, fixture.spaceId, word)).toHaveLength(1);
    expect(await searchAs(null, fixture.spaceId, word)).toEqual([]);
  });

  it('a chain head the caller cannot read is not answered through a predecessor', async () => {
    // The head lives in the space; deleting it is the one way to make a
    // same-space head unreadable, and the walk must then stop short of it
    // rather than answer a row entity_readable refuses.
    const word = unique('hiddenhead');
    const predecessor = await mintMemory({ statement: `${word} predecessor` });
    const head = await mintMemory({ statement: 'the head' });
    await drawEdge(head, predecessor, 'supersedes', { reason: 'test' });
    await asOwner((client) => client.query('update public.entities set deleted_at = now() where id = $1', [head]));
    const rows = await searchAs(MEMBER, fixture.spaceId, word);
    expect(rows.map((r) => r.entity_id)).toEqual([predecessor]);
  });
});

describe('the facade handler carries the claims and renders the contract shape', () => {
  let db: PgDb;

  function depsFor(identityId: string): FacadeDeps {
    return {
      db,
      config: {} as ServerConfig,
      owner: async () => ({
        identityId, accountId: identityId, username: identityId, isNodeAdmin: false, isOwner: true,
      }),
    };
  }

  function context(identityId: string, body: unknown): RequestContext {
    return {
      op: { name: 'memories.search', method: 'POST', path: '/v2/memories/search', kind: 'read', status: 'v1' },
      opName: 'memories.search',
      params: {},
      query: new URLSearchParams(),
      body,
      requestId: 'req-memory-search',
      identity: { kind: 'auto-owner', identityId },
      headers: {},
      method: 'POST',
      path: '/v2/memories/search',
    } as RequestContext;
  }

  beforeAll(() => {
    db = new PgDb({ databaseUrl: database.url, max: 2 });
  });

  afterAll(async () => {
    await db?.end();
  });

  it('answers items in the contract shape for the member, and nothing for an outsider', async () => {
    const word = unique('facadeword');
    const id = await mintMemory({
      statement: `${word} through the facade`,
      subjectScope: 'this handler',
      doesNotEstablish: 'the other handlers',
    });

    const asMember = await memoriesSearch(depsFor(MEMBER))(
      context(MEMBER, { spaceId: fixture.spaceId, query: `  ${word}  ` }),
    ) as MemorySearchResult;
    expect(asMember.items).toEqual([{
      id,
      statement: `${word} through the facade`,
      subjectScope: 'this handler',
      doesNotEstablish: 'the other handlers',
      rank: expect.any(Number),
      marks: [],
    }]);
    expect(asMember.items[0]!.rank).toBeGreaterThan(0);

    const asOutsider = await memoriesSearch(depsFor(OUTSIDER))(
      context(OUTSIDER, { spaceId: fixture.spaceId, query: word }),
    ) as MemorySearchResult;
    expect(asOutsider.items).toEqual([]);
  });

  it('honours the limit', async () => {
    const word = unique('limitword');
    await mintMemory({ statement: `${word} a` });
    await mintMemory({ statement: `${word} b` });
    const page = await memoriesSearch(depsFor(MEMBER))(
      context(MEMBER, { spaceId: fixture.spaceId, query: word, limit: 1 }),
    ) as MemorySearchResult;
    expect(page.items).toHaveLength(1);
  });

  it('refuses a malformed space id as a client error, not a database one', async () => {
    await expect(
      memoriesSearch(depsFor(MEMBER))(context(MEMBER, { spaceId: 'not-a-uuid', query: 'anything' })),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      memoriesSearch(depsFor(MEMBER))(context(MEMBER, { spaceId: 'not-a-uuid', query: 'anything' })),
    ).rejects.toBeInstanceOf(CollabError);
  });
});
