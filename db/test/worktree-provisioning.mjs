// =============================================================================
// 078 — the provisioning, reconciliation and tracking-observer doors, driven as
// tm8_app through the real functions against a live scratch chain.
//
// 057's driver proves the SEMANTIC lifecycle. This proves the OPERATIONAL one
// and the queue, which is everything 057 §8 and 006 §5 deferred:
//
//   P1  the entity id passthrough — the reservation and the entity are the
//       same row's two halves (design §4.4), which is what makes the
//       deliberately-missing FK a design choice rather than an accident
//   P2  reserve → state writes → lease → preflight, all through doors, and
//       NOTHING here bumps entities.version (057 §3's structural guarantee)
//   P3  the worktree cap is separate from the session cap and refuses 53400
//   P4  the lease is exclusive; contention is a refusal, never a queue
//   P5  in_worktree written by the saga stamps origin='worktree_manager', so a
//       spawn-created association is distinguishable from a hand-drawn one
//   P6  node_worktree_allocations answers the questions §6.1 asks of SQL
//   P7  claim_tracking_refresh: skip-locked, stale reclaim, targets resolved
//   P8  apply_*_facts stamps fetched_at, and a refresh that learned NOTHING
//       does not bump entities.version — the whole reason 078 narrowed those
//       snapshot triggers
//
//   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_worktree_verify \
//     node db/migrate.mjs reset --force && node db/test/worktree-provisioning.mjs
// =============================================================================
import { json, run, scalar, claimsFor, buildWorld, literal, uuid, cmid, OWNER_URL } from './helpers.mjs';

const tag = `wp${Date.now().toString(36)}`;
const world = buildWorld(tag);
const spaceId = world.spaceA;
const identityA = world.identityA;
const memberA = world.memberA;
const identityB = world.identityB;
const ownerOpts = { url: OWNER_URL };
const appA = { claims: claimsFor(identityA, memberA) };

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}
/**
 * `run` reports rather than throws, so a refusal is read off `sqlstate` — and
 * `verbose` is load-bearing: without `\set VERBOSITY verbose` psql prints the
 * message and not the SQLSTATE, so every refusal check would read `null` and
 * a test asserting on the code would be asserting on nothing.
 */
function refuses(label, sql, opts, code) {
  const res = run(sql, { ...opts, verbose: true });
  check(label, res.ok ? 'no error' : res.sqlstate, code);
}

const OID = 'b'.repeat(40);
const NODE = `node-${tag}`;
// Generated HERE, before any database write — design §4.4. Everything below
// depends on that ordering being real.
const suffix = () => Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0');
const WT1 = `11111111-1111-4111-8111-${suffix()}`;
const WT2 = `22222222-2222-4222-8222-${suffix()}`;
const WT3 = `33333333-3333-4333-8333-${suffix()}`;
const path1 = `/tmp/tm8-wp-${tag}/one`;
const path2 = `/tmp/tm8-wp-${tag}/two`;

// --- P1/P2: reserve BEFORE the entity exists ---------------------------------
json(
  `select public.reserve_worktree_allocation(${uuid(WT1)}, ${uuid(spaceId)}, ${uuid(world.projectId)},
     ${literal(NODE)}, ${literal(path1)}, ${literal(`tm8/${tag}-1`)}, 0)`,
  appA,
);
check('reservation exists before any entity does',
  scalar(`select state from public.worktree_allocations where worktree_entity_id = ${uuid(WT1)}`, ownerOpts),
  'preparing');
check('and no entity backs it yet (the deliberately-missing FK, working as designed)',
  Number(scalar(`select count(*) from public.entities where id = ${uuid(WT1)}`, ownerOpts)),
  0);

refuses('a relative path is refused at the door, not at the CHECK',
  `select public.reserve_worktree_allocation(${uuid(WT2)}, ${uuid(spaceId)}, ${uuid(world.projectId)},
     ${literal(NODE)}, 'relative/path', ${literal(`tm8/${tag}-x`)}, 0)`,
  appA, '22023');

