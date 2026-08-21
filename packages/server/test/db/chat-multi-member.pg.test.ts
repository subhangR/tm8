import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * A chat thread is a shared message thread, not a private one. Every human
 * member of the Space who can read the thread may prompt the teammate; only a
 * team_member author (the teammate's own reply) is inert, which is what stops
 * a reply from re-triggering itself.
 *
 * The reproduction this file locks down: identity A configures the thread,
 * identity B replies in it, and B's reply must become a durable turn. Before
 * 112 the trigger queued only `configured_by_member_id`, so B's message was
 * stored, rendered, and never answered.
 */
interface Fixture {
  identityA: string;
  identityB: string;
  spaceId: string;
  memberA: string;
  memberB: string;
  teammateId: string;
  anchorId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;
let rootMessageId: string;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identityA: 'chat-configurer-a',
    identityB: 'chat-participant-b',
    spaceId: randomUUID(),
    memberA: randomUUID(),
    memberB: randomUUID(),
    teammateId: randomUUID(),
    anchorId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Member A'), ($2, 'Member B')`,
      [values.identityA, values.identityB],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Chat Multi Member', $2)`,
      [values.spaceId, values.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$5,'member',0,$1), ($2,$5,'member',1,$1),
              ($3,$5,'team_member',2,$1), ($4,$5,'channel',3,$1)`,
      [values.memberA, values.memberB, values.teammateId, values.anchorId, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$3,$4,'owner','Member A'), ($2,$3,$5,'member','Member B')`,
      [values.memberA, values.memberB, values.spaceId, values.identityA, values.identityB],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Chat Agent','helper','claude-opus-5','claude-code')`,
      [values.teammateId, values.memberA],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1,$2,'chat-multi-member','')`,
      [values.anchorId, values.spaceId],
    );
  });
  return values;
}

async function asIdentity<T extends QueryResultRow>(
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

async function post(
  identityId: string,
  body: string,
  parentMessageId: string | null,
  actorId: string | null = null,
): Promise<string> {
  return asIdentity(identityId, async (client) => {
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, $3::uuid, '{}'::uuid[], '{}'::uuid[], null,
         $4::uuid, $5
       ) result`,
      [[fixture.anchorId], body, parentMessageId, actorId, `chat-post-${randomUUID()}`],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

async function turnFor(userMessageId: string): Promise<{
  user_message_id: string;
  requested_by_member_id: string | null;
  state: string;
} | undefined> {
  const rows = await database.query<{
    user_message_id: string;
    requested_by_member_id: string | null;
    state: string;
  }>(
    `select user_message_id::text, requested_by_member_id::text, state
       from public.chat_turns where user_message_id = $1`,
    [userMessageId],
  );
  return rows[0];
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_multi_member');
  database.apply(migrationFiles());
  fixture = await seed(database);
  rootMessageId = await post(fixture.identityA, 'root prompt from A', null);
  await asIdentity(fixture.identityA, async (client) => (
    await client.query<{ result: Record<string, unknown> }>(
      `select public.start_chat_thread($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result`,
      [
        rootMessageId,
        fixture.teammateId,
        'claude-opus-5',
        'anthropic',
        'claude-code',
        'orchestrate',
        randomUUID(),
        `/tmp/tm8-chat-${rootMessageId}`,
        `chat-config-${randomUUID()}`,
        null,
        'scratch',
      ],
    )
  ).rows[0]!);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('TM8 Chat turns are queued for every human member of the thread', () => {
  it('queues a turn for a reply from a member who did not create the thread', async () => {
    const replyFromB = await post(fixture.identityB, 'question from B', rootMessageId);
    expect(await turnFor(replyFromB)).toMatchObject({
      user_message_id: replyFromB,
      requested_by_member_id: fixture.memberB,
      state: 'queued',
    });
  });

  it('still queues the configuring member and never self-triggers on the teammate', async () => {
    const replyFromA = await post(fixture.identityA, 'follow-up from A', rootMessageId);
    const agentReply = await post(
      fixture.identityA,
      'teammate answer must not queue itself',
      rootMessageId,
      fixture.teammateId,
    );
    expect(await turnFor(replyFromA)).toMatchObject({
      requested_by_member_id: fixture.memberA,
      state: 'queued',
    });
    expect(await turnFor(agentReply)).toBeUndefined();
  });

  it('drains both members in message order and names each turn requester', async () => {
    const drained: Array<Record<string, unknown>> = [];
    for (;;) {
      const claimed = await asIdentity(fixture.identityA, async (client) => (
        await client.query<{ result: Record<string, unknown> | null }>(
          `select public.claim_next_chat_turn($1) result`,
          [rootMessageId],
        )
      ).rows[0]!);
      if (!claimed.result) break;
      drained.push(claimed.result);
    }
    expect(drained.map((turn) => turn['body'])).toEqual([
      'root prompt from A',
      'question from B',
      'follow-up from A',
    ]);
    // Authority stays frozen to the configuring human on every turn; the
    // requester fields are provenance, never a second set of claims.
    expect(drained.every((turn) => turn['requesterIdentityId'] === fixture.identityA)).toBe(true);
    expect(drained.every((turn) => turn['chatMode'] === 'orchestrate')).toBe(true);
    expect(drained.map((turn) => turn['requestedByMemberId'])).toEqual([
      fixture.memberA,
      fixture.memberB,
      fixture.memberA,
    ]);
    expect(drained.map((turn) => turn['requestedByIdentityId'])).toEqual([
      fixture.identityA,
      fixture.identityB,
      fixture.identityA,
    ]);
    expect(drained.map((turn) => turn['requestedByDisplayName'])).toEqual([
      'Member A',
      'Member B',
      'Member A',
    ]);
  });
});
