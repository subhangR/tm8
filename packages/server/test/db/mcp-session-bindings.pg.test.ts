import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SpawnService } from '../../../execution/src/spawn/SpawnService.js';
import { PtyHostService } from '../../../execution/src/pty/PtyHostService.js';
import { FakeGraph } from '../../../execution/test/fake-graph.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerMcpRuntimeHandlers } from '../../src/mcp/handlers.js';
import { resolveBearerIdentity, issueAgentRuntimeSession } from '../../src/identity/pg-auth.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpCredentialStore } from '../../src/mcp/credential-store.js';
import { McpProxy } from '../../src/mcp/proxy.js';
import { loadMcpServer, resolveMcpSelections } from '../../src/mcp/definitions.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { McpSessionBindings } from '../../src/mcp/session-bindings.js';
import { hashToken } from '../../src/identity/crypto.js';
vi.setConfig({testTimeout:120000,hookTimeout:300000});
let scratch:W1ScratchDatabase, db:Db, bindings:McpSessionBindings;
const space=randomUUID(), member=randomUUID(), otherMember=randomUUID(), teammate=randomUUID();
const account=randomUUID(), otherAccount=randomUUID(), identity='mcp-launcher-'+randomUUID(), otherIdentity='mcp-runtime-'+randomUUID();
const auth:DbClaims={identityId:identity,authKind:'browser',sessionSpaceId:space};
let server:string, credential:string;
const definition={name:'bindingfixture',transport:'http',url:'https://example.test/mcp',envKeys:[],headerKeys:['Authorization'],auth:{type:'api_key',headerName:'Authorization'},approved:true};
async function runtime(runtimeIdentity=identity) {
 const sessionId=randomUUID(), authSessionId=randomUUID(), secret=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 await scratch.transaction(async c=>{
  await c.query('set local role tm8_graph_owner');
  await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'work_session',$3)",[sessionId,space,member]);
  await c.query("insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'MCP fixture','spawning','space')",[sessionId]);
  await c.query("insert into public.auth_sessions(id,account_id,kind,acting_as_team_member_id,work_session_id,token_hash,expires_at,space_id) values($1,$2,'agent',$3,$4,$5,now()+interval '1 hour',$6)",[authSessionId,runtimeIdentity===identity?account:otherAccount,teammate,sessionId,hashToken(secret),space]);
 });
 return {sessionId,authSessionId,token:`tm8s_${authSessionId}.${secret}`,claims:{identityId:runtimeIdentity,authKind:'agent',sessionSpaceId:space,authSessionId}};
}
beforeAll(async()=>{
 scratch=await createW1ScratchDatabase('mcp_bindings');scratch.apply(migrationFiles());db=createDb(scratch.url,{max:4});bindings=new McpSessionBindings(db);
 await scratch.transaction(async c=>{
  await c.query('set local role tm8_graph_owner');
  await c.query("insert into public.accounts(id,identity_id,username) values($1,$2,'mcp-launcher'),($3,$4,'mcp-runtime')",[account,identity,otherAccount,otherIdentity]);
  await c.query("insert into public.user_profiles(identity_id,display_name) values($1,'Launcher'),($2,'Runtime')",[identity,otherIdentity]);
  await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP',$2)",[space,identity]);
  await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$4,'member',$1),($2,$4,'member',$1),($3,$4,'team_member',$1)",[member,otherMember,teammate,space]);
  await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$3,$4,'owner','Launcher'),($2,$3,$5,'member','Runtime')",[member,otherMember,space,identity,otherIdentity]);
  await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,model,agent_tool) values($1,$2,'MCP worker','helper','claude-sonnet-4-5','claude-code')",[teammate,member]);
 });
 const made=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify(definition),null,randomUUID()]);server=made.entity.id;
 credential=randomUUID();await db.rpc(auth,'create_mcp_credential',[credential,space,server,'Fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key',null,false,1]);
});
afterAll(async()=>{await db?.end();await scratch?.destroy();});
it('binds launcher authority independently of runtime identity, denies sibling tokens and unselected servers',async()=>{
 const r=await runtime(otherIdentity);
 const picks=await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server,credentialId:credential}]});
 expect(picks).toEqual([{serverId:server,credentialId:credential,serverKey:'bindingfixture'}]);
 expect(await bindings.authorize(r.claims,r.sessionId,server)).toMatchObject({identityId:otherIdentity,launcherIdentityId:identity,credentialId:credential});
 await expect(bindings.authorize({...r.claims,authSessionId:randomUUID()},r.sessionId,server)).rejects.toBeTruthy();
 await expect(bindings.authorize(r.claims,r.sessionId,randomUUID())).rejects.toBeTruthy();
 await expect(bindings.authorize({...r.claims,identityId:identity},r.sessionId,server)).rejects.toBeTruthy();
});
it('task readers cannot bind another human private account, nor reach one through an unpinned selection',async()=>{
 const r=await runtime(otherIdentity);
 await expect(bindings.bind({...auth,identityId:otherIdentity},{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server,credentialId:credential}]})).rejects.toBeTruthy();
 // The §3 resolution 341 adds searches the ROOT's own rows and the Space's
 // PUBLIC ones. The fixture credential is another human's PRIVATE row, so an
 // unpinned selection under that other human must still find nothing: the
 // fallback must never widen who can reach a private account.
 await expect(bindings.bind({...auth,identityId:otherIdentity},{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server}]})).rejects.toBeTruthy();
});
it('resolves the root member own connection for an unpinned selection (§3, G15)',async()=>{
 const r=await runtime(otherIdentity);
 // Was `credential_required` and a failed launch before 341: the launcher owns
 // the connection, so an unpinned selection now resolves to exactly that row.
 const picks=await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server}]});
 expect(picks).toEqual([{serverId:server,credentialId:credential,serverKey:'bindingfixture'}]);
 // And the binding holds that exact row, so the live session re-checks it
 // rather than re-picking.
 expect(await bindings.authorize(r.claims,r.sessionId,server)).toMatchObject({credentialId:credential});
});
it('a refused credential leaves a usable transaction, so the launch says why (finding 3)',async()=>{
 // `Querier.rpc` is a bare client.query with no savepoint, so a raised
 // read_mcp_credential aborts the whole bind transaction. While readiness was
 // decided by catching that throw in TypeScript, the resolver's NEXT statement
 // (loadMcpServer for the following selection) died with 25P02 and the launch
 // reported an opaque 'internal database error' instead of naming the problem.
 // Deciding openability in plpgsql instead keeps the refusal inside an implicit
 // savepoint. Two selections, the first unopenable, is the minimal reproduction.
 const second=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name:'bindingsecond'}),null,randomUUID()]);
 const r=await runtime(otherIdentity);
 await expect(bindings.bind({...auth,identityId:otherIdentity},{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,
  mcpSelections:[{serverId:server,credentialId:credential},{serverId:second.entity.id}]}))
  .rejects.toThrow(/MCP launch unavailable/);
});
it('a delegated launch with no live launcher binding drops defaults instead of refusing (finding 4)',async()=>{
 // An auth-none connector with defaultOn makes the resolved default set
 // non-empty for EVERY launch in the space. Before this, that turned a rare
 // refusal into one that killed every delegated launch: asking for NO
 // connectors must never refuse the spawn itself.
 const open=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,
  JSON.stringify({name:'bindingdefault',transport:'http',url:'https://example.test/open',envKeys:[],headerKeys:[],auth:{type:'none'},approved:true,defaultOn:true}),null,randomUUID()]);
 // Sanity: it really is in the default set for a normal launcher.
 const normal=await runtime();
 expect(await bindings.bind(auth,{sessionId:normal.sessionId,spaceId:space,teamMemberId:teammate,agentToken:normal.token}))
  .toEqual([{serverId:open.entity.id,serverKey:'bindingdefault'}]);
 // An agent caller with no verified mcpSource is `sourceUnavailable`.
 const r=await runtime(otherIdentity);
 expect(await bindings.bind(r.claims,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token})).toEqual([]);
 // The binding exists and grants nothing, so authorize refuses the connector.
 await expect(bindings.authorize(r.claims,r.sessionId,open.entity.id)).rejects.toBeTruthy();
 // An EXPLICIT selection is still refused: only defaults are dropped.
 const explicit=await runtime(otherIdentity);
 await expect(bindings.bind(explicit.claims,{sessionId:explicit.sessionId,spaceId:space,teamMemberId:teammate,agentToken:explicit.token,
  mcpSelections:[{serverId:open.entity.id}]})).rejects.toThrow(/live launcher binding/);
 // And an explicit [] is not an ask, so it is allowed.
 const none=await runtime(otherIdentity);
 expect(await bindings.bind(none.claims,{sessionId:none.sessionId,spaceId:space,teamMemberId:teammate,agentToken:none.token,mcpSelections:[]})).toEqual([]);
 // A `defaultOn` connector is space-wide by design, so it belongs to EVERY
 // launch's default set in this space. Retire it, or it silently joins the
 // expected sets of the sibling tests below.
 await db.rpc(auth,'delete_entity',[open.entity.id,null,randomUUID()]);
});
it('the loop-executor claim shape is lent no connection, for all three sources (B17/B19)',async()=>{
 /*
  * THE SHAPE, verbatim from `createLoopExecutorPort`: the node's loopback
  * owner, `requestId: 'loop-executor'`, and NO `authKind` at all. It is neither
  * a human bearer (browser/cli) nor an agent bearer with a live launcher
  * binding, so §6.1 gives it no root — and `identity` here is the Space OWNER,
  * who owns the fixture credential. That is the whole danger: 341's tier 1 is
  * "the root's own connection", resolved under the claims in force, so before
  * B19 any member's schedule resolved the NODE OWNER's own PRIVATE account.
  */
 const loopExecutor:DbClaims={identityId:identity,nodeAdmin:true,requestId:'loop-executor'};
 const make=(name:string,extra:Record<string,unknown>={})=>db.rpc<{entity:{id:string}}>(auth,
  'create_mcp_server_entity',[space,JSON.stringify({...definition,name,...extra}),null,randomUUID()]);
 // Three connectors, one per source, plus the auth-none control.
 const byDefaultOn=await make('loopdefaulton',{defaultOn:true});
 const byEquips=await make('loopequips');
 const explicit=await make('loopexplicit');
 const openOne=await make('loopopen',{auth:{type:'none'},headerKeys:[],defaultOn:true});
 try {
  const task=await db.rpc<{entity:{id:string}}>(auth,'create_task',[space,'Loop provenance fixture']);
  await db.rpc(auth,'write_edge',[task.entity.id,byEquips.entity.id,'equips','{}',null,randomUUID()]);
  // Each of the three needs an account the OWNER owns, or "no account" and "no
  // provenance" would be indistinguishable. Labels are unique per Space.
  for(const made of [byDefaultOn,byEquips,explicit]) {
   await db.rpc(auth,'create_mcp_credential',[randomUUID(),space,made.entity.id,`Loop fixture ${made.entity.id}`,
    Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key',null,false,1]);
  }
  const defaults={spaceId:space,teamMemberId:teammate,targetIds:[task.entity.id]};
  // CONTROL. A human bearer in this Space gets all four: the two auth
  // connectors resolve the owner's accounts through §3, so what follows is
  // about provenance and not about the connectors being unusable.
  const human=await runtime();
  const asHuman=await bindings.bind(auth,{...defaults,sessionId:human.sessionId,agentToken:human.token});
  expect(asHuman.map(s=>s.serverId).sort()).toEqual([byDefaultOn.entity.id,byEquips.entity.id,openOne.entity.id].sort());
  expect(asHuman.filter(s=>s.credentialId).map(s=>s.serverId).sort())
   .toEqual([byDefaultOn.entity.id,byEquips.entity.id].sort());

  // 1 + 2. The `defaultOn` default and the `equips` default are SKIPPED, not
  // refused: a schedule firing must still launch. Only the auth-none connector
  // survives, which is also assertion 4.
  const fired=await runtime();
  expect(await bindings.bind(loopExecutor,{...defaults,sessionId:fired.sessionId,agentToken:fired.token}))
   .toEqual([{serverId:openOne.entity.id,serverKey:'loopopen'}]);
  // The binding holds exactly that, so no later call can reach the others.
  expect(await bindings.authorize(fired.claims,fired.sessionId,openOne.entity.id)).toMatchObject({serverId:openOne.entity.id});
  for(const made of [byDefaultOn,byEquips,explicit]) {
   await expect(bindings.authorize(fired.claims,fired.sessionId,made.entity.id)).rejects.toBeTruthy();
  }
  // And the skip says WHY, where §7.3's launch record and the UI read it.
  const reported=await db.tx(loopExecutor,q=>resolveMcpSelections(q,{spaceId:space,teamMemberId:teammate,targetIds:[task.entity.id]},{noHumanRoot:true}));
  expect(reported.skipped?.map(skip=>[skip.name,skip.reason]).sort()).toEqual(
   [['loopdefaulton','no_human_provenance'],['loopequips','no_human_provenance']]);

  // 3. An EXPLICIT selection naming an auth connector is refused OUT LOUD
  // (B9's rule: a default is skipped, a named pick is an error), and the
  // sentence names the real cause rather than "not connected".
  const named=await runtime();
  await expect(bindings.bind(loopExecutor,{...defaults,sessionId:named.sessionId,agentToken:named.token,
   mcpSelections:[{serverId:explicit.entity.id}]})).rejects.toThrow(/MCP delegated launch requires a human root/);
  // A PIN is refused too: the pin is this caller's own assertion, and the point
  // is that this caller cannot vouch for a human at all.
  const credentials=await db.rpc<Array<{id:string}>>(auth,'list_mcp_credentials',[explicit.entity.id,null]);
  expect(credentials).toHaveLength(1);
  await expect(bindings.bind(loopExecutor,{...defaults,sessionId:named.sessionId,agentToken:named.token,
   mcpSelections:[{serverId:explicit.entity.id,credentialId:credentials[0]!.id}]}))
   .rejects.toThrow(/MCP delegated launch requires a human root/);
  // 4. An explicitly named auth-NONE connector still binds: the rule withholds
  // connections, not connectors.
  expect(await bindings.bind(loopExecutor,{...defaults,sessionId:named.sessionId,agentToken:named.token,
   mcpSelections:[{serverId:openOne.entity.id}]})).toEqual([{serverId:openOne.entity.id,serverKey:'loopopen'}]);

  // A BINDING WRITTEN BEFORE #1316 must not keep working. Reproduce one
  // exactly: 343 records a root, and a row from before it has none, so the only
  // thing left to judge it by is the launcher kind it stored — which for the
  // rootless shapes is ''. Clearing the root columns as well as the kind is what
  // makes this a pre-343 row rather than a 343 row with a damaged kind.
  const legacy=await runtime();
  await bindings.bind(auth,{...defaults,sessionId:legacy.sessionId,agentToken:legacy.token,
   mcpSelections:[{serverId:byDefaultOn.entity.id}]});
  await bindings.authorize(legacy.claims,legacy.sessionId,byDefaultOn.entity.id);
  await scratch.query(`update internal.mcp_session_bindings
    set launcher_auth_kind='', root_member_id=null, root_identity_id=null, chain=null, chain_space_ids=null
    where session_id=$1`,[legacy.sessionId]);
  await expect(bindings.authorize(legacy.claims,legacy.sessionId,byDefaultOn.entity.id))
   .rejects.toThrow(/MCP connector access has changed/);
  // And the mirror: a 343 row whose RECORDED ROOT is intact is judged by that
  // root, not by a launcher kind — so clearing only the kind changes nothing.
  // Without this cell the line above would pass for the wrong reason.
  const kept=await runtime();
  await bindings.bind(auth,{...defaults,sessionId:kept.sessionId,agentToken:kept.token,
   mcpSelections:[{serverId:byDefaultOn.entity.id}]});
  await scratch.query("update internal.mcp_session_bindings set launcher_auth_kind='' where session_id=$1",[kept.sessionId]);
  expect(await bindings.authorize(kept.claims,kept.sessionId,byDefaultOn.entity.id))
   .toMatchObject({serverId:byDefaultOn.entity.id,rootIdentityId:identity});
 } finally {
  // `defaultOn` is space-wide, so these would silently join every sibling
  // test's expected default set.
  for(const made of [byDefaultOn,openOne]) await db.rpc(auth,'delete_entity',[made.entity.id,null,randomUUID()]);
 }
});
it('explicit [] persists across resume and cannot grant a connector',async()=>{
 const r=await runtime();
 expect(await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[]})).toEqual([]);
 expect(await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,resume:true,mcpSelections:[{serverId:server,credentialId:credential}]})).toEqual([]);
 await expect(bindings.authorize(r.claims,r.sessionId,server)).rejects.toBeTruthy();
});
it('revocation blocks an already bound session and its resume',async()=>{
 const r=await runtime();
 await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server,credentialId:credential}]});
 await scratch.query("update public.space_credentials set status='revoked',secret_ciphertext=null,secret_nonce=null where id=$1",[credential]);
 await expect(bindings.authorize(r.claims,r.sessionId,server)).rejects.toBeTruthy();
 await expect(bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,resume:true})).rejects.toBeTruthy();
});
it('generic database writers have no table grant',async()=>{
 await expect(db.query(auth,'select * from internal.mcp_session_bindings')).rejects.toBeTruthy();
 await expect(db.query(auth,'select * from internal.mcp_launch_selections')).rejects.toBeTruthy();
});

