/**
 * `execution.dispatch` — the ACTOR argument it hands to SQL.
 *
 * THE DEFECT THIS FILE IS THE ORACLE FOR
 *
 * `sendDispatchRequest` posts the durable request through
 * `public.w2_post_message_batch`, whose seventh parameter is declared
 * `p_actor_id uuid` (019:346). The handler filled it from the request envelope
 * with a fallback, and the fallback was the loopback owner's `identityId` — a
 * value `identity/ids.ts` mints as `id_` + random and documents as
 * "deliberately NOT a uuid". Every dispatch whose caller did not name an actor
 * therefore reached Postgres as `'id_9bc5f874-…'::uuid` and died with 22P02
 * `invalid input syntax for type uuid`. That is every dispatch from the UI,
 * which sends no `actorId`.
 *
 * WHY THIS IS AN ARGUMENT ASSERTION AND NOT A ROUND TRIP. The bug is not that
 * the database disagreed with us; it is that the handler put a value of the
 * wrong TYPE on the wire, and the type is knowable without a database. A pg
 * test would also catch it, but only by asserting the absence of an error — and
 * an absent error is exactly what this path reported for the whole time it was
 * broken, because the loop executor (which passes null and works) shares the
 * function. So the observer here is the ARGUMENT ITSELF: what the handler
 * decided to send, read off the wire, checked against the declared column type.
 *
 * NULL IS ALSO THE RIGHT VALUE, not merely a non-crashing one.
 * `internal.resolve_actor(requested, space)` (002:277-290) coalesces a null
 * request to `internal.actor_id()` and then to `internal.current_member_id()`,
 * so the message is authored by the CALLER either way — the fallback was not
 * even buying the provenance it appeared to buy. `messages.post` has always
 * spelled this `input.actorId ?? null`; this path is the one that drifted.
 */
import { describe, expect, it } from 'vitest';
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
  dispatcherSession: '44444444-4444-4444-8444-444444444444',
  message: '55555555-5555-4555-8555-555555555555',
  actor: '66666666-6666-4666-8666-666666666666',
};

/**
 * The shape `resolveLoopbackOwner` really produces. `identityId` is spelled out
 * as `id_` + a uuid on purpose: that is the literal value from the incident
 * report, and a tidier placeholder here would make the test pass against the
 * broken code.
 */
const OWNER: LoopbackOwner = {
  identityId: 'id_9bc5f874-fb94-474c-91bf-80f4ce5f5042',
  accountId: '77777777-7777-4777-8777-777777777777',
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

/** `p_actor_id` is the 7th positional parameter of `w2_post_message_batch`. */
const P_ACTOR_ID = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answers the three reads the dispatch path makes and records the batch call.
 *
 * It answers rather than stubbing empty because every "not found" on this path
 * throws before the RPC we are here to inspect — a silent fake would turn this
 * suite green by never reaching the assertion.
 */
class RecordingDb implements Db {
  readonly batchArgs: unknown[][] = [];

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async () => [] as never[],
      rpc: async (fn2: string, args?: readonly unknown[]) => {
        if (fn2 === 'w2_post_message_batch') {
          this.batchArgs.push([...(args ?? [])]);
          return { messageIds: [IDS.message] } as never;
        }
        return {} as never;
      },
    };
    return fn(q);
  }

  async rpc<T = unknown>(_claims: DbClaims, fn: string): Promise<T> {
    // The task derivation that opens the handler.
    if (fn === 'public.derive_task_for_entity') return { taskId: IDS.task } as T;
    return {} as T;
  }

  async query<R = Record<string, unknown>>(_claims: DbClaims, _sql: string): Promise<R[]> {
    // `findLiveDispatcherSession` — a live dispatcher, so nothing is spawned.
    return [{ id: IDS.dispatcherSession }] as unknown as R[];
  }

  async end(): Promise<void> {}
}

function harness(): { db: RecordingDb; call: (ctx: RequestContext) => Promise<unknown> } {
  const registry = new HandlerRegistry();
  const db = new RecordingDb();
  registerExecutionHandlers(registry, {
    db,
    // A dispatcher terminal is live; `findLiveDispatcherSession` intersects
    // this with the query above.
    pty: { liveSessionIds: () => [IDS.dispatcherSession] } as never,
    config: CONFIG,
    owner: async () => OWNER,
  });
  const handler = registry.get('execution.dispatch');
  if (!handler) throw new Error('execution.dispatch not registered');
  return { db, call: (ctx) => handler(ctx) };
}

function dispatchCtx(body: Record<string, unknown> = {}): RequestContext {
  const opName = 'execution.dispatch' as OperationName;
  const identity: RequestIdentity = {
    kind: 'auto-owner',
    identityId: OWNER.identityId,
    authKind: 'browser',
  };
  return {
    op: getOperation(opName)!,
    opName,
    params: {},
    query: new URLSearchParams(),
    body: {
      spaceId: IDS.space,
      subjectId: IDS.subject,
      clientMutationId: 'cmid-dispatch-1',
      ...body,
    },
    requestId: 'req-dispatch',
    identity,
    headers: {},
    method: 'POST',
    path: '/v2/execution/dispatch',
  } as unknown as RequestContext;
}

describe('execution.dispatch: the actor handed to w2_post_message_batch', () => {
  it('sends NULL when the caller names no actor — never the owner identity id', async () => {
    const { db, call } = harness();
    await call(dispatchCtx());

    expect(db.batchArgs).toHaveLength(1);
    const actorArg = db.batchArgs[0]![P_ACTOR_ID];

    // THE REGRESSION, stated as the value that was actually sent. Before the
    // fix this was `'id_9bc5f874-fb94-474c-91bf-80f4ce5f5042'`.
    expect(actorArg).toBeNull();
    expect(actorArg).not.toBe(OWNER.identityId);
  });

  it('forwards the envelope actor unchanged when the caller does name one', async () => {
    const { db, call } = harness();
    await call(dispatchCtx({ actorId: IDS.actor }));

    expect(db.batchArgs[0]![P_ACTOR_ID]).toBe(IDS.actor);
  });

  it('never puts a non-uuid in a uuid parameter, whatever the caller sent', async () => {
    // The general form of the defect: the column is `uuid`, so the only two
    // legal values on this wire are null and a uuid. An identity id is neither,
    // and so is anything else a future fallback might reach for.
    const { db, call } = harness();
    await call(dispatchCtx());
    await call(dispatchCtx({ actorId: IDS.actor, clientMutationId: 'cmid-dispatch-2' }));

    for (const args of db.batchArgs) {
      const actorArg = args[P_ACTOR_ID];
      expect(actorArg === null || (typeof actorArg === 'string' && UUID_RE.test(actorArg))).toBe(true);
    }
  });
});
