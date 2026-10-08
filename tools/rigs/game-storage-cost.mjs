/** Synthetic, real-handler persistence cost probes. Reports counts and latency only. */
import { randomUUID } from 'node:crypto';
import { request } from './game-storage-node.mjs';
import { dataOf } from './game-storage-fixture.mjs';
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];

export async function ledgerSize(pool) {
  const { rows: [result] } = await pool.query(`select
    (select count(*)::integer from map.command_inputs) as "inputRows",
    (select coalesce(sum(pg_column_size(c)),0)::bigint::text from map.command_inputs c) as "inputBytes",
    (select count(*)::integer from public.command_ledger) as "ledgerRows",
    (select coalesce(sum(pg_column_size(c)),0)::bigint::text from public.command_ledger c) as "ledgerBytes"`);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Number(value)]));
}

export async function verifyPersistenceCost(f, pool, record) {
  const started = Date.now(), types = ['hub', 'taskland', 'office', 'library', 'factory', 'town'];
  const open = async selection => dataOf(await request(`/v2/spaces/${f.spaceId}/maps/open`, { ...selection, clientMutationId: randomUUID() }), 'cost map open');
  const town = await open({ type: 'town', scope: { kind: 'space', id: f.spaceId } });
  await pool.query(`insert into map.placements(map_id,item_id,entity_id,kind,x,z,rotation,spec,layer,by_actor,version)
    select $1,gen_random_uuid(),null,'decor',i,0,0,'{}','human',$2,1 from generate_series(1,100) i`, [town.id, f.owner.memberId]);
  const contextTimes = [];
  for (let index = 0; index < 10; index++) {
    const start = performance.now();
    const context = dataOf(await request(`/v2/maps/${town.id}?limit=100`), 'cost context');
    if (context.placements.length !== 100) throw new Error('Cost context did not contain 100 placements');
    contextTimes.push(performance.now() - start);
  }
  const scopes = [{ kind: 'space', id: f.spaceId }, { kind: 'story', id: f.storyId }, { kind: 'story', id: f.nestedStoryId }];
  while (scopes.length < 22) {
    const entity = dataOf(await request('/v2/entities', { kind: 'story', title: 'Synthetic cost story', spaceId: f.spaceId, clientMutationId: randomUUID() }), 'cost story').entity;
    scopes.push({ kind: 'story', id: entity.id });
  }
  const selections = scopes.flatMap(scope => types.map(type => ({ scope, type }))).slice(0, 128);
  for (let index = 0; index < selections.length; index += 4) await Promise.all(selections.slice(index, index + 4).map(open));
  const state = { version: 1, spaceId: f.spaceId, memberId: f.owner.memberId,
    current: { type: 'hub', scope: scopes[0] }, stack: [], maps: Object.fromEntries(selections.map(selection => [
      JSON.stringify([selection.scope.kind, selection.scope.id, selection.type]),
      { position: { x: 0, z: 0 }, camera: { zoom: 23, position: [24, 23, 24], target: [0, 0.3, 0] } },
    ])) };
  const navPath = `/v2/spaces/${f.spaceId}/maps/navigation`;
  let view = dataOf(await request(navPath), 'cost revision');
  const saveTimes = [], before = await ledgerSize(pool);
  for (let index = 0; index < 5; index++) {
    state.maps[JSON.stringify(['space', f.spaceId, 'hub'])].position.x = index;
    const start = performance.now();
    view = dataOf(await request(navPath, { save: state, expectedRevision: view.revision, clientMutationId: randomUUID() }, { method: 'PUT' }), 'cost save');
    if (Object.keys(view.save.maps).length !== 128) throw new Error('Cost save pruned valid memories');
    saveTimes.push(performance.now() - start);
  }
  const after = await ledgerSize(pool);
  record({ name: 'real context 100 placements and 128-memory save persistence cost', passed: true, elapsedMs: Date.now() - started,
    contextSamples: contextTimes.length, contextP50Ms: percentile(contextTimes, 0.5), contextP95Ms: percentile(contextTimes, 0.95),
    saveSamples: saveTimes.length, saveP50Ms: percentile(saveTimes, 0.5), saveP95Ms: percentile(saveTimes, 0.95),
    savePayloadBytes: Buffer.byteLength(JSON.stringify(state)),
    inputBytesGrowth: after.inputBytes - before.inputBytes, ledgerBytesGrowth: after.ledgerBytes - before.ledgerBytes });
}