it('delegation derives the human from the live parent binding and reauthorizes current credentials',async()=>{
 const selected=randomUUID();
 await db.rpc(auth,'create_mcp_credential',[selected,space,server,'Child fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key',null,false,1]);
 const parent=await runtime(otherIdentity),child=await runtime(otherIdentity);
 await bindings.bind(auth,{sessionId:parent.sessionId,spaceId:space,teamMemberId:teammate,agentToken:parent.token,mcpSelections:[]});
 const source={...parent.claims,mcpSource:{sessionId:parent.sessionId,authSessionId:parent.authSessionId}};
 await bindings.bind(source,{sessionId:child.sessionId,spaceId:space,teamMemberId:teammate,agentToken:child.token,mcpSelections:[{serverId:server,credentialId:selected}]});
 expect(await bindings.authorize(child.claims,child.sessionId,server)).toMatchObject({launcherIdentityId:identity,identityId:otherIdentity});
 await expect(bindings.bind(child.claims,{sessionId:child.sessionId,spaceId:space,teamMemberId:teammate,agentToken:child.token,mcpSelections:[{serverId:server,credentialId:selected}]})).rejects.toBeTruthy();
 await scratch.query('update public.auth_sessions set revoked_at=now() where id=$1',[parent.authSessionId]);
 await expect(bindings.bind(source,{sessionId:child.sessionId,spaceId:space,teamMemberId:teammate,agentToken:child.token,resume:true})).rejects.toBeTruthy();
});
it('withdrawn sharing denies an already running grantee session',async()=>{
 const selected=randomUUID();
 await db.rpc(auth,'create_mcp_credential',[selected,space,server,'Shared fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key',null,false,1]);
 await db.rpc(auth,'share_space_credential',[selected,otherAccount]);
 const r=await runtime(otherIdentity);
 await bindings.bind({...auth,identityId:otherIdentity},{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server,credentialId:selected}]});
 await bindings.authorize(r.claims,r.sessionId,server);
 await db.rpc(auth,'unshare_space_credential',[selected,otherAccount]);
 await expect(bindings.authorize(r.claims,r.sessionId,server)).rejects.toBeTruthy();
});
it('performs a real MCP tool call with a sealed selected credential, then denies a dead session',async()=>{
 const requests:string[]=[];
 const upstream=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=String(chunk);
  const message=JSON.parse(body);requests.push(message.method);
  expect(req.headers.authorization).toBe('Bearer synthetic-bound-secret');
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='tools/call'?{content:[{type:'text',text:'fixture tool ran'}]}:{tools:[{name:'fixture',inputSchema:{type:'object'}}]}}));
 });
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(join(tmpdir(),'mcp-bind-sealed-'));
 try {
  const url=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
  const made=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name:'boundHttp',url,allowPrivateNetwork:true}),null,randomUUID()]);
  const store=new McpCredentialStore(db,dir);
  const created=await store.create(auth,{spaceId:space,serverId:made.entity.id,label:'Sealed fixture',secret:{kind:'api_key',value:'synthetic-bound-secret'}}) as {id:string};
  const r=await runtime(otherIdentity);
  await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:made.entity.id,credentialId:created.id}]});
  const proxy=new McpProxy({credentials:store,authorize:(claims,id,serverId)=>bindings.authorize(claims,id,serverId),definition:async(claims,id)=>{
   const view=await db.tx(claims,q=>loadMcpServer(q,id));return {id:view.id,spaceId:view.spaceId,...view.definition};
  }});
  expect(await proxy.request(r.claims,r.sessionId,made.entity.id,'tools/call',{name:'fixture',arguments:{}})).toEqual({content:[{type:'text',text:'fixture tool ran'}]});
  expect(requests).toEqual(['initialize','notifications/initialized','tools/call']);
  await scratch.transaction(async c=>{await c.query("select set_config('tm8.work_session_transition','on',true)");await c.query("update public.work_sessions set status='exited' where entity_id=$1",[r.sessionId]);});
  await expect(proxy.request(r.claims,r.sessionId,made.entity.id,'tools/call',{name:'fixture',arguments:{}})).rejects.toBeTruthy();
  expect(requests).toHaveLength(3);

  // Exercise the complete child bridge -> authenticated facade -> durable
  // authorization -> sealed opener -> upstream path through an actual PTY.
  const running=await runtime(otherIdentity);
  const registry=new HandlerRegistry();
  registerMcpRuntimeHandlers(registry,{db,owner:async()=>({identityId:identity,memberId:member,spaceId:space})} as unknown as FacadeDeps,{
   dataDir:dir,callbackUrl:'http://127.0.0.1/callback',
   definition:(claims,id)=>db.tx(claims,q=>loadMcpServer(q,id)),
   authorize:(claims,id,serverId)=>bindings.authorize(claims,id,serverId),
  });
  const gateway=createServer(async(req,res)=>{
   try {
    let body='';for await(const chunk of req)body+=String(chunk);
    const input=JSON.parse(body),bearer=String(req.headers.authorization).replace(/^Bearer /,'');
    const resolved=await resolveBearerIdentity(db,bearer);
    const ctx={body:input,params:{sessionId:input.sessionId,serverId:input.serverId},query:new URLSearchParams(),requestId:randomUUID(),
     identity:{kind:'bearer',identityId:resolved.identityId,authKind:resolved.kind,sessionId:resolved.sessionId,workSessionId:resolved.workSessionId,sessionSpaceId:resolved.spaceId},headers:{}} as unknown as RequestContext;
    const result=await registry.get('mcp.proxy.request')!(ctx);res.setHeader('content-type','application/json');res.end(JSON.stringify({result}));
   } catch(error) {res.statusCode=403;res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  const pty=new PtyHostService();
  try {
   const cli=fileURLToPath(new URL('../../../mcp/dist/cli.js',import.meta.url));
   const provider=join(dir,'provider.mjs');
   await writeFile(provider,String.raw`import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const child=spawn(process.execPath,[${JSON.stringify(cli)},'--connector',${JSON.stringify(made.entity.id)}],{env:process.env,stdio:['pipe','pipe','inherit']});
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{const m=JSON.parse(line);if(m.id===1){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'fixture',arguments:{}}})+'\n');}if(m.id===2)console.log('BOUND_CHILD_RESULT:'+JSON.stringify(m));});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');
setInterval(()=>{},1000);`);
   const graph=new FakeGraph({workingDir:dir,sessionId:running.sessionId});
   graph.issueWorkSessionAgentToken=async()=>running.token;
   const service=new SpawnService({graph,pty,dataDir:dir,baseUrl:`http://127.0.0.1:${(gateway.address() as {port:number}).port}`,
    env:{...process.env,TM8_AGENT_CMD:`${process.execPath} ${provider}`},trustWatchdogMs:0,
    mcpBindings:{bind:(claims,input)=>bindings.bind(claims as DbClaims,input)}});
   await service.spawn(auth,{spaceId:space,teamMemberId:teammate,mcpSelections:[{serverId:made.entity.id,credentialId:created.id}]});
   let output='';const deadline=Date.now()+15000;
   while(Date.now()<deadline){output=pty.getReplay(running.sessionId,0)?.data.toString('utf8')??'';if(output.includes('BOUND_CHILD_RESULT:'))break;await new Promise(resolve=>setTimeout(resolve,25));}
   expect(output).toContain('fixture tool ran');
   expect(output).not.toContain('synthetic-bound-secret');
   expect(requests).toEqual(['initialize','notifications/initialized','tools/call','initialize','notifications/initialized','tools/call']);
  } finally {pty.shutdownAll();await new Promise<void>(resolve=>gateway.close(()=>resolve()));}
 } finally {await new Promise<void>(resolve=>upstream.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
it('omitted selections resolve attached defaults, [] disables, and a nonempty list replaces defaults',async()=>{
 const make=async(name:string)=>db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name,auth:{type:'none'},headerKeys:[]}),null,randomUUID()]);
 const a=await make('defaultOne'),b=await make('explicitReplacement');
 const task=await db.rpc<{entity:{id:string}}>(auth,'create_task',[space,'Default MCP fixture']);
 await db.rpc(auth,'write_edge',[task.entity.id,a.entity.id,'equips','{}',null,randomUUID()]);
 const r=await runtime();
 const input={sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,targetIds:[task.entity.id],agentToken:r.token};
 expect(await bindings.bind(auth,input)).toEqual([{serverId:a.entity.id,serverKey:'defaultone'}]);
 expect(await bindings.bind(auth,{...input,mcpSelections:[]})).toEqual([]);
 expect(await bindings.bind(auth,{...input,mcpSelections:[{serverId:b.entity.id}]})).toEqual([{serverId:b.entity.id,serverKey:'explicitreplacement'}]);
 await expect(bindings.authorize(r.claims,r.sessionId,a.entity.id)).rejects.toBeTruthy();
});

