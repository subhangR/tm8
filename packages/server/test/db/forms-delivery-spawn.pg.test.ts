/**
 * Forms W2 — spawn modes (migration 215; facade/services/w2/form-delivery-spawn.ts),
 * end to end against a real scratch database.
 *
 * Two fakes, each at the one place a fake is honest:
 *   * the TERMINAL, as in forms-delivery.pg.test.ts — a real
 *     session_message_deliveries row per reserve, settled the way the delivery
 *     service settles it;
 *   * SPAWNSERVICE — `spawn` writes a real, live work_session row and renders
 *     the first turn through the request's own `firstTurnAppendix`; it replays
 *     by clientMutationId exactly as execution.spawn's ledger does. `resume`
 *     flips the row live and fires the drain-on-live listener, as
 *     SpawnService.notifySessionLive does.
 * Everything between them — the claim, the seam, the handlers, 215's doors —
 * is the production code.
 */
import { randomUUID } from 'node:crypto';

import { OPERATIONS, type FormResponseView, type OperationName } from '@tm8/contract';
import type { SpawnRequest } from '@tm8/execution';
import { SpawnError } from '@tm8/execution';
import { BYTE_BUDGETS, utf8Bytes } from '@tm8/prompt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { FormDeliveryDrain } from '../../src/facade/services/w2/form-delivery.js';
import { createSpawnModeHandlers, type FormSpawnPort } from '../../src/facade/services/w2/form-delivery-spawn.js';
import { W2FormsService } from '../../src/facade/services/w2/forms.js';
import type { MessageDeliveryPort } from '../../src/facade/services/w2/message-dispatch.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

type Row = Record<string, any>;

const ID1 = 'forms-spawn-1';
const ID2 = 'forms-spawn-2';

let database: W1ScratchDatabase;
let db: PgDb;
let owner: LoopbackOwner;
let w: { space: string; m1: string; m2: string; teammate: string };

// -- the terminal fake (as forms-delivery.pg.test.ts) --------------------------------

interface Injection { deliveryId: string; messageId: string; target: string; content: string }

class FakeTerminal {
  reserves: Array<{ messageId: string; target: string }> = [];
  injections: Injection[] = [];

  port(): MessageDeliveryPort {
    return {
      reserve: async (intent) => {
        const attemptNo = intent.attemptNo ?? 1;
        this.reserves.push({ messageId: intent.messageId, target: intent.targetWorkSessionId });
        const deliveryId = randomUUID();
        await sql(`insert into public.session_message_deliveries(
                     delivery_id, message_id, target_work_session_id, status, attempt_no)
                   values ($1, $2, $3, 'pending', $4)`,
          [deliveryId, intent.messageId, intent.targetWorkSessionId, attemptNo]);
        return { deliveryId, messageId: intent.messageId, targetWorkSessionId: intent.targetWorkSessionId, attemptNo };
      },
      adapter: {
        dispatch: async (attempt) => {
          this.injections.push({
            deliveryId: String(attempt.deliveryId), messageId: String(attempt.messageId),
            target: String(attempt.targetWorkSessionId), content: String(attempt.content),
          });
          await sql(`update public.session_message_deliveries set status = 'dispatching', claimed_at = now()
                      where delivery_id = $1`, [attempt.deliveryId]);
          await sql(`update public.session_message_deliveries set status = 'delivered', settled_at = now()
                      where delivery_id = $1`, [attempt.deliveryId]);
        },
        reject: async (attempt) => {
          await sql(`update public.session_message_deliveries set status = 'dispatching', claimed_at = now()
                      where delivery_id = $1`, [attempt.deliveryId]);
          await sql(`update public.session_message_deliveries
                        set status = 'failed_permanent', settled_at = now(), failure_reason = $2
                      where delivery_id = $1`, [attempt.deliveryId, attempt.reason]);
        },
      },
      principalFor: () => ({}),
    };
  }

  for(messageId: string): Injection[] {
    return this.injections.filter((i) => i.messageId === messageId);
  }
}

// -- the SpawnService fake ---------------------------------------------------------------

