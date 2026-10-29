/**
 * ToolRuntime.runScheduled against a real PTY and a recording database fake
 * (docs/features/tools/SCHEDULED-RUNS.md). The SQL side of the seam is proved in
 * scheduled-runs.pg.test.ts; here each case is the server half of one contract
 * rule, asserted on exactly what reaches the database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollabError, ToolDefinitionSchema, type ToolView } from '@tm8/contract';
import { PtyHostService, toolWrapper, type SpawnService } from '@tm8/execution';
import type { Db, DbClaims } from '../../src/db/types.js';

const current = vi.hoisted(() => ({ tool: undefined as unknown, loads: 0 }));
vi.mock('../../src/tools/views.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/tools/views.js')>(),
  loadTool: vi.fn(async () => { current.loads += 1; return current.tool; }),
}));
const { ToolRuntime, scheduledInputProblems } = await import('../../src/tools/runtime.js');

vi.setConfig({ testTimeout: 20000 });
const dirs: string[] = [], hosts: Array<{ host: PtyHostService; ids: string[] }> = [];
afterEach(async () => {
  for (const { host, ids } of hosts.splice(0)) for (const id of ids) host.kill(id);
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
  current.loads = 0;
});

function toolView(overrides: Partial<ToolView['definition']> = {}, view: Partial<ToolView> = {}): ToolView {
  const definition = ToolDefinitionSchema.parse({ name: 'nightly-probe', description: '', help: '', runtime: 'bash',
    source: 'exit 0', inputs: [], tm8Access: 'none', timeoutSeconds: 10, ...overrides });
  return { id: randomUUID(), spaceId: randomUUID(), version: 3, executionVersion: 2, configRevision: 0,
    sourceSha256: 'b'.repeat(64), definition, config: {}, secretBindings: [], ...view };
}
/** The exact shape `createLoopExecutorPort.claimsForLoop` returns (375). */
const firing: DbClaims = { identityId: 'loop-armer', nodeAdmin: false, requestId: 'loop-executor:fixture' };
const loopId = randomUUID(), persona = randomUUID();
const request = (overrides: Record<string, unknown> = {}) => ({
  toolId: (current.tool as ToolView).id, inputs: {}, firingKey: `${loopId}:2026-10-28T19:00:00.000Z`,
  triggeredByLoopId: loopId, runAsTeamMemberId: persona, title: 'Nightly check', ...overrides,
});

