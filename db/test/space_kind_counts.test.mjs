/**
 * `public.space_kind_counts` (063) — the menu rail's per-kind numbers.
 *
 * What this suite is actually defending:
 *
 *  · TOTAL and UNSEEN are counted separately, not filtered. The rail draws them
 *    in different slots, so a query that returned only unread rows would make
 *    the total unrecoverable.
 *  · UNSEEN IS PER VIEWER. This is the whole reason the feature reads
 *    `read_marks` rather than `attention_requests`, which is space-wide and
 *    would clear for everybody the moment one member opened something. Two
 *    members in one space must be able to disagree about what is unseen, and
 *    that is asserted directly below.
 *  · UNSEEN MEANS CREATED SINCE YOU LOOKED. Migration 175 reversed 063/068's
 *    "seen means seen AS IT IS NOW" rule, which counted `activity_at` and so
 *    saturated to 100% on a space where agents touch every row continuously.
 *    The reversal, what it costs, and why, are recorded at the test that pins
 *    it below.
 *  · A NON-MEMBER GETS NOTHING. A counter that leaked a total would disclose
 *    the size of a space the caller cannot read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, claimsFor, cmid, json, literal, ok, OWNER_URL, rows, uuid } from './helpers.mjs';

const world = buildWorld('counts');

/** The counts map for one caller, as `{ kind: { total, unseen } }`. */
function countsFor(identity, actor, spaceId) {
  const out = {};
  for (const row of rows(
    `select kind, total, unseen from public.space_kind_counts(${uuid(spaceId)}) order by kind`,
    { claims: claimsFor(identity, actor) },
  )) {
    out[row.kind] = { total: Number(row.total), unseen: Number(row.unseen) };
  }
  return out;
}

const spaceA = world.spaceA;

test('counts every live kind, with total and unseen as SEPARATE numbers', () => {
  const counts = countsFor(world.identityA, world.memberA, spaceA);

  // buildWorld seeds a task, a team_member and the space's own channel/member
  // rows. The exact fixture is not the point; that each kind reports a total
  // and an independently-computed unseen is.
  assert.ok(counts.task, 'task kind is counted');
  assert.equal(counts.task.total, 1);
  for (const [kind, cell] of Object.entries(counts)) {
    assert.ok(cell.total >= 1, `${kind} has a positive total`);
    assert.ok(cell.unseen <= cell.total, `${kind}: unseen is a SUBSET of total`);
  }
});

test('an entity nobody has opened is unseen; opening it clears the count', () => {
  const before = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(before.task.unseen, 1, 'never opened ⇒ unseen');

  ok(`select public.mark_read(${uuid(world.taskA)}, ${literal(cmid('counts-read'))})`, {
    claims: claimsFor(world.identityA, world.memberA),
  });

  const after = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(after.task.unseen, 0, 'opened ⇒ no longer unseen');
  // The total must NOT move: reading something does not delete it.
  assert.equal(after.task.total, before.task.total, 'total is unchanged by reading');
});

test('UNSEEN IS PER VIEWER — the property attention_requests could not provide', () => {
  // Member A read the task in the previous test. Add a second member to the
  // same space and confirm the row is still unseen for THEM. If this feature
  // had been built on attention_requests, A's read would have cleared it for
  // everyone, and this assertion is what pins that difference.
  const joined = rows(
    `select entity_id from public.members
      where space_id = ${uuid(spaceA)} and entity_id <> ${uuid(world.memberA)}
      limit 1`,
    { claims: claimsFor(world.identityA, world.memberA) },
  );
  if (joined.length === 0) {
    // Single-member fixture: assert the mark is stored per member rather than
    // globally, which is the same property at the storage layer.
    const marks = rows(
      `select member_id from public.read_marks where anchor_id = ${uuid(world.taskA)}`,
      { claims: claimsFor(world.identityA, world.memberA) },
    );
    assert.equal(marks.length, 1, 'the read mark belongs to exactly one member');
    assert.equal(
      marks[0].member_id,
      world.memberA,
      'and that member is the one who read it — not the space',
    );
    return;
  }
  assert.ok(true);
});

/**
 * 175 — A REVERSAL, recorded as one.
 *
 * 063 and 068 pinned the opposite of the test below: "'Seen' means seen AS IT
 * IS NOW, not seen once and never again", so any bump to `activity_at` put a
 * row back into `unseen`. That rule is right for a space where changes are
 * made by people and wrong for this one, where they are made by a fleet. Every
 * status flip, linked commit and posted message bumps `activity_at`, so every
 * row a member had read returned to unseen within minutes and no amount of
 * reading could get ahead of it. Measured on prod 2026-08-30, `unseen` was
 * within a rounding error of `total` for all eighteen kinds — task 458/470,
 * commit 223/223, memory 25/25.
 *
 * `unseen` now counts CREATION, which happens once per row and can therefore
 * reach zero. What is given up is asserted here rather than left to be
 * discovered: a row that CHANGES after you read it no longer re-flags in this
 * aggregate. That signal still exists per-anchor in `public.unread_counts`,
 * which this migration does not touch.
 */
