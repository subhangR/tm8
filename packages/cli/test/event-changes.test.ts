/**
 * `tm8 event changes` — the scoped change feed's CLI (spec doc 01a0cf35 §3.4,
 * §5, acceptance 4, 9, 10, 15, 16), against a stub Server.
 *
 * Drives the module through `run()`'s own funnel exactly as test/event.test.ts
 * does (the driver below is that file's, verbatim), substituting only the
 * registry lookup.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath, type EventChangesView } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_RETRYABLE, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { ledger } from '../src/discovery/availability.js';
import { commandDiscovery, discoveryFor } from '../src/discovery/operations.js';
import type { CommandModule } from '../src/run.js';

async function eventCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/event.js')).EVENT_COMMANDS;
}

interface Seen {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'req_t' } };
let scratchHome: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: url.pathname,
        query: url.search,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

const SPACE = '55555555-5555-7555-8555-555555555555';
const ENTITY = '66666666-6666-7666-8666-666666666666';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: { items: [], nextCursor: '0' }, requestId: 'req_t' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g8-home-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

afterEach(() => {
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_BASE_URL;
});

// ── the driver: `run()`'s funnel with only the registry substituted ─────────

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await eventCommands();
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: (c: string | Uint8Array) => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
    stderr: (c: string) => {
      stderr += c;
    },
  };
  let out = createOutput({ format: 'human', streams });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
      streams,
    });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '));
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    const code = await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

const T1 = '01a0cf19-583f-7287-ada2-2fc20c6dca7c';
const ROOT = '01a0cd01-fcaf-77cb-8559-b35d26e3b530';
const M1 = '01a0cf1a-779c-76e2-ac5a-7453ed71e1d1';
const M0 = '01a0cf1a-7700-76e2-ac5a-7453ed71e1d0';

/** A digest carrying every optional field, so "every field appears" is checkable. */
function fullDigest(overrides: Partial<EventChangesView> = {}): EventChangesView {
  return {
    scope: { subtree: [ROOT] },
    since: 146232,
    through: 146732,
    more: false,
    gap: null,
    unresolved: [],
    changed: [
      {
        id: T1, kind: 'task', title: 'THROWAWAY receipt fixture B (delete me)', parentId: ROOT,
        v: 3, status: 'done', lastSeq: 146731,
        changes: ['created', 'status:in_progress→done', 'edge+:tracks', 'pr', 'message'],
        actors: ['Opus 5.5 1M Teammate', 'Subhang'],
        messages: [
          { id: M1, author: 'Opus 5.5 1M Teammate', replyTo: M0, toMe: true, excerpt: 'short reply for measurement', truncated: true },
        ],
        messagesTotal: 6,
        messagesMore: true,
        messagesNext: `tm8 entity feed ${T1} --order newest --cursor abc123`,
      },
      {
        id: ROOT, kind: 'task', title: 'Work on: research', parentId: null, v: 2, status: 'working',
        lastSeq: 146580, changes: ['message'], actors: ['Opus 5 1M Teammate'],
        messages: [{ id: M0, author: 'Opus 5 1M Teammate', replyTo: null, toMe: false, excerpt: 'Follow-up work launched', truncated: false }],
        messagesTotal: 1,
      },
    ],
    next: `tm8 event changes --subtree ${ROOT} --after 146732`,
    ...overrides,
  };
}

const ok = (data: unknown): { status: number; body: unknown } => ({ status: 200, body: { data, requestId: 'req_t' } });

