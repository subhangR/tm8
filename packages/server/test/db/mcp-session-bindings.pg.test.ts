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