interface Call { fn: string; args: readonly unknown[]; claims: DbClaims }
async function harness(tool: ToolView, rpc: Record<string, (args: readonly unknown[]) => unknown> = {}) {
  current.tool = tool;
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-scheduled-')); dirs.push(dataDir);
  const sessionId = randomUUID();
  const host = new PtyHostService({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  hosts.push({ host, ids: [sessionId] });
  const calls: Call[] = [];
  const handlers: Record<string, (args: readonly unknown[]) => unknown> = {
    my_path_grants: () => [],
    start_tool_session: () => ({ entity: { id: sessionId }, __tm8_replayed: false }),
    issue_tool_session_loop_session: () => ({ id: randomUUID() }),
    work_session_transition: () => ({}), record_tool_exit: () => ({}), revoke_agent_auth_session: () => null,
    ...rpc,
  };
  const db = {
    tx: async (_claims: DbClaims, fn: (q: unknown) => unknown) => fn({}),
    rpc: async (claims: DbClaims, fn: string, args: readonly unknown[] = []) => {
      calls.push({ fn, args, claims });
      const handler = handlers[fn];
      if (!handler) throw new Error(`unexpected rpc ${fn}`);
      return handler(args);
    },
    query: async (claims: DbClaims, _sql: string, args: readonly unknown[] = []) => {
      calls.push({ fn: 'query', args, claims });
      return [{ tool_version: tool.version, tool_source_sha256: tool.sourceSha256, tool_keep_open: false }];
    },
  } as unknown as Db;
  const spawnService = {
    adoptToolSession: vi.fn(),
    terminate: vi.fn(async (_claims: DbClaims, id: string) => { host.kill(id); return { outcome: 'killed', commandResult: {} }; }),
  };
  const runtime = new ToolRuntime({ db, pty: host, spawnService: spawnService as unknown as SpawnService, dataDir,
    baseUrl: 'http://127.0.0.1:4610', nodeId: 'scheduled-unit' });
  const scratch = join(dataDir, 'tool-workspaces', firing.identityId!, tool.id);
  const of = (fn: string) => calls.filter(call => call.fn === fn);
  return { runtime, calls, of, sessionId, host, spawnService, scratch };
}

describe('runScheduled on a real PTY', () => {
  it('fires once: pinned version, keep-open off, tool-fire cmid, loop id, scratch cwd, loop mint, recorded exit', async () => {
    const tool = toolView({ tm8Access: 'read', inputs: [{ name: 'target', type: 'string', required: true }],
      source: 'printf "pwd:%s token:%s target:%s\\n" "$PWD" "${TM8_AGENT_TOKEN:+set}" "$TARGET"; exit 3' });
    const h = await harness(tool);
    const result = await h.runtime.runScheduled(firing, request({ inputs: { target: 'db-1' } }));
    expect(result).toEqual({ sessionId: h.sessionId, toolVersion: 3, sourceSha256: tool.sourceSha256 });
    const cwd = await realpath(h.scratch);
    // p_tool_version = tool.version (never null), p_keep_open false, no override cwd, tool-fire:<firingKey>, the loop id last.
    expect(h.of('start_tool_session')[0]!.args).toEqual([tool.spaceId, tool.id, 3, '{"target":"db-1"}', false,
      'scheduled-unit', cwd, 8, null, `tool-fire:${loopId}:2026-10-28T19:00:00.000Z`, loopId]);
    const [mint] = h.of('issue_tool_session_loop_session');
    expect(mint!.args).toEqual([h.sessionId, loopId, persona, expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(String), 'read']);
    await vi.waitFor(() => expect(h.of('record_tool_exit')).toHaveLength(1), { timeout: 15000 });
    const [, exitCode, state, tail] = h.of('record_tool_exit')[0]!.args as [string, number, string, string];
    expect([exitCode, state]).toEqual([3, 'exited']);
    expect(tail).toContain('── nightly-probe v3 · loop: Nightly check · inputs: target ──');
    expect(tail).toContain(`── cwd: ${cwd} ──`);
    expect(tail).toContain(`pwd:${cwd} token:set target:db-1`);
    expect(h.of('revoke_agent_auth_session')).toHaveLength(1);
    expect(h.host.hasSession(h.sessionId)).toBe(false); // keep-open off: the PTY closes with the tool
    // Every write runs under the firing's own claims, never a substitute.
    expect(h.calls.every(call => call.claims === firing)).toBe(true);
  });

  it('a retry of one firing is a replay: no mint, no launch, the original run returned', async () => {
    const tool = toolView({ tm8Access: 'write' });
    const h = await harness(tool, { start_tool_session: () => ({ entity: { id: 'original-run' }, __tm8_replayed: true }) });
    expect((await h.runtime.runScheduled(firing, request())).sessionId).toBe('original-run');
    expect(h.calls.map(call => call.fn)).toEqual(['my_path_grants', 'start_tool_session', 'query']);
    expect(h.host.hasSession('original-run')).toBe(false);
  });

  it('refuses tm8 API access without a runs-as persona BEFORE any row (invalid_input)', async () => {
    const h = await harness(toolView({ tm8Access: 'read' }));
    const refused = h.runtime.runScheduled(firing, request({ runAsTeamMemberId: undefined }));
    await expect(refused).rejects.toMatchObject({ code: 'invalid_input', message: 'tool nightly-probe needs a runs-as persona for tm8 API access' });
    expect(h.calls).toEqual([]);
  });

  it('tm8Access none mints nothing and passes no token', async () => {
    const h = await harness(toolView({ source: 'printf "token:%s\\n" "${TM8_AGENT_TOKEN-unset}"' }));
    await h.runtime.runScheduled(firing, request({ runAsTeamMemberId: undefined }));
    await vi.waitFor(() => expect(h.of('record_tool_exit')).toHaveLength(1), { timeout: 15000 });
    expect(h.of('issue_tool_session_loop_session')).toEqual([]);
    expect(h.of('record_tool_exit')[0]!.args[3]).toContain('token:unset');
  });

  it('a refused mint kills and records the run, then surfaces the mint\'s own refusal', async () => {
    const h = await harness(toolView({ tm8Access: 'write' }), {
      issue_tool_session_loop_session: () => { throw new CollabError('forbidden', 'loop tool bearer acts only as the loop\'s runs-as persona'); },
    });
    await expect(h.runtime.runScheduled(firing, request())).rejects.toMatchObject({ code: 'forbidden', message: 'loop tool bearer acts only as the loop\'s runs-as persona' });
    expect(h.spawnService.terminate).toHaveBeenCalledWith(firing, h.sessionId, expect.objectContaining({ terminalStatus: 'failed' }));
    expect(h.of('revoke_agent_auth_session')).toHaveLength(1);
    expect(h.of('record_tool_exit')[0]!.args).toEqual([h.sessionId, null, 'killed', '']);
    expect(h.of('work_session_transition')).toEqual([]);
  });

  it('a launch failure kills and records the run, revokes its token and reports Tool launch failed', async () => {
    const h = await harness(toolView({ tm8Access: 'read' }));
    vi.spyOn(h.host, 'spawnIfAbsent').mockImplementationOnce(() => { throw new Error('Synthetic PTY launch failure'); });
    await expect(h.runtime.runScheduled(firing, request())).rejects.toMatchObject({ code: 'upstream_unavailable', message: 'Tool launch failed' });
    expect(h.of('issue_tool_session_loop_session')).toHaveLength(1);
    expect(h.of('revoke_agent_auth_session')).toHaveLength(1);
    expect(h.of('record_tool_exit')[0]!.args).toEqual([h.sessionId, null, 'killed', '']);
  });
});

describe('runScheduled refusals before any read or row', () => {
  it.each([
    ['a browser bearer', { authKind: 'browser' }], ['a CLI bearer', { authKind: 'cli' }], ['an agent bearer', { authKind: 'agent' }],
    ['an auth session', { authSessionId: randomUUID() }], ['a space link', { viaLinkId: randomUUID() }],
    ['a work session', { workSessionId: randomUUID() }], ['a space pin', { sessionSpaceId: randomUUID() }],
    ['an acting-as actor', { actorId: randomUUID() }], ['the due-read job claim', { backgroundJob: 'loops.execute-due' }],
    ['node admin', { nodeAdmin: true }], ['no identity', { identityId: undefined }],
  ] as const)('refuses claims carrying %s', async (_label, extra) => {
    const h = await harness(toolView());
    await expect(h.runtime.runScheduled({ ...firing, ...extra } as DbClaims, request())).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.calls).toEqual([]); expect(current.loads).toBe(0);
  });

  it('names every stale, renamed, secret or newly required input in one invalid_input', async () => {
    const tool = toolView({ inputs: [
      { name: 'repo', type: 'string', required: true }, { name: 'limit', type: 'int', min: 1, max: 10 },
      { name: 'token', type: 'secret', required: true }, { name: 'mode', type: 'enum', options: ['a', 'b'], required: true, default: 'a' },
      { name: 'region', type: 'string', required: true },
    ] }, { config: { region: 'eu' } });
    const problems = scheduledInputProblems(tool, { repository: 'x/y', limit: 50, token: 'literal' } as never);
    expect(problems).toEqual(['repository (not declared)', 'limit (invalid int)',
      'token (secret values are never stored; bind the secret to the tool)', 'repo (required)']);
    expect(scheduledInputProblems({ ...tool, definition: { ...tool.definition, inputs: tool.definition.inputs.filter(input => input.name === 'token') } }, {}))
      .toEqual(['token (required secret is not bound)']);
    const h = await harness(tool);
    await expect(h.runtime.runScheduled(firing, request({ inputs: { repository: 'x/y', limit: 50 } }))).rejects.toMatchObject({
      code: 'invalid_input', message: expect.stringMatching(/repository \(not declared\); limit \(invalid int\); repo \(required\); token \(required secret is not bound\)$/),
    });
    expect(h.of('start_tool_session')).toEqual([]);
  });
});

describe('the run header', () => {
  const definition = toolView({ inputs: [{ name: 'key', type: 'secret' }] }).definition;
  it('prints the cwd on every run and the origin of a scheduled one', () => {
    const plain = toolWrapper({ definition, toolVersion: 4, cwd: '/srv/work dir', keepOpen: false }, '/run', '/bin/bash', []);
    expect(plain).toContain(`printf '%s\\n' '── nightly-probe v4 · inputs: key=[masked] ──' '── cwd: /srv/work dir ──'`);
    const scheduled = toolWrapper({ definition, toolVersion: 4, cwd: '/x', keepOpen: false, origin: 'loop: it\'s\nnightly\u001b[31m' }, '/run', '/bin/bash', []);
    // Free-text loop titles are quoted and lose their control characters.
    expect(scheduled).toContain(`'── nightly-probe v4 · loop: it'\\''s nightly [31m · inputs: key=[masked] ──'`);
  });
});
