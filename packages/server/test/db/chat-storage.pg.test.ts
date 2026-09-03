import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  getOperation,
  type MessageView,
  type OperationName,
  type Page,
} from '@tm8/contract';
import { PgDb } from '../../src/db/client.js';
import type { RequestContext } from '../../src/http/types.js';
import { messagesList } from '../../src/facade/handlers/messages.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

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
let facadeDb: PgDb;
let fixture: Fixture;
let chatId: string;
let openingMessageId: string;
let authorReplyId: string;
let otherReplyId: string;

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

async function asIdentity<T extends QueryResultRow>(
  identityId: string,
  authKind: 'browser' | 'agent',
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    await client.query(`select set_config('tm8.auth_kind',$1,true)`, [authKind]);
    return fn(client);
  });
}

/**
 * A turn: a message ANCHORED ON THE CHAT, with no parent.
 *
 * That is the whole re-key. This used to post onto a channel with the chat's
 * root message as `parentMessageId`, because the chat WAS that message — which
 * is exactly why nothing in the graph could address it.
 */
async function post(
  identityId: string,
  body: string,
  actorId: string | null = null,
  sourceChatId: string | null = null,
): Promise<string> {
  return asIdentity(identityId, 'browser', async (client) => {
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, null, '{}'::uuid[], '{}'::uuid[], null,
         $3::uuid, $4, null, $5::uuid
       ) result`,
      [[chatId], body, actorId, `chat-post-${randomUUID()}`, sourceChatId],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

async function postWithMode(identityId: string, body: string, mode: string): Promise<string> {
  return asIdentity(identityId, 'browser', async (client) => {
    // 154: the mode rides as an explicit w2_post_message_batch argument,
    // written to messages.requested_chat_mode.
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, null, '{}'::uuid[], '{}'::uuid[], null, null, $3, $4, null
       ) result`,
      [[chatId], body, `chat-post-${randomUUID()}`, mode],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

async function startChat(
  identityId: string,
  authKind: 'browser' | 'agent',
  mutationId: string,
  candidateId: string = randomUUID(),
  aboutId: string | null = null,
) {
  return asIdentity(identityId, authKind, async (client) => (
    await client.query<{ result: Record<string, unknown> }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [
        candidateId,
        fixture.spaceId,
        fixture.teammateId,
        'gpt-5.6-sol',
        'openai',
        'codex',
        'explain',
        'scratch',
        null,
        randomUUID(),
        `/tmp/tm8-chat-${candidateId}`,
        null,
        'first prompt verbatim',
        [],
        aboutId,
        mutationId,
      ],
    )
  ).rows[0]!.result);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_storage');
  database.apply(migrationFiles());
  fixture = await seed(database);
  facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
}, 240_000);

afterAll(async () => {
  await facadeDb?.end();
  await database?.destroy();
});

