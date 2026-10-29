import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_WS_PROTOCOL, PTY_GRANT_PROTOCOL_PREFIX, TOOL_STARTERS, toolStarterDefinition, toolStarterNamed, type ToolDefinition, type ToolRun, type ToolView } from '@tm8/contract';
import { parseInvocation } from '../src/args.js';
import { run } from '../src/run.js';
import { parseToolArgs, parseToolValue, renderToolHelp, type ToolHelp } from '../src/commands/tool-args.js';
import { duration, type ToolListItem } from '../src/commands/tool-views.js';
import { toolRunExitCode } from '../src/commands/tool-terminal.js';
import * as secretReader from '../src/commands/tool-secret.js';
import { nounHelp } from '../src/discovery/help.js';
// The first run() of the file pays the CLI's module warm-up, several seconds on a loaded runner.
vi.setConfig({ testTimeout: 20000 });

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
let noReplay = false, statusDelay = 0, noTerminalEnd = false;
const AUTHOR = { id: CREDENTIAL, kind: 'team_member' as const, displayName: 'Author', isAgent: false };
// Stored snapshots, newest first, as entities.versions returns them. Since migration 381 a definition
// write pins execution_version = version; a configuration, secret or metadata write keeps the older pin.
const stored = (version: number, patch: Partial<ToolDefinition>, config: Record<string, unknown> = {}, executionVersion = version) => ({
  entityId: TOOL, version, changedBy: AUTHOR, changedAt: `2026-10-28T1${version}:00:00.000Z`,
  snapshot: { entity: { id: TOOL, kind: 'tool', version }, content: { title: 'demo', definition: { ...definition, ...patch },
    execution_version: executionVersion, config_revision: Object.keys(config).length, config, secretBindings: [] } },
});
let history: ReturnType<typeof stored>[] = [], versionPageCap = 200;
// Starter installs: the Space's tools (served two per page), and refusals by tool name.
let spaceTools: ToolView[] | undefined, headerRefused = false, headerNotStored = false;
let createRefusals: Record<string, { status: number; code: string; message: string }> = {};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const toolNamed = (name: string, id: string, source = toolStarterNamed(name)!.source): ToolView =>
  ({ ...tool, id, version: 3, sourceSha256: sha256(source), definition: { ...definition, name, source } });
