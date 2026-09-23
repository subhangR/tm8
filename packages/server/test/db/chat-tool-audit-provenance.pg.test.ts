/**
 * 179 — the tool-audit event names WHO spent the configuring human's authority.
 *
 * Ruling R-C says an agent-triggered turn runs under the chat's configuring
 * human, "and the tool-audit event records it". 176 shipped the speaker line
 * that tells the AGENT who is talking and left the audit row describing only
 * the call: `{chatId, toolCallId, tool, state, mode}`.
 *
 * That gap only became reachable in 176. Before it,
 * `internal.queue_chat_human_reply` fired for HUMAN authors only, so the answer
 * to "who triggered this tool call" was always "the human on the turn" and
 * recording it would have recorded a constant. 176 deleted that trigger, so a
 * work session or another chat can now cause a chat to run tools — and
 * `requested_by_member_id` is NULL for exactly those turns. The audit row for
 * the most interesting case named nobody.
 *
 * The three cases below are the three shapes a queued turn can have, and the
 * point of running all three is that only comparing them shows the encoding is
 * unambiguous: at most one source id is ever set, and a human turn is the one
 * where BOTH are null rather than absent.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

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
  channelId: string;
  workSessionId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;
/** The chat under test — the one whose agent runs the tools. */
let chatId: string;
/** A SECOND chat, used only as a message source. */
let otherChatId: string;

/**
 * `T` is deliberately UNCONSTRAINED, where the same helper in
 * `chat-storage.pg.test.ts` constrains it to `QueryResultRow`. The constraint
 * there is a leftover — every caller that returns a plain value trips it — and
 * copying it would have added two more errors to a config nobody runs.
 */
async function asIdentity<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [fixture.identity]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identity: 'chat-audit-owner',
    spaceId: randomUUID(),
    memberId: randomUUID(),
    teammateId: randomUUID(),
    channelId: randomUUID(),
    workSessionId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1,'Audit Owner')`,
      [values.identity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1,'Audit Test',$2)`,
      [values.spaceId, values.identity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$5,'member',0,$1), ($2,$5,'team_member',1,$1),
              ($3,$5,'channel',2,$1), ($4,$5,'work_session',3,$1)`,
      [values.memberId, values.teammateId, values.channelId, values.workSessionId, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Audit Owner')`,
      [values.memberId, values.spaceId, values.identity],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Audit Agent','helper','gpt-5.6-sol','codex')`,
      [values.teammateId, values.memberId],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic) values ($1,$2,'audit','')`,
      [values.channelId, values.spaceId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1,'reporting worker','running','space')`,
      [values.workSessionId],
    );
    // `w2_post_message_batch` authorizes `p_source_work_session_id` against a
    // `participates_in` edge from the resolved author (176:1275): naming a
    // session you are not running is refused 42501. The server writes this edge
    // when it spawns a session; the fixture has to write it by hand or the
    // provenance argument this suite exists to exercise is unreachable.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1,$2,$3,'participates_in',$2)`,
      [values.spaceId, values.teammateId, values.workSessionId],
    );
  });
  return values;
}

async function startChat(mutationId: string): Promise<string> {
  const candidate = randomUUID();
  const result = await asIdentity(async (client) => (
    await client.query<{ result: { chatId: string } }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [
        candidate, fixture.spaceId, fixture.teammateId,
        'gpt-5.6-sol', 'openai', 'codex', 'build', 'scratch', null,
        randomUUID(), `/tmp/tm8-chat-${candidate}`, null, 'opening turn', [],
        null, mutationId,
      ],
    )
  ).rows[0]!.result);
  return result.chatId;
}

/**
 * Post into the chat under test, naming a source exactly as the server does.
 *
 * `sourceSessionId` and `sourceChatId` are the two provenance arguments; 176
 * refuses a message that supplies both, so the three call shapes here are the
 * complete set.
 */
