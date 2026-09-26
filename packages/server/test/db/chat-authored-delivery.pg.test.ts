/**
 * 253 — a chat-authored message reserves a delivery to a work session.
 *
 * 176 made every chat-authored post carry `authored_from(message -> chat)`.
 * `reserve_session_message_delivery` read any `authored_from` destination as
 * the source WORK SESSION and inserted the chat id into
 * `session_message_deliveries.source_work_session_id`, whose FK then refused
 * it. On the live node that was every chat -> session message, reported as
 * `delivery_reserve_refused`.
 *
 * The two cases below are the two provenance shapes a Teammate post can carry.
 * The session-authored one is here so the fix is shown not to have loosened
 * `verified` attribution: its source session still lands on the row.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import {
  createDeliveryPrincipalPool,
  type DeliveryPrincipalPool,
} from './delivery-principal.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identity: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  /** The session a Teammate speaks FROM (it has a `participates_in` edge). */
  sourceSessionId: string;
  /** The running session every message below is addressed to. */
  targetSessionId: string;
}

let database: W1ScratchDatabase;
let delivery: DeliveryPrincipalPool;
let fixture: Fixture;
let chatId: string;

async function asIdentity<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [fixture.identity]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identity: 'chat-delivery-owner',
    spaceId: randomUUID(),
    memberId: randomUUID(),
    teammateId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1,'Delivery Owner')`,
      [values.identity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1,'Chat Delivery',$2)`,
      [values.spaceId, values.identity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$5,'member',0,$1), ($2,$5,'team_member',1,$1),
              ($3,$5,'work_session',2,$1), ($4,$5,'work_session',3,$1)`,
      [values.memberId, values.teammateId, values.sourceSessionId, values.targetSessionId, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Delivery Owner')`,
      [values.memberId, values.spaceId, values.identity],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Delivery Agent','helper','gpt-5.6-sol','codex')`,
      [values.teammateId, values.memberId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1,'source worker','running','space'), ($2,'target worker','running','space')`,
      [values.sourceSessionId, values.targetSessionId],
    );
    // 176:1275 refuses a source session the author does not participate in.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1,$2,$3,'participates_in',$2)`,
      [values.spaceId, values.teammateId, values.sourceSessionId],
    );
  });
  return values;
}

async function startChat(): Promise<string> {
  const candidate = randomUUID();
  const result = await asIdentity(async (client) => (
    await client.query<{ result: { chatId: string } }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [
        candidate, fixture.spaceId, fixture.teammateId,
        'gpt-5.6-sol', 'openai', 'codex', 'build', 'scratch', null,
        randomUUID(), `/tmp/tm8-chat-${candidate}`, null, 'opening turn', [],
        null, `chat-delivery-${candidate}`,
      ],
    )
  ).rows[0]!.result);
  return result.chatId;
}

/** Post to the target session as the Teammate, naming a source as the server does. */
async function postToTarget(source: { sessionId?: string; chatId?: string }): Promise<string> {
  return asIdentity(async (client) => {
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, null, '{}'::uuid[], '{}'::uuid[],
         $3::uuid, $4::uuid, $5, null, $6::uuid
       ) result`,
      [
        [fixture.targetSessionId], `steer ${randomUUID()}`,
        source.sessionId ?? null, fixture.teammateId,
        `chat-delivery-post-${randomUUID()}`, source.chatId ?? null,
      ],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

/** Reserve exactly as the delivery adapter does: authenticated worker, bound tuple. */
async function reserve(messageId: string): Promise<Record<string, unknown>> {
  const deliveryId = randomUUID();
  return delivery.transaction(async (client) => {
    await client.query(
      `select set_config('tm8.principal_type','system_delivery_adapter',true),
              set_config('tm8.delivery_id',$1,true),
              set_config('tm8.delivery_message_id',$2,true),
              set_config('tm8.delivery_target_work_session_id',$3,true),
              set_config('tm8.delivery_expires_at',(now()+interval '15 minutes')::text,true),
              set_config('tm8.actor_id','',true)`,
      [deliveryId, messageId, fixture.targetSessionId],
    );
    return (await client.query<{ row: Record<string, unknown> }>(
      `select public.reserve_session_message_delivery($1,$2,$3,1) as row`,
      [deliveryId, messageId, fixture.targetSessionId],
    )).rows[0]!.row;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_authored_deliv');
  database.apply(migrationFiles());
  delivery = createDeliveryPrincipalPool(database.url);
  fixture = await seed(database);
  chatId = await startChat();
}, 240_000);

afterAll(async () => {
  await delivery?.end();
  await database?.destroy();
});

describe.sequential('253 — chat-authored messages reserve a session delivery', () => {
  it('a message authored from a chat reserves with no source session', async () => {
    const messageId = await postToTarget({ chatId });

    // The provenance that tripped the FK is really there: the source is a chat.
    const [edge] = await database.query<{ kind: string }>(
      `select dst.kind from public.edges e join public.entities dst on dst.id = e.dst_id
        where e.src_id = $1 and e.type = 'authored_from'`,
      [messageId],
    );
    expect(edge?.kind).toBe('chat');

    const reserved = await reserve(messageId);
    expect(reserved['status']).toBe('pending');
    expect(reserved['source_work_session_id']).toBeNull();
    expect(reserved['target_work_session_id']).toBe(fixture.targetSessionId);
  });

  it('a message authored from a work session still reserves with that session', async () => {
    const messageId = await postToTarget({ sessionId: fixture.sourceSessionId });

    const reserved = await reserve(messageId);
    expect(reserved['status']).toBe('pending');
    expect(reserved['source_work_session_id']).toBe(fixture.sourceSessionId);
  });
});
