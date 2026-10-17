/**
 * 328 — the Coordinator's team rides a chat TURN, never its body.
 *
 * `set_chat_turn_team` may only stamp a turn whose message was created in the
 * caller's own transaction and is still queued; `chat_turn_team` reads it back
 * only for the identity that configured the chat.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

let database: W1ScratchDatabase;
const owner = 'team-owner-a';
const other = 'team-member-b';
const spaceId = randomUUID();
const memberA = randomUUID();
const memberB = randomUUID();
const teammateId = randomUUID();
let chatId: string;

const TEAM = { members: [{ name: 'Worker', model: 'Claude Opus 5.5 (1M)', effort: 'medium' }] };

async function asIdentity<T extends QueryResultRow | QueryResultRow[] | unknown>(
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

async function postIn(client: PoolClient, body: string): Promise<string> {
  const row = (await client.query<{ result: { messageIds: string[] } }>(
    `select public.w2_post_message_batch(
       $1::uuid[], $2, null, '{}'::uuid[], '{}'::uuid[], null, null, $3, null, null
     ) result`,
    [[chatId], body, `team-post-${randomUUID()}`],
  )).rows[0]!;
  return row.result.messageIds[0]!;
}

const stamp = (client: PoolClient, messageId: string, team: unknown) =>
  client.query<{ ok: boolean }>('select public.set_chat_turn_team($1, $2::jsonb) ok', [messageId, JSON.stringify(team)])
    .then((result) => result.rows[0]!.ok);

const turnOf = async (messageId: string) =>
  (await database.query<{ turn_id: string; team: unknown }>(
    'select turn_id, team from public.chat_turns where user_message_id = $1',
    [messageId],
  ))[0]!;

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_turn_team');
  database.apply(migrationFiles());
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1,'Team A'), ($2,'Team B')`,
      [owner, other],
    );
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Team Test',$2)`, [spaceId, owner]);
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$4,'member',0,$1), ($2,$4,'member',1,$1), ($3,$4,'team_member',2,$1)`,
      [memberA, memberB, teammateId, spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$3,$4,'owner','Team A'), ($2,$3,$5,'member','Team B')`,
      [memberA, memberB, spaceId, owner, other],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Chat Agent','helper','claude-opus-5','claude-code')`,
      [teammateId, memberA],
    );
  });
  const candidateId = randomUUID();
  const started = await asIdentity(owner, async (client) => (
    await client.query<{ result: { chatId: string } }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [candidateId, spaceId, teammateId, 'claude-opus-5', 'anthropic', 'claude-code', 'ask', 'scratch', null,
        randomUUID(), `/tmp/tm8-chat-${candidateId}`, null, 'first prompt', [], null, `team-start-${randomUUID()}`],
    )
  ).rows[0]!.result);
  chatId = started.chatId;
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('328 chat turn team', () => {
  it('stamps the turn in the posting transaction and leaves the body alone', async () => {
    const messageId = await asIdentity(owner, async (client) => {
      const id = await postIn(client, 'Plan the release.');
      expect(await stamp(client, id, TEAM)).toBe(true);
      return id;
    });
    const turn = await turnOf(messageId);
    expect(turn.team).toEqual(TEAM);
    const [message] = await database.query<{ body: string }>('select body from public.messages where entity_id = $1', [messageId]);
    expect(message!.body).toBe('Plan the release.');

    // The configuring identity reads it back; anybody else reads nothing.
    const read = (identity: string) => asIdentity(identity, async (client) =>
      (await client.query<{ team: unknown }>('select public.chat_turn_team($1) team', [turn.turn_id])).rows[0]!.team);
    expect(await read(owner)).toEqual(TEAM);
    expect(await read(other)).toBeNull();
  });

  it('refuses to restamp a turn after its posting transaction', async () => {
    const messageId = await asIdentity(owner, (client) => postIn(client, 'Second.'));
    const later = await asIdentity(owner, (client) => stamp(client, messageId, TEAM));
    expect(later).toBe(false);
    expect((await turnOf(messageId)).team).toBeNull();
  });

  it('rejects a malformed team', async () => {
    await expect(asIdentity(owner, async (client) => {
      const id = await postIn(client, 'Third.');
      return stamp(client, id, { members: [] });
    })).rejects.toThrow(/invalid chat turn team/);
  });
});
