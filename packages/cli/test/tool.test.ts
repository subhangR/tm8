import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_WS_PROTOCOL, PTY_GRANT_PROTOCOL_PREFIX, type ToolDefinition, type ToolRun, type ToolView } from '@tm8/contract';
import { parseInvocation } from '../src/args.js';
import { run } from '../src/run.js';
import { parseToolArgs, renderToolHelp, type ToolHelp } from '../src/commands/tool-args.js';
import { toolRunExitCode } from '../src/commands/tool-terminal.js';
import * as secretReader from '../src/commands/tool-secret.js';
import { nounHelp } from '../src/discovery/help.js';

const TOOL = '11111111-1111-7111-8111-111111111111';
const SESSION = '22222222-2222-7222-8222-222222222222';
const SPACE = '33333333-3333-7333-8333-333333333333';
const CREDENTIAL = '44444444-4444-7444-8444-444444444444';
const definition: ToolDefinition = {
  name: 'demo', description: 'Demo tool', help: 'Examples: tm8 tool run demo --repo owner/repo', runtime: 'bash',
  source: 'echo hello', tm8Access: 'none', timeoutSeconds: 900,
  inputs: [
    { name: 'repo', type: 'string', short: 'r', description: 'Repository' },
    { name: 'limit', type: 'int', short: 'l', min: 1, max: 100, default: 20 },
    { name: 'ratio', type: 'number', default: 0.5 }, { name: 'draft', type: 'bool', short: 'd' },
    { name: 'state', type: 'enum', options: ['open', 'closed'], default: 'open' },
    { name: 'payload', type: 'json' }, { name: 'location', type: 'path' },
    { name: 'format', type: 'string' }, { name: 'timeout', type: 'int' }, { name: 'space', type: 'string' },
    { name: 'auth', type: 'secret', short: 'a' },
  ],
};
let tool: ToolView;
const help = (): ToolHelp => ({ toolId: tool.id, version: tool.version, ...tool.definition,
  inputs: tool.definition.inputs.map(input => ({ ...input, configured: input.type === 'secret'
    ? tool.secretBindings.some(binding => binding.inputName === input.name) : Object.hasOwn(tool.config, input.name) })) });
let server: Server, baseUrl: string;
let requests: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, any> }> = [];
let stdout = '', stderr = '', fast = false, completed = false, exitCode = 37, keepOpen = false, conflict = false, helpVersionMismatch = false;
let namePage = 0;
let noReplay = false, statusDelay = 0;
const storedRun = (): ToolRun => ({ id: SESSION, spaceId: SPACE, toolId: TOOL, toolVersion: tool.version,
  sourceSha256: tool.sourceSha256, inputs: {}, state: completed ? 'exited' : 'running', keepOpen,
  exitCode: completed ? exitCode : null, startedAt: null, exitedAt: null, outputTail: 'stored output\n', parentSessionId: null });