refuses('a duplicate reservation is 23505, never a silent reuse',
  `select public.reserve_worktree_allocation(${uuid(WT1)}, ${uuid(spaceId)}, ${uuid(world.projectId)},
     ${literal(NODE)}, ${literal(path2)}, ${literal(`tm8/${tag}-dup`)}, 0)`,
  appA, '23505');

// --- P1: the entity adopts the reservation's id ------------------------------
const created = json(
  `select public.create_worktree(${uuid(spaceId)}, ${uuid(world.projectId)}, ${literal(path1)},
     ${literal(`tm8/${tag}-1`)}, 'main', ${literal(OID)}, ${uuid(memberA)}, ${literal(cmid(tag))},
     ${uuid(WT1)})`,
  appA,
);
check('create_worktree adopted the node-generated id', created.entity?.id, WT1);
check('so the allocation and the entity are one row in two tables',
  scalar(`select w.entity_id::text from public.worktrees w
           join public.worktree_allocations a on a.worktree_entity_id = w.entity_id
          where w.entity_id = ${uuid(WT1)}`, ownerOpts),
  WT1);
check('version after create is 1', Number(scalar(
  `select version from public.entities where id = ${uuid(WT1)}`, ownerOpts)), 1);

// --- P2: allocation churn bumps NOTHING (057 §3's structural guarantee) ------
for (const state of ['ready', 'cleanup_pending', 'missing', 'failed', 'ready']) {
  json(`select public.set_worktree_allocation_state(${uuid(WT1)}, ${literal(state)}, null, null, false)`, appA);
}
json(`select public.acquire_worktree_lease(${uuid(WT1)}, ${uuid(memberA)})`, appA);
json(`select public.release_worktree_lease(${uuid(WT1)})`, appA);
json(`select public.record_worktree_preflight(${uuid(WT1)}, 'tok-abc')`, appA);
check('all of that churn left entities.version at 1 (W3)', Number(scalar(
  `select version from public.entities where id = ${uuid(WT1)}`, ownerOpts)), 1);
check('and the preflight token is what update_worktree will read', scalar(
  `select preflight_token from public.worktree_allocations where worktree_entity_id = ${uuid(WT1)}`, ownerOpts),
  'tok-abc');

refuses('an unknown allocation state is 22023, not a silent write',
  `select public.set_worktree_allocation_state(${uuid(WT1)}, 'vibes', null, null, false)`, appA, '22023');

check('attempts are counted only when asked (bounded-backoff bookkeeping)', (() => {
  json(`select public.set_worktree_allocation_state(${uuid(WT1)}, 'cleanup_pending', 'x', null, true)`, appA);
  json(`select public.set_worktree_allocation_state(${uuid(WT1)}, 'cleanup_pending', 'x', null, true)`, appA);
  json(`select public.set_worktree_allocation_state(${uuid(WT1)}, 'cleanup_pending', 'x', null, false)`, appA);
  return Number(scalar(`select attempts from public.worktree_allocations where worktree_entity_id = ${uuid(WT1)}`, ownerOpts));
})(), 2);
json(`select public.set_worktree_allocation_state(${uuid(WT1)}, 'ready', null, null, false)`, appA);

// --- P3: the worktree cap is SEPARATE from the session cap -------------------
refuses('the worktree cap refuses with 53400 once reached',
  `select public.reserve_worktree_allocation(${uuid(WT2)}, ${uuid(spaceId)}, ${uuid(world.projectId)},
     ${literal(NODE)}, ${literal(path2)}, ${literal(`tm8/${tag}-2`)}, 1)`,
  appA, '53400');

