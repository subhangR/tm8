// =============================================================================
// The `graph` kind (135), end to end, through the RPC doors only.
//
// A graph entity is ONE ROW holding vertices AND edges (Craft P1 ruling R1):
// crafting is create + version-guarded patch on that row, and it must never
// require or produce real public.edges rows. Every step asserts the CONTENT of
// what came back — internal.entity_content falls through to '{}'::jsonb for a
// kind it does not know, which is invisible to success-only assertions (the
// 011/091 lesson; see loop_rpcs.test.mjs' header).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_URL,
  buildWorld,
  cmid,
  denied,
  json,
  literal,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('graph');

const commandEntity = (id) => json(`select internal.command_entity(${uuid(id)})`, { url: OWNER_URL });

const state = {};

test('step 1 — create an entity-type blueprint and its CONTENT resolves', () => {
  const nodes = JSON.stringify([
    { key: 'a', id: w.personaA },
    { key: 'b', spec: { kind: 'task', title: 'Ship API', hint: 'REST, reuse auth' } },
  ]);
  const edges = JSON.stringify([{ src: 'b', dst: 'a', type: 'assigned_to', note: 'alpha owns backend' }]);
  const created = json(
    `select public.create_graph_entity(${uuid(w.spaceA)}, 'Launch flow', null,
       'entity', ${literal(nodes)}::jsonb, ${literal(edges)}::jsonb,
       '{"b":{"x":0,"y":0}}'::jsonb, null, null, null, ${literal(cmid('graph-create'))})`,
    { claims: w.claimsA },
  );
  state.graph = created.entity;

  assert.equal(state.graph.kind, 'graph');
  assert.equal(state.graph.version, 1);
  assert.equal(state.graph.content.title, 'Launch flow', 'graph content must resolve (011)');
  assert.equal(state.graph.content.graph_type, 'entity');
  assert.equal(state.graph.content.nodes.length, 2);
  assert.equal(state.graph.content.nodes[1].spec.title, 'Ship API');
  assert.equal(state.graph.content.edges[0].type, 'assigned_to');
  assert.deepEqual(state.graph.content.layout, { b: { x: 0, y: 0 } });
  // Command results strip null members (internal.command_result); the raw
  // row carries "source": null. Absent-or-null both mean "no text source".
  assert.equal(state.graph.content.source ?? null, null, 'entity-type blueprints have no text source');

  // R1: crafting produced ZERO real edges — the flow lives inside the row.
  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(state.graph.id)} or dst_id = ${uuid(state.graph.id)}`,
      { url: OWNER_URL },
    ),
    '0',
  );
});

test('step 2 — a version-guarded patch merges, bumps the version, and refuses staleness', () => {
  const grown = JSON.stringify([
    { key: 'a', id: w.personaA },
    { key: 'b', spec: { kind: 'task', title: 'Ship API', hint: 'REST, reuse auth' } },
    { key: 'c', spec: { kind: 'task', title: 'Ship UI' } },
  ]);
  const patched = json(
    `select public.update_graph_entity(${uuid(state.graph.id)}, 1, null,
       null, null, ${literal(grown)}::jsonb, null, null, null, false,
       ${literal(cmid('graph-grow'))})`,
    { claims: w.claimsA },
  );
  assert.equal(patched.entity.version, 2);
  assert.equal(patched.entity.content.nodes.length, 3);
  // null MERGED: members the patch did not carry are untouched.
  assert.equal(patched.entity.content.edges.length, 1);
  assert.equal(patched.entity.content.title, 'Launch flow');

  denied(
    'a stale expectedVersion must refuse, never clobber',
    `select public.update_graph_entity(${uuid(state.graph.id)}, 1, null,
       'Clobbered', null, null, null, null, null, false, ${literal(cmid('graph-stale'))})`,
    { claims: w.claimsA },
  );
  const reread = commandEntity(state.graph.id);
  assert.equal(reread.content.title, 'Launch flow', 'the refused patch must not land');
});

test('step 3 — a mermaid graph stores its source, and clear_source clears it', () => {
  const created = json(
    `select public.create_graph_entity(${uuid(w.spaceA)}, 'Auth sketch', null,
       'mermaid', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
       'flowchart TD; login-->token', null, null, ${literal(cmid('graph-mermaid'))})`,
    { claims: w.claimsA },
  );
  assert.equal(created.entity.content.graph_type, 'mermaid');
  assert.equal(created.entity.content.source, 'flowchart TD; login-->token');

  const cleared = json(
    `select public.update_graph_entity(${uuid(created.entity.id)}, 1, null,
       null, null, null, null, null, null, true, ${literal(cmid('graph-clear'))})`,
    { claims: w.claimsA },
  );
  assert.equal(cleared.entity.content.source ?? null, null);
  assert.equal(cleared.entity.version, 2);
});

test('step 4 — the doors refuse malformed input by name, softly typed containers only', () => {
  denied(
    'graph_type must be a lowercase slug',
    `select public.create_graph_entity(${uuid(w.spaceA)}, 'Bad type', null,
       'Not A Slug', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, null, null, null,
       ${literal(cmid('graph-badtype'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  denied(
    'nodes must be a JSON array',
    `select public.create_graph_entity(${uuid(w.spaceA)}, 'Bad nodes', null,
       'entity', '{"not":"an array"}'::jsonb, '[]'::jsonb, '{}'::jsonb, null, null, null,
       ${literal(cmid('graph-badnodes'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  denied(
    'title is required',
    `select public.create_graph_entity(${uuid(w.spaceA)}, '  ', null,
       'entity', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, null, null, null,
       ${literal(cmid('graph-notitle'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  // Lean by law (R2): a node spec's SHAPE is not schema-validated — an
  // unknown member sails through; the orchestrating agent interprets it.
  const loose = json(
    `select public.create_graph_entity(${uuid(w.spaceA)}, 'Loose sketch', null,
       'entity', '[{"key":"x","spec":{"kind":"task","vibe":"fast"}}]'::jsonb,
       '[]'::jsonb, '{}'::jsonb, null, null, null, ${literal(cmid('graph-loose'))})`,
    { claims: w.claimsA },
  );
  assert.equal(loose.entity.content.nodes[0].spec.vibe, 'fast');
});

test('step 5 — a non-member cannot create or patch a graph in the space', () => {
  denied(
    'outsider create must refuse',
    `select public.create_graph_entity(${uuid(w.spaceA)}, 'Intruder', null,
       'entity', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, null, null, null,
       ${literal(cmid('graph-outsider'))})`,
    { claims: w.claimsB },
  );
  denied(
    'outsider patch must refuse',
    `select public.update_graph_entity(${uuid(state.graph.id)}, 2, null,
       'Stolen', null, null, null, null, null, false, ${literal(cmid('graph-outpatch'))})`,
    { claims: w.claimsB },
  );
});
