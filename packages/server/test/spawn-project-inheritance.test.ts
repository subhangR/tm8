// @vitest-environment node
/**
 * A WORKER LAUNCHED FROM A PROJECT CHAT OR SESSION WORKS IN THAT PROJECT.
 *
 * Reported in the tm8 group: "people must start chats in the chat folder".
 * A chat started in a project ran there, but a worker it spawned naming no
 * project was a scratch session in a fresh temp directory. The spawn handler
 * now gives an AGENT caller (chat runtime or worker session) its parent's
 * project when it names none; anything explicit still wins, and a person's
 * spawn is never rewritten. Same fake-Db harness as spawn-chat-parent.test.ts:
 * the subject is the argument that reaches `public.execution_spawn`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { inheritedSpawnProjectId, inheritsSpawnProject } from '../src/facade/spawn-project-inheritance.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { CollabError, type OperationName } from '@tm8/contract';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PARENT_SESSION = '55555555-5555-4555-8555-555555555555';
const CHAT = '66666666-6666-4666-8666-666666666666';
const AUTH_SESSION = '77777777-7777-4777-8777-777777777777';
const PROJECT = '88888888-8888-4888-8888-888888888888';

/** `execution_spawn` positionals (007's declared order). */
const PROJECT_ARG = 3;
const WORKDIR_MODE_ARG = 4;
const WORKDIR_PATH_ARG = 5;

class SpawnDb implements Db {
  /** `resolve_project_ref` lookups the spawn context made, in order. */
  readonly projectLookups: unknown[][] = [];
  /** The inheritance read: what the parent chat or session runs in. */
  parentProject: string | null = null;
  projectDir = '/tmp';
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];
  /** Every `public.entities` kind lookup the loader made, in order. */
  readonly kindLookups: unknown[][] = [];

  constructor(private readonly parentKind: string | null = 'work_session') {}

  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async <R>(sql: string, args: readonly unknown[] = []): Promise<R[]> => {
        // Visible teammate, with no equipped connectors in this parentage fixture.
        if (sql.includes('internal.is_space_member($2::uuid)') && sql.includes('as allowed')) {
          return [{ allowed: args[0] === TEAMMATE && args[1] === SPACE }] as R[];
        }
        if (sql.includes('from public.team_members')) {
          return [{
            entity_id: TEAMMATE, name: 'Draco', role: 'PTY engineer',
            identity: 'terminal seam', memories: [], model: 'opus',
            agent_tool: 'claude-code', mode: 'worker', permission_mode: null,
            avatar: null, capabilities: {}, command_permissions: {},
          }] as R[];
        }
        if (sql.includes('public.resolve_project_ref')) {
          this.projectLookups.push([...args]);
          return [{ id: PROJECT, name: 'Docs Site', working_dir: this.projectDir, trust: 'trusted' }] as R[];
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
    // 256 (W7p): the spawn port re-resolves the minted token to read its
    // via_link stamp. The real mint always resolves; no link here.
    if (fn === 'resolve_auth_session') return { sessionId: AUTH_SESSION, identityId: 'owner-identity', kind: 'agent', spaceId: SPACE, workSessionId: SESSION, viaLinkId: null } as T;
    if (fn === 'public.issue_work_session_agent_session') return { id: AUTH_SESSION } as T;
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return {
        workSessionId: SESSION, pinRevision: 1, profileId: null, profileVersion: null,
        templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'core-hash',
        source: 'core_default', createdAt: '2026-09-03T00:00:00.000Z',
      } as T;
    }
    if (fn === 'read_account_git_credential') return null as T;
    // As 206's read_space_credential_for_spawn answers a space with no default:
    // P0002, which the Db maps to a CollabError carrying the reason.
    if (fn === 'read_space_credential_for_spawn') {
      throw new CollabError('not_found', 'this space has no default credential', { details: { reason: 'no_default' } });
    }
    return {} as T;
  }

  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> {
    if (sql.includes('from public.chats') && sql.includes('from public.work_sessions')) {
      return (this.parentProject === null ? [] : [{ project_id: this.parentProject }]) as R[];
    }
    return [];
  }
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


const CHAT_RUNTIME: RequestIdentity = { kind: 'bearer', identityId: 'chat-identity', authKind: 'agent_runtime', runtimeChatId: CHAT } as RequestIdentity;
const WORKER: RequestIdentity = { kind: 'bearer', identityId: 'worker-identity', authKind: 'agent', workSessionId: PARENT_SESSION } as RequestIdentity;
const PERSON: RequestIdentity = { kind: 'bearer', identityId: 'person', authKind: 'browser' } as RequestIdentity;

