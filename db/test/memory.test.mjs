// =============================================================================
// Memories (056_entity_memory.sql): the memory kind, its mark-edge vocabulary,
// and append-only enforcement.
//
// THE LOAD-BEARING PAIR IS FIRST: V4 (TM8-FOUNDATION-VERIFICATION.md) refuted
// the design's original D2 trigger — an unconditional append-only trigger on
// public.edges breaks the FK purge cascade, and `spaces → entities → edges`
// cascade TODAY. So this suite proves BOTH directions:
//   * cascade-succeeds: deleting an entity (and a whole space) that carries
//     append-only edges works, and the edges die with their graph;
//   * direct-delete-refused: a client deleting the same edge is refused 23514.
// A trigger that passes only one of the two is wrong in a way the other test
// makes visible.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_URL,
  buildWorld,
  claimsFor,
  cmid,
  denied,
  json,
  literal,
  ok,
  run,
  scalar,
  uuid,
} from './helpers.mjs';

const world = buildWorld('memory');
const A = world.claimsA;

function createMemory(statement, { actor = null, claims = A, space = world.spaceA } = {}) {
  return json(
    `select public.create_memory(${uuid(space)}, ${literal(statement)},
       'read of the working tree', 'this suite''s scratch database only',
       'does not establish runtime behavior', null, ${uuid(actor)}, null, null, ${literal(cmid('mem'))})`,
    { claims },
  );
}

function writeEdge(src, dst, type, props, { claims = A } = {}) {
  return run(
    `select public.write_edge(${uuid(src)}, ${uuid(dst)}, ${literal(type)},
       ${literal(JSON.stringify(props))}::jsonb, null, ${literal(cmid('edge'))})`,
    { claims, verbose: true },
  );
}

// ---------------------------------------------------------------------------
// The V4 pair, entity-level.
// ---------------------------------------------------------------------------

test('append-only edge survives as a refusal for clients but NOT against the purge cascade (V4)', () => {
  const memory = createMemory('cascade target memory');
  const memoryId = memory.entity.id;

  const pinned = writeEdge(memoryId, world.taskA, 'based_on', {
    pinnedVersion: 1,
    pinnedAt: '2026-07-31T00:00:00Z',
  });
  assert.equal(pinned.ok, true, `based_on create failed:\n${pinned.stderr}`);

  // RED: a direct client delete of the flagged edge is refused with 23514.
  denied(
    'append-only: edges.delete on based_on must be refused',
    `delete from public.edges where src_id = ${uuid(memoryId)} and type = 'based_on'`,
    { url: OWNER_URL, expect: '23514' },
  );

  // GREEN: the entity purge cascade is exempt — the edge dies with its entity.
  ok(`delete from public.entities where id = ${uuid(memoryId)}`, { url: OWNER_URL });
  assert.equal(
    Number(scalar(`select count(*) from public.edges where src_id = ${uuid(memoryId)}`, { url: OWNER_URL })),
    0,
    'cascade left the append-only edge behind',
  );
});

// ---------------------------------------------------------------------------
// The V4 pair, space-level — the exact failure the verification doc names:
// spaces → entities and entities → edges are both `on delete cascade` today.
// ---------------------------------------------------------------------------

