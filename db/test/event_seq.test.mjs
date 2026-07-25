// =============================================================================
// workspace_events.seq — the assumption Sirius's entire event stream rests on.
//
// The contract (003 §5): seq is PER-SPACE MONOTONIC, and it is the poll cursor.
// A poller that has seen seq N asks for `seq > N` and must never be able to miss
// an event. Three distinct properties have to hold for that to be true, and only
// the first is obvious:
//
//   1. no duplicates            — a cursor cannot distinguish two rows at seq N
//   2. no GAPS                  — because internal.next_event_seq increments a
//                                 TABLE row rather than drawing from a sequence,
//                                 a rolled-back transaction returns its number.
//                                 A real sequence would leave a permanent hole.
//   3. no OUT-OF-ORDER COMMITS  — the killer. If a writer could take seq 5 and
//                                 commit while seq 4 was still uncommitted, a
//                                 poller could read 5, advance its cursor past 4,
//                                 and lose event 4 forever. next_event_seq holds
//                                 the space_event_seq row lock until commit, so
//                                 seq order IS commit order. That is what makes
//                                 the cursor safe, and it is asserted here
//                                 directly rather than assumed.
//
// Property 3 needs two genuinely concurrent connections, which is why this suite
// uses the async runner instead of the synchronous one.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorld,
  claimsFor,
  literal,
  ok,
  rootClaims,
  rows,
  runAsync,
  runRawAsync,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('seq');

/** Every seq in a space, in order, read as a member of it. */
function seqsOf(spaceId, claims) {
  return rows(
    `select seq, event_type from public.workspace_events where space_id = ${uuid(spaceId)} order by seq`,
    { claims },
  ).map((r) => ({ seq: Number(r.seq), type: r.event_type }));
}

/**
 * The whole cursor contract in one assertion, with a diagnostic that says WHICH
 * number is wrong rather than just that a count did not match.
 */
function assertContiguousFromOne(seqs, label) {
  const values = seqs.map((s) => s.seq);
  const duplicates = values.filter((v, i) => values.indexOf(v) !== i);
  assert.deepEqual(duplicates, [], `${label}\n  DUPLICATE seq values: ${duplicates.join(', ')}`);
  assert.equal(values[0], 1, `${label}\n  first seq should be 1, got ${values[0]}`);
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== i + 1) {
      throw new Error(
        `${label}\n  GAP in the seq run: expected ${i + 1} at index ${i}, found ${values[i]}\n` +
          `  full run: ${values.join(',')}`,
      );
    }
  }
}

test('seq is monotonic, gapless and starts at 1 for sequential writers', () => {
  const before = seqsOf(w.spaceA, w.claimsA);
  assertContiguousFromOne(before, 'space A after world building');

  for (let i = 0; i < 5; i += 1) {
    ok(`select public.post_message(${uuid(w.channelA)}, 'sequential ${i}')`, { claims: w.claimsA });
  }
  const after = seqsOf(w.spaceA, w.claimsA);
  assertContiguousFromOne(after, 'space A after 5 sequential posts');
  assert.ok(after.length > before.length, 'the posts should have produced events');
});

test('seq is PER SPACE: two spaces keep independent counters, both starting at 1', () => {
  const a = seqsOf(w.spaceA, w.claimsA);
  const b = seqsOf(w.spaceB, w.claimsB);
  assertContiguousFromOne(a, 'space A');
  assertContiguousFromOne(b, 'space B');
  // Both runs start at 1, so the numbers overlap — which is exactly why a poll
  // cursor is only meaningful together with its space id.
  assert.equal(a[0].seq, 1);
  assert.equal(b[0].seq, 1);
});

