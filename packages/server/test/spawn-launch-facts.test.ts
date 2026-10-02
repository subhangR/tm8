/**
 * `execution.spawn` answers with the posture the child RESOLVED — access mode
 * and which link chose it, the credential each provider ran on, and the parent
 * — so `tm8 session spawn`'s receipt can show what a child inherited without a
 * second read (before this, only `tm8 session launch <id>` could).
 *
 * The fake `Db` answers by SQL shape, as in spawn-chat-parent.test.ts. The
 * response re-read (`toCommandResult`) is stubbed to echo the RPC's entity:
 * this file is about the `launch` block beside it, not the entity projection.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { CollabError, ExecutionSpawnLaunchSchema, type ExecutionSpawnResult, type OperationName } from '@tm8/contract';
import type { RequestContext } from '../src/http/types.js';

vi.mock('../src/facade/handlers/entities.js', async (original) => ({
  ...(await original<typeof import('../src/facade/handlers/entities.js')>()),
  toCommandResult: async (_q: unknown, raw: { entity?: unknown }) => ({ entity: raw.entity, patches: [] }),
}));

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PARENT_SESSION = '55555555-5555-4555-8555-555555555555';
const AUTH_SESSION = '77777777-7777-4777-8777-777777777777';

class SpawnDb implements Db {
  /** The parent's recorded manifest posture; null means none was recorded. */
  constructor(private readonly parentPosture: Record<string, unknown> | null) {}

  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async <R>(sql: string): Promise<R[]> => this.answer<R>(sql),
      rpc: async <T2>(fn: string, rpcArgs: readonly unknown[] = []): Promise<T2> =>
        this.rpc<T2>(claims, fn, rpcArgs),
    };
    return run(q);
  }

  private answer<R>(sql: string): R[] {
    if (sql.includes('from public.team_members')) {
      return [{
        entity_id: TEAMMATE, name: 'Draco', role: 'PTY engineer',
        identity: 'terminal seam', memories: [], model: 'opus',
        // The persona says `interactive`: an inherited `fullAccess` cannot be its.
        agent_tool: 'claude-code', mode: 'worker', permission_mode: 'interactive',
        avatar: null, capabilities: {}, command_permissions: {},
      }] as R[];
    }
    if (sql.includes('from public.entities e') && sql.includes('select e.kind')) {
      return [{ kind: 'work_session' }] as R[];
    }
    if (sql.includes("'{launch,accessMode}'")) {
      return (this.parentPosture === null ? [] : [this.parentPosture]) as R[];
    }
    return [];
  }

  async rpc<T>(_claims: DbClaims, fn: string, _args: readonly unknown[] = []): Promise<T> {
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
    if (fn === 'resolve_auth_session') return { sessionId: AUTH_SESSION, viaLinkId: null } as T;
    if (fn === 'public.issue_work_session_agent_session') return { id: AUTH_SESSION } as T;
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return {
        workSessionId: SESSION, pinRevision: 1, profileId: null, profileVersion: null,
        templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'core-hash',
        source: 'core_default', createdAt: '2026-10-02T00:00:00.000Z',
      } as T;
    }
    if (fn === 'read_account_git_credential') return null as T;
    if (fn === 'read_space_credential_for_spawn') {
      throw new CollabError('not_found', 'this space has no default credential', { details: { reason: 'no_default' } });
    }
    return {} as T;
  }

  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> { return this.answer<R>(sql); }
  async end(): Promise<void> {}
}

describe('execution.spawn — the resolved launch facts', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function spawn(body: Record<string, unknown>, parentPosture: Record<string, unknown> | null = null) {
    const binDir = await mkdtemp(join(tmpdir(), 'tm8-launchfacts-bin-'));
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('TM8_PERMISSION_MODE', '');
    const dataDir = await mkdtemp(join(tmpdir(), 'tm8-launchfacts-data-'));
    dirs.push(binDir, dataDir);
    const registry = new HandlerRegistry();
    registerExecutionHandlers(registry, {
      db: new SpawnDb(parentPosture),
      pty: {
        beginPromptHandoff: vi.fn(),
        spawnIfAbsent: vi.fn(() => ({ reused: false })),
        waitForBootSettlement: vi.fn(async () => null),
        liveSessionIds: () => [],
      } as never,
      dataDir,
      config: { host: '127.0.0.1', port: 4617 } as never,
      owner: async () => ({
        identityId: 'owner-identity', accountId: 'owner-account', username: 'owner',
        isNodeAdmin: true, isOwner: true,
      }),
    });
    const ctx: RequestContext = {
      op: {} as never,
      opName: 'execution.spawn' as OperationName,
      params: {},
      query: new URLSearchParams(),
      body: { spaceId: SPACE, teamMemberId: TEAMMATE, model: 'opus', agentTool: 'claude-code', ...body },
      requestId: 'req-launch-facts',
      identity: { kind: 'cli', identityId: 'owner-identity' } as never,
      headers: {},
      method: 'POST',
      path: '/v2/execution/spawn',
    };
    const response = await registry.get('execution.spawn' as OperationName)!(ctx) as { status: number; data: unknown };
    expect(response.status).toBe(201);
    const result = response.data as ExecutionSpawnResult;
    // The wire shape the contract declares, strictly (the stubbed entity is not a detail).
    const parsed = ExecutionSpawnLaunchSchema.safeParse(result.launch);
    expect(parsed.error?.issues).toBeUndefined();
    return result;
  }

  it('a child that names no access mode reports the parent posture as INHERITED', async () => {
    const result = await spawn(
      { parentSessionId: PARENT_SESSION, mode: 'worker' },
      { access_mode: 'fullAccess', permission_mode: 'bypassPermissions', credential_sources: { github: 'node' } },
    );
    expect(result.launch).toMatchObject({
      accessMode: 'fullAccess',
      accessModeSource: 'inherited',
      parentSessionId: PARENT_SESSION,
    });
    expect(result.launch?.credentials).toContainEqual({ provider: 'github', source: 'node' });
  });

  it('a requested access mode outranks the parent and says so; a root has a null parent', async () => {
    const child = await spawn(
      { parentSessionId: PARENT_SESSION, accessMode: 'plan' },
      { access_mode: 'fullAccess', permission_mode: 'bypassPermissions' },
    );
    expect(child.launch).toMatchObject({ accessMode: 'plan', accessModeSource: 'requested' });

    const root = await spawn({ credentialSources: { github: 'node' } });
    expect(root.launch).toMatchObject({ accessMode: 'safe', accessModeSource: 'persona', parentSessionId: null });
    expect(root.launch?.credentials).toContainEqual({ provider: 'github', source: 'node' });
  });
});
