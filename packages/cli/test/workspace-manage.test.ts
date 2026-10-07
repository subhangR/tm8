/**
 * `tm8 workspace create|rename|color|reorder|delete|use` (MW W2.1, API doc
 * 01a115c4 §8.2). Drives `run()` against a local fake node: `<ws>` resolves by
 * id or case-insensitive name through `workspace.list`, `--last` is bare only
 * on `workspace reorder`, delete sends its request id and `--discard` in the
 * query, and a switch conflict exits 6. W3.1 (§8.1, §8.3): `--workspace`
 * resolves a name to an id before anything is sent, `--expect-workspace`
 * rides along as the pin, several `tabs open` pairs are one batch, and an
 * agent's switch waits for the human (exit 16).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { parseInvocation } from '../src/args.js';
import { ledger } from '../src/discovery/availability.js';

vi.setConfig({ testTimeout: 30_000 });

async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true; });
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const SPACE = '11111111-1111-4111-8111-111111111111';
const MAIN = '22222222-2222-4222-8222-222222222222';
const BILLING = '33333333-3333-4333-8333-333333333333';
const REVIEW = '44444444-4444-4444-8444-444444444444';

const summary = (id: string, name: string, position: number, active = false) => ({
  id, name, color: null, position, active, revision: 1, tabCount: 0, draftCount: 0, dirtyDraftCount: 0,
  createdAt: '2026-10-07T08:00:00.000Z', createdBy: null, agentChangedSinceActive: false, lastAgentChange: null,
});
const LIST = {
  items: [summary(MAIN, 'Main', 0, true), summary(BILLING, 'Billing', 1), summary(REVIEW, 'Review', 2)],
  activeWorkspaceId: MAIN, listRevision: 4, cap: 20, prompts: [],
};
const manage = (status: string, workspace: unknown, extra: Record<string, unknown> = {}) => ({
  requestId: 'r1', status, workspace, activeWorkspaceId: MAIN, listRevision: 5, ...extra,
});

interface Recorded { method: string; path: string; search: string; body: Record<string, unknown> }
let recorded: Recorded[] = [];
let server: Server;
let baseUrl: string;
let configDir: string;

const ok = (data: unknown) => ({ status: 200, body: { data, requestId: 'req_t' } });
const WS = `/v2/spaces/${SPACE}/workspaces`;
let routes: Record<string, () => { status: number; body: unknown }> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      recorded.push({ method: req.method ?? '', path: url.pathname, search: url.search, body: raw === '' ? {} : JSON.parse(raw) });
      const route = routes[`${req.method} ${url.pathname}`];
      const reply = route ? route() : { status: 404, body: { error: { code: 'not_found', message: 'no route', requestId: 'r', retryable: false } } };
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const SAVED = ['TM8_BASE_URL', 'TM8_SPACE_ID', 'TM8_ACTOR_ID', 'TM8_CONFIG_PATH', 'TM8_SESSION_ID', 'TM8_AGENT_TOKEN', 'TM8_JOURNAL_CLASS', 'XDG_CONFIG_HOME'] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of SAVED) { saved[k] = process.env[k]; delete process.env[k]; }
  configDir = mkdtempSync(join(tmpdir(), 'tm8-workspace-manage-'));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.TM8_JOURNAL_CLASS = 'human';
  recorded = [];
  routes = { [`GET ${WS}`]: () => ok(LIST) };
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(configDir, { recursive: true, force: true });
  ledger.clear();
});

describe('tm8 workspace management verbs', () => {
  it('--last is bare on workspace reorder only; session transcript keeps --last <count>', () => {
    const reorder = parseInvocation(['workspace', 'reorder', 'Billing', '--last', '--request-id', 'r1']);
    expect(reorder.positionals).toEqual(['workspace', 'reorder', 'Billing']);
    expect(reorder.options.bool('last')).toBe(true);
    const transcript = parseInvocation(['session', 'transcript', 'abc', '--last', '5']);
    expect(transcript.options.value('last')).toBe('5');
  });

  it('reorder resolves <ws> by case-insensitive name and prints the new order', async () => {
    routes[`POST ${WS}/${BILLING}/move`] = () => ok(manage('applied', summary(BILLING, 'Billing', 2)));
    const r = await tm8(['workspace', 'reorder', 'billing', '--last', '--request-id', 'r1']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${WS}`, `POST ${WS}/${BILLING}/move`]);
    expect(recorded[1]?.body).toMatchObject({ requestId: 'r1', beforeWorkspaceId: null });
    expect(r.stdout).toContain('1. Main\n2. Review\n3. Billing');
  });

  it('delete carries requestId and --discard in the query and names the active workspace', async () => {
    routes[`DELETE ${WS}/${REVIEW}`] = () => ok(manage('applied', summary(REVIEW, 'Review', 2)));
    const r = await tm8(['workspace', 'delete', REVIEW, '--discard', '--request-id', 'r1']);
    expect(r.code, r.stderr).toBe(0);
    expect(new URLSearchParams(recorded[1]?.search)).toEqual(new URLSearchParams({ requestId: 'r1', discard: 'true' }));
    expect(r.stdout).toContain(`deleted Review (${REVIEW}); active: Main (${MAIN})`);
  });

  it('use exits 6 on a switch conflict and 5 on an unknown <ws> without writing', async () => {
    routes[`POST ${WS}/${REVIEW}/activate`] = () => ok(manage('conflict', summary(REVIEW, 'Review', 2), {
      reason: 'workspace_switched', expectedWorkspaceId: BILLING,
    }));
    const conflict = await tm8(['workspace', 'use', 'Review']);
    expect(conflict.code).toBe(6);
    expect(conflict.stdout).toContain('conflict (workspace_switched)');
    recorded = [];
    const missing = await tm8(['workspace', 'use', 'Nope']);
    expect(missing.code).toBe(5);
    expect(recorded.map((x) => x.method)).toEqual(['GET']);
  });
});

describe('tm8 workspace: which workspace (W3.1)', () => {
  const COMMANDS = `/v2/spaces/${SPACE}/workspace/commands`;
  const applied = { requestId: 'r1', status: 'applied', revision: 2, workspace: { id: REVIEW, name: 'Review', color: null, resolvedBy: 'explicit', active: false } };

  it('--workspace resolves a name before sending; several pairs are one batch with the pin', async () => {
    routes[`POST ${COMMANDS}`] = () => ok({ ...applied, tabIds: ['t1', 't2'], outcomes: ['opened', 'opened'] });
    const r = await tm8([
      'workspace', 'tabs', 'open', 'task', 'a1', 'doc', 'b2',
      '--workspace', 'review', '--expect-workspace', REVIEW, '--request-id', 'r1',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${WS}`, `POST ${COMMANDS}`]);
    expect(recorded[1]?.body).toMatchObject({
      command: 'workspace.tabs.open',
      args: { entities: [{ kind: 'task', entityId: 'a1' }, { kind: 'doc', entityId: 'b2' }] },
      workspaceId: REVIEW,
      expectedWorkspaceId: REVIEW,
    });
  });

  it('an unknown --workspace exits 5 before any write', async () => {
    const r = await tm8(['workspace', 'tabs', 'open', 'task', 'a1', '--workspace', 'Nope']);
    expect(r.code).toBe(5);
    expect(recorded.map((x) => x.method)).toEqual(['GET']);
  });

  it("an agent's use waits for the human: exit 16 with the prompt id", async () => {
    const prompt = { promptId: 'p1', kind: 'switch', workspaceId: REVIEW, workspaceName: 'Review', state: 'open', createdAt: '2026-10-07T08:00:00.000Z' };
    routes[`POST ${WS}/${REVIEW}/activate`] = () => ok(manage('requires_user_choice', summary(REVIEW, 'Review', 2), {
      reason: 'agent_switch', choices: ['switch', 'stay'], prompt, promptDelivered: 1,
    }));
    const r = await tm8(['workspace', 'use', 'Review']);
    expect(r.code).toBe(16);
    expect(r.stdout).toContain('waiting for the human: switch to Review? [switch, stay] prompt p1');
  });
});
