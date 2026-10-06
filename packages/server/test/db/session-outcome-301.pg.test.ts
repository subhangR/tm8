/**
 * 301 against a real Postgres: a session's OUTCOME is separate from its
 * PROCESS, and a `working_on` claim has a lifetime (Spec D1, doc 01a110ab).
 *
 * Each `it` names the spec §9 scenario it covers (S1..S29) where one applies.
 * The UI-only scenarios (tabs, chips, dialogs) are covered in tm8-ui; this file
 * owns everything the database decides: the outcome, the category, the claim
 * ends, the refusals and the events.
 *
 * Every session here is made through the real `execution_spawn` door, as
 * tm8_app, so the anchor claim, the task start and the concurrency cap are the
 * product's own. An agent's own calls are made with `tm8.work_session_id` set,
 * the claim the server forwards from a verified agent bearer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

let database: W1ScratchDatabase;
let fixture: Fixture;
let unique = 0;
const cmid = (label: string): string => `outcome-299-${label}-${(unique += 1)}`;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'outcome-299-owner'::text "identityId", internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId", internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Owner')`, [
      f.identityId,
    ]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Outcomes',$2)`, [
      f.spaceId,
      f.identityId,
    ]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Worker','','persona')`,
      [f.teamMemberId, f.memberId],
    );
    return f;
  });
}

/**
 * As tm8_app. `asSession` makes the call the way an agent inside that session
 * does: acting as its teammate, with the verified work-session claim set.
 */
async function asApp<T>(fn: (q: Q) => Promise<T>, asSession?: string): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id',$2,true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-299',true),
              set_config('tm8.work_session_id',$3,true)`,
      [fixture.identityId, asSession ? fixture.teamMemberId : '', asSession ?? ''],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/** Postgres error → `{code, reason}` so refusals can be asserted by their named reason. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: string | undefined; detail: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; detail?: string };
    let detail: unknown = e.detail;
    try {
      detail = e.detail ? JSON.parse(e.detail) : undefined;
    } catch {
      /* plain-text detail */
    }
    return { code: e.code ?? '', reason: (detail as { reason?: string } | undefined)?.reason, detail };
  }
  throw new Error('expected a refusal, the call succeeded');
}

async function createTask(title: string): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,null,'',$3::jsonb,null,null,'medium','[]'::jsonb,null,null,null,null,'attached_to',$4) result`,
      [fixture.spaceId, title, '{}', cmid('task')],
    ),
  );
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
}

async function spawn(taskIds: string[], cap = 64): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => $3::uuid[],
         p_workdir_mode => 'scratch', p_model => 'claude-opus-5', p_agent_tool => 'claude',
         p_title => 'Run', p_node_id => 'node-local', p_confirm_untrusted => true,
         p_session_cap => $4, p_client_mutation_id => $5) result`,
      [fixture.spaceId, fixture.teamMemberId, taskIds, cap, cmid('spawn')],
    ),
  );
  const id = (rows[0]!.result as { entity: { id: string } }).entity.id;
  await settle(id);
  return id;
}

/** The launcher records the credential binding before the PTY runs (273). */
async function settle(id: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `select internal.settle_credential_binding($1, '{"effectiveCredentialSources":{"anthropic":"node"}}'::jsonb)`,
      [id],
    );
  });
}

async function transition(sessionId: string, status: string, endedKind: string | null = null): Promise<void> {
  await asApp((q) =>
    q(`select public.work_session_transition($1,$2,null,null,null,$3,$4,null)`, [
      sessionId,
      status,
      cmid(status),
      endedKind,
    ]),
  );
}

async function running(taskIds: string[]): Promise<string> {
  const id = await spawn(taskIds);
  await transition(id, 'running');
  return id;
}

/**
 * A message on `anchorId`, written as the owner. The post door is not what is
 * under test, and the legacy `post_message` is not granted to tm8_app; the row
 * shape is what `w2_post_message_batch` writes. `asSession` makes the agent the
 * author (its teammate), as an agent's own `tm8 message send` would.
 */
async function post(anchorId: string, body: string, asSession?: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const author = asSession ? fixture.teamMemberId : fixture.memberId;
    const id = (
      await client.query<{ id: string }>(
        `insert into public.entities(space_id,kind,parent_id,position,created_by)
         values($1,'message',null,0,$2) returning id`,
        [fixture.spaceId, author],
      )
    ).rows[0]!.id;
    await client.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)`,
      [id, anchorId, author, body],
    );
    return id;
  });
}