it('chat about-task defaults honor omission and a new sender cannot inherit the creator account',async()=>{
 const made=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name:'chatDefault',auth:{type:'none'},headerKeys:[]}),null,randomUUID()]);
 const task=await db.rpc<{entity:{id:string}}>(auth,'create_task',[space,'Chat default task']);
 await db.rpc(auth,'write_edge',[task.entity.id,made.entity.id,'equips','{}',null,randomUUID()]);
 const chatId=randomUUID();
 await db.rpc(auth,'start_chat',[chatId,space,teammate,'claude-sonnet-4-5','anthropic','claude-code','ask','scratch',null,randomUUID(),'/tmp/mcp-chat-fixture','MCP chat','Hello',[],task.entity.id,randomUUID()]);
 const minted=await issueAgentRuntimeSession(db,auth,{chatId,teamMemberId:teammate});
 const input={sessionId:chatId,spaceId:space,teamMemberId:teammate,agentToken:minted.token,resume:true};
 expect(await bindings.bind(auth,input)).toEqual([{serverId:made.entity.id,serverKey:'chatdefault'}]);
 const selected=randomUUID();
 await db.rpc(auth,'create_mcp_credential',[selected,space,server,'Chat private fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key',null,false,1]);
 await db.rpc(auth,'update_chat_mcp_selections',[chatId,JSON.stringify([{serverId:server,credentialId:selected}])]);
 await bindings.bind(auth,{...input,resume:false,mcpSelections:[{serverId:server,credentialId:selected}]});
 await expect(bindings.bind({...auth,identityId:otherIdentity},input)).rejects.toBeTruthy();
 await db.rpc(auth,'update_chat_mcp_selections',[chatId,'[]']);
 await bindings.bind(auth,{...input,resume:false,mcpSelections:[]});
 expect(await bindings.bind({...auth,identityId:otherIdentity},input)).toEqual([]);
});

