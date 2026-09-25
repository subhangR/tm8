/**
 * Forms W3 — forms.responses.redeliver and forms.pendingForSessions
 * (migration 221), end to end against a real scratch database.
 *
 * The fakes are forms-delivery-spawn.pg.test.ts's, for the same reasons: a
 * terminal that writes real session_message_deliveries rows, and a SpawnService
 * that writes real work_session rows and fires drain-on-live on resume.
 * Everything between them — 221's doors, the claim, 215's handlers — is the
 * production code.
 */
import { randomUUID } from 'node:crypto';

import {
  CollabError,
  FORMS_PENDING_MAX_FORMS,
  isCollabError,
  OPERATIONS,
  type FormResponseView,
  type FormsPendingForSessionsResult,
  type FormsResponsesRedeliverResult,
  type OperationName,
} from '@tm8/contract';
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

const ID1 = 'forms-redeliver-1';
const ID2 = 'forms-redeliver-2';
/** A plain member: neither the respondent, the author nor an admin. */
const ID3 = 'forms-redeliver-3';

let database: W1ScratchDatabase;
let db: PgDb;
let owner: LoopbackOwner;
let w: { space: string; m1: string; m2: string; m3: string; teammate: string };

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

const cmid = () => `fr-${randomUUID()}`;
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
    claims: async () => ({ identityId: owner.identityId, nodeAdmin: true, requestId: 'forms-redeliver-test' }),
    delivery: terminal.port(),
    notLive: createSpawnModeHandlers({ spawner }),
  });
  spawner.onLive = async (sessionId) => { await drain.onSessionLive(sessionId); };
  const service = new W2FormsService(deps, opts.hooks === false ? {} : {
    onResponseSubmitted: drain.onResponseSubmitted,
    onFormCancelled: drain.onFormCancelled,
    onResponseRedelivered: drain.onResponseSubmitted,
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
  database = await createW1ScratchDatabase('forms_redeliver');
  database.apply(migrationFiles());
  w = await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    const id = async () => (await c.query(`select internal.new_id()::text id`)).rows[0]!.id as string;
    const x = { space: await id(), m1: await id(), m2: await id(), m3: await id(), teammate: await id() };
    for (const identity of [ID1, ID2, ID3]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
    }
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Forms redeliver', $2)`,
      [x.space, ID1]);
    for (const [eid, identity, role] of [[x.m1, ID1, 'owner'], [x.m2, ID2, 'member'], [x.m3, ID3, 'member']] as const) {
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
  owner = { identityId: ID1, accountId: 'acct-fr', username: 'owner', isNodeAdmin: true, isOwner: true };
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});
// -- W3 helpers ----------------------------------------------------------------------------

async function refusal(p: Promise<unknown>): Promise<CollabError> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').not.toBeNull();
  expect(isCollabError(error), String(error)).toBe(true);
  return error as CollabError;
}

function redeliver(
  service: W2FormsService, identity: RequestIdentity, responseId: string, body: Row = {},
): Promise<FormsResponsesRedeliverResult> {
  return service.responsesRedeliver(ctx('forms.responses.redeliver', identity, { responseId },
    { clientMutationId: cmid(), ...body })) as Promise<FormsResponsesRedeliverResult>;
}

function pending(
  service: W2FormsService, identity: RequestIdentity, sessionIds: string[], spaceId = w.space,
): Promise<FormsPendingForSessionsResult> {
  const c = ctx('forms.pendingForSessions', identity, {});
  const query = new URLSearchParams({ spaceId, sessionIds: sessionIds.join(',') });
  return service.pendingForSessions({ ...c, query }) as Promise<FormsPendingForSessionsResult>;
}

/** A work session with no form edges: `task` is the one it works on. */
async function requesterOnTask(): Promise<{ session: string; task: string }> {
  const task = await newTask();
  return { session: await newSession({ task }), task };
}

// -- forms.responses.redeliver, to = new_session ------------------------------------------

