import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getOperation, gameMapKey, type GameMapIdentity, type GameNavigationSave, type GameNavigationView, type OperationName } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { createMapsService } from '../../src/facade/services/w2/maps.js';
import { registerMapsHandlers } from '../../src/facade/handlers/w2/maps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 240000 });
let scratch: W1ScratchDatabase, db: Db, deps: FacadeDeps;
const space = randomUUID(), otherSpace = randomUUID(), owner = randomUUID(), peer = randomUUID(), outsider = randomUUID();
const identity = `map-owner-${randomUUID()}`, peerIdentity = `map-peer-${randomUUID()}`, outIdentity = `map-out-${randomUUID()}`;
let agent: string, task: string, foreignTask: string;
const as = <T>(fn: (q: Querier) => Promise<T>, who = identity, actorId?: string, authKind: 'browser'|'agent' = 'browser') =>
  db.tx({ identityId: who, ...(actorId ? { actorId } : {}), authKind, requestId: randomUUID() }, fn);
const open = (type = 'town', scope = { kind: 'space', id: space }, who = identity, cmid = randomUUID()) =>
  as(q => q.rpc<GameMapIdentity>('game_map_open', [space, JSON.stringify({ type, scope }), cmid]), who);
const write = (mapId: string, op: string, input: Record<string, unknown>, actor?: string, cmid = randomUUID(), who = identity) =>
  as(q => q.rpc<{ mapId: string; itemId: string; version: number; editSeq: number; undone?: number[]; conflicts?: number[] }>('game_map_write',
    [mapId, op, JSON.stringify(input), cmid]), who, actor, actor === agent ? 'agent' : 'browser');
const place = (mapId: string, itemId = randomUUID(), actor?: string) =>
  write(mapId, 'place', { itemId, entityId: task, kind: 'ref', x: 2, z: 3, spec: {}, expectedVersion: 0 }, actor);
const ctx = (opName: OperationName, params: Record<string,string>, body?: unknown, who = identity, query = ''): RequestContext => ({
  opName, op: getOperation(opName)!, params, body, query: new URLSearchParams(query), requestId: randomUUID(),
  identity: { kind: 'bearer', identityId: who, authKind: 'browser' }, headers: {}, method: 'POST', path: '/',
});
const save = (): GameNavigationSave => ({ version: 1, spaceId: space, memberId: owner,
  current: { type: 'town', scope: { kind: 'space', id: space } }, stack: [{ type: 'hub', scope: { kind: 'space', id: space } }],
  maps: { [gameMapKey({ type: 'town', scope: { kind: 'space', id: space } })]: { position: { x: 10, z: 20 },
    camera: { zoom: 10, position: [1,2,3], target: [4,5,6] } } } });
const saveNav = (state = save(), revision = 0, who = identity, actor?: string) =>
  as(q => q.rpc<GameNavigationView>('game_navigation_save', [space, JSON.stringify(state), revision, randomUUID()]), who, actor, actor === agent ? 'agent' : 'browser');
