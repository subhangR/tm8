/**
 * The `execution.spawn` HANDLER's share of exact selection (design 01a0cb80
 * §5.2, §6), with a recording fake Db — the same harness shape as
 * spawn-chat-parent.test.ts:
 *   · a bad `selection` id refuses with `invalid_input` naming it BEFORE any
 *     write — no derived task, no work_session;
 *   · `jevRunId` links the run to the new session AFTER the spawn succeeds;
 *   · a link that cannot be made is logged, never a failed launch.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollabError, type OperationName } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { RequestContext } from '../src/http/types.js';

vi.mock('../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn(async () => ({ scannedAt: null })) }));

const SPACE = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const MEMORY = '55555555-5555-4555-8555-555555555555';
const SKILL = '66666666-6666-4666-8666-666666666666';
const NOT_A_MEMORY = '77777777-7777-4777-8777-777777777777';
const RUN = '88888888-8888-4888-8888-888888888888';

class SpawnDb implements Db {
  readonly rpcCalls: string[] = [];
  readonly writes: Array<{ sql: string; args: readonly unknown[] }> = [];
  /** Order of events, so "after the spawn" is checkable. */
  readonly timeline: string[] = [];
  linkFails = false;

  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async <R>(sql: string, args: readonly unknown[] = []): Promise<R[]> => {
        if (sql.includes('from public.team_members')) {
          return [{
            entity_id: TEAMMATE, name: 'Draco', role: 'PTY', identity: 'persona', memories: [], model: 'opus',
            agent_tool: 'claude-code', mode: 'worker', permission_mode: null, avatar: null, capabilities: {}, command_permissions: {},
          }] as R[];
        }
        if (sql.includes('select e.id, e.kind from public.entities e')) {
          const kinds: Record<string, string> = { [MEMORY]: 'memory', [SKILL]: 'skill', [NOT_A_MEMORY]: 'task' };
          return (args[0] as string[]).flatMap((id) => (kinds[id] ? [{ id, kind: kinds[id] }] : [])) as R[];
        }
        if (sql.includes('from public.memories m')) {
          return [{ entity_id: MEMORY, statement: 'selected', version: 1, remembered: false, task_remembered: false, superseded: false, disputed: false, verified: false, created_at: new Date() }] as R[];
        }
        if (sql.includes('update public.jev_runs')) {
          this.timeline.push('link');
          this.writes.push({ sql, args });
          if (this.linkFails) throw new Error('permission denied for table jev_runs');
          return [{ id: args[0] }] as R[];
        }
        return [];
      },
      rpc: async <T2>(fn: string, rpcArgs: readonly unknown[] = []): Promise<T2> => this.rpc<T2>(claims, fn, rpcArgs),
    };
    return run(q);
  }

  async rpc<T>(_claims: DbClaims, fn: string): Promise<T> {
    this.rpcCalls.push(fn);
    this.timeline.push(fn);
    if (fn === 'public.execution_spawn') return { entity: { id: SESSION }, patches: [], __tm8_replayed: false } as T;
    if (fn === 'public.derive_task_for_entity') return { taskId: 'task' } as T;
    if (fn === 'internal.w2_resolve_interaction_profile_for_launch') {
      return { profileId: null, profileVersion: null, templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'h', source: 'core_default', snapshot: { profile: { source: 'core_default' } } } as T;
    }
    // 256 (W7p): the spawn port re-resolves the minted token to read its
    // via_link stamp. The real mint always resolves; no link here.
    if (fn === 'resolve_auth_session') return { sessionId: 'auth', viaLinkId: null } as T;
    if (fn === 'public.issue_work_session_agent_session') return { id: 'auth' } as T;
    if (fn === 'internal.w2_record_interaction_profile_pin') {
      return { workSessionId: SESSION, pinRevision: 1, profileId: null, profileVersion: null, templateKey: 'tm8.chat.core', templateVersion: 1, resolvedHash: 'h', source: 'core_default', createdAt: '2026-09-23T00:00:00.000Z' } as T;
    }
    if (fn === 'read_account_git_credential') return null as T;
    // As 206's read_space_credential_for_spawn answers a space with no default:
    // P0002, which the Db maps to a CollabError carrying the reason.
    if (fn === 'read_space_credential_for_spawn') {
      throw new CollabError('not_found', 'this space has no default credential', { details: { reason: 'no_default' } });
    }
    return {} as T;
  }

  async query<R>(): Promise<R[]> { return []; }
  async end(): Promise<void> {}
}

