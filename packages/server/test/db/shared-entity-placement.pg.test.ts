import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOperation, MoveEntityInputSchema, type CollectionQuery } from '@tm8/contract';
import { PgDb } from '../../src/db/client.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import { capabilitiesOf } from '../../src/facade/entity-read.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { W2EntitiesCommandsTrackingService } from '../../src/facade/services/w2/entities-commands-tracking.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

describe('shared entity placement through the authorized server paths', () => {
  let database: W1ScratchDatabase;
  let dbA: PgDb; let dbB: PgDb;
  const space = randomUUID(); const other = randomUUID();
  const memberA = randomUUID(); const memberB = randomUUID(); const memberOut = randomUUID();
  const sessions = [randomUUID(), randomUUID()];
  let service: W2EntitiesCommandsTrackingService;
  const claims = (identityId: string) => ({ identityId, nodeAdmin: false });
  const query = (db: PgDb, identity: string, input: Partial<CollectionQuery> = {}) => db.tx(claims(identity), (q) =>
    queryCollection(q, { spaceId: space, kinds: ['task'], limit: 2, ...input }, identity));
  const request = (id: string, body: unknown): RequestContext => ({
    op: getOperation('entities.move'), opName: 'entities.move', params: { id }, query: new URLSearchParams(), body,
    requestId: randomUUID(), identity: { kind: 'auto-owner', identityId: 'placement-a' }, headers: {}, method: 'POST', path: `/v2/entities/${id}/move`,
  });
  beforeAll(async () => {
    database = await createW1ScratchDatabase('shared_placement'); database.apply(migrationFiles());
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query("insert into public.user_profiles(identity_id,display_name) values ('placement-a','A'),('placement-b','B'),('placement-out','Out')");
      await client.query("insert into public.spaces(id,name,created_by_identity) values ($1,'Placement','placement-a'),($2,'Other','placement-out')",[space,other]);
      for (const [id, sp, identity] of [[memberA,space,'placement-a'],[memberB,space,'placement-b'],[memberOut,other,'placement-out']]) {
        await client.query("insert into public.entities(id,space_id,kind,created_by) values ($1,$2,'member',$1)",[id,sp]);
        await client.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values ($1,$2,$3,'owner',$3)",[id,sp,identity]);
      }
      for (const id of sessions) {
        await client.query("insert into public.entities(id,space_id,kind,created_by) values ($1,$2,'work_session',$3)",[id,space,memberA]);
        await client.query("insert into public.work_sessions(entity_id,title,status,share_mode) values ($1,'Session','running','space')",[id]);
      }
    });
    dbA = new PgDb({ databaseUrl: database.url, max: 4 }); dbB = new PgDb({ databaseUrl: database.url, max: 4 });
    service = new W2EntitiesCommandsTrackingService({ db: dbA, config: {} as never,
      owner: async () => ({ identityId: 'placement-a',accountId: randomUUID(),username:'placement-a',isNodeAdmin:false,isOwner:true }) });
    for (let i=0;i<7;i++) await dbA.tx(claims('placement-a'),q=>q.rpc('create_task',[space,`Task ${i}`]));
  },120_000);
  afterAll(async()=>{ await dbA?.end(); await dbB?.end(); await database?.destroy(); },30_000);

  it('uses position by default, including filtered keyset pages and reload',async()=>{
    const first=await query(dbA,'placement-a'); expect(first.query.sort).toBe('position');
    expect(first.page.items.map(r=>r.title)).toEqual(['Task 6','Task 5']);
    const second=await query(dbB,'placement-b',{cursor:first.page.nextCursor!});
    expect(second.page.items.map(r=>r.title)).toEqual(['Task 4','Task 3']);
    const all=await query(dbB,'placement-b',{limit:100});
    const filtered=await query(dbB,'placement-b',{filters:{words:'Task'},limit:100});
    expect(filtered.page.items.map(r=>r.id)).toEqual(all.page.items.map(r=>r.id));
    expect((await query(dbA,'placement-a')).page.items.map(r=>r.id)).toEqual(first.page.items.map(r=>r.id));
  });

  it('two independent authorized event clients receive the same move; outsider sees no events',async()=>{
    const all=await query(dbA,'placement-a',{limit:100}); const moving=all.page.items.at(-1)!;
    const seq=Number((await database.query<{n:string}>('select max(seq)::text n from public.workspace_events where space_id=$1',[space]))[0]!.n);
    const body=MoveEntityInputSchema.parse({parentId:null,placement:{targetId:all.page.items[0]!.id,relation:'before'},expectedVersion:moving.version,clientMutationId:randomUUID()});
    const moved=await service.moveEntity(request(moving.id,body));
    expect(moved.entity?.id).toBe(moving.id);
    const [a,b,out]=await Promise.all([
      new PgDurableEventLog(dbA).since(space,seq,500,claims('placement-a')),
      new PgDurableEventLog(dbB).since(space,seq,500,claims('placement-b')),
      new PgDurableEventLog(dbB).since(space,seq,500,claims('placement-out')),
    ]);
    const placements=(events: typeof a.items)=>events.flatMap(e=>e.type==='entity.upsert' && e.entity.id===moving.id ? [[e.entity.id,e.entity.parentId,e.entity.position]] : []);
    expect(placements(a.items).length).toBeGreaterThan(0); expect(placements(b.items)).toEqual(placements(a.items)); expect(out.items).toEqual([]);
    expect((await query(dbB,'placement-b')).page.items[0]!.id).toBe(moving.id);
  });

  it('rejects pre-move cursors, pages the new filtered order, and ignores activity for placement',async()=>{
    const filter={words:'Task'}; const first=await query(dbA,'placement-a',{filters:filter});
    const all=await query(dbA,'placement-a',{limit:100}); const moving=all.page.items.at(-1)!;
    await service.moveEntity(request(moving.id,{parentId:null,placement:{targetId:null,relation:'inside'},expectedVersion:moving.version,clientMutationId:randomUUID()}));
    await expect(query(dbB,'placement-b',{filters:filter,cursor:first.page.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
    const reloaded=await query(dbB,'placement-b',{filters:filter});
    const next=await query(dbB,'placement-b',{filters:filter,cursor:reloaded.page.nextCursor!});
    expect(new Set([...reloaded.page.items,...next.page.items].map(r=>r.id)).size).toBe(4);
    const before=await query(dbA,'placement-a',{limit:100});
    await database.query('update public.entities set activity_at=now()+interval \'1 day\',updated_at=now() where id=$1',[before.page.items.at(-1)!.id]);
    const after=await query(dbB,'placement-b',{limit:100});
    expect(after.page.items.map(r=>[r.id,r.parentId,r.position])).toEqual(before.page.items.map(r=>[r.id,r.parentId,r.position]));
  });

  it('the facade authorizes session placement while keeping runtime and lifecycle fields unchanged',async()=>{
    expect(capabilitiesOf({ kind: 'op_request', deleted_at: null } as never).canMove).toBe(false);
    await expect(dbA.tx(claims('placement-a'),q=>q.rpc('move_entity_relative',[memberA,null,'inside',1,null,randomUUID()])))
      .rejects.toThrow('command-owned');
    const before=(await database.query('select * from public.work_sessions where entity_id=$1',[sessions[0]]))[0];
    const moved=await service.moveEntity(request(sessions[0]!,{parentId:null,placement:{targetId:sessions[1],relation:'inside'},expectedVersion:1,clientMutationId:randomUUID()}));
    expect(moved.entity?.parentId).toBe(sessions[1]); expect(moved.entity?.capabilities?.canMove).toBe(true);
    expect((await database.query('select * from public.work_sessions where entity_id=$1',[sessions[0]]))[0]).toEqual(before);
    await expect(service.moveEntity(request(sessions[1]!,{parentId:null,placement:{targetId:sessions[0],relation:'inside'},expectedVersion:1,clientMutationId:randomUUID()}))).rejects.toMatchObject({code:'invariant_violation'});
  });
});
