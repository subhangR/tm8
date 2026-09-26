/**
 * Launch v3, lane C — `execution.dispatch` newTask / dispatcherSessionId / kind,
 * the `execution.dispatchers` read, and `execution.spawn`'s newTask refusal.
 *
 * Argument-level, like `dispatch-actor-argument.test.ts`: the database is a
 * recording fake that ANSWERS the reads on this path, so every assertion is
 * about what the handler decided to send and return. The SQL half (the task
 * created in the spawn transaction, replay, the dispatcher-mode edges) is
 * `test/db/launch-v3-new-task.pg.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { SpawnService } from '@tm8/execution';
import { getOperation, type OperationName } from '@tm8/contract';

import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';

const IDS = {
  space: '11111111-1111-4111-8111-111111111111',
  subject: '22222222-2222-4222-8222-222222222222',
  task: '33333333-3333-4333-8333-333333333333',
  newestDispatcher: '44444444-4444-4444-8444-444444444444',
  namedDispatcher: '45555555-5555-4555-8555-555555555555',
  message: '55555555-5555-4555-8555-555555555556',
  createdTask: '66666666-6666-4666-8666-666666666666',
  project: '77777777-7777-4777-8777-777777777777',
  teamMember: '88888888-8888-4888-8888-888888888888',
  otherSpace: '99999999-9999-4999-8999-999999999999',
};

const OWNER: LoopbackOwner = {
  identityId: 'id_9bc5f874-fb94-474c-91bf-80f4ce5f5042',
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  username: 'owner',
  isNodeAdmin: true,
  isOwner: true,
};

const CONFIG = {
  host: '127.0.0.1',
  port: 0,
  uiDir: undefined,
  maxBodyBytes: 8 * 1024 * 1024,
  databaseUrl: 'unused',
} as unknown as ServerConfig;

interface TargetRow { mode: string | null; space_id: string }

class RecordingDb implements Db {
  readonly rpcCalls: Array<{ fn: string; args: unknown[] }> = [];
  readonly batchBodies: string[] = [];
  /** What `assertDispatcherTarget` reads for the named session. */
  target: TargetRow | null = { mode: 'dispatcher', space_id: IDS.space };
  dispatcherRows: Record<string, unknown>[] = [];
  spaceReadable = true;

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async () => [] as never[],
      rpc: async (fn2: string, args?: readonly unknown[]) => {
        if (fn2 === 'w2_post_message_batch') {
          this.batchBodies.push(String(args?.[1]));
          return { messageIds: [IDS.message] } as never;
        }
        return {} as never;
      },
    };
    return fn(q);
  }

  async rpc<T = unknown>(_claims: DbClaims, fn: string, args?: readonly unknown[]): Promise<T> {
    this.rpcCalls.push({ fn, args: [...(args ?? [])] });
    if (fn === 'public.derive_task_for_entity') return { taskId: IDS.task } as T;
    if (fn === 'public.execution_dispatch_new_task') return { taskId: IDS.createdTask } as T;
    return {} as T;
  }

  async query<R = Record<string, unknown>>(_claims: DbClaims, sql: string): Promise<R[]> {
    if (sql.includes('from public.spaces s')) {
      return (this.spaceReadable ? [{ id: IDS.space }] : []) as unknown as R[];
    }
    if (sql.includes('ws.mode, e.space_id')) {
      return (this.target ? [this.target] : []) as unknown as R[];
    }
    if (sql.includes('teammate_name')) return this.dispatcherRows as unknown as R[];
    // `findLiveDispatcherSession` — the newest live dispatcher.
    return [{ id: IDS.newestDispatcher }] as unknown as R[];
  }

  async end(): Promise<void> {}
}

function harness(live: string[] = [IDS.newestDispatcher, IDS.namedDispatcher]) {
  const registry = new HandlerRegistry();
  const db = new RecordingDb();
  registerExecutionHandlers(registry, {
    db,
    pty: { liveSessionIds: () => live } as never,
    config: CONFIG,
    owner: async () => OWNER,
  });
  const call = (opName: string, ctx: Partial<RequestContext>) => {
    const handler = registry.get(opName as OperationName);
    if (!handler) throw new Error(`${opName} not registered`);
    return handler({
      op: getOperation(opName as OperationName)!,
      opName,
      params: {},
      query: new URLSearchParams(),
      requestId: 'req-launch-v3',
      identity: { kind: 'auto-owner', identityId: OWNER.identityId, authKind: 'browser' } as RequestIdentity,
      headers: {},
      method: 'POST',
      path: '/',
      ...ctx,
    } as unknown as RequestContext);
  };
  return { db, call };
}