/** A system prompt + task turn of a realistic size; `large` crowds the envelope. */
const SYSTEM = 's'.repeat(9_000);
const TASK_TURN = 't'.repeat(2_000);
const LARGE_TASK_TURN = 't'.repeat(14_000);

interface Spawned { request: SpawnRequest; sessionId: string; reused: boolean; firstTurn: string; room: number }

class FakeSpawner implements FormSpawnPort {
  spawns: Spawned[] = [];
  resumes: string[] = [];
  byMutation = new Map<string, string>();
  spawnError: Error | null = null;
  resumeError: Error | null = null;
  taskTurn = TASK_TURN;
  /** Held open this long, so concurrent drains really overlap a spawn. */
  spawnDelayMs = 0;
  /** Drain-on-live, as SpawnService.onSessionLive fires it. */
  onLive: ((sessionId: string) => Promise<void>) | null = null;

  async spawn(_auth: unknown, request: SpawnRequest): Promise<{ sessionId: string; reused: boolean }> {
    const replayed = request.clientMutationId ? this.byMutation.get(request.clientMutationId) : undefined;
    if (replayed) {
      this.spawns.push({ request, sessionId: replayed, reused: true, firstTurn: '', room: 0 });
      return { sessionId: replayed, reused: true };
    }
    if (this.spawnError) throw this.spawnError;
    const sessionId = await newSession({ status: 'running', teammate: request.teamMemberId });
    if (request.clientMutationId) this.byMutation.set(request.clientMutationId, sessionId);
    if (this.spawnDelayMs) await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    // SpawnService's own rule: the appendix gets what the combined budget left.
    const room = BYTE_BUDGETS.combinedInitialInjection - utf8Bytes(`${SYSTEM}\n\n${this.taskTurn}\n\n`);
    const appendix = request.firstTurnAppendix ? request.firstTurnAppendix(sessionId, room) : '';
    this.spawns.push({ request, sessionId, reused: false, firstTurn: `${this.taskTurn}\n\n${appendix}`, room });
    return { sessionId, reused: false };
  }

  async resume(_auth: unknown, request: { sessionId: string }): Promise<unknown> {
    this.resumes.push(request.sessionId);
    if (this.resumeError) throw this.resumeError;
    await setStatus(request.sessionId, 'running');
    // Fire-and-forget, as notifySessionLive does.
    if (this.onLive) void this.onLive(request.sessionId).catch(() => {});
    return {};
  }

  fresh(): Spawned[] {
    return this.spawns.filter((s) => !s.reused);
  }
}

// -- helpers -------------------------------------------------------------------------------

async function sql(text: string, params: unknown[] = []): Promise<Row[]> {
  return database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    return (await c.query(text, params)).rows;
  });
}

const human = (identityId: string): RequestIdentity => ({ kind: 'bearer', identityId, authKind: 'cli' });
const agent = (session: string, actorId = w.teammate): RequestIdentity => ({
  kind: 'bearer', identityId: ID1, actorId, workSessionId: session, authKind: 'agent',
});

function ctx(opName: OperationName, identity: RequestIdentity, params: Row, body?: unknown): RequestContext {
  const op = OPERATIONS.find((o) => o.name === opName)!;
  return {
    op, opName, params, query: new URLSearchParams(), body,
    requestId: `req-${randomUUID()}`, identity, headers: {}, method: op.method, path: op.path,
  };
}

const cmid = () => `fs-${randomUUID()}`;
const QUESTIONS = [
  { key: 'pick', type: 'single_choice', title: 'Pick one',
    config: { options: [{ value: 'x', label: 'X', recommended: true }, { value: 'y', label: 'Y' }] } },
  { key: 'why', type: 'long_text', title: 'Why?', required: false, config: { maxLength: 20_000 } },
];

const newId = async (): Promise<string> => (await sql(`select internal.new_id()::text id`))[0]!.id as string;

/**
 * A session as execution.spawn leaves one: its teammate (relates_to), its task
 * (working_on), its parent, and a recorded manifest carrying its posture.
 */