async function admin(sql: string, params: unknown[] = []) {
  return scratch.transaction(async c => {
    await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true),set_config('tm8.node_admin','true',true)", [identity]);
    return (await c.query(sql, params)).rows;
  });
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('game_maps'); scratch.apply(migrationFiles()); db = createDb(scratch.url, { max: 8 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.user_profiles(identity_id,display_name) values($1,'Owner'),($2,'Peer'),($3,'Other')", [identity, peerIdentity, outIdentity]);
    await c.query("insert into public.accounts(identity_id,username,display_name) values($1,$1,'Owner'),($2,$2,'Peer'),($3,$3,'Other')", [identity, peerIdentity, outIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Maps',$3),($2,'Other',$4)", [space, otherSpace, identity, outIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$4,'member',$1),($2,$4,'member',$2),($3,$5,'member',$3)", [owner,peer,outsider,space,otherSpace]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$4,$6,'owner','Owner'),($2,$4,$7,'member','Peer'),($3,$5,$8,'owner','Other')", [owner,peer,outsider,space,otherSpace,identity,peerIdentity,outIdentity]);
  });
  agent = (await as(q => q.rpc<{entity:{id:string}}>('create_team_member', [space,'Map agent']))).entity.id;
  task = (await as(q => q.rpc<{entity:{id:string}}>('create_task', [space,'Real task']))).entity.id;
  foreignTask = (await as(q => q.rpc<{entity:{id:string}}>('create_task', [otherSpace,'Other task']),outIdentity)).entity.id;
  deps = { db, config: {} as FacadeDeps['config'], owner: async () => ({ identityId: identity, memberId: owner, isNodeAdmin: false }) } as FacadeDeps;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('durable map schema and real authorization', () => {
  it('mixed-case concurrent first-open creates one metadata-only entity and durable identity', async () => {
    const maps = await Promise.all([open('town'), open('town',{kind:'space',id:space.toUpperCase()})]);
    expect(maps[0]!.id).toBe(maps[1]!.id);
    const [row] = await scratch.query<{n:string}>("select count(*) as n from public.graphs where graph_type='tm8-map' and layout->>'type'='town'");
    expect(row!.n).toBe('1');
    expect(maps[0]!.scope.id).toBe(space);
  });
  it('rejects other-space scopes, missing stories, unowned actors and outsider reads', async () => {
    await expect(open('town',{kind:'space',id:otherSpace})).rejects.toMatchObject({code:'forbidden'});
    await expect(open('town',{kind:'story',id:randomUUID()})).rejects.toMatchObject({code:'not_found'});
    const map = await open();
    await expect(as(q => q.query('select map.identity($1)',[map.id]),outIdentity)).rejects.toMatchObject({code:'not_found'});
    await expect(place(map.id,randomUUID(),outsider)).rejects.toMatchObject({code:'forbidden'});
    expect(await as(q => q.query('select * from map.placements where map_id=$1',[map.id]),outIdentity)).toEqual([]);
  });
  it('requires real readable same-scope and admitted-kind refs; decor cannot fabricate a building', async () => {
    const map = await open('library');
    await expect(place(map.id)).rejects.toMatchObject({code:'invalid_input'});
    const town = await open();
    for (const entityId of [randomUUID(),foreignTask]) await expect(write(town.id,'place',{itemId:randomUUID(),entityId,kind:'ref',x:1,z:2,expectedVersion:0})).rejects.toMatchObject({code:'not_found'});
    await expect(write(town.id,'place',{itemId:randomUUID(),kind:'ref',x:1,z:2,expectedVersion:0})).rejects.toMatchObject({code:'not_found'});
    await expect(write(town.id,'place',{itemId:randomUUID(),kind:'decor',x:1,z:2,spec:{asset:'task-building'},expectedVersion:0})).rejects.toMatchObject({code:'invalid_input'});
    const story=(await as(q=>q.rpc<{entity:{id:string}}>('create_story_entity',[space,'Scoped']))).entity.id;
    const scoped=await open('town',{kind:'story',id:story});
    await expect(place(scoped.id)).rejects.toMatchObject({code:'forbidden'});
    await as(q=>q.rpc('write_edge',[story,task,'contains','{}',null,randomUUID()]));
    expect((await place(scoped.id)).version).toBe(1);
  });
  it('protects human placements against every agent write and undo after a human intervention', async () => {
    const map=await open(), human=await place(map.id);
    for (const [op,input] of [['move',{itemId:human.itemId,x:9,z:9,expectedVersion:1}],['remove',{itemId:human.itemId,expectedVersion:1}],
      ['place',{itemId:human.itemId,entityId:task,kind:'ref',x:9,z:9,expectedVersion:1}],['undo',{editSeq:human.editSeq}]] as const)
      await expect(write(map.id,op,input,agent)).rejects.toMatchObject({code:'forbidden'});
    const proposed=await place(map.id,randomUUID(),agent);
    await write(map.id,'place',{itemId:proposed.itemId,entityId:task,kind:'ref',x:77,z:88,expectedVersion:1});
    await expect(write(map.id,'undo',{editSeq:proposed.editSeq},agent)).rejects.toMatchObject({code:'forbidden'});
    await expect(write(map.id,'undo',{editSeq:proposed.editSeq})).rejects.toMatchObject({code:'version_conflict'});
    const [row]=await as(q=>q.query<{x:number;layer:string}>('select x,layer from map.placements where map_id=$1 and item_id=$2',[map.id,proposed.itemId]));
    expect(row).toEqual({x:77,layer:'human'});
  });
  it('attributed undo is reversible and version conflicts preserve newer edits', async () => {
    const map=await open(), placed=await place(map.id);
    const moved=await write(map.id,'move',{itemId:placed.itemId,x:30,z:40,expectedVersion:1});
    await expect(write(map.id,'undo',{editSeq:placed.editSeq})).rejects.toMatchObject({code:'version_conflict'});
    const undone=await write(map.id,'undo',{editSeq:moved.editSeq});
    await write(map.id,'undo',{editSeq:undone.editSeq});
    const [row]=await as(q=>q.query<{x:number;version:number;by_actor:string}>('select x,version,by_actor from map.placements where map_id=$1 and item_id=$2',[map.id,placed.itemId]));
    expect(row).toEqual({x:30,version:4,by_actor:owner});
  });
  it('human member town edits/undo work; terrain remains editor/admin only and agent forbidden', async () => {
    const map=await open(), placed=await place(map.id);
    expect((await write(map.id,'move',{itemId:placed.itemId,x:9,z:9,expectedVersion:1},undefined,randomUUID(),peerIdentity)).version).toBe(2);
    const paint={chunkX:1,chunkZ:2,tiles:[1,2,3],expectedVersion:0};
    await expect(write(map.id,'paint',paint,agent)).rejects.toMatchObject({code:'forbidden'});
    await expect(write(map.id,'paint',paint,undefined,randomUUID(),peerIdentity)).rejects.toMatchObject({code:'forbidden'});
    const painted=await write(map.id,'paint',paint);
    await expect(write(map.id,'paint',paint)).rejects.toMatchObject({code:'version_conflict'});
    await write(map.id,'undo',{editSeq:painted.editSeq});
  });
  it('idempotent replay preserves edit/version and rejects payload reuse', async () => {
    const map=await open(), cmid=randomUUID(), input={itemId:randomUUID(),entityId:task,kind:'ref',x:1,z:2,expectedVersion:0};
    const first=await write(map.id,'place',input,undefined,cmid);
    expect(await write(map.id,'place',input,undefined,cmid)).toEqual(first);
    await expect(write(map.id,'place',{...input,x:2},undefined,cmid)).rejects.toMatchObject({code:'invariant_violation'});
  });
  it('restores a deleted map identity through standard restore without duplicating it', async () => {
    const map=await open('office');
    await admin('update public.entities set deleted_at=clock_timestamp() where id=$1',[map.id]);
    const restored=await Promise.all([open('office'),open('office')]);
    expect(restored.map(m=>m.id)).toEqual([map.id,map.id]);
    const audit=await scratch.query("select verb from public.activity where entity_id=$1 and verb='restored'",[map.id]);
    expect(audit).toHaveLength(1);
  });
  it('handler context pages honestly, hides deleted refs and caps terrain', async () => {
    const map=await open(), service=createMapsService(deps);
    await place(map.id); await place(map.id);
    const first=await service.context(ctx('maps.context',{mapId:map.id},undefined,identity,'limit=1'));
    expect(first.placements).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next=await service.context(ctx('maps.context',{mapId:map.id},undefined,identity,`limit=1&cursor=${first.nextCursor}`));
    expect(next.placements[0]!.itemId).not.toBe(first.placements[0]!.itemId);
    const temporary=(await as(q=>q.rpc<{entity:{id:string}}>('create_task',[space,'Temporary']))).entity.id;
    const itemId=randomUUID(); await write(map.id,'place',{itemId,entityId:temporary,kind:'ref',x:1,z:2,expectedVersion:0});
    await admin('update public.entities set deleted_at=clock_timestamp() where id=$1',[temporary]);
    expect((await service.context(ctx('maps.context',{mapId:map.id}))).placements.some(p=>p.itemId===itemId)).toBe(false);
    await admin('insert into map.terrain_chunks(map_id,chunk_x,chunk_z,tiles,version,by_actor) select $1,i,0,\'[]\',1,$2 from generate_series(10,74) i',[map.id,owner]);
    const bounded=await service.context(ctx('maps.context',{mapId:map.id})); expect(bounded.terrain).toHaveLength(64); expect(bounded.terrainTruncated).toBe(true);
  });
  it('map edits/activity never add workspace events; activity has bounded TTL and actor caps/rate', async () => {
    const map=await open('taskland');
    const [before]=await scratch.query<{n:string}>('select count(*) as n from public.workspace_events');
    await place(map.id);
    await write(map.id,'activity.append',{kind:'narration',text:'Tests running',ttlSeconds:1},agent);
    await expect(write(map.id,'activity.append',{kind:'celebration',targetEntityId:task,text:'Done',ttlSeconds:7201},agent)).rejects.toMatchObject({code:'invalid_input'});
    const [after]=await scratch.query<{n:string}>('select count(*) as n from public.workspace_events'); expect(after!.n).toBe(before!.n);
    await admin("insert into map.activity(map_id,actor_id,kind,text,created_at,expires_at) select $1,$2,'narration','marker',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour' from generate_series(1,200)",[map.id,agent]);
    await expect(write(map.id,'activity.append',{kind:'narration',text:'over cap'},agent)).rejects.toMatchObject({code:'rate_limited'});
    await admin("delete from map.activity where map_id=$1 and actor_id=$2",[map.id,agent]);
    await admin("insert into map.activity(map_id,actor_id,kind,text,expires_at) select $1,$2,'narration','burst',clock_timestamp()+interval '1 hour' from generate_series(1,60)",[map.id,agent]);
    await expect(write(map.id,'activity.append',{kind:'narration',text:'over rate'},agent)).rejects.toMatchObject({code:'rate_limited'});
  });
  it('navigation CAS survives a new db pool, isolates members, and rejects agent/spoofed state', async () => {
    const state=save(); await open();
    const views=await Promise.allSettled([saveNav(state),saveNav({...state,maps:{...state.maps,[gameMapKey(state.current)]:{position:{x:50,z:60}}}})]);
    expect(views.filter(v=>v.status==='fulfilled')).toHaveLength(1);
    const rejected=views.find(v=>v.status==='rejected') as PromiseRejectedResult; expect(rejected.reason.code).toBe('version_conflict');
    await db.end(); db=createDb(scratch.url,{max:4}); deps={...deps,db};
    const loaded=await as(q=>q.rpc<GameNavigationView>('game_navigation_get',[space])); expect(loaded.revision).toBe(1); expect(loaded.save!.maps).not.toEqual({});
    const peerView=await as(q=>q.rpc<GameNavigationView>('game_navigation_get',[space]),peerIdentity); expect(peerView).toMatchObject({save:null,revision:0,memberId:peer});
    await expect(saveNav({...state,memberId:peer},1)).rejects.toMatchObject({code:'forbidden'});
    await expect(saveNav({...state,spaceId:otherSpace},1)).rejects.toMatchObject({code:'forbidden'});
    await expect(saveNav(state,1,identity,agent)).rejects.toMatchObject({code:'forbidden'});
    await expect(as(q=>q.rpc('game_navigation_get',[space]),identity,agent,'agent')).rejects.toMatchObject({code:'forbidden'});
    expect(await as(q=>q.query('select * from map.player_states'),peerIdentity)).toEqual([]);
    await expect(as(q=>q.query('insert into map.navigation_states values($1,$2,\'{}\',1,now())',[space,peer]),peerIdentity)).rejects.toMatchObject({code:'forbidden'});
  });
  it('normalizes inaccessible route and memories, accepts non-root first story, enforces deeper lineage', async () => {
    const parent=(await as(q=>q.rpc<{entity:{id:string}}>('create_story_entity',[space,'Parent']))).entity.id;
    const child=(await as(q=>q.rpc<{entity:{id:string}}>('create_story_entity',[space,'Child',null,'',parent]))).entity.id;
    const other=(await as(q=>q.rpc<{entity:{id:string}}>('create_story_entity',[space,'Unrelated']))).entity.id;
    const hub={type:'hub' as const,scope:{kind:'space' as const,id:space}}, childHub={type:'hub' as const,scope:{kind:'story' as const,id:child}};
    await open('hub',{kind:'story',id:child});
    const prior=await as(q=>q.rpc<GameNavigationView>('game_navigation_get',[space]));
    const state:GameNavigationSave={...save(),current:childHub,stack:[hub],maps:{[gameMapKey(childHub)]:{position:{x:2,z:3}}}};
    const written=await saveNav(state,prior.revision); expect(written.repairs.routeTruncated).toBe(false);
    const invalid=await saveNav({...state,current:{type:'hub',scope:{kind:'story',id:other}},stack:[hub,childHub]},written.revision);
    expect(invalid.repairs.routeTruncated).toBe(true); expect(invalid.save!.current).toEqual(childHub);
    await admin('update public.entities set deleted_at=clock_timestamp() where id=$1',[child]);
    const loaded=await as(q=>q.rpc<GameNavigationView>('game_navigation_get',[space])); expect(loaded.save!.current).toEqual(hub); expect(loaded.save!.maps).toEqual({});
    expect(loaded.repairs).toEqual({routeTruncated:true,droppedMemories:1});
  });
  it('handler schemas refuse non-finite positions and forged member saves before SQL', async () => {
    const registry=new HandlerRegistry(); registerMapsHandlers(registry,deps);
    const map=await open();
    await expect(registry.get('maps.place')!(ctx('maps.place',{mapId:map.id},{itemId:randomUUID(),entityId:task,kind:'ref',x:Infinity,z:0,expectedVersion:0,clientMutationId:randomUUID()}))).rejects.toMatchObject({code:'invalid_input'});
    await expect(registry.get('maps.navigation.save')!(ctx('maps.navigation.save',{spaceId:space},{save:{...save(),memberId:peer},expectedRevision:0,clientMutationId:randomUUID()}))).rejects.toMatchObject({code:'forbidden'});
  });
});
