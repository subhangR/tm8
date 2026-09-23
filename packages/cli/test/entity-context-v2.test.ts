/**
 * Entity context v2 — the CLI half of the shared acceptance suite (Module 2,
 * step S1). The server half, with the seeded fixtures and the statement
 * counter, is `packages/server/test/w2/context-v2-acceptance.pg.test.ts`.
 *
 * These are the items that are about CLI BEHAVIOUR rather than the DTO:
 *   c904 §5.1  agent-class `--format json` prints exactly the minified DTO bytes
 *   c904 §5.3  `context_budget_too_small` exits 2 and names the `next` command
 *   c904 §5.9  `--section-bytes` is a usage error on v2; `--schema v1` keeps it
 *   c904 §2.8  the expand flags (`--cursor`, `--offset`, `--edge-type`) bind, so
 *              every advertised expand runs verbatim from a shell
 *   c761 §10.9 the text brief shows every marker JSON shows
 *   c761 §9    the rollout matrix (agent json → v2; non-agent json → v1 + notice)
 *
 * The CLI is driven through `run()`'s own funnel against a stub HTTP server
 * (the `entity.test.ts` pattern); the stub answers with a v2 DTO written from
 * the spec, so what is under test is only the CLI.
 *
 * Tests the CLI cannot pass yet are `it.fails`, naming the step that flips
 * them: S3 (`--schema`, section paging flags), S4 (`--offset`, the 422 → exit 2,
 * `--section-bytes` refusal), S5 (minified print, text brief, rollout). Every
 * negative test carries a positive control, so none of them "passes" today
 * merely because `--schema` is still an unknown option.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { ledger } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

// ── the stub Server ─────────────────────────────────────────────────────────

interface Seen { method: string; pathname: string; query: URLSearchParams }

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'req_t' } };
let scratchHome: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', pathname: url.pathname, query: url.searchParams });
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

const SPACE = '11111111-1111-7111-8111-111111111111';
const ENT = '01a0cf17-c904-72cf-abb8-b894cb55da42';
const PARENT = '01a0cd01-fcaf-77cb-8559-b35d26e3b530';
const CHILD = '01a0cf17-c761-7942-a3ef-f597af1d1b67';
const DELETED = '01a0cf21-5a13-7000-8000-000000000001';
const UNREADABLE = '01a0cf21-fc2a-7000-8000-000000000002';

const ENV_KEYS = ['TM8_BASE_URL', 'TM8_SPACE_ID', 'XDG_CONFIG_HOME', 'TM8_CONFIG_PATH', 'TM8_ACTOR_ID',
  'TM8_JOURNAL_CLASS', 'TM8_NO_TERSE_DEFAULT'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  seen = [];
  reply = ok(V2_TASK);
  ledger.clear();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-ctx-v2-home-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_NO_TERSE_DEFAULT;
  // Agent class by default: the caller the v2 default is for.
  process.env.TM8_JOURNAL_CLASS = 'agent';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// ── the driver: `run()`'s funnel, render included ───────────────────────────

interface Ran { code: number; stdout: string; stderr: string }

async function entityCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/entity.js')).ENTITY_COMMANDS;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await entityCommands();
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
      render: inv.globals.render,
      streams,
    });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '))!;
    const ctx = resolveContext({ globals: inv.globals, session: sessionContextFromEnv(), config: loadLocalConfig() });
    const code = await mod.run({ path: match.path, args: match.args, options: inv.options, passthrough: inv.passthrough, ctx, out });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

const ok = (data: unknown) => ({ status: 200, body: { data, requestId: 'req_ctx_v2' } });

// ── a v2 DTO written from the spec (c761 §4, c904 §3) ───────────────────────

const BODY = '## Problem\nThe assignment body, cut at the ceiling.\n';
const V2_TASK = {
  schemaVersion: 'tm8.entity-context.v2',
  id: ENT,
  kind: 'task',
  title: 'Align: byte budgets that never drop the assignment',
  version: 2,
  status: 'working',
  priority: 'medium',
  gate: 'none',
  assignees: [{ id: '01a0cb4c-c0d8-79e7-b63f-edb646e8013c', name: 'Opus 5.5 1M Teammate', you: true, by: 'Opus 5 1M Teammate', at: '2026-09-23T16:28:03Z' }],
  parent: { id: UNREADABLE, unreadable: true },
  assignment: {
    text: BODY,
    bytes: 40211,
    complete: false,
    offset: 0,
    expand: `tm8 entity context ${ENT} --sections assignment --offset 15342`,
  },
  acceptance: [
    { id: 'a1', done: false, text: 'Current output measured on real entities' },
    { id: 'a2', done: true, text: 'Alternatives proposed with example responses' },
  ],
  blockers: [{ id: PARENT, title: 'Upstream dependency', status: 'open', resolved: false }],
  children: [
    { id: CHILD, kind: 'task', title: 'Align: a narrow default', status: 'working' },
    { id: DELETED, kind: 'task', title: 'A removed child', status: 'cancelled', deleted: true },
  ],
  messages: [
    { id: '01a0cf2d-e5f5-7188-aa75-7e4a887d411d', from: 'Opus 5.5 1M Teammate', at: '2026-09-23T16:51:26.824Z', text: 'Delegated decision for Subhang…', truncated: true },
  ],
  asOfSeq: 146582,
  omitted: [{
    section: 'messages', kept: 1, more: true, reason: 'rowLimit',
    expand: `tm8 entity context ${ENT} --sections messages --cursor c_msgs_2`,
    expandOp: { operation: 'entities.context', params: { id: ENT, sections: ['messages'], cursor: 'c_msgs_2' } },
  }],
  notLoaded: [
    { section: 'connections', expand: `tm8 entity context ${ENT} --sections connections`, expandOp: { operation: 'entities.context', params: { id: ENT, sections: ['connections'] } } },
    { section: 'actions', expand: `tm8 action list --for ${ENT}`, expandOp: { operation: 'actions.list', params: { for: ENT } } },
  ],
  errors: [{ section: 'connections', code: 'upstream_unavailable', retry: true }],
  budget: { requested: 16384, used: 2048 },
};
const V2_MINIFIED = `${JSON.stringify(V2_TASK)}\n`;

// ============================================================================
// v1 unchanged (plain `it`)
// ============================================================================

describe('v1 stays reachable and unchanged', () => {
  it('[c904 §5.9] without --schema, --section-bytes still binds (v1 keeps it)', async () => {
    reply = ok({ schemaVersion: 'tm8.entity-context.v1' });
    const r = await drive(['entity', 'context', ENT, '--total-bytes', '4096', '--section-bytes', '1024']);
    expect(r.code).toBe(0);
    expect(seen[0]?.query.get('sectionBytes')).toBe('1024');
  });
});

// ============================================================================
// S3 — --schema and the paging flags
// ============================================================================

describe('S3 --schema and section paging flags', () => {
  it.fails('[c761 §9] `--schema v2` requests v2 and `--schema v1` requests v1 (S3)', async () => {
    const two = await drive(['entity', 'context', ENT, '--schema', 'v2', '--format', 'json']);
    expect(two.code).toBe(0);
    expect(seen.at(-1)?.query.get('schema')).toBe('v2');
    reply = ok({ schemaVersion: 'tm8.entity-context.v1' });
    const one = await drive(['entity', 'context', ENT, '--schema', 'v1', '--format', 'json']);
    expect(one.code).toBe(0);
    expect(seen.at(-1)?.query.get('schema') ?? 'v1').toBe('v1');
  });

  it.fails('[c904 §5.9] `--schema v1` still accepts --section-bytes (S3)', async () => {
    reply = ok({ schemaVersion: 'tm8.entity-context.v1' });
    const r = await drive(['entity', 'context', ENT, '--schema', 'v1', '--section-bytes', '1024']);
    expect(r.code).toBe(0);
    expect(seen.at(-1)?.query.get('sectionBytes')).toBe('1024');
  });

  it.fails('[c904 §2.8 · c904 §5.4] the section expands run verbatim: --sections X --cursor, --edge-type bind (S3)', async () => {
    for (const expand of [
      `tm8 entity context ${ENT} --sections messages --cursor c_msgs_2`,
      `tm8 entity context ${ENT} --sections hierarchy --cursor c_kids_2`,
      `tm8 entity context ${ENT} --sections blockers --cursor c_blk_2`,
      `tm8 entity context ${ENT} --sections connections --edge-type in_project`,
    ]) {
      seen = [];
      const r = await drive([...expand.split(' ').slice(1), '--schema', 'v2']);
      expect(r.code, expand).toBe(0);
      const q = seen[0]!.query;
      expect(q.get('sections'), expand).toBe(/--sections (\S+)/.exec(expand)![1]);
      const cursor = /--cursor (\S+)/.exec(expand)?.[1];
      if (cursor) expect(q.get('cursor'), expand).toBe(cursor);
      const edgeType = /--edge-type (\S+)/.exec(expand)?.[1];
      if (edgeType) expect(q.get('edgeType'), expand).toBe(edgeType);
    }
  });

  it.fails('[c761 §9] --sections accepts the v2 names: assignment (alias summary), blockers (S3)', async () => {
    for (const section of ['assignment', 'blockers', 'summary']) {
      seen = [];
      const r = await drive(['entity', 'context', ENT, '--schema', 'v2', '--sections', section]);
      expect(r.code, section).toBe(0);
      expect(seen).toHaveLength(1);
    }
  });
});

// ============================================================================
// S4 — offset pages, context_budget_too_small, --section-bytes refusal
// ============================================================================

describe('S4 body pages and caller budget', () => {
  it.fails('[c904 §2.4] the body expand runs verbatim: --sections assignment --offset binds (S4)', async () => {
    const expand = V2_TASK.assignment.expand;
    const r = await drive([...expand.split(' ').slice(1), '--schema', 'v2']);
    expect(r.code).toBe(0);
    expect(seen[0]?.query.get('sections')).toBe('assignment');
    expect(seen[0]?.query.get('offset')).toBe('15342');
  });

  it.fails('[c904 §5.3] context_budget_too_small exits 2 and prints the `next` command (S4)', async () => {
    // Control: the same argv succeeds when the server answers 200.
    const control = await drive(['entity', 'context', ENT, '--schema', 'v2', '--total-bytes', '1024', '--format', 'json']);
    expect(control.code).toBe(0);
    const next = `tm8 entity context ${ENT} --total-bytes 5120`;
    reply = {
      status: 422,
      body: {
        error: {
          code: 'context_budget_too_small',
          message: 'the core needs 4698 bytes; 1024 were requested',
          details: { requestedBytes: 1024, minimumBytes: 4698, core: ['root', 'assignment', 'acceptance', 'blockers'] },
          next,
        },
        requestId: 'req_ctx_v2',
      },
    };
    const r = await drive(['entity', 'context', ENT, '--schema', 'v2', '--total-bytes', '1024', '--format', 'json']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('context_budget_too_small');
    expect(r.stderr).toContain(next);
    expect(r.stderr).toContain('4698');
  });

  it.fails('[c904 §5.9] v2 rejects --section-bytes locally as usage, before any request (S4)', async () => {
    const control = await drive(['entity', 'context', ENT, '--schema', 'v2', '--total-bytes', '4096']);
    expect(control.code).toBe(0);
    expect(seen).toHaveLength(1);
    seen = [];
    const r = await drive(['entity', 'context', ENT, '--schema', 'v2', '--section-bytes', '1024']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toContain('v2 budgets are total-only; see --total-bytes');
  });
});

// ============================================================================
// S5 — minified print, text brief, rollout
// ============================================================================

describe('S5 rendering and rollout', () => {
  it.fails('[c904 §5.1 · c904 §2.2] agent-class --format json prints EXACTLY the minified DTO (S5)', async () => {
    const r = await drive(['entity', 'context', ENT, '--schema', 'v2', '--format', 'json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(V2_MINIFIED);
    expect(Buffer.byteLength(r.stdout.trimEnd(), 'utf8')).toBe(Buffer.byteLength(JSON.stringify(V2_TASK), 'utf8'));
  });

  it.fails('[c761 §8] --full and TM8_NO_TERSE_DEFAULT are no-ops for entity context (S5)', async () => {
    const full = await drive(['entity', 'context', ENT, '--schema', 'v2', '--format', 'json', '--full']);
    expect(full.stdout).toBe(V2_MINIFIED);
    process.env.TM8_NO_TERSE_DEFAULT = '1';
    const killSwitch = await drive(['entity', 'context', ENT, '--schema', 'v2', '--format', 'json']);
    expect(killSwitch.stdout).toBe(V2_MINIFIED);
  });

  it.fails('[c761 §9] agent-class --format json asks for v2 by default; --schema v1 is the escape (S5)', async () => {
    const r = await drive(['entity', 'context', ENT, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(seen.at(-1)?.query.get('schema')).toBe('v2');
    expect(r.stdout).toBe(V2_MINIFIED);
    reply = ok({ schemaVersion: 'tm8.entity-context.v1' });
    await drive(['entity', 'context', ENT, '--format', 'json', '--schema', 'v1']);
    expect(seen.at(-1)?.query.get('schema') ?? 'v1').toBe('v1');
  });

  it.fails('[c761 §9] non-agent --format json stays v1 for one release, with a stderr notice (S5)', async () => {
    process.env.TM8_JOURNAL_CLASS = 'human';
    reply = ok({ schemaVersion: 'tm8.entity-context.v1' });
    const r = await drive(['entity', 'context', ENT, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(seen.at(-1)?.query.get('schema') ?? 'v1').toBe('v1');
    expect(r.stderr).toMatch(/v2/);
    expect(r.stderr).toMatch(/--schema/);
  });

  it.fails('[c761 §10.9 · c761 §4 Q20] the text brief is lossless on markers (S5)', async () => {
    const r = await drive(['entity', 'context', ENT]);
    expect(r.code).toBe(0);
    const text = r.stdout;
    // Defect 1 (c761 §1): text mode printed no body. The brief prints it.
    expect(text).toContain(BODY.trim());
    // complete:false with its bytes, and the continuation, verbatim.
    expect(text).toMatch(/40,?211 B/);
    expect(text).toMatch(/complete:\s*false|incomplete|cut/);
    expect(text).toContain(V2_TASK.assignment.expand);
    // acceptance, with done state
    expect(text).toContain('[ ] a1');
    expect(text).toContain('[x] a2');
    // blockers, parent unreadable, deleted child
    expect(text).toContain(PARENT);
    expect(text).toContain(UNREADABLE);
    expect(text).toMatch(/unreadable/);
    expect(text).toContain(DELETED);
    expect(text).toMatch(/deleted/);
    // `more` with its expand, notLoaded expands, and errors
    for (const expand of [...V2_TASK.omitted.map((o) => o.expand), ...V2_TASK.notLoaded.map((n) => n.expand)]) {
      expect(text).toContain(expand);
    }
    expect(text).toMatch(/errors:.*connections/s);
    expect(text).toContain('upstream_unavailable');
    // a truncated message row is marked
    expect(text).toMatch(/\[truncated\]|truncated/);
    expect(text).toContain(String(V2_TASK.asOfSeq));
  });

  it.fails('[c761 §10.9] the text brief says "errors: none" rather than omitting the line (S5)', async () => {
    reply = ok({ ...V2_TASK, errors: [] });
    const r = await drive(['entity', 'context', ENT]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/errors: none/);
  });
});
