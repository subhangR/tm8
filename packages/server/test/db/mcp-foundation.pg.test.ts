import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { loadMcpServer, resolveMcpSelections } from '../../src/mcp/definitions.js';
import { W2EntitiesCommandsTrackingService } from '../../src/facade/services/w2/entities-commands-tracking.js';
import type { RequestContext } from '../../src/http/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
vi.setConfig({testTimeout:120000,hookTimeout:240000});
let scratch:W1ScratchDatabase;let db:Db;
const spaceId=randomUUID(), otherSpace=randomUUID(), owner=randomUUID(), member=randomUUID();
const ownerIdentity='mcp-owner-'+randomUUID(),memberIdentity='mcp-member-'+randomUUID();
const definition=(name='fixture')=>({name,transport:'http',url:'https://example.test/mcp',envKeys:[],headerKeys:[],auth:{type:'none'},approved:true});
const as=<T>(identityId:string,fn:(q:Querier)=>Promise<T>)=>db.tx({identityId,authKind:'browser',requestId:randomUUID()},fn);
async function create(name:string,extra:Record<string,unknown>={}) {return as(ownerIdentity,q=>q.rpc<{entity:{id:string;version:number}}>('create_mcp_server_entity',[spaceId,JSON.stringify({...definition(name),...extra}),null,randomUUID()]));}
beforeAll(async()=>{
 scratch=await createW1ScratchDatabase('mcp_foundation');scratch.apply(migrationFiles());db=createDb(scratch.url,{max:4});
 await scratch.transaction(async c=>{
  await c.query('set local role tm8_graph_owner');
  await c.query("insert into public.user_profiles(identity_id,display_name) values($1,'Owner'),($2,'Member')",[ownerIdentity,memberIdentity]);
  await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP',$3),($2,'Other',$3)",[spaceId,otherSpace,ownerIdentity]);
  await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$3,'member',$1),($2,$3,'member',$2)",[owner,member,spaceId]);
  await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$5,$3,'owner','Owner'),($2,$5,$4,'member','Member')",[owner,member,ownerIdentity,memberIdentity,spaceId]);
 });
});
afterAll(async()=>{await db?.end();await scratch?.destroy();});
it('round trips generic entity create/read/update and SQL content',async()=>{
 const deps={db,owner:async()=>({identityId:ownerIdentity,memberId:owner,spaceId}),config:{}} as unknown as FacadeDeps;
 const svc=new W2EntitiesCommandsTrackingService(deps);
 const ctx=(body:unknown,params:Record<string,string>={})=>({body,params,query:new URLSearchParams(),requestId:randomUUID(),headers:{},identity:{identityId:ownerIdentity,authKind:'browser'}} as unknown as RequestContext);
 await expect(svc.createEntity(ctx({spaceId,kind:'mcp_server',title:'wrapped',content:{definition:definition('wrapped'),env:{TOKEN:'fixture-secret'}},clientMutationId:randomUUID()}))).rejects.toBeTruthy();
 const created=await svc.createEntity(ctx({spaceId,kind:'mcp_server',title:'generic',content:{definition:definition('generic')},clientMutationId:randomUUID()}));
 const entity=(created as {entity:{id:string;version:number;state:{definition:unknown}}}).entity;
 expect(entity.state.definition).toEqual(definition('generic'));
 await expect(svc.patchEntity(ctx({expectedVersion:entity.version,content:{env:{TOKEN:'fixture-secret'}},clientMutationId:randomUUID()},{id:entity.id}))).rejects.toBeTruthy();
 const patched=await svc.patchEntity(ctx({expectedVersion:entity.version,content:{definition:{...definition('generic'),approved:false}},clientMutationId:randomUUID()},{id:entity.id}));
 expect((patched as {entity:{state:{definition:{approved:boolean}}}}).entity.state.definition.approved).toBe(false);
 const rows=await scratch.query<{content:{definition:{name:string}}}>('select internal.entity_content($1) as content',[entity.id]);
 expect(rows[0]!.content.definition.name).toBe('generic');
});
it('requires admin for create, update and generic delete; ordinary members can read',async()=>{
 const c=await create('policy');const id=c.entity.id;
 await expect(as(memberIdentity,q=>q.rpc('create_mcp_server_entity',[spaceId,JSON.stringify(definition('denied')),null,randomUUID()]))).rejects.toBeTruthy();
 await expect(as(memberIdentity,q=>q.rpc('update_mcp_server_entity',[id,c.entity.version,JSON.stringify(definition('policy')),null,randomUUID()]))).rejects.toBeTruthy();
 await expect(as(memberIdentity,q=>q.rpc('delete_entity',[id,null,randomUUID()]))).rejects.toBeTruthy();
 expect((await as(memberIdentity,q=>loadMcpServer(q,id))).allowed.manage).toBe(false);
});
it('SQL rejects secret maps, reserved/colliding names, unknown auth and transport mismatch',async()=>{
 for(const patch of [{name:null},{auth:{type:'api_key',headerName:null},headerKeys:['Authorization']},{env:{KEY:'fixture-secret'}},{headers:{Authorization:'fixture-secret'}},{name:'tm8'},{auth:{type:'none',secret:'fixture-secret'}},{command:'bash'},{headerKeys:['X-Key']},{url:'https://u:p@example.test/mcp'}]) {
  await expect(create('reject-'+randomUUID(),patch)).rejects.toBeTruthy();
 }
 await create('collision');await expect(create('COLLISION')).rejects.toBeTruthy();
});
it('equips defaults require approval and have no account fallback; [] disables',async()=>{
 const c=await create('default');const denied=await create('unapproved',{approved:false});
 const task=await as(ownerIdentity,q=>q.rpc<{entity:{id:string}}>('create_task',[spaceId,'MCP task']));
 await as(memberIdentity,q=>q.rpc('write_edge',[task.entity.id,c.entity.id,'equips','{}',null,randomUUID()]));
 await expect(as(memberIdentity,q=>q.rpc('write_edge',[task.entity.id,denied.entity.id,'equips','{}',null,randomUUID()]))).rejects.toBeTruthy();
 const result=await as(memberIdentity,q=>resolveMcpSelections(q,{spaceId,targetIds:[task.entity.id]}));
 expect(result.selections.map(s=>s.server.id)).toEqual([c.entity.id]);expect(result.ready).toBe(true);
 expect((await as(memberIdentity,q=>resolveMcpSelections(q,{spaceId,targetIds:[task.entity.id],mcpSelections:[]}))).selections).toEqual([]);
 const auth=await create('auth',{auth:{type:'api_key',headerName:'Authorization'},headerKeys:['Authorization']});
 const readiness=await as(memberIdentity,q=>resolveMcpSelections(q,{spaceId,mcpSelections:[{serverId:auth.entity.id}]}));
 expect(readiness.selections[0]?.reason).toBe('credential_required');
});
it('caches health only for the testing member and current definition version',async()=>{
 const c=await create('health');const result={ready:true,reason:'ready',tools:[],checkedAt:new Date().toISOString()};
 await as(ownerIdentity,q=>q.rpc('record_mcp_server_health',[c.entity.id,JSON.stringify(result)]));
 expect((await as(ownerIdentity,q=>loadMcpServer(q,c.entity.id))).health).toEqual(result);
 expect((await as(memberIdentity,q=>loadMcpServer(q,c.entity.id))).health).toBeUndefined();
 await as(ownerIdentity,q=>q.rpc('update_mcp_server_entity',[c.entity.id,c.entity.version,JSON.stringify({...definition('health'),approved:false}),null,randomUUID()]));
 expect((await as(ownerIdentity,q=>loadMcpServer(q,c.entity.id))).health).toBeUndefined();
});

it('inherits real ancestor equipment without duplicating the same server',async()=>{
 const c=await create('ancestor');
 const root=await as(ownerIdentity,q=>q.rpc<{entity:{id:string}}>('create_task',[spaceId,'Parent']));
 const child=await as(ownerIdentity,q=>q.rpc<{entity:{id:string}}>('create_task',[spaceId,'Child',null,'','{}',root.entity.id]));
 for(const id of [root.entity.id,child.entity.id])await as(memberIdentity,q=>q.rpc('write_edge',[id,c.entity.id,'equips','{}',null,randomUUID()]));
 const resolved=await as(memberIdentity,q=>resolveMcpSelections(q,{spaceId,targetIds:[child.entity.id]}));
 expect(resolved.selections.map(s=>s.server.id)).toEqual([c.entity.id]);
});
