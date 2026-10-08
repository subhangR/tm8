/** Acceptance through the shipped HTTP handlers and compiled CLI, backed by PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request, runCli, runRoot } from './game-storage-node.mjs';
import { dataOf } from './game-storage-fixture.mjs';

export async function verifyStorageApi(f, pool, record) {
  const mutation = () => randomUUID();
  const mapPath = `/v2/spaces/${f.spaceId}/maps/open`;
  const selection = { type: 'taskland', scope: { kind: 'space', id: f.spaceId } };
  const open = async (value, options) => request(mapPath, { ...value, clientMutationId: mutation() }, options);
  const map = dataOf(await open(selection), 'map open');
  assert.ok(map.id, 'map identity id');
  const path = `/v2/maps/${map.id}`;
  const context = async () => dataOf(await request(path), 'map context');
  const place = async (input, options) => request(`${path}/placements`, { kind: 'decor', x: 1, z: 2,
    expectedVersion: 0, itemId: randomUUID(), spec: {}, ...input, clientMutationId: mutation() }, { method: 'PUT', ...options });
  const denied = response => { assert.ok(response.status >= 400 && response.status < 500, 'expected typed refusal'); assert.ok(response.error?.code, 'typed error'); };
  const check = async (name, fn) => { const began = Date.now(); try { await fn(); record({ name, passed: true, elapsedMs: Date.now() - began }); }
    catch (error) { record({ name, passed: false, elapsedMs: Date.now() - began, reason: String(error.message).slice(0, 200) }); } };

  await check('real request transactions enforce tm8_app RLS', async () => {
    dataOf(await place({}), 'RLS fixture placement');
    assert.ok((await context()).placements.length > 0, 'positive owner control');
    const client = await pool.connect();
    try {
      await client.query('begin'); await client.query('set local role tm8_app');
      await client.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.node_admin','false',true)", [f.stranger.identityId]);
      const { rows } = await client.query('select * from map.placements where map_id=$1', [map.id]);
      assert.equal(rows.length, 0);
      const { rows: [role] } = await client.query('select current_user as role'); assert.equal(role.role, 'tm8_app');
    } finally { await client.query('rollback'); client.release(); }
    denied(await request(path, undefined, { token: f.stranger.token }));
  });
  await check('concurrent mixed-case first opens create one durable identity', async () => {
    const s = { type: 'office', scope: { kind: 'story', id: f.nestedStoryId } };
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => open({ ...s, scope: { ...s.scope, id: index % 2 ? s.scope.id.toUpperCase() : s.scope.id } })));
    const ids = results.map(result => dataOf(result, 'concurrent open').id); assert.equal(new Set(ids).size, 1);
    const { rows: [count] } = await pool.query(`select count(*)::integer as n from public.graphs g join public.entities e on e.id=g.entity_id
      where e.space_id=$1 and g.graph_type='tm8-map' and lower(g.layout->'scope'->>'id')=lower($2) and g.layout->>'type'='office' and e.deleted_at is null`, [f.spaceId, f.nestedStoryId]);
    assert.equal(count.n, 1);
  });
  await check('scope authorization rejects foreign space story and non-story refs', async () => {
    for (const scope of [{ kind: 'space', id: f.otherSpaceId }, { kind: 'story', id: f.foreignStoryId }, { kind: 'story', id: f.taskId }, { kind: 'story', id: randomUUID() }]) denied(await open({ type: 'hub', scope }));
    denied(await open(selection, { token: f.stranger.token }));
  });
  await check('building references require real same-space admitted entities', async () => {
    denied(await place({ kind: 'ref' }));
    for (const entityId of [randomUUID(), f.foreignTaskId, f.docId]) denied(await place({ kind: 'ref', entityId }));
    denied(await place({ kind: 'decor', entityId: f.taskId }));
    dataOf(await place({ kind: 'ref', entityId: f.taskId }), 'real ref placement');
  });
  await check('story references require live story membership and reads hide deleted targets', async () => {
    const scoped = dataOf(await open({ type: 'taskland', scope: { kind: 'story', id: f.storyId } }), 'scoped map');
    const scopedPath = `/v2/maps/${scoped.id}`;
    const entity = dataOf(await request('/v2/entities', { kind: 'task', title: 'Synthetic scoped placement', spaceId: f.spaceId, clientMutationId: mutation() }), 'scoped task').entity;
    const body = { itemId: randomUUID(), entityId: entity.id, kind: 'ref', x: 2, z: 3, expectedVersion: 0, spec: {} };
    denied(await request(`${scopedPath}/placements`, { ...body, clientMutationId: mutation() }, { method: 'PUT' }));
    dataOf(await request(`/v2/collections/${f.storyId}/items`, { entityId: entity.id, clientMutationId: mutation() }), 'story membership');
    dataOf(await request(`${scopedPath}/placements`, { ...body, clientMutationId: mutation() }, { method: 'PUT' }), 'story ref');
    assert.equal(dataOf(await request(scopedPath), 'scoped read').placements.length, 1);
    dataOf(await request(`/v2/entities/${entity.id}`, { clientMutationId: mutation() }, { method: 'DELETE' }), 'delete synthetic target');
    assert.equal(dataOf(await request(scopedPath), 'filtered deleted ref').placements.length, 0);
  });

  let human, moved;
  await check('human placements resist agent replace move remove undo and revert', async () => {
    const itemId = randomUUID(); human = dataOf(await place({ itemId }), 'human placement');
    const actor = { token: f.agent.token };
    denied(await place({ itemId, expectedVersion: human.version, x: 7 }, actor));
    denied(await request(`${path}/placements/${itemId}`, { x: 7, z: 8, expectedVersion: human.version, clientMutationId: mutation() }, { ...actor, method: 'PATCH' }));
    denied(await request(`${path}/placements/${itemId}`, { expectedVersion: human.version, clientMutationId: mutation() }, { ...actor, method: 'DELETE' }));
    denied(await request(`${path}/undo`, { editSeq: human.editSeq, clientMutationId: mutation() }, actor));
    denied(await request(`${path}/revert`, { byActor: f.owner.memberId, since: '2026-01-01T00:00:00Z', clientMutationId: mutation() }, actor));
    const row = (await context()).placements.find(row => row.itemId === itemId); assert.equal(row.x, 1); assert.equal(row.layer, 'human');
  });
  await check('undo is attributed and version-safe against newer edits', async () => {
    assert.ok(human, 'human setup');
    moved = dataOf(await request(`${path}/placements/${human.itemId}`, { x: 8, z: 9, expectedVersion: human.version, clientMutationId: mutation() }, { method: 'PATCH' }), 'move');
    const newer = dataOf(await request(`${path}/placements/${human.itemId}`, { x: 9, z: 10, expectedVersion: moved.version, clientMutationId: mutation() }, { method: 'PATCH' }), 'newer move');
    const stale = await request(`${path}/undo`, { editSeq: moved.editSeq, clientMutationId: mutation() }); denied(stale); assert.equal(stale.error.code, 'version_conflict');
    const undone = dataOf(await request(`${path}/undo`, { editSeq: newer.editSeq, clientMutationId: mutation() }), 'undo');
    const row = (await context()).placements.find(row => row.itemId === human.itemId); assert.equal(row.x, 8); assert.ok(row.version > newer.version);
    const { rows: [edit] } = await pool.query('select actor_id,op from map.edits where seq=$1', [undone.editSeq]);
    assert.equal(edit.actor_id, f.owner.memberId); assert.equal(edit.op, 'undo');
  });
  await check('agent undo cannot overwrite subsequent human intervention', async () => {
    const itemId = randomUUID();
    const initial = dataOf(await place({ itemId }, { token: f.agent.token }), 'agent placement');
    const touched = dataOf(await place({ itemId, expectedVersion: initial.version, x: 12 }), 'human intervention');
    denied(await request(`${path}/undo`, { editSeq: initial.editSeq, clientMutationId: mutation() }, { token: f.agent.token }));
    const row = (await context()).placements.find(row => row.itemId === itemId); assert.equal(row.x, 12); assert.equal(row.version, touched.version); assert.equal(row.layer, 'human');
  });
  await check('map context is cursor-bounded and scoped to requested identity', async () => {
    dataOf(await place({}), 'extra placement');
    const first = dataOf(await request(`${path}?limit=1`), 'bounded context'); assert.equal(first.placements.length, 1); assert.ok(first.nextCursor);
    const second = dataOf(await request(`${path}?limit=1&cursor=${first.nextCursor}`), 'second page'); assert.equal(second.placements.length, 1); assert.notEqual(second.placements[0].itemId, first.placements[0].itemId);
    const other = dataOf(await open({ type: 'library', scope: selection.scope }), 'other map');
    assert.equal(dataOf(await request(`/v2/maps/${other.id}`), 'other context').placements.length, 0);
  });
  await check('placement and camera reject nonfinite or out-of-budget numbers', async () => {
    denied(await place({ x: null })); denied(await place({ x: 1_000_001 })); denied(await place({ rotation: 361 }));
  });

  const navPath = `/v2/spaces/${f.spaceId}/maps/navigation`;
  const nav = async options => dataOf(await request(navPath, undefined, options), 'navigation get');
  const save = { version: 1, spaceId: f.spaceId, memberId: f.owner.memberId, current: { type: 'hub', scope: selection.scope }, stack: [], maps: {} };
  const write = (state, revision, options) => request(navPath, { save: state, expectedRevision: revision, clientMutationId: mutation() }, { method: 'PUT', ...options });
  await check('navigation isolates members and refuses arbitrary-member or agent writes', async () => {
    const initial = await nav(); assert.equal(initial.save, null); assert.equal(initial.revision, 0);
    dataOf(await write(save, initial.revision), 'first save');
    const second = await nav({ token: f.member.token }); assert.equal(second.save, null); assert.equal(second.memberId, f.member.memberId);
    denied(await write({ ...save, memberId: f.member.memberId }, 1));
    denied(await write({ ...save, spaceId: f.otherSpaceId }, 1));
    denied(await request(navPath, undefined, { token: f.agent.token }));
    denied(await write(save, 1, { token: f.agent.token }));
    denied(await request(navPath, undefined, { token: f.stranger.token }));
  });
  await check('ordinary members may place undo Town refs without gaining terrain authority', async () => {
    const actor = { token: f.member.token };
    const town = dataOf(await open({ type: 'town', scope: selection.scope }, actor), 'member first town open');
    const townPath = `/v2/maps/${town.id}`;
    const placed = dataOf(await request(`${townPath}/placements`, { itemId: randomUUID(), entityId: f.taskId, kind: 'ref', x: 4, z: 5,
      expectedVersion: 0, clientMutationId: mutation() }, { ...actor, method: 'PUT' }), 'member Town ref');
    const undone = dataOf(await request(`${townPath}/undo`, { editSeq: placed.editSeq, clientMutationId: mutation() }, actor), 'member Town undo');
    const { rows: [edit] } = await pool.query('select actor_id from map.edits where seq=$1', [undone.editSeq]); assert.equal(edit.actor_id, f.member.memberId);
    denied(await request(`${townPath}/terrain`, { chunkX: 0, chunkZ: 0, tiles: [1], expectedVersion: 0, clientMutationId: mutation() }, { ...actor, method: 'PUT' }));
  });
  await check('mutation replay is stable and rejects changed payload', async () => {
    const clientMutationId = mutation();
    const body = { itemId: randomUUID(), kind: 'decor', x: 1, z: 2, expectedVersion: 0, clientMutationId };
    const first = dataOf(await request(`${path}/placements`, body, { method: 'PUT' }), 'first replayable placement');
    assert.deepEqual(dataOf(await request(`${path}/placements`, body, { method: 'PUT' }), 'placement replay'), first);
    denied(await request(`${path}/placements`, { ...body, x: 4 }, { method: 'PUT' }));
  });
  await check('two device CAS race keeps the winner and reports conflict', async () => {
    const initial = await nav();
    const attempts = await Promise.all([write(save, initial.revision), write(save, initial.revision)]);
    assert.equal(attempts.filter(r => r.status < 300).length, 1);
    const loser = attempts.find(r => r.status >= 400); assert.equal(loser.error.code, 'version_conflict');
    assert.equal((await nav()).revision, initial.revision + 1);
  });
  await check('navigation validates finite camera canonical keys and route bounds', async () => {
    const initial = await nav(); const key = JSON.stringify(['space', f.spaceId, 'hub']);
    denied(await write({ ...save, maps: { [key]: { camera: { zoom: 0, position: [1, 2, 3], target: [0, 0, 0] } } } }, initial.revision));
    denied(await write({ ...save, maps: { [key]: { position: { x: null, z: 0 } } } }, initial.revision));
    denied(await write({ ...save, maps: { invalid: { position: { x: 0, z: 0 } } } }, initial.revision));
    denied(await write({ ...save, stack: Array(65).fill(save.current) }, initial.revision));
    denied(await write({ ...save, title: 'a snapshot field' }, initial.revision));
  });
  await check('deleted map is skipped by saves and explicit open restores the same identity', async () => {
    const selected = { type: 'factory', scope: selection.scope };
    const identity = dataOf(await open(selected), 'map to delete');
    dataOf(await request(`/v2/entities/${identity.id}`, { clientMutationId: mutation() }, { method: 'DELETE' }), 'delete map');
    const memoryKey = JSON.stringify(['space', f.spaceId, 'factory']), initial = await nav();
    const acknowledged = dataOf(await write({ ...save, maps: { [memoryKey]: { position: { x: 1, z: 2 } } } }, initial.revision), 'save skips missing map');
    assert.equal(acknowledged.repairs.droppedMemories, 1); assert.equal(acknowledged.save.maps[memoryKey], undefined);
    const restored = dataOf(await open(selected), 'restore map'); assert.equal(restored.id, identity.id);
    assert.equal(dataOf(await request(`/v2/maps/${restored.id}`), 'restored context').map.id, identity.id);
  });
  await check('deleted old story truncates route to valid prefix and prunes its memory', async () => {
    const story = dataOf(await request('/v2/entities', { kind: 'story', title: 'Synthetic old story', spaceId: f.spaceId, parentId: f.storyId, clientMutationId: mutation() }), 'old story').entity;
    const scoped = { type: 'hub', scope: { kind: 'story', id: story.id } };
    dataOf(await open(scoped), 'old story map');
    const root = save.current, initial = await nav(), memoryKey = JSON.stringify(['story', story.id, 'hub']);
    dataOf(await write({ ...save, current: scoped, stack: [root], maps: { [memoryKey]: { position: { x: 1, z: 2 } } } }, initial.revision), 'first descent to projected child');
    dataOf(await request(`/v2/entities/${story.id}`, { clientMutationId: mutation() }, { method: 'DELETE' }), 'delete old story');
    const repaired = await nav(); assert.deepEqual(repaired.save.current, root); assert.deepEqual(repaired.save.stack, []);
    assert.equal(repaired.repairs.routeTruncated, true); assert.equal(repaired.repairs.droppedMemories, 1);
    assert.deepEqual(repaired.save.maps, {});
  });
  await check('compiled CLI opens reads places moves undoes and reads navigation', async () => {
    const env = { TM8_CREDENTIALS_MODE: 'file', TM8_CREDENTIALS_PATH: `${runRoot}/unused-synthetic-credentials.json` };
    const cli = async args => { const result = await runCli([...args, '--space', f.spaceId], env);
      assert.equal(result.code, 0, `compiled CLI ${args.slice(0, 2).join(' ')} must succeed`); return JSON.parse(result.stdout); };
    assert.equal((await cli(['map', 'open', '--type', 'taskland'])).id, map.id);
    assert.equal((await cli(['map', 'context', map.id])).map.id, map.id);
    const placed = await cli(['map', 'place', map.id, f.taskId, '--at', '3,4', '--expect-version', '0']);
    const changed = await cli(['map', 'move', map.id, placed.itemId, '--at', '5,6', '--expect-version', String(placed.version)]);
    await cli(['map', 'undo', map.id, '--input', JSON.stringify({ editSeq: changed.editSeq })]);
    assert.equal((await cli(['map', 'navigation', 'get'])).memberId, f.owner.memberId);
    const row = (await context()).placements.find(row => row.itemId === placed.itemId); assert.equal(row.x, 3); assert.equal(row.z, 4);
    const { rows: [edit] } = await pool.query('select actor_id from map.edits where map_id=$1 order by seq desc limit 1', [map.id]);
    assert.equal(edit.actor_id, f.owner.memberId);
  });
  return { mapId: map.id, navigationPath: navPath, save, check };
}
