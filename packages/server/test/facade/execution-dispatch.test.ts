/**
 * execution.dispatch — what it hands Postgres as the requesting ACTOR.
 *
 * The handler is driven as a function with a fake `Db` and a fake PTY host, so
 * no Postgres and no agent are needed: the dispatcher session is already live,
 * which is the path every real dispatch after the first one takes.
 *
 * The assertion is narrow on purpose. `w2_post_message_batch`'s `p_actor_id` is
 * a `uuid` (019:345), while a LoopbackOwner carries an `id_…` IDENTITY string
 * and no member id at all. Both are `string` in TypeScript, so the one thing
 * that separates a working dispatch from `22P02 invalid input syntax for type
 * uuid` is invisible to the compiler — it has to be asserted here.
 */
import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import type { Db } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const DISPATCHER_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';

/** `p_actor_id` is the 7th positional argument of `w2_post_message_batch`. */
const ACTOR_ARG = 6;

function buildHandler(): { handler: OperationHandler; postArgs: () => unknown[] } {
  let postArgs: unknown[] = [];
  const q = {
    rpc: async (_name: string, args: unknown[]) => {
      postArgs = args;
      return { messageIds: ['66666666-6666-4666-8666-666666666666'] };
    },
  };
  const db: Db = {
    // The only rpc the handler makes outside the transaction is the task
    // derivation; inside it, the message post.
    rpc: async () => ({ taskId: TASK_ID }),
    query: async () => [{ id: DISPATCHER_SESSION_ID }],
    tx: async (_claims: unknown, run: (tx: typeof q) => Promise<unknown>) => run(q),
  } as unknown as Db;
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    uiDir: undefined,
    maxBodyBytes: 8 * 1024 * 1024,
    databaseUrl: 'unused',
  } as unknown as ServerConfig;
  const registry = new HandlerRegistry();
  registerExecutionHandlers(registry, {
    db,
    // A live dispatcher, so nothing is spawned and the SpawnService is untouched.
    pty: { liveSessionIds: () => [DISPATCHER_SESSION_ID] } as never,
    config,
    owner: async () =>
      ({
        identityId: 'id_e6c364a9-108f-40cf-943a-bf8f2fd525e9',
        accountId: 'acct',
        username: 'owner',
        isNodeAdmin: true,
        isOwner: true,
      }) as never,
  });
  const handler = registry.get('execution.dispatch');
  if (!handler) throw new Error('execution.dispatch not registered');
  return { handler, postArgs: () => postArgs };
}

function ctxFor(body: Record<string, unknown>): RequestContext {
  return {
    params: {},
    query: new URLSearchParams(),
    body,
    requestId: 'req-1',
    identity: { kind: 'auto-owner', identityId: 'id_e6c364a9-108f-40cf-943a-bf8f2fd525e9' },
  } as unknown as RequestContext;
}

describe('execution.dispatch requester actor', () => {
  it('sends NO actor when the caller named none — never the `id_…` identity', async () => {
    const { handler, postArgs } = buildHandler();
    await handler(ctxFor({ spaceId: SPACE_ID, subjectId: SUBJECT_ID, clientMutationId: 'cm-1' }));
    // Null is the correct absence: `resolve_actor` then derives the caller's
    // per-space member row itself. An identity string here is the shipped bug.
    expect(postArgs()[ACTOR_ARG]).toBeNull();
  });

  it('forwards an actor the caller did name', async () => {
    const { handler, postArgs } = buildHandler();
    await handler(
      ctxFor({ spaceId: SPACE_ID, subjectId: SUBJECT_ID, clientMutationId: 'cm-2', actorId: ACTOR_ID }),
    );
    expect(postArgs()[ACTOR_ARG]).toBe(ACTOR_ID);
  });
});