json(
  `select public.reserve_worktree_allocation(${uuid(WT2)}, ${uuid(spaceId)}, ${uuid(world.projectId)},
     ${literal(NODE)}, ${literal(path2)}, ${literal(`tm8/${tag}-2`)}, 0)`,
  appA,
);
check('cap 0 means unbounded', scalar(
  `select state from public.worktree_allocations where worktree_entity_id = ${uuid(WT2)}`, ownerOpts),
  'preparing');

// --- P4: the lease is exclusive ----------------------------------------------
const S1 = scalar(`select ${uuid(memberA)}::text`, ownerOpts);
json(`select public.acquire_worktree_lease(${uuid(WT1)}, ${uuid(S1)})`, appA);
check('re-acquiring by the SAME session is idempotent, not a refusal', (() => {
  json(`select public.acquire_worktree_lease(${uuid(WT1)}, ${uuid(S1)})`, appA);
  return scalar(`select lease_session_id::text from public.worktree_allocations where worktree_entity_id = ${uuid(WT1)}`, ownerOpts);
})(), S1);
refuses('a DIFFERENT session is refused 53400 — a refusal, never a queue',
  `select public.acquire_worktree_lease(${uuid(WT1)}, ${uuid(world.memberB)})`, appA, '53400');
json(`select public.release_worktree_lease(${uuid(WT1)})`, appA);

// --- P6: the reconciler's read -----------------------------------------------
const allocs = json(
  `select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.node_worktree_allocations(${literal(NODE)}) a`,
  appA,
);
check('node_worktree_allocations returns this node\'s rows', allocs.length, 2);
const withEntity = allocs.find((a) => a.worktree_entity_id === WT1);
const withoutEntity = allocs.find((a) => a.worktree_entity_id === WT2);
check('it answers whether an entity backs the reservation — the question §6.2 turns on',
  [withEntity?.entity_exists, withoutEntity?.entity_exists], [true, false]);
check('and it carries the path, so a pre-entity row can still be reconciled',
  withoutEntity?.path, path2);
check('another node sees none of them', json(
  `select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.node_worktree_allocations('someone-else') a`,
  appA).length, 0);

// --- P5: the in_worktree edge is written under the worktree_manager token ----
//
// Proven by CONTRAST, which is the only way it means anything: the generic
// edge door and the saga door write the same edge type, and only one of them
// records who wrote it. Before this door existed the saga's edge stamped
// 'user' — indistinguishable from a human drawing it by hand, which is exactly
// the distinction 052 minted the token for.
run(`insert into public.entities(id, space_id, kind, created_by)
     values (${uuid(WT3)}, ${uuid(spaceId)}, 'work_session', ${uuid(memberA)})`, ownerOpts);
run(`insert into public.work_sessions(entity_id, space_id, team_member_id, status, workdir_mode, workdir_path)
     values (${uuid(WT3)}, ${uuid(spaceId)}, ${uuid(world.personaA)}, 'spawning', 'worktree', ${literal(path1)})`,
    ownerOpts);

json(`select public.link_session_worktree(${uuid(WT3)}, ${uuid(WT1)})`, appA);
check('a saga-written in_worktree edge stamps origin=worktree_manager',
  scalar(`select props ->> 'origin' from public.edges
           where type = 'in_worktree' and src_id = ${uuid(WT3)} and dst_id = ${uuid(WT1)}`, ownerOpts),
  'worktree_manager');

json(`select public.write_edge(${uuid(world.taskA)}, ${uuid(WT1)}, 'in_worktree', '{}'::jsonb,
        ${uuid(memberA)}, ${literal(cmid(tag))})`, appA);
check('while a hand-drawn one still stamps origin=user — the contrast is the point',
  scalar(`select props ->> 'origin' from public.edges
           where type = 'in_worktree' and src_id = ${uuid(world.taskA)} and dst_id = ${uuid(WT1)}`, ownerOpts),
  'user');

refuses('linking a session that does not exist is P0002, not a dangling edge',
  `select public.link_session_worktree('44444444-4444-4444-8444-444444444444', ${uuid(WT1)})`, appA, 'P0002');