async function bodyOf(response: unknown): Promise<Record<string, unknown>> {
  return (response as { data: Record<string, unknown> }).data;
}

function dispatch(h: ReturnType<typeof harness>, body: Record<string, unknown>) {
  return h.call('execution.dispatch', {
    body: { spaceId: IDS.space, clientMutationId: 'cmid-v3', ...body },
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { reason?: unknown } };
    return { code: String(e.code), reason: e.details?.reason };
  }
  throw new Error('expected a refusal');
}

describe('execution.dispatch newTask (launch v3 gap 4)', () => {
  it('creates the task under its own ledger key and answers taskCreated', async () => {
    const h = harness();
    const result = await bodyOf(await dispatch(h, { newTask: { title: 'Do it', projectId: IDS.project } }));

    const create = h.db.rpcCalls.find((c) => c.fn === 'public.execution_dispatch_new_task');
    expect(create?.args).toEqual([IDS.space, 'Do it', IDS.project, null, 'cmid-v3:new-task']);
    expect(h.db.rpcCalls.some((c) => c.fn === 'public.derive_task_for_entity')).toBe(false);
    expect(result).toMatchObject({ taskId: IDS.createdTask, taskCreated: true });
  });

  it('answers taskCreated false for a subject', async () => {
    const h = harness();
    const result = await bodyOf(await dispatch(h, { subjectId: IDS.subject }));
    expect(result).toMatchObject({ taskId: IDS.task, taskCreated: false });
  });

  for (const [label, body] of [
    ['neither subjectId nor newTask', {}],
    ['both subjectId and newTask', { subjectId: IDS.subject, newTask: { title: 'x' } }],
    ['newTask with forceNewTask', { newTask: { title: 'x' }, forceNewTask: true }],
  ] as const) {
    it(`refuses ${label} with new_task_conflict, writing nothing`, async () => {
      const h = harness();
      expect(await refusal(dispatch(h, body))).toEqual({ code: 'invalid_input', reason: 'new_task_conflict' });
      expect(h.db.rpcCalls).toEqual([]);
      expect(h.db.batchBodies).toEqual([]);
    });
  }
});

describe('execution.dispatch dispatcherSessionId + kind (launch v3 gap 5)', () => {
  it('routes to the named dispatcher while it is live', async () => {
    const h = harness();
    const result = await bodyOf(await dispatch(h, { subjectId: IDS.subject, dispatcherSessionId: IDS.namedDispatcher }));
    expect(result).toMatchObject({ dispatcherSessionId: IDS.namedDispatcher, dispatcherSpawned: false });
  });

  it('falls back to the newest live dispatcher when the named one is not live', async () => {
    const h = harness([IDS.newestDispatcher]);
    const result = await bodyOf(await dispatch(h, { subjectId: IDS.subject, dispatcherSessionId: IDS.namedDispatcher }));
    expect(result).toMatchObject({ dispatcherSessionId: IDS.newestDispatcher, dispatcherSpawned: false });
  });

  for (const [label, target] of [
    ['not a dispatcher', { mode: 'worker', space_id: IDS.space }],
    ['in another space', { mode: 'dispatcher', space_id: IDS.otherSpace }],
    ['unreadable', null],
  ] as const) {
    it(`refuses a session that is ${label} with not_a_dispatcher, before any task is written`, async () => {
      const h = harness();
      h.db.target = target;
      expect(
        await refusal(dispatch(h, { newTask: { title: 'x' }, dispatcherSessionId: IDS.namedDispatcher })),
      ).toEqual({ code: 'invalid_input', reason: 'not_a_dispatcher' });
      expect(h.db.rpcCalls).toEqual([]);
    });
  }

  it('carries kind in the stored routing request, worker by default', async () => {
    const h = harness();
    await dispatch(h, { subjectId: IDS.subject, kind: 'coordinator' });
    await dispatch(h, { subjectId: IDS.subject, clientMutationId: 'cmid-v3-b' });
    expect(h.db.batchBodies[0]).toContain('coordinator session');
    expect(h.db.batchBodies[1]).toContain('worker session');
  });
});