test('a rolled-back writer leaves NO gap: the number is returned, not burned', async () => {
  const maxBefore = Number(
    scalar(`select max(seq) from public.workspace_events where space_id = ${uuid(w.spaceA)}`, {
      claims: w.claimsA,
    }),
  );

  // A transaction that takes seq numbers and then aborts.
  const rolledBack = await runRawAsync(
    `begin;\n` +
      `select set_config('tm8.identity_id', ${literal(w.identityA)}, true);\n` +
      `select set_config('tm8.actor_id', ${literal(w.memberA)}, true);\n` +
      `select public.post_message(${uuid(w.channelA)}, 'never committed');\n` +
      `rollback;\n`,
  );
  assert.ok(rolledBack.ok, `the rolled-back script itself should not error:\n${rolledBack.stderr}`);

  const maxAfterRollback = Number(
    scalar(`select max(seq) from public.workspace_events where space_id = ${uuid(w.spaceA)}`, {
      claims: w.claimsA,
    }),
  );
  assert.equal(
    maxAfterRollback,
    maxBefore,
    'a rolled-back transaction must leave max(seq) untouched — its events are gone',
  );

  // ...and the next committed writer reuses the numbers the aborted one took.
  ok(`select public.post_message(${uuid(w.channelA)}, 'after the rollback')`, { claims: w.claimsA });
  assertContiguousFromOne(
    seqsOf(w.spaceA, w.claimsA),
    'space A after a rolled-back writer and a committed one',
  );
});

test('CONCURRENT writers in one space: no duplicates, no gaps, 8 connections interleaved', async () => {
  const WRITERS = 8;
  const POSTS_PER_WRITER = 4;

  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_, writer) => {
      const statements = Array.from(
        { length: POSTS_PER_WRITER },
        (_, i) => `select public.post_message(${uuid(w.channelA)}, 'w${writer}-p${i}');`,
      ).join('\n');
      return runAsync(statements, { claims: w.claimsA });
    }),
  );
  results.forEach((r, i) => assert.ok(r.ok, `writer ${i} failed:\n${r.stderr}`));

  const seqs = seqsOf(w.spaceA, w.claimsA);
  assertContiguousFromOne(
    seqs,
    `space A after ${WRITERS} concurrent writers x ${POSTS_PER_WRITER} posts each`,
  );

  // Every message actually landed — a gapless seq run would also be satisfied by
  // silently losing writers, so count the payloads too.
  const landed = Number(
    scalar(
      `select count(*) from public.messages m
         join public.entities e on e.id = m.entity_id
        where e.space_id = ${uuid(w.spaceA)} and m.body like 'w%-p%'`,
      { claims: w.claimsA },
    ),
  );
  assert.equal(landed, WRITERS * POSTS_PER_WRITER, 'every concurrent post must have landed');
});

test('seq order IS commit order: an open writer BLOCKS a concurrent writer in the same space', async () => {
  const HOLD_MS = 900;

  // T1 takes a seq and sits on the space_event_seq row lock until it commits.
  const t1 = runRawAsync(
    `begin;\n` +
      `select set_config('tm8.identity_id', ${literal(w.identityA)}, true);\n` +
      `select set_config('tm8.actor_id', ${literal(w.memberA)}, true);\n` +
      `select public.post_message(${uuid(w.channelA)}, 'T1 holds the lock');\n` +
      `select pg_sleep(${HOLD_MS / 1000});\n` +
      `commit;\n`,
  );

  // T2 starts while T1 is mid-transaction and must WAIT for it.
  await new Promise((r) => setTimeout(r, 250));
  const t2Started = Date.now();
  const t2 = await runAsync(`select public.post_message(${uuid(w.channelA)}, 'T2 waits')`, {
    claims: w.claimsA,
  });
  const t2Elapsed = Date.now() - t2Started;
  const t1Result = await t1;

  assert.ok(t1Result.ok, `T1 failed:\n${t1Result.stderr}`);
  assert.ok(t2.ok, `T2 failed:\n${t2.stderr}`);
  assert.ok(
    t2Elapsed > 400,
    `T2 should have BLOCKED on the space_event_seq row lock for the rest of T1's transaction, ` +
      `but it finished in ${t2Elapsed}ms. If T2 no longer waits, seq order is no longer commit ` +
      `order and a poller can advance past an uncommitted lower seq — Sirius's cursor becomes lossy.`,
  );

  const seqT1 = Number(
    scalar(
      `select we.seq from public.workspace_events we
        where we.space_id = ${uuid(w.spaceA)} and we.event_type = 'message.created'
          and we.payload ->> 'body' = 'T1 holds the lock'`,
      { claims: w.claimsA },
    ),
  );
  const seqT2 = Number(
    scalar(
      `select we.seq from public.workspace_events we
        where we.space_id = ${uuid(w.spaceA)} and we.event_type = 'message.created'
          and we.payload ->> 'body' = 'T2 waits'`,
      { claims: w.claimsA },
    ),
  );
  assert.ok(
    seqT1 < seqT2,
    `the writer that committed FIRST must hold the lower seq (T1=${seqT1}, T2=${seqT2})`,
  );
  assertContiguousFromOne(seqsOf(w.spaceA, w.claimsA), 'space A after the blocking pair');
});

