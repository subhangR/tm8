/**
 * `tm8 mcp import`, driven over a fake Server.
 *
 * The assertions that matter are about what crosses the wire: definitions that
 * hold no token, a dry run that writes nothing at all, and a token that
 * travels ONLY in a `mcp.credentials.create` body and only when the member
 * asked for it with `--with-credentials`.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../src/args.js';
import { resolveContext } from '../src/context.js';
import { createOutput } from '../src/output.js';
import { MCP_IMPORT_COMMAND } from '../src/commands/mcp-import.js';

const SPACE = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'ntn_fixture_token_9xZ';
const STDIO_TOKEN = 'ghp_fixture_token_4aQ';

let server: Server;
let baseUrl: string;
let temp: string;
let requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
/** Servers the fake Space already has, as `mcp.servers.list` would return them. */
let existing: unknown[] = [];

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'mcp-import-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, body });
      const data = path.endsWith('/mcp/servers/import')
        ? { items: ((body?.definitions ?? []) as Array<{ name: string }>).map((definition, index) => ({
            id: `00000000-0000-4000-8000-00000000001${index}`, spaceId: SPACE, version: 1, definition,
            allowed: { register: true, approve: true, manage: true, attach: true },
          })) }
        : req.method === 'GET' && path.includes('/mcp/servers')
          ? { items: existing, nextCursor: null, allowed: { register: true, attach: true } }
          : { ok: true };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data, requestId: 'test' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
});

afterEach(() => { requests = []; existing = []; });

async function invoke(args: string[]) {
  const parsed = parseInvocation(['--space', SPACE, '--format', 'json', ...args]);
  const stdout: string[] = [];
  const ctx = resolveContext({ globals: parsed.globals, session: { baseUrl }, config: {} });
  const out = createOutput({ format: 'json', streams: { stdout: chunk => stdout.push(String(chunk)), stderr() {} } });
  const code = await MCP_IMPORT_COMMAND.run({
    path: MCP_IMPORT_COMMAND.path,
    args: parsed.positionals.slice(MCP_IMPORT_COMMAND.path.length),
    options: parsed.options,
    passthrough: parsed.passthrough,
    ctx,
    out,
  });
  return { code, result: JSON.parse(stdout.join('')) as Record<string, never> };
}

async function claudeConfig(): Promise<string> {
  const path = join(temp, 'claude.json');
  await writeFile(path, JSON.stringify({
    mcpServers: {
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
      slack: { type: 'http', url: 'https://mcp.slack.com/mcp' },
    },
    projects: {
      '/srv/app': {
        mcpServers: {
          github: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_TOKEN: STDIO_TOKEN } },
        },
      },
    },
  }), { mode: 0o600 });
  return path;
}

function wire(): string {
  return JSON.stringify(requests);
}

it('plans the import without writing anything under --dry-run', async () => {
  const path = await claudeConfig();
  const { result } = await invoke(['mcp', 'import', '--from', 'claude', '--path', path, '--dry-run']);
  expect(requests.filter(r => r.method !== 'GET')).toEqual([]);
  expect(result.dryRun).toBe(true);
  expect(result.plan).toMatchObject([
    { sourceName: 'notion', action: 'register', hasSecret: true, oauthProvider: 'Notion' },
    { sourceName: 'slack', action: 'register', hasSecret: false },
    { sourceName: 'github', action: 'needs-trust' },
  ]);
  // The plan is printed. It names the slot, never the value.
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(JSON.stringify(result)).not.toContain(STDIO_TOKEN);
});

it('registers translated definitions and keeps every token off the wire', async () => {
  const path = await claudeConfig();
  const { result } = await invoke(['mcp', 'import', '--from', 'claude', '--path', path]);
  const imported = requests.find(r => r.path.endsWith('/mcp/servers/import'));
  expect(imported?.method).toBe('POST');
  expect((imported?.body?.definitions as Array<{ name: string }>).map(d => d.name)).toEqual(['notion', 'slack']);
  expect(wire()).not.toContain(TOKEN);
  expect(wire()).not.toContain(STDIO_TOKEN);
  expect(requests.some(r => r.path.includes('/credentials'))).toBe(false);
  expect(result.registered).toHaveLength(2);
  expect(JSON.stringify(result.hints)).toContain('--with-credentials');
});

