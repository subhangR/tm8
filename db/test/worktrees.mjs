// =============================================================================
// 057 worktrees — DB-level proof, run as tm8_app through the real doors.
//
// Gates from TM8-WORKTREE-DESIGN §9 Phase 1, driven against a live scratch
// chain (NEVER tm8_dev):
//
//   G1.1  one semantic transition = exactly one entities.version bump
//   G1.2  allocation churn (all five states + lease) bumps NOTHING (W3)
//   G1.3  direct status UPDATE outside the door → 23514 (R29)
//   G1.4  entity_content returns populated content, not '{}'
//   G1.6  expectedVersion mismatch → refused; illegal transition → 23514;
//         'active' as a target → 22023; self-transition = idempotent no-op
//   +     preflight TOCTOU gate, lease refusal, uniqueness, envelope trigger,
//         non-member refusal, in_worktree registry row with its own schema
//
//   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_worktree_verify \
//     node db/test/worktrees.mjs
// =============================================================================
import { json, run, scalar, claimsFor, buildWorld, literal, uuid, cmid, OWNER_URL } from './helpers.mjs';

const tag = `wt${Date.now().toString(36)}`;
const world = buildWorld(tag);
const spaceId = world.spaceA;
const identityA = world.identityA;
const memberA = world.memberA;
const identityB = world.identityB;
/** `internal.*` and direct table writes are owner-only; those probes run as owner. */
const ownerOpts = { url: OWNER_URL };

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

const OID = 'a'.repeat(40);
const wtPath = `/tmp/tm8-wt-${tag}/one`;

// --- 1. create through the door, as tm8_app ----------------------------------
const created = json(
  `select public.create_worktree(${uuid(spaceId)}, ${uuid(world.projectId)}, ${literal(wtPath)},
     ${literal(`tm8/${tag}-one`)}, 'main', ${literal(OID)}, ${uuid(memberA)}, ${literal(cmid(tag))})`,
  { claims: claimsFor(identityA, memberA) },
);
const wtId = created.entity?.id;
check('create_worktree returns an entity id', typeof wtId === 'string' && wtId.length > 0, true);
check('envelope kind is worktree',
  scalar(`select kind from public.entities where id = ${uuid(wtId)}`, { claims: claimsFor(identityA, memberA) }),
  'worktree');
check('initial version row recorded (021 precedent, not 015)',
  Number(scalar(`select count(*) from public.entity_versions where entity_id = ${uuid(wtId)}`, ownerOpts)),
  1);

const versionAfterCreate = Number(scalar(
  `select version from public.entities where id = ${uuid(wtId)}`, ownerOpts));
check('version after create is 1', versionAfterCreate, 1);

// --- 2. G1.4 content hydration — the entity_content arm ----------------------
const content = json(`select internal.entity_content(${uuid(wtId)})`, ownerOpts);
check('entity_content hydrates branch', content.branch, `tm8/${tag}-one`);
check('entity_content hydrates status', content.status, 'active');
check('entity_content does not leak entity_id', 'entity_id' in content, false);

// --- 3. G1.3 — R29: direct status write outside the door, even as OWNER ------
const direct = run(
  `update public.worktrees set status = 'merged' where entity_id = ${uuid(wtId)}`,
  { ...ownerOpts, verbose: true },
);
check('direct status UPDATE refused (R29, 23514)', direct.sqlstate, '23514');

// --- 4. G1.2 — allocation churn must not touch the entity version (W3) -------
run(`insert into public.worktree_allocations(worktree_entity_id, node_id, state)
     values (${uuid(wtId)}, 'test-node', 'preparing')`, ownerOpts);
for (const state of ['ready', 'cleanup_pending', 'missing', 'failed', 'ready']) {
  run(`update public.worktree_allocations set state = ${literal(state)}
       where worktree_entity_id = ${uuid(wtId)}`, ownerOpts);
}
run(`update public.worktree_allocations
       set lease_session_id = ${uuid(world.personaA)}, lease_acquired_at = now()
     where worktree_entity_id = ${uuid(wtId)}`, ownerOpts);
run(`update public.worktree_allocations
       set lease_session_id = null, lease_acquired_at = null
     where worktree_entity_id = ${uuid(wtId)}`, ownerOpts);
check('G1.2: five allocation states + lease acquire/release bumped nothing',
  Number(scalar(`select version from public.entities where id = ${uuid(wtId)}`, ownerOpts)),
  versionAfterCreate);