describe('forms.responses.redeliver: send a cancelled delivery to a new session', () => {
  it('deleted session → cancelled → redeliver → spawned, for the same teammate and task, and never re-cancelled', async () => {
    const { spawner, drain, service, openForm, submit } = world();
    const { session, task } = await requesterOnTask();
    const form = await openForm(session);
    await setStatus(session, 'exited');
    await softDelete(session);
    const view = await submit(form, { pick: { value: 'x' } });
    await drain.drain({ responseId: view.id });
    expect(await delivery(view.id)).toMatchObject({ status: 'cancelled', last_error: 'session_deleted' });

    const result = await redeliver(service, human(ID2), view.id);
    expect(result).toEqual({
      responseId: view.id, workSessionId: session, to: 'new_session', status: 'pending', redelivered: true,
    });
    const row = await until(() => delivery(view.id), (r) => r.status === 'spawned');
    expect(row).toMatchObject({
      status: 'spawned', route_override: 'new_session', last_error: null,
      spawned_session_id: spawner.fresh()[0]!.sessionId,
    });
    expect(spawner.fresh()).toHaveLength(1);
    // (b): the teammate and the task come off the DELETED requester's rows.
    expect(spawner.fresh()[0]!.request).toMatchObject({ teamMemberId: w.teammate, taskIds: [task] });
    const env = spawner.fresh()[0]!.firstTurn;
    expect(env).toContain('kind="form_response"');
    expect(env).toContain(`<fetch command="tm8 form response get ${view.id} --format json" />`);
    // Another pass finds nothing to cancel and nothing to spawn.
    await drain.drain({});
    expect((await delivery(view.id)).status).toBe('spawned');
    expect(spawner.fresh()).toHaveLength(1);
  });

  it('a redelivered row survives the session_deleted sweep while still pending (221 C)', async () => {
    const { drain, service, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session);
    await softDelete(session);
    const view = await submit(form, { pick: { value: 'x' } });
    await drain.drain({ responseId: view.id });
    expect((await delivery(view.id)).status).toBe('cancelled');
    await redeliver(service, human(ID2), view.id);
    // A drain that cannot route new_session (no handlers) must leave it pending,
    // not cancel it again as session_deleted.
    const plain = new FormDeliveryDrain({
      db,
      claims: async () => ({ identityId: owner.identityId, nodeAdmin: true, requestId: 'forms-redeliver-test' }),
      delivery: new FakeTerminal().port(),
    });
    const result = await plain.drain({ responseId: view.id });
    expect(result.cancelled).toBe(0);
    expect(await delivery(view.id)).toMatchObject({ status: 'pending', route_override: 'new_session' });
  });

  it('resume_unavailable → redeliver → spawned; the old error is kept as redelivered_from until it settles', async () => {
    const { spawner, service, openForm, submit } = world();
    spawner.resumeError = new SpawnError('agent tool has no resume-by-id contract', 'invalid_input');
    const session = await newSession();
    const form = await openForm(session);
    await setStatus(session, 'failed');
    const view = await submit(form, { pick: { value: 'x' } });
    await until(() => delivery(view.id), (r) => r.status === 'cancelled');
    // Redeliver with no drain hook: the row is pending with the old reason kept.
    const bare = new W2FormsService({ db, config: {} as FacadeDeps['config'], owner: async () => owner });
    await redeliver(bare, human(ID2), view.id);
    expect(await delivery(view.id)).toMatchObject({
      status: 'pending', route_override: 'new_session',
      last_error: 'redelivered_from: resume_unavailable: agent tool has no resume-by-id contract',
      claimed_at: null, delivery_id: null, spawn_mutation_id: null,
    });
    // Then the click's drain spawns it.
    await redeliver(service, human(ID2), view.id);
    await until(() => delivery(view.id), (r) => r.status === 'spawned');
    expect(spawner.resumes).toEqual([session]);   // the one failed resume, before the redeliver
    expect(spawner.fresh()).toHaveLength(1);
  });

  it('is idempotent: a replay returns the recorded result, and a second click on a routed row changes nothing', async () => {
    const { spawner, drain, service, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session);
    await softDelete(session);
    const view = await submit(form, { pick: { value: 'x' } });
    await drain.drain({ responseId: view.id });
    const id = cmid();
    const call = () => service.responsesRedeliver(ctx('forms.responses.redeliver', human(ID2),
      { responseId: view.id }, { clientMutationId: id })) as Promise<FormsResponsesRedeliverResult>;
    const first = await call();
    expect(await call()).toEqual(first);
    const second = await redeliver(service, human(ID2), view.id);
    expect(second).toMatchObject({ redelivered: false, status: 'pending' });
    await drain.drain({ responseId: view.id });
    expect((await delivery(view.id)).status).toBe('spawned');
    const third = await redeliver(service, human(ID2), view.id);
    expect(third).toMatchObject({ redelivered: false, status: 'spawned' });
    expect(spawner.fresh()).toHaveLength(1);
  });

  it('refuses a delivery that is not cancelled: conflict, details.reason delivery_not_cancelled', async () => {
    const { service, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session);
    const view = await submit(form, { pick: { value: 'x' } });
    // Settled by hand: the refusal must not depend on drain timing.
    await sql(`update public.form_deliveries set status = 'delivered' where response_id = $1`, [view.id]);
    const e = await refusal(redeliver(service, human(ID2), view.id));
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ reason: 'delivery_not_cancelled', status: 'delivered' });
  });

  it('the respondent, the form\'s author and an admin may; another member may not', async () => {
    const { drain, service, openForm, submit } = world({ hooks: false });
    const responses: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await newSession();
      const form = await openForm(session);
      await softDelete(session);
      const view = await submit(form, { pick: { value: 'x' } });
      await drain.drain({ responseId: view.id });
      responses.push(view.id);
    }
    const e = await refusal(redeliver(service, human(ID3), responses[0]!));
    expect(e.code).toBe('forbidden');
    await redeliver(service, human(ID2), responses[0]!);                // the respondent
    await redeliver(service, agent(await newSession()), responses[1]!); // the author (the teammate)
    await redeliver(service, human(ID1), responses[2]!);                // the space owner
    for (const id of responses) expect((await delivery(id)).route_override).toBe('new_session');
  });

  it('an unknown response is not_found; a draft is not a response to redeliver', async () => {
    const { service, openForm } = world();
    const e = await refusal(redeliver(service, human(ID2), randomUUID()));
    expect(e.code).toBe('not_found');
    const form = await openForm(await newSession());
    const draft = await service.responsesSave(ctx('forms.responses.save', human(ID2), { formId: form },
      { clientMutationId: cmid(), answers: { pick: { value: 'x' } } })) as FormResponseView;
    expect((await refusal(redeliver(service, human(ID2), draft.id))).code).toBe('not_found');
  });
});

