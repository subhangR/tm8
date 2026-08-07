/**
 * W2.G10 — is the per-Space event sequence ACTUALLY durable, or in-memory and
 * reset-on-restart?
 *
 * The program's standing risk register says "the current live event publisher
 * uses in-memory sequence state". Reading seq.ts suggests that is stale — the
 * durable counter is a table row minted by the capture trigger — but a comment
 * is not evidence, and the whole point of this file is that the question is
 * answered EXECUTABLY. Nothing here trusts a docstring: the counter is observed
 * across a genuine teardown-and-rebuild of every in-process object.
 *
 * ## What "restart" means here, precisely
 *
 * `startNode()` builds a fresh `Pool` and a fresh set of lane objects
 * (`PgDurableSeqSource`, `PgDurableEventLog`). A restart is
 * `await node.shutdown()` followed by a second `startNode()` against the SAME
 * database URL. Every JavaScript object that could be hiding a counter is
 * discarded and rebuilt; only Postgres persists. If the sequence lived in
 * process memory, the rebuilt node would restart it at 1 and the seq assertions
 * below would fail. That is the discrimination this file exists to make, and it
 * is why the assertions check "not 1" as well as "greater than".
 *
 * ## FIXTURE
 *
 * Built, not listed: `createW1ScratchDatabase` + the FULL official chain from
 * `migrationFiles()` — every `NNN_*.sql` in db/migrations, whatever is there on
 * the day it runs. No hand-picked slice, so this cannot drift into testing a
 * schema the node does not actually run. This is an ISOLATION proof for G10, not
 * a coverage proof for the chain.
 *
 * ## ROLE
 *
 * Reads that model the SERVER go through `tm8_app`, never the superuser, because
 * `tm8` bypasses RLS and a test run as `tm8` would pass even if every space's
 * events leaked to every caller. `asOwner` exists only for fixture assertions
 * that deliberately want the un-filtered truth to compare against.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import { PgDurableSeqSource } from '../../src/events/seq.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/** `internal.command_result` shape: `{entity, activity?, patches[]}` (007:49). */
interface CommandResult {
  entity: { id: string };
}

// ---------------------------------------------------------------------------
// A node process, startable and stoppable
// ---------------------------------------------------------------------------

/** `SET LOCAL` for the four canonical claims, as db/types.ts specifies them. */
async function applyClaims(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  claims: DbClaims,
): Promise<void> {
  const bindings: Array<[string, string]> = [];
  if (claims.identityId !== undefined) bindings.push(['tm8.identity_id', claims.identityId]);
  if (claims.actorId !== undefined) bindings.push(['tm8.actor_id', claims.actorId]);
  // 'true'/'false', never 'on'/'off' — 001:166 compares against the literal.
  if (claims.nodeAdmin !== undefined) bindings.push(['tm8.node_admin', claims.nodeAdmin ? 'true' : 'false']);
  if (claims.requestId !== undefined) bindings.push(['tm8.request_id', claims.requestId]);
  for (const [name, value] of bindings) {
    await client.query('select set_config($1, $2, true)', [name, value]);
  }
}

interface NodeDb extends Db {
  /** Un-filtered truth, as the superuser. Fixture assertions only. */
  asOwner<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
}

interface NodeProcess {
  readonly db: NodeDb;
  /** The lane object under test. Rebuilt on every start — carries no state. */
  readonly seq: PgDurableSeqSource;
  readonly log: PgDurableEventLog;
  /** Ends the pool. Models the process dying. */
  shutdown(): Promise<void>;
}

/**
 * Boot a node against `connectionString`.
 *
 * Everything in here is per-process state. Calling `shutdown()` then
 * `startNode()` again is the strongest restart this test can stage without
 * actually forking, and it is strong enough: no object survives it.
 */