it('Craft and chat context defaults reach the runtime while account ownership and deselection remain enforced',async()=>{
 const made=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name:'craftDefault',auth:{type:'none'},headerKeys:[]}),null,randomUUID()]);
 const privateMade=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name:'craftPrivate'}),null,randomUUID()]);
 const privateCredential=randomUUID();
 await db.rpc(auth,'create_mcp_credential',[privateCredential,space,privateMade.entity.id,'Craft private account',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key',null,false,1]);
 const craft=await db.rpc<{entity:{id:string}}>(auth,'create_craft_entity',[space,'MCP Craft defaults',null,'Disposable context fixture',null,null,randomUUID()]);
 const skill=await db.rpc<{entity:{id:string}}>(auth,'create_skill_entity',[space,'Equipment isolation fixture',null,'','',null,null,randomUUID()]);
 await expect(db.rpc(auth,'write_edge',[craft.entity.id,skill.entity.id,'equips','{}',null,randomUUID()])).rejects.toBeTruthy();
 await expect(db.rpc(auth,'write_edge',[craft.entity.id,made.entity.id,'equips',JSON.stringify({credentialId:privateCredential}),null,randomUUID()])).rejects.toBeTruthy();
 await db.rpc(auth,'write_edge',[craft.entity.id,made.entity.id,'equips','{}',null,randomUUID()]);
 await db.rpc(auth,'write_edge',[craft.entity.id,privateMade.entity.id,'equips','{}',null,randomUUID()]);
 const chatId=randomUUID();
 await db.rpc(auth,'start_chat',[chatId,space,teammate,'claude-sonnet-4-5','anthropic','claude-code','craft','scratch',null,randomUUID(),'/tmp/mcp-chat-fixture','MCP Craft chat','Read selected sources',[],craft.entity.id,randomUUID()]);
 const minted=await issueAgentRuntimeSession(db,auth,{chatId,teamMemberId:teammate});
 const input={sessionId:chatId,spaceId:space,teamMemberId:teammate,agentToken:minted.token,resume:true};
 expect(await bindings.bind(auth,input)).toEqual(expect.arrayContaining([{serverId:made.entity.id,serverKey:'craftdefault'},{serverId:privateMade.entity.id,credentialId:privateCredential,serverKey:'craftprivate'}]));
 const other=await bindings.effectiveChatSelection({...auth,identityId:otherIdentity},{chatId,spaceId:space,teamMemberId:teammate});
 expect(other).toEqual([{serverId:made.entity.id}]);
 await db.rpc(auth,'write_edge',[chatId,made.entity.id,'equips','{}',null,randomUUID()]);
 expect(await bindings.effectiveChatSelection(auth,{chatId,spaceId:space,teamMemberId:teammate})).toHaveLength(2);
 await db.rpc(auth,'update_chat_mcp_selections',[chatId,'[]']);
 expect(await bindings.bind(auth,input)).toEqual([]);
 await expect(bindings.authorize({identityId:identity,authKind:'agent_runtime',authSessionId:minted.sessionId,sessionSpaceId:space},chatId,made.entity.id)).rejects.toBeTruthy();
});