it('seals a literal token as the member’s own credential only when asked', async () => {
  const path = await claudeConfig();
  await invoke(['mcp', 'import', '--from', 'claude', '--path', path, '--with-credentials']);
  const credential = requests.filter(r => r.path.includes('/credentials'));
  expect(credential).toHaveLength(1);
  expect(credential[0]?.path).toBe('/v2/mcp/servers/00000000-0000-4000-8000-000000000010/credentials');
  // The token travels in exactly one body, and with the `Bearer ` prefix
  // stripped — tm8 re-adds it from the definition's `prefix`.
  expect(credential[0]?.body).toMatchObject({ secret: TOKEN, label: 'imported from claude' });
  const importCall = requests.find(r => r.path.endsWith('/mcp/servers/import'));
  expect(JSON.stringify(importCall)).not.toContain(TOKEN);
});

it('registers a local command only with --trust-stdio', async () => {
  const path = await claudeConfig();
  const { result } = await invoke(['mcp', 'import', '--from', 'claude', '--path', path, '--trust-stdio']);
  const definitions = requests.find(r => r.path.endsWith('/mcp/servers/import'))?.body?.definitions as Array<Record<string, unknown>>;
  expect(definitions.map(d => d.name)).toEqual(['notion', 'slack', 'github']);
  expect(definitions.find(d => d.name === 'github')).toMatchObject({
    transport: 'stdio', stdioTrusted: true, envKeys: ['GITHUB_TOKEN'], auth: { type: 'api_key', envKey: 'GITHUB_TOKEN' },
  });
  expect(wire()).not.toContain(STDIO_TOKEN);
  expect(result.plan).toHaveLength(3);
});

it('skips a connector the Space already has, matched by endpoint', async () => {
  const path = await claudeConfig();
  existing = [{
    id: '00000000-0000-4000-8000-0000000000aa', spaceId: SPACE, version: 3,
    definition: {
      name: 'notion-already', transport: 'http', url: 'https://mcp.notion.com/mcp/',
      envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true,
    },
    allowed: { register: true, approve: true, manage: true, attach: true },
  }];
  const { result } = await invoke(['mcp', 'import', '--from', 'claude', '--path', path]);
  expect(result.plan[0]).toMatchObject({ sourceName: 'notion', action: 'duplicate' });
  expect((result.plan[0] as unknown as { reason: string }).reason).toContain('notion-already');
  expect((requests.find(r => r.path.endsWith('/mcp/servers/import'))?.body?.definitions as unknown[]).length).toBe(1);
});

it('renames around a name the Space already uses so one clash cannot refuse the batch', async () => {
  const path = await claudeConfig();
  existing = [{
    id: '00000000-0000-4000-8000-0000000000bb', spaceId: SPACE, version: 1,
    definition: {
      name: 'Notion', transport: 'http', url: 'https://notion.internal.test/mcp',
      envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true,
    },
    allowed: { register: true, approve: true, manage: true, attach: true },
  }];
  const { result } = await invoke(['mcp', 'import', '--from', 'claude', '--path', path]);
  expect((requests.find(r => r.path.endsWith('/mcp/servers/import'))?.body?.definitions as Array<{ name: string }>).map(d => d.name))
    .toEqual(['notion-2', 'slack']);
  expect(result.plan[0]).toMatchObject({ sourceName: 'notion', name: 'notion-2', action: 'register' });
});

it('reads a Codex config.toml', async () => {
  const path = join(temp, 'config.toml');
  await writeFile(path, [
    'model = "gpt-5-codex"',
    '',
    '[mcp_servers.linear]',
    'url = "https://mcp.linear.app/mcp"',
    'bearer_token_env_var = "LINEAR_API_KEY"',
  ].join('\n'), { mode: 0o600 });
  const { result } = await invoke(['mcp', 'import', '--from', 'codex', '--path', path, '--dry-run']);
  expect(result.plan).toMatchObject([{ sourceName: 'linear', action: 'register', hasSecret: false }]);
  expect(result.format).toBe('codex');
});

it('refuses a missing file, an unknown dialect and an unknown flag', async () => {
  await expect(invoke(['mcp', 'import', '--from', 'claude', '--path', join(temp, 'absent.json')]))
    .rejects.toThrow('no claude configuration at');
  await expect(invoke(['mcp', 'import', '--from', 'cursor'])).rejects.toThrow('--from must be one of');
  await expect(invoke(['mcp', 'import', '--from', 'claude', '--force'])).rejects.toThrow('has no --force');
  expect(requests).toEqual([]);
});

it('says so rather than failing when the configuration has no servers tm8 can take', async () => {
  const path = join(temp, 'empty.json');
  await writeFile(path, JSON.stringify({ numStartups: 2 }));
  await expect(invoke(['mcp', 'import', '--from', 'claude', '--path', path])).rejects.toThrow('No mcpServers');
});