async function newSession(opts: {
  status?: string;
  teammate?: string;
  parent?: string | null;
  task?: string | null;
  accessMode?: string | null;
} = {}): Promise<string> {
  const id = await newId();
  const teammate = opts.teammate ?? w.teammate;
  await sql(`insert into public.entities(id, space_id, kind, visibility, created_by, parent_id)
             values ($1, $2, 'work_session', 'space', $3, $4)`, [id, w.space, teammate, opts.parent ?? null]);
  await sql(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at,
                                              workdir_mode, mode, model, agent_tool)
             values ($1, 'Requester', $2, 'space', now(), 'scratch', 'worker', 'claude-opus-5-5', 'claude-code')`,
    [id, opts.status ?? 'running']);
  await sql(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
             values ($1, $2, $3, 'participates_in', $2)`, [w.space, teammate, id]);
  await sql(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
             values ($1, $2, $3, 'relates_to', $3)`, [w.space, id, teammate]);
  if (opts.task) {
    await sql(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
               values ($1, $2, $3, 'working_on', $3)`, [w.space, id, opts.task]);
  }
  if (opts.accessMode !== null) {
    await sql(`insert into public.session_manifests(work_session_id, manifest) values ($1, $2)`,
      [id, JSON.stringify({ launch: { accessMode: opts.accessMode ?? 'plan', permissionMode: 'readOnly' } })]);
  }
  return id;
}

async function newTask(): Promise<string> {
  const id = await newId();
  await sql(`insert into public.entities(id, space_id, kind, visibility, created_by)
             values ($1, $2, 'task', 'space', $3)`, [id, w.space, w.m1]);
  await sql(`insert into public.tasks(entity_id, title, work_status, priority) values ($1, 'the task', 'open', 'medium')`, [id]);
  return id;
}

const setStatus = (session: string, status: string) => database.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
  await c.query(`update public.work_sessions set status = $2 where entity_id = $1`, [session, status]);
});

const softDelete = (session: string) => sql(`update public.entities set deleted_at = now() where id = $1`, [session]);

function world(opts: { hooks?: boolean } = {}) {
  const terminal = new FakeTerminal();
  const spawner = new FakeSpawner();
  const deps: FacadeDeps = { db, config: {} as FacadeDeps['config'], owner: async () => owner };
  const drain = new FormDeliveryDrain({
    db,
    claims: async () => ({ identityId: owner.identityId, nodeAdmin: true, requestId: 'forms-spawn-test' }),
    delivery: terminal.port(),
    notLive: createSpawnModeHandlers({ spawner }),
  });
  spawner.onLive = async (sessionId) => { await drain.onSessionLive(sessionId); };
  const service = new W2FormsService(deps, opts.hooks === false ? {} : {
    onResponseSubmitted: drain.onResponseSubmitted,
    onFormCancelled: drain.onFormCancelled,
  });
  const openForm = async (session: string, settings: Row = {}, actorId?: string): Promise<string> => {
    const created = await service.create(ctx('forms.create', agent(session, actorId), {}, {
      clientMutationId: cmid(), spaceId: w.space, title: 'Pick the <strategy> & go', questions: QUESTIONS,
      open: true, settings,
    })) as Row;
    return created.entity.id as string;
  };
  const submit = async (form: string, answers: Row): Promise<FormResponseView> =>
    await service.responsesSubmit(ctx('forms.responses.submit', human(ID2), { formId: form },
      { clientMutationId: cmid(), answers })) as FormResponseView;
  return { terminal, spawner, drain, service, openForm, submit };
}