// --- P7/P8: the tracking observer surface ------------------------------------
json(`select public.link_pull_request(${uuid(world.taskA)}, 'https://github.com/o/r/pull/7', 'github',
        'o/r', 7, null, ${uuid(memberA)}, ${literal(cmid(tag))})`, appA);
// Scoped to THIS run's space. A bare `limit 1` picks a stale row from an
// earlier run's space against an accumulated database, and the test then fails
// for a reason that has nothing to do with the code under test.
const prId = scalar(
  `select entity_id::text from public.pull_requests where space_id = ${uuid(spaceId)} limit 1`,
  ownerOpts);
{
  const prVersionBefore = Number(scalar(`select version from public.entities where id = ${uuid(prId)}`, ownerOpts));

  run(`delete from public.tracking_refresh_requests where space_id = ${uuid(spaceId)}`, ownerOpts);
  run(`insert into public.tracking_refresh_requests(space_id, requested_by, entity_ids)
       values (${uuid(spaceId)}, ${uuid(memberA)}, array[${uuid(prId)}])`, ownerOpts);

  const claim1 = json(`select public.claim_tracking_refresh(10, 600)`, appA);
  check('claim returns the queued request with its targets resolved',
    [claim1.claimed.length, claim1.claimed[0]?.targets?.[0]?.entityId], [1, prId]);
  check('and the row is now running', scalar(
    `select status from public.tracking_refresh_requests where space_id = ${uuid(spaceId)}`, ownerOpts),
    'running');

  const claim2 = json(`select public.claim_tracking_refresh(10, 600)`, appA);
  check('a second claim takes nothing — no double delivery', claim2.claimed.length, 0);

  // A refresh that learns NOTHING NEW must not bump the version. This is the
  // whole reason 078 narrowed the 017:54 snapshot triggers: without it a poller
  // doing its job would fire every staleness signal in the system, forever.
  json(`select public.apply_pull_request_facts(${uuid(prId)}, null, null, null)`, appA);
  check('a no-op refresh stamps fetched_at', scalar(
    `select (fetched_at is not null)::text from public.pull_requests where entity_id = ${uuid(prId)}`, ownerOpts),
    'true');
  check('and does NOT bump entities.version', Number(scalar(
    `select version from public.entities where id = ${uuid(prId)}`, ownerOpts)), prVersionBefore);

  // A real state change still versions. Freshness is an observation; state is content.
  json(`select public.apply_pull_request_facts(${uuid(prId)}, 'A real title', 'merged', ${literal('c'.repeat(40))})`, appA);
  check('a state change DOES bump it, exactly once', Number(scalar(
    `select version from public.entities where id = ${uuid(prId)}`, ownerOpts)), prVersionBefore + 1);

  refuses('an out-of-vocabulary state is refused 22023',
    `select public.apply_pull_request_facts(${uuid(prId)}, null, 'vibes', null)`, appA, '22023');

  json(`select public.complete_tracking_refresh((select id from public.tracking_refresh_requests
          where space_id = ${uuid(spaceId)} limit 1), null)`, appA);
  check('complete records the terminal status', scalar(
    `select status from public.tracking_refresh_requests where space_id = ${uuid(spaceId)}`, ownerOpts),
    'completed');

  // A node that dies mid-fetch strands its row in 'running'. The stale window
  // is what makes that recoverable rather than permanent.
  run(`insert into public.tracking_refresh_requests(space_id, requested_by, entity_ids, status, started_at)
       values (${uuid(spaceId)}, ${uuid(memberA)}, array[${uuid(prId)}], 'running', now() - interval '1 hour')`,
      ownerOpts);
  const claim3 = json(`select public.claim_tracking_refresh(10, 600)`, appA);
  check('a stale running row is returned to the queue and reclaimed', claim3.claimed.length, 1);
}

// --- P9: the review's findings, pinned -----------------------------------------