const createdId = (name: string): string => `5555555${TOOL_STARTERS.findIndex(starter => starter.name === name) + 1}-5555-7555-8555-555555555555`;
const refuse = (res: import('node:http').ServerResponse, status: number, code: string, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message, retryable: false, requestId: 'test' } }));
};
const storedRun = (): ToolRun => ({ id: SESSION, spaceId: SPACE, toolId: TOOL, toolVersion: tool.version,
  sourceSha256: tool.sourceSha256, inputs: {}, state: completed ? 'exited' : 'running', keepOpen,
  exitCode: completed ? exitCode : null, startedAt: completed ? '2026-10-28T18:36:37.000Z' : null, exitedAt: completed ? '2026-10-28T18:36:41.400Z' : null,
  outputTail: 'stored output\n', parentSessionId: null, invoker: AUTHOR });

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
      if (!keepOpen && !noTerminalEnd) {
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
        else if (spaceTools) {
          const start = Number(url.searchParams.get('cursor') ?? 0);
          data = { items: spaceTools.slice(start, start + 2), nextCursor: start + 2 < spaceTools.length ? String(start + 2) : null };
        } else data = { items: [tool], nextCursor: null };
        if (req.method === 'POST') {
          const refusal = createRefusals[body.definition?.name];
          if (refusal) { refuse(res, refusal.status, refusal.code, refusal.message); return; }
          data = spaceTools ? { ...tool, id: createdId(body.definition.name), version: 1, definition: body.definition } : tool;
        }
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
      else if (url.pathname.endsWith('/versions')) {
        // The cursor is the last version served, the keyset the server encodes.
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), versionPageCap), after = url.searchParams.get('cursor');
        const rest = history.filter(item => after === null || item.version < Number(after));
        data = { items: rest.slice(0, limit), nextCursor: rest.length > limit ? String(rest[limit - 1]!.version) : null };
      }
      else if (url.pathname.includes('/tool-runs/')) data = storedRun();
      else if (url.pathname.endsWith('/secrets/bind')) data = { inputName: 'auth', keyHint: '••••' };
      else if (url.pathname.endsWith('/header')) {
        if (headerRefused) { refuse(res, 403, 'forbidden', 'Header writes are not allowed here'); return; }
        // The node's answer: an authored header when stored; a node that does not admit the kind
        // answers 200 with no header and a header_not_stored warning (before migration 380).
        data = headerNotStored
          ? { patches: [], warnings: [{ code: 'header_not_stored', message: 'a tool cannot carry a selection header; nothing was stored' }] }
          : { patches: [], header: { whenToUse: body.whenToUse ?? null, summary: body.summary ?? null, keywords: [], version: 1, pinnedVersion: 1 } };
      }
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
    executionVersion: 6, configRevision: 0, config: {}, secretBindings: [], sourceChangedSinceViewerLastRun: null };
  requests = []; stdout = ''; stderr = ''; fast = false; completed = false; exitCode = 37; keepOpen = false; conflict = false; helpVersionMismatch = false; namePage = 0;
  TerminalSocket.instances = [];
  noReplay = false; statusDelay = 0; noTerminalEnd = false; versionPageCap = 200;
  spaceTools = undefined; headerRefused = false; headerNotStored = false; createRefusals = {};
  history = [
    // v6: an inputs edit after migration 381 (pin 6). v5: a configuration write before it (pin 2).
    // v4: a source edit before it whose v2 and v3 folded into it (pin 2). v1: created.
    stored(6, { source: 'echo one\necho two\n', help: 'New help', inputs: definition.inputs.slice(0, 2) }, { limit: 4 }),
    stored(5, { source: 'echo one\necho two\n' }, { limit: 4 }, 2),
    stored(4, { source: 'echo one\necho two\n' }, {}, 2),
    stored(1, { source: 'echo one\n' }),
  ];
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
  it('names the declared range or number rule when a value is out of bounds, never the value itself', () => {
    expect(() => parseToolArgs(definition.inputs, ['-l', '500'])).toThrow('limit must be between 1 and 100');
    expect(() => parseToolArgs(definition.inputs, ['-l', '500'])).not.toThrow('500');
    expect(() => parseToolArgs(definition.inputs, ['-l', '1.5'])).toThrow('limit expects an integer');
    expect(() => parseToolArgs(definition.inputs, ['--ratio', 'abc'])).toThrow('ratio expects a number');
    expect(() => parseToolValue({ name: 'since', type: 'int', min: 0 }, '-1')).toThrow('since must be at least 0');
    expect(() => parseToolValue({ name: 'share', type: 'number', max: 1 }, '2')).toThrow('share must be at most 1');
    expect(() => parseToolValue({ name: 'count', type: 'int' }, '1e400')).toThrow('count expects an integer');
    expect(() => parseToolArgs(definition.inputs, ['--state', 'other'])).toThrow('Invalid enum value for state; choose open|closed');
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
  it('renders tool list and runs as tables for a human, while --format json stays the DTO', async () => {
    const URL_CHECK = '77777777-7777-7777-8777-777777777777', OTHER = '66666666-6666-7666-8666-666666666666';
    const listed = (name: string, id: string, lastRun?: ToolListItem['lastRun']): ToolListItem =>
      ({ ...tool, id, version: 3, executionVersion: 2, definition: { ...definition, name, tm8Access: name === 'space-digest' ? 'read' : 'none' }, ...(lastRun === undefined ? {} : { lastRun }) });
    spaceTools = [listed('demo', TOOL, { sessionId: SESSION, state: 'exited', exitCode: 1, startedAt: '2026-10-28T18:36:37.415Z', exitedAt: '2026-10-28T18:36:38.340Z' }),
      listed('space-digest', URL_CHECK, null), listed('gh-pr-status', OTHER)];
    expect(await run(['tool', 'list', '--limit', '2'])).toBe(0);
    expect(stdout.split('\n')).toEqual([
      'name          runtime  version  access  last-run',
      'demo          bash     v2       none    exited 1 2026-10-28T18:36:37.415Z',
      'space-digest  bash     v2       read    never',
      'more: tm8 tool list --cursor 2', '']);
    expect(stdout).not.toContain('echo hello');
    stdout = '';
    expect(await run(['tool', 'list', '--cursor', '2'])).toBe(0);
    expect(stdout).toBe('name          runtime  version  access  last-run\ngh-pr-status  bash     v2       none\n');
    stdout = '';
    // The mock answers the first --words listing with a further page.
    expect(await run(['tool', 'list', '--words', 'gh'])).toBe(0);
    // The entity version (23) is the concurrency token; the table prints the execution version runs pin.
    expect(stdout).toBe('name        runtime  version  access  last-run\ndemo-other  bash     v6       none\nmore: tm8 tool list --words "gh" --cursor next\n');
    stdout = '';
    expect(await run(['tool', 'list', '--format', 'json', '--limit', '2'])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ items: spaceTools.slice(0, 2), nextCursor: '2' });
    stdout = ''; spaceTools = [];
    expect(await run(['tool', 'list'])).toBe(0);
    expect(stdout).toBe('no tools in this Space; create one with tm8 tool create, or tm8 tool starters install\n');
    stdout = '';
    expect(await run(['tool', 'list', '--words', 'zzz'])).toBe(0);
    expect(stdout).toBe('no tools match "zzz" in this Space\n');
    stdout = ''; completed = true; exitCode = 37;
    expect(await run(['tool', 'runs', TOOL])).toBe(0);
    expect(stdout).toBe(`id${' '.repeat(34)}  version  status  exit  duration  invoker  started\n${SESSION}  v23      exited  37    4s        Author   2026-10-28T18:36:37.000Z\n`);
    stdout = '';
    expect(await run(['tool', 'runs', TOOL, '--format', 'json'])).toBe(0);
    expect(JSON.parse(stdout).items[0]).toMatchObject({ id: SESSION, state: 'exited', exitCode: 37, invoker: AUTHOR });
    expect([duration(null, '2026-10-28T18:36:41.400Z'), duration('2026-10-28T18:00:00Z', '2026-10-28T18:02:05Z'), duration('2026-10-28T18:00:00Z', '2026-10-28T19:02:00Z')]).toEqual(['', '2m 05s', '1h 02m']);
  });
  it('wires show, source, list, help, runs, and run-show output to their operations', async () => {
    expect(await run(['tool', 'show', TOOL, '--source'])).toBe(0); expect(stdout).toContain('echo hello');
    expect(await run(['tool', 'list', '--words', 'demo', '--limit', '2'])).toBe(0);
    expect(requests.at(-1)!.query.get('limit')).toBe('2');
    expect(await run(['tool', 'help', TOOL])).toBe(0); expect(requests.at(-1)!.path).toContain('/help');
    expect(await run(['tool', 'runs', TOOL, '--limit', '3'])).toBe(0); expect(requests.at(-1)!.path).toContain('/runs');
    expect(await run(['tool', 'run-show', SESSION, '--output'])).toBe(0); expect(stdout).toContain('stored output');
    expect(nounHelp('tool')!.commands).toHaveLength(16);
  });
});