it('work sessions inherit their actual about-entity defaults even when the spawner supplies task targets',async()=>{
 const made=await db.rpc<{entity:{id:string}}>(auth,'create_mcp_server_entity',[space,JSON.stringify({...definition,name:'sessionContext',auth:{type:'none'},headerKeys:[]}),null,randomUUID()]);
 const craft=await db.rpc<{entity:{id:string}}>(auth,'create_craft_entity',[space,'Session context defaults',null,'',null,null,randomUUID()]);
 await db.rpc(auth,'write_edge',[craft.entity.id,made.entity.id,'equips','{}',null,randomUUID()]);
 const r=await runtime();
 await db.rpc(auth,'write_edge',[r.sessionId,craft.entity.id,'about','{}',null,randomUUID()]);
 const picked=await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,targetIds:[]});
 expect(picked).toEqual(expect.arrayContaining([{serverId:made.entity.id,serverKey:'sessioncontext'}]));
});

it('a session started through a space link launches with no MCP servers; naming one is refused, and nothing is bound',async()=>{
 // W9c found every link spawn (local and remote) refused here before the
 // spawn itself: the link-bound launcher now gets [] instead.
 const r=await runtime();
 const linkAuth:DbClaims={...auth,authKind:'link',viaLinkId:randomUUID()};
 await expect(bindings.bind(linkAuth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token})).resolves.toEqual([]);
 await expect(bindings.bind(linkAuth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server}]}))
  .rejects.toThrow(/space link/);
 await expect(bindings.authorize({...linkAuth,authSessionId:r.authSessionId},r.sessionId,server)).rejects.toThrow();
});