function startNode(connectionString: string, readerClaims: () => DbClaims = () => ({})): NodeProcess {
  const pool = new Pool({ connectionString, max: 4 });

  const querier = (client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; fields?: ReadonlyArray<{ name: string }> }>;
  }): Querier => ({
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      const res = await client.query(sql, [...params]);
      return res.rows as R[];
    },
    // MIRRORS db/client.ts `makeQuerier` — see the note in events/pg-harness.ts.
    // A `returns table(...)` RPC with zero rows made the old scalar shape throw.
    async rpc<T>(fn: string, args: readonly unknown[] = []): Promise<T> {
      const placeholders = args.map((_, i) => `$${String(i + 1)}`).join(', ');
      const qualified = fn.includes('.') ? fn : `public.${fn}`;
      const res = await client.query(`select * from ${qualified}(${placeholders})`, [...args]);
      if (res.rows.length === 1 && res.fields?.length === 1) {
        const field = res.fields[0];
        return (field ? (res.rows[0] as Record<string, unknown>)[field.name] : undefined) as T;
      }
      return res.rows as unknown as T;
    },
  });

  async function run<T>(role: string | null, claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // SET ROLE first, then the claims, so the claims land in the transaction
      // the role will read them from.
      if (role !== null) await client.query(`set local role ${role}`);
      await applyClaims(client, claims);
      const out = await fn(querier(client));
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  const db: NodeDb = {
    tx: (claims, fn) => run('tm8_app', claims, fn),
    rpc: (claims, fn, args = []) => run('tm8_app', claims, (q) => q.rpc(fn, args)),
    query: (claims, sql, params = []) => run('tm8_app', claims, (q) => q.query(sql, params)),
    asOwner: (fn) => run(null, {}, fn),
    end: () => pool.end(),
  };

  // `PgDurableSeqSource` takes a bare `Querier`. It runs as tm8_app — the role
  // the real node connects as — and, CRUCIALLY, with the READER'S OWN CLAIMS.
  //
  // This used to bind no claims at all, modelling "a long-lived server-side
  // reader". That model was wrong: it describes a caller the design does not
  // have. Every read on the durable path is per-connection under that
  // connection's identity, precisely so one member's private notifications
  // cannot be fanned out to a Space. A fixture describing an identity-less
  // reader kept generating findings about a path nobody uses — and those
  // findings looked real, which costs a trace every time.
  //
  // It did earn its keep once: it is what exposed that `latest()` mapped
  // no-row to 0, i.e. a caller who cannot see the row is told the Space has
  // never had an event. That is now unrepresentable — `latest()` returns null.
  const appQuerier: Querier = {
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      return run('tm8_app', readerClaims(), (q) => q.query<R>(sql, params));
    },
    async rpc<T>(fn: string, args: readonly unknown[] = []): Promise<T> {
      return run('tm8_app', readerClaims(), (q) => q.rpc<T>(fn, args));
    },
  };

  return {
    db,
    seq: new PgDurableSeqSource(appQuerier),
    log: new PgDurableEventLog(db),
    shutdown: () => pool.end(),
  };
}

// ---------------------------------------------------------------------------