test('the per-space lock does NOT serialise across spaces', async () => {
  // The flip side of the property above: if the seq lock were global, one busy
  // space would stall every other space's writers. C joins space B so there is a
  // second space with a real writer.
  const HOLD_MS = 800;
  const holdA = runRawAsync(
    `begin;\n` +
      `select set_config('tm8.identity_id', ${literal(w.identityA)}, true);\n` +
      `select set_config('tm8.actor_id', ${literal(w.memberA)}, true);\n` +
      `select public.post_message(${uuid(w.channelA)}, 'A holds its own space');\n` +
      `select pg_sleep(${HOLD_MS / 1000});\n` +
      `commit;\n`,
  );

  await new Promise((r) => setTimeout(r, 250));
  const startedB = Date.now();
  const inB = await runAsync(`select public.post_message(${uuid(w.channelB)}, 'B is unaffected')`, {
    claims: w.claimsB,
  });
  const elapsedB = Date.now() - startedB;
  const holdResult = await holdA;

  assert.ok(inB.ok, `the space B writer failed:\n${inB.stderr}`);
  assert.ok(holdResult.ok, `the space A holder failed:\n${holdResult.stderr}`);
  assert.ok(
    elapsedB < 400,
    `a writer in space B waited ${elapsedB}ms behind an open transaction in space A. ` +
      `The seq lock must be per-space, or one noisy space throttles the whole node.`,
  );
});

test('a poller at a cursor never misses an event while writers are running', async () => {
  // The property stated the way Sirius consumes it: repeatedly ask for `seq > cursor`
  // while writers commit concurrently, and the union of what came back must be a
  // contiguous run with nothing skipped.
  const cursorStart = Number(
    scalar(`select coalesce(max(seq), 0) from public.workspace_events where space_id = ${uuid(w.spaceA)}`, {
      claims: w.claimsA,
    }),
  );

  const writers = Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      runAsync(
        Array.from({ length: 3 }, (_, j) => `select public.post_message(${uuid(w.channelA)}, 'poll-${i}-${j}');`).join('\n'),
        { claims: w.claimsA },
      ),
    ),
  );

  let cursor = cursorStart;
  const seen = [];
  for (let poll = 0; poll < 12; poll += 1) {
    const batch = rows(
      `select seq from public.workspace_events
        where space_id = ${uuid(w.spaceA)} and seq > ${cursor} order by seq limit 50`,
      { claims: w.claimsA },
    ).map((r) => Number(r.seq));
    for (const s of batch) {
      seen.push(s);
      cursor = s; // advance exactly the way the poller does
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  await writers;

  // Drain whatever landed after the last poll.
  for (const r of rows(
    `select seq from public.workspace_events
      where space_id = ${uuid(w.spaceA)} and seq > ${cursor} order by seq`,
    { claims: w.claimsA },
  )) {
    seen.push(Number(r.seq));
  }

  const finalMax = Number(
    scalar(`select max(seq) from public.workspace_events where space_id = ${uuid(w.spaceA)}`, {
      claims: w.claimsA,
    }),
  );
  const expected = Array.from({ length: finalMax - cursorStart }, (_, i) => cursorStart + 1 + i);
  assert.deepEqual(
    seen,
    expected,
    `a cursor-advancing poller must observe every seq exactly once and in order.\n` +
      `  MISSED: ${expected.filter((s) => !seen.includes(s)).join(',') || '(none)'}\n` +
      `  cursor started at ${cursorStart}, final max(seq) = ${finalMax}`,
  );
});
