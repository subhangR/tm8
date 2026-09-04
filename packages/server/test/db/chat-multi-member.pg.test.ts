import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * A chat is a shared conversation, not a private one. Every member of the Space
 * who can read it may prompt the teammate.
 *
 * The reproduction this file locks down: identity A starts the chat, identity B
 * posts in it, and B's message must become a durable turn. Before 112 the
 * trigger queued only `configured_by_member_id`, so B's message was stored,
 * rendered, and never answered.
 *
 * 176 WIDENS THE SAME RULE ONE STEP FURTHER, and the third case below is the
 * new half: the author-kind test is gone too (ruling R-A), so a team_member
 * author — a worker reporting back, another chat speaking — queues a turn as
 * well. What stops a reply re-triggering itself is no longer "the author has no
 * members row" but the ONE remaining guard: a chat is never handed a message
 * whose SOURCE is that same chat.
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
let chatId: string;

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
  _unusedParent: string | null,
  actorId: string | null = null,
  sourceChatId: string | null = null,
): Promise<string> {
  return asIdentity(identityId, async (client) => {
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, $3::uuid, '{}'::uuid[], '{}'::uuid[], null,
         $4::uuid, $5, null, $6::uuid
       ) result`,
      [[chatId], body, null, actorId, `chat-post-${randomUUID()}`, sourceChatId],
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
  chatId = randomUUID();
  await asIdentity(fixture.identityA, async (client) => (
    await client.query<{ result: Record<string, unknown> }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [
        chatId,
        fixture.spaceId,
        fixture.teammateId,
        'claude-opus-5',
        'anthropic',
        'claude-code',
        'orchestrate',
        'scratch',
        null,
        randomUUID(),
        `/tmp/tm8-chat-${chatId}`,
        null,
        'root prompt from A',
        [],
        null,
        `chat-config-${randomUUID()}`,
      ],
    )
  ).rows[0]!);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('TM8 Chat turns are queued for every author', () => {
  it('queues a turn for a message from a member who did not create the chat', async () => {
    const replyFromB = await post(fixture.identityB, 'question from B', null);
    expect(await turnFor(replyFromB)).toMatchObject({
      user_message_id: replyFromB,
      requested_by_member_id: fixture.memberB,
      state: 'queued',
    });
  });

  it('still queues the configuring member, and now the teammate too', async () => {
    const replyFromA = await post(fixture.identityA, 'follow-up from A', null);
    // 176: a team_member author from ELSEWHERE queues. Under 115 this found no
    // `members` row and the message stayed inert context — the reported defect.
    const workerReport = await post(
      fixture.identityA, 'a worker reports back', null, fixture.teammateId,
    );
    expect(await turnFor(replyFromA)).toMatchObject({
      requested_by_member_id: fixture.memberA,
      state: 'queued',
    });
    expect(await turnFor(workerReport)).toMatchObject({
      // No member: nobody human sent it, and the column says so rather than
      // naming the configurer, who did not speak.
      requested_by_member_id: null,
      state: 'queued',
    });
  });

  it('never hands the chat a message it authored ITSELF', async () => {
    // The ONE guard R-A keeps, and it is keyed on the SOURCE rather than on the
    // author: keying it on the author would also suppress a message this same
    // teammate wrote from a DIFFERENT chat or session, which is precisely the
    // traffic the feature exists to carry.
    const ownOutput = await post(
      fixture.identityA, 'Agent turn in progress.', null, fixture.teammateId, chatId,
    );
    expect(await turnFor(ownOutput)).toBeUndefined();
  });

  it('drains both members in message order and names each turn requester', async () => {
    const drained: Array<Record<string, unknown>> = [];
    for (;;) {
      const claimed = await asIdentity(fixture.identityA, async (client) => (
        await client.query<{ result: Record<string, unknown> | null }>(
          `select public.claim_next_chat_turn($1) result`,
          [chatId],
        )
      ).rows[0]!);
      if (!claimed.result) break;
      drained.push(claimed.result);
    }
    expect(drained.map((turn) => turn['body'])).toEqual([
      'root prompt from A',
      'question from B',
      'follow-up from A',
      'a worker reports back',
    ]);
    // Authority stays frozen to the configuring human on every turn; the
    // requester fields are provenance, never a second set of claims.
    expect(drained.every((turn) => turn['requesterIdentityId'] === fixture.identityA)).toBe(true);
    expect(drained.every((turn) => turn['chatMode'] === 'orchestrate')).toBe(true);
    expect(drained.map((turn) => turn['requestedByMemberId'])).toEqual([
      fixture.memberA,
      fixture.memberB,
      fixture.memberA,
      // The worker's report has no human sender, and the claim says so rather
      // than coalescing to the configurer — which would put words in the mouth
      // of somebody who did not speak.
      null,
    ]);
    expect(drained.map((turn) => turn['requestedByIdentityId'])).toEqual([
      fixture.identityA,
      fixture.identityB,
      fixture.identityA,
      null,
    ]);
    expect(drained.map((turn) => turn['requestedByActorKind'])).toEqual([
      'member', 'member', 'member', 'team_member',
    ]);
    expect(drained.map((turn) => turn['requestedByDisplayName'])).toEqual([
      'Member A',
      'Member B',
      'Member A',
      null,
    ]);
  });
});
