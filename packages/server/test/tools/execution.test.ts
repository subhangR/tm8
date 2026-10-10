import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PtyHostService, ToolSessionLauncher, confineToolPath, resolveToolInputs, redactToolOutput,
  type ToolExit,
} from '@tm8/execution';
import { ToolDefinitionSchema, ToolRunInputSchema, ToolSecretBindInputSchema, OPERATIONS, getOperation, type ToolView } from '@tm8/contract';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerToolHandlers } from '../../src/tools/handlers.js';
import { toolTokenScope } from '../../src/tools/runtime.js';
import type { RequestContext } from '../../src/http/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';

const dirs: string[] = [], hosts: PtyHostService[] = [];
const sessions: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) for (const id of sessions) host.kill(id);
  sessions.length = 0;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'tm8-tool-test-')); dirs.push(dir); return dir; }
function tool(overrides: Partial<ToolView['definition']> = {}): ToolView {
  const definition = ToolDefinitionSchema.parse({ name: 'demo-tool', description: '', help: '', source: 'exit 0',
    runtime: 'bash', inputs: [], tm8Access: 'none', timeoutSeconds: 10, ...overrides });
  return { id: randomUUID(), spaceId: randomUUID(), version: 3, executionVersion: 1, configRevision: 0, sourceSha256: 'a'.repeat(64), definition, config: {}, secretBindings: [] };
}
describe('tool input resolution and boundaries', () => {
  it('uses argument > config > default, preserving false, zero, and JSON values', async () => {
    const cwd = await directory();
    const view = tool({ inputs: [
      { name: 'count', type: 'int', default: 3, min: 0 }, { name: 'flag', type: 'bool', default: true },
      { name: 'data', type: 'json', default: { a: 1 } }, { name: 'state', type: 'enum', options: ['open', 'closed'], default: 'open' },
    ] });
    view.config = { count: 7, flag: true };
    const resolved = await resolveToolInputs(view, { count: 0, flag: false, data: [1, 'x'] }, {}, { cwd, roots: [], readSecret: vi.fn() });
    expect(resolved.values).toEqual({ count: 0, flag: false, data: [1, 'x'], state: 'open' });
    expect(resolved.env).toMatchObject({ COUNT: '0', FLAG: 'false', DATA: '[1,"x"]' });
    expect((await resolveToolInputs(view, {}, {}, { cwd, roots: [], readSecret: vi.fn() })).values.count).toBe(7);
  });
  it('reports all missing inputs and refuses unknown values, literals, and out-of-range numbers', async () => {
    const cwd = await directory();
    const view = tool({ inputs: [{ name: 'repo', type: 'string', required: true }, { name: 'key', type: 'secret', required: true }] });
    const options = { cwd, roots: [], readSecret: vi.fn() };
    await expect(resolveToolInputs(view, {}, {}, options)).rejects.toThrow('repo, key');
    await expect(resolveToolInputs(view, { key: 'literal' }, {}, options)).rejects.toThrow('Literal secret refused');
    await expect(resolveToolInputs(view, { unknown: 1 }, {}, options)).rejects.toThrow('Undeclared');
    await expect(resolveToolInputs(tool({ inputs: [{ name: 'n', type: 'int', min: 1, max: 2 }] }), { n: 3 }, {}, options)).rejects.toThrow('Invalid tool input');
    expect(ToolRunInputSchema.safeParse({ toolId: view.id, clientMutationId: 'x', source: 'evil' }).success).toBe(false);
  });
  it('uses the credential opener only for bound secrets and stores references, never values', async () => {
    const cwd = await directory(), credentialId = randomUUID();
    const view = tool({ inputs: [{ name: 'key', type: 'secret', required: true }] });
    view.secretBindings = [{ inputName: 'key', credentialId, keyHint: '••••' }];
    const readSecret = vi.fn(async () => 'bound-secret');
    const bound = await resolveToolInputs(view, {}, {}, { cwd, roots: [], readSecret });
    expect(readSecret).toHaveBeenCalledWith('key', credentialId);
    expect(bound.values).toEqual({ key: { secret: credentialId } });
    const passed = await resolveToolInputs(view, {}, { key: 'passed-secret' }, { cwd, roots: [], readSecret });
    expect(passed.values).toEqual({ key: { secret: 'passed' } });
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(passed.values)).not.toContain('passed-secret');
  });
  it('canonicalizes cwd and path inputs before checking grants, refusing symlink escapes', async () => {
    const inside = await directory(), outside = await directory();
    await symlink(outside, join(inside, 'escape'));
    await expect(confineToolPath(join(inside, 'escape'), inside, [inside])).rejects.toThrow('outside');
    expect(await confineToolPath(inside, inside, [inside])).toBe(inside);
  });
});

