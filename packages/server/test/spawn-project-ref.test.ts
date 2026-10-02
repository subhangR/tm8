// `--launch-project` takes either id a project has: the space's project ENTITY
// id (`tm8 entity query --kind project`) or its folder/resource id. The loader
// resolves both through `resolve_project_ref`, but `execution_spawn` and
// `start_shell_session` look the id up in `public.projects` — by folder id
// only. Forwarding the raw request id refused an entity-id launch with a bare
// `not_found`. These pin that the RESOLVED folder id reaches the RPC, and that
// an id resolving to nothing is refused with a reason before any row is written.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const PROJECT_ENTITY = '77777777-7777-4777-8777-777777777777';
const UNKNOWN = '88888888-8888-4888-8888-888888888888';
const SESSION = '44444444-4444-4444-8444-444444444444';
const AUTH_SESSION = '66666666-6666-4666-8666-666666666666';

class SpawnDb implements Db {
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];

  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    return run(this.querier(claims));
  }

  private querier(claims: DbClaims): Querier {
    return {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
        if (sql.includes('from public.team_members')) {
          return [{
            entity_id: TEAMMATE, name: 'GPT 5.6 Teammate', role: 'Launch persona',
            identity: 'OpenAI GPT 5.6 via codex', memories: [], model: 'gpt-5.6-sol',
            agent_tool: 'codex', mode: 'worker', permission_mode: null, avatar: null,
            capabilities: {}, command_permissions: {},
          }] as R[];
        }
        if (sql.includes('public.resolve_project_ref')) {
          // The real resolver: the entity id and the folder id answer the same
          // folder; anything else answers nothing.
          return params[0] === PROJECT_ENTITY || params[0] === FOLDER
            ? ([{ id: FOLDER, name: 'tm8', working_dir: process.cwd(), trust: 'trusted' }] as R[])
            : [];
        }
        return [];
      },
      rpc: async <T2>(fn: string, rpcArgs: readonly unknown[] = []): Promise<T2> =>
        this.rpc<T2>(claims, fn, rpcArgs),
    };
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.rpcCalls.push({ fn, args });
    if (fn === 'public.execution_spawn' || fn === 'public.start_shell_session') {
      return { entity: { id: SESSION }, patches: [], __tm8_replayed: false } as T;
    }
    if (fn === 'internal.w2_resolve_interaction_profile_for_launch') {
      return {
        profileId: null, profileVersion: null, templateKey: 'tm8.chat.core', templateVersion: 1,
        resolvedHash: 'core-hash', source: 'core_default', snapshot: { profile: { source: 'core_default' } },
      } as T;
    }
    if (fn === 'resolve_auth_session') return { sessionId: AUTH_SESSION, viaLinkId: null } as T;
    if (fn === 'public.issue_work_session_agent_session') return { id: AUTH_SESSION } as T;
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return {
        workSessionId: SESSION, pinRevision: 1, profileId: null, profileVersion: null,
        templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'core-hash',
        source: 'core_default', createdAt: '2026-07-29T00:00:00.000Z',
      } as T;
    }
    if (fn === 'read_account_git_credential') return null as T;
    return {} as T;
  }

  async query<R>(claims: DbClaims, sql: string, params?: readonly unknown[]): Promise<R[]> {
    return this.querier(claims).query<R>(sql, params);
  }
  async end(): Promise<void> {}
}

/** See spawn-stub-pty.test.ts: a `codex` that answers the spawn gate's preflight. */
async function stubCodexOnPath(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'tm8-stub-bin-'));
  await writeFile(
    join(binDir, 'codex'),
    '#!/bin/sh\n'
      + 'if [ "$1" = "sandbox" ]; then echo "TM8_SANDBOX_PROBE_OK"; exit 0; fi\n'
      + 'case "$*" in\n'
      + '  *--version*) echo "codex-cli 999.0.0" ;;\n'
      + '  *) echo "network_proxy   stable   true" ;;\n'
      + 'esac\n',
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
  return binDir;
}

describe('a launch project named by entity id or folder id', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (binDir) await rm(binDir, { recursive: true, force: true });
  });

  async function runtimeFor(db: SpawnDb) {
    binDir = await stubCodexOnPath();
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-spawn-project-ref-'));
    const pty = {
      beginPromptHandoff: vi.fn(),
      spawnIfAbsent: vi.fn(() => ({ reused: false })),
      waitForBootSettlement: vi.fn(async () => null),
      kill: vi.fn(),
      liveSessionIds: () => [],
    };
    return registerExecutionHandlers(new HandlerRegistry(), {
      db,
      pty: pty as never,
      dataDir,
      config: { host: '127.0.0.1', port: 4610 } as never,
      owner: async () => ({
        identityId: 'owner-identity', accountId: 'owner-account', username: 'owner',
        isNodeAdmin: true, isOwner: true,
      }),
    });
  }

  const spawnRequest = (projectId: string) => ({
    spaceId: SPACE,
    teamMemberId: TEAMMATE,
    projectId,
    workdir: { mode: 'project' as const },
    mode: 'worker' as const,
    accessMode: 'acceptEdits' as const,
    model: 'gpt-5.6-sol',
    agentTool: 'codex' as const,
    credentialSources: { openai: 'node' as const, github: 'member' as const },
    clientMutationId: `spawn-project-ref-${projectId}`,
  });
  const AUTH = { identityId: 'owner-identity', nodeAdmin: true };

  it.each([
    ['the project entity id', PROJECT_ENTITY],
    ['the folder id', FOLDER],
  ])('spawn with %s hands execution_spawn the folder id', async (_label, ref) => {
    const db = new SpawnDb();
    const runtime = await runtimeFor(db);

    const result = await runtime.spawnService.spawn(AUTH, spawnRequest(ref));

    expect(result.sessionId).toBe(SESSION);
    const call = db.rpcCalls.find((c) => c.fn === 'public.execution_spawn');
    expect(call?.args[3]).toBe(FOLDER);
  });

  it('an unknown project id is refused with a reason, before any row is written', async () => {
    const db = new SpawnDb();
    const runtime = await runtimeFor(db);

    await expect(runtime.spawnService.spawn(AUTH, spawnRequest(UNKNOWN))).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'project_not_linked', projectId: UNKNOWN },
    });
    expect(db.rpcCalls.some((c) => c.fn === 'public.execution_spawn')).toBe(false);
  });

  it('a terminal started on the project entity id hands start_shell_session the folder id', async () => {
    const db = new SpawnDb();
    const runtime = await runtimeFor(db);

    await runtime.spawnService.startShell(AUTH, {
      spaceId: SPACE,
      projectId: PROJECT_ENTITY,
      clientMutationId: 'shell-project-ref',
    });

    const call = db.rpcCalls.find((c) => c.fn === 'public.start_shell_session');
    expect(call?.args[1]).toBe(FOLDER);
  });
});