async function setWork(taskId: string, status: string, opts: { claim?: boolean; asSession?: string } = {}) {
  return asApp(
    (q) =>
      q(`select public.set_work_state($1,$2,null,null,null,$3,false,$4) result`, [
        taskId,
        status,
        cmid('work'),
        opts.claim ?? false,
      ]),
    opts.asSession,
  );
}

async function completeTask(taskId: string): Promise<void> {
  const v = await database.query<{ version: number }>(`select version from public.entities where id=$1`, [taskId]);
  await asApp((q) => q(`select public.complete_task($1,$2,'{}',null,$3)`, [taskId, v[0]!.version, cmid('done')]));
}

const complete = (sessionId: string, receipt: string | null = null, asSession?: string) =>
  asApp(
    (q) => q(`select public.complete_work_session($1,$2,null,$3) result`, [sessionId, receipt, cmid('complete')]),
    asSession,
  );
const stop = (sessionId: string, note: string | null = null) =>
  asApp((q) => q(`select public.stop_work_session($1,$2,null,$3) result`, [sessionId, note, cmid('stop')]));
async function resume(sessionId: string): Promise<void> {
  await asApp((q) => q(`select public.execution_resume($1,64,null,$2,null) result`, [sessionId, cmid('resume')]));
  await settle(sessionId);
}

interface SessionRow {
  status: string;
  outcome: string;
  ended_kind: string | null;
  outcome_source: string | null;
  receipt_message_id: string | null;
  category: string;
}
async function session(id: string): Promise<SessionRow> {
  const rows = await database.query<SessionRow>(
    `select ws.status, ws.outcome, ws.ended_kind, ws.outcome_source, ws.receipt_message_id,
            e.status_category category
       from public.work_sessions ws join public.entities e on e.id = ws.entity_id where ws.entity_id=$1`,
    [id],
  );
  return rows[0]!;
}

interface ClaimRow {
  src_id: string;
  dst_id: string;
  status: string | null;
  ended_at: string | null;
  end_reason: string | null;
  handoff: string | null;
  end_note: string | null;
}
async function claims(where: { src?: string; dst?: string }): Promise<ClaimRow[]> {
  return database.query<ClaimRow>(
    `select src_id, dst_id, props->>'status' status, props->>'endedAt' ended_at,
            props->>'endReason' end_reason, props->>'handoffMessageId' handoff, props->>'endNote' end_note
       from public.edges where type='working_on'
        and ($1::uuid is null or src_id=$1) and ($2::uuid is null or dst_id=$2)
      order by created_at`,
    [where.src ?? null, where.dst ?? null],
  );
}
const active = (rows: ClaimRow[]) => rows.filter((r) => r.ended_at === null);

async function events(type: string, id: string): Promise<Record<string, unknown>[]> {
  const rows = await database.query<{ payload: Record<string, unknown> }>(
    `select payload from public.workspace_events where event_type=$1 and payload->>'id'=$2 order by seq`,
    [type, id],
  );
  return rows.map((r) => r.payload);
}