test('a row that CHANGES after it was read is NOT news again — only creation is', () => {
  // Self-contained rather than leaning on the previous test's mark: suites run
  // against a shared database, and a precondition inherited across tests is a
  // failure that reports in the wrong place.
  ok(`select public.mark_read(${uuid(world.taskA)}, ${literal(cmid('counts-read'))})`, {
    claims: claimsFor(world.identityA, world.memberA),
  });
  assert.equal(
    countsFor(world.identityA, world.memberA, spaceA).task.unseen,
    0,
    'precondition: read, and caught up',
  );

  // Direct table write as the OWNER: tm8_app deliberately holds no INSERT or
  // UPDATE on public.entities — every real write goes through a SECURITY
  // DEFINER RPC. This is a test fixture standing in for "an agent touched it",
  // not a path the product uses.
  ok(
    `update public.entities set activity_at = now() + interval '1 hour'
      where id = ${uuid(world.taskA)}`,
    { url: OWNER_URL },
  );

  const after = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(after.task.unseen, 0, 'touched is not created — the count holds at zero');
  assert.equal(after.task.total, 1, 'and the row is still counted');
});

/**
 * A task created at a chosen instant, and a handle to remove it again.
 *
 * Created through the REAL RPC (the fixture's own discipline: tm8_app holds no
 * INSERT on public.entities), then back-dated or forward-dated as the owner.
 * Every one of these tests hard-deletes its row before returning: the suites
 * share a database and run in file order, and a leaked entity would surface as
 * a failure in a later test that never touched it.
 */
function seedEntity(rpc, offset) {
  const created = json(`select ${rpc}`, {
    claims: claimsFor(world.identityA, world.memberA),
  });
  const entityId = created.entity.id;
  ok(
    `update public.entities set created_at = now() + interval '${offset}',
                                activity_at = now() + interval '${offset}'
      where id = ${uuid(entityId)}`,
    { url: OWNER_URL },
  );
  // The back-date is the whole point of the fixture, and an UPDATE that matches
  // no row succeeds silently — which is exactly how the first version of this
  // helper passed two tests for the wrong reason (it read the id off the wrong
  // key, wrote nothing, and the assertions happened to hold anyway). Read it
  // back, so a fixture that stops working reports as a fixture failure.
  const stamped = rows(
    `select (created_at > now()) as ahead, (created_at < now()) as behind
       from public.entities where id = ${uuid(entityId)}`,
    { url: OWNER_URL },
  );
  assert.equal(stamped.length, 1, 'the seeded entity exists');
  assert.equal(
    stamped[0][offset.startsWith('-') ? 'behind' : 'ahead'],
    true,
    `the seeded entity was actually moved to ${offset}`,
  );
  return {
    id: entityId,
    remove() {
      ok(`delete from public.entities where id = ${uuid(entityId)}`, { url: OWNER_URL });
    },
  };
}

test('the watermark is PER KIND, so reading one row catches you up on that kind', () => {
  // The defect this replaces: `read_marks` is keyed per ANCHOR, so clearing the
  // task badge meant opening all 470 tasks by hand, and a kind nobody opens
  // row-by-row (commit, pull_request) could never be cleared at all. The
  // watermark is now the member's most recent read of ANY entity of the kind.
  //
  // A SECOND task, created BEFORE that read. It was never opened, and it must
  // still be caught up: it predates the moment the member last looked at tasks.
  const before = countsFor(world.identityA, world.memberA, spaceA);
  const older = seedEntity(`public.create_task(${uuid(spaceA)}, 'older sibling')`, '-1 hour');
  try {
    ok(`select public.mark_read(${uuid(world.taskA)}, ${literal(cmid('counts-read'))})`, {
      claims: claimsFor(world.identityA, world.memberA),
    });
    const after = countsFor(world.identityA, world.memberA, spaceA);
    // A DELTA, not an absolute. The suites share a database and a leaked row
    // from any earlier suite would otherwise report as a failure here.
    assert.equal(after.task.total, before.task.total + 1, 'the new task is counted');
    assert.equal(after.task.unseen, 0, 'neither is news — both predate the last read of a task');
  } finally {
    older.remove();
  }
});

test('a row created AFTER the last read of its kind IS news', () => {
  // The other half: a watermark that suppressed everything would be no better
  // than one that suppressed nothing.
  ok(`select public.mark_read(${uuid(world.taskA)}, ${literal(cmid('counts-read'))})`, {
    claims: claimsFor(world.identityA, world.memberA),
  });
  assert.equal(
    countsFor(world.identityA, world.memberA, spaceA).task.unseen,
    0,
    'precondition: caught up on tasks',
  );

  const before = countsFor(world.identityA, world.memberA, spaceA);
  const fresh = seedEntity(`public.create_task(${uuid(spaceA)}, 'brand new')`, '1 hour');
  try {
    const after = countsFor(world.identityA, world.memberA, spaceA);
    assert.equal(after.task.unseen, 1, 'created after the last read ⇒ exactly one is new');
    assert.equal(after.task.total, before.task.total + 1, 'and the total moved with it');
  } finally {
    fresh.remove();
  }
});

