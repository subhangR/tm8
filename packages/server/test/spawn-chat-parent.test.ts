/**
 * 176 — A CHAT IS THE PARENT OF WHAT IT SPAWNS, AND THE MANIFEST SAYS SO.
 *
 * Two facts meet in `execution.spawn` and neither is expressible by the client:
 *
 *   1. `parentSessionId` may come from the CALLER'S OWN CREDENTIAL. A chat
 *      runtime dispatching through `tm8_delegate` holds an `agent_runtime`
 *      bearer whose row records `runtime_chat_id`; before 176 there was no id
 *      to name and every worker a chat spawned was born an orphan. That
 *      derivation landed in Wave 1 with no test of its own — this file is it,
 *      and it asserts on the argument that reaches `public.execution_spawn`,
 *      because that positional is what the graph actually persists.
 *
 *   2. WHAT that parent is. `loadSpawnContext` resolves the parent's kind in
 *      the same transaction as the persona, so the manifest's coordinator block
 *      can tell a worker whether its return address is a work session or a
 *      chat. Read from `public.entities` under the caller's RLS and never from
 *      the request: a client-supplied kind would be a claim about someone
 *      else's row.
 *
 * The fake `Db` answers by SQL SHAPE rather than by call order, so a query
 * added to the loader cannot silently take another one's answer.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { DbGraphPort, registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { OperationName } from '@tm8/contract';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PARENT_SESSION = '55555555-5555-4555-8555-555555555555';
const CHAT = '66666666-6666-4666-8666-666666666666';
const AUTH_SESSION = '77777777-7777-4777-8777-777777777777';

/** The positional `execution_spawn` takes the parent on — 007's declared order. */
const PARENT_ARG_INDEX = 16;

class SpawnDb implements Db {
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];
  /** Every `public.entities` kind lookup the loader made, in order. */
  readonly kindLookups: unknown[][] = [];

  constructor(private readonly parentKind: string | null = 'work_session') {}

  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async <R>(sql: string, args: readonly unknown[] = []): Promise<R[]> => {
        if (sql.includes('from public.team_members')) {
          return [{
            entity_id: TEAMMATE, name: 'Draco', role: 'PTY engineer',
            identity: 'terminal seam', memories: [], model: 'opus',
            agent_tool: 'claude-code', mode: 'worker', permission_mode: null,
            avatar: null, capabilities: {}, command_permissions: {},
          }] as R[];
        }
        // The parent-kind read: `public.entities` with no other table joined.
        if (sql.includes('from public.entities e') && sql.includes('select e.kind')) {
          this.kindLookups.push([...args]);
          return (this.parentKind === null ? [] : [{ kind: this.parentKind }]) as R[];
        }
        return [];
      },
      rpc: async <T2>(fn: string, rpcArgs: readonly unknown[] = []): Promise<T2> =>
        this.rpc<T2>(claims, fn, rpcArgs),
    };
    return run(q);
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.rpcCalls.push({ fn, args });
    if (fn === 'public.execution_spawn') {
      return { entity: { id: SESSION }, patches: [], __tm8_replayed: false } as T;
    }
    if (fn === 'internal.w2_resolve_interaction_profile_for_launch') {
      return {
        profileId: null, profileVersion: null, templateKey: 'tm8.chat.core',
        templateVersion: 1, resolvedHash: 'core-hash', source: 'core_default',
        snapshot: { profile: { source: 'core_default' } },
      } as T;
    }
    if (fn === 'public.issue_work_session_agent_session') return { id: AUTH_SESSION } as T;
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return {
        workSessionId: SESSION, pinRevision: 1, profileId: null, profileVersion: null,
        templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'core-hash',
        source: 'core_default', createdAt: '2026-09-03T00:00:00.000Z',
      } as T;
    }
    if (fn === 'read_account_git_credential') return null as T;
    return {} as T;
  }

  async query<R>(): Promise<R[]> { return []; }
  async end(): Promise<void> {}
}

/**
 * A `claude` on PATH that never runs. The spawn gate resolves the agent binary
 * before it builds a command; without one the launch dies at `agent CLI
 * 'claude-code' was not found` and never reaches the assertions.
 */
async function stubClaudeOnPath(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'tm8-chatparent-bin-'));
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
  return binDir;
}

function spawnCtx(identity: RequestIdentity, body: Record<string, unknown>): RequestContext {
  return {
    op: {} as never,
    opName: 'execution.spawn' as OperationName,
    params: {},
    query: new URLSearchParams(),
    body,
    requestId: 'req-chat-parent',
    identity,
    headers: {},
    method: 'POST',
    path: '/v2/execution/spawn',
  };
}