// -- forms.responses.redeliver, to = resume ("Resume now") ---------------------------------

describe('forms.responses.redeliver: resume now, for a queued delivery', () => {
  it('a queued answer on an exited session: resumed by the server, then injected once', async () => {
    const { terminal, spawner, service, openForm, submit } = world();
    const session = await newSession();
    const form = await openForm(session, QUEUE);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await new Promise((r) => setTimeout(r, 200));
    expect((await delivery(view.id)).status).toBe('pending');
    expect(spawner.resumes).toEqual([]);

    const result = await redeliver(service, human(ID2), view.id, { to: 'resume' });
    expect(result).toMatchObject({ to: 'resume', status: 'pending', redelivered: true });
    const row = await until(() => delivery(view.id), (r) => r.status === 'delivered');
    expect(row).toMatchObject({ status: 'delivered', route_override: 'resume' });
    expect(spawner.resumes).toEqual([session]);
    expect(terminal.for(view.messageId!)).toHaveLength(1);
    expect(spawner.fresh()).toEqual([]);
  });

  it('clears a backoff but never steals a live lease', async () => {
    const { service, openForm, submit } = world({ hooks: false });
    const session = await newSession();
    const form = await openForm(session, QUEUE);
    await setStatus(session, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await sql(`update public.form_deliveries set claimed_at = now() + interval '1 hour' where response_id = $1`, [view.id]);
    const bare = new W2FormsService({ db, config: {} as FacadeDeps['config'], owner: async () => owner });
    await redeliver(bare, human(ID2), view.id, { to: 'resume' });
    expect((await delivery(view.id)).claimed_at).toBeNull();

    await sql(`update public.form_deliveries set claimed_at = now() - interval '5 seconds' where response_id = $1`, [view.id]);
    const again = await redeliver(bare, human(ID2), view.id, { to: 'resume' });
    expect(again.redelivered).toBe(false);
    expect((await delivery(view.id)).claimed_at).not.toBeNull();
  });

  it('refuses a delivery that is not pending, and a deleted session', async () => {
    // No hooks and no waiting on a real delivery: the row is settled by hand,
    // so the refusal does not depend on how fast the drain runs under load.
    const { service, openForm, submit } = world({ hooks: false });
    const live = await newSession();
    const delivered = await submit(await openForm(live), { pick: { value: 'x' } });
    await sql(`update public.form_deliveries set status = 'delivered' where response_id = $1`, [delivered.id]);
    const notPending = await refusal(redeliver(service, human(ID2), delivered.id, { to: 'resume' }));
    expect(notPending.code).toBe('conflict');
    expect(notPending.details).toMatchObject({ reason: 'delivery_not_pending' });

    const gone = await newSession();
    const form = await openForm(gone, QUEUE);
    await setStatus(gone, 'exited');
    const view = await submit(form, { pick: { value: 'x' } });
    await softDelete(gone);
    const deleted = await refusal(redeliver(service, human(ID2), view.id, { to: 'resume' }));
    expect(deleted.code).toBe('conflict');
    expect(deleted.details).toMatchObject({ reason: 'session_deleted' });
  });
});

// -- forms.pendingForSessions ---------------------------------------------------------------

describe('forms.pendingForSessions', () => {
  it('lists the forms waiting on the caller, with the draft, until the caller submits', async () => {
    const { service, openForm, submit } = world({ hooks: false });
    const s1 = await newSession();
    const s2 = await newSession();
    const form = await openForm(s1);

    const before = await pending(service, human(ID2), [s2, s1]);
    expect(before.sessions).toEqual([{
      workSessionId: s1, total: 1, queued: 0,
      forms: [{
        formId: form, title: 'Pick the <strategy> & go', version: expect.any(Number), structureVersion: 1,
        questionCount: 2, openedAt: expect.stringMatching(/Z$/), draft: null,
      }],
    }]);

    const draft = await service.responsesSave(ctx('forms.responses.save', human(ID2), { formId: form },
      { clientMutationId: cmid(), answers: { pick: { value: 'y' } } })) as FormResponseView;
    const drafting = await pending(service, human(ID2), [s1]);
    expect(drafting.sessions[0]!.forms[0]!.draft).toEqual({ id: draft.id, version: draft.version });
    // A draft is private: another member sees the form, not the draft.
    expect((await pending(service, human(ID3), [s1])).sessions[0]!.forms[0]!.draft).toBeNull();

    await submit(form, { pick: { value: 'x' } });
    // Hooks are off, so the answer is still pending — but s1 is LIVE, so it is
    // in flight, not queued: nothing to list (advisor D1).
    expect((await pending(service, human(ID2), [s1])).sessions).toEqual([]);
    // per_member: it still waits on everyone else.
    expect((await pending(service, human(ID3), [s1])).sessions[0]!.total).toBe(1);
  });

  it('single: done for everyone after the first submit; unlimited: done for the caller once they submit', async () => {
    const { service, openForm, submit } = world({ hooks: false });
    const s = await newSession();
    await openForm(s, { responses: 'single' });
    const unlimited = await openForm(s, { responses: 'unlimited' });
    expect((await pending(service, human(ID3), [s])).sessions[0]!.total).toBe(2);
    const single = (await pending(service, human(ID3), [s])).sessions[0]!.forms.find((f) => f.formId !== unlimited)!;
    await submit(single.formId, { pick: { value: 'x' } });
    await submit(unlimited, { pick: { value: 'x' } });
    expect((await pending(service, human(ID3), [s])).sessions[0]!.forms.map((f) => f.formId)).toEqual([unlimited]);
    expect((await pending(service, human(ID2), [s])).sessions).toEqual([]);   // live: in flight, not queued
  });

  it('an agent caller sees only forms that accept agents; closed and draft forms never wait', async () => {
    const { service, openForm } = world({ hooks: false });
    const s = await newSession();
    await openForm(s);
    const anyone = await openForm(s, { respondents: 'anyone' });
    const viewer = agent(await newSession());
    expect((await pending(service, viewer, [s])).sessions[0]!.forms.map((f) => f.formId)).toEqual([anyone]);

    const closing = await service.transition(ctx('forms.transition', agent(s), { formId: anyone },
      { clientMutationId: cmid(), expectedVersion: (await pending(service, viewer, [s])).sessions[0]!.forms[0]!.version, to: 'closed' }));
    expect(closing).toBeTruthy();
    expect((await pending(service, viewer, [s])).sessions).toEqual([]);
  });

  it('an agent is a respondent only in ITS space: its teammate never answers another space\'s forms', async () => {
    // The teammate lives in w.space; its owner (ID1) is also a member of
    // `other`. Reading `other` through the owner's identity is allowed, but
    // the teammate cannot answer there (form_assert_respondent: space
    // mismatch), so nothing may wait on it — not even an `anyone` form.
    const { service } = world({ hooks: false });
    const other = await newId();
    const otherMember = await newId();
    const otherSession = await newId();
    await sql(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Other space', $2)`, [other, ID1]);
    await sql(`insert into public.entities(id, space_id, kind, visibility, created_by)
               values ($1, $2, 'member', 'space', $1)`, [otherMember, other]);
    await sql(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
               values ($1, $2, $3, 'owner', $3)`, [otherMember, other, ID1]);
    await sql(`insert into public.entities(id, space_id, kind, visibility, created_by)
               values ($1, $2, 'work_session', 'space', $3)`, [otherSession, other, otherMember]);
    await sql(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
               values ($1, 'Other requester', 'running', 'space', now())`, [otherSession]);
    const created = await service.create(ctx('forms.create', human(ID1), {}, {
      clientMutationId: cmid(), spaceId: other, title: 'Anyone, over there', questions: QUESTIONS,
      open: true, forSession: otherSession, settings: { respondents: 'anyone' },
    })) as Row;
    const form = created.entity.id as string;

    // Control: the owner's member row in `other` is a respondent there.
    expect((await pending(service, human(ID1), [otherSession], other)).sessions[0]!.forms.map((f) => f.formId))
      .toEqual([form]);
    // The teammate, bound from its own space, is not.
    expect((await pending(service, agent(await newSession()), [otherSession], other)).sessions).toEqual([]);
  });

  it('counts queued deliveries, so an exited session with a queued answer is listed', async () => {
    const { service, openForm, submit } = world();
    const s = await newSession();
    const form = await openForm(s, QUEUE);
    await setStatus(s, 'exited');
    await submit(form, { pick: { value: 'x' } });
    expect((await pending(service, human(ID2), [s])).sessions).toEqual([
      { workSessionId: s, total: 0, queued: 1, forms: [] },
    ]);
  });

  it('queued counts only answers waiting for THIS session to come back (advisor D1)', async () => {
    const { service, openForm, submit } = world({ hooks: false });
    const bare = new W2FormsService({ db, config: {} as FacadeDeps['config'], owner: async () => owner });
    const s = await newSession();
    const view = await submit(await openForm(s, QUEUE), { pick: { value: 'x' } });
    // Live, with a pending row: in flight, not queued.
    expect((await pending(service, human(ID2), [s])).sessions).toEqual([]);
    // Exited: now it waits for the session.
    await setStatus(s, 'exited');
    expect((await pending(service, human(ID2), [s])).sessions).toEqual([
      { workSessionId: s, total: 0, queued: 1, forms: [] },
    ]);
    // A resume in progress still counts.
    await setStatus(s, 'spawning');
    expect((await pending(service, human(ID2), [s])).sessions[0]!.queued).toBe(1);
    await setStatus(s, 'exited');
    // Routed to a new session: no longer waiting on the old one.
    await sql(`update public.form_deliveries set status = 'cancelled', last_error = 'resume_unavailable: x'
                where response_id = $1`, [view.id]);
    await redeliver(bare, human(ID2), view.id);
    expect((await delivery(view.id))).toMatchObject({ status: 'pending', route_override: 'new_session' });
    expect((await pending(service, human(ID2), [s])).sessions).toEqual([]);
    // A form configured with target new_session never queues on the requester.
    const t = await newSession();
    await submit(await openForm(t, NEW_SESSION), { pick: { value: 'x' } });
    await setStatus(t, 'exited');
    expect((await pending(service, human(ID2), [t])).sessions).toEqual([]);
  });

  it(`caps the list at ${FORMS_PENDING_MAX_FORMS}, newest first, while total counts them all; request order is kept`, async () => {
    const { service, openForm } = world({ hooks: false });
    const busy = await newSession();
    const quiet = await newSession();
    const quietForm = await openForm(quiet);
    const forms: string[] = [];
    for (let i = 0; i < FORMS_PENDING_MAX_FORMS + 2; i += 1) forms.push(await openForm(busy));
    const result = await pending(service, human(ID2), [quiet, busy]);
    expect(result.sessions.map((s) => s.workSessionId)).toEqual([quiet, busy]);
    expect(result.sessions[0]!.forms.map((f) => f.formId)).toEqual([quietForm]);
    expect(result.sessions[1]!.total).toBe(FORMS_PENDING_MAX_FORMS + 2);
    expect(result.sessions[1]!.forms.map((f) => f.formId)).toEqual(forms.reverse().slice(0, FORMS_PENDING_MAX_FORMS));
  });

  it('refuses more than 100 ids, duplicates and malformed ids; unknown ids are absent', async () => {
    const { service } = world({ hooks: false });
    const many = Array.from({ length: 101 }, () => randomUUID());
    expect((await refusal(pending(service, human(ID2), many))).code).toBe('invalid_input');
    const one = randomUUID();
    expect((await refusal(pending(service, human(ID2), [one, one]))).code).toBe('invalid_input');
    expect((await refusal(pending(service, human(ID2), ['nope']))).code).toBe('invalid_input');
    expect((await pending(service, human(ID2), [one])).sessions).toEqual([]);
  });

  it('another space\'s id reads nothing', async () => {
    const { service, openForm } = world({ hooks: false });
    const s = await newSession();
    await openForm(s);
    expect((await pending(service, human(ID2), [s], randomUUID())).sessions).toEqual([]);
  });
});
