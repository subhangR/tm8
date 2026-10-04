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
  // Definition registration uses the actual core kind and its approved metadata.
  for(const id of [server,otherServer]){
   await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'mcp_server',0,$3)",[id,space,ownerMember]);
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