describe.sequential('W2.G10 durable per-Space event sequence (real Postgres)', () => {
  let scratch: W1ScratchDatabase;
  let node: NodeProcess;

  /** The space under test, its owning identity, and its member row. */
  let identityId: string;
  let spaceId: string;
  let memberId: string;

  /** A second space, to prove the counters are per-Space and not global. */
  let otherSpaceId: string;
  let otherMemberId: string;

  /** An identity that is a member of NOTHING. The negative half's caller. */
  let outsiderId: string;

  const claims = (who: string = identityId): DbClaims => ({
    identityId: who,
    nodeAdmin: false,
    requestId: `req_${randomUUID()}`,
  });

  /** Create a task through the RPC, and return its id. The ONLY event source. */
  async function createTask(space: string, member: string, title: string, who?: string): Promise<string> {
    const result = await node.db.rpc<CommandResult>(claims(who), 'public.create_task', [
      space, title, member, '',
      null, null, null, 'medium', null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    return result.entity.id;
  }

  /** The stored counter, read as the superuser — the un-filtered truth. */
  async function storedSeq(space: string): Promise<number> {
    const rows = await node.db.asOwner((q) =>
      q.query<{ last_seq: string }>('select last_seq from public.space_event_seq where space_id = $1', [space]),
    );
    return rows[0] === undefined ? 0 : Number(rows[0].last_seq);
  }

  async function makeSpace(who: string, name: string): Promise<{ spaceId: string; memberId: string }> {
    const created = await node.db.rpc<{ space: { id: string } }>(claims(who), 'public.create_space', [
      name, 'G10 durability proof', 'private', null, null,
    ]);
    const space = created.space.id;
    const members = await node.db.query<{ entity_id: string }>(
      claims(who),
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [space, who],
    );
    return { spaceId: space, memberId: members[0]!.entity_id };
  }

  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('g10_events');
    // BUILT, NOT LISTED: the full official chain, whatever it contains today.
    scratch.apply(migrationFiles());

    node = startNode(scratch.url);

    identityId = `identity_${randomUUID()}`;
    outsiderId = `identity_${randomUUID()}`;
    await node.db.rpc(claims(), 'public.upsert_user_profile', ['G10 Owner', null, null]);
    await node.db.rpc(claims(outsiderId), 'public.upsert_user_profile', ['G10 Outsider', null, null]);

    ({ spaceId, memberId } = await makeSpace(identityId, 'G10 durable events'));
    ({ spaceId: otherSpaceId, memberId: otherMemberId } = await makeSpace(identityId, 'G10 second space'));

    await createTask(spaceId, memberId, 'before restart one');
    await createTask(spaceId, memberId, 'before restart two');
  }, 180_000);

  afterAll(async () => {
    // Teardown on EVERY path, including failure — the scratch database must not
    // outlive the run. `node` may be undefined if beforeAll threw early.
    await node?.shutdown().catch(() => undefined);
    await scratch?.destroy().catch(() => undefined);
  }, 60_000);

  it('mints the per-Space seq in the mutating transaction, with no server involvement', async () => {
    // The premise everything else rests on: nothing in this test constructs a
    // seq, calls a publisher, or inserts into workspace_events. If the rows are
    // there, the trigger put them there.
    const rows = await node.db.query<{ seq: string; event_type: string }>(
      claims(),
      'select seq, event_type from public.workspace_events where space_id = $1 order by seq asc',
      [spaceId],
    );
    expect(rows.length).toBeGreaterThan(0);

    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs, 'seq must be ascending').toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size, 'seq must be unique — it is the dedupe key').toBe(seqs.length);
    expect(seqs[0]).toBe(1);

    // The counter row and the log agree.
    expect(await storedSeq(spaceId)).toBe(seqs.at(-1));
  });

  it('the counter is STORED: it survives a full process restart and never restarts at 1', async () => {
    const before = await storedSeq(spaceId);
    expect(before).toBeGreaterThan(0);

    const seqsBefore = (await node.db.query<{ seq: string }>(
      claims(), 'select seq from public.workspace_events where space_id = $1 order by seq asc', [spaceId],
    )).map((r) => Number(r.seq));

    // ---- RESTART. Every in-process object dies here. -----------------------
    await node.shutdown();
    node = startNode(scratch.url);
    // ------------------------------------------------------------------------

    // The stored high-water mark did not move, and above all did not reset.
    expect(await storedSeq(spaceId), 'a restart must not reset the counter').toBe(before);

    // The decisive assertion: the FIRST event after a restart continues the
    // sequence. An in-memory counter would hand out 1 here and collide with the
    // event that already owns seq 1 — destroying the dedupe key, the ordering
    // key and the poll cursor in one move.
    await createTask(spaceId, memberId, 'after restart');
    const after = await storedSeq(spaceId);
    expect(after).toBeGreaterThan(before);
    expect(after, 'a post-restart event must not be numbered 1').not.toBe(1);

    const seqsAfter = (await node.db.query<{ seq: string }>(
      claims(), 'select seq from public.workspace_events where space_id = $1 order by seq asc', [spaceId],
    )).map((r) => Number(r.seq));

    // No reuse across the restart boundary, and the pre-restart events are all
    // still there and unchanged.
    expect(new Set(seqsAfter).size, 'no seq may be reused across a restart').toBe(seqsAfter.length);
    expect(seqsAfter.slice(0, seqsBefore.length)).toEqual(seqsBefore);
    expect(seqsAfter.length).toBeGreaterThan(seqsBefore.length);
  }, 60_000);

  it('counters are per-Space: advancing one space does not move another', async () => {
    const mainBefore = await storedSeq(spaceId);
    const otherBefore = await storedSeq(otherSpaceId);

    await createTask(otherSpaceId, otherMemberId, 'other space task');

    expect(await storedSeq(otherSpaceId)).toBeGreaterThan(otherBefore);
    expect(await storedSeq(spaceId), 'the untouched space must not move').toBe(mainBefore);

    // And the two number spaces overlap — which is only safe because the dedupe
    // key is (spaceId, seq), never seq alone.
    const otherSeqs = (await node.db.query<{ seq: string }>(
      claims(), 'select seq from public.workspace_events where space_id = $1 order by seq asc', [otherSpaceId],
    )).map((r) => Number(r.seq));
    expect(otherSeqs[0]).toBe(1);
  }, 60_000);

  it('replay after a seq reconciles across a restart with no gap and no duplicate', async () => {
    // Catch up fully, then remember where we were — exactly what a client does
    // before it loses the socket.
    const caughtUp = await node.log.since(spaceId, 0, 500, claims());
    expect(caughtUp.items.length).toBeGreaterThan(0);
    const cursor = Number(caughtUp.nextCursor);
    expect(cursor).toBeGreaterThan(0);

    const seen = new Set(caughtUp.items.map((e) => e.seq));

    // Events happen while the client is away...
    await createTask(spaceId, memberId, 'missed one');
    await createTask(spaceId, memberId, 'missed two');

    // ---- ...and the node restarts underneath it too. ------------------------
    await node.shutdown();
    node = startNode(scratch.url);
    // ------------------------------------------------------------------------

    const replay = await node.log.since(spaceId, cursor, 500, claims());
    expect(replay.items.length, 'the client must not be told it is caught up').toBeGreaterThan(0);

    // NO DUPLICATE: nothing the client already applied comes back.
    for (const event of replay.items) {
      expect(seen.has(event.seq), `seq ${String(event.seq)} was replayed twice`).toBe(false);
      expect(event.seq).toBeGreaterThan(cursor);
    }

    // NO GAP: the replayed seqs are contiguous with the cursor. A hole here is
    // the silent data loss this whole operation exists to prevent.
    const replayed = replay.items.map((e) => e.seq).sort((a, b) => a - b);
    expect(replayed[0]).toBe(cursor + 1);
    for (let i = 1; i < replayed.length; i += 1) {
      expect(replayed[i], 'replayed seqs must be contiguous').toBe(replayed[i - 1]! + 1);
    }

    // The new cursor is a fixed point: replaying from it returns nothing and
    // echoes the position rather than losing it.
    const settled = await node.log.since(spaceId, Number(replay.nextCursor), 500, claims());
    expect(settled.items).toEqual([]);
    expect(settled.nextCursor).toBe(replay.nextCursor);
  }, 60_000);

  it('a non-member replaying the space gets NOTHING, and the member still gets everything', async () => {
    // NEGATIVE. `outsiderId` is a real identity with a real profile that is a
    // member of no space. RLS (008 workspace_events_select) is the only thing
    // standing between it and the log.
    const outsider = await node.log.since(spaceId, 0, 500, claims(outsiderId));
    expect(outsider.items, 'a non-member must not read another space’s events').toEqual([]);

    // POSITIVE — the half that stops this passing by refusing everyone. The
    // SAME call, the SAME space, the SAME cursor, differing only in identity.
    const member = await node.log.since(spaceId, 0, 500, claims(identityId));
    expect(member.items.length, 'the legitimate member must still be served').toBeGreaterThan(0);
    expect(member.items.every((e) => e.spaceId === spaceId)).toBe(true);
  }, 60_000);

  /**
   * The documented reason `PgDurableSeqSource` reads the counter row rather than
   * `max(seq) from workspace_events` (seq.ts:107-116): retention pruning deletes
   * events, and a high-water mark derived from a pruned table would move
   * BACKWARD. Destructive — it empties the log — so it runs last.
   */
  it('the high-water mark survives retention pruning, where max(seq) would move backward', async () => {
    const before = await storedSeq(spaceId);
    expect(before).toBeGreaterThan(0);

    const removed = await node.db.asOwner((q) =>
      q.rpc<string>('internal.prune_workspace_events', ["0 seconds"]),
    );
    expect(Number(removed)).toBeGreaterThan(0);

    // The log really is empty for this space now...
    const maxAfterPrune = await node.db.asOwner((q) =>
      q.query<{ high: string | null }>(
        'select max(seq) as high from public.workspace_events where space_id = $1', [spaceId],
      ),
    );
    expect(maxAfterPrune[0]?.high).toBeNull();

    // ...and the counter is untouched. This is the whole argument for the
    // counter row: a mark that can decrease is not a high-water mark.
    expect(await storedSeq(spaceId)).toBe(before);

    // A new event after pruning continues from the mark rather than reusing a
    // seq the client may still be holding as its cursor.
    //
    // NOTE: asserted as "strictly greater", not "before + 1". An earlier
    // version of this test asserted +1 and went red — that was the TEST's bug,
    // not the database's: one `create_task` produces MORE THAN ONE captured
    // event (the entity upsert plus its activity), so the counter legitimately
    // advances by more than one per command. The property that actually matters
    // is that the next seq is past the pruned high-water mark, never that the
    // step size is one.
    await createTask(spaceId, memberId, 'after prune');
    const afterPrune = await storedSeq(spaceId);
    expect(afterPrune).toBeGreaterThan(before);

    const reissued = await node.db.asOwner((q) =>
      q.query<{ seq: string }>('select seq from public.workspace_events where space_id = $1', [spaceId]),
    );
    // Nothing written after the prune may reuse a seq at or below the mark.
    expect(reissued.every((r) => Number(r.seq) > before)).toBe(true);
  }, 60_000);
});

