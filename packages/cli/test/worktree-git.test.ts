/**
 * `tm8 session checkpoint|rollback` + `tm8 worktree stage|commit|merge` — the
 * Tier 2 mutating git verbs, driven through the SAME funnel session.test.ts
 * uses (real parseInvocation, real resolveContext, real Output, real exit-code
 * funnel; only the registry lookup substituted).
 *
 * TWO REAL THINGS AT ONCE, BY DESIGN. The graph side is a routing stub Server
 * (entities.get / edges.list / messages.post / attentionRequests.create
 * answered from fixtures, every request recorded) — but the GIT side is a real
 * repository with a real `git worktree add` checkout in a temp directory,
 * because the claims under test ("a conflict aborts and the worktree is
 * verifiably clean", "rollback refuses to delete untracked files") are about
 * what real git leaves on disk, and a mocked git would measure the mock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGit } from '@tm8/execution/worktree';

import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { createOutput } from '../src/output.js';
import { isCommandPath } from '../src/discovery/operations.js';
import type { CommandModule } from '../src/run.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function gitCommands(): Promise<CommandModule[]> {
  const session = (await import('../src/commands/session-git.js')).SESSION_GIT_COMMANDS;
  const worktree = (await import('../src/commands/worktree-git.js')).WORKTREE_GIT_COMMANDS;
  return [...session, ...worktree];
}

const SESSION = '33333333-3333-7333-8333-333333333333';
const WORKTREE = '44444444-4444-7444-8444-444444444444';
const TASK = '55555555-5555-7555-8555-555555555555';

// ── the routing stub Server ─────────────────────────────────────────────────

interface Seen { method: string; pathname: string; query: URLSearchParams; body: unknown }

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
/** The worktree detail row the stub serves — path is set per test group. */
let worktreeContent: Record<string, unknown> = {};
/** in_worktree edges the stub serves, filtered by source/destination. */
let edges: Array<{ source: { id: string; kind: string }; target: { id: string; kind: string } }> = [];

function respond(pathname: string, query: URLSearchParams): unknown {
  if (pathname.includes('attention')) return { request: { id: 'att_1', status: 'open' }, affectedCount: 1 };
  if (pathname.includes('message')) return { messages: [{ id: 'msg_1' }] };
  if (pathname.includes('edge')) {
    const source = query.get('source');
    const destination = query.get('destination');
    const items = edges
      .filter((e) => (source ? e.source.id === source : true))
      .filter((e) => (destination ? e.target.id === destination : true))
      .map((e, i) => ({ id: `edge_${i}`, type: 'in_worktree', source: e.source, target: e.target }));
    return { items, nextCursor: null };
  }
  if (pathname.includes(SESSION)) return { id: SESSION, kind: 'work_session', content: { kind: 'work_session' } };
  if (pathname.includes(WORKTREE)) return { id: WORKTREE, kind: 'worktree', content: worktreeContent };
  return {};
}

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
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ data: respond(url.pathname, url.searchParams), requestId: 'req_t' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no stub port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

// ── the real git side ───────────────────────────────────────────────────────

let base: string;
let repoRoot: string;
let wt: string;
let counter = 0;

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-cli-git-verbs-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  counter += 1;
  seen = [];
  repoRoot = join(base, `repo-${counter}`);
  wt = join(base, `wt-${counter}`);
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'shared.txt'), 'line-1\nline-2\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
  await git(['worktree', 'add', '-b', 'tm8/session', wt, 'HEAD'], repoRoot);
  worktreeContent = {
    kind: 'worktree', projectId: 'p', path: wt, branch: 'tm8/session',
    baseRef: 'main', baseCommitOid: 'a'.repeat(40), status: 'active', statusChangedAt: null,
  };
  edges = [
    { source: { id: SESSION, kind: 'work_session' }, target: { id: WORKTREE, kind: 'worktree' } },
    { source: { id: TASK, kind: 'task' }, target: { id: WORKTREE, kind: 'worktree' } },
  ];
});

// ── drive(): session.test.ts's funnel, verbatim in shape ────────────────────

interface DriveResult { code: number; stdout: string; stderr: string }

