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

it('recovers a settled closing owner without changing its answer or replaying it',async()=>{
  const p=await prepared();await agentMessage(p);await opened(p);
  await caller(q=>q.query('select public.begin_chat_dispatch($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,p.sealed.inputDigest]));
  const terminal={outcome:'completed',evidence:'provider_terminal',body:'settled answer'};
  await caller(q=>q.query('select public.complete_chat_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [p.claim.turnId,'completed','settled answer',null,null,null,p.fence,p.snapshot,terminal,null]));
  const recover=(nodeId:string)=>caller(async q=>(await q.query('select public.recover_chat_attempt($1,$2,$3,$4) result',
    [p.id,p.claim.turnId,p.claim.attemptNo,{nodeId,bootId:'boot-b'}])).rows[0].result);
  expect((await recover('other-node')).disposition).toBe('wait_owner');
  expect((await recover('node-a')).disposition).toBe('released_settled');
  expect((await database.query('select state from chat_turns where turn_id=$1',[p.claim.turnId]))[0].state).toBe('completed');
  expect((await database.query('select runtime_phase from chats where entity_id=$1',[p.id]))[0].runtime_phase).toBe('idle');
  expect((await caller(async q=>(await q.query('select public.release_chat_runtime($1,$2,$3) result',
    [p.id,p.fence.runtimeEpoch,p.fence.leaseToken])).rows[0].result))).toBe(false);
});

it('removes edited and deleted source detail from subsequent portable history',async()=>{
  const {PgDb}=await import('../../src/db/client.js');const {readPortableHistory,projectHistory}=await import('../../src/chat/continuity.js');
  const p=await prepared();const message=await agentMessage(p);await opened(p);
  await caller(q=>q.query('select public.begin_chat_dispatch($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,p.sealed.inputDigest]));
  await caller(q=>q.query("select public.append_chat_message_part($1,0,'text',$2,$3,$4,'old-output')",
    [message,{text:'removed assistant secret'},p.fence,p.snapshot]));
  const terminal={outcome:'completed',evidence:'provider_terminal',body:'removed assistant secret'};
  await caller(q=>q.query('select public.complete_chat_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [p.claim.turnId,'completed',terminal.body,null,null,null,p.fence,p.snapshot,terminal,null]));
  await database.query("update messages set body='revised user' where entity_id=$1",[p.claim.userMessageId]);
  await database.query("update messages set body='revised assistant',edited_at=now()+interval '1 second' where entity_id=$1",[message]);
  const db=new PgDb({databaseUrl:database.url});
  try {
    const rendered=async()=>projectHistory(await readPortableHistory(db,{identityId:fixture.identityA},p.id,2,1000),{
      snapshotId:randomUUID(),currentTurnOrdinal:2,captureHighWater:1000,authorityScopeDigest:'authority',maxBytes:32768}).renderedContext;
    const edited=await rendered();expect(edited).toContain('revised user');expect(edited).toContain('revised assistant');
    expect(edited).not.toContain('removed assistant secret');expect(edited).not.toContain('original input');
    await database.query('update entities set deleted_at=now() where id=any($1::uuid[])',[[p.claim.userMessageId,message]]);
    const deleted=await rendered();expect(deleted).not.toContain('revised user');expect(deleted).not.toContain('revised assistant');
    expect(deleted).toContain('source deleted or unavailable');
  } finally {await db.end();}
});

it('keeps legacy setters revisioned and permits a cross-harness change with remembered provider choices',async()=>{
  const id=await chat();
  await caller(q=>q.query('select public.set_chat_credentials($1,$2)',[id,{source:'member'}]));
  await caller(q=>q.query('select public.set_chat_model($1,$2,$3,$4)',[id,'claude-opus-4-6','anthropic','claude-code']));
  await caller(q=>q.query('select public.set_chat_credentials($1,$2)',[id,{source:'node'}]));
  await caller(q=>q.query('select public.set_chat_model($1,$2,$3,$4)',[id,'gpt-5.6-sol','openai','codex']));
  const row=(await database.query('select config_revision,credential_selection,credential_intent from chats where entity_id=$1',[id]))[0];
  expect(Number(row.config_revision)).toBe(5);expect(row.credential_selection).toEqual({source:'member'});
  expect(row.credential_intent.byProvider).toEqual({openai:{source:'member'},anthropic:{source:'node'}});
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


it('permits a current prepared connector read but refuses pre-barrier effects and spoofed or stale grants',async () => {
  const p=await prepared(); const tokenHash='e'.repeat(64);
  const grant=await caller(async q => (await q.query("select public.issue_agent_runtime_session($1,$2,$3,now()+interval '1 hour',null,$4) result",
    [p.id,fixture.teammateId,tokenHash,p.generation])).rows[0].result);
  await caller(q => q.query("select public.bind_mcp_session($1,$2,'[]'::jsonb)",[p.id,tokenHash]));
  const read=(session:string=grant.id) => database.transaction(async q => {
    await q.query('set local role tm8_app');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','agent_runtime',true),set_config('tm8.auth_session_id',$2,true),set_config('tm8.session_space_id',$3,true)",
      [fixture.identityA,grant.id,fixture.spaceId]);
    return (await q.query('select public.read_mcp_session_binding($1,$2) result',[p.id,session])).rows[0].result;
  });
  expect(await read()).toMatchObject({identityId:fixture.identityA,launcherIdentityId:fixture.identityA,selections:[]});
  const effect=()=>database.transaction(async q=>{
    await q.query('set local role tm8_app');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','agent_runtime',true),set_config('tm8.auth_session_id',$2,true)",[fixture.identityA,grant.id]);
    return q.query('select public.authorize_chat_runtime_effect($1,$2)',[p.id,grant.id]);
  });
  await expect(effect()).rejects.toMatchObject({code:'42501'});
  await opened(p);await caller(q=>q.query('select public.begin_chat_dispatch($1,$2,$3,$4)',[p.id,p.fence,p.snapshot,p.sealed.inputDigest]));
  await expect(effect()).resolves.toBeDefined();
  await expect(read(randomUUID())).rejects.toMatchObject({code:'42501'});
  await database.query('update chats set runtime_epoch=runtime_epoch+1 where entity_id=$1',[p.id]);
  await expect(read()).rejects.toMatchObject({code:'42501'});
});

it('runs queued cross-harness turns through the registry with durable inert history and exact grant ownership',async () => {
  const {PgDb}=await import('../../src/db/client.js');
  const {ChatOrchestrator}=await import('../../src/chat/orchestrator.js');
  const {ChatTurnPublisher}=await import('../../src/chat/publisher.js');
  const {SubscriptionRegistry}=await import('../../src/events/subscriptions.js');
  const {HarnessRegistry}=await import('@tm8/execution');
  const db=new PgDb({databaseUrl:database.url}); const id=await chat();
  const opens:any[]=[]; const submissions:any[]=[]; const releases:string[]=[]; const errors:unknown[]=[];
  const adapter=(kind:'codex'|'claude') => {
    const caps={schemaVersion:1,harness:kind,binaryVersion:'test',protocolRevision:'v2',nativeResume:'unknown',portableBootstrap:'supported',
      cancelActiveTurn:'supported',nativeTurnIds:'supported',usage:'supported',contextReading:'supported',interactiveRequests:'unsupported',
      textInputs:'supported',imageInputs:'unsupported',fileInputs:'unsupported',builtInToolRestriction:'unknown',
      configuration:{model:'per_turn',reasoningEffort:'per_turn',serviceTier:'per_turn',instructions:'restart',tools:'restart',credential:'restart'}};
    return {kind,capabilities:async()=>caps,open:async(input:any)=>{
      opens.push(input);let command:any;let ready!:()=>void;const submitted=new Promise<void>(r=>{ready=r;});
      const seed={...input.mode.context,transport:'instructions',acknowledgement:'turn_accepted'};
      return {fence:input.fence,opened:{native:{schemaVersion:1,harness:kind,nativeId:`opaque:${kind}:${opens.length}`,nodeId:'node-a',
        storageScopeId:input.launch.nativeStorageScopeId,nativeStorageGeneration:1,cwdIdentity:input.config.cwdIdentity,historyFormat:'test'},nativeConfirmed:true,
        readiness:'protocol_session_ack',capabilities:caps,execution:{requested:input.config.target,configuredModel:input.config.target.model,
          observedModel:null,observedEffort:null,observedServiceTier:null,evidence:'protocol_echo'},seed:{...seed,acknowledgement:'launch_materialized'}},
        observations:(async function*(){await submitted; const base={fence:input.fence,attempt:command.attempt,nativeTurnId:'native-turn',observedAt:new Date().toISOString()};
          yield {...base,adapterSeq:1,payload:{kind:'seed_acknowledged',seed}};
          yield {...base,adapterSeq:2,payload:{kind:'text',itemId:'answer',revision:1,operation:'append',phase:'final',text:`answer:${kind}`}};
          if(submissions.length===1) yield {...base,adapterSeq:3,payload:{kind:'tool',tool:{toolKey:'first-tool',nativeCallId:'tool',name:'write',args:{path:'once'},
            state:'completed',result:'written once',origin:'native',evidence:'completion_only'}}};
          yield {...base,adapterSeq:4,payload:{kind:'terminal',outcome:'completed',evidence:'provider_terminal'}};
        })(),
        submit:async(value:any)=>{command=value;submissions.push(value);
          if(submissions.length===1) {
            await caller(q=>q.query(`select public.w2_post_message_batch($1::uuid[],'queued future user',null,'{}'::uuid[],'{}'::uuid[],null,null,$2,null,null)`,[[id],randomUUID()]));
            await caller(q=>q.query('select public.set_chat_configuration($1,1,$2,$3)',[id,target,randomUUID()]));
          }
          ready();return {delivery:'sent',acknowledgement:'native_ack',nativeTurnId:'native-turn'};},
        cancel:async()=>({disposition:'requested',nativeTurnId:'native-turn'}),respond:async()=>{},close:async()=>({exited:true,nativeUsable:null})};
    }};
  };
  const registry=new HarnessRegistry([adapter('codex'),adapter('claude')] as any);
  const resolver=async(input:any,owner:any,fence:any)=>{
    const auth={identityId:input.requesterIdentityId,authKind:input.requesterAuthKind,...(input.requesterAuthSessionId?{authSessionId:input.requesterAuthSessionId}:{})};
    const grant:any=await db.rpc(auth,'issue_agent_runtime_session',[id,fixture.teammateId,randomUUID().replaceAll('-','').repeat(2),new Date(Date.now()+3600000).toISOString(),null,fence]);
    const tokenHash=(await database.query('select token_hash from auth_sessions where id=$1',[grant.id]))[0].token_hash;
    await db.rpc(auth,'bind_mcp_session',[id,tokenHash,JSON.stringify([])]);
    const revalidate=async()=>{await db.rpc({identityId:input.requesterIdentityId,authKind:'agent_runtime',authSessionId:grant.id,sessionSpaceId:fixture.spaceId},'read_mcp_session_binding',[id,grant.id]);};
    const requested={harness:input.agentTool==='codex'?'codex':'claude',provider:input.provider,model:input.model,reasoningEffort:input.reasoningEffort,serviceTier:null};
    return {target:requested,instructionHash:'instructions',toolPolicyHash:'policy',mcpBindingRevision:'mcp',credentialBinding:{},credentialBindingId:randomUUID(),
      credentialRevision:null,launchFingerprint:null,revalidate,launch:{owner,kind:'ephemeral-launch',launchId:randomUUID(),storageScopeId:'private',
        nativeStorageScopeId:`history:${fence.generation}`,nativeStorageGeneration:1,modelCredentialLeaseId:'lease',runtimeGrantId:grant.id,capabilityPlanId:'plan',
        materialize:async()=>({}),release:async()=>{releases.push(grant.id);await db.rpc(auth,'revoke_agent_runtime_session',[id,fence.leaseEpoch,fence.generation,grant.id]);}}};
  };
  const orchestrator=new ChatOrchestrator({db,registry,resolvePreparedLaunch:resolver as any,nodeId:'node-a',bootId:'boot-a',
    publisher:new ChatTurnPublisher(new SubscriptionRegistry()),onError:error=>errors.push(error)});
  try {
    await orchestrator.wake(id,fixture.identityA);
    expect(errors).toEqual([]); expect(opens.map(o=>o.config.target.harness)).toEqual(['codex','claude']);
    expect(submissions[0].config.target.model).toBe('gpt-5.6-sol');
    expect(opens[0].mode.context.renderedContext).not.toContain('queued future user');
    expect(opens[1].mode.context.renderedContext).toContain('original input');
    expect(opens[1].mode.context.renderedContext).toContain('answer:codex');
    expect(opens[1].mode.context.renderedContext).toContain('written once');
    expect(opens[1].mode.context.renderedContext).not.toContain('queued future user');
    expect(opens[1].mode.context.renderedContext).toContain('"executable":false');
    const back={...target,model:'gpt-5.6-sol',provider:'openai',agentTool:'codex'};
    await caller(q=>q.query('select public.set_chat_configuration($1,2,$2,$3)',[id,back,randomUUID()]));
    await caller(q=>q.query(`select public.w2_post_message_batch($1::uuid[],'return to codex',null,'{}'::uuid[],'{}'::uuid[],null,null,$2,null,null)`,[[id],randomUUID()]));
    await orchestrator.wake(id,fixture.identityA);
    expect(errors).toEqual([]);expect(opens[2].mode.kind).toBe('bootstrap');expect(opens[2].mode.context.renderedContext).toContain('answer:claude');
    expect(new Set(opens.map(o=>o.fence.generation)).size).toBe(3);expect(releases).toHaveLength(3);
    expect((await database.query('select state from chat_turns where chat_id=$1 order by turn_ordinal',[id])).map(r=>r.state)).toEqual(['completed','completed','completed']);
    expect(await database.query("select * from message_parts where kind='tool_result' and message_id in(select agent_message_id from chat_turns where chat_id=$1)",[id])).toHaveLength(1);
  } finally {await db.end();}
});