/**
 * `PgDurableSeqSource` — the class the lane exports for exactly the job of
 * telling a reconnecting client how far the durable log has got.
 *
 * These are in their own scratch database because the assertion is about the
 * ROLE the reader runs as, and mixing it with the durability tests above would
 * make a failure ambiguous between "the counter is wrong" and "the reader
 * cannot see it".
 */
describe.sequential('W2.G10 PgDurableSeqSource under the role the server actually connects as', () => {
  let scratch: W1ScratchDatabase;
  let node: NodeProcess;
  let identityId: string;
  let spaceId: string;
  let memberId: string;

  const claims = (who: string = identityId): DbClaims => ({
    identityId: who, nodeAdmin: false, requestId: `req_${randomUUID()}`,
  });

  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('g10_seqsrc');
    scratch.apply(migrationFiles());
    // The reader is a BOUND MEMBER — the only caller shape this design has.
    node = startNode(scratch.url, () => ({ identityId, nodeAdmin: false }));

    identityId = `identity_${randomUUID()}`;
    await node.db.rpc(claims(), 'public.upsert_user_profile', ['G10 Seq Owner', null, null]);
    const created = await node.db.rpc<{ space: { id: string } }>(claims(), 'public.create_space', [
      'G10 seq source', 'seq source proof', 'private', null, null,
    ]);
    spaceId = created.space.id;
    const members = await node.db.query<{ entity_id: string }>(
      claims(), 'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [spaceId, identityId],
    );
    memberId = members[0]!.entity_id;

    await node.db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId, 'seq source anchor', memberId, '',
      null, null, null, 'medium', null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ]);
  }, 180_000);

  afterAll(async () => {
    await node?.shutdown().catch(() => undefined);
    await scratch?.destroy().catch(() => undefined);
  }, 60_000);

  it('reports the high-water mark of a space that demonstrably has events', async () => {
    // The truth, as the superuser sees it.
    const truth = await node.db.asOwner((q) =>
      q.query<{ last_seq: string }>('select last_seq from public.space_event_seq where space_id = $1', [spaceId]),
    );
    const stored = Number(truth[0]!.last_seq);
    expect(stored, 'fixture must have produced events').toBeGreaterThan(0);

    // And the truth as the SERVER sees it, through the class the lane exports
    // for this purpose, read as a MEMBER — which db/migrations/035 made possible
    // by landing a grant AND a policy together. A bare grant would have left the
    // table RLS-enabled with no policy, i.e. silently zero rows.
    expect(await node.seq.latest(spaceId)).toBe(stored);
  }, 60_000);

  /**
   * The RED half, against a real database — which this file did not have.
   *
   * `latest()` returning `null` rather than `0` was only ever observed at unit
   * level, where the null was INJECTED by a fake. That left the one branch 035
   * changed the ground under with a green half and no red half, in the exact
   * place we have been most careful everywhere else.
   *
   * Three states through `PgDurableSeqSource` itself, not through raw SQL, so
   * this proves the READER's behaviour and not merely the migration's policy:
   *
   *   A. member          → the true mark
   *   B. non-member      → null
   *   C. unbound identity→ null
   *
   * B and C matter separately. C fails `internal.is_space_member` because there
   * is no identity to test; B fails it because a real, authenticated identity is
   * simply not in this Space. A reader that handled only one of them would look
   * correct against whichever fixture happened to be written.
   */
  it('returns NULL — never 0 — for a non-member and for an unbound identity, while the member still gets the mark', async () => {
    const truth = await node.db.asOwner((q) =>
      q.query<{ last_seq: string }>('select last_seq from public.space_event_seq where space_id = $1', [spaceId]),
    );
    const stored = Number(truth[0]!.last_seq);
    expect(stored, 'fixture must have produced events').toBeGreaterThan(0);

    // B — a REAL identity, with a real profile, that is a member of no Space.
    const outsiderId = `identity_${randomUUID()}`;
    await node.db.rpc(claims(outsiderId), 'public.upsert_user_profile', ['G10 Seq Outsider', null, null]);
    const outsider = startNode(scratch.url, () => ({ identityId: outsiderId, nodeAdmin: false }));

    // C — no identity bound at all.
    const unbound = startNode(scratch.url, () => ({}));

    try {
      // Both must be null, and the distinction from 0 is the whole point:
      // `latest()` used to document 0 as "this space has never had an event",
      // so 0 here would be a confident wrong answer about a Space with events —
      // and a consumer seeding a live cursor from it replays the entire
      // retained log at a client that asked for none of it.
      expect(await outsider.seq.latest(spaceId), 'a non-member must not be told 0').toBeNull();
      expect(await unbound.seq.latest(spaceId), 'an unbound identity must not be told 0').toBeNull();
    } finally {
      await outsider.shutdown().catch(() => undefined);
      await unbound.shutdown().catch(() => undefined);
    }

    // A — the POSITIVE half, restated against the SAME Space in the SAME test.
    // Without it this whole assertion would pass just as well against a reader
    // that returned null for everybody.
    expect(await node.seq.latest(spaceId)).toBe(stored);
  }, 60_000);
});