async function taskStatus(id: string): Promise<string> {
  return (await database.query<{ s: string }>(`select work_status s from public.tasks where entity_id=$1`, [id]))[0]!.s;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session-outcome-301');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

// ---------------------------------------------------------------------------
// The two fields (ac1)
// ---------------------------------------------------------------------------

describe('299 — outcome and process are separate fields', () => {
  it('a new session is open, and its category follows the process while open', async () => {
    const t = await createTask('open-cat');
    const s = await spawn([t]);
    expect(await session(s)).toMatchObject({ outcome: 'open', status: 'spawning', category: 'to_do' });
    await transition(s, 'running');
    expect((await session(s)).category).toBe('in_progress');
  });

  it('S1/S3/S4: complete leaves the process running; a later crash or exit never rewrites the outcome', async () => {
    const t = await createTask('s1');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'Close-out: PR open, in review.', s);
    await complete(s, null, s);
    expect(await session(s)).toMatchObject({
      outcome: 'completed',
      status: 'running',
      category: 'done',
      outcome_source: 'self',
    });
    expect(active(await claims({ src: s }))).toHaveLength(0);

    // S3: the completed session's process crashes.
    await transition(s, 'failed', 'crashed');
    expect(await session(s)).toMatchObject({ outcome: 'completed', status: 'failed', category: 'done' });
    // S4: a late process event — only process fields move.
    await transition(s, 'failed', 'unknown');
    expect((await session(s)).outcome).toBe('completed');
  });

  it('S2/S4: after completion, closing the process moves only the process fields; the task gets no event', async () => {
    const t = await createTask('s2');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'Close-out: done, in review.', s);
    await complete(s, null, s);
    const aboutTask = async () =>
      Number(
        (await database.query<{ n: number }>(
          `select count(*)::int n from public.workspace_events where payload::text like '%' || $1 || '%'`,
          [t],
        ))[0]!.n,
      );
    const before = await aboutTask();
    // Stop on the ✓ row (§13.7: a terminate after completion records exited_clean),
    // or the same process exit arriving late.
    await transition(s, 'exited', 'exited_clean');
    expect(await session(s)).toMatchObject({
      outcome: 'completed',
      status: 'exited',
      ended_kind: 'exited_clean',
      category: 'done',
    });
    expect(await events('session.outcome_changed', s)).toHaveLength(1);
    expect(await aboutTask()).toBe(before);
    expect(await taskStatus(t)).toBe('in_review');
  });

  it('the outcome has a single writer: a direct update is refused', async () => {
    const s = await running([await createTask('guard')]);
    const r = await refusal(
      database.transaction(async (c) => {
        await c.query('set local role tm8_graph_owner');
        await c.query(`update public.work_sessions set outcome='stopped', outcome_at=now(), outcome_source='operator' where entity_id=$1`, [s]);
      }),
    );
    expect(r.code).toBe('23514');
  });

  it('S11: a clean exit (code 0) without completion is exited_clean, open, in_progress', async () => {
    const s = await running([await createTask('s11')]);
    await transition(s, 'exited', 'completed'); // the pre-299 spelling is accepted and renamed
    expect(await session(s)).toMatchObject({
      outcome: 'open',
      status: 'exited',
      ended_kind: 'exited_clean',
      category: 'in_progress',
    });
  });

  it('S14 + ac4: every end kind of the new vocabulary is accepted and stored as given', async () => {
    for (const kind of ['container_stopped', 'runtime_lost', 'lost', 'credential_revoked', 'server_restart']) {
      const s = await running([await createTask(`kind-${kind}`)]);
      await transition(s, 'failed', kind);
      expect(await session(s)).toMatchObject({ ended_kind: kind, outcome: 'open', category: 'in_progress' });
    }
    const s = await running([await createTask('kind-bad')]);
    expect((await refusal(transition(s, 'failed', 'vanished'))).code).toBe('22023');
  });
});

// ---------------------------------------------------------------------------
// session complete: the receipt rule and the claim check (ac2)
// ---------------------------------------------------------------------------