// The lease doors are no longer `require_identity()`-only. Clearing a lease is
// exactly what frees 057's partial unique index to admit a SECOND session into
// one working tree, so "the uuid is unguessable" was the only thing standing
// between a cross-space caller and two agents writing the same checkout.
refuses('a non-member cannot release another space\'s lease (§3.4 single-writer)',
  `select public.release_worktree_lease(${uuid(WT1)})`,
  { claims: claimsFor(identityB, null) }, '42501');
refuses('nor acquire it',
  `select public.acquire_worktree_lease(${uuid(WT1)}, ${uuid(memberA)})`,
  { claims: claimsFor(identityB, null) }, '42501');
refuses('nor mint its preflight token (§5.4)',
  `select public.record_worktree_preflight(${uuid(WT1)}, 'forged')`,
  { claims: claimsFor(identityB, null) }, '42501');
refuses('releasing a lease that names nothing is reported, not silently true',
  `select public.release_worktree_lease('66666666-6666-4666-8666-666666666666')`,
  appA, 'P0002');

// A vanished directory holds no disk, so `missing` must not consume a cap slot
// — reconciliation treats it as terminal and nothing deletes allocation rows,
// so counting it would eventually refuse every spawn on a capped node.
json(`select public.set_worktree_allocation_state(${uuid(WT2)}, 'missing', null, null, false)`, appA);
// Fresh id and fresh path per run — a fixed uuid here would 23505 on the second
// run against the same database and report a cap failure that is really a
// fixture collision. That is precisely the isolation defect this driver was
// caught having elsewhere.
const WT4 = `44444444-4444-4444-8444-${suffix()}`;
check('a missing allocation does not hold a cap slot', (() => {
  const res = run(
    `select public.reserve_worktree_allocation(${uuid(WT4)},
       ${uuid(spaceId)}, ${uuid(world.projectId)}, ${literal(NODE)},
       ${literal(`/tmp/tm8-wp-${tag}/cap-${WT4.slice(-6)}`)},
       ${literal(`tm8/${tag}-cap-${WT4.slice(-6)}`)}, 2)`,
    { ...appA, verbose: true });
  return res.ok || res.sqlstate;
})(), true);

// THE TRIGGER-DRIFT GUARD. 078 narrows two shipped snapshot triggers to a
// hand-maintained column list. Nothing but this assertion stops the next person
// who adds a column to `pull_requests` from silently losing versioning for it
// forever — no migration error, no other failing test.
const OBSERVATION_COLUMNS = ['entity_id', 'space_id', 'created_at', 'updated_at', 'fetched_at'];
for (const table of ['pull_requests', 'commits']) {
  const cols = json(
    `select coalesce(jsonb_agg(column_name order by column_name), '[]'::jsonb)
       from information_schema.columns
      where table_schema = 'public' and table_name = ${literal(table)}
        and column_name <> all(array[${OBSERVATION_COLUMNS.map(literal).join(',')}])`,
    ownerOpts);
  const def = scalar(
    `select pg_get_triggerdef(t.oid) from pg_trigger t
      where t.tgrelid = ${literal(`public.${table}`)}::regclass
        and t.tgname = ${literal(`${table}_w2_snapshot_version`)}`,
    ownerOpts);
  const missing = cols.filter((c) => !String(def).includes(`new.${c} `) && !String(def).includes(`new.${c}\n`));
  check(`${table}: every content column is in the snapshot trigger's WHEN list`,
    missing, []);
}

// --- authorization ------------------------------------------------------------
refuses('a non-member cannot reserve against this space',
  `select public.reserve_worktree_allocation('55555555-5555-4555-8555-555555555555', ${uuid(spaceId)},
     ${uuid(world.projectId)}, ${literal(NODE)}, '/tmp/nope', 'tm8/nope', 0)`,
  { claims: claimsFor(identityB, null) }, '42501');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