class TerminalSocket extends EventTarget {
  static instances: TerminalSocket[] = [];
  binaryType = ''; readyState = 0; protocol = ''; sends: unknown[] = []; closed = false;
  constructor(public url: string, public protocols: string[]) {
    super(); this.protocol = protocols[0]!; TerminalSocket.instances.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1; this.dispatchEvent(new Event('open'));
      if (!noReplay) this.dispatchEvent(new MessageEvent('message', { data: new TextEncoder().encode('live output\n').buffer }));
      if (statusDelay) setTimeout(() => { completed = true; }, statusDelay);
      else completed = true;
      if (!keepOpen) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'exit', exitCode: 0 }) }));
        // A PTY's exit frame can differ from the recorded tool's status.
        this.close();
      }
    }, 10);
  }
  send(data: unknown): void { this.sends.push(data); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close'));
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> : {};
      requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
      let data: unknown = tool;
      if (url.pathname.endsWith('/tools')) {
        // Name lookup must paginate and match exactly rather than pick a substring.
        if (url.searchParams.has('words') && namePage++ === 0) data = { items: [{ ...tool, definition: { ...tool.definition, name: 'demo-other' } }], nextCursor: 'next' };
        else data = { items: [tool], nextCursor: null };
        if (req.method === 'POST') data = tool;
      } else if (url.pathname.endsWith('/help')) data = { ...help(), ...(helpVersionMismatch ? { version: tool.version + 1 } : {}) };
      else if (url.pathname.endsWith('/run')) {
        if (conflict) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'version_conflict', message: 'Tool changed', retryable: false, requestId: 'test' } })); return;
        }
        keepOpen = body.keepOpen; completed = fast;
        data = { sessionId: SESSION, toolId: TOOL, toolVersion: tool.version, sourceSha256: tool.sourceSha256, keepOpen, reused: false };
      } else if (url.pathname.endsWith('/streams-attach')) data = {
        workSessionId: SESSION, mode: 'drive', token: 'grant-bearer', expiresAt: new Date(Date.now() + 60000).toISOString(), url: `/terminal?sessionId=${SESSION}`,
      };
      else if (url.pathname.endsWith('/runs')) data = { items: [storedRun()], nextCursor: null };
      else if (url.pathname.includes('/tool-runs/')) data = storedRun();
      else if (url.pathname.endsWith('/secrets/bind')) data = { inputName: 'auth', keyHint: '••••' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data, requestId: 'test' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  tool = { id: TOOL, spaceId: SPACE, version: 23, sourceSha256: 'a'.repeat(64), definition,
    executionVersion: 1, configRevision: 0, config: {}, secretBindings: [], sourceChangedSinceViewerLastRun: null };
  requests = []; stdout = ''; stderr = ''; fast = false; completed = false; exitCode = 37; keepOpen = false; conflict = false; helpVersionMismatch = false; namePage = 0;
  TerminalSocket.instances = [];
  noReplay = false; statusDelay = 0;
  vi.stubEnv('TM8_BASE_URL', baseUrl); vi.stubEnv('TM8_SPACE_ID', SPACE); vi.stubEnv('TM8_CREDENTIALS_MODE', 'off');
  vi.stubEnv('TM8_SESSION_ID', ''); vi.stubEnv('TM8_AGENT_TOKEN', ''); vi.stubEnv('TM8_TEAM_MEMBER_ID', '');
  vi.stubEnv('TM8_JOURNAL_CLASS', 'human'); vi.stubEnv('TM8_NO_TERSE_DEFAULT', '1');
  vi.stubGlobal('WebSocket', TerminalSocket);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('dynamic arguments', () => {
  it('keeps run/global options before the name and all subsequent tokens opaque', () => {
    const parsed = parseInvocation(['--space', SPACE, 'tool', 'run', '--detach', '--format', 'json', '--timeout', '3', '--cwd', '/tmp', 'demo', '--format', 'yaml', '--timeout', '9', '--space', 'other', '--no-draft', '-l', '5', '--help']);
    expect(parsed.globals).toMatchObject({ space: SPACE, format: 'json', timeoutMs: 3000, help: false });
    expect(parsed.positionals).toEqual(['tool', 'run', 'demo']);
    expect(parsed.passthrough).toEqual(['--format', 'yaml', '--timeout', '9', '--space', 'other', '--no-draft', '-l', '5', '--help']);
    expect(parsed.options.bool('detach')).toBe(true); expect(parsed.options.value('cwd')).toBe('/tmp');
    expect(parseInvocation(['tool', 'run', '--', 'demo', '-d']).passthrough).toEqual(['-d']);
  });
  it('parses declared types, overrides, boolean negation, short flags, and equals syntax', () => {
    const parsed = parseToolArgs(definition.inputs, ['-r', 'owner/repo', '-l', '5', '--ratio=-1.25', '--no-draft', '--state', 'closed', '--payload', '{"x":[1,true]}', '--location', './data', '--format', 'yaml', '--timeout', '99']);
    expect(parsed.inputs).toEqual({ repo: 'owner/repo', limit: 5, ratio: -1.25, draft: false, state: 'closed', payload: { x: [1, true] }, location: './data', format: 'yaml', timeout: 99 });
    expect(parseToolArgs(definition.inputs, ['-d']).inputs.draft).toBe(true);
  });
  it.each([['--state', 'other'], ['-l', '0'], ['-l', '1.1'], ['--ratio', 'NaN'], ['--payload', 'bad'], ['--location', ''], ['--draft=false'], ['-l'], ['-d', '--no-draft'], ['--unknown', 'oops']])('rejects invalid tool arguments %j', (...argv) => {
    expect(() => parseToolArgs(definition.inputs, argv)).toThrow();
  });
  it('requires an input unless configured or defaulted, including false and null defaults', () => {
    expect(() => parseToolArgs([{ name: 'repo', type: 'string', required: true }], [])).toThrow('Missing required inputs: repo');
    expect(() => parseToolArgs([{ name: 'repo', type: 'string', required: true, configured: true }, { name: 'draft', type: 'bool', required: true, default: false }, { name: 'payload', type: 'json', required: true, default: null }], [])).not.toThrow();
  });
  it('prints generated per-tool help after the name, including secret metadata', async () => {
    tool.definition = { ...definition, inputs: [...definition.inputs, { name: 'required', type: 'string', required: true }] };
    expect(await run(['tool', 'run', 'demo', '--help'])).toBe(0);
    expect(stdout).toContain('tm8 tool run'); expect(stdout).toContain('Repository'); expect(stdout).toContain('default: 20');
    expect(stdout).toContain('choices: open|closed'); expect(stdout).toContain('--draft / --no-draft');
    expect(stdout).toContain('--auth-from-env <VAR> (secret, optional)'); expect(stdout).toContain('(string, required)');
    expect(stdout).toContain('Examples:'); expect(requests.some(req => req.method === 'POST')).toBe(false);
    expect(renderToolHelp(help())).not.toContain('undefined');
  });
  it('keeps command help available before the tool name', async () => {
    expect(await run(['tool', 'run', '--help'])).toBe(0);
    expect(stdout).toContain('<name|id>'); expect(requests).toHaveLength(0);
  });
});

describe('catalog commands and version pin', () => {
  it('runs with the just-loaded version, resolves exact names across pages, and shows source changes', async () => {
    tool.sourceChangedSinceViewerLastRun = { byActor: { id: CREDENTIAL, kind: 'team_member', displayName: 'Author', isAgent: true }, at: '2026-10-10T12:00:00Z', fromSha: 'b'.repeat(64), toSha: tool.sourceSha256 };
    expect(await run(['tool', 'run', '--detach', '--cwd', '/tmp', 'demo', '--format', 'yaml', '--timeout', '99', '-l', '5'])).toBe(0);
    const request = requests.find(req => req.path.endsWith('/run'))!;
    expect(request.body).toMatchObject({ expectedVersion: 23, keepOpen: false, cwd: '/tmp', inputs: { format: 'yaml', timeout: 99, limit: 5 } });
    expect(request.body).toHaveProperty('clientMutationId'); expect(stdout).toBe(`${SESSION}\n`);
    expect(stderr).toContain('source changed since your last run by Author at 2026-10-10T12:00:00Z');
    expect(requests.filter(req => req.query.has('words'))).toHaveLength(2);
  });
  it('does not retry a changed version and refuses mismatched help before a run', async () => {
    conflict = true;
    expect(await run(['tool', 'run', '--detach', TOOL])).toBe(6);
    expect(requests.filter(req => req.path.endsWith('/run'))).toHaveLength(1);
    requests = []; helpVersionMismatch = true;
    expect(await run(['tool', 'run', '--detach', TOOL])).toBe(6);
    expect(requests.some(req => req.path.endsWith('/run'))).toBe(false);
  });
  it('creates a definition from source and spec files and edits with an explicit version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-tool-'));
    const source = join(dir, 'source.sh'), spec = join(dir, 'spec.json');
    writeFileSync(source, 'echo new-source\n'); writeFileSync(spec, JSON.stringify({ inputs: definition.inputs, help: 'Custom help', tm8Access: 'read', timeoutSeconds: 15 }));
    expect(await run(['tool', 'create', 'new-tool', '--runtime', 'bash', '--source', `@${source}`, '--spec', `@${spec}`, '--description', 'New tool'])).toBe(0);
    expect(requests.at(-1)!.body.definition).toMatchObject({ name: 'new-tool', runtime: 'bash', source: 'echo new-source\n', help: 'Custom help', tm8Access: 'read', timeoutSeconds: 15 });
    expect(await run(['tool', 'edit', TOOL, '--source', `@${source}`, '--expect-version', '23'])).toBe(0);
    expect(requests.at(-1)!.method).toBe('PATCH'); expect(requests.at(-1)!.body.expectedVersion).toBe(23);
    expect(await run(['tool', 'edit', TOOL, '--source', `@${source}`])).toBe(2);
    expect(await run(['tool', 'create', 'new-tool', '--runtime', 'bash', '--source', 'echo inline'])).toBe(2);
  });
  it('sets typed config, unsets it, and refuses secret config', async () => {
    expect(await run(['tool', 'config', 'set', TOOL, 'limit', '4'])).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ expectedVersion: 23, inputName: 'limit', value: 4 });
    expect(await run(['tool', 'config', 'unset', TOOL, 'limit'])).toBe(0);
    expect(requests.at(-1)!.path).toContain('/config/unset'); expect(requests.at(-1)!.body).not.toHaveProperty('value');
    expect(await run(['tool', 'config', 'set', TOOL, 'auth', 'private-value'])).toBe(2);
    expect(stdout + stderr).not.toContain('private-value');
  });
  it('wires show, source, list, help, runs, and run-show output to their operations', async () => {
    expect(await run(['tool', 'show', TOOL, '--source'])).toBe(0); expect(stdout).toContain('echo hello');
    expect(await run(['tool', 'list', '--words', 'demo', '--limit', '2'])).toBe(0);
    expect(requests.at(-1)!.query.get('limit')).toBe('2');
    expect(await run(['tool', 'help', TOOL])).toBe(0); expect(requests.at(-1)!.path).toContain('/help');
    expect(await run(['tool', 'runs', TOOL, '--limit', '3'])).toBe(0); expect(requests.at(-1)!.path).toContain('/runs');
    expect(await run(['tool', 'run-show', SESSION, '--output'])).toBe(0); expect(stdout).toContain('stored output');
    expect(nounHelp('tool')!.commands).toHaveLength(12);
  });
});