/**
 * §4.2. `bind` answers the launcher with the tool prefix the model will read,
 * and it is DERIVED, not stored: the durable binding keeps the bare
 * `{serverId, credentialId}` pair that `read_mcp_launch_selections` and
 * `authorize` parse with the strict `McpSelectionsSchema`. That is what lets a
 * rename change the prefix at the next launch instead of leaving a dead name
 * behind in a resumed session — and it is why adding the key to the stored JSON
 * would break resume outright.
 */
it('answers the readable server key but stores only the selection pair (§4.2)', async () => {
  const renamed = await db.rpc<{ entity: { id: string; version: number } }>(auth, 'create_mcp_server_entity',
    [space, JSON.stringify({ ...definition, name: 'Key-Fixture', auth: { type: 'none' }, headerKeys: [] }), null, randomUUID()]);
  const r = await runtime();
  const input = { sessionId: r.sessionId, spaceId: space, teamMemberId: teammate, agentToken: r.token };
  expect(await bindings.bind(auth, { ...input, mcpSelections: [{ serverId: renamed.entity.id }] }))
    .toEqual([{ serverId: renamed.entity.id, serverKey: 'key_fixture' }]);

  // The stored binding is the bare pair; the strict schema would reject a key.
  const stored = await db.rpc<unknown>(auth, 'read_mcp_launch_selections', [r.sessionId]);
  expect(stored).toEqual([{ serverId: renamed.entity.id }]);

  // Rename the connector: the next launch names it by its NEW key, and resume
  // (which re-reads the stored pair) does too.
  await db.rpc(auth, 'update_mcp_server_entity', [renamed.entity.id, renamed.entity.version,
    JSON.stringify({ ...definition, name: 'Gmail', auth: { type: 'none' }, headerKeys: [] }), null, randomUUID()]);
  expect(await bindings.bind(auth, { ...input, resume: true }))
    .toEqual([{ serverId: renamed.entity.id, serverKey: 'gmail' }]);
});