describe('299 — session complete', () => {
  it('S13: with no message on its anchor, complete refuses receipt_required and changes nothing', async () => {
    const t = await createTask('s13');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    const r = await refusal(complete(s, null, s));
    expect(r.reason).toBe('receipt_required');
    expect((await session(s)).outcome).toBe('open');
  });

  it('an explicit receipt must sit on the session anchor', async () => {
    const t = await createTask('receipt-anchor');
    const elsewhere = await createTask('receipt-elsewhere');
    const s = await running([t]);
    await setWork(t, 'blocked', { asSession: s });
    const offAnchor = await post(elsewhere, 'not here', s);
    expect((await refusal(complete(s, offAnchor))).reason).toBe('receipt_not_on_anchor');
    const onAnchor = await post(t, 'Operator receipt: blocked on access.');
    const res = (await complete(s, onAnchor))[0]!.result as { outcome: { receiptMessageId: string } };
    expect(res.outcome.receiptMessageId).toBe(onAnchor);
    expect(await session(s)).toMatchObject({ outcome: 'completed', outcome_source: 'operator', receipt_message_id: onAnchor });
  });

  it('S17: complete with a claim still working refuses claims_open, listing that task', async () => {
    const t = await createTask('s17');
    const s = await running([t]);
    await post(t, 'trying to finish', s);
    const r = await refusal(complete(s, null, s));
    expect(r.reason).toBe('claims_open');
    expect((r.detail as { tasks: { taskId: string }[] }).tasks.map((x) => x.taskId)).toEqual([t]);
    expect((await session(s)).outcome).toBe('open');
  });

  it('S18 (+Q7): claims in_review and blocked end with session_completed; tasks keep status; receipt is the hand-off', async () => {
    const a = await createTask('s18-a');
    const b = await createTask('s18-b');
    const s = await running([a, b]);
    await setWork(a, 'in_review', { asSession: s });
    await setWork(b, 'blocked', { asSession: s });
    const receipt = await post(a, 'Close-out: A in review (PR), B blocked on the vendor answer.', s);
    await complete(s, receipt, s);
    const rows = await claims({ src: s });
    expect(rows.map((r) => r.end_reason)).toEqual(['session_completed', 'session_completed']);
    expect(rows.every((r) => r.handoff === receipt)).toBe(true);
    expect([await taskStatus(a), await taskStatus(b)]).toEqual(['in_review', 'blocked']);
  });

  it('complete is idempotent, and a stopped session must be resumed before completing', async () => {
    const t = await createTask('idem');
    const s = await running([t]);
    await setWork(t, 'blocked', { asSession: s });
    await post(t, 'done for now', s);
    await complete(s, null, s);
    const again = (await complete(s, null, s))[0]!.result as { outcome: { alreadyCompleted: boolean } };
    expect(again.outcome.alreadyCompleted).toBe(true);

    const s2 = await running([await createTask('stopped-complete')]);
    await stop(s2);
    expect((await refusal(complete(s2))).reason).toBe('session_stopped');
  });

  it('the row tick (set_session_done) is session complete and cannot be un-ticked (Q2 A)', async () => {
    const t = await createTask('tick');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'ticked close-out', s);
    const version = async () =>
      (await database.query<{ v: number }>(`select version v from public.entities where id=$1`, [s]))[0]!.v;
    const v = await version();
    await asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [s, v, cmid('tick')]));
    expect((await session(s)).outcome).toBe('completed');
    const r = await refusal(asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [s, v + 1, cmid('untick')])));
    expect(r.reason).toBe('session_completed');
  });
});

// ---------------------------------------------------------------------------
// Completed sessions: no new work, no resume (ac2, Q2)
// ---------------------------------------------------------------------------