describe('secrets', () => {
  it.each([['--auth', 'private-value'], ['--auth=private-value'], ['-a', 'private-value']])('refuses literal secrets %j without echoing or running', async (...argv) => {
    expect(await run(['tool', 'run', '--detach', TOOL, ...argv])).toBe(2);
    expect(stdout + stderr).not.toContain('private-value'); expect(requests.some(req => req.path.endsWith('/run'))).toBe(false);
  });
  it('reads env references only into the request secret body', async () => {
    vi.stubEnv('TEST_TOOL_AUTH', 'private-value');
    expect(await run(['tool', 'run', '--detach', TOOL, '--auth-from-env', 'TEST_TOOL_AUTH'])).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ secrets: { auth: 'private-value' }, inputs: {} });
    expect(stdout + stderr).not.toContain('private-value');
    expect(() => parseToolArgs(definition.inputs, ['--auth-from-env', 'MISSING'], {})).toThrow('missing, empty');
  });
  it('requires unbound required secrets, while bound credentials need no prompt', async () => {
    tool.definition = { ...definition, inputs: [{ name: 'auth', type: 'secret', required: true }] };
    expect(await run(['tool', 'run', '--detach', TOOL])).toBe(2);
    tool.secretBindings = [{ inputName: 'auth', credentialId: CREDENTIAL, keyHint: '••••' }];
    expect(await run(['tool', 'run', '--detach', TOOL])).toBe(0);
    expect(requests.at(-1)!.body.secrets).toEqual({});
  });
  it('binds stdin/prompt values or credential ids exclusively and unbinds with a version', async () => {
    const reader = vi.spyOn(secretReader, 'readToolSecret').mockResolvedValue('private-value');
    expect(await run(['tool', 'secret', 'set', TOOL, 'auth', '--value-stdin'])).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ expectedVersion: 23, inputName: 'auth', value: 'private-value' });
    expect(stdout + stderr).not.toContain('private-value');
    reader.mockClear();
    expect(await run(['tool', 'secret', 'set', TOOL, 'auth', '--credential-id', CREDENTIAL])).toBe(0);
    expect(requests.at(-1)!.body.credentialId).toBe(CREDENTIAL); expect(reader).not.toHaveBeenCalled();
    expect(await run(['tool', 'secret', 'set', TOOL, 'auth', '--value-stdin', '--credential-id', CREDENTIAL])).toBe(2);
    expect(await run(['tool', 'secret', 'set', TOOL, 'auth', 'private-value'])).toBe(2);
    expect(stdout + stderr).not.toContain('private-value');
    expect(await run(['tool', 'secret', 'unset', TOOL, 'auth'])).toBe(0);
    expect(requests.at(-1)!.path).toContain('/secrets/unbind'); expect(requests.at(-1)!.body.expectedVersion).toBe(23);
  });
  it('refuses agents before reading a secret value', async () => {
    vi.stubEnv('TM8_SESSION_ID', SESSION);
    const reader = vi.spyOn(secretReader, 'readToolSecret');
    expect(await run(['tool', 'secret', 'set', TOOL, 'auth', '--value-stdin'])).toBe(4);
    expect(reader).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
  });
});