test('the append-only guard adds NO refusal to the space-delete path (V4 space-level)', () => {
  // MEASURED PRE-EXISTING DEFECT, not this feature's: space hard-delete fails
  // TODAY on a space with zero mark edges — `entities_capture_event` fires
  // during the cascade and `internal.next_event_seq` re-inserts into
  // `space_event_seq` for a space that is mid-deletion (FK 23503). So the
  // V4 green ("space delete succeeds through append-only edges") is
  // unreachable end-to-end until that is fixed. What THIS lane must prove is
  // that its guard does not add a second refusal: the failure must be
  // byte-for-byte the same failure with and without append-only edges, and it
  // must never be the guard's 23514.
  const bare = json(`select public.create_space('Cascade Control', 'memory-cascade-bare', 'private')`, {
    claims: claimsFor(world.identityA),
  });
  const bareFailure = run(`delete from public.spaces where id = ${uuid(bare.space.id)}`, {
    url: OWNER_URL, verbose: true,
  });
  assert.equal(bareFailure.ok, false, 'pre-existing: space hard-delete is expected to fail today');
  assert.equal(bareFailure.sqlstate, '23503', bareFailure.stderr);

  const marked = json(`select public.create_space('Cascade Marked', 'memory-cascade-marked', 'private')`, {
    claims: claimsFor(world.identityA),
  });
  const claims = claimsFor(world.identityA, marked.memberId);
  const task = json(`select public.create_task(${uuid(marked.space.id)}, 'basis task')`, { claims });
  const memory = createMemory('space cascade memory', { claims, space: marked.space.id });
  const pinned = writeEdge(memory.entity.id, task.entity.id, 'based_on', {
    pinnedVersion: 1, pinnedAt: '2026-07-31T00:00:00Z',
  }, { claims });
  assert.equal(pinned.ok, true, `based_on create failed:\n${pinned.stderr}`);
  const disputed = writeEdge(memory.entity.id, task.entity.id, 'disputes', {
    quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1,
  }, { claims });
  assert.equal(disputed.ok, true, `disputes create failed:\n${disputed.stderr}`);

  const markedFailure = run(`delete from public.spaces where id = ${uuid(marked.space.id)}`, {
    url: OWNER_URL, verbose: true,
  });
  assert.equal(markedFailure.ok, false);
  assert.equal(markedFailure.sqlstate, '23503',
    `expected the SAME pre-existing failure, got: ${markedFailure.stderr}`);
  assert.ok(!/append-only/.test(markedFailure.stderr),
    `the append-only guard refused the space cascade — the V4 exemption is broken:\n${markedFailure.stderr}`);
});

// ---------------------------------------------------------------------------
// The third mutation door: edges.create is an UPSERT, and the DO UPDATE arm
// must be closed too (an RPC-level guard would miss it).
// ---------------------------------------------------------------------------

test('append-only: the upsert door is closed; mutable types keep it open', () => {
  const memory = createMemory('upsert door memory');
  const first = writeEdge(memory.entity.id, world.taskA, 'disputes', {
    quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1,
  });
  assert.equal(first.ok, true, first.stderr);

  // RED: re-create with different props → the DO UPDATE arm fires the guard.
  const second = writeEdge(memory.entity.id, world.taskA, 'disputes', {
    quote: 'rewritten', expected: 'e', observed: 'o', pinnedVersion: 1,
  });
  assert.equal(second.ok, false, 'append-only upsert was allowed to rewrite props');
  assert.equal(second.sqlstate, '23514', second.stderr);

  // GREEN: `about` is mutable — the same re-create path succeeds.
  const aboutOne = writeEdge(memory.entity.id, world.taskA, 'about', {});
  assert.equal(aboutOne.ok, true, aboutOne.stderr);
  const aboutTwo = writeEdge(memory.entity.id, world.taskA, 'about', {});
  assert.equal(aboutTwo.ok, true, aboutTwo.stderr);
});

test('append-only: edges.patch refused on based_on, allowed on remembers', () => {
  const memory = createMemory('patch door memory');
  const pin = writeEdge(memory.entity.id, world.taskA, 'based_on', {
    pinnedVersion: 1, pinnedAt: '2026-07-31T00:00:00Z',
  });
  assert.equal(pin.ok, true, pin.stderr);
  const pinEdge = scalar(
    `select id from public.edges where src_id = ${uuid(memory.entity.id)} and type = 'based_on'`,
    { claims: A },
  );
  denied(
    'edges.patch on an append-only type',
    `select public.update_edge(${uuid(pinEdge)}, '{"pinnedVersion": 99, "pinnedAt": "2026-07-31T00:00:00Z"}'::jsonb, null, ${literal(cmid('patch'))})`,
    { claims: A, expect: '23514' },
  );

  const remembers = writeEdge(world.memberA, memory.entity.id, 'remembers', { note: 'mine' });
  assert.equal(remembers.ok, true, remembers.stderr);
  const rememberEdge = scalar(
    `select id from public.edges where dst_id = ${uuid(memory.entity.id)} and type = 'remembers'`,
    { claims: A },
  );
  const patched = run(
    `select public.update_edge(${uuid(rememberEdge)}, '{"note": "corrected"}'::jsonb, null, ${literal(cmid('patch'))})`,
    { claims: A },
  );
  assert.equal(patched.ok, true, patched.stderr);
});

