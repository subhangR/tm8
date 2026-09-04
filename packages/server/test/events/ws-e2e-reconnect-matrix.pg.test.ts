/**
 * DRAFT — destined for packages/server/test/events/ws-e2e-reconnect-matrix.pg.test.ts
 * (held in scratchpad while the tree is frozen; do not run from here)
 *
 * The reconnect/gap MATRIX (coordinator directive, sanctioned enrichment):
 *
 *   { gap size: 0, 1, exactly-batch, batch+1, multi-page }
 * × { mutation during the gap: task entity, message, recipient-targeted }
 * × { reconnect mode: resume-from-lastApplied, resume-from-0 re-entry }
 *
 * — 30 cells, every one asserted as an EXACT seq set against the TABLE
 * (groundTruth: a superuser read independent of every instrument on the
 * delivery path), never as "the expected event appeared".
 *
 * Every cell drives the REAL CLIENT ALGORITHM the bridge team ships —
 * `clientSync`: subscribe (join the live fan-out, seed at high-water), then
 * ALWAYS resume, looping until a resume round delivers nothing new. The suite
 * exercises the algorithm, not single hand-rolled frames.
 *
 * ## Why this lives at the composed level, not over bootstrap()
 *
 * Two of the five gap sizes are DEFINED relative to the delivery batch
 * ("exactly batch", "batch+1"). The production pump's batch is 200 and
 * MAX_RESUME_BATCH is a const — hitting those boundaries through bootstrap()
 * would mean seeding hundreds of RPC mutations per cell. The pump's `batch`
 * is an injectable production knob; at batch=3 the same boundary properties
 * cost single-digit mutations per cell. The composition is the real one —
 * `composeRealEventPath` (the single factory that holds every control.ts
 * construction) over a real scratch database and real trigger-captured rows.
 * Suite A (ws-e2e.pg.test.ts A4) keeps one full-bootstrap reconnect case so
 * the bootstrap-level wiring of the same path stays covered.
 *
 * ## Organic MAX_RESUME_BATCH coverage
 *
 * Cells run sequentially in ONE growing space, so the late from-zero
 * re-entry cells replay the full accumulated history (~500+ rows by the
 * tail of the run) and cross the real MAX_RESUME_BATCH (=MAX_POLL_LIMIT=500)
 * boundary through clientSync's multi-round loop. GO-EDIT-day named step:
 * confirm the actual row count exceeds 500; bump the multi-page gap if short.
 *
 * RUN: cd packages/server && ./node_modules/.bin/vitest run \
 *        --no-file-parallelism test/events/ws-e2e-reconnect-matrix.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { MAX_POLL_LIMIT } from '../../src/events/poll.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { createTestDb, type TestDb } from './pg-harness.js';
import {
  addSpaceMember,
  claimsFor,
  clientSync,
  closed,
  collect,
  composeRealEventPath,
  connectWs,
  groundTruth,
  postMentioning,
  postMessage,
  spine,
  startComposedWsServer,
  type ComposedWsServer,
} from './ws-e2e-harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/** The injected pump batch — the unit the gap-size dimension is measured in. */
const BATCH = 3;

/** Gap sizes in MUTATIONS. Each mutation mints >1 row, so 'exactly batch' in
 * mutations is already several delivery pages in rows — the boundary is
 * crossed in every non-trivial cell, and named cells pin the edges. */
const GAP_SIZES = [
  { label: 'gap=0 (clean reconnect)', mutations: 0 },
  { label: 'gap=1', mutations: 1 },
  { label: `gap=batch (${String(BATCH)})`, mutations: BATCH },
  { label: `gap=batch+1 (${String(BATCH + 1)})`, mutations: BATCH + 1 },
  // 14, not 10: the shared space must OUTGROW MAX_RESUME_BATCH by the end of
  // the run (the final count assertion enforces it); at 10 the history topped
  // out at 456 rows — measured, and exactly the silent shortfall the
  // assertion exists to catch.
  { label: 'gap=multi-page (14)', mutations: 14 },
] as const;

type MutationKind = 'task' | 'message' | 'targeted';
const MUTATION_KINDS: readonly MutationKind[] = ['task', 'message', 'targeted'];

type ReconnectMode = 'from-lastApplied' | 'from-zero';
const RECONNECT_MODES: readonly ReconnectMode[] = ['from-lastApplied', 'from-zero'];