describe('attached execution', () => {
  it.each([0, 1, 37, 124, 255])('streams live output and passes through exit code %i', async code => {
    exitCode = code;
    expect(await run(['tool', 'run', TOOL])).toBe(code);
    expect(stdout).toBe(`${SESSION}\nlive output\n`);
    expect(TerminalSocket.instances[0]!.protocols).toEqual([PTY_WS_PROTOCOL, `${PTY_GRANT_PROTOCOL_PREFIX}grant-bearer`]);
    expect(TerminalSocket.instances[0]!.url).not.toContain('grant-bearer');
    expect(requests.find(req => req.path.endsWith('/run'))!.body.keepOpen).toBe(false);
  });
  it('uses stored output when the tool finished before attachment', async () => {
    fast = true; expect(await run(['tool', 'run', '--close', TOOL])).toBe(37);
    expect(stdout).toBe(`${SESSION}\nstored output\n`); expect(TerminalSocket.instances).toHaveLength(0);
  });
  it('recovers the recorded tail if the tool exits between the grant and replay', async () => {
    noReplay = true;
    expect(await run(['tool', 'run', TOOL])).toBe(37);
    expect(stdout).toBe(`${SESSION}\nstored output\n`);
  });
  it('waits for the status watcher after the PTY closes without duplicating live output', async () => {
    statusDelay = 80;
    expect(await run(['tool', 'run', TOOL])).toBe(37);
    expect(stdout).toBe(`${SESSION}\nlive output\n`);
    expect(requests.filter(req => req.path.includes('/tool-runs/')).length).toBeGreaterThan(2);
  });
  it.each([false, true])('forwards stdin, sets raw mode only with TTY stdout (%s), and restores it', async stdoutTty => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const input = Object.assign(new EventEmitter(), {
      isTTY: true, isRaw: false, setRawMode: vi.fn(), isPaused: () => true, pause: vi.fn(),
      resume: () => { input.emit('data', Buffer.from('stdin bytes')); },
    });
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty });
    try {
      expect(await run(['tool', 'run', TOOL])).toBe(37);
      expect(TerminalSocket.instances[0]!.sends).toContainEqual(Buffer.from('stdin bytes'));
      expect(input.setRawMode.mock.calls).toEqual(stdoutTty ? [[true], [false]] : []);
      expect(input.pause).toHaveBeenCalledOnce(); expect(input.listenerCount('data')).toBe(0);
    } finally {
      Object.defineProperty(process, 'stdin', stdinDescriptor);
      if (stdoutTtyDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutTtyDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });
  it('returns the tool status while a keep-open shell remains live', async () => {
    vi.stubEnv('TM8_SESSION_ID', SESSION);
    expect(await run(['tool', 'run', '--keep-open', TOOL])).toBe(37);
    expect(keepOpen).toBe(true); expect(TerminalSocket.instances[0]!.closed).toBe(true);
    expect(requests.some(req => req.path.includes('terminate'))).toBe(false);
    expect(stderr).toContain(`shell left open; close with: tm8 session terminate ${SESSION}`);
  });
  it('detaches with a session id and uses JSON only when detached', async () => {
    expect(await run(['tool', 'run', '--detach', '--format', 'json', TOOL])).toBe(0);
    expect(JSON.parse(stdout).sessionId).toBe(SESSION); expect(TerminalSocket.instances).toHaveLength(0);
    stdout = ''; requests = [];
    expect(await run(['tool', 'run', '--format', 'json', TOOL])).toBe(2);
    expect(requests.some(req => req.method === 'POST')).toBe(false);
    expect(await run(['tool', 'run', '--close', '--keep-open', TOOL])).toBe(2);
  });
  it('propagates a tool exit code through the process entry point', async () => {
    fast = true; exitCode = 37;
    const result = await new Promise<{ code: number | string | undefined; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['dist/index.js', 'tool', 'run', TOOL], { cwd: process.cwd(), env: { ...process.env, TM8_JOURNAL_PATH: '', TM8_SESSION_ID: '', TM8_SPACE_ID: SPACE, TM8_BASE_URL: baseUrl, TM8_CREDENTIALS_MODE: 'off', TM8_JOURNAL_CLASS: 'human' } }, (error, stdout, stderr) => resolve({ code: error?.code ?? undefined, stdout, stderr }));
    });
    expect(result.code).toBe(37); expect(result.stdout).toBe(`${SESSION}\nstored output\n`);
  });
  it('maps timed out/killed runs and refuses missing process statuses', () => {
    expect(toolRunExitCode({ ...storedRun(), state: 'timed_out', exitCode: null })).toBe(124);
    expect(toolRunExitCode({ ...storedRun(), state: 'killed', exitCode: null })).toBe(137);
    expect(() => toolRunExitCode({ ...storedRun(), state: 'exited', exitCode: null })).toThrow('exit code');
  });
});