describe('version history', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  type Row = { version: number; executionVersion: number; definition: boolean; changed: string[] | null; previousVersion: number | null };
  const shape = (rows: Row[]) => rows.map(row => [row.version, row.executionVersion, row.definition, row.changed, row.previousVersion]);
  it('lists definition versions by default from the whole history, classifying pre-381 rows by their executable fields', async () => {
    versionPageCap = 2;
    expect(await run(['tool', 'versions', 'demo', '--format', 'json'])).toBe(0);
    const page = JSON.parse(stdout);
    expect(page).toMatchObject({ toolId: TOOL, name: 'demo', currentVersion: 23, currentExecutionVersion: 6, all: false, nextCursor: null, hidden: 1, truncated: 0 });
    // v5 is a configuration write (pin 2, nothing executable changed); v4's pin also reads 2 but its source differs from v1.
    expect(shape(page.items)).toEqual([[6, 6, true, ['inputs', 'help', 'config'], 4], [4, 2, true, ['source'], 1], [1, 1, true, null, null]]);
    expect(page.items[0]).toMatchObject({ changedBy: AUTHOR, changedAt: '2026-10-28T16:00:00.000Z', configRevision: 1, sourceSha256: sha('echo one\necho two\n') });
    expect(requests.filter(req => req.path.endsWith('/versions')).map(req => [req.query.get('limit'), req.query.get('cursor')])).toEqual([['200', null], ['200', '5']]);
    stdout = '';
    expect(await run(['tool', 'versions', TOOL])).toBe(0);
    expect(stdout).toContain('demo: 3 definition versions, newest first (current v6)');
    expect(stdout).toMatch(/v6 +2026-10-28T16:00:00.000Z +Author +inputs, help, config +sha256 [0-9a-f]{12}/);
    expect(stdout).toMatch(/v4 .* source +sha256 /); expect(stdout).toMatch(/v1 .* created +sha256 /);
    expect(stdout).not.toContain('v5'); expect(stdout).not.toContain('note:');
    expect(stdout).toContain('hidden: 1 configuration or metadata write; --all lists every stored write');
    stdout = '';
    expect(await run(['tool', 'versions', TOOL, '--limit', '2'])).toBe(0);
    expect(stdout).toContain('more: 1 older definition version; drop --limit to list all'); expect(stdout).not.toMatch(/^v1 /m);
    requests = [];
    expect(await run(['tool', 'versions', TOOL, '--cursor', '5'])).toBe(2);
    expect(await run(['tool', 'versions', TOOL, '--limit', '0'])).toBe(2);
    expect(requests.some(req => req.path.endsWith('/versions'))).toBe(false);
  });
  it('pages every stored write with --all, comparing a page\'s oldest row past the page and naming the pinned definition', async () => {
    expect(await run(['tool', 'versions', 'demo', '--all', '--limit', '2', '--format', 'json'])).toBe(0);
    const page = JSON.parse(stdout);
    expect(page).toMatchObject({ all: true, nextCursor: '5', hidden: 0, truncated: 0 });
    expect(shape(page.items)).toEqual([[6, 6, true, ['inputs', 'help'], 5], [5, 2, false, ['config'], 4]]);
    const reads = requests.filter(req => req.path.endsWith(`/entities/${TOOL}/versions`));
    expect(reads.map(req => [req.query.get('limit'), req.query.get('cursor')])).toEqual([['2', null], ['1', '5']]);
    stdout = '';
    expect(await run(['tool', 'versions', TOOL, '--all'])).toBe(0);
    expect(stdout).toContain('demo: 4 stored writes, newest first (current v6)');
    expect(stdout).toMatch(/v5 +2026-10-28T15:00:00.000Z +Author +config +definition v2/);
    expect(stdout).toMatch(/v4 .* source +sha256 /);
    expect(stdout).toContain('note: versions written before migration 381 (2026-10-28) may have been folded');
    expect(stdout).not.toContain('hidden:'); expect(stdout).not.toContain('more:');
    stdout = '';
    expect(await run(['tool', 'versions', TOOL, '--all', '--limit', '1'])).toBe(0);
    expect(stdout).toContain('more: tm8 tool versions demo --all --cursor 6');
  });
  it('diffs the two newest definition versions by default and says when the source did not change', async () => {
    expect(await run(['tool', 'diff', 'demo'])).toBe(0);
    expect(stdout).toBe('no source change between demo v4 and v6; changed: inputs, help, config\n');
    stdout = '';
    // An explicit end may be any stored write, a configuration write included.
    expect(await run(['tool', 'diff', 'demo', '--from', '5'])).toBe(0);
    expect(stdout).toBe('no source change between demo v5 and v6; changed: inputs, help\n');
  });
  it('prints a unified source diff between named versions, with json carrying both ends', async () => {
    expect(await run(['tool', 'diff', 'demo', '--from', 'v1', '--to', '4'])).toBe(0);
    expect(stdout).toBe('--- demo@v1\n+++ demo@v4\n@@ -1 +1,2 @@\n echo one\n+echo two\n');
    stdout = '';
    expect(await run(['tool', 'diff', 'demo', '--from', '1', '--format', 'json'])).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ toolId: TOOL, name: 'demo', from: { version: 1, executionVersion: 1, definition: true, changedBy: AUTHOR },
      to: { version: 6, executionVersion: 6, definition: true }, changed: ['source', 'inputs', 'help', 'config'],
      diff: '--- demo@v1\n+++ demo@v6\n@@ -1 +1,2 @@\n echo one\n+echo two\n' });
    expect(result.from.sourceSha256).toBe(sha('echo one\n'));
    stdout = '';
    expect(await run(['tool', 'diff', 'demo', '--from', '4', '--to', '5', '--format', 'json'])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ from: { version: 4, executionVersion: 2, definition: true }, to: { version: 5, executionVersion: 2, definition: false }, changed: ['config'], diff: '' });
  });
  it('walks history pages until both named versions are found, and stops once a missing one is passed', async () => {
    versionPageCap = 2;
    expect(await run(['tool', 'diff', 'demo', '--from', '4', '--to', '6'])).toBe(0);
    expect(requests.filter(req => req.path.endsWith('/versions')).map(req => req.query.get('cursor'))).toEqual([null, '5']);
    requests = [];
    expect(await run(['tool', 'diff', 'demo', '--from', '5', '--to', '6'])).toBe(0);
    expect(requests.filter(req => req.path.endsWith('/versions'))).toHaveLength(1);
    requests = [];
    expect(await run(['tool', 'diff', 'demo', '--from', '3'])).toBe(5);
    expect(stderr).toContain('demo v3 has no stored snapshot (nearest stored: v4, v1); versions written before migration 381 (2026-10-28) may have been folded');
    expect(requests.filter(req => req.path.endsWith('/versions'))).toHaveLength(2);
    expect(await run(['tool', 'diff', 'demo', '--to', '9'])).toBe(5);
    expect(stderr).toContain('demo v9 has no stored snapshot (nearest stored: v6)');
    expect(await run(['tool', 'diff', 'demo', '--from', '3', '--to', '6'])).toBe(5);
  });
  it('refuses a single stored definition version and malformed version numbers', async () => {
    history = history.slice(-1);
    expect(await run(['tool', 'diff', 'demo'])).toBe(5);
    expect(stderr).toContain('demo has no stored definition version older than v1 to compare with');
    // A configuration write on top of the only definition version is not a second definition version.
    history = [stored(2, { source: 'echo one\n' }, { limit: 1 }, 1), stored(1, { source: 'echo one\n' })];
    expect(await run(['tool', 'diff', 'demo'])).toBe(5);
    expect(stderr).toContain('demo has no stored definition version older than v1 to compare with');
    requests = [];
    for (const bad of ['0', 'latest', '-1', '1.5']) expect(await run(['tool', 'diff', 'demo', '--from', bad])).toBe(2);
    expect(requests).toHaveLength(0);
    expect(await run(['tool', 'versions', 'demo', 'extra'])).toBe(2);
  });
});