describe('which spawns inherit their parent\'s project', () => {
  const base = { agentCaller: true, parentId: CHAT, input: {} };
  it('an agent naming no project, under a parent, inherits', () => {
    expect(inheritsSpawnProject(base)).toBe(true);
  });
  it('anything explicit wins: a projectId, a null projectId (scratch), a scratch workdir', () => {
    expect(inheritsSpawnProject({ ...base, input: { projectId: PROJECT as never } })).toBe(false);
    expect(inheritsSpawnProject({ ...base, input: { projectId: null } })).toBe(false);
    expect(inheritsSpawnProject({ ...base, input: { workdir: { mode: 'scratch' } } })).toBe(false);
  });
  it('a worktree workdir still inherits the project it is cut from', () => {
    expect(inheritsSpawnProject({ ...base, input: { workdir: { mode: 'worktree' } } })).toBe(true);
  });
  it('a person, or a spawn with no parent, is never rewritten', () => {
    expect(inheritsSpawnProject({ ...base, agentCaller: false })).toBe(false);
    expect(inheritsSpawnProject({ ...base, parentId: null })).toBe(false);
  });
  it('reads the parent under the caller\'s claims, and asks nothing when it does not inherit', async () => {
    const query = vi.fn(async () => [{ project_id: PROJECT }]);
    const db = { query } as unknown as Db;
    expect(await inheritedSpawnProjectId(db, {} as DbClaims, base)).toBe(PROJECT);
    expect(query.mock.calls[0]![2]).toEqual([CHAT]);
    query.mockClear();
    expect(await inheritedSpawnProjectId(db, {} as DbClaims, { ...base, agentCaller: false })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('execution.spawn — a worker works where its chat or session does', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of [dataDir, binDir, projectDir]) if (dir) await rm(dir, { recursive: true, force: true });
    dataDir = binDir = projectDir = undefined;
  });

  async function runSpawn(identity: RequestIdentity, parentProject: string | null, body: Record<string, unknown> = {}, parentKind = 'chat') {
    binDir = await mkdtemp(join(tmpdir(), 'tm8-inherit-bin-'));
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-inherit-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-inherit-project-'));
    const db = new SpawnDb(parentKind);
    db.parentProject = parentProject;
    db.projectDir = projectDir;
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
    const handler = registry.get('execution.spawn' as OperationName)!;
    try {
      await handler(spawnCtx(identity, {
        spaceId: SPACE, teamMemberId: TEAMMATE, mode: 'coordinated-worker',
        model: 'opus', agentTool: 'claude-code', accessMode: 'acceptEdits', ...body,
      }));
    } catch (error) {
      if (!(error instanceof Error) || !/no such entity/.test(error.message)) throw error;
    }
    return db.rpcCalls.find(({ fn }) => fn === 'public.execution_spawn')?.args;
  }

  it('a worker the chat spawns with no project starts in the chat\'s project folder', async () => {
    const args = await runSpawn(CHAT_RUNTIME, PROJECT);
    expect(args?.[PROJECT_ARG]).toBe(PROJECT);
    expect(args?.[WORKDIR_MODE_ARG]).toBe('project');
    expect(args?.[WORKDIR_PATH_ARG]).toBe(projectDir);
  });

  it('a worker a project SESSION spawns starts in that project folder too', async () => {
    const args = await runSpawn(WORKER, PROJECT, {}, 'work_session');
    expect(args?.[PROJECT_ARG]).toBe(PROJECT);
    expect(args?.[WORKDIR_PATH_ARG]).toBe(projectDir);
  });

  it('a scratch chat\'s worker stays scratch', async () => {
    const args = await runSpawn(CHAT_RUNTIME, null);
    expect(args?.[PROJECT_ARG]).toBeNull();
    expect(args?.[WORKDIR_MODE_ARG]).toBe('scratch');
  });

  it('an explicit projectId: null still asks for scratch', async () => {
    const args = await runSpawn(CHAT_RUNTIME, PROJECT, { projectId: null });
    expect(args?.[PROJECT_ARG]).toBeNull();
  });

  it('a person\'s spawn is not rewritten', async () => {
    const args = await runSpawn(PERSON, PROJECT, { parentSessionId: CHAT });
    expect(args?.[PROJECT_ARG]).toBeNull();
  });
});