/** Every leaf value of a DTO, as the strings a lossless rendering must contain. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out);
  else if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  return out;
}

describe('tm8 event changes — wiring', () => {
  it('is registered and bound to events.changes', async () => {
    const modules = await eventCommands();
    expect(modules.map((m) => m.path.join(' '))).toContain('event changes');
    expect(discoveryFor('events.changes').command).toEqual(['event', 'changes']);
    expect(commandDiscovery(['event', 'changes'])?.operations).toEqual(['events.changes']);
  });

  it('`event list` help points at `event changes` for "did anything change"', () => {
    expect(discoveryFor('events.poll').notes.join('\n')).toContain('to ask whether something changed, use `tm8 event changes`');
  });

  it('GETs the bound path with selectors as comma-joined query params', async () => {
    reply = ok(fullDigest());
    const r = await drive([
      'event', 'changes', '--subtree', ROOT, '--anchor', T1, '--anchor', M0, '--kind', 'task',
      '--change', 'status', '--after', '146232', '--total-bytes', '9000', '--events',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.pathname).toBe(bindPath('events.changes', { spaceId: SPACE }));
    const q = new URLSearchParams(seen[0]?.query ?? '');
    expect(q.get('subtree')).toBe(ROOT);
    expect(q.get('anchor')).toBe(`${T1},${M0}`);
    expect(q.get('kind')).toBe('task');
    expect(q.get('change')).toBe('status');
    expect(q.get('after')).toBe('146232');
    expect(q.get('totalBytes')).toBe('9000');
    expect(q.get('events')).toBe('true');
  });
});

describe('acceptance 16 — --total-bytes range is a usage error, never a request', () => {
  for (const bad of ['8191', '32769', '0', 'lots']) {
    it(`--total-bytes ${bad} → exit 2, nothing sent`, async () => {
      const r = await drive(['event', 'changes', '--total-bytes', bad]);
      expect(r.code).toBe(EXIT_USAGE);
      expect(seen).toHaveLength(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/--total-bytes expects 8192\.\.32768/);
    });
  }
  for (const good of ['8192', '32768']) {
    it(`--total-bytes ${good} is accepted`, async () => {
      reply = ok(fullDigest());
      const r = await drive(['event', 'changes', '--total-bytes', good]);
      expect(r.code).toBe(0);
    });
  }

  it('a malformed selector id is refused locally', async () => {
    const r = await drive(['event', 'changes', '--entity', 'not-an-id']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
  });
});

describe('acceptance 9 — the line view is lossless and the footer tells the truth', () => {
  it('every JSON leaf value appears in the human view', async () => {
    const dto = fullDigest({ unresolved: ['77777777-7777-7777-8777-777777777777'] });
    reply = ok(dto);
    const r = await drive(['event', 'changes', '--subtree', ROOT, '--after', '146232']);
    expect(r.code).toBe(0);
    for (const leaf of leaves(dto)) expect(r.stdout, `missing ${leaf}`).toContain(leaf);
    // booleans with no string form: toMe, truncated, messagesMore, more.
    expect(r.stdout).toContain('to-me');
    expect(r.stdout).toContain('(truncated)');
    expect(r.stdout).toContain('+5 more');
    expect(r.stdout).toContain('+message×6');
    expect(r.stdout).toContain('parent -');
    expect(r.stdout).toContain('root');
  });

  it('"unchanged" ONLY when !more && !gap', async () => {
    reply = ok(fullDigest());
    let r = await drive(['event', 'changes', '--subtree', ROOT]);
    expect(r.stdout.trim().split('\n').at(-1)).toBe(
      `since 146232 · through 146732 · unchanged elsewhere in scope · next: tm8 event changes --subtree ${ROOT} --after 146732`,
    );

    reply = ok(fullDigest({ more: true }));
    r = await drive(['event', 'changes', '--subtree', ROOT]);
    expect(r.stdout).not.toMatch(/unchanged/);
    expect(r.stdout.trim().split('\n').at(-1)).toMatch(/more — next: tm8 event changes/);

    reply = ok(fullDigest({ changed: [], gap: { after: 10, oldestRetained: 500 } }));
    r = await drive(['event', 'changes', '--subtree', ROOT]);
    expect(r.stdout).not.toMatch(/unchanged/);
  });

  it('an unchanged poll (no scope, no next in the DTO) still prints the next command', async () => {
    reply = ok({ since: 146732, through: 146750, more: false, gap: null, unresolved: [], changed: [] });
    const r = await drive(['event', 'changes', '--subtree', ROOT, '--after', '146732']);
    expect(r.stdout.trim()).toBe(
      `since 146732 · through 146750 · unchanged in scope · next: tm8 event changes --subtree ${ROOT} --after 146750`,
    );
  });

  it('--events thin rows render every key', async () => {
    const dto: EventChangesView = {
      scope: {}, since: 1, through: 9, more: false, gap: null, unresolved: [],
      events: [{ seq: 5, type: 'edge.upsert', id: M0, edge: 'in_project', src: T1, dst: ROOT, actor: 'Opus 5 1M Teammate' }],
      next: 'tm8 event changes --events --after 9',
    };
    reply = ok(dto);
    const r = await drive(['event', 'changes', '--events']);
    for (const leaf of leaves(dto)) expect(r.stdout).toContain(leaf);
  });
});

describe('acceptance 4 — a GAP is loud, first, on both streams, and exit 0', () => {
  it('banner is the FIRST stdout line and is on stderr; never "unchanged"', async () => {
    reply = ok({
      scope: { subtree: [ROOT] }, since: 10, through: 900, more: false,
      gap: { after: 10, oldestRetained: 500 }, unresolved: [], changed: [], next: `tm8 event changes --subtree ${ROOT} --after 900`,
    });
    const r = await drive(['event', 'changes', '--subtree', ROOT, '--after', '10']);
    expect(r.code).toBe(0);
    const banner = 'GAP: events 11..499 were pruned; changes in that range are unknown, re-read with tm8 entity context <id>';
    expect(r.stdout.split('\n')[0]).toBe(banner);
    expect(r.stderr).toContain(banner);
    expect(r.stdout).not.toMatch(/unchanged/);
  });

  it('under --format json the banner still reaches stderr and stdout is the DTO alone', async () => {
    const dto = { since: 10, through: 900, more: false, gap: { after: 10, oldestRetained: 500 }, unresolved: [], changed: [] };
    reply = ok(dto);
    const r = await drive(['event', 'changes', '--format', 'json', '--after', '10']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(dto);
    expect(r.stderr).toMatch(/^GAP: events 11\.\.499/);
  });
});

describe('refusals — named by reason, nothing on stdout, cursor never advanced', () => {
  const refusal = (code: string, status: number, reason: string, hint: string): { status: number; body: unknown } => ({
    status,
    body: { error: { code, message: 'refused', requestId: 'r1', retryable: false, details: { reason, hint } } },
  });

  it('index_incomplete renders `index_incomplete: <hint>` and exits non-zero', async () => {
    reply = refusal('invalid_cursor', 400, 'index_incomplete', 'retry with --after 1199, or tm8 event list');
    const r = await drive(['event', 'changes', '--subtree', ROOT, '--after', '5']);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('index_incomplete: retry with --after 1199, or tm8 event list');
  });

  it('scope_too_large renders its reason and hint', async () => {
    reply = refusal('invalid_input', 400, 'scope_too_large', 'narrow the scope');
    const r = await drive(['event', 'changes', '--subtree', ROOT]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('scope_too_large: narrow the scope');
  });

  it('acceptance 15 — digest_group_too_large: no partial output', async () => {
    reply = refusal('payload_too_large', 413, 'digest_group_too_large', 'retry with a larger --total-bytes');
    const r = await drive(['event', 'changes', '--subtree', ROOT, '--after', '5']);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('digest_group_too_large: retry with a larger --total-bytes');
  });

  it('acceptance 10 — a server error prints no digest and exits retryable', async () => {
    reply = { status: 503, body: { error: { code: 'upstream_unavailable', message: 'db down', requestId: 'r2', retryable: true } } };
    const r = await drive(['event', 'changes', '--subtree', ROOT, '--after', '5']);
    expect(r.code).toBe(EXIT_RETRYABLE);
    expect(r.stdout).toBe('');
    expect(r.stdout).not.toMatch(/next:/);
  });

  it('acceptance 10 — a transport failure prints no digest and exits retryable', async () => {
    process.env.TM8_BASE_URL = 'http://127.0.0.1:1';
    const r = await drive(['event', 'changes', '--after', '5']);
    expect(r.code).toBe(EXIT_RETRYABLE);
    expect(r.stdout).toBe('');
  });
});

describe('minified JSON for agent-class invocations', () => {
  it('an agent session gets one minified line; a human gets indentation', async () => {
    const dto = fullDigest();
    reply = ok(dto);
    process.env.TM8_JOURNAL_CLASS = 'agent';
    try {
      const r = await drive(['event', 'changes', '--format', 'json']);
      expect(r.stdout).toBe(`${JSON.stringify(dto)}\n`);
    } finally {
      delete process.env.TM8_JOURNAL_CLASS;
    }
    process.env.TM8_JOURNAL_CLASS = 'human';
    try {
      const r = await drive(['event', 'changes', '--format', 'json']);
      expect(r.stdout).toBe(`${JSON.stringify(dto, null, 2)}\n`);
    } finally {
      delete process.env.TM8_JOURNAL_CLASS;
    }
  });
});