describe('starters', () => {
  const OTHER = '66666666-6666-7666-8666-666666666666', URL_CHECK = '77777777-7777-7777-8777-777777777777';
  it('lists every starter in full and marks names that exist, comparing their source', async () => {
    spaceTools = [toolNamed('demo', TOOL, 'echo hello'), toolNamed('url-check', URL_CHECK), toolNamed('gh-pr-status', OTHER, 'echo edited')];
    expect(await run(['tool', 'starters', 'list', '--format', 'json'])).toBe(0);
    const { items } = JSON.parse(stdout);
    expect(items.map((item: { name: string }) => item.name)).toEqual(['gh-pr-status', 'slack-notify', 'space-digest', 'url-check']);
    expect(items[3]).toMatchObject({ ...toolStarterNamed('url-check'), existing: { toolId: URL_CHECK, version: 3, matchesStarter: true } });
    expect(items[0].existing).toEqual({ toolId: OTHER, version: 3, matchesStarter: false });
    expect(items[1].existing).toBeNull();
    // The Space listing pages, so a name past the first page still counts.
    expect(requests.filter(req => req.path.endsWith('/tools')).map(req => req.query.get('cursor'))).toEqual([null, '2']);
    stdout = '';
    expect(await run(['tool', 'starters', 'list'])).toBe(0);
    expect(stdout).toContain('4 starter tools; install with: tm8 tool starters install [--only <name>...]');
    expect(stdout).toMatch(/gh-pr-status +bash +exists v3 \(other source\) +List a GitHub/);
    expect(stdout).toMatch(/url-check +bash +exists v3 +Check that/); expect(stdout).toMatch(/space-digest +python +not installed/);
  });
  it('installs the missing starters with their headers and per-starter mutation ids, skipping existing names', async () => {
    spaceTools = [toolNamed('url-check', URL_CHECK)];
    expect(await run(['tool', 'starters', 'install', '--mutation-id', 'install-1', '--format', 'json'])).toBe(0);
    const creates = requests.filter(req => req.method === 'POST' && req.path.endsWith('/tools'));
    expect(creates.map(req => req.body.definition)).toEqual(['gh-pr-status', 'slack-notify', 'space-digest'].map(name => toolStarterDefinition(toolStarterNamed(name)!)));
    expect(creates.map(req => req.body.clientMutationId)).toEqual(['install-1:gh-pr-status', 'install-1:slack-notify', 'install-1:space-digest']);
    const headers = requests.filter(req => req.path.endsWith('/header'));
    expect(headers.map(req => [req.path.split('/')[3], req.body.clientMutationId, req.body.whenToUse, req.body.summary])).toEqual(
      ['gh-pr-status', 'slack-notify', 'space-digest'].map(name => [createdId(name), `install-1:${name}:header`, toolStarterNamed(name)!.whenToUse, toolStarterNamed(name)!.summary]));
    expect(JSON.parse(stdout).items).toEqual([
      { name: 'gh-pr-status', status: 'created', toolId: createdId('gh-pr-status'), version: 1, header: 'set' },
      { name: 'slack-notify', status: 'created', toolId: createdId('slack-notify'), version: 1, header: 'set' },
      { name: 'space-digest', status: 'created', toolId: createdId('space-digest'), version: 1, header: 'set' },
      { name: 'url-check', status: 'skipped', reason: 'exists', toolId: URL_CHECK },
    ]);
  });
  it('narrows with repeatable or comma-separated --only, and refuses an unknown name before any call', async () => {
    spaceTools = [];
    expect(await run(['tool', 'starters', 'install', '--only', 'url-check', '--only', 'space-digest,url-check'])).toBe(0);
    expect(requests.filter(req => req.method === 'POST').map(req => req.body.definition.name)).toEqual(['space-digest', 'url-check']);
    expect(stdout).toMatch(/created +space-digest +5555555/); expect(stdout).toContain('2 created, 0 skipped, 0 failed');
    requests = [];
    expect(await run(['tool', 'starters', 'install', '--only', 'url-check,nope'])).toBe(2);
    expect(stderr).toContain('Unknown starter nope; choose from gh-pr-status, slack-notify, space-digest, url-check');
    expect(await run(['tool', 'starters', 'install', '--only', ','])).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it('reports a name taken since the listing as skipped, and a refused create as failed without stopping the rest', async () => {
    spaceTools = [];
    createRefusals = {
      'gh-pr-status': { status: 409, code: 'invariant_violation', message: 'a live tool already has this name' },
      'slack-notify': { status: 403, code: 'forbidden', message: 'Tool creation is not allowed' },
    };
    expect(await run(['tool', 'starters', 'install'])).toBe(4);
    expect(stdout).toMatch(/skipped +gh-pr-status +already exists\n/);
    expect(stdout).toMatch(/failed +slack-notify +forbidden: Tool creation is not allowed/);
    expect(stdout).toMatch(/created +space-digest/); expect(stdout).toMatch(/created +url-check/);
    expect(stdout).toContain('2 created, 1 skipped, 1 failed');
  });
  it('keeps a created starter when its header cannot be set, and warns', async () => {
    spaceTools = []; headerRefused = true;
    expect(await run(['tool', 'starters', 'install', '--only', 'url-check', '--format', 'json'])).toBe(0);
    expect(JSON.parse(stdout).items).toEqual([{ name: 'url-check', status: 'created', toolId: createdId('url-check'), version: 1, header: 'failed' }]);
    expect(stderr).toContain('url-check was created but its selection header was not set: forbidden: Header writes are not allowed here');
  });
  it('reports a header the node answered without storing as not_stored, with a warning, for install and create', async () => {
    spaceTools = []; headerNotStored = true;
    expect(await run(['tool', 'starters', 'install', '--only', 'url-check', '--format', 'json'])).toBe(0);
    expect(JSON.parse(stdout).items).toEqual([{ name: 'url-check', status: 'created', toolId: createdId('url-check'), version: 1, header: 'not_stored' }]);
    expect(stderr).toContain('url-check was created but its selection header was not stored: header_not_stored: a tool cannot carry a selection header; nothing was stored');
    stdout = ''; stderr = '';
    expect(await run(['tool', 'starters', 'install', '--only', 'space-digest'])).toBe(0);
    expect(stdout).toMatch(/created +space-digest +\S+ v1 \(selection header not set\)/);
    stdout = ''; stderr = '';
    expect(await run(['tool', 'create', '--from-starter', 'slack-notify'])).toBe(0);
    expect(stderr).toContain('slack-notify was created but its selection header was not stored: header_not_stored');
  });
  it('creates from a starter, letting the name, options and spec fields override it', async () => {
    expect(await run(['tool', 'create', '--from-starter', 'url-check'])).toBe(0);
    expect(requests.find(req => req.method === 'POST')!.body.definition).toEqual(toolStarterDefinition(toolStarterNamed('url-check')!));
    expect(requests.find(req => req.path.endsWith('/header'))!.body).toMatchObject({ whenToUse: toolStarterNamed('url-check')!.whenToUse, summary: toolStarterNamed('url-check')!.summary });
    requests = [];
    const dir = mkdtempSync(join(tmpdir(), 'tm8-starter-'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ timeoutSeconds: 30 })); writeFileSync(join(dir, 'tool.sh'), 'echo mine\n');
    expect(await run(['tool', 'create', 'my-check', '--from-starter', 'url-check', '--source', `@${join(dir, 'tool.sh')}`,
      '--spec', `@${join(dir, 'spec.json')}`, '--description', 'Mine', '--summary', 'Custom summary'])).toBe(0);
    const starter = toolStarterNamed('url-check')!;
    expect(requests.find(req => req.method === 'POST')!.body.definition).toEqual({ ...toolStarterDefinition(starter),
      name: 'my-check', description: 'Mine', source: 'echo mine\n', timeoutSeconds: 30 });
    expect(requests.find(req => req.path.endsWith('/header'))!.body).toMatchObject({ whenToUse: starter.whenToUse, summary: 'Custom summary' });
    requests = [];
    expect(await run(['tool', 'create', '--from-starter', 'nope'])).toBe(2);
    expect(await run(['tool', 'create', 'a', 'b', '--from-starter', 'url-check'])).toBe(2);
    expect(await run(['tool', 'create', '--runtime', 'bash', '--source', `@${join(dir, 'tool.sh')}`])).toBe(2);
    expect(requests).toHaveLength(0);
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
  it('settles from persisted status when the PTY end frame and close event are lost', async () => {
    noTerminalEnd = true; exitCode = 1;
    expect(await run(['tool', 'run', TOOL])).toBe(1);
    expect(TerminalSocket.instances[0]!.closed).toBe(true);
    expect(stdout).toBe(`${SESSION}\nlive output\n`);
  });
  it('does not resume piped stdin for an attached drive session', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const input = Object.assign(new EventEmitter(), { isTTY: false, resume: vi.fn(), pause: vi.fn() });
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    try {
      expect(await run(['tool', 'run', TOOL])).toBe(37);
      expect(input.resume).not.toHaveBeenCalled();
      expect(input.listenerCount('data')).toBe(0);
    } finally { Object.defineProperty(process, 'stdin', stdinDescriptor); }
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
    expect(stderr).toContain(`shell left open; close with: tm8 session terminate ${SESSION} --yes`);
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
