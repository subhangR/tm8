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
import { loadMcpServer } from '../../src/mcp/definitions.js';
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
 credential=randomUUID();await db.rpc(auth,'create_mcp_credential',[credential,space,server,'Fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key']);
});
afterAll(async()=>{await db?.end();await scratch?.destroy();});
it('binds launcher authority independently of runtime identity, denies sibling tokens and unselected servers',async()=>{
 const r=await runtime(otherIdentity);
 const picks=await bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server,credentialId:credential}]});
 expect(picks).toEqual([{serverId:server,credentialId:credential}]);
 expect(await bindings.authorize(r.claims,r.sessionId,server)).toMatchObject({identityId:otherIdentity,launcherIdentityId:identity,credentialId:credential});
 await expect(bindings.authorize({...r.claims,authSessionId:randomUUID()},r.sessionId,server)).rejects.toBeTruthy();
 await expect(bindings.authorize(r.claims,r.sessionId,randomUUID())).rejects.toBeTruthy();
 await expect(bindings.authorize({...r.claims,identityId:identity},r.sessionId,server)).rejects.toBeTruthy();
});
it('task readers cannot bind another human private account and authentication has no fallback',async()=>{
 const r=await runtime(otherIdentity);
 await expect(bindings.bind({...auth,identityId:otherIdentity},{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server,credentialId:credential}]})).rejects.toBeTruthy();
 await expect(bindings.bind(auth,{sessionId:r.sessionId,spaceId:space,teamMemberId:teammate,agentToken:r.token,mcpSelections:[{serverId:server}]})).rejects.toBeTruthy();
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
 await db.rpc(auth,'create_mcp_credential',[selected,space,server,'Child fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key']);
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
 await db.rpc(auth,'create_mcp_credential',[selected,space,server,'Shared fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key']);
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
 expect(await bindings.bind(auth,input)).toEqual([{serverId:a.entity.id}]);
 expect(await bindings.bind(auth,{...input,mcpSelections:[]})).toEqual([]);
 expect(await bindings.bind(auth,{...input,mcpSelections:[{serverId:b.entity.id}]})).toEqual([{serverId:b.entity.id}]);
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
 expect(await bindings.bind(auth,input)).toEqual([{serverId:made.entity.id}]);
 const selected=randomUUID();
 await db.rpc(auth,'create_mcp_credential',[selected,space,server,'Chat private fixture',Buffer.alloc(32,7),Buffer.alloc(12,3),'api_key']);
 await bindings.bind(auth,{...input,resume:false,mcpSelections:[{serverId:server,credentialId:selected}]});
 await expect(bindings.bind({...auth,identityId:otherIdentity},input)).rejects.toBeTruthy();
 await bindings.bind(auth,{...input,resume:false,mcpSelections:[]});
 expect(await bindings.bind({...auth,identityId:otherIdentity},input)).toEqual([]);
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