async function delivery(responseId: string): Promise<Row> {
  return (await sql(`select * from public.form_deliveries where response_id = $1`, [responseId]))[0]!;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Let time pass for a deferred or leased row: make it claimable now. */
const expireHold = (responseId: string) =>
  sql(`update public.form_deliveries set claimed_at = null where response_id = $1`, [responseId]);

const SPAWN_NEW = { delivery: { onSessionNotLive: 'spawn_new' } };
const NEW_SESSION = { delivery: { target: 'new_session' } };
const QUEUE = { delivery: { onSessionNotLive: 'queue' } };

// -- seed ------------------------------------------------------------------------------------

beforeAll(async () => {
  database = await createW1ScratchDatabase('forms_delivery_spawn');
  database.apply(migrationFiles());
  w = await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    const id = async () => (await c.query(`select internal.new_id()::text id`)).rows[0]!.id as string;
    const x = { space: await id(), m1: await id(), m2: await id(), teammate: await id() };
    for (const identity of [ID1, ID2]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
    }
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Forms spawn', $2)`,
      [x.space, ID1]);
    for (const [eid, identity, role] of [[x.m1, ID1, 'owner'], [x.m2, ID2, 'member']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, visibility, created_by)
                     values ($1, $2, 'member', 'space', $1)`, [eid, x.space]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, $4, $3)`, [eid, x.space, identity, role]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, visibility, created_by)
                   values ($1, $2, 'team_member', 'space', $3)`, [x.teammate, x.space, x.m1]);
    await c.query(`insert into public.team_members(entity_id, name, owner_member_id) values ($1, 'Agent', $2)`,
      [x.teammate, x.m1]);
    return x;
  });
  db = new PgDb({ databaseUrl: database.url });
  owner = { identityId: ID1, accountId: 'acct-fs', username: 'owner', isNodeAdmin: true, isOwner: true };
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

// -- resume (the default) --------------------------------------------------------------------

describe('onSessionNotLive = resume', () => {
  it('live: injected, nothing resumed', async () => {
    const { terminal, spawner, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session);
    const view = await submit(form, { pick: { value: 'x' } });
    await until(() => delivery(view.id), (r) => r.status === 'delivered');
    expect(terminal.for(view.messageId!)).toHaveLength(1);
    expect(spawner.resumes).toEqual([]);
  });

  it('exited: resumed once, then injected as the first turn after resume — once, with hook, tick and listener racing', async () => {
    const { terminal, spawner, drain, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });   // the hook
    await Promise.all([drain.drain(), drain.drain(), drain.drain({ workSessionId: session })]);   // ticks
    const row = await until(() => delivery(view.id), (r) => r.status === 'delivered');
    await drain.drain();
    await drain.onSessionLive(session);

    expect(row).toMatchObject({ status: 'delivered', spawned_session_id: null });
    expect(spawner.resumes).toEqual([session]);
    expect(spawner.spawns).toEqual([]);
    expect(terminal.reserves.filter((r) => r.messageId === view.messageId)).toHaveLength(1);
    expect(terminal.for(view.messageId!)).toHaveLength(1);
    expect(terminal.for(view.messageId!)[0]!.target).toBe(session);
  });

  it('deleted: cancelled, never resumed', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await softDelete(session);
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'cancelled', last_error: 'session_deleted' });
    expect(spawner.resumes).toEqual([]);
  });

  it('a session that cannot be resumed is cancelled resume_unavailable — never spawned instead', async () => {
    const { spawner, openForm, submit } = world();
    spawner.resumeError = new SpawnError('agent tool has no resume-by-id contract', 'invalid_input');
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'failed');
    const view = await submit(form, { pick: { value: 'x' } });
    const row = await until(() => delivery(view.id), (r) => r.status !== 'pending');
    expect(row.status).toBe('cancelled');
    expect(row.last_error).toBe('resume_unavailable: agent tool has no resume-by-id contract');
    expect(spawner.spawns).toEqual([]);
  });

  it('a transient failure records attempts and last_error, stays pending, and is not retried at once', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    spawner.resumeError = new SpawnError('pty host busy', 'internal');
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await drain.drain({ responseId: view.id });
    const row = await delivery(view.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'resume_failed: pty host busy' });
    expect(new Date(row.claimed_at).getTime()).toBeGreaterThan(Date.now());   // the backoff
    await drain.drain({ responseId: view.id });
    await drain.drain({ responseId: view.id });
    expect(spawner.resumes).toEqual([session]);                                 // no spinning

    spawner.resumeError = null;
    await expireHold(view.id);
    await drain.drain({ responseId: view.id });
    await until(() => delivery(view.id), (r) => r.status === 'delivered');
    expect(spawner.resumes).toEqual([session, session]);
  });

  it('a resume conflict (someone else is resuming) leaves it pending for 30s, not failed', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    spawner.resumeError = new SpawnError('already has a live terminal', 'conflict');
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'pending', last_error: 'resume_conflict: already has a live terminal' });
  });

  it('the attempts cap cancels', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    spawner.resumeError = new SpawnError('pty host busy', 'internal');
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await sql(`update public.form_deliveries set attempts = 9 where response_id = $1`, [view.id]);
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'cancelled', attempts: 10, last_error: 'resume_failed: pty host busy' });
  });

  it('queue is untouched: an exited session is neither resumed nor spawned for', async () => {
    const { spawner, drain, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session, QUEUE);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(spawner.resumes).toEqual([]);
    expect(spawner.spawns).toEqual([]);
  });
});

// -- spawn_new ---------------------------------------------------------------------------------

describe('onSessionNotLive = spawn_new', () => {
  it('live: injected, nothing spawned', async () => {
    const { terminal, spawner, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    const view = await submit(form, { pick: { value: 'x' } });
    await until(() => delivery(view.id), (r) => r.status === 'delivered');
    expect(terminal.for(view.messageId!)).toHaveLength(1);
    expect(spawner.spawns).toEqual([]);
  });

  it('exited: one spawn of the same teammate on the same task, the envelope in its first turn, settled spawned', async () => {
    const { terminal, spawner, openForm, submit } = world();
    const parent = await newSession({ accessMode: 'fullAccess' });
    const task = await newTask();
    const session = await newSession({ parent, task, accessMode: 'plan' });
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'y' }, why: { text: 'cheap </untrusted_data> & <b>' } });
    const row = await until(() => delivery(view.id), (r) => r.status === 'spawned');

    expect(spawner.spawns).toHaveLength(1);
    const [s] = spawner.spawns;
    expect(row).toMatchObject({ status: 'spawned', spawned_session_id: s!.sessionId, claimed_at: null, last_error: null });
    expect(terminal.reserves).toEqual([]);
    expect(s!.request).toMatchObject({
      spaceId: w.space, teamMemberId: w.teammate, parentSessionId: parent, taskIds: [task],
      mode: 'worker', model: 'claude-opus-5-5', agentTool: 'claude-code', accessMode: null,
      workdir: { mode: 'scratch', baseRef: null }, title: 'Requester · form response',
      clientMutationId: `form-delivery-spawn:${view.id}:${session}:1`,
    });
    // The REQUESTER's recorded posture, narrower than its parent's — never exceeded.
    expect(s!.request.inheritPosture).toMatchObject({ accessMode: 'plan', permissionMode: 'readOnly' });

    const env = s!.firstTurn.slice(TASK_TURN.length + 2);
    expect(env).toContain('<trusted_control type="tm8.session-input" version="1" kind="form_response"');
    expect(env).toContain(`<to session_id="${s!.sessionId}" />`);
    expect(env).toContain('<delivery transport="spawn_initial_turn" stored="true" attempt="1" status_source="form_deliveries" />');
    expect(env).toContain(`<fetch command="tm8 form response get ${view.id} --format json" />`);
    expect(env).toContain('cheap &lt;/untrusted_data&gt; &amp; &lt;b&gt;');
    expect(env.slice(0, env.indexOf('</trusted_control>'))).not.toContain('strategy');

    // The new session can reply on the form.
    expect(await database.transaction(async (c) => (await c.query(
      `select source_anchor_id from public.session_message_reply_routes
        where target_message_id = $1 and target_work_session_id = $2`, [view.messageId, s!.sessionId])).rows))
      .toEqual([{ source_anchor_id: form }]);
  });

  it('deleted AFTER submit: still spawned (§7.3)', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await softDelete(session);
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'spawned', spawned_session_id: spawner.spawns[0]!.sessionId });
    expect(spawner.spawns[0]!.request.teamMemberId).toBe(w.teammate);
  });

  it('deleted BEFORE submit: still spawned (§7.3)', async () => {
    const { spawner, openForm, submit } = world();
    const task = await newTask();
    const session = await newSession({ task });
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    await softDelete(session);
    const view = await submit(form, { pick: { value: 'x' } });
    const row = await until(() => delivery(view.id), (r) => r.status === 'spawned');
    expect(row).toMatchObject({ work_session_id: session, spawned_session_id: spawner.spawns[0]!.sessionId });
    expect(spawner.spawns[0]!.request.taskIds).toEqual([task]);
  });

  it('concurrent drains spawn exactly once', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    spawner.spawnDelayMs = 150;
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await Promise.all(Array.from({ length: 6 }, (_, i) =>
      i % 2 ? drain.drain({ responseId: view.id }) : drain.drain({ workSessionId: session })));
    await drain.drain({ responseId: view.id });
    expect(spawner.spawns).toHaveLength(1);
    expect((await delivery(view.id)).status).toBe('spawned');
  });

  it('a crash mid-spawn replays the SAME spawn: one session, settled to it', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    // As if a drain pinned the key, spawned, and died before settling.
    const key = `form-delivery-spawn:${view.id}:${session}:1`;
    const orphan = await newSession({ status: 'running' });
    spawner.byMutation.set(key, orphan);
    await sql(`update public.form_deliveries set spawn_mutation_id = $2, attempts = 1 where response_id = $1`, [view.id, key]);

    await drain.drain({ responseId: view.id });
    expect(spawner.fresh()).toEqual([]);
    expect(spawner.spawns.map((s) => s.request.clientMutationId)).toEqual([key]);
    expect(await delivery(view.id)).toMatchObject({ status: 'spawned', spawned_session_id: orphan });
  });

  it('a replay that lands on a FAILED session drops the key and spawns fresh: one live spawned session', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    const key = `form-delivery-spawn:${view.id}:${session}:1`;
    const dead = await newSession({ status: 'failed' });
    spawner.byMutation.set(key, dead);
    await sql(`update public.form_deliveries set spawn_mutation_id = $2, attempts = 1 where response_id = $1`, [view.id, key]);

    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({
      status: 'pending', spawn_mutation_id: null, attempts: 2, last_error: 'spawn_replayed_failed',
    });
    await expireHold(view.id);
    await drain.drain({ responseId: view.id });

    const row = await delivery(view.id);
    expect(spawner.fresh()).toHaveLength(1);
    expect(row).toMatchObject({ status: 'spawned', spawned_session_id: spawner.fresh()[0]!.sessionId });
    expect(row.spawned_session_id).not.toBe(dead);
    expect(spawner.fresh()[0]!.request.clientMutationId).toBe(`form-delivery-spawn:${view.id}:${session}:3`);
  });

  it('a permanent refusal cancels spawn_failed; a transient one defers and forgets the key', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });

    spawner.spawnError = new SpawnError('the agent CLI is not installed', 'internal');
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({
      status: 'pending', spawn_mutation_id: null, last_error: 'spawn_failed: the agent CLI is not installed',
    });
    await drain.drain({ responseId: view.id });
    expect(spawner.spawns).toHaveLength(0);   // deferred: no spinning

    spawner.spawnError = new SpawnError('coordinated mode needs a parent session', 'invalid_input');
    await expireHold(view.id);
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({
      status: 'cancelled', last_error: 'spawn_failed: coordinated mode needs a parent session',
    });
  });

  it('the attempts cap cancels', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    spawner.spawnError = new SpawnError('boom', 'internal');
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await sql(`update public.form_deliveries set attempts = 9 where response_id = $1`, [view.id]);
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'cancelled', attempts: 10, last_error: 'spawn_failed: boom' });
  });

  it('a gone teammate, or no recorded posture, cancels spawn_failed without trying', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const unposed = await newSession({ accessMode: null });
    const formA = await openForm(unposed, SPAWN_NEW);
    await setStatus(unposed, 'exited');
    const a = await submit(formA, { pick: { value: 'x' } });

    const loner = await newId();
    await sql(`insert into public.entities(id, space_id, kind, visibility, created_by)
               values ($1, $2, 'team_member', 'space', $3)`, [loner, w.space, w.m1]);
    await sql(`insert into public.team_members(entity_id, name, owner_member_id) values ($1, 'Gone', $2)`, [loner, w.m1]);
    const orphaned = await newSession({ teammate: loner });
    const formB = await openForm(orphaned, SPAWN_NEW, loner);
    await setStatus(orphaned, 'exited');
    const b = await submit(formB, { pick: { value: 'x' } });
    await softDelete(loner);

    await Promise.all([drain.drain({ responseId: a.id }), drain.drain({ responseId: b.id })]);
    expect(await delivery(a.id)).toMatchObject({
      status: 'cancelled', last_error: 'spawn_failed: the requesting session recorded no launch posture',
    });
    expect(await delivery(b.id)).toMatchObject({ status: 'cancelled', last_error: 'spawn_failed: the teammate is gone' });
    expect(spawner.spawns).toEqual([]);
  });

  it('10k CJK + <& with a large task turn: the envelope is cut to what is left, never the task', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    spawner.taskTurn = LARGE_TASK_TURN;
    const session = await newSession();
    const form = await openForm(session, SPAWN_NEW);
    await setStatus(session, 'exited');
    const text = `${'答'.repeat(9_990)}<&<&<&`;
    const view = await submit(form, { pick: { value: 'x' }, why: { text } });
    await drain.drain({ responseId: view.id });

    expect((await delivery(view.id)).status).toBe('spawned');
    const [s] = spawner.spawns;
    expect(s!.room).toBeLessThan(BYTE_BUDGETS.incomingMessageInjection);
    expect(s!.firstTurn.startsWith(`${LARGE_TASK_TURN}\n\n`)).toBe(true);
    const env = s!.firstTurn.slice(LARGE_TASK_TURN.length + 2);
    expect(utf8Bytes(env)).toBeLessThanOrEqual(s!.room);
    expect(env).toContain('truncated="true"');
    expect(env).toContain(`fetch_ref="tm8 form response get ${view.id} --format json"`);
    expect(env).toContain('答答答');
    expect(env.match(/<\/untrusted_data>/g)).toHaveLength(1);
    expect(env).not.toMatch(/<&/);
  });
});

// -- target = new_session ------------------------------------------------------------------------

describe('delivery.target = new_session', () => {
  it('live: spawns anyway — it is the target, not a fallback — and injects nothing', async () => {
    const { terminal, spawner, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session, NEW_SESSION);
    const view = await submit(form, { pick: { value: 'x' } });
    const row = await until(() => delivery(view.id), (r) => r.status === 'spawned');
    expect(row.spawned_session_id).toBe(spawner.spawns[0]!.sessionId);
    expect(spawner.spawns).toHaveLength(1);
    expect(terminal.reserves).toEqual([]);
  });

  it('exited: spawns', async () => {
    const { spawner, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session, NEW_SESSION);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await until(() => delivery(view.id), (r) => r.status === 'spawned');
    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.resumes).toEqual([]);
  });

  it('deleted before submit, and after: spawns', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const before = await newSession();
    const formBefore = await openForm(before, NEW_SESSION);
    await softDelete(before);
    const a = await submit(formBefore, { pick: { value: 'x' } });

    const after = await newSession();
    const formAfter = await openForm(after, NEW_SESSION);
    const b = await submit(formAfter, { pick: { value: 'x' } });
    await softDelete(after);

    await Promise.all([drain.drain({ responseId: a.id }), drain.drain({ responseId: b.id })]);
    expect((await delivery(a.id)).status).toBe('spawned');
    expect((await delivery(b.id)).status).toBe('spawned');
    expect(spawner.spawns).toHaveLength(2);
  });

  it('each response spawns its own session', async () => {
    const { spawner, drain, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session, { ...NEW_SESSION, responses: 'unlimited' });
    const a = await submit(form, { pick: { value: 'x' } });
    const b = await submit(form, { pick: { value: 'y' } });
    await Promise.all([drain.drain({ responseId: a.id }), drain.drain({ responseId: b.id })]);
    const rows = [await delivery(a.id), await delivery(b.id)];
    expect(rows.map((r) => r.status)).toEqual(['spawned', 'spawned']);
    expect(new Set(rows.map((r) => r.spawned_session_id)).size).toBe(2);
    expect(spawner.spawns).toHaveLength(2);
  });
});
