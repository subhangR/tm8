import { randomUUID } from 'node:crypto';
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
  database.apply(migrationFiles()); fixture=await seed(database); },240_000);
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