function context(operation: OperationName, params: Record<string, string>): RequestContext {
  const op = getOperation(operation);
  return {
    op,
    opName: operation,
    params,
    query: new URLSearchParams(),
    body: undefined,
    requestId: `chat-read-${operation}`,
    identity: { kind: 'auto-owner', identityId: fixture.identityA, authKind: 'browser' },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

describe.sequential('TM8 Chat storage and door rules', () => {
  it('creates the chat and its opening turn in ONE human-gated call', async () => {
    // An agent_runtime bearer cannot start a chat: `require_human_auth_kind`.
    // This is the ONE gate 176 deliberately keeps — R-A removed every gate on
    // TURNS, not the one on birth.
    await expect(startChat(fixture.identityA, 'agent', 'chat-start-agent')).rejects.toMatchObject({
      code: '42501',
    });

    const candidate = randomUUID();
    const result = await startChat(
      fixture.identityA, 'browser', 'chat-start-a', candidate, fixture.channelId,
    );
    chatId = String(result.chatId);
    openingMessageId = String(result.messageId);
    // The id the CALLER minted is the id the chat has. It must be, because the
    // handler creates the scratch directory named after it before this runs.
    expect(chatId).toBe(candidate);
    // R5: no native identifier and no path reaches the caller.
    expect(JSON.stringify(result)).not.toContain('nativeSessionId');
    expect(JSON.stringify(result)).not.toContain('/tmp/tm8-chat');

    const row = (await database.query<{
      kind: string; title: string; chat_mode: string; workdir_mode: string;
      runtime_state: string; node_id: string | null; requester_auth_kind: string | null;
    }>(
      `select e.kind, c.title, c.chat_mode, c.workdir_mode, c.runtime_state,
              c.node_id, c.requester_auth_kind
         from public.chats c join public.entities e on e.id = c.entity_id
        where c.entity_id = $1`,
      [chatId],
    ))[0]!;
    expect(row).toMatchObject({
      kind: 'chat',
      title: 'first prompt verbatim',
      chat_mode: 'explain',
      workdir_mode: 'scratch',
      runtime_state: 'cold',
      // B7: nothing has claimed the runtime, and NULL says so rather than
      // naming a node that does not hold it.
      node_id: null,
      // Server-RESOLVED at the human-gated start, never asserted later.
      requester_auth_kind: 'browser',
    });

    // The opening message is anchored ON THE CHAT and is a ROOT message.
    const message = (await database.query<{ anchor_id: string; root_message_id: string | null }>(
      `select anchor_id::text, root_message_id::text from public.messages where entity_id=$1`,
      [openingMessageId],
    ))[0]!;
    expect(message).toEqual({ anchor_id: chatId, root_message_id: null });

    // Turn one is queued by the SAME path every later turn takes — there is no
    // second queueing door, which is what 104 had and what silently dropped
    // every agent-authored message.
    const turns = await database.query<{ user_message_id: string; chat_id: string }>(
      `select user_message_id::text, chat_id::text from public.chat_turns where chat_id=$1`,
      [chatId],
    );
    expect(turns).toEqual([{ user_message_id: openingMessageId, chat_id: chatId }]);

    // The two edges a chat is born with.
    const edges = await database.query<{ type: string; dst: string }>(
      `select type, dst_id::text as dst from public.edges where src_id=$1 order by type`,
      [chatId],
    );
    expect(edges).toEqual([
      { type: 'about', dst: fixture.channelId },
      { type: 'relates_to', dst: fixture.teammateId },
    ]);

    // A RETRY RETURNS THE ORIGINAL CHAT, and it must: the handler mints a fresh
    // candidate id and native session id on every attempt (the scratch
    // directory is named before the RPC runs), so a client retrying the same
    // clientMutationId after a timeout sends DIFFERENT ids for a logically
    // identical request. The request hash therefore excludes both, and the
    // ledger hands back the chat that exists rather than refusing the caller
    // that cannot otherwise learn its id.
    const replay = await startChat(
      fixture.identityA, 'browser', 'chat-start-a', randomUUID(), fixture.channelId,
    );
    expect(replay.chatId).toBe(chatId);
    expect(replay.messageId).toBe(openingMessageId);
    // A different logical request under the same id is still refused.
    await expect(startChat(
      fixture.identityA, 'browser', 'chat-start-a', randomUUID(), null,
    )).rejects.toMatchObject({ code: '23514' });
  });

  /**
   * THE REPORTED DEFECT, as an assertion.
   *
   * 104/115/153 queued a turn only when the author was a human MEMBER — a
   * team_member author found no `members` row and "the message stays inert
   * context". A worker reporting back into a chat therefore woke nothing. R-A
   * removes every one of those gates and keeps exactly one, and this is the
   * pair that pins it: an agent-authored message from ELSEWHERE queues, and the
   * chat's own output does not.
   */
  it('queues a turn for EVERY author, and never hands a chat its own message', async () => {
    authorReplyId = await post(fixture.identityA, 'next human turn');
    otherReplyId = await post(fixture.identityB, 'second member asks too');
    // A teammate-authored message with no source: this is a worker's report or
    // another chat's post, and it MUST queue. Under 115 it silently did not.
    const agentReplyId = await post(
      fixture.identityA, 'a worker reports back', fixture.teammateId,
    );
    // The chat's OWN output, posted with itself as the source. This is the
    // orchestrator's `Agent turn in progress.` placeholder, and it must not
    // wake the chat that wrote it.
    const selfPostId = await post(
      fixture.identityA, 'Agent turn in progress.', fixture.teammateId, chatId,
    );

    const turns = await database.query<{ user_message_id: string }>(
      `select user_message_id::text from public.chat_turns
        where chat_id=$1 order by queued_at, user_message_id`,
      [chatId],
    );
    const queued = turns.map((row) => row.user_message_id);
    expect(queued.sort()).toEqual(
      [openingMessageId, authorReplyId, otherReplyId, agentReplyId].sort(),
    );
    expect(queued).not.toContain(selfPostId);

    // Provenance, not claims: the actor is recorded either way, and only a
    // human author fills `requested_by_member_id`.
    const provenance = await database.query<{
      user_message_id: string;
      requested_by_member_id: string | null;
      requested_by_actor_id: string;
      requested_by_chat_id: string | null;
    }>(
      `select user_message_id::text, requested_by_member_id::text,
              requested_by_actor_id::text, requested_by_chat_id::text
         from public.chat_turns where user_message_id = any($1::uuid[])`,
      [[otherReplyId, agentReplyId]],
    );
    const byId = new Map(provenance.map((row) => [row.user_message_id, row]));
    expect(byId.get(otherReplyId)).toMatchObject({
      requested_by_member_id: fixture.memberB,
      requested_by_actor_id: fixture.memberB,
      requested_by_chat_id: null,
    });
    expect(byId.get(agentReplyId)).toMatchObject({
      requested_by_member_id: null,
      requested_by_actor_id: fixture.teammateId,
    });

    // And the self-post still carries provenance: it is stored and readable,
    // it simply queues nothing.
    const selfEdge = await database.query<{ dst_id: string }>(
      `select dst_id::text from public.edges where src_id=$1 and type='authored_from'`,
      [selfPostId],
    );
    expect(selfEdge).toEqual([{ dst_id: chatId }]);
  });

  it('refuses a message that names two sources', async () => {
    // `edges_authored_from_source_idx` makes one authored_from per source a
    // hard rule; a batch naming two would violate it or silently drop one, and
    // "silently drop one" is how provenance becomes a guess.
    await expect(asIdentity(fixture.identityA, 'browser', async (client) => (
      client.query(
        `select public.w2_post_message_batch(
           $1::uuid[], 'two sources', null, '{}'::uuid[], '{}'::uuid[], $2::uuid,
           null, $3, null, $2::uuid)`,
        [[chatId], chatId, `chat-post-${randomUUID()}`],
      ) as never
    ))).rejects.toThrow(/a message has one source/);
  });

  it('stamps the per-turn mode from the send onto chat_turns.mode', async () => {
    const planMsg = await postWithMode(fixture.identityA, 'do it in plan mode', 'plan');
    const defaultMsg = await post(fixture.identityA, 'no mode named');
    const rows = await database.query<{ user_message_id: string; mode: string | null }>(
      `select user_message_id::text, mode from public.chat_turns where user_message_id = any($1::uuid[])`,
      [[planMsg, defaultMsg]],
    );
    const byId = new Map(rows.map((row) => [row.user_message_id, row.mode]));
    expect(byId.get(planMsg)).toBe('plan');
    // 176 RESOLVES at queue time rather than leaving NULL for claim time: the
    // chat's own mode is on the row the queue step already read, so the turn
    // records the mode it will actually run under.
    expect(byId.get(defaultMsg)).toBe('explain');
    const msg = await database.query<{ requested_chat_mode: string | null }>(
      `select requested_chat_mode from public.messages where entity_id=$1`,
      [planMsg],
    );
    expect(msg[0]!.requested_chat_mode).toBe('plan');
    // An out-of-vocabulary mode fails LOUD (22023), like a bad body or
    // clientMutationId — never a silent fallback to the chat default.
    await expect(postWithMode(fixture.identityA, 'seventh mode?', 'telepathy'))
      .rejects.toThrow(/unknown chat turn mode/);
  });

  it('persists ordered parts idempotently and never coerces absent cost to zero', async () => {
    const claimed = await asIdentity(fixture.identityA, 'browser', async (client) => (
      await client.query<{ result: { turnId: string; chatId: string } }>(
        `select public.claim_next_chat_turn($1) result`, [chatId],
      )
    ).rows[0]!.result);
    expect(claimed.chatId).toBe(chatId);

    // FLAT: the agent's message is anchored on the chat, not threaded under
    // the human's, and the pairing is the chat_turns row this binds.
    const agentMessageId = await post(
      fixture.identityA, 'Agent turn in progress.', fixture.teammateId, chatId,
    );
    await asIdentity(fixture.identityA, 'browser', async (client) => {
      await client.query(`select public.bind_chat_agent_message($1,$2)`, [claimed.turnId, agentMessageId]);
      const first = (await client.query<{ result: { seq: number; kind: string } }>(
        `select public.append_chat_message_part($1,0,'usage',$2::jsonb) result`,
        [agentMessageId, JSON.stringify({ input_tokens: 7 })],
      )).rows[0]!.result;
      const replay = (await client.query<{ result: { seq: number; kind: string } }>(
        `select public.append_chat_message_part($1,0,'usage',$2::jsonb) result`,
        [agentMessageId, JSON.stringify({ input_tokens: 7 })],
      )).rows[0]!.result;
      expect(replay).toEqual(first);
      await client.query(
        `select public.append_chat_message_part($1,1,'tool_call',$2::jsonb)`,
        [agentMessageId, JSON.stringify({ id: 'call-1', name: 'repo_read_file', args: { path: 'README.md' }, state: 'running' })],
      );
      await client.query(
        `select public.append_chat_message_part($1,2,'tool_call',$2::jsonb)`,
        [agentMessageId, JSON.stringify({ id: 'call-1', name: 'repo_read_file', args: { path: 'README.md' }, state: 'completed' })],
      );
      return { ok: true };
    });

    const deps = {
      db: facadeDb,
      owner: async () => ({ identityId: fixture.identityA, isNodeAdmin: true }),
    } as never;

    // Mid-turn, the read path projects the claim as `turnInFlight` (133): the
    // placeholder body is a claim, and clients suppress it by this marker.
    // The chat is FLAT, so it is a top-level item, not a reply under a root.
    const midPage = await messagesList(deps)(
      context('messages.list', { anchorId: chatId }),
    ) as Page<MessageView>;
    expect(midPage.items.find((message) => message.id === agentMessageId)?.turnInFlight).toBe(true);

    await asIdentity(fixture.identityA, 'browser', async (client) => {
      await client.query(
        `select public.complete_chat_turn($1,'completed','answer',$2::jsonb,null,null)`,
        [claimed.turnId, JSON.stringify({ input_tokens: 7 })],
      );
      return { ok: true };
    });
    const rows = await database.query<{
      total_cost_usd: string | null;
      usage_source: string | null;
      usage: { input_tokens: number };
    }>(
      `select total_cost_usd::text, usage_source, usage
         from public.chat_turns where turn_id=$1`,
      [claimed.turnId],
    );
    expect(rows[0]).toEqual({
      total_cost_usd: null,
      usage_source: 'c1_usage_item',
      usage: { input_tokens: 7 },
    });

    const page = await messagesList(deps)(
      context('messages.list', { anchorId: chatId }),
    ) as Page<MessageView>;
    const projectedAgent = page.items.find((message) => message.id === agentMessageId);
    // Completed: the marker is gone and the body is the answer, not a claim.
    expect(projectedAgent?.turnInFlight).toBeUndefined();
    expect(projectedAgent?.parts).toMatchObject([
      { seq: 0, kind: 'usage', payload: { input_tokens: 7 } },
      { seq: 1, kind: 'tool_call', payload: { id: 'call-1', name: 'repo_read_file', state: 'running' } },
      { seq: 2, kind: 'tool_call', payload: { id: 'call-1', name: 'repo_read_file', state: 'completed' } },
    ]);

    const audits = await database.query<{ verb: string; summary: Record<string, unknown> }>(
      `select verb, summary from public.activity
        where entity_id = $1 and verb = 'chat.tool_called'
        order by created_at, id`,
      [agentMessageId],
    );
    // `chatId`, not `threadRootId`: the fact it named no longer exists, so the
    // key is renamed rather than aliased.
    expect(audits).toEqual([
      {
        verb: 'chat.tool_called',
        summary: {
          chatId, toolCallId: 'call-1', tool: 'repo_read_file',
          state: 'running', mode: 'explain',
        },
      },
      {
        verb: 'chat.tool_called',
        summary: {
          chatId, toolCallId: 'call-1', tool: 'repo_read_file',
          state: 'completed', mode: 'explain',
        },
      },
    ]);
  });

  /**
   * The list read is `entities.list kind=chat` now — the same read every other
   * kind uses — so what a row carries is an ordinary `EntityState`, asserted
   * key for key exactly as the deleted `spaces.home` projection was.
   */
  it('projects the chat as an ordinary entity row, with BOTH state axes', async () => {
    const [summary] = await facadeDb.tx(
      { identityId: fixture.identityA },
      (q) => loadEntitySummariesByIds(q, [chatId], fixture.identityA),
    );
    expect(summary?.kind).toBe('chat');
    expect(summary?.title).toBe('first prompt verbatim');
    expect(Object.keys(summary?.state ?? {}).sort()).toEqual([
      'agentTool', 'kind', 'lastTurnAt', 'mode', 'model', 'projectId', 'provider',
      'runtimeState', 'teammateId', 'turnCount', 'turnState', 'workdirMode',
    ]);
    expect(summary?.state).toMatchObject({
      kind: 'chat',
      teammateId: fixture.teammateId,
      model: 'gpt-5.6-sol',
      provider: 'openai',
      agentTool: 'codex',
      mode: 'explain',
      // This fixture starts a scratch chat, so the binding is the honest
      // "nowhere in particular" rather than a project it never named.
      projectId: null,
      workdirMode: 'scratch',
      // The two axes are INDEPENDENT: nothing has run the runtime, and turns
      // are waiting. Neither field can say that alone.
      runtimeState: 'cold',
      turnState: 'queued',
    });
    // R5, from the read side.
    expect(JSON.stringify(summary)).not.toContain('/tmp/tm8-chat');
  });

  it('records each sender auth kind, mints against the CHAT, and fails closed without it', async () => {
    // The mint inherits a human ACCOUNT's authority (105), which this chat
    // fixture does not otherwise need — seed both collaborating humans.
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, 'chat-owner-a', 'Chat A', false, true),
                ($2, 'chat-member-b', 'Chat B', false, false)
         on conflict do nothing`,
        [fixture.identityA, fixture.identityB],
      );
    });

    const turnForB = (await database.query<{
      requested_by_member_id: string;
      requested_by_auth_kind: string | null;
    }>(
      `select requested_by_member_id::text, requested_by_auth_kind
         from public.chat_turns where user_message_id = $1`,
      [otherReplyId],
    ))[0]!;
    expect(turnForB).toEqual({
      requested_by_member_id: fixture.memberB,
      requested_by_auth_kind: 'browser',
    });

    // The configuring identity owns the durable drain, but the claim carries
    // the current turn sender and that sender's server-resolved auth kind.
    let claimedByB: {
      userMessageId: string;
      requestedByIdentityId?: string;
      requestedByAuthKind?: string;
      requestedByActorKind?: string;
    } | null = null;
    for (let index = 0; index < 6 && !claimedByB; index += 1) {
      const claimed = await asIdentity(fixture.identityA, 'browser', async (client) => (
        await client.query<{ result: typeof claimedByB }>(
          `select public.claim_next_chat_turn($1) result`, [chatId],
        )
      ).rows[0]!.result);
      if (claimed?.userMessageId === otherReplyId) claimedByB = claimed;
    }
    expect(claimedByB).toMatchObject({
      userMessageId: otherReplyId,
      requestedByIdentityId: fixture.identityB,
      requestedByAuthKind: 'browser',
      requestedByActorKind: 'member',
    });

    // The C5 mint accepts the truthful per-turn sender replay, and binds to the
    // CHAT rather than to a root message.
    const minted = await asIdentity(fixture.identityB, 'browser', async (client) => (
      await client.query<{ result: { id: string; runtime_member_id: string | null; runtime_chat_id: string | null } }>(
        `select public.issue_agent_runtime_session($1,$2,$3,$4,$5) result`,
        [chatId, fixture.teammateId, 'a'.repeat(64), new Date(Date.now() + 60_000).toISOString(), 'r9'],
      )
    ).rows[0]!.result);
    expect(minted.runtime_member_id).toBe(fixture.memberB);
    expect(minted.runtime_chat_id).toBe(chatId);

    // ...and FAILS CLOSED when no auth kind is bound — the exact live-measured
    // composition failure this column exists to fix (advisor R9, condition 3b).
    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id',$1,true)`, [fixture.identityB]);
        await client.query(
          `select public.issue_agent_runtime_session($1,$2,$3,$4,$5)`,
          [chatId, fixture.teammateId, 'b'.repeat(64), new Date(Date.now() + 60_000).toISOString(), 'r9-closed'],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('marks the runtime live and stamps the node that claimed it', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id',$1,true)`, [fixture.identityA]);
      await client.query(`select set_config('tm8.node_id','node-alpha',true)`);
      await client.query(`select public.mark_chat_runtime_state($1,'live')`, [chatId]);
    });
    let row = (await database.query<{ runtime_state: string; node_id: string | null }>(
      `select runtime_state, node_id from public.chats where entity_id=$1`, [chatId],
    ))[0]!;
    expect(row).toEqual({ runtime_state: 'live', node_id: 'node-alpha' });

    // A node that does not know its own name must not ERASE the one that does:
    // stopping leaves the claim, and a later live without the GUC keeps it.
    await asIdentity(fixture.identityA, 'browser', async (client) => {
      await client.query(`select public.mark_chat_runtime_state($1,'stopped')`, [chatId]);
      await client.query(`select public.mark_chat_runtime_state($1,'live')`, [chatId]);
      return { ok: true };
    });
    row = (await database.query<{ runtime_state: string; node_id: string | null }>(
      `select runtime_state, node_id from public.chats where entity_id=$1`, [chatId],
    ))[0]!;
    expect(row).toEqual({ runtime_state: 'live', node_id: 'node-alpha' });
  });
});