test('undo token suppressed for append-only types, still minted for mutable ones', () => {
  const memory = createMemory('undo token memory');
  const about = writeEdge(memory.entity.id, world.taskA, 'about', {});
  assert.equal(about.ok, true, about.stderr);
  const aboutResult = JSON.parse(about.stdout.split('\n').filter((l) => l.trim()).pop());
  assert.ok(aboutResult.undo, 'mutable edge should mint an undo token');

  const pin = writeEdge(memory.entity.id, world.taskA, 'copy_of', {
    pinnedVersion: 1, source: 'db/test/memory.test.mjs',
  });
  assert.equal(pin.ok, true, pin.stderr);
  const pinResult = JSON.parse(pin.stdout.split('\n').filter((l) => l.trim()).pop());
  assert.equal(pinResult.undo, undefined, 'append-only edge minted a dead-on-arrival undo token');
});

// ---------------------------------------------------------------------------
// Doors.
// ---------------------------------------------------------------------------

test('create_memory: happy path records exactly one v1 snapshot', () => {
  const memory = createMemory('initial version memory');
  assert.equal(memory.entity.version, 1);
  const versions = scalar(
    `select count(*) from public.entity_versions where entity_id = ${uuid(memory.entity.id)}`,
    { url: OWNER_URL },
  );
  assert.equal(Number(versions), 1, 'create must record the initial version');
});

test('create_memory: missing scope fields are 22023, not a retryable 503 (F5)', () => {
  denied(
    'create_memory with a whitespace-only mechanism',
    `select public.create_memory(${uuid(world.spaceA)}, 'stmt', '   ', 'scope', 'dne', null, null, null, null, ${literal(cmid('bad'))})`,
    { claims: A, expect: '22023' },
  );
});

test('update_memory bumps the version through the snapshot trigger', () => {
  const memory = createMemory('version bump memory');
  const updated = json(
    `select public.update_memory(${uuid(memory.entity.id)}, 1, null, 'version bump memory, edited',
       null, null, null, null, false, ${literal(cmid('upd'))})`,
    { claims: A },
  );
  assert.ok(updated);
  const version = Number(scalar(
    `select version from public.entities where id = ${uuid(memory.entity.id)}`, { claims: A },
  ));
  assert.equal(version, 2, 'material edit must advance entities.version');
});

test('memory hierarchy is refused at the data layer, not merely hidden', () => {
  const memory = createMemory('no hierarchy memory');
  denied(
    'setting a parent on a memory entity',
    `update public.entities set parent_id = ${uuid(world.taskA)} where id = ${uuid(memory.entity.id)}`,
    { url: OWNER_URL, expect: '23514' },
  );
});

// ---------------------------------------------------------------------------
// Registry gates: closed props schemas and kind restrictions.
// ---------------------------------------------------------------------------