describe('301 — completion is a status marker (owner ruling 6 Oct)', () => {
  it('S5 (owner ruling 6 Oct): --claim from a completed session REOPENS it — completion is a marker, not a gate', async () => {
    const t = await createTask('s5');
    const other = await createTask('s5-other');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    const receipt = await post(t, 'close-out', s);
    await complete(s, null, s);
    await setWork(other, 'working', { claim: true, asSession: s });
    expect(await session(s)).toMatchObject({ outcome: 'open', outcome_source: 'self', receipt_message_id: null, category: 'in_progress' });
    expect(active(await claims({ src: s })).map((c) => c.dst_id)).toEqual([other]);
    const logged = await database.query<{ summary: Record<string, unknown> }>(
      `select summary from public.activity where entity_id=$1 and summary->>'action'='reopened'`,
      [s],
    );
    expect(logged[0]!.summary).toMatchObject({ cause: 'claimed_task', fromOutcome: 'completed', priorReceiptMessageId: receipt, subjectId: other });
    const ev = await events('session.outcome_changed', s);
    expect(ev.at(-1)).toMatchObject({ from: 'completed', to: 'open', outcomeSource: 'self' });
  });

  it('Q2 = B: resume reopens a completed session — open again, logged with the receipt it had', async () => {
    const t = await createTask('reopen');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    const receipt = await post(t, 'close-out', s);
    await complete(s, null, s);
    await transition(s, 'exited', 'exited_clean');
    await resume(s);
    expect(await session(s)).toMatchObject({ outcome: 'open', status: 'spawning', category: 'to_do', receipt_message_id: null });
    const logged = await database.query<{ summary: Record<string, unknown> }>(
      `select summary from public.activity where entity_id=$1 and summary->>'action'='resumed'`,
      [s],
    );
    expect(logged[0]!.summary).toMatchObject({ reopened: true, fromOutcome: 'completed', priorReceiptMessageId: receipt });
    // Reopened, it may claim work again.
    const next = await createTask('reopen-next');
    await transition(s, 'running');
    await setWork(next, 'working', { claim: true, asSession: s });
    expect(active(await claims({ src: s })).map((c) => c.dst_id)).toEqual([next]);
  });

  it('only resume reopens: a direct outcome write on a completed row is refused', async () => {
    const t = await createTask('final');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'close-out', s);
    await complete(s, null, s);
    const r = await refusal(
      database.transaction(async (c) => {
        await c.query(`select set_config('tm8.work_session_outcome','on',true)`);
        await c.query(`update public.work_sessions set outcome='open', outcome_at=null, outcome_source=null, receipt_message_id=null where entity_id=$1`, [s]);
      }),
    );
    expect(r.reason).toBe('session_completed');
  });
});

// ---------------------------------------------------------------------------
// Stop and resume (ac2, ac3)
// ---------------------------------------------------------------------------

describe('299 — stop and resume', () => {
  it('S6: stop ends claims with session_stopped; the task keeps its status; category cancelled', async () => {
    const t = await createTask('s6');
    const s = await running([t]);
    await stop(s, 'Not needed any more');
    expect(await session(s)).toMatchObject({ outcome: 'stopped', category: 'cancelled', status: 'running' });
    expect((await claims({ src: s }))[0]).toMatchObject({ end_reason: 'session_stopped' });
    expect(await taskStatus(t)).toBe('working');
    // A completed session cannot be stopped.
    const t2 = await createTask('s6-completed');
    const s2 = await running([t2]);
    await setWork(t2, 'in_review', { asSession: s2 });
    await post(t2, 'close-out', s2);
    await complete(s2, null, s2);
    expect((await refusal(stop(s2))).reason).toBe('session_completed');
  });

  it('S12: a stopped session resumed is open again, spawning, to_do — and the log says so', async () => {
    const s = await running([await createTask('s12')]);
    await stop(s);
    await transition(s, 'exited', 'stopped_by_operator');
    await resume(s);
    expect(await session(s)).toMatchObject({ outcome: 'open', status: 'spawning', category: 'to_do' });
    const logged = await database.query<{ summary: { reopened: boolean; fromOutcome: string } }>(
      `select summary from public.activity where entity_id=$1 and summary->>'action'='resumed'`,
      [s],
    );
    expect(logged[0]!.summary).toMatchObject({ reopened: true, fromOutcome: 'stopped' });
  });

  it('S8/S20: a crash keeps every claim; resume continues them; stop then ends them with session_stopped', async () => {
    const a = await createTask('s20-a');
    const b = await createTask('s20-b');
    const s = await running([a, b]);
    await transition(s, 'failed', 'crashed');
    expect(await session(s)).toMatchObject({ outcome: 'open', category: 'in_progress' });
    expect(active(await claims({ src: s }))).toHaveLength(2);
    await resume(s);
    await transition(s, 'running');
    expect(active(await claims({ src: s }))).toHaveLength(2);
    await transition(s, 'failed', 'out_of_memory');
    await stop(s);
    expect((await claims({ src: s })).map((r) => r.end_reason)).toEqual(['session_stopped', 'session_stopped']);
  });

  it('S9: credential revoked is a process fact; the outcome stays open', async () => {
    const s = await running([await createTask('s9')]);
    await transition(s, 'failed', 'credential_revoked');
    expect(await session(s)).toMatchObject({ outcome: 'open', ended_kind: 'credential_revoked', category: 'in_progress' });
  });

  it('S10: the reaper writes lost; the outcome stays open', async () => {
    const s = await running([await createTask('s10')]);
    await transition(s, 'failed', 'lost');
    expect(await session(s)).toMatchObject({ outcome: 'open', ended_kind: 'lost' });
  });
});