async function post(options: {
  body: string;
  actorId?: string | null;
  sourceSessionId?: string | null;
  sourceChatId?: string | null;
}): Promise<string> {
  return asIdentity(async (client) => {
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, null, '{}'::uuid[], '{}'::uuid[],
         $3::uuid, $4::uuid, $5, null, $6::uuid
       ) result`,
      [
        [chatId], options.body,
        options.sourceSessionId ?? null, options.actorId ?? null,
        `audit-post-${randomUUID()}`, options.sourceChatId ?? null,
      ],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

/**
 * Drive one turn all the way to a tool call, which is the only thing that
 * writes an audit row: claim it, bind an agent message, append a `tool_call`
 * part. Returns the agent message the audit rows hang off.
 */
async function runTurnWithToolCall(callId: string): Promise<string> {
  const claimed = await asIdentity(async (client) => (
    await client.query<{ result: { turnId: string; chatId: string } }>(
      `select public.claim_next_chat_turn($1) result`, [chatId],
    )
  ).rows[0]!.result);
  // The chat's own placeholder: posted with ITSELF as the source, so the
  // self-delivery guard skips queueing a turn for it.
  const agentMessageId = await post({
    body: 'Agent turn in progress.',
    actorId: fixture.teammateId,
    sourceChatId: chatId,
  });
  await asIdentity(async (client) => {
    await client.query(`select public.bind_chat_agent_message($1,$2)`, [claimed.turnId, agentMessageId]);
    await client.query(
      `select public.append_chat_message_part($1,0,'tool_call',$2::jsonb)`,
      [agentMessageId, JSON.stringify({ id: callId, name: 'repo_grep', args: {}, state: 'running' })],
    );
    return { ok: true };
  });
  await asIdentity(async (client) => {
    await client.query(
      `select public.complete_chat_turn($1,'completed','done',null,null,null)`,
      [claimed.turnId],
    );
    return { ok: true };
  });
  return agentMessageId;
}

async function auditSummary(agentMessageId: string): Promise<Record<string, unknown>> {
  const rows = await database.query<{ summary: Record<string, unknown> }>(
    `select summary from public.activity
      where entity_id = $1 and verb = 'chat.tool_called' order by created_at, id`,
    [agentMessageId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.summary;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_audit_prov');
  database.apply(migrationFiles());
  fixture = await seed(database);
  chatId = await startChat('audit-chat-under-test');
  otherChatId = await startChat('audit-chat-source');
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('179 — chat.tool_called carries requestedBy* provenance', () => {
  it('names the human on a turn a person typed, and both source ids are null', async () => {
    // The opening turn, queued by `start_chat` for the configuring human.
    const summary = await auditSummary(await runTurnWithToolCall('call-human'));
    expect(summary).toEqual({
      chatId,
      toolCallId: 'call-human',
      tool: 'repo_grep',
      state: 'running',
      mode: 'build',
      requestedByActorId: fixture.memberId,
      // PRESENT AND NULL, not absent. A consumer must be able to tell "179
      // looked and there was no source" from "this row predates 179"; omitting
      // the nulls would make those two indistinguishable and re-create the gap
      // this migration closes.
      requestedBySessionId: null,
      requestedByChatId: null,
    });
    expect(Object.keys(summary)).toContain('requestedBySessionId');
    expect(Object.keys(summary)).toContain('requestedByChatId');
  });

  it('names the work session whose report woke the chat', async () => {
    // THE REPORTED DEFECT'S TURN. Under 115 this message queued nothing at all;
    // under 176 it queues a turn whose `requested_by_member_id` is null, because
    // no human spoke. Without 179 the audit row for the tools that turn runs
    // names nobody.
    await post({
      body: 'worker reporting back',
      actorId: fixture.teammateId,
      sourceSessionId: fixture.workSessionId,
    });
    const summary = await auditSummary(await runTurnWithToolCall('call-session'));
    expect(summary).toMatchObject({
      chatId,
      toolCallId: 'call-session',
      requestedByActorId: fixture.teammateId,
      requestedBySessionId: fixture.workSessionId,
      requestedByChatId: null,
    });
  });

  it('names the other chat that spoke, and never confuses it with the session', async () => {
    await post({
      body: 'chat B asks chat A',
      actorId: fixture.teammateId,
      sourceChatId: otherChatId,
    });
    const summary = await auditSummary(await runTurnWithToolCall('call-chat'));
    expect(summary).toMatchObject({
      chatId,
      toolCallId: 'call-chat',
      requestedByActorId: fixture.teammateId,
      requestedBySessionId: null,
      requestedByChatId: otherChatId,
    });
    // The source is the OTHER chat, never the one running the tools. A guard
    // keyed on the author rather than the source would have suppressed this
    // turn entirely — same teammate, different conversation.
    expect(summary.requestedByChatId).not.toBe(chatId);
  });

  it('still writes exactly one row per (call, state), the guard untouched', async () => {
    await post({ body: 'another human turn' });
    const claimed = await asIdentity(async (client) => (
      await client.query<{ result: { turnId: string } }>(
        `select public.claim_next_chat_turn($1) result`, [chatId],
      )
    ).rows[0]!.result);
    const agentMessageId = await post({
      body: 'Agent turn in progress.',
      actorId: fixture.teammateId,
      sourceChatId: chatId,
    });
    await asIdentity(async (client) => {
      await client.query(`select public.bind_chat_agent_message($1,$2)`, [claimed.turnId, agentMessageId]);
      // The same part delivered twice — the re-delivery the idempotence guard
      // exists for. 179 must not have widened that guard with provenance: the
      // provenance of a turn cannot change between deliveries, so including it
      // could only ever let a duplicate through.
      for (let i = 0; i < 2; i += 1) {
        await client.query(
          `select public.append_chat_message_part($1,0,'tool_call',$2::jsonb)`,
          [agentMessageId, JSON.stringify({ id: 'call-dup', name: 'repo_grep', args: {}, state: 'running' })],
        );
      }
      await client.query(
        `select public.append_chat_message_part($1,1,'tool_call',$2::jsonb)`,
        [agentMessageId, JSON.stringify({ id: 'call-dup', name: 'repo_grep', args: {}, state: 'completed' })],
      );
      return { ok: true };
    });
    const rows = await database.query<{ state: string }>(
      `select summary ->> 'state' as state from public.activity
        where entity_id = $1 and verb = 'chat.tool_called' order by created_at, id`,
      [agentMessageId],
    );
    expect(rows.map((row) => row.state)).toEqual(['running', 'completed']);
  });
});
