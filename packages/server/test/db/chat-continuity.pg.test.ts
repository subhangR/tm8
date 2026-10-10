import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
interface Fixture {
  identityA: string;
  identityB: string;
  spaceId: string;
  memberA: string;
  memberB: string;
  teammateId: string;
  channelId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;
async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identityA: 'chat-owner-a',
    identityB: 'chat-member-b',
    spaceId: randomUUID(),
    memberA: randomUUID(),
    memberB: randomUUID(),
    teammateId: randomUUID(),
    channelId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Chat A'), ($2, 'Chat B')`,
      [values.identityA, values.identityB],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Chat Test', $2)`,
      [values.spaceId, values.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$5,'member',0,$1), ($2,$5,'member',1,$1),
              ($3,$5,'team_member',2,$1), ($4,$5,'channel',3,$1)`,
      [values.memberA, values.memberB, values.teammateId, values.channelId, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$3,$4,'owner','Chat A'), ($2,$3,$5,'member','Chat B')`,
      [values.memberA, values.memberB, values.spaceId, values.identityA, values.identityB],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Chat Agent','helper','gpt-5.6-sol','codex')`,
      [values.teammateId, values.memberA],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1,$2,'chat-test','')`,
      [values.channelId, values.spaceId],
    );
  });
  return values;
}


async function caller<T>(fn: (q: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async q => {
    await q.query('set local role tm8_app');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [fixture.identityA]);
    return fn(q);
  });
}
async function chat(): Promise<string> {
  const id=randomUUID();
  await caller(q => q.query(`select public.start_chat($1,$2,$3,'gpt-5.6-sol','openai','codex','explain',
    'scratch',null,$4,$5,null,'original input','{}'::uuid[],null,$6)`,
    [id,fixture.spaceId,fixture.teammateId,randomUUID(),`/tmp/${id}`,randomUUID()]));
  return id;
}
const target={model:'claude-opus-4-6',provider:'anthropic',agentTool:'claude-code',reasoningEffort:null,
  credentialSelection:{source:'auto'},credentialIntent:{defaultChoice:{source:'auto'},byProvider:{}}};
beforeAll(async () => { database=await createW1ScratchDatabase('chat_continuity');
  database.apply(migrationFiles()); fixture=await seed(database);
  await database.query('insert into accounts(identity_id,username) values($1,$2)',[fixture.identityA,'continuity-owner']); },240_000);
afterAll(async () => { await database?.destroy(); });

it('atomically switches the entire desired target and idempotently replays the receipt',async () => {
  const id=await chat(); const mutation=randomUUID();
  const set=() => caller(async q => (await q.query('select public.set_chat_configuration($1,1,$2,$3) result',
    [id,target,mutation])).rows[0].result);
  expect(await set()).toMatchObject({...target,configRevision:2,appliesAt:'next_claim'});
  expect(await set()).toMatchObject({configRevision:2});
  await expect(caller(q => q.query('select public.set_chat_configuration($1,1,$2,$3)',
    [id,{...target,model:'different'},randomUUID()]))).rejects.toMatchObject({code:'40001'});
  expect((await database.query('select model,agent_tool,config_revision from chats where entity_id=$1',[id]))[0])
    .toMatchObject({model:target.model,agent_tool:target.agentTool,config_revision:'2'});
});
it('captures original queued input and gives each later input an increasing logical ordinal',async () => {
  const id=await chat();
  await caller(q => q.query(`select public.w2_post_message_batch($1::uuid[],'future input',null,
    '{}'::uuid[],'{}'::uuid[],null,null,$2,null,null)`,[[id],randomUUID()]));
  const turns=await database.query('select turn_ordinal,input_snapshot,input_history_seq from chat_turns where chat_id=$1 order by turn_ordinal',[id]);
  expect(turns.map(t => t.turn_ordinal)).toEqual(['1','2']);
  expect(turns.map(t => t.input_snapshot.body)).toEqual(['original input','future input']);
  expect(turns[1].input_history_seq).not.toEqual(turns[0].input_history_seq);
});
it('rejects malformed intent and does not change revision or target',async () => {
  const id=await chat();
  await expect(caller(q => q.query('select public.set_chat_configuration($1,1,$2,$3)',
    [id,{...target,credentialIntent:{defaultChoice:{source:'auto'}}},randomUUID()]))).rejects.toMatchObject({code:'22023'});
  expect((await database.query('select config_revision,agent_tool from chats where entity_id=$1',[id]))[0])
    .toMatchObject({config_revision:'1',agent_tool:'codex'});
});

async function prepared(existingId?:string) {
  const id=existingId ?? await chat(); const lease=randomUUID(); const hash=createHash('sha256').update(lease).digest('hex');
  const claim=await caller(async q => (await q.query('select public.claim_next_chat_turn($1,2,$2) result',
    [id,{nodeId:'node-a',bootId:'boot-a',leaseTokenHash:hash}])).rows[0].result);
  let fence={turnId:claim.turnId,attemptNo:claim.attemptNo,runtimeEpoch:claim.runtimeEpoch,leaseToken:lease,nativeGeneration:0};
  const reserved=await caller(async q => (await q.query('select public.reserve_chat_continuity($1,$2,$3) result',
    [id,{...fence,nativeGeneration:undefined},{targetBinding:{agentTool:'codex',storageScopeId:'storage',protocolRevision:'v1',compatibilityDigest:'compat'}}])).rows[0].result);
  fence={...fence,nativeGeneration:reserved.nativeGeneration}; const snapshot=randomUUID(); const text='historical inert data';
  const bootstrap={schemaVersion:1,snapshotId:snapshot,coverage:{throughTurnOrdinal:claim.turnOrdinal-1,
    captureHighWater:claim.captureHighWater,projectionPolicyVersion:'v1',authorityScopeDigest:'authority',logicalHistoryDigest:'logical'},
    renderedContext:text,contentHash:createHash('sha256').update(text).digest('hex'),manifest:[]};
  const sealed=await caller(async q => (await q.query('select public.seal_chat_turn_snapshot($1,$2,$3,$4,$5) result',
    [id,fence,snapshot,{desired:claim.claimedConfiguration,authority:claim.claimedAuthority},bootstrap])).rows[0].result);
  const generation={chatId:id,bindingId:reserved.bindingId,generation:reserved.nativeGeneration,leaseEpoch:claim.runtimeEpoch,configRevision:claim.configRevision};
  return {id,fence,snapshot,claim,bootstrap,sealed,generation};
}
async function opened(p:Awaited<ReturnType<typeof prepared>>) {
  await caller(q => q.query('select public.record_chat_open($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,
    {native:{nativeId:randomUUID()},seed:{snapshotId:p.snapshot,coverage:p.bootstrap.coverage,contentHash:p.bootstrap.contentHash,
      transport:'instructions',acknowledgement:'launch_materialized'},execution:{evidence:'requested_only'}}]));
}
it('pins claimed configuration while later desired revision changes',async () => {
  const p=await prepared();
  await caller(q => q.query('select public.set_chat_configuration($1,1,$2,$3)',[p.id,target,randomUUID()]));
  expect((await database.query('select claimed_configuration from chat_turns where turn_id=$1',[p.claim.turnId]))[0].claimed_configuration.model)
    .toBe('gpt-5.6-sol');
  await expect(database.query("update chat_turn_attempts set configuration_snapshot='{}' where snapshot_id=$1",[p.snapshot]))
    .rejects.toMatchObject({code:'23514'});
  await expect(database.query("update chat_turns set input_snapshot='{}' where turn_id=$1",[p.claim.turnId]))
    .rejects.toMatchObject({code:'23514'});
});
it('retries only durable prepared work and preserves its pinned target',async () => {
  const p=await prepared(); await opened(p);
  await database.query("update chats set runtime_lease_expires_at=now()-interval '1 second' where entity_id=$1",[p.id]);
  const recovery=await caller(async q => (await q.query('select public.recover_chat_attempt($1,$2,$3,$4) result',
    [p.id,p.claim.turnId,p.claim.attemptNo,{nodeId:'other-node',bootId:'boot-b'}])).rows[0].result);
  expect(recovery.disposition).toBe('retry_prepared');
  expect((await database.query('select state,claimed_configuration from chat_turns where turn_id=$1',[p.claim.turnId]))[0])
    .toMatchObject({state:'queued',claimed_configuration:{model:'gpt-5.6-sol'}});
});
it('never retries after the committed dispatch barrier even if actual send never happened',async () => {
  const p=await prepared(); await opened(p);
  await caller(q => q.query('select public.begin_chat_dispatch($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,p.sealed.inputDigest]));
  await database.query("update chats set runtime_lease_expires_at=now()-interval '1 second' where entity_id=$1",[p.id]);
  const recovery=await caller(async q => (await q.query('select public.recover_chat_attempt($1,$2,$3,$4) result',
    [p.id,p.claim.turnId,p.claim.attemptNo,{nodeId:'other-node',bootId:'boot-b'}])).rows[0].result);
  expect(recovery.disposition).toBe('settled_unknown');
  expect((await database.query('select state,failure from chat_turns where turn_id=$1',[p.claim.turnId]))[0])
    .toMatchObject({state:'error',failure:{code:'delivery_unknown'}});
  const next=await caller(async q => (await q.query('select public.claim_next_chat_turn($1,2,$2) result',
    [p.id,{nodeId:'node-a',bootId:'boot-b',leaseTokenHash:'a'.repeat(64)}])).rows[0].result);
  expect(next).toBeNull();
});
it('checks exact native binding before mint and denies runtime effects outside the active generation',async () => {
  const p=await prepared(); const tokenHash='a'.repeat(64);
  const mint=(fence:unknown,hash:string) => caller(async q => (await q.query(
    "select public.issue_agent_runtime_session($1,$2,$3,now()+interval '1 hour',null,$4) result",
    [p.id,fixture.teammateId,hash,fence])).rows[0].result);
  await expect(mint({...p.generation,bindingId:randomUUID()},'b'.repeat(64))).rejects.toMatchObject({code:'42501'});
  const grant=await mint(p.generation,tokenHash);
  const effect=() => database.transaction(async q => {
    await q.query('set local role tm8_app');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','agent_runtime',true),set_config('tm8.auth_session_id',$2,true)",
      [fixture.identityA,grant.id]);
    return q.query(`select public.w2_post_message_batch($1::uuid[],'runtime effect',null,'{}'::uuid[],
      '{}'::uuid[],null,$2::uuid,$3,null,null)`,[[fixture.channelId],fixture.teammateId,randomUUID()]);
  });
  await expect(effect()).rejects.toMatchObject({code:'42501'});
  await opened(p); await caller(q => q.query('select public.begin_chat_dispatch($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,p.sealed.inputDigest]));
  await expect(effect()).resolves.toBeDefined();
  await caller(q => q.query('select public.revoke_agent_runtime_session($1,$2,$3,$4)',[p.id,p.fence.runtimeEpoch-1,p.fence.nativeGeneration,grant.id]));
  await expect(effect()).resolves.toBeDefined();
  await database.query('update chats set runtime_epoch=runtime_epoch+1 where entity_id=$1',[p.id]);
  await expect(effect()).rejects.toMatchObject({code:'42501'});
  expect((await database.query('select public.resolve_auth_session($1) result',[tokenHash]))[0].result).toBeNull();
});

async function agentMessage(p:Awaited<ReturnType<typeof prepared>>) {
  const id=await caller(async q => (await q.query(`select public.w2_post_message_batch($1::uuid[],'in progress',null,
    '{}'::uuid[],'{}'::uuid[],null,$2::uuid,$3,null,$4::uuid) result`,
    [[p.id],fixture.teammateId,randomUUID(),p.id])).rows[0].result.messageIds[0]);
  await caller(q => q.query('select public.bind_chat_agent_message($1,$2)',[p.claim.turnId,id]));
  return id;
}
it('fences append and settlement, deduplicates normalized events and does not claim closed as success',async () => {
  const p=await prepared(); const message=await agentMessage(p); await opened(p);
  await caller(q => q.query('select public.begin_chat_dispatch($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,p.sealed.inputDigest]));
  const append=(fence:unknown,seq:number,event:string) => caller(async q => (await q.query(
    "select public.append_chat_message_part($1,$2,'text',$3,$4,$5,$6) result",[message,seq,{text:'durable'},fence,p.snapshot,event])).rows[0].result);
  expect((await append(p.fence,0,'adapter:1')).seq).toBe(0);
  expect((await append(p.fence,1,'adapter:1')).seq).toBe(0);
  expect(await database.query('select seq from message_parts where message_id=$1',[message])).toHaveLength(1);
  await expect(append({...p.fence,runtimeEpoch:p.fence.runtimeEpoch+1},1,'adapter:2')).rejects.toMatchObject({code:'42501'});
  await expect(caller(q => q.query('select public.complete_chat_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [p.claim.turnId,'completed','durable',null,null,null,p.fence,p.snapshot,{outcome:'completed',evidence:'process_exit'},null])))
    .rejects.toMatchObject({code:'42501'});
  const terminal={outcome:'completed',evidence:'provider_terminal',body:'durable'};
  await caller(q => q.query('select public.record_chat_terminal($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,terminal]));
  await database.query("update chats set runtime_lease_expires_at=now()-interval '1 second' where entity_id=$1",[p.id]);
  const recovery=await caller(async q => (await q.query('select public.recover_chat_attempt($1,$2,$3,$4) result',
    [p.id,p.claim.turnId,p.claim.attemptNo,{nodeId:'node-b',bootId:'boot-b'}])).rows[0].result);
  expect(recovery.disposition).toBe('finalized_terminal');
  expect((await database.query('select state from chat_turns where turn_id=$1',[p.claim.turnId]))[0].state).toBe('completed');
});
it('lets only one claim owner win and preserves a healthy other node at boot',async () => {
  const p=await prepared();
  const other=await caller(async q => (await q.query('select public.claim_next_chat_turn($1,2,$2) result',
    [p.id,{nodeId:'node-b',bootId:'boot-b',leaseTokenHash:'b'.repeat(64)}])).rows[0].result);
  expect(other).toBeNull();
  const recovery=await caller(async q => (await q.query('select public.recover_chat_attempt($1,$2,$3,$4) result',
    [p.id,p.claim.turnId,p.claim.attemptNo,{nodeId:'node-b',bootId:'boot-b'}])).rows[0].result);
  expect(recovery.disposition).toBe('wait_owner');
});

it('binds a second human turn to that poster instead of inheriting the creator runtime authority',async () => {
  const first=await prepared();
  await caller(q => q.query('select public.fail_chat_preparation($1,$2,$3)',[first.id,first.fence,{code:'test_not_sent',message:'not dispatched'}]));
  await caller(q => q.query('select public.release_chat_runtime($1,$2,$3)',[first.id,first.fence.runtimeEpoch,first.fence.leaseToken]));
  const authorSession=randomUUID();
  await database.query('insert into accounts(identity_id,username) values($1,$2)',[fixture.identityB,'continuity-poster']);
  await database.query(`insert into auth_sessions(id,account_id,kind,token_hash,expires_at) select $1,id,'browser',$2,
    now()+interval '1 hour' from accounts where identity_id=$3`,[authorSession,'c'.repeat(64),fixture.identityB]);
  await database.transaction(async q => {
    await q.query('set local role tm8_app');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true),set_config('tm8.auth_session_id',$2,true)",[fixture.identityB,authorSession]);
    await q.query(`select public.w2_post_message_batch($1::uuid[],'second human',null,'{}'::uuid[],'{}'::uuid[],null,null,$2,null,null)`,[[first.id],randomUUID()]);
  });
  const second=await prepared(first.id);
  expect(second.claim.claimedAuthority).toMatchObject({identityId:fixture.identityB,memberId:fixture.memberB,authSessionId:authorSession});
  const mint=async (identity:string,session:string|undefined) => database.transaction(async q => {
    await q.query('set local role tm8_app');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true),set_config('tm8.auth_session_id',$2,true)",[identity,session??'']);
    return q.query("select public.issue_agent_runtime_session($1,$2,$3,now()+interval '1 hour',null,$4) result",
      [second.id,fixture.teammateId,'d'.repeat(64),second.generation]);
  });
  await expect(mint(fixture.identityA,undefined)).rejects.toMatchObject({code:'42501'});
  const granted=(await mint(fixture.identityB,authorSession)).rows[0].result;
  expect(granted.runtime_member_id).toBe(fixture.memberB);
  expect((await database.query('select identity_id from accounts where id=$1',[granted.account_id]))[0].identity_id).toBe(fixture.identityB);
});