// ---------------------------------------------------------------------------
// The claim lifecycle (ac3)
// ---------------------------------------------------------------------------

describe('299 — claims follow their task', () => {
  it('spawn claims are status=working with a startedAt', async () => {
    const t = await createTask('spawn-props');
    const s = await spawn([t]);
    const [c] = await claims({ src: s });
    expect(c).toMatchObject({ status: 'working', ended_at: null });
  });

  it('S15: completing task A ends only A’s claim (task_done); B stays active', async () => {
    const a = await createTask('s15-a');
    const b = await createTask('s15-b');
    const s = await running([a, b]);
    await completeTask(a);
    const rows = await claims({ src: s });
    expect(rows.find((r) => r.dst_id === a)).toMatchObject({ end_reason: 'task_done' });
    expect(rows.find((r) => r.dst_id === b)).toMatchObject({ ended_at: null });
  });

  it('S21: someone else marking a task done ends every claim on it (R9)', async () => {
    const t = await createTask('s21');
    const s1 = await running([t]);
    const s2 = await running([t]);
    await completeTask(t); // the owner, not either session
    const rows = await claims({ dst: t });
    expect(rows.filter((r) => r.src_id === s1 || r.src_id === s2).map((r) => r.end_reason)).toEqual([
      'task_done',
      'task_done',
    ]);
  });

  it('cancel ends claims with task_cancelled; back to open ends them with task_reset', async () => {
    const a = await createTask('cancel');
    const b = await createTask('reset');
    const s = await running([a, b]);
    await setWork(a, 'cancelled');
    await setWork(b, 'open');
    const rows = await claims({ src: s });
    expect(rows.find((r) => r.dst_id === a)!.end_reason).toBe('task_cancelled');
    expect(rows.find((r) => r.dst_id === b)!.end_reason).toBe('task_reset');
  });

  it('the claim status follows the task (in_review -> working on changes requested)', async () => {
    const t = await createTask('follow');
    const s = await running([t]);
    await setWork(t, 'in_review');
    expect((await claims({ src: s }))[0]!.status).toBe('in_review');
    await setWork(t, 'working');
    expect((await claims({ src: s }))[0]!.status).toBe('working');
  });

  it('S22: release ends the claim with released and the note; the task keeps its status', async () => {
    const t = await createTask('s22');
    const s = await running([t]);
    await asApp(
      (q) => q(`select public.release_task_claim($1,$2,null,$3)`, [t, 'needs DB access', cmid('release')]),
      s,
    );
    expect((await claims({ src: s }))[0]).toMatchObject({ end_reason: 'released', end_note: 'needs DB access' });
    expect(await taskStatus(t)).toBe('working');
    // Nothing left to release; a note is required.
    expect(
      (await refusal(asApp((q) => q(`select public.release_task_claim($1,'x',null,$2)`, [t, cmid('r2')]), s))).reason,
    ).toBe('no_claim');
    expect(
      (await refusal(asApp((q) => q(`select public.release_task_claim($1,' ',null,$2)`, [t, cmid('r3')]), s))).code,
    ).toBe('22023');
  });

  it('a session --claim is the SESSION’s claim, and re-claiming an ended claim reopens it fresh', async () => {
    const t = await createTask('reclaim');
    const s = await running([]);
    await setWork(t, 'working', { claim: true, asSession: s });
    expect(active(await claims({ src: s }))).toHaveLength(1);
    await asApp((q) => q(`select public.release_task_claim($1,'later',null,$2)`, [t, cmid('rel')]), s);
    await setWork(t, 'working', { claim: true, asSession: s });
    const [c] = await claims({ src: s });
    expect(c).toMatchObject({ ended_at: null, end_reason: null, end_note: null });
    // No team-member-sourced claim was written.
    expect((await claims({ src: fixture.teamMemberId })).length).toBe(0);
  });

  it('S19: a task left in_review by a completed session, completed later by someone else: done, no claim touched', async () => {
    const t = await createTask('s19');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'PR open', s);
    await complete(s, null, s);
    const before = await claims({ src: s });
    await completeTask(t);
    expect(await taskStatus(t)).toBe('done');
    expect(await claims({ src: s })).toEqual(before);
  });

  it('edge.ended is emitted once per ended claim', async () => {
    const t = await createTask('edge-ended');
    const s = await running([t]);
    await completeTask(t);
    const ended = await database.query<{ n: string }>(
      `select count(*) n from public.workspace_events where event_type='edge.ended' and payload->>'src_id'=$1`,
      [s],
    );
    expect(Number(ended[0]!.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Events (ac4) and the limit (ac5)
// ---------------------------------------------------------------------------

describe('299 — events and the concurrency limit', () => {
  it('session.process_changed and session.outcome_changed carry from/to', async () => {
    const t = await createTask('events');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    const receipt = await post(t, 'events close-out', s);
    await complete(s, null, s);
    await transition(s, 'exited', 'exited_clean');
    const proc = await events('session.process_changed', s);
    expect(proc.map((p) => `${String(p.from)}->${String(p.to)}`)).toEqual(['spawning->running', 'running->exited']);
    expect(proc[1]).toMatchObject({ endedKind: 'exited_clean', outcome: 'completed' });
    const out = await events('session.outcome_changed', s);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 'open', to: 'completed', receiptMessageId: receipt, outcomeSource: 'self' });
  });

  it('S28: a completed session does not count toward the cap', async () => {
    const used = Number(
      (await database.query<{ n: number }>(`select internal.live_work_session_count(null) n`))[0]!.n,
    );
    const t = await createTask('cap');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'cap close-out', s);
    expect(Number((await database.query<{ n: number }>(`select internal.live_work_session_count(null) n`))[0]!.n)).toBe(
      used + 1,
    );
    await complete(s, null, s);
    expect(Number((await database.query<{ n: number }>(`select internal.live_work_session_count(null) n`))[0]!.n)).toBe(
      used,
    );
    // With the cap exactly full of open sessions + this ✓ one, a spawn still succeeds.
    await expect(spawn([await createTask('cap-next')], used + 1)).resolves.toBeTruthy();
  });

  it('the category rule holds for every session row (spec §3.2)', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*) n from public.entities e join public.work_sessions ws on ws.entity_id=e.id
        where e.status_category is distinct from internal.session_category(ws.outcome, ws.status)`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-close (owner ruling Q3) — which completed sessions the node closes
// ---------------------------------------------------------------------------

describe('301 — completed_sessions_to_close (Q3)', () => {
  async function completedAgo(label: string, minutes: number): Promise<string> {
    const t = await createTask(label);
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    await post(t, 'close-out', s);
    await complete(s, null, s);
    await database.transaction(async (c) => {
      await c.query(`select set_config('tm8.work_session_outcome','on',true)`);
      await c.query(`update public.work_sessions set outcome_at = now() - make_interval(mins => $2) where entity_id = $1`, [s, minutes]);
      await c.query(`update public.entities set activity_at = now() - make_interval(mins => $2) where id = $1`, [s, minutes]);
    });
    return s;
  }
  const due = async (): Promise<string[]> =>
    (await asApp((q) => q(`select session_id from public.completed_sessions_to_close('node-local')`))).map(
      (r) => r.session_id as string,
    );
  const setWindow = (minutes: number) =>
    database.query(`update public.spaces set session_autoclose_minutes = $2 where id = $1`, [fixture.spaceId, minutes]);

  it('lists a completed live session idle past the 30-minute default, not one inside it', async () => {
    await setWindow(30);
    const old = await completedAgo('ac-old', 45);
    const fresh = await completedAgo('ac-fresh', 5);
    const listed = await due();
    expect(listed).toContain(old);
    expect(listed).not.toContain(fresh);
  });

  it('0 means never', async () => {
    const s = await completedAgo('ac-never', 120);
    await setWindow(0);
    expect(await due()).not.toContain(s);
    await setWindow(30);
  });

  it('never closes a session that still has running children (D2 follow-on)', async () => {
    const parent = await completedAgo('ac-parent', 60);
    const child = await spawn([await createTask('ac-child')]);
    await database.query(`update public.entities set parent_id = $2 where id = $1`, [child, parent]);
    expect(await due()).not.toContain(parent);
  });
});

// ---------------------------------------------------------------------------
// Spec D1 R1 / scenario 16 — OFFERED tasks on the session summary
// ---------------------------------------------------------------------------

describe('302 — offeredTaskIds: handed to the session, not claimed (scenario 16)', () => {
  async function handoff(taskId: string, sessionId: string, withdrawn = false): Promise<void> {
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(
        `insert into public.session_handoffs(handoff_id, source_entity_id, target_work_session_id,
           delivery_status, record_status, request_hash, source_snapshot, envelope_hash,
           identity_id, request_id, author_id, source_space_id, resolved_content_version,
           withdrawn_at, withdraw_reason, withdrawn_by)
         values ($1, $2, $3, 'delivered', $4, 'h', '{}'::jsonb, 'e', $5, 'req', $6, $7, 1,
                 case when $8 then now() end, case when $8 then 'not needed' end,
                 case when $8 then $6::uuid end)`,
        [cmid('handoff'), taskId, sessionId, withdrawn ? 'withdrawn' : 'recorded',
         fixture.identityId, fixture.memberId, fixture.spaceId, withdrawn],
      );
    });
  }
  async function offered(sessionId: string): Promise<string[] | undefined> {
    return database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      const q: Querier = {
        query: async <R>(sql: string, params: readonly unknown[] = []) => (await c.query(sql, [...params])).rows as R[],
        rpc: async () => { throw new Error('read only'); },
      };
      const [summary] = await loadEntitySummariesByIds(q, [sessionId], fixture.identityId);
      return (summary!.state as { offeredTaskIds?: string[] }).offeredTaskIds;
    });
  }

  it('a handed-off task is offered — not a claim, no working_on — until the session claims it', async () => {
    const own = await createTask('offer-own');
    const extra = await createTask('offer-extra');
    const s = await running([own]);
    await handoff(extra, s);
    expect(await offered(s)).toEqual([extra]);
    expect(active(await claims({ src: s })).map((c) => c.dst_id)).toEqual([own]);

    await setWork(extra, 'working', { claim: true, asSession: s });
    expect(await offered(s)).toEqual([]);
  });

  it('a withdrawn handoff offers nothing', async () => {
    const t = await createTask('offer-withdrawn');
    const s = await running([]);
    await handoff(t, s, true);
    expect(await offered(s)).toEqual([]);
  });
});