let database: W1ScratchDatabase;
let db: TestDb;
let composition: ReturnType<typeof composeRealEventPath>;
let composed: ComposedWsServer;

let spaceId = '';
let memberA: { identityId: string; memberId: string };
let memberB: { identityId: string; memberId: string };
let anchorTaskId = '';

const sockets: WebSocket[] = [];

/** Deterministic quiescence: tick the pump until two consecutive idle rounds. */
async function settle(): Promise<void> {
  let idle = 0;
  for (let i = 0; i < 200 && idle < 2; i += 1) {
    const delivered = await composition.pump.tick();
    // One macrotask so socket writes flush before the frame count is read.
    await new Promise((r) => setTimeout(r, 15));
    idle = delivered === 0 ? idle + 1 : 0;
  }
  if (idle < 2) throw new Error('the pump never went idle — delivery is looping');
}

async function mutate(kind: MutationKind, label: string): Promise<void> {
  if (kind === 'task') {
    await db.rpc(claimsFor(memberA.identityId), 'public.create_task', [
      spaceId, label, memberA.memberId, '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    return;
  }
  if (kind === 'message') {
    // Through the bound door (w2_post_message_batch) — public.post_message is
    // not executable by tm8_app (019:1321; the documented baseline reds).
    await postMessage(db, memberA.identityId, memberA.memberId, anchorTaskId, label);
    return;
  }
  // 'targeted': space-wide message.created PLUS a notification row addressed
  // to member B — the row the reconnecting A-socket must skip WITHOUT
  // wedging, in the middle of its gap replay.
  await postMentioning(db, memberA.identityId, memberA.memberId, anchorTaskId, memberB.memberId, label);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('wse2e_matrix');
  database.apply(migrationFiles());
  db = createTestDb(database.url);

  memberA = { identityId: `identity_${randomUUID()}`, memberId: '' };
  await db.rpc(claimsFor(memberA.identityId), 'public.upsert_user_profile', ['Matrix A', null, null]);
  const created = await db.rpc<{ space: { id: string } }>(
    claimsFor(memberA.identityId),
    'public.create_space',
    ['reconnect matrix space', 'gap proof', 'private', null, null],
  );
  spaceId = created.space.id;
  const rows = await db.query<{ entity_id: string }>(
    claimsFor(memberA.identityId),
    'select entity_id from public.members where space_id = $1 and identity_id = $2',
    [spaceId, memberA.identityId],
  );
  memberA.memberId = rows[0]!.entity_id;
  memberB = await addSpaceMember(db, spaceId, memberA.identityId, 'Matrix B');

  const anchor = await db.rpc<{ entity: { id: string } }>(
    claimsFor(memberA.identityId),
    'public.create_task',
    [spaceId, 'matrix anchor', memberA.memberId, '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`],
  );
  anchorTaskId = anchor.entity.id;

  composition = composeRealEventPath(db, { batch: BATCH });
  composed = await startComposedWsServer(composition);
});

afterAll(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  await composed?.close();
  await db?.end();
  await database?.destroy();
});

describe(`reconnect/gap matrix (pump batch=${String(BATCH)}, real client algorithm)`, () => {
  for (const gap of GAP_SIZES) {
    for (const kind of MUTATION_KINDS) {
      for (const mode of RECONNECT_MODES) {
        // gap=0 has no mutation to vary; run it once per mode, under 'task'.
        if (gap.mutations === 0 && kind !== 'task') continue;

        it(`${gap.label} × ${kind} × ${mode}: exact visible set, no loss, no duplicate, then live`, async () => {
          // ---- Session 1: sync to current, remember the applied cursor.
          const ws1 = await connectWs(`${composed.wsBase}/v2/ws?testIdentity=${memberA.identityId}`);
          sockets.push(ws1);
          const frames1 = collect(ws1);
          const lastApplied = await clientSync(ws1, frames1, spaceId, 0, settle, composition.seeds);
          ws1.close();
          await closed(ws1);

          // ---- The gap: mutations while no socket exists.
          for (let i = 0; i < gap.mutations; i += 1) {
            await mutate(kind, `${kind}-gap-${String(i)}-${randomUUID().slice(0, 8)}`);
          }

          // ---- Ground truth for the window, from the table itself.
          const truth = await groundTruth(database, spaceId, lastApplied, memberA.memberId);
          if (gap.mutations === 0) {
            expect(truth.visible, 'gap=0 must mint nothing').toEqual([]);
          } else {
            expect(truth.visible.length, 'the gap must mint visible rows').toBeGreaterThan(0);
          }
          if (kind === 'targeted') {
            expect(truth.excluded.length, 'targeted cells must mint rows A cannot see').toBeGreaterThan(0);
          }

          // ---- Session 2: reconnect with the REAL client algorithm.
          const since = mode === 'from-lastApplied' ? lastApplied : 0;
          const ws2 = await connectWs(`${composed.wsBase}/v2/ws?testIdentity=${memberA.identityId}`);
          sockets.push(ws2);
          const frames2 = collect(ws2);
          const finalCursor = await clientSync(ws2, frames2, spaceId, since, settle, composition.seeds);

          const got = spine(frames2.all);
          const gotSeqs = got.map(([s]) => s);

          // No duplicates, ascending — in EVERY cell, both modes.
          expect(new Set(gotSeqs).size, 'duplicate seq on the wire').toBe(gotSeqs.length);
          expect(gotSeqs).toEqual([...gotSeqs].sort((a, b) => a - b));

          if (mode === 'from-lastApplied') {
            // Exactly the gap window: the table's visible rows, all of them,
            // nothing else, nothing at or below the cursor.
            expect(gotSeqs, 'delivered set != table visible set for the gap').toEqual(truth.visible);
            expect(gotSeqs.every((s) => s > lastApplied)).toBe(true);
          } else {
            // Re-entry from zero: full visible history — the pre-gap window
            // AND the gap — exactly once.
            const fullTruth = await groundTruth(database, spaceId, 0, memberA.memberId);
            expect(gotSeqs, 'from-zero re-entry does not equal full visible history').toEqual(fullTruth.visible);
          }

          // Excluded rows are excluded by SEQ, not by type-absence.
          for (const seq of truth.excluded) {
            expect(gotSeqs.includes(seq), `excluded seq ${String(seq)} reached the socket`).toBe(false);
          }

          // ---- Live continuation: the synced socket is in the fan-out.
          const liveTitle = `live-${gap.mutations}-${kind}-${mode}-${randomUUID().slice(0, 8)}`;
          await mutate('task', liveTitle);
          await settle();
          const liveTruth = await groundTruth(database, spaceId, finalCursor, memberA.memberId);
          expect(liveTruth.visible.length).toBeGreaterThan(0);
          // settle() pumped the delivery; the tail-wait covers the last hop
          // (socket receipt on the client side), then exact-set.
          await frames2.next(
            (f) => (f as { seq?: number }).seq === liveTruth.visible[liveTruth.visible.length - 1]!,
          );
          const after = spine(frames2.all).map(([s]) => s);
          expect(
            after.filter((s) => s > finalCursor),
            'live delivery after sync does not match the table',
          ).toEqual(liveTruth.visible);

          ws2.close();
          await closed(ws2);
        });
      }
    }
  }

  /**
   * THE ORGANIC MAX_RESUME_BATCH CROSSING, ASSERTED RATHER THAN ESTIMATED.
   *
   * The cells above share ONE growing space, so the late from-zero re-entries
   * replay the full accumulated history through clientSync's multi-round
   * resume loop. That only exercises the real `MAX_RESUME_BATCH`
   * (= MAX_POLL_LIMIT) boundary if the history actually OUTGROWS one batch —
   * and a quiet refactor (fewer cells, smaller gaps, a leaner trigger) could
   * shrink it below the boundary without any cell noticing. This runs LAST
   * (vitest preserves declaration order under --no-file-parallelism) and
   * turns that silent decay into a named red: if it fires, grow the
   * multi-page gap or add cells.
   */
  it(`the shared space outgrew MAX_RESUME_BATCH (${String(MAX_POLL_LIMIT)}), so the from-zero cells crossed the multi-round resume boundary`, async () => {
    const rows = await database.query<{ n: string }>(
      'select count(*) as n from public.workspace_events where space_id = $1',
      [spaceId],
    );
    expect(Number(rows[0]!.n), 'history no longer crosses the resume batch boundary').toBeGreaterThan(MAX_POLL_LIMIT);
  });
});