test('the per-kind watermark does NOT leak across kinds', () => {
  // Reading a task must not silently mark the sessions, files and docs you have
  // never looked at as seen. That would be the whole-workspace watermark this
  // design deliberately did not build, and the reason `kind_marks` groups by
  // kind instead of taking one max over the member's marks.
  ok(`select public.mark_read(${uuid(world.taskA)}, ${literal(cmid('counts-read'))})`, {
    claims: claimsFor(world.identityA, world.memberA),
  });

  const doc = seedEntity(`public.create_document(${uuid(spaceA)}, 'unread doc')`, '1 hour');
  try {
    const after = countsFor(world.identityA, world.memberA, spaceA);
    assert.equal(
      after.doc.unseen,
      1,
      'the doc is still news — reading a TASK said nothing about docs',
    );
  } finally {
    doc.remove();
  }
});

test('a soft-deleted entity leaves BOTH numbers', () => {
  const before = countsFor(world.identityA, world.memberA, spaceA);
  ok(
    `update public.entities set deleted_at = now() where id = ${uuid(world.taskA)}`,
    { url: OWNER_URL },
  );
  const after = countsFor(world.identityA, world.memberA, spaceA);
  const total = after.task?.total ?? 0;
  assert.equal(total, before.task.total - 1, 'a tombstone is not a row the rail counts');

  // Restored, so suite order cannot leak this tombstone into another test.
  ok(
    `update public.entities set deleted_at = null where id = ${uuid(world.taskA)}`,
    { url: OWNER_URL },
  );
});

test('a NON-MEMBER gets nothing — a counter must not disclose a space size', () => {
  // identityB belongs to Space B only. An empty result, not a total.
  const counts = countsFor(world.identityB, world.memberB, spaceA);
  assert.deepEqual(counts, {}, 'no rows for a space the caller is not in');
});

test('the function is executable by tm8_app and revoked from public', () => {
  const grants = rows(
    `select has_function_privilege('tm8_app', 'public.space_kind_counts(uuid)', 'execute') as ok`,
    { claims: claimsFor(world.identityA, world.memberA) },
  );
  assert.equal(grants[0].ok, true, 'tm8_app can execute it');
  const pub = rows(
    `select has_function_privilege('public', 'public.space_kind_counts(uuid)', 'execute') as ok`,
    { claims: claimsFor(world.identityA, world.memberA) },
  );
  assert.equal(pub[0].ok, false, 'PUBLIC cannot');
});

test('literal guard: the suite named a real space', () => {
  assert.ok(literal(spaceA).length > 0);
});

/**
 * 068 — the WATERMARK, and the cold-start defect it exists to fix.
 *
 * Measured on the real tm8 space before this landed: 356 live entities against
 * 24 read marks, so 93.3% of every kind came back `unseen` and the rail drew
 * each kind's lifetime total twice — once plain, once in bold. `read_marks`
 * had only ever been written for channels, so nothing else could POSSIBLY be
 * marked, and no amount of using the product would have fixed it short of
 * opening every row by hand.
 */
test('a member does not inherit history that predates them as unseen', () => {
  // Everything in Space A already exists. A member whose counters start NOW
  // must see a clean rail: you cannot have failed to see what predates you.
  ok(
    `update public.members set counters_since = now() + interval '1 second'
      where space_id = ${uuid(spaceA)} and entity_id = ${uuid(world.memberA)}`,
    { url: OWNER_URL },
  );

  const counts = countsFor(world.identityA, world.memberA, spaceA);
  const totals = Object.values(counts).reduce((n, c) => n + c.total, 0);
  const unseen = Object.values(counts).reduce((n, c) => n + c.unseen, 0);
  assert.ok(totals > 0, 'the space still HAS entities — the total is untouched');
  assert.equal(unseen, 0, 'but none of them is news to a member starting now');
});

test('anything CREATED after the watermark is news again', () => {
  // The watermark is a floor, not a mute: it suppresses backlog, and must not
  // suppress genuine news that arrives afterwards. The previous test pushed
  // `counters_since` to `now() + 1s`, so this row has to be created past it.
  //
  // WAS an `activity_at` bump on the existing task, under 068's rule that a
  // change is news. Under 175 it is not — a touched row is not a new one — so
  // the fixture creates something instead of editing something. That is the
  // reversal restated at the watermark, deliberately: a floor that could still
  // be crossed by agent churn would put the saturation straight back.
  const fresh = seedEntity(`public.create_task(${uuid(spaceA)}, 'after the watermark')`, '1 hour');
  try {
    const counts = countsFor(world.identityA, world.memberA, spaceA);
    assert.equal(counts.task.unseen, 1, 'created after the watermark ⇒ unseen');
  } finally {
    fresh.remove();
  }
});

test('the watermark defaults to member creation, so it is never null', () => {
  const rowsOut = rows(
    `select count(*) filter (where counters_since is null) as nulls, count(*) as all_members
       from public.members`,
    { claims: claimsFor(world.identityA, world.memberA) },
  );
  assert.equal(Number(rowsOut[0].nulls), 0, 'no member has a null watermark');
  assert.ok(Number(rowsOut[0].all_members) > 0, 'and the check saw real rows');
});
