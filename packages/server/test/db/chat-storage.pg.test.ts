import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  getOperation,
  type HomeSnapshot,
  type MessageView,
  type OperationName,
  type Page,
} from '@tm8/contract';
import { PgDb } from '../../src/db/client.js';
import type { RequestContext } from '../../src/http/types.js';
import { messagesList } from '../../src/facade/handlers/messages.js';
import { spacesHome } from '../../src/facade/handlers/spaces.js';
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
  anchorId: string;
}

let database: W1ScratchDatabase;
let facadeDb: PgDb;
let fixture: Fixture;
let rootMessageId: string;
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
    anchorId: randomUUID(),
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
      [values.memberA, values.memberB, values.teammateId, values.anchorId, values.spaceId],
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
      [values.anchorId, values.spaceId],
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

async function post(
  identityId: string,
  body: string,
  parentMessageId: string | null,
  actorId: string | null = null,
): Promise<string> {
  return asIdentity(identityId, 'browser', async (client) => {
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

async function postWithMode(identityId: string, body: string, mode: string): Promise<string> {
  return asIdentity(identityId, 'browser', async (client) => {
    // 154: the send path sets a transaction-local mode; the BEFORE INSERT
    // trigger stamps it onto messages.requested_chat_mode.
    await client.query(`select set_config('tm8.chat_turn_mode',$1,true)`, [mode]);
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, $3::uuid, '{}'::uuid[], '{}'::uuid[], null, null, $4
       ) result`,
      [[fixture.anchorId], body, rootMessageId, `chat-post-${randomUUID()}`],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

async function configure(identityId: string, authKind: 'browser' | 'agent', mutationId: string) {
  return asIdentity(identityId, authKind, async (client) => (
    await client.query<{ result: Record<string, unknown> }>(
      `select public.start_chat_thread($1,$2,$3,$4,$5,$6,$7,$8,$9) result`,
      [
        rootMessageId,
        fixture.teammateId,
        'gpt-5.6-sol',
        'openai',
        'codex',
        'explain',
        randomUUID(),
        `/tmp/tm8-chat-${rootMessageId}`,
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
  rootMessageId = await post(fixture.identityA, 'first prompt verbatim', null);
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

describe.sequential('TM8 Chat storage and trigger rules', () => {
  it('only the human root author can make the write-once binding', async () => {
    await expect(configure(fixture.identityB, 'browser', 'chat-config-b')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(configure(fixture.identityA, 'agent', 'chat-config-agent')).rejects.toMatchObject({
      code: '42501',
    });

    const result = await configure(fixture.identityA, 'browser', 'chat-config-a');
    expect(result).toMatchObject({
      thread: {
        rootMessageId,
        anchorId: fixture.anchorId,
        teammateId: fixture.teammateId,
        model: 'gpt-5.6-sol',
        mode: 'explain',
        lastReplyAt: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('nativeSessionId');
    await expect(configure(fixture.identityA, 'browser', 'chat-config-second')).rejects.toMatchObject({
      code: '23505',
    });
  });

  // 112 widened this from "only the configuring human" to "every human member
  // of the Space". The teammate's own reply stays inert — that suppression now
  // comes from the author having no `members` row, not from an id comparison.
  it('queues every human member while the teammate never self-triggers', async () => {
    authorReplyId = await post(fixture.identityA, 'next human turn', rootMessageId);
    otherReplyId = await post(fixture.identityB, 'second member asks too', rootMessageId);
    const agentReplyId = await post(
      fixture.identityA,
      'agent reply must not self-trigger',
      rootMessageId,
      fixture.teammateId,
    );
    const turns = await database.query<{ user_message_id: string }>(
      `select user_message_id::text from public.chat_turns order by queued_at, user_message_id`,
    );
    expect(turns.map((row) => row.user_message_id).sort()).toEqual(
      [rootMessageId, authorReplyId, otherReplyId].sort(),
    );
    const visibleReplies = await database.query<{ entity_id: string }>(
      `select entity_id::text from public.messages where root_message_id=$1`,
      [rootMessageId],
    );
    expect(visibleReplies.map((row) => row.entity_id)).toEqual(
      expect.arrayContaining([authorReplyId, otherReplyId, agentReplyId]),
    );
  });

  it('stamps the per-turn mode from the send onto chat_turns.mode, else leaves it null', async () => {
    const planMsg = await postWithMode(fixture.identityA, 'do it in plan mode', 'plan');
    const defaultMsg = await post(fixture.identityA, 'no mode named', rootMessageId);
    const rows = await database.query<{ user_message_id: string; mode: string | null }>(
      `select user_message_id::text, mode from public.chat_turns where user_message_id = any($1::uuid[])`,
      [[planMsg, defaultMsg]],
    );
    const byId = new Map(rows.map((row) => [row.user_message_id, row.mode]));
    // A named mode reaches the turn; an unnamed send stays null (→ the thread
    // default resolves at claim time).
    expect(byId.get(planMsg)).toBe('plan');
    expect(byId.get(defaultMsg)).toBeNull();
    // And the carrier is on the message row itself.
    const msg = await database.query<{ requested_chat_mode: string | null }>(
      `select requested_chat_mode from public.messages where entity_id=$1`,
      [planMsg],
    );
    expect(msg[0]!.requested_chat_mode).toBe('plan');
  });

  it('persists ordered parts idempotently and never coerces absent cost to zero', async () => {
    const claimed = await asIdentity(fixture.identityA, 'browser', async (client) => (
      await client.query<{ result: { turnId: string } }>(
        `select public.claim_next_chat_turn($1) result`, [rootMessageId],
      )
    ).rows[0]!.result);
    const agentMessageId = await post(
      fixture.identityA,
      'Agent turn in progress.',
      rootMessageId,
      fixture.teammateId,
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

    // Mid-turn, the read path projects the claim as `turnInFlight` (133): the
    // placeholder body is a claim, and clients suppress it by this marker.
    const midDeps = {
      db: facadeDb,
      owner: async () => ({ identityId: fixture.identityA, isNodeAdmin: true }),
    } as never;
    const midPage = await messagesList(midDeps)(
      context('messages.list', { anchorId: fixture.anchorId }),
    ) as Page<MessageView>;
    const midAgent = midPage.items
      .find((message) => message.id === rootMessageId)!
      .replies?.items.find((message) => message.id === agentMessageId);
    expect(midAgent?.turnInFlight).toBe(true);

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

    const deps = {
      db: facadeDb,
      owner: async () => ({ identityId: fixture.identityA, isNodeAdmin: true }),
    } as never;
    const page = await messagesList(deps)(
      context('messages.list', { anchorId: fixture.anchorId }),
    ) as Page<MessageView>;
    const root = page.items.find((message) => message.id === rootMessageId)!;
    const projectedAgent = root.replies?.items.find((message) => message.id === agentMessageId);
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
    expect(audits).toEqual([
      {
        verb: 'chat.tool_called',
        summary: {
          threadRootId: rootMessageId,
          toolCallId: 'call-1',
          tool: 'repo_read_file',
          state: 'running',
          mode: 'explain',
        },
      },
      {
        verb: 'chat.tool_called',
        summary: {
          threadRootId: rootMessageId,
          toolCallId: 'call-1',
          tool: 'repo_read_file',
          state: 'completed',
          mode: 'explain',
        },
      },
    ]);

    const home = await spacesHome(deps)(
      context('spaces.home', { spaceId: fixture.spaceId }),
    ) as HomeSnapshot;
    const summary = home.chatThreads?.find((thread) => thread.rootMessageId === rootMessageId);
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      // + title/replyCount: PR188 review F4 — the list needs a readable row.
      'anchorId', 'createdAt', 'lastReplyAt', 'mode', 'model', 'replyCount', 'rootMessageId', 'teammateId', 'title',
    ]);
    expect(summary).toMatchObject({
      anchorId: fixture.anchorId,
      teammateId: fixture.teammateId,
      model: 'gpt-5.6-sol',
      mode: 'explain',
    });
  });

  it('records each sender auth kind, mints with that sender, and fails closed without it', async () => {
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

    // (1) The binding row holds the literal that was SERVER-RESOLVED at the
    // human-gated start — never asserted later. ('agent' could not have
    // written it: the configure test above already saw that arm refuse 42501.)
    const bound = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ requester_auth_kind: string | null }>(
        `select requester_auth_kind from public.chat_threads where root_message_id = $1`,
        [rootMessageId],
      )).rows[0]!;
    });
    expect(bound.requester_auth_kind).toBe('browser');

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
    } | null = null;
    for (let index = 0; index < 3 && !claimedByB; index += 1) {
      const claimed = await asIdentity(fixture.identityA, 'browser', async (client) => (
        await client.query<{ result: typeof claimedByB }>(
          `select public.claim_next_chat_turn($1) result`, [rootMessageId],
        )
      ).rows[0]!.result);
      if (claimed?.userMessageId === otherReplyId) claimedByB = claimed;
    }
    expect(claimedByB).toMatchObject({
      userMessageId: otherReplyId,
      requestedByIdentityId: fixture.identityB,
      requestedByAuthKind: 'browser',
    });

    // The C5 mint accepts the truthful per-turn sender replay.
    const minted = await asIdentity(fixture.identityB, 'browser', async (client) => (
      await client.query<{ result: { id: string; runtime_member_id: string | null } }>(
        `select public.issue_agent_runtime_session($1,$2,$3,$4,$5) result`,
        [rootMessageId, fixture.teammateId, 'a'.repeat(64), new Date(Date.now() + 60_000).toISOString(), 'r9'],
      )
    ).rows[0]!.result);
    expect(minted.runtime_member_id).toBe(fixture.memberB);

    // ...and FAILS CLOSED when no auth kind is bound — the exact live-measured
    // composition failure this column exists to fix (advisor R9, condition 3b).
    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id',$1,true)`, [fixture.identityB]);
        await client.query(
          `select public.issue_agent_runtime_session($1,$2,$3,$4,$5)`,
          [rootMessageId, fixture.teammateId, 'b'.repeat(64), new Date(Date.now() + 60_000).toISOString(), 'r9-closed'],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