describe('execution.spawn — the parent a chat runtime cannot name (176)', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (binDir) await rm(binDir, { recursive: true, force: true });
    dataDir = undefined;
    binDir = undefined;
  });

  async function runSpawn(identity: RequestIdentity, body: Record<string, unknown> = {}) {
    binDir = await stubClaudeOnPath();
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-chatparent-data-'));
    const db = new SpawnDb('chat');
    const registry = new HandlerRegistry();
    registerExecutionHandlers(registry, {
      db,
      pty: {
        beginPromptHandoff: vi.fn(),
        spawnIfAbsent: vi.fn(() => ({ reused: false })),
        waitForBootSettlement: vi.fn(async () => null),
        liveSessionIds: () => [],
      } as never,
      dataDir,
      config: { host: '127.0.0.1', port: 4616 } as never,
      owner: async () => ({
        identityId: 'owner-identity', accountId: 'owner-account', username: 'owner',
        isNodeAdmin: true, isOwner: true,
      }),
    });
    const handler = registry.get('execution.spawn' as OperationName);
    expect(handler).toBeDefined();
    // The RESPONSE is rendered by re-reading the new work_session through the
    // ordinary entity path, which this fake Db does not serve — it exists to
    // record RPC arguments, not to be a database. The spawn itself has already
    // happened by then, so the recorded `execution_spawn` call is the subject
    // either way; a refusal BEFORE the RPC (the root-spawn case below) is a
    // different outcome and stays visible because no call is recorded.
    try {
      await handler?.(spawnCtx(identity, {
        spaceId: SPACE,
        teamMemberId: TEAMMATE,
        mode: 'coordinated-worker',
        model: 'opus',
        agentTool: 'claude-code',
        accessMode: 'acceptEdits',
        ...body,
      }));
    } catch (error) {
      if (!(error instanceof Error) || !/no such entity/.test(error.message)) throw error;
    }
    return db;
  }

  it('parents the worker on the calling chat when the request names no parent', async () => {
    const db = await runSpawn({
      kind: 'bearer',
      identityId: 'chat-identity',
      authKind: 'agent_runtime',
      runtimeChatId: CHAT,
    });

    const spawn = db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn');
    expect(spawn?.args[PARENT_ARG_INDEX]).toBe(CHAT);
  });

  it('lets an EXPLICIT parent win over the ambient one — the argument is not a lie', async () => {
    const db = await runSpawn(
      { kind: 'bearer', identityId: 'chat-identity', authKind: 'agent_runtime', runtimeChatId: CHAT },
      { parentSessionId: PARENT_SESSION },
    );

    const spawn = db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn');
    expect(spawn?.args[PARENT_ARG_INDEX]).toBe(PARENT_SESSION);
  });

  it('parents nothing for a non-bearer caller, which has no runtime chat at all', async () => {
    // `coordinated-worker` needs a return address, so a root spawn from the
    // owner UI is refused rather than launched parentless — the refusal IS the
    // evidence that no ambient parent was invented, and it happens BEFORE any
    // row is created, so nothing was recorded.
    await expect(runSpawn({ kind: 'auto-owner', identityId: 'owner-identity' }))
      .rejects.toThrow(/parentSessionId/);
  });
});

describe('loadSpawnContext resolves what the parent IS (176)', () => {
  const auth = { identityId: 'identity-1' };
  const input = { spaceId: SPACE, teamMemberId: TEAMMATE };

  it('reads the parent kind from the graph, scoped to the space, under the caller claims', async () => {
    const db = new SpawnDb('chat');
    const context = await new DbGraphPort(db).loadSpawnContext(auth, {
      ...input,
      parentSessionId: CHAT,
    });

    expect(context.parentKind).toBe('chat');
    expect(db.kindLookups).toEqual([[CHAT, SPACE]]);
  });

  it('names a work_session parent as such', async () => {
    const db = new SpawnDb('work_session');
    const context = await new DbGraphPort(db).loadSpawnContext(auth, {
      ...input,
      parentSessionId: PARENT_SESSION,
    });
    expect(context.parentKind).toBe('work_session');
  });

  it('costs no query at all for a root spawn', async () => {
    const db = new SpawnDb('chat');
    const context = await new DbGraphPort(db).loadSpawnContext(auth, input);

    expect(context.parentKind).toBeNull();
    expect(db.kindLookups).toEqual([]);
  });

  it('answers null — never a guess — for a parent RLS hides or a kind it does not know', async () => {
    for (const stored of [null, 'channel']) {
      const db = new SpawnDb(stored);
      const context = await new DbGraphPort(db).loadSpawnContext(auth, {
        ...input,
        parentSessionId: CHAT,
      });
      expect(context.parentKind).toBeNull();
    }
  });
});