async function launch(source: string, keepOpen: boolean, extra: { runtime?: 'bash' | 'python'; timeoutSeconds?: number; secret?: string } = {}) {
  const dir = await directory(), sessionId = randomUUID(); sessions.push(sessionId);
  const host = new PtyHostService({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }); hosts.push(host);
  const view = tool({ source, runtime: extra.runtime ?? 'bash', timeoutSeconds: extra.timeoutSeconds ?? 10,
    inputs: extra.secret ? [{ name: 'key', type: 'secret' }] : [] });
  const inputs = await resolveToolInputs(view, {}, extra.secret ? { key: extra.secret } : {}, { cwd: dir, roots: [], readSecret: vi.fn() });
  const recordExit = vi.fn(async (_exit: ToolExit) => {}), revokeToken = vi.fn(async () => {});
  const launcher = new ToolSessionLauncher({ pty: host, dataDir: dir, baseUrl: 'http://127.0.0.1:4610', pollMs: 20, env: { PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/bash', DATABASE_URL: 'should-not-leak' } });
  await launcher.launch({ sessionId, toolId: view.id, toolVersion: view.version, definition: view.definition,
    inputs, cwd: dir, keepOpen, token: 'tm8s_secret_run_token_12345678901234567890', recordExit, revokeToken });
  return { host, launcher, sessionId, recordExit, revokeToken, dir };
}
describe('tool exit capture on real PTYs', () => {
  it('records nonzero exit + redacted output and ends a CLI PTY', async () => {
    const run = await launch('printf "%s\\n" "$KEY" "$TM8_AGENT_TOKEN"; exit 7', false, { secret: 'ordinary-secret-value' });
    await vi.waitFor(() => expect(run.recordExit).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(run.recordExit.mock.calls[0]![0]).toMatchObject({ exitCode: 7, state: 'exited' });
    const tail = run.recordExit.mock.calls[0]![0].outputTail;
    expect(tail).not.toContain('ordinary-secret-value'); expect(tail).not.toContain('tm8s_secret_run_token');
    expect(tail).toContain('[credential-redacted]'); expect(run.revokeToken).toHaveBeenCalledTimes(1);
    expect(run.host.hasSession(run.sessionId)).toBe(false);
  });
  it('leaves a usable shell after exit with secrets, token and agent-context marker absent', async () => {
    const run = await launch('printf "done\\n"', true, { secret: 'shell-secret' });
    await vi.waitFor(() => expect(run.recordExit).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(run.host.hasSession(run.sessionId)).toBe(true);
    run.host.write(run.sessionId, 'printf "CLEAN:%s:%s:%s:%s:%s\\n" "${KEY-unset}" "${TM8_AGENT_TOKEN-unset}" "${TM8_SESSION_ID-unset}" "$TM8_CREDENTIALS_MODE" "${DATABASE_URL-unset}"\r');
    await vi.waitFor(() => expect(run.host.getReplay(run.sessionId, -1)?.data.toString()).toContain('CLEAN:unset:unset:unset:off:unset'), { timeout: 15000 });
    expect(run.recordExit).toHaveBeenCalledTimes(1);
    const wrapper = await readFile(join(run.dir, 'tool-runs', run.sessionId, 'run'), 'utf8');
    expect(wrapper).toContain('timeout --foreground -k 10'); expect(wrapper).not.toContain('shell-secret');
  });
  it('records killed when the PTY disappears before a status file is written', async () => {
    const run = await launch('/bin/sleep 30', false, { secret: 'secret-on-kill' });
    run.host.kill(run.sessionId);
    await run.launcher.checkExit(run.sessionId);
    await vi.waitFor(() => expect(run.recordExit).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(run.recordExit.mock.calls[0]![0]).toMatchObject({ state: 'killed', exitCode: null });
    expect(run.revokeToken).toHaveBeenCalledTimes(1);
  });
  it('captures timeout outcome and Python execution', async () => {
    const timeout = await launch('/bin/sleep 30', false, { timeoutSeconds: 1 });
    await vi.waitFor(() => expect(timeout.recordExit).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(timeout.recordExit.mock.calls[0]![0]).toMatchObject({ state: 'timed_out', exitCode: 124 });
    const python = await launch('print("python-output")\nraise SystemExit(4)', false, { runtime: 'python' });
    await vi.waitFor(() => expect(python.recordExit).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(python.recordExit.mock.calls[0]![0]).toMatchObject({ state: 'exited', exitCode: 4 });
  });
  it('redacts before truncation and keeps output within 64 KiB including Unicode', () => {
    const secret = 'secret-across-boundary';
    const output = 'prefix'.repeat(12000) + secret + '界'.repeat(22000);
    const tail = redactToolOutput(output, [secret]);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(65536);
    expect(tail).not.toContain(secret); expect(tail).not.toContain('\ufffd');
    expect(redactToolOutput('ghp_abcdefghijklmnopqrstuvwxyz1234', [])).toBe('[credential-redacted]');
  });
});

describe('tool authorization', () => {
  function ctx(name: RequestContext['opName'], authKind: 'agent' | 'cli' = 'agent', apiScope?: 'read' | 'write'): RequestContext {
    return { opName: name, op: getOperation(name), params: {}, query: new URLSearchParams(), body: {}, requestId: 'test',
      identity: { kind: 'bearer', authKind, ...(apiScope ? { apiScope } : {}) }, headers: {}, method: 'POST', path: '/' };
  }
  it('enforces read scope once for all commands and admits reads', async () => {
    const registry = new HandlerRegistry(), command = vi.fn(() => 'changed'), read = vi.fn(() => 'view');
    registry.register('tools.run', command); registry.register('tools.get', read);
    expect(() => registry.get('tools.run')!(ctx('tools.run', 'agent', 'read'))).toThrow('read operations only');
    expect(command).not.toHaveBeenCalled(); expect(registry.get('tools.get')!(ctx('tools.get', 'agent', 'read'))).toBe('view');
    expect(registry.get('tools.run')!(ctx('tools.run', 'agent', 'write'))).toBe('changed');
    expect(toolTokenScope('write', 'read')).toBe('read'); expect(toolTokenScope('read', 'write')).toBe('read');
  });
  it('registers every tools operation and refuses agent secret binding before any DB call', async () => {
    const registry = new HandlerRegistry(), owner = vi.fn();
    registerToolHandlers(registry, { owner } as unknown as FacadeDeps);
    for (const name of ['tools.create', 'tools.update', 'tools.get', 'tools.list', 'tools.help', 'tools.config.set', 'tools.config.unset', 'tools.secrets.bind', 'tools.secrets.unbind', 'tools.run', 'tools.runs.list', 'tools.runs.get']) expect(registry.has(name as RequestContext['opName'])).toBe(true);
    await expect(registry.get('tools.secrets.bind')!(ctx('tools.secrets.bind'))).rejects.toThrow('human sessions only');
    await expect(registry.get('tools.secrets.unbind')!(ctx('tools.secrets.unbind'))).rejects.toThrow('human sessions only');
    expect(owner).not.toHaveBeenCalled();
    expect(OPERATIONS.some(op => JSON.stringify(op).includes('record_tool_exit'))).toBe(false);
    expect(getOperation('tools.secrets.bind').humanOnly).toBe(true); expect(getOperation('tools.secrets.unbind').humanOnly).toBe(true);
    const base = { toolId: randomUUID(), expectedVersion: 1, inputName: 'key', clientMutationId: 'one' };
    expect(ToolSecretBindInputSchema.safeParse({ ...base, value: 'prompt-secret' }).success).toBe(true);
    expect(ToolSecretBindInputSchema.safeParse({ ...base, value: 'prompt-secret', credentialId: randomUUID() }).success).toBe(false);
  });
});