describe('execution.dispatchers (launch v3 gap 5)', () => {
  it('lists dispatchers newest first with probed liveness and null queuedCount', async () => {
    const h = harness([IDS.namedDispatcher]);
    h.db.dispatcherRows = [
      { session_id: IDS.namedDispatcher, team_member_id: IDS.teamMember, teammate_name: 'Router', title: 'Dispatcher', purpose: 'Routes work' },
      { session_id: IDS.newestDispatcher, team_member_id: IDS.teamMember, teammate_name: 'Router', title: '', purpose: null },
      { session_id: IDS.task, team_member_id: null, teammate_name: null, title: 'orphan', purpose: null },
    ];
    const result = await bodyOf(await h.call('execution.dispatchers', { method: 'GET', params: { spaceId: IDS.space } }));
    expect(result).toEqual({
      dispatchers: [
        { sessionId: IDS.namedDispatcher, teamMemberId: IDS.teamMember, teammateName: 'Router', title: 'Dispatcher', purpose: 'Routes work', live: true, queuedCount: null },
        { sessionId: IDS.newestDispatcher, teamMemberId: IDS.teamMember, teammateName: 'Router', title: '', purpose: null, live: false, queuedCount: null },
      ],
    });
  });

  it('answers not_found for a space the caller cannot read', async () => {
    const h = harness();
    h.db.spaceReadable = false;
    expect((await refusal(h.call('execution.dispatchers', { method: 'GET', params: { spaceId: IDS.space } }))).code).toBe('not_found');
  });
});

describe('execution.spawn newTask refusal (launch v3 gap 4)', () => {
  for (const [label, extra] of [
    ['taskIds', { taskIds: [IDS.task] }],
    ['forceNewTask', { forceNewTask: true }],
  ] as const) {
    it(`refuses newTask with ${label} as new_task_conflict before anything is written`, async () => {
      const h = harness();
      const error = await refusal(
        h.call('execution.spawn', {
          body: {
            spaceId: IDS.space,
            teamMemberId: IDS.teamMember,
            clientMutationId: 'cmid-spawn',
            newTask: { title: 'x' },
            ...extra,
          },
        }),
      );
      expect(error).toEqual({ code: 'invalid_input', reason: 'new_task_conflict' });
      expect(h.db.rpcCalls).toEqual([]);
    });
  }
});

describe('in-flight retries share the attempt they retry (STATUS-1)', () => {
  it('a same-cmid dispatch retried while the first is running creates one task and answers the same result', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rpc = h.db.rpc.bind(h.db);
    h.db.rpc = async <T,>(claims: DbClaims, fn: string, args?: readonly unknown[]): Promise<T> => {
      if (fn === 'public.execution_dispatch_new_task') await gate;
      return rpc<T>(claims, fn, args);
    };
    const first = dispatch(h, { newTask: { title: 'Once' }, clientMutationId: 'cmid-inflight' });
    const retry = dispatch(h, { newTask: { title: 'Once' }, clientMutationId: 'cmid-inflight' });
    release();
    const [a, b] = await Promise.all([first, retry]);
    expect(b).toBe(a);
    expect(h.db.rpcCalls.filter((c) => c.fn === 'public.execution_dispatch_new_task')).toHaveLength(1);
    expect(h.db.batchBodies).toHaveLength(1);
  });

  it('never shares an attempt across clientMutationIds', async () => {
    const h = harness();
    await Promise.all([
      dispatch(h, { newTask: { title: 'A' }, clientMutationId: 'cmid-a' }),
      dispatch(h, { newTask: { title: 'B' }, clientMutationId: 'cmid-b' }),
    ]);
    expect(h.db.rpcCalls.filter((c) => c.fn === 'public.execution_dispatch_new_task')).toHaveLength(2);
  });

  it('a same-cmid spawn retried while the first is running starts one session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spawn = vi.spyOn(SpawnService.prototype, 'spawn').mockImplementation(async () => {
      await gate;
      return { sessionId: IDS.newestDispatcher, commandResult: {}, createdTaskId: IDS.createdTask } as never;
    });
    try {
      const h = harness();
      const body = { spaceId: IDS.space, teamMemberId: IDS.teamMember, clientMutationId: 'cmid-spawn-inflight', newTask: { title: 'x' } };
      const first = h.call('execution.spawn', { body });
      const retry = h.call('execution.spawn', { body });
      release();
      const [a, b] = await Promise.all([first, retry]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(b).toBe(a);
      expect((a as { data: { createdTaskId?: string } }).data.createdTaskId).toBe(IDS.createdTask);
    } finally {
      spawn.mockRestore();
    }
  });
});
