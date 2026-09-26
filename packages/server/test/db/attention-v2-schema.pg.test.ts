/**
 * Migration 256 — the Attention v2 schema (slice S3, spec chapter 1).
 *
 * The chain is applied up to 254, legacy OPEN rows are seeded, and only then is
 * 256 applied: its clean-slate cutover (R8) is a data step, and a suite that
 * applies the full chain to an empty database would run it over zero rows.
 *
 * Then, against the full chain: the new columns and their defaults for writers
 * that predate them (050, 211), status `cleared`, the dedupe indexes, the
 * roll-up rule, the badge (rolled up + raised-by, F1), the flag trigger's touch
 * of the root and the raising session, and attention_seen's RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const MIGRATION = '256_attention_v2_schema.sql';

interface Fixture {
  identityId: string;
  otherIdentityId: string;
  spaceId: string;
  memberId: string;
  otherMemberId: string;
  agentId: string;
  taskId: string;
  docId: string;
  sessionId: string;
  loneSessionId: string;
  formId: string;
  docFormId: string;
  chatId: string;
}

const ids = (f: Fixture, keys: (keyof Fixture)[]) => keys.map((k) => f[k]);

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'attention-v2-owner'::text "identityId", 'attention-v2-other'::text "otherIdentityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
              internal.new_id()::text "otherMemberId", internal.new_id()::text "agentId",
              internal.new_id()::text "taskId", internal.new_id()::text "docId",
              internal.new_id()::text "sessionId", internal.new_id()::text "loneSessionId",
              internal.new_id()::text "formId", internal.new_id()::text "docFormId",
              internal.new_id()::text "chatId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Owner'),($2,'Other')`,
      [f.identityId, f.otherIdentityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Attention v2',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
         ($1,$2,'member',null,0,$1), ($3,$2,'member',null,1,$1), ($4,$2,'team_member',null,2,$1),
         ($5,$2,'task',null,3,$1), ($6,$2,'doc',null,4,$1), ($7,$2,'work_session',null,5,$1),
         ($8,$2,'work_session',null,6,$1), ($9,$2,'form',null,7,$1), ($10,$2,'form',null,8,$1),
         ($11,$2,'chat',null,9,$1)`,
      ids(f, ['memberId', 'spaceId', 'otherMemberId', 'agentId', 'taskId', 'docId', 'sessionId',
        'loneSessionId', 'formId', 'docFormId', 'chatId']),
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Owner'), ($4,$2,$5,'member','Other')`,
      ids(f, ['memberId', 'spaceId', 'identityId', 'otherMemberId', 'otherIdentityId']),
    );
    await client.query(`insert into public.tasks(entity_id,title,work_status) values($1,'Wire refund webhook','open')`, [f.taskId]);
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values
         ($1,$2,$3,'working_on',$4), ($1,$5,$3,'attached_to',$4), ($1,$6,$7,'attached_to',$4)`,
      ids(f, ['spaceId', 'sessionId', 'taskId', 'memberId', 'formId', 'docFormId', 'docId']),
    );
    return f;
  });
}

describe.sequential('attention v2 schema (migration 256)', () => {
  let database: W1ScratchDatabase;
  let f: Fixture;
  let messagesBefore: number;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('attention_v2_schema');
    const chain = migrationFiles();
    expect(chain).toContain(MIGRATION);
    database.apply(chain.filter((file) => file < MIGRATION));
    f = await seed(database);
    // Legacy rows exactly as 050 writes them: an open one by a human, an open
    // one by an agent, an acknowledged one, and one already resolved.
    await database.query(
      `insert into public.attention_requests(space_id, entity_id, reason, points, requested_by, status)
       values ($1,$2,'legacy human',40,$3,'open'), ($1,$2,'legacy agent',60,$4,'open'),
              ($1,$5,'legacy acked',20,$3,'acknowledged'), ($1,$5,'legacy done',20,$3,'resolved')`,
      ids(f, ['spaceId', 'taskId', 'memberId', 'agentId', 'docId']),
    );
    messagesBefore = Number((await database.query<{ n: string }>('select count(*) n from public.messages'))[0]!.n);
    database.apply(chain.filter((file) => file >= MIGRATION));
  }, 240_000);

  afterAll(async () => database?.destroy(), 30_000);

  const q = <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.query<R>(sql, params);

  describe('clean-slate cutover (R8)', () => {
    it('resolves every open and acknowledged row silently, and leaves history alone', async () => {
      const rows = await q<{ reason: string; status: string; resolution_note: string | null; resolved_by: string | null; note_deliver_after: string | null; note_message_id: string | null; origin: string; level: string; action_type: string }>(
        `select reason, status, resolution_note, resolved_by, note_deliver_after, note_message_id, origin, level, action_type
           from public.attention_requests where space_id = $1 order by reason`,
        [f.spaceId],
      );
      expect(rows).toHaveLength(4);
      const cutover = rows.filter((r) => r.reason !== 'legacy done');
      expect(cutover).toHaveLength(3);
      for (const r of cutover) {
        expect(r).toMatchObject({
          status: 'resolved', resolution_note: 'attention redesign', resolved_by: null,
          note_deliver_after: null, note_message_id: null, level: 'normal', action_type: 'decide',
        });
      }
      expect(rows.find((r) => r.reason === 'legacy done')!.resolution_note).toBeNull();
      expect(Object.fromEntries(rows.map((r) => [r.reason, r.origin]))).toEqual({
        'legacy acked': 'human', 'legacy agent': 'agent', 'legacy done': 'human', 'legacy human': 'human',
      });
      expect((await q<{ n: string }>(`select count(*) n from public.attention_requests where status in ('open','acknowledged')`))[0]!.n).toBe('0');
    });

    it('posts no message', async () => {
      expect(Number((await q<{ n: string }>('select count(*) n from public.messages'))[0]!.n)).toBe(messagesBefore);
    });
  });

  /** Insert as the 050/211 writers do (no v2 columns) plus `extra` columns. */
  async function raise(entity: keyof Fixture, reason: string, extra: Record<string, unknown> = {}, by: keyof Fixture = 'agentId') {
    const cols = Object.keys(extra);
    const rows = await q<{ id: string }>(
      `insert into public.attention_requests(space_id, entity_id, reason, points, requested_by${cols.map((c) => `, ${c}`).join('')})
       values ($1, $2, $3, 40, $4${cols.map((_, i) => `, $${i + 5}`).join('')}) returning id`,
      [f.spaceId, f[entity], reason, f[by], ...Object.values(extra)],
    );
    return rows[0]!.id;
  }
  const clear = () => q(`update public.attention_requests set status = 'resolved' where space_id = $1 and status = 'open'`, [f.spaceId]);

  describe('columns, statuses, dedupe', () => {
    it('fills origin/level/action_type for a writer that predates them', async () => {
      const agent = await raise('taskId', 'from an agent');
      const human = await raise('taskId', 'from a human', {}, 'memberId');
      const rows = await q<{ id: string; origin: string; level: string; action_type: string }>(
        'select id, origin, level, action_type from public.attention_requests where id = any($1::uuid[])', [[agent, human]],
      );
      expect(rows.find((r) => r.id === agent)).toMatchObject({ origin: 'agent', level: 'normal', action_type: 'decide' });
      expect(rows.find((r) => r.id === human)!.origin).toBe('human');
      await clear();
    });

    it('accepts status cleared and keeps the old four', async () => {
      const id = await raise('taskId', 'condition ended', { origin: 'system', signal_key: 'form:x' });
      await q(`update public.attention_requests set status = 'cleared' where id = $1`, [id]);
      await expect(q(`update public.attention_requests set status = 'snoozed' where id = $1`, [id])).rejects.toThrow(/status_check/);
    });

    it('allows signal_key only on system rows, a source only of kind work_session or chat, an assignee only of kind member', async () => {
      await expect(raise('taskId', 'bad signal', { origin: 'agent', signal_key: 'form:y' })).rejects.toThrow(/signal_key_system_check/);
      await expect(raise('taskId', 'bad source', { source_session_id: f.taskId })).rejects.toThrow(/work session or a chat/);
      await expect(raise('taskId', 'bad assignee', { assignee_id: f.agentId })).rejects.toThrow(/assignee must be a member/);
      await raise('taskId', 'chat source', { source_session_id: f.chatId, assignee_id: f.memberId });
      await clear();
    });

    it('dedupes one open reason per session and one open signal per entity, and never humans', async () => {
      await raise('taskId', 'same', { source_session_id: f.sessionId });
      await expect(raise('taskId', 'same', { source_session_id: f.sessionId })).rejects.toThrow(/open_session_reason_uq/);
      await raise('taskId', 'different', { source_session_id: f.sessionId });
      await raise('taskId', 'same', { source_session_id: f.loneSessionId });
      await raise('taskId', 'human twice', {}, 'memberId');
      await raise('taskId', 'human twice', {}, 'memberId');
      await raise('taskId', 'sig', { origin: 'system', signal_key: 'conflict:wt' });
      await expect(raise('taskId', 'sig again', { origin: 'system', signal_key: 'conflict:wt' })).rejects.toThrow(/open_signal_uq/);
      // Once settled, the same ask may be raised again.
      await clear();
      await raise('taskId', 'same', { source_session_id: f.sessionId });
      await clear();
    });
  });

  describe('roll-up and badge', () => {
    it('rolls a session up to its working_on task and a form to its attached_to task; one hop, tasks only', async () => {
      const onSession = await raise('sessionId', 'pick retry policy');
      const onForm = await raise('formId', 'form open');
      const onDocForm = await raise('docFormId', 'form on a doc');
      const onTask = await raise('taskId', 'merge conflict');
      const onLone = await raise('loneSessionId', 'no task');
      const roots = Object.fromEntries((await q<{ request_id: string; root_id: string }>(
        'select request_id, root_id from public.attention_rollup where request_id = any($1::uuid[])',
        [[onSession, onForm, onDocForm, onTask, onLone]],
      )).map((r) => [r.request_id, r.root_id]));
      expect(roots).toEqual({
        [onSession]: f.taskId, [onForm]: f.taskId, [onTask]: f.taskId,
        [onDocForm]: f.docFormId, [onLone]: f.loneSessionId,
      });
      await clear();
    });

    it('counts rolled-up requests on the root, keeps the pinned entity its own badge, and adds the raised-by badge for sessions and chats', async () => {
      await raise('sessionId', 'pick retry policy', { source_session_id: f.sessionId, level: 'high' });
      await raise('formId', 'form open', { assignee_id: f.memberId });
      await raise('taskId', 'merge conflict', { level: 'fyi' });
      await raise('docId', 'raised from the lone session', { source_session_id: f.loneSessionId, level: 'urgent' });
      const rows = await q<Record<string, unknown>>(
        'select * from public.attention_badges($1::uuid[])',
        [[f.taskId, f.sessionId, f.formId, f.loneSessionId, f.chatId, f.docId]],
      );
      const by = Object.fromEntries(rows.map((r) => [r.entity_id as string, r]));
      expect(by[f.taskId]).toMatchObject({
        pending_count: 3, total_points: 120, max_points: 40, max_level: 'high',
        latest_reason: 'merge conflict', assignee_ids: [f.memberId], rolled_up_count: 2,
        raised_pending_count: null,
      });
      expect(by[f.sessionId]).toMatchObject({
        pending_count: 1, rolled_up_count: 0, raised_pending_count: 1,
        raised_max_level: 'high', raised_latest_reason: 'pick retry policy',
      });
      expect(by[f.formId]).toMatchObject({ pending_count: 1, rolled_up_count: 0, raised_pending_count: null });
      // Raised elsewhere, nothing pinned to it: a raised-only row, pending_count 0.
      expect(by[f.loneSessionId]).toMatchObject({
        pending_count: 0, latest_reason: null, raised_pending_count: 1, raised_max_level: 'urgent',
      });
      expect(by[f.docId]).toMatchObject({ pending_count: 1, raised_pending_count: null });
      // Nothing open and nothing raised: no row at all.
      expect(by[f.chatId]).toBeUndefined();
      await clear();
      expect(await q('select * from public.attention_badges($1::uuid[])', [[f.taskId, f.sessionId, f.loneSessionId]])).toEqual([]);
    });
  });

  describe('flag trigger: the root and the raising session re-project', () => {
    /** Run `statements` in one transaction; return the entity events per fixture id, in order. */
    async function emitted(statements: [string, unknown[]][]) {
      return database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        const mark = (await client.query<{ seq: string | null }>(
          'select max(seq)::text seq from public.workspace_events where space_id = $1', [f.spaceId],
        )).rows[0]!.seq ?? '0';
        for (const [sql, params] of statements) await client.query(sql, params);
        const rows = (await client.query<{ id: string; event_type: string }>(
          `select payload->>'id' id, event_type from public.workspace_events
            where space_id = $1 and seq > $2::bigint and event_type like 'entity.%' order by seq`,
          [f.spaceId, mark],
        )).rows;
        const out: Record<string, string[]> = {};
        for (const r of rows) (out[r.id] ??= []).push(r.event_type);
        return out;
      });
    }
    const INSERT = `insert into public.attention_requests(space_id, entity_id, reason, points, requested_by, source_session_id)
                    values ($1, $2, $3, 40, $4, $5)`;
    const TOUCH = 'update public.entities set activity_at = now(), updated_at = now() where id = $1';

    it('a request on a session emits one full upsert for its task (root) and one for the raising chat', async () => {
      const events = await emitted([
        [INSERT, [f.spaceId, f.sessionId, 'via session', f.agentId, f.chatId]],
        [TOUCH, [f.sessionId]],
      ]);
      expect(events[f.taskId]).toEqual(['entity.upsert']);
      expect(events[f.chatId]).toEqual(['entity.upsert']);
      expect(events[f.sessionId]).toEqual(['entity.upsert']);
      await clear();
    });

    it('touches each extra id once per transaction, however many rows name it', async () => {
      const events = await emitted([
        [INSERT, [f.spaceId, f.sessionId, 'one', f.agentId, f.chatId]],
        [INSERT, [f.spaceId, f.formId, 'two', f.agentId, f.chatId]],
        [`update public.attention_requests set status = 'resolved' where space_id = $1 and status = 'open'`, [f.spaceId]],
      ]);
      expect(events[f.taskId]).toEqual(['entity.upsert']);
      expect(events[f.chatId]).toEqual(['entity.upsert']);
    });

    /**
     * The root was already written in this transaction, so its updated_at is
     * now(); a now() touch would be byte-identical, 165's `old.* is distinct
     * from new.*` would not fire, and the badge would never be sent.
     */
    it('still emits a full upsert for the root when the same transaction touched it first', async () => {
      const events = await emitted([
        [TOUCH, [f.taskId]],
        [INSERT, [f.spaceId, f.sessionId, 'after a touch', f.agentId, null]],
      ]);
      expect(events[f.taskId]).toEqual(['entity.activity_touched', 'entity.upsert']);
      await clear();
    });

    it('does not touch the request\'s own entity (its writer does) or anything for a plain task request', async () => {
      const events = await emitted([[INSERT, [f.spaceId, f.taskId, 'plain', f.memberId, null]]]);
      expect(events).toEqual({});
      await clear();
    });
  });

  describe('attention_seen', () => {
    async function asMember(identity: string, sql: string, params: unknown[]) {
      return database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(
          `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true), set_config('tm8.request_id', 'attention-v2', true)`,
          [identity],
        );
        return (await client.query(sql, params)).rows;
      });
    }

    it('is keyed per request and member, and a member reads only their own rows', async () => {
      const id = await raise('taskId', 'seen by two');
      await q('insert into public.attention_seen(request_id, member_id) values ($1,$2), ($1,$3)', [id, f.memberId, f.otherMemberId]);
      await expect(q('insert into public.attention_seen(request_id, member_id) values ($1,$2)', [id, f.memberId])).rejects.toThrow(/attention_seen_pkey/);
      const mine = await asMember(f.identityId, 'select member_id from public.attention_seen where request_id = $1', [id]);
      expect(mine).toEqual([{ member_id: f.memberId }]);
      const theirs = await asMember(f.otherIdentityId, 'select member_id from public.attention_seen where request_id = $1', [id]);
      expect(theirs).toEqual([{ member_id: f.otherMemberId }]);
      await expect(asMember(f.identityId, 'insert into public.attention_seen(request_id, member_id) values ($1,$2)', [id, f.memberId]))
        .rejects.toThrow(/permission denied/);
      // Seen never changes status.
      expect((await q<{ status: string }>('select status from public.attention_requests where id = $1', [id]))[0]!.status).toBe('open');
      await clear();
    });
  });
});
