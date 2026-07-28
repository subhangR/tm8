import { encodeCursor } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbClaims } from '../../../src/db/types.js';
import { PgDb } from '../../../src/db/client.js';
import { loadActivity } from '../../../src/facade/handlers/activity.js';
import { W2InboxReadMarksService } from '../../../src/facade/services/w2/inbox-read-marks.js';
import { getOperation, type OperationName } from '@tm8/contract';
import type { RequestContext } from '../../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../../db/w1-pg.js';

/**
 * W5 DUO B — THE DECODE-SIDE REFUSAL, AND WHY THIS ONE IS REACHABLE.
 *
 * The MINT-side refusal class (the two spelling-B truthiness guards at
 * `messages-handoffs.ts:562` and `feed-context.ts:1187`) CANNOT be driven red
 * from outside: both producers always supply their value today, so the guards
 * cannot fire without editing production source. That is recorded as a
 * CANNOT-REACH, not papered over with a green.
 *
 * THE DECODE SIDE IS DIFFERENT, AND THAT IS THE WHOLE POINT OF THIS FILE.
 * A cursor arrives from the CLIENT, so a hostile or stale one is an ordinary
 * input — no production edit required to produce it.
 *
 *   `activity.ts:46-51`      `params.push(String(k[0]), String(k[1]))`
 *                            straight into `$::timestamptz`. NO `Date.parse`.
 *   `inbox-read-marks.ts`    decodes with `Number.isNaN(Date.parse(...))` and
 *                            throws `invalid_cursor`.
 *   `identity-spaces.ts`     same guard.
 *
 * So `activity.ts` is the SILENT PRODUCER WITH NO LUCKY CONSUMER: B1's missing
 * value surfaced as a clean 400 only because the INBOX decoder happened to
 * check. Point the same shape at activity and nothing checks.
 *
 * WHAT THIS FILE ASSERTS: a malformed cursor is a CLIENT error and must be
 * refused as `invalid_cursor`. It must NOT reach the database and come back as
 * an upstream/driver error, because those are different status classes, and a
 * caller cannot fix a 5xx by fixing its cursor.
 *
 * WHAT IT CAN BE SATISFIED BY: any refusal carrying `invalid_cursor`. It is NOT
 * satisfied by a Postgres `invalid input syntax for type timestamp` surfacing
 * through the driver, and NOT by a silent empty page.
 *
 * BOTH HALVES LIVE IN THIS FILE, ON THE SAME FIXTURE AND IN THE SAME RUN:
 * `inbox.list` is the KNOWN-GOOD decoder and must refuse cleanly; `loadActivity`
 * is the KNOWN-BAD one. A detector that fired on both would prove nothing.
 */

vi.setConfig({ testTimeout: 120_000 });

interface Fixture { identityId: string; spaceId: string; memberId: string }

const UUID = '11111111-2222-3333-4444-555555555555';

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<Fixture>(
      `select 'w5-decode-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'W5 decode owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'W5 Decode Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [base.memberId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','W5 decode owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.activity(space_id,entity_id,actor_id,verb,summary)
       select $1,$2,$2,'created',jsonb_build_object('n',g) from generate_series(1,3) g`,
      [base.spaceId, base.memberId],
    );
    return base;
  });
}

function ctxFor(opName: OperationName, identityId: string, query: string): RequestContext {
  const op = getOperation(opName);
  return {
    op, opName, params: {},
    query: new URLSearchParams(query),
    body: undefined,
    requestId: `req-${opName}`,
    identity: { kind: 'auto-owner', identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

/** Captures whatever a call throws, so the SHAPE of the failure can be asserted. */
async function thrownBy(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
    return { message: '<<did not throw>>' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ...(e.code ? { code: e.code } : {}), message: String(e.message ?? err) };
  }
}

describe.sequential('W5 Duo B — decode-side cursor refusal', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let claims: DbClaims;
  let inbox: W2InboxReadMarksService;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5_decode_refusal');
    database.apply(migrationFiles());
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    claims = { identityId: fixture.identityId, nodeAdmin: false, requestId: 'req-w5-decode' };
    inbox = new W2InboxReadMarksService({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000999',
        username: 'w5-decode-owner',
        isNodeAdmin: false,
        isOwner: true,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
  }, 120_000);

  // -------------------------------------------------------------------------
  // KNOWN-GOOD — the decoder that DOES refuse. Without this the check below
  // would be indistinguishable from one that fires on every malformed input.
  // -------------------------------------------------------------------------

  it('KNOWN-GOOD: inbox.list refuses a non-date cursor as invalid_cursor', async () => {
    const bad = encodeCursor(['any-fingerprint', 'definitely-not-a-timestamp', UUID]);
    const thrown = await thrownBy(() =>
      inbox.list(ctxFor('inbox.list', fixture.identityId, `limit=2&cursor=${encodeURIComponent(bad)}`)));

    expect(thrown.code).toBe('invalid_cursor');
  });

  // -------------------------------------------------------------------------
  // THE FINDING — the decoder that does not.
  // -------------------------------------------------------------------------

  it('a non-date cursor is refused as invalid_cursor, not passed to the database', async () => {
    // Two slots, matching activity's keyset shape, with a value that is a
    // perfectly good STRING and not remotely a timestamp. `decodeCursor`
    // accepts it (the codec only checks structure), and `activity.ts:46-51`
    // performs NO further validation before binding it to `$::timestamptz`.
    const bad = encodeCursor(['definitely-not-a-timestamp', UUID]);
    const thrown = await thrownBy(() =>
      facadeDb.tx(claims, (q) => loadActivity(q, { spaceId: fixture.spaceId, limit: 2, cursor: bad })));

    // The contract: a bad cursor is a CLIENT error. A caller cannot fix a
    // database syntax error by fixing its cursor, because nothing tells it the
    // cursor was the problem.
    expect(thrown.code).toBe('invalid_cursor');
  });

  it('a structurally wrong keyset length is refused before any query runs', async () => {
    // activity.ts:48 DOES check `k.length !== 2`, so this half is expected to
    // pass today. Asserted so the file distinguishes "no validation at all"
    // from "structural validation but no VALUE validation" — the second is the
    // real state, and a report saying the first would be wider than the truth.
    const bad = encodeCursor(['a', 'b', 'c']);
    const thrown = await thrownBy(() =>
      facadeDb.tx(claims, (q) => loadActivity(q, { spaceId: fixture.spaceId, limit: 2, cursor: bad })));

    expect(thrown.code).toBe('invalid_cursor');
  });
});
