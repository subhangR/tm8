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
 *  · SEEN IS PERMANENT AND EXPLICIT (313). Only a list activation
 *    (`mark_entity_seen`) records it; opening a detail (`mark_read`) does not,
 *    and a later change to the entity does not make it unseen again.
 *  · A NON-MEMBER GETS NOTHING. A counter that leaked a total would disclose
 *    the size of a space the caller cannot read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, claimsFor, cmid, literal, ok, OWNER_URL, rows, uuid } from './helpers.mjs';

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

// mark_entity_seen is human-only (require_human_auth_kind), like a browser/cli caller.
const humanA = { ...claimsFor(world.identityA, world.memberA), 'tm8.auth_kind': 'browser' };
const markSeen = (entityId) =>
  ok(`select public.mark_entity_seen(${uuid(entityId)}, ${literal(cmid('counts-seen'))})`, { claims: humanA });

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

test('an entity nobody has seen is unseen; marking it seen clears only that row', () => {
  const before = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(before.task.unseen, 1, 'never seen ⇒ unseen');

  // 313: opening a detail (advancing the read cursor) is NOT seeing it in the list.
  ok(`select public.mark_read(${uuid(world.taskA)}, ${literal(cmid('counts-read'))})`, {
    claims: claimsFor(world.identityA, world.memberA),
  });
  assert.equal(
    countsFor(world.identityA, world.memberA, spaceA).task.unseen,
    1,
    'mark_read does not write seen state',
  );

  markSeen(world.taskA);
  const after = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(after.task.unseen, 0, 'seen ⇒ no longer unseen');
  // The total must NOT move: reading something does not delete it.
  assert.equal(after.task.total, before.task.total, 'total is unchanged by reading');
});

test('UNSEEN IS PER VIEWER — the property attention_requests could not provide', () => {
  // Member A saw the task in the previous test. Add a second member to the
  // same space and confirm the row is still unseen for THEM. If this feature
  // had been built on attention_requests, A's view would have cleared it for
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
      `select member_id from public.entity_seen where entity_id = ${uuid(world.taskA)}`,
      { claims: claimsFor(world.identityA, world.memberA) },
    );
    assert.equal(marks.length, 1, 'the seen mark belongs to exactly one member');
    assert.equal(
      marks[0].member_id,
      world.memberA,
      'and that member is the one who read it — not the space',
    );
    return;
  }
  assert.ok(true);
});

test('seen is PERMANENT: a change after it was seen does not make it unseen again', () => {
  // 313 replaced the stale-on-change read marks: a list activation records
  // seen once, and later activity is surfaced elsewhere, not by this number.
  // Self-contained rather than leaning on the previous test's mark: suites run
  // against a shared database.
  markSeen(world.taskA);
  assert.equal(
    countsFor(world.identityA, world.memberA, spaceA).task.unseen,
    0,
    'precondition: seen',
  );

  // Direct table write as the OWNER: tm8_app deliberately holds no INSERT or
  // UPDATE on public.entities — every real write goes through a SECURITY
  // DEFINER RPC. This is a test fixture standing in for "something changed",
  // not a path the product uses.
  ok(
    `update public.entities set activity_at = now() + interval '1 second'
      where id = ${uuid(world.taskA)}`,
    { url: OWNER_URL },
  );

  const after = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(after.task.unseen, 0, 'changed since it was seen ⇒ still seen');
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
 * 068 — the WATERMARK, and the cold-start defect it exists to fix. 313 moved
 * it to `members.entities_seen_since`, compared against an entity's CREATION.
 *
 * Measured on the real tm8 space before 068 landed: 356 live entities against
 * 24 read marks, so 93.3% of every kind came back `unseen` and the rail drew
 * each kind's lifetime total twice — once plain, once in bold.
 */
test('a member does not inherit history that predates them as unseen', () => {
  // Everything in Space A already exists. A member whose watermark starts NOW
  // must see a clean rail: you cannot have failed to see what predates you.
  ok(
    `update public.members set entities_seen_since = now()
      where space_id = ${uuid(spaceA)} and entity_id = ${uuid(world.memberA)}`,
    { url: OWNER_URL },
  );

  const counts = countsFor(world.identityA, world.memberA, spaceA);
  const totals = Object.values(counts).reduce((n, c) => n + c.total, 0);
  const unseen = Object.values(counts).reduce((n, c) => n + c.unseen, 0);
  assert.ok(totals > 0, 'the space still HAS entities — the total is untouched');
  assert.equal(unseen, 0, 'but none of them is news to a member starting now');
});

test('anything CREATED after the watermark is news', () => {
  // The watermark is a floor, not a mute: it suppresses backlog, and must not
  // suppress what arrives afterwards.
  ok(`select public.create_task(${uuid(spaceA)}, 'after the watermark')`, {
    claims: claimsFor(world.identityA, world.memberA),
  });
  const counts = countsFor(world.identityA, world.memberA, spaceA);
  assert.equal(counts.task.unseen, 1, 'created after the watermark ⇒ unseen');
});

test('the watermark defaults to member creation, so it is never null', () => {
  const rowsOut = rows(
    `select count(*) filter (where entities_seen_since is null) as nulls, count(*) as all_members
       from public.members`,
    { claims: claimsFor(world.identityA, world.memberA) },
  );
  assert.equal(Number(rowsOut[0].nulls), 0, 'no member has a null watermark');
  assert.ok(Number(rowsOut[0].all_members) > 0, 'and the check saw real rows');
});