describe('execution.spawn — selection and jevRunId', () => {
  let dataDir: string | undefined;
  let binDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of [dataDir, binDir]) if (dir) await rm(dir, { recursive: true, force: true });
    dataDir = binDir = undefined;
  });

  async function spawn(body: Record<string, unknown>, db = new SpawnDb()) {
    binDir = await mkdtemp(join(tmpdir(), 'tm8-sel-bin-'));
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-sel-data-'));
    const registry = new HandlerRegistry();
    registerExecutionHandlers(registry, {
      db,
      pty: {
        beginPromptHandoff: vi.fn(), spawnIfAbsent: vi.fn(() => ({ reused: false })),
        waitForBootSettlement: vi.fn(async () => null), liveSessionIds: () => [],
      } as never,
      dataDir,
      config: { host: '127.0.0.1', port: 4616 } as never,
      owner: async () => ({ identityId: 'owner', accountId: 'a', username: 'o', isNodeAdmin: true, isOwner: true }),
    });
    const ctx = {
      op: {} as never, opName: 'execution.spawn' as OperationName, params: {}, query: new URLSearchParams(),
      body: { spaceId: SPACE, teamMemberId: TEAMMATE, model: 'opus', agentTool: 'claude-code', accessMode: 'acceptEdits', ...body },
      requestId: 'req', identity: { kind: 'loopback' }, headers: {}, method: 'POST', path: '/v2/execution/spawn',
    } as unknown as RequestContext;
    let error: unknown;
    try {
      await registry.get('execution.spawn' as OperationName)!(ctx);
    } catch (caught) {
      // The fake cannot re-read the new work_session for the response; the
      // spawn has happened by then, so only an earlier refusal is interesting.
      if (!(caught instanceof Error) || !/no such entity/.test(caught.message)) error = caught;
    }
    return { db, error };
  }

  it('refuses a bad selection id by name before any write — no derived task, no session', async () => {
    const { db, error } = await spawn({
      taskIds: ['99999999-9999-4999-8999-999999999999'],
      selection: { memoryIds: [MEMORY, NOT_A_MEMORY], skillIds: [SKILL] },
    });
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(String((error as Error).message)).toContain(NOT_A_MEMORY);
    expect(String((error as Error).message)).not.toContain(MEMORY);
    expect(db.rpcCalls).not.toContain('public.derive_task_for_entity');
    expect(db.rpcCalls).not.toContain('public.execution_spawn');
  });

  it('refuses a referenceIds entry that is not a reference kind, by name, before any write', async () => {
    const { db, error } = await spawn({
      taskIds: ['99999999-9999-4999-8999-999999999999'],
      selection: { referenceIds: [NOT_A_MEMORY, MEMORY] },
    });
    expect(error).toMatchObject({ code: 'invalid_input' });
    // The task is a reference kind; the memory is not.
    expect(String((error as Error).message)).toContain(`referenceIds ${MEMORY}`);
    expect(String((error as Error).message)).not.toContain(NOT_A_MEMORY);
    expect(db.rpcCalls).not.toContain('public.derive_task_for_entity');
    expect(db.rpcCalls).not.toContain('public.execution_spawn');
  });

  it('links the Ask Jev run to the new session after the spawn succeeds', async () => {
    const { db, error } = await spawn({ selection: { memoryIds: [MEMORY], skillIds: [SKILL] }, jevRunId: RUN });
    expect(error).toBeUndefined();
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.args).toEqual([RUN, SESSION, SPACE]);
    expect(db.timeline.indexOf('public.execution_spawn')).toBeGreaterThanOrEqual(0);
    expect(db.timeline.indexOf('link')).toBeGreaterThan(db.timeline.indexOf('public.execution_spawn'));
  });

  it('a run that cannot be linked is logged — the launch still succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new SpawnDb();
    db.linkFails = true;
    const { error } = await spawn({ jevRunId: RUN }, db);
    expect(error).toBeUndefined();
    expect(db.rpcCalls).toContain('public.execution_spawn');
    expect(warn.mock.calls.some(([line]) => String(line).includes(`run ${RUN} not linked`))).toBe(true);
  });

  it('no jevRunId, no link attempted', async () => {
    const { db, error } = await spawn({});
    expect(error).toBeUndefined();
    expect(db.writes).toHaveLength(0);
  });
});