test('closed edge props: an unregistered key in disputes.props is 22023', () => {
  const memory = createMemory('closed props memory');
  const bad = writeEdge(memory.entity.id, world.taskA, 'disputes', {
    quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1, smuggled: true,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.sqlstate, '22023', bad.stderr);
});

test('required edge props: based_on without pinnedVersion is 22023', () => {
  const memory = createMemory('required props memory');
  const bad = writeEdge(memory.entity.id, world.taskA, 'based_on', { pinnedAt: '2026-07-31T00:00:00Z' });
  assert.equal(bad.ok, false);
  assert.equal(bad.sqlstate, '22023', bad.stderr);
});

test('kind-mismatched marks: disputes from a task source is refused', () => {
  const bad = writeEdge(world.taskA, world.personaA, 'disputes', {
    quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.sqlstate, '23514', bad.stderr);
});

test('supersedes: cycle refused, chain accepted', () => {
  const older = createMemory('superseded claim');
  const newer = createMemory('superseding claim');
  const forward = writeEdge(newer.entity.id, older.entity.id, 'supersedes', { reason: 'remeasured' });
  assert.equal(forward.ok, true, forward.stderr);
  const backward = writeEdge(older.entity.id, newer.entity.id, 'supersedes', { reason: 'cycle' });
  assert.equal(backward.ok, false, 'A→B→A supersession must be refused');
});

// ---------------------------------------------------------------------------
// Verification semantics.
// ---------------------------------------------------------------------------

test('verifies: pin currency, answers integrity, and the independence tiers', () => {
  // Target authored by member A; evidence authored by the persona — distinct
  // created_by, no authored_from on either side → the ACTOR tier applies.
  const target = createMemory('verified claim');
  const evidence = createMemory('independent evidence', { actor: world.personaA });

  // RED: stale pin.
  const stale = writeEdge(evidence.entity.id, target.entity.id, 'verifies', {
    mechanism: 'reread', answers: [], pinnedVersion: 99, independenceBasis: 'actor',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.sqlstate, '23514', stale.stderr);

  // RED: overclaimed basis — only actor separation exists here.
  const overclaim = writeEdge(evidence.entity.id, target.entity.id, 'verifies', {
    mechanism: 'reread', answers: [], pinnedVersion: 1, independenceBasis: 'session',
  });
  assert.equal(overclaim.ok, false);
  assert.equal(overclaim.sqlstate, '23514', overclaim.stderr);

  // RED: same-author evidence fails the actor tier.
  const dependent = createMemory('dependent evidence');
  const sameAuthor = writeEdge(dependent.entity.id, target.entity.id, 'verifies', {
    mechanism: 'reread', answers: [], pinnedVersion: 1, independenceBasis: 'actor',
  });
  assert.equal(sameAuthor.ok, false);
  assert.equal(sameAuthor.sqlstate, '23514', sameAuthor.stderr);

  // RED: answers naming something that is not a dispute on this target.
  const bogus = writeEdge(evidence.entity.id, target.entity.id, 'verifies', {
    mechanism: 'reread', answers: ['00000000-0000-0000-0000-000000000000'],
    pinnedVersion: 1, independenceBasis: 'actor',
  });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.sqlstate, '23514', bogus.stderr);

  // GREEN: a real dispute, answered, on the actor tier.
  const disputer = createMemory('disputing evidence', { actor: world.personaA });
  const dispute = writeEdge(disputer.entity.id, target.entity.id, 'disputes', {
    quote: 'claim text', expected: 'x', observed: 'y', pinnedVersion: 1,
  });
  assert.equal(dispute.ok, true, dispute.stderr);
  const disputeEdge = scalar(
    `select id from public.edges where src_id = ${uuid(disputer.entity.id)} and type = 'disputes'`,
    { claims: A },
  );
  const cleared = writeEdge(evidence.entity.id, target.entity.id, 'verifies', {
    mechanism: 'independent re-measurement', answers: [disputeEdge],
    pinnedVersion: 1, independenceBasis: 'actor',
  });
  assert.equal(cleared.ok, true, cleared.stderr);
});

test('cross-space pins are refused', () => {
  const memory = createMemory('cross space memory');
  const bad = writeEdge(memory.entity.id, world.channelB, 'about', {});
  assert.equal(bad.ok, false, 'edge into another space must be refused');
});