async function drive(argv: readonly string[]): Promise<DriveResult> {
  const modules = await gitCommands();
  const out: string[] = [];
  const err: string[] = [];
  const streams = {
    stdout: (chunk: string | Uint8Array) =>
      void out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')),
    stderr: (chunk: string) => void err.push(chunk),
  };
  let output = createOutput({ format: 'human', streams });
  try {
    const invocation = parseInvocation(argv);
    output = createOutput({
      format: invocation.globals.format,
      color: invocation.globals.color,
      quiet: invocation.globals.quiet,
      streams,
    });
    const registered = new Map(modules.map((m) => [m.path.join(' '), m]));
    const match = splitCommandPath(invocation.positionals, (p) => registered.has(p.join(' ')));
    if (!match) throw new Error(`no tier-2 command matched: ${invocation.positionals.join(' ')}`);
    const command = registered.get(match.path.join(' '))!;
    const ctx = resolveContext({
      globals: invocation.globals,
      session: sessionContextFromEnv({ TM8_BASE_URL: baseUrl }),
      config: loadLocalConfig({}, {
        readFile: () => {
          throw new Error('no config in a tier-2 test');
        },
      }),
    });
    const code = await command.run({
      path: match.path,
      args: match.args,
      options: invocation.options,
      passthrough: invocation.passthrough,
      ctx,
      out: output,
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } catch (error) {
    output.error(errorLines(error));
    return { code: exitCodeFor(error), stdout: out.join(''), stderr: err.join('') };
  }
}

const posts = (needle: string) => seen.filter((s) => s.method === 'POST' && s.pathname.includes(needle));

// ── registration ────────────────────────────────────────────────────────────

describe('registration', () => {
  it('registers exactly the five tier-2 paths, all present in the frozen projection', async () => {
    const paths = (await gitCommands()).map((m) => m.path.join(' ')).sort();
    expect(paths).toEqual(['session checkpoint', 'session rollback', 'worktree commit', 'worktree merge', 'worktree stage']);
    for (const m of await gitCommands()) expect(isCommandPath(m.path), m.path.join(' ')).toBe(true);
    // PROBE-RED: isCommandPath can say no.
    expect(isCommandPath(['worktree', 'obliterate'])).toBe(false);
  });
});

// ── checkpoint / rollback ───────────────────────────────────────────────────

describe('session checkpoint and rollback', () => {
  it('checkpoint commits WIP on the branch, prints the ref, posts the receipt on the session', async () => {
    await writeFile(join(wt, 'wip.txt'), 'work in progress\n');
    const res = await drive(['session', 'checkpoint', SESSION]);
    expect(res.code, res.stderr).toBe(0);
    const oid = await git(['rev-parse', 'tm8/session'], wt);
    expect(res.stdout).toContain(oid);
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    // The durable receipt went to the SESSION anchor.
    const receipts = posts('message');
    expect(receipts).toHaveLength(1);
    expect((receipts[0]?.body as { anchorIds?: string[] }).anchorIds).toEqual([SESSION]);
    expect((receipts[0]?.body as { body?: string }).body).toContain(oid);
  });

  it('a clean tree checkpoints as created:false and posts NOTHING', async () => {
    const res = await drive(['session', 'checkpoint', SESSION]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('clean');
    expect(posts('message')).toHaveLength(0);
  });

  it('rollback restores the checkpoint; untracked files refuse without --force and die with it', async () => {
    await writeFile(join(wt, 'a.txt'), 'v1\n');
    await drive(['session', 'checkpoint', SESSION, '--message', 'tm8 checkpoint v1']);
    const cp = await git(['rev-parse', 'tm8/session'], wt);
    await writeFile(join(wt, 'a.txt'), 'v2\n');
    await drive(['session', 'checkpoint', SESSION, '--message', 'tm8 checkpoint v2']);

    // An untracked file appears AFTER the last checkpoint.
    await writeFile(join(wt, 'precious.txt'), 'never committed\n');
    const refused = await drive(['session', 'rollback', SESSION, '--to', cp]);
    expect(refused.code).toBe(6);
    expect(refused.stderr).toContain('untracked');
    expect(await readFile(join(wt, 'precious.txt'), 'utf8')).toBe('never committed\n');

    const forced = await drive(['session', 'rollback', SESSION, '--to', cp, '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(cp);
  });

  it('a worktree id is accepted directly, and a missing --to is usage', async () => {
    await writeFile(join(wt, 'wip.txt'), 'x\n');
    const res = await drive(['session', 'checkpoint', WORKTREE]);
    expect(res.code, res.stderr).toBe(0);
    expect((await drive(['session', 'rollback', WORKTREE])).code).toBe(2);
  });

  it('a graph path that does not exist on this host refuses with worktree_not_local', async () => {
    worktreeContent = { ...worktreeContent, path: join(base, 'not-on-this-host') };
    const res = await drive(['session', 'checkpoint', SESSION]);
    expect(res.code).toBe(5);
    expect(res.stderr).toContain('worktree_not_local');
  });

  it('a non-active worktree is refused before any git runs', async () => {
    worktreeContent = { ...worktreeContent, status: 'merged' };
    const res = await drive(['session', 'checkpoint', SESSION]);
    expect(res.code).toBe(6);
    expect(res.stderr).toContain('merged');
  });
});

// ── the commit rail ─────────────────────────────────────────────────────────

describe('worktree stage and commit', () => {
  it('stage with no pathspecs LISTS and stages nothing; with pathspecs it stages', async () => {
    await writeFile(join(wt, 'one.txt'), '1\n');
    await writeFile(join(wt, 'two.txt'), '2\n');
    const listed = await drive(['worktree', 'stage', SESSION]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('one.txt');
    expect(listed.stdout).toContain('two.txt');
    expect(await git(['diff', '--cached', '--name-only'], wt)).toBe('');

    const staged = await drive(['worktree', 'stage', SESSION, 'one.txt']);
    expect(staged.code, staged.stderr).toBe(0);
    expect(await git(['diff', '--cached', '--name-only'], wt)).toBe('one.txt');
  });

  it('commit writes exactly the index with a receipt; an empty index refuses', async () => {
    const empty = await drive(['worktree', 'commit', SESSION, '--message', 'rail: nothing']);
    expect(empty.code).toBe(6);
    expect(empty.stderr).toContain('nothing_staged');

    await writeFile(join(wt, 'one.txt'), '1\n');
    await drive(['worktree', 'stage', SESSION, 'one.txt']);
    const done = await drive(['worktree', 'commit', SESSION, '--message', 'rail: one']);
    expect(done.code, done.stderr).toBe(0);
    expect(await git(['log', '-1', '--pretty=%s'], wt)).toBe('rail: one');
    expect(posts('message').length).toBeGreaterThan(0);
  });

  it('hostile pathspecs are refused locally as usage errors', async () => {
    for (const evil of ['-rf', '/etc/passwd', '../outside.txt']) {
      const res = await drive(['worktree', 'stage', SESSION, evil]);
      expect(res.code, evil).toBe(2);
    }
  });
});

// ── merge with conflict surfacing ───────────────────────────────────────────

describe('worktree merge', () => {
  it('merges a clean ref and posts a receipt', async () => {
    await writeFile(join(repoRoot, 'main-only.txt'), 'from main\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main advances'], repoRoot);
    const res = await drive(['worktree', 'merge', SESSION, '--from', 'main']);
    expect(res.code, res.stderr).toBe(0);
    expect(await readFile(join(wt, 'main-only.txt'), 'utf8')).toBe('from main\n');
    expect(posts('message')).toHaveLength(1);
  });

  it('a REAL conflict: exit 6, durable message on the owning TASK naming the paths, attention raised, worktree clean', async () => {
    // Diverge the same line on both sides.
    await writeFile(join(repoRoot, 'shared.txt'), 'line-1 MAIN\nline-2\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main moves'], repoRoot);
    await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION\nline-2\n');
    await drive(['session', 'checkpoint', SESSION, '--message', 'tm8 checkpoint session edit']);
    seen = [];
    const headBefore = await git(['rev-parse', 'HEAD'], wt);

    const res = await drive(['worktree', 'merge', SESSION, '--from', 'main']);
    expect(res.code).toBe(6);

    // Durable message: on the TASK (the in_worktree task edge wins), naming the path.
    const receipts = posts('message');
    expect(receipts).toHaveLength(1);
    const receiptBody = receipts[0]?.body as { anchorIds?: string[]; body?: string };
    expect(receiptBody.anchorIds).toEqual([TASK]);
    expect(receiptBody.body).toContain('shared.txt');
    expect(receiptBody.body).toContain('ABORTED');

    // Attention: raised on the same anchor.
    const attention = posts('attention');
    expect(attention).toHaveLength(1);
    expect(attention[0]?.pathname).toContain(TASK);
    expect((attention[0]?.body as { reason?: string }).reason).toContain('merge conflict');

    // The worktree: clean, HEAD unmoved, no merge state, no markers.
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(headBefore);
    expect((await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt })).code).not.toBe(0);
    expect(await readFile(join(wt, 'shared.txt'), 'utf8')).not.toContain('<<<<<<<');
  });

  it('with no task edge the conflict is surfaced on the SESSION — never nowhere', async () => {
    edges = [{ source: { id: SESSION, kind: 'work_session' }, target: { id: WORKTREE, kind: 'worktree' } }];
    await writeFile(join(repoRoot, 'shared.txt'), 'line-1 MAIN\nline-2\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main moves'], repoRoot);
    await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION\nline-2\n');
    await drive(['session', 'checkpoint', SESSION, '--message', 'cp']);
    seen = [];

    const res = await drive(['worktree', 'merge', SESSION, '--from', 'main']);
    expect(res.code).toBe(6);
    expect((posts('message')[0]?.body as { anchorIds?: string[] }).anchorIds).toEqual([SESSION]);
    expect(posts('attention')[0]?.pathname).toContain(SESSION);
  });

  it('a dirty worktree refuses before merging, and --from is required', async () => {
    await writeFile(join(wt, 'shared.txt'), 'uncommitted\n');
    const res = await drive(['worktree', 'merge', SESSION, '--from', 'main']);
    expect(res.code).toBe(6);
    expect(res.stderr).toContain('dirty_worktree');
    expect((await drive(['worktree', 'merge', SESSION])).code).toBe(2);
  });
});