// --- 5. G1.6 — refusals before any transition --------------------------------
const badVersion = run(
  `select public.update_worktree(${uuid(wtId)}, 99, 'merged', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('expectedVersion mismatch refused', badVersion.ok, false);
const toActive = run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterCreate}, 'active', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check("'active' is never a legal target (22023)", toActive.sqlstate, '22023');
const outsider = run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterCreate}, 'merged', null, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityB), verbose: true },
);
check('non-member transition refused', outsider.ok, false);

// --- 6. G1.1 — the transition, exactly one bump ------------------------------
const merged = json(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterCreate}, 'merged', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA) },
);
check('active→merged succeeds through the door', (merged.entity?.id ?? null) !== null, true);
const versionAfterMerge = Number(scalar(
  `select version from public.entities where id = ${uuid(wtId)}`, ownerOpts));
check('G1.1: exactly one version bump per transition', versionAfterMerge, versionAfterCreate + 1);
check('status is merged', scalar(
  `select status from public.worktrees where entity_id = ${uuid(wtId)}`, ownerOpts), 'merged');
check('snapshot row tracks the envelope version (debounce-aware)',
  Number(scalar(`select max(version) from public.entity_versions where entity_id = ${uuid(wtId)}`, ownerOpts)),
  versionAfterMerge);

// --- 7. G1.6 — forward-only, terminal, idempotent ----------------------------
const backwards = run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterMerge}, 'abandoned', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('merged→abandoned refused (23514)', backwards.sqlstate, '23514');
run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterMerge}, 'merged', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA) },
);
check('self-transition is a no-op (no version bump)',
  Number(scalar(`select version from public.entities where id = ${uuid(wtId)}`, ownerOpts)),
  versionAfterMerge);

// --- 8. preflight TOCTOU gate on delete with a READY allocation --------------
run(`update public.worktree_allocations set state = 'ready'
     where worktree_entity_id = ${uuid(wtId)}`, ownerOpts);
const noToken = run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterMerge}, 'deleted', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('delete with ready allocation and no token refused (stale_preflight)', noToken.sqlstate, '23514');
run(`update public.worktree_allocations
       set lease_session_id = ${uuid(world.personaA)}, lease_acquired_at = now(),
           preflight_token = 'tok-${tag}', preflight_at = now()
     where worktree_entity_id = ${uuid(wtId)}`, ownerOpts);
const leased = run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterMerge}, 'deleted', ${uuid(memberA)}, ${literal(cmid(tag))}, ${literal(`tok-${tag}`)})`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('delete while leased refused (53400)', leased.sqlstate, '53400');
run(`update public.worktree_allocations set lease_session_id = null
     where worktree_entity_id = ${uuid(wtId)}`, ownerOpts);
const deleted = json(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterMerge}, 'deleted', ${uuid(memberA)}, ${literal(cmid(tag))}, ${literal(`tok-${tag}`)})`,
  { claims: claimsFor(identityA, memberA) },
);
check('delete with fresh token succeeds', deleted !== null, true);
check('deleted is terminal: version bumped once more',
  Number(scalar(`select version from public.entities where id = ${uuid(wtId)}`, ownerOpts)),
  versionAfterMerge + 1);
const afterDeleted = run(
  `select public.update_worktree(${uuid(wtId)}, ${versionAfterMerge + 1}, 'merged', ${uuid(memberA)}, ${literal(cmid(tag))}, null)`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('deleted→merged refused (terminal, 23514)', afterDeleted.sqlstate, '23514');

// --- 9. uniqueness: no silent queuing ----------------------------------------
const dupPath = run(
  `select public.create_worktree(${uuid(spaceId)}, ${uuid(world.projectId)}, ${literal(wtPath)},
     ${literal(`tm8/${tag}-two`)}, 'main', ${literal(OID)}, ${uuid(memberA)}, ${literal(cmid(tag))})`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('duplicate path is 23505, not silent reuse', dupPath.sqlstate, '23505');
const dupBranch = run(
  `select public.create_worktree(${uuid(spaceId)}, ${uuid(world.projectId)}, ${literal(`/tmp/tm8-wt-${tag}/two`)},
     ${literal(`tm8/${tag}-one`)}, 'main', ${literal(OID)}, ${uuid(memberA)}, ${literal(cmid(tag))})`,
  { claims: claimsFor(identityA, memberA), verbose: true },
);
check('duplicate (project, branch) is 23505', dupBranch.sqlstate, '23505');

// --- 10. envelope trigger: a worktree detail row on a task entity ------------
const wrongKind = run(
  `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid)
   values (${uuid(world.taskA)}, ${uuid(world.projectId)}, '/tmp/bogus-${tag}', 'bogus', 'main', ${literal(OID)})`,
  { ...ownerOpts, verbose: true },
);
check('detail row on a task entity is refused (23514)', wrongKind.sqlstate, '23514');

// --- 11. registry: in_worktree carries its own props_schema ------------------
check('in_worktree registered with a props_schema (018 sweep cannot cover it)',
  scalar(`select (props_schema is not null)::text from public.edge_types where type = 'in_worktree'`, ownerOpts),
  'true');
check('in_worktree src_kinds excludes memory (based_on is the memory path)',
  scalar(`select ('memory' = any(src_kinds))::text from public.edge_types where type = 'in_worktree'`, ownerOpts),
  'false');

// --- 12. origin stamping (052): an app-written in_worktree edge stamps 'user' -
const edgeRes = json(
  `select public.write_edge(${uuid(world.taskA)}, ${uuid(wtId)}, 'in_worktree', '{}'::jsonb, ${uuid(memberA)}, ${literal(cmid(tag))})`,
  { claims: claimsFor(identityA, memberA) },
);
check('in_worktree edge is writable without a recorder token (mutable association)',
  edgeRes !== null, true);
check('props.origin stamped user for hand-drawn association',
  scalar(`select props->>'origin' from public.edges
           where src_id = ${uuid(world.taskA)} and dst_id = ${uuid(wtId)} and type = 'in_worktree'`, ownerOpts),
  'user');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
