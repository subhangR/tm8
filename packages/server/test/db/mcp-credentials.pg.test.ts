import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { McpCredentialStore } from '../../src/mcp/credential-store.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
vi.setConfig({testTimeout:60000,hookTimeout:300000});
let database:W1ScratchDatabase;let db:Db;let dir:string;let store:McpCredentialStore;let common:DbSpaceCredentialStore;
const space=randomUUID(),server=randomUUID(),otherServer=randomUUID(),ownerMember=randomUUID(),peerMember=randomUUID();
const auth=(identityId='mcp-owner',authKind='browser'):DbClaims=>({identityId,authKind,sessionSpaceId:space});
beforeAll(async()=>{
 database=await createW1ScratchDatabase('mcp_credentials');database.apply(migrationFiles());db=createDb(database.url);dir=await mkdtemp(join(tmpdir(),'mcp-crypto-'));store=new McpCredentialStore(db,dir);common=new DbSpaceCredentialStore({db,dataDir:dir});
 await database.transaction(async c=>{
  await c.query('set local role tm8_graph_owner');
  for(const identity of ['mcp-owner','mcp-peer']){await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)',[identity]);await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)',[identity]);}
  await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP fixture','mcp-owner')",[space]);
  for(const [id,identity,role] of [[ownerMember,'mcp-owner','owner'],[peerMember,'mcp-peer','member']]){
   await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)",[id,space]);await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)',[id,space,identity,role]);
  }
  await c.query("select set_config('tm8.identity_id','mcp-owner',true),set_config('tm8.auth_kind','browser',true)");
  // Definition registration uses the actual core kind and its approved metadata.
  for(const id of [server,otherServer]){
   await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'mcp_server',0,$3)",[id,space,ownerMember]);
   await c.query('insert into public.mcp_servers(entity_id,space_id,title,definition) values($1,$2,$3,$4)',[id,space,'Fixture',JSON.stringify({name:'fixture_'+id,transport:'http',url:'https://example.test/mcp',envKeys:[],headerKeys:['Authorization'],auth:{type:'api_key',headerName:'Authorization'},approved:true})]);
  }
 });
});
afterAll(async()=>{await db?.end();await database?.destroy();if(dir)await rm(dir,{recursive:true,force:true});});
it('seals private by default; shares explicitly; rejects wrong binding; revocation preserves definition',async()=>{
 const created=await store.create(auth(),{spaceId:space,serverId:server,label:'Fixture account',secret:{kind:'api_key',value:'sealed-secret-canary'}}) as {id:string;visibility:string};
 expect(created.visibility).toBe('private');expect(JSON.stringify(created)).not.toContain('sealed-secret-canary');
 const binding={spaceId:space,serverId:server,credentialId:created.id};
 expect((await store.read(auth(),binding)).secret).toEqual({kind:'api_key',value:'sealed-secret-canary'});
 await expect(store.read(auth('mcp-peer'),binding)).rejects.toThrow();
 await expect(store.read(auth(),{...binding,serverId:otherServer})).rejects.toThrow();
 await common.share(auth(),created.id,peerMember);expect((await store.read(auth('mcp-peer'),binding)).secret.kind).toBe('api_key');
 await common.unshare(auth(),created.id,peerMember);await expect(store.read(auth('mcp-peer'),binding)).rejects.toThrow();
 await expect(common.readForSpawn(auth(),space,'mcp' as never,created.id)).rejects.toThrow('server-only');
 await common.revoke(auth(),created.id);await expect(store.read(auth(),binding)).rejects.toThrow();
 expect(await db.rpc(auth(),'mcp_credential_readiness',[server,created.id])).toEqual({ready:false,reason:'credential_revoked'});
 const row=await database.query('select id from public.entities where id=$1',[server]);expect(row).toHaveLength(1);
});
it('keeps both TS and SQL human-only write gates and fails closed on cross-space pins',async()=>{
 await expect(store.create(auth('mcp-owner','agent'),{spaceId:space,serverId:server,label:'forbidden',secret:{kind:'api_key',value:'agent-secret'}})).rejects.toThrow('human');
 await expect(db.rpc(auth('mcp-owner','agent'),'create_mcp_credential',[randomUUID(),space,server,'forbidden',Buffer.alloc(32),Buffer.alloc(12),'api_key'])).rejects.toThrow();
 const created=await store.create(auth(),{spaceId:space,serverId:server,label:'Pin fixture',secret:{kind:'api_key',value:'pin-secret'}}) as {id:string};
 await expect(store.read({...auth(),sessionSpaceId:randomUUID()},{spaceId:space,serverId:server,credentialId:created.id})).rejects.toThrow();
 await expect(store.read({...auth(),viaLinkId:randomUUID()},{spaceId:space,serverId:server,credentialId:created.id})).rejects.toThrow();
});
it('reports expired non-refreshable OAuth accounts and retains only references in audit',async()=>{
 const created=await store.create(auth(),{spaceId:space,serverId:server,label:'Expired fixture',secret:{kind:'oauth',accessToken:'expired-canary',expiresAt:Date.now()-1000,issuer:'https://example.test',tokenEndpoint:'https://example.test/token',resource:'https://example.test/mcp',clientId:'fixture'}}) as {id:string};
 expect(await db.rpc(auth(),'mcp_credential_readiness',[server,created.id])).toEqual({ready:false,reason:'credential_expired'});
 const session=randomUUID();await db.rpc(auth(),'record_mcp_call',[space,session,server,created.id,'tools/call','failed']);
 const rows=await db.query(auth(),'select * from public.mcp_call_audit where session_id=$1',[session]);expect(rows).toHaveLength(1);expect(JSON.stringify(rows)).not.toContain('expired-canary');
});
it('serializes refreshes across independent database clients',async()=>{
 const created=await store.create(auth(),{spaceId:space,serverId:server,label:'Lock fixture',secret:{kind:'api_key',value:'lock-old'}}) as {id:string};
 const binding={spaceId:space,serverId:server,credentialId:created.id};
 const db2=createDb(database.url);const store2=new McpCredentialStore(db2,dir);
 let firstRunning=false;let secondEntered=false;
 const first=store.withRefreshLock(auth(),binding,async locked=>{
   firstRunning=true;const opened=await locked.read(auth(),binding);
   await new Promise<void>(resolve=>setTimeout(resolve,100));
   await locked.replace(auth(),binding,opened.nonce,{kind:'api_key',value:'lock-new'});
 });
 await new Promise<void>(resolve=>setTimeout(resolve,25));
 const second=store2.withRefreshLock(auth(),binding,async locked=>{
   secondEntered=true;const opened=await locked.read(auth(),binding);
   expect(opened.secret).toEqual({kind:'api_key',value:'lock-new'});
 });
 await new Promise<void>(resolve=>setTimeout(resolve,25));
 expect(firstRunning).toBe(true);expect(secondEntered).toBe(false);
 await Promise.all([first,second]);
 expect(secondEntered).toBe(true);
 await db2.end();
});
