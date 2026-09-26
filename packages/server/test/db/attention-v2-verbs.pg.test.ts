/**
 * Migration 256 — the Attention v2 verbs (slice S4, spec chapter 3).
 *
 * Every door is called as `tm8_app` under a real identity claim, exactly as the
 * server calls it. The chapter 3 invariants are the `it`s named "INV n"; the
 * rest pin create (source stamping, level → points, dedupe), withdraw, the
 * legacy acknowledge, and the delivery doors the sweep drives.
 *
 * Time: Undo's 8s window and the note's deliver-after are wall-clock columns,
 * so the tests MOVE THE COLUMNS (as graph owner) instead of sleeping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  ownerIdentity: string;
  otherIdentity: string;
  spaceId: string;
  ownerId: string;
  otherId: string;
  agentId: string;
  taskId: string;
  otherTaskId: string;
  docId: string;
  liveA: string;
  liveB: string;
  ended: string;
  lone: string;
  formId: string;
}

type Row = Record<string, unknown>;
const KEYS: (keyof Fixture)[] = [
  'spaceId', 'ownerId', 'otherId', 'agentId', 'taskId', 'otherTaskId', 'docId', 'liveA', 'liveB', 'ended', 'lone', 'formId',
];

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Record<string, string>>(
      `select ${KEYS.map((k) => `internal.new_id()::text "${k}"`).join(', ')}`,
    )).rows[0]!;
    const f = { ...ids, ownerIdentity: 'attention-s4-owner', otherIdentity: 'attention-s4-other' } as Fixture;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Owner'),($2,'Other')`,
      [f.ownerIdentity, f.otherIdentity],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Attention S4',$2)`, [f.spaceId, f.ownerIdentity]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
         ($2,$1,'member',null,0,$2), ($3,$1,'member',null,1,$2), ($4,$1,'team_member',null,2,$2),
         ($5,$1,'task',null,3,$2), ($6,$1,'task',null,4,$2), ($7,$1,'doc',null,5,$2),
         ($8,$1,'work_session',null,6,$2), ($9,$1,'work_session',null,7,$2), ($10,$1,'work_session',null,8,$2),
         ($11,$1,'work_session',null,9,$2), ($12,$1,'form',null,10,$2)`,
      KEYS.map((k) => f[k]),
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Owner'), ($4,$2,$5,'member','Other')`,
      [f.ownerId, f.spaceId, f.ownerIdentity, f.otherId, f.otherIdentity],
    );
    await client.query(`insert into public.team_members(entity_id, owner_member_id, name) values($1,$2,'Agent')`, [f.agentId, f.ownerId]);
    await client.query(
      `insert into public.tasks(entity_id,title,work_status) values($1,'Wire refund webhook','open'),($2,'Other task','open')`,
      [f.taskId, f.otherTaskId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values
         ($1,'live a','running','none',now()), ($2,'live b','idle','none',now()),
         ($3,'ended','exited','none',now()), ($4,'lone','running','none',now())`,
      [f.liveA, f.liveB, f.ended, f.lone],
    );
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values
         ($1,$2,$5,'working_on',$6), ($1,$3,$5,'working_on',$6), ($1,$4,$5,'working_on',$6), ($1,$7,$5,'attached_to',$6)`,
      [f.spaceId, f.liveA, f.liveB, f.ended, f.taskId, f.ownerId, f.formId],
    );
    return f;
  });
}

describe.sequential('attention v2 verbs (migration 256)', () => {
  let database: W1ScratchDatabase;
  let f: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('attention_v2_verbs');
    database.apply(migrationFiles());
    f = await seed(database);
  }, 240_000);

  afterAll(async () => database?.destroy(), 30_000);

  const q = <R extends Row>(sql: string, params: unknown[] = []) => database.query<R>(sql, params);

  /** One transaction as tm8_app under `identity`, the server's posture. */
  async function as<R extends Row>(identity: string, sql: string, params: unknown[] = []): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true), set_config('tm8.request_id', 'attention-s4', true)`,
        [identity],
      );
      return (await client.query<R>(sql, params)).rows;
    });
  }
  const rpc = async (identity: string, sql: string, params: unknown[] = []) =>
    (await as<{ r: Row }>(identity, `select ${sql} as r`, params))[0]!.r;

  let seq = 0;
  const cmid = () => `attention-s4-${++seq}`;

  /** An agent (the teammate) asks from `session`, pinned to `entity`. */
  const ask = (entity: string, reason: string, session: string | null, extra: { level?: string; type?: string; assignee?: string; points?: number } = {}) =>
    rpc(f.ownerIdentity,
      'public.create_attention_request($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [entity, reason, extra.points ?? null, f.agentId, cmid(), session, extra.level ?? null, extra.type ?? null, extra.assignee ?? null]);
  const resolve = (entity: string, note: string | null, identity = f.ownerIdentity, batch: string | null = null) =>
    rpc(identity, 'public.resolve_attention_root($1, $2, null, $3, $4)', [entity, note, cmid(), batch]);
  const statusOf = async (id: string) => (await q<{ status: string }>('select status from public.attention_requests where id = $1', [id]))[0]!.status;
  const messages = async () => Number((await q<{ n: string }>('select count(*) n from public.messages'))[0]!.n);
  const makeDue = (batch: string) => q(`update public.attention_requests set note_deliver_after = clock_timestamp() - interval '1 second' where resolution_batch_id = $1`, [batch]);
  const deliver = (batch: string, identity = f.ownerIdentity) => rpc(identity, 'public.deliver_attention_batch($1)', [batch]);
  const openCount = async () => Number((await q<{ n: string }>(`select count(*) n from public.attention_requests where space_id = $1 and status = 'open'`, [f.spaceId]))[0]!.n);
  /** R29: status has one writer; the fixture borrows its claim. */
  const setStatus = (session: string, status: string) => database.transaction(async (client) => {
    await client.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await client.query('update public.work_sessions set status = $2 where entity_id = $1', [session, status]);
  });
  const resetOpen = () => q(`update public.attention_requests set status = 'dismissed' where space_id = $1 and status = 'open'`, [f.spaceId]);

  describe('create', () => {
    it('stamps the source session, derives points from the level, and records type and assignee', async () => {
      const r = await ask(f.taskId, 'Pick retry policy', f.liveA, { level: 'high', type: 'approve', assignee: f.otherId });
      expect(r).toMatchObject({ entityId: f.taskId, affectedCount: 1, deduped: false });
      const [row] = await q<Row>('select * from public.attention_requests where id = $1', [r.attentionRequestId]);
      expect(row).toMatchObject({
        source_session_id: f.liveA, origin: 'agent', level: 'high', action_type: 'approve',
        assignee_id: f.otherId, points: 70, requested_by: f.agentId, status: 'open',
      });
      const fyi = await ask(f.docId, 'FYI only', null, { level: 'fyi' });
      expect((await q<{ points: number }>('select points from public.attention_requests where id = $1', [fyi.attentionRequestId]))[0]!.points).toBe(10);
      const plain = await ask(f.docId, 'defaults', null, { points: 55 });
      expect((await q<Row>('select points, level, action_type from public.attention_requests where id = $1', [plain.attentionRequestId]))[0])
        .toMatchObject({ points: 55, level: 'normal', action_type: 'decide' });
      await resetOpen();
    });

    it('dedupes the same session + reason while open, and a different reason is a new request (Q10)', async () => {
      const a = await ask(f.taskId, 'Same question', f.liveA);
      const b = await ask(f.taskId, '  Same question ', f.liveA);
      expect(b).toMatchObject({ attentionRequestId: a.attentionRequestId, affectedCount: 0, deduped: true });
      const c = await ask(f.taskId, 'Another question', f.liveA);
      expect(c.attentionRequestId).not.toBe(a.attentionRequestId);
      // Humans / no session are never deduped.
      const h1 = await ask(f.taskId, 'Same question', null);
      const h2 = await ask(f.taskId, 'Same question', null);
      expect(h1.attentionRequestId).not.toBe(h2.attentionRequestId);
      await resetOpen();
    });

    it('refuses a source session of another space, an unknown level, and a non-member assignee', async () => {
      await expect(ask(f.taskId, 'x', f.taskId)).rejects.toThrow(/source session/);
      await expect(ask(f.taskId, 'x', null, { level: 'loud' })).rejects.toThrow(/level/);
      await expect(ask(f.taskId, 'x', null, { assignee: f.agentId })).rejects.toThrow(/assignee/);
    });
  });

  describe('resolve / undo / delivery', () => {
    it('INV 1: resolving a root settles exactly its open own and rolled-up requests, nothing else', async () => {
      const own = await ask(f.taskId, 'own', null);
      const viaA = await ask(f.liveA, 'pinned to session A', f.liveA);
      const viaForm = await ask(f.formId, 'pinned to the form', null);
      const lone = await ask(f.lone, 'lone session', f.lone);
      const elsewhere = await ask(f.otherTaskId, 'other task', f.liveA);
      const doc = await ask(f.docId, 'doc', null);
      const r = await resolve(f.taskId, 'go');
      expect(r).toMatchObject({ entityId: f.taskId, affectedCount: 3 });
      expect(typeof r.resolutionBatchId).toBe('string');
      for (const x of [own, viaA, viaForm]) expect(await statusOf(x.attentionRequestId as string)).toBe('resolved');
      for (const x of [lone, elsewhere, doc]) expect(await statusOf(x.attentionRequestId as string)).toBe('open');
      const batch = await q<{ n: string }>('select count(*) n from public.attention_requests where resolution_batch_id = $1', [r.resolutionBatchId]);
      expect(batch[0]!.n).toBe('3');
      // Resolving a pinned NON-root (session A) resolves its root's set: here nothing is left.
      expect(await resolve(f.liveA, null)).toMatchObject({ entityId: f.taskId, affectedCount: 0, resolutionBatchId: null });
      await resetOpen();
    });

    it('INV 2: a resolve emits a full entity.upsert for the root and the pinned session, with the badge gone', async () => {
      await ask(f.liveB, 'badge probe', f.liveB);
      const mark = (await q<{ s: string | null }>('select max(seq)::text s from public.workspace_events where space_id = $1', [f.spaceId]))[0]!.s ?? '0';
      await resolve(f.taskId, null);
      const events = await q<{ id: string; event_type: string }>(
        `select payload->>'id' id, event_type from public.workspace_events
          where space_id = $1 and seq > $2::bigint and (payload->>'id')::uuid = any($3::uuid[])`,
        [f.spaceId, mark, [f.taskId, f.liveB]],
      );
      expect(events.filter((e) => e.id === f.taskId).map((e) => e.event_type)).toContain('entity.upsert');
      expect(events.filter((e) => e.id === f.liveB).map((e) => e.event_type)).toContain('entity.upsert');
      const badges = await q<Row>('select * from public.attention_badges($1::uuid[])', [[f.taskId, f.liveB]]);
      expect(badges).toEqual([]);
    });

    it('INV 3: Undo within 8s reopens the batch and delivers ZERO messages; after 8s it is refused', async () => {
      const a = await ask(f.taskId, 'undo me', f.liveA);
      const before = await messages();
      const r = await resolve(f.taskId, 'note that must never arrive');
      const u = await rpc(f.ownerIdentity, 'public.unresolve_attention_batch($1, null, $2)', [r.resolutionBatchId, cmid()]);
      expect(u).toMatchObject({ entityId: f.taskId, affectedCount: 1, resolutionBatchId: r.resolutionBatchId });
      expect(await statusOf(a.attentionRequestId as string)).toBe('open');
      const [row] = await q<Row>('select resolution_batch_id, note_deliver_after, resolved_by from public.attention_requests where id = $1', [a.attentionRequestId]);
      expect(row).toEqual({ resolution_batch_id: null, note_deliver_after: null, resolved_by: null });
      // The sweep finds nothing to deliver for the undone batch.
      expect(await deliver(r.resolutionBatchId as string)).toEqual({ posted: [] });
      expect(await messages()).toBe(before);

      const r2 = await resolve(f.taskId, null);
      await q(`update public.attention_requests set resolved_at = now() - interval '9 seconds' where resolution_batch_id = $1`, [r2.resolutionBatchId]);
      await expect(rpc(f.ownerIdentity, 'public.unresolve_attention_batch($1, null, $2)', [r2.resolutionBatchId, cmid()]))
        .rejects.toMatchObject({ code: 'TAC01' });
      await q(`update public.attention_requests set note_deliver_after = null where resolution_batch_id = $1`, [r2.resolutionBatchId]);
    });

    it('INV 3: only the resolver can undo, and a delivered batch cannot be undone', async () => {
      await ask(f.taskId, 'who undoes', null);
      const r = await resolve(f.taskId, null);
      await expect(rpc(f.otherIdentity, 'public.unresolve_attention_batch($1, null, $2)', [r.resolutionBatchId, cmid()]))
        .rejects.toMatchObject({ code: '42501' });
      await makeDue(r.resolutionBatchId as string);
      expect(((await deliver(r.resolutionBatchId as string)).posted as Row[]).length).toBe(1);
      await expect(rpc(f.ownerIdentity, 'public.unresolve_attention_batch($1, null, $2)', [r.resolutionBatchId, cmid()]))
        .rejects.toMatchObject({ code: 'TAC01' });
    });

    it('INV 4 + 5: one message per raising session per batch, ended/unknown folded onto the root, authored by the resolver', async () => {
      await ask(f.taskId, 'A first', f.liveA);
      await ask(f.liveA, 'A second', f.liveA);
      await ask(f.taskId, 'B only', f.liveB);
      await ask(f.taskId, 'from an ended session', f.ended);
      await ask(f.formId, 'no session at all', null);
      const before = await messages();
      const r = await resolve(f.taskId, 'exponential, cap 1h', f.otherIdentity);
      // Not due yet: nothing goes out inside the window.
      expect(await deliver(r.resolutionBatchId as string)).toEqual({ posted: [] });
      expect(await rpc(f.ownerIdentity, 'public.list_due_attention_notes(50)')).toEqual([]);

      await makeDue(r.resolutionBatchId as string);
      const due = await rpc(f.ownerIdentity, 'public.list_due_attention_notes(50)') as Row[];
      expect(due).toEqual([{ batchId: r.resolutionBatchId, spaceId: f.spaceId, resolverId: f.otherId, resolverIdentityId: f.otherIdentity }]);
      // The sweep posts as the RESOLVER's identity.
      const out = await deliver(r.resolutionBatchId as string, f.otherIdentity);
      const posted = (out.posted as Row[]).map((p) => [p.anchorId, (p.requestIds as string[]).length]).sort();
      expect(posted).toEqual([[f.liveA, 2], [f.liveB, 1], [f.taskId, 2]].sort());
      expect(await messages()).toBe(before + 3);

      const bodies = await q<{ anchor_id: string; body: string; author_id: string }>(
        `select m.anchor_id, m.body, m.author_id from public.messages m where m.entity_id = any($1::uuid[])`,
        [(out.posted as Row[]).map((p) => p.messageId)],
      );
      const byAnchor = Object.fromEntries(bodies.map((b) => [b.anchor_id, b]));
      expect(byAnchor[f.liveB]!.body).toBe('Attention resolved by Other: "B only"\n\nexponential, cap 1h');
      expect(byAnchor[f.liveA]!.body).toBe('Attention resolved by Other (2 requests):\n- "A first"\n- "A second"\n\nexponential, cap 1h');
      for (const b of bodies) expect(b.author_id).toBe(f.otherId);
      // note_message_id recorded; a second sweep posts nothing.
      expect((await q<{ n: string }>('select count(*) n from public.attention_requests where resolution_batch_id = $1 and note_message_id is null', [r.resolutionBatchId]))[0]!.n).toBe('0');
      expect(await deliver(r.resolutionBatchId as string, f.otherIdentity)).toEqual({ posted: [] });
    });

    it('R11: a resolve without a note still sends the one-line message', async () => {
      await ask(f.taskId, 'silent resolve', f.liveA);
      const r = await resolve(f.taskId, null);
      await makeDue(r.resolutionBatchId as string);
      const out = await deliver(r.resolutionBatchId as string);
      const [m] = await q<{ body: string }>('select body from public.messages where entity_id = $1', [(out.posted as Row[])[0]!.messageId]);
      expect(m!.body).toBe('Attention resolved by Owner: "silent resolve"');
    });

    it('a client batch id is echoed, and reusing one is refused', async () => {
      await ask(f.taskId, 'client batch', null);
      const batch = '11111111-1111-4111-8111-111111111111';
      const r = await resolve(f.taskId, null, f.ownerIdentity, batch);
      expect(r.resolutionBatchId).toBe(batch);
      await ask(f.taskId, 'client batch 2', null);
      await expect(resolve(f.taskId, null, f.ownerIdentity, batch)).rejects.toMatchObject({ code: 'TAC01' });
      await q(`update public.attention_requests set note_deliver_after = null where resolution_batch_id = $1`, [batch]);
      await resetOpen();
    });

    it('the legacy wrapper resolve_entity_attention resolves the root too', async () => {
      await ask(f.liveA, 'legacy wrapper', f.liveA);
      const r = await rpc(f.ownerIdentity, 'public.resolve_entity_attention($1, null, null, $2)', [f.taskId, cmid()]);
      expect(r).toMatchObject({ entityId: f.taskId, affectedCount: 1 });
      await q(`update public.attention_requests set note_deliver_after = null where resolution_batch_id = $1`, [r.resolutionBatchId]);
    });
  });

  describe('seen', () => {
    it('INV 6 + 7: Seen never changes status, counts, the badge or another member\'s view', async () => {
      await resetOpen();
      const a = await ask(f.taskId, 'seen probe', f.liveA);
      const b = await ask(f.liveB, 'seen probe rolled up', f.liveB);
      const badgeBefore = await q<Row>('select * from public.attention_badges($1::uuid[])', [[f.taskId]]);
      const versionBefore = await q<Row>('select id, version, status from public.attention_requests where id = any($1::uuid[]) order by id', [[a.attentionRequestId, b.attentionRequestId]]);
      const seen = await rpc(f.ownerIdentity, 'public.mark_attention_seen($1, $2)', [f.liveA, cmid()]);
      expect(seen).toMatchObject({ entityId: f.taskId, affectedCount: 2 });
      expect(await rpc(f.ownerIdentity, 'public.mark_attention_seen($1, $2)', [f.taskId, cmid()])).toMatchObject({ affectedCount: 0 });
      expect(await q<Row>('select id, version, status from public.attention_requests where id = any($1::uuid[]) order by id', [[a.attentionRequestId, b.attentionRequestId]])).toEqual(versionBefore);
      expect(await q<Row>('select * from public.attention_badges($1::uuid[])', [[f.taskId]])).toEqual(badgeBefore);
      // Owner sees both as seen; Other sees neither.
      const mine = await as<{ n: string }>(f.ownerIdentity, 'select count(*) n from public.attention_seen');
      const theirs = await as<{ n: string }>(f.otherIdentity, 'select count(*) n from public.attention_seen');
      expect(mine[0]!.n).toBe('2');
      expect(theirs[0]!.n).toBe('0');
      expect(await openCount()).toBe(2);
    });

    it('update_attention_request(acknowledged) writes Seen and leaves the row alone', async () => {
      const a = await ask(f.docId, 'legacy ack', null);
      const [before] = await q<Row>('select version, status from public.attention_requests where id = $1', [a.attentionRequestId]);
      await rpc(f.otherIdentity, `public.update_attention_request($1, $2, null, null, 'acknowledged', null, null, $3)`, [a.attentionRequestId, before!.version, cmid()]);
      expect((await q<Row>('select version, status from public.attention_requests where id = $1', [a.attentionRequestId]))[0]).toEqual(before);
      expect((await as<{ n: string }>(f.otherIdentity, 'select count(*) n from public.attention_seen where request_id = $1', [a.attentionRequestId]))[0]!.n).toBe('1');
      await expect(rpc(f.ownerIdentity, `public.update_attention_request($1, $2, null, null, 'cleared', null, null, $3)`, [a.attentionRequestId, before!.version, cmid()]))
        .rejects.toThrow(/invalid attention status/);
    });
  });

  describe('withdraw', () => {
    it('the raising agent withdraws its own open agent row; nobody else can, and nothing is delivered', async () => {
      const a = await ask(f.taskId, 'withdraw me', f.liveA);
      const before = await messages();
      await expect(rpc(f.ownerIdentity, 'public.withdraw_attention_request($1, null, null, $2)', [a.attentionRequestId, cmid()]))
        .rejects.toMatchObject({ code: '42501' });
      const w = await rpc(f.ownerIdentity, 'public.withdraw_attention_request($1, null, $2, $3)', [a.attentionRequestId, f.agentId, cmid()]);
      expect(w).toMatchObject({ attentionRequestId: a.attentionRequestId, entityId: f.taskId, affectedCount: 1 });
      expect(await statusOf(a.attentionRequestId as string)).toBe('dismissed');
      await expect(rpc(f.ownerIdentity, 'public.withdraw_attention_request($1, null, $2, $3)', [a.attentionRequestId, f.agentId, cmid()]))
        .rejects.toMatchObject({ code: 'TAC01' });
      const human = await rpc(f.ownerIdentity, 'public.create_attention_request($1, $2, null, null, $3)', [f.taskId, 'human ask', cmid()]);
      await expect(rpc(f.ownerIdentity, 'public.withdraw_attention_request($1, null, null, $2)', [human.attentionRequestId, cmid()]))
        .rejects.toMatchObject({ code: 'TAC01' });
      expect(await messages()).toBe(before);
    });
  });

  describe('raised-by marker', () => {
    it('INV 8: the raising session carries the marker while pinned to the task, through Seen and the session ending, and loses it on resolve or withdraw', async () => {
      await resetOpen();
      const raised = async (id: string) => (await q<{ n: number | null }>(
        'select raised_pending_count n from public.attention_badges($1::uuid[]) where entity_id = $2', [[id], id]))[0]?.n ?? 0;
      const a = await ask(f.taskId, 'marker probe', f.liveB);
      expect(await raised(f.liveB)).toBe(1);
      await rpc(f.ownerIdentity, 'public.mark_attention_seen($1, $2)', [f.taskId, cmid()]);
      expect(await raised(f.liveB)).toBe(1);
      await setStatus(f.liveB, 'exited');
      expect(await raised(f.liveB)).toBe(1);
      await setStatus(f.liveB, 'idle');
      const r = await resolve(f.taskId, null);
      expect(await raised(f.liveB)).toBe(0);
      await rpc(f.ownerIdentity, 'public.unresolve_attention_batch($1, null, $2)', [r.resolutionBatchId, cmid()]);
      expect(await raised(f.liveB)).toBe(1);
      await rpc(f.ownerIdentity, 'public.withdraw_attention_request($1, null, $2, $3)', [a.attentionRequestId, f.agentId, cmid()]);
      expect(await raised(f.liveB)).toBe(0);
    });
  });
});
