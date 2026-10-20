import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SessionLookup } from '../../src/ops/disk-inventory.js';
import { DAY } from '../../src/ops/disk-retention.js';
import { createDiskGuardJob, type DiskAlert } from '../../src/scheduler/jobs/disk-guard.js';
import type { JobContext } from '../../src/scheduler/types.js';

// The `ops.disk-guard` job against a real tree: real git repos with a real
// remote, real worktrees, and real mtimes. Nothing outside the temp root.

const NOW = Date.now();
const ENDED_ID = '01a10000-0000-7000-8000-000000000001';
const DIRTY_ID = '01a10000-0000-7000-8000-000000000002';
const LIVE_ID = '01a10000-0000-7000-8000-000000000003';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, stdio: 'pipe' }).toString();

let root: string;
let data: string;
let repo: string;

function age(path: string, ms: number): void {
  const at = new Date(NOW - ms);
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) for (const c of readdirSync(p)) walk(join(p, c));
    utimesSync(p, at, at);
  };
  walk(path);
}

function worktree(path: string, branch: string, opts: { push?: boolean; dirty?: boolean } = {}): string {
  mkdirSync(join(path, '..'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', branch, path);
  writeFileSync(join(path, `${branch}.txt`), branch);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', branch);
  if (opts.push) git(path, 'push', '-q', 'origin', branch);
  if (opts.dirty) writeFileSync(join(path, 'uncommitted.txt'), 'wip');
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'disk-guard-'));
  data = join(root, 'data');
  const origin = join(root, 'origin.git');
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'pipe' });
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'HEAD');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function lookup(byPath: Record<string, 'live' | 'ended'>): () => Promise<SessionLookup> {
  const ids: Record<string, 'live' | 'ended'> = { [ENDED_ID]: 'ended', [DIRTY_ID]: 'ended', [LIVE_ID]: 'live' };
  const fact = (s: 'live' | 'ended' | undefined) => s === 'ended' ? { state: 'ended' as const, endedAt: NOW - 2 * DAY }
    : s === 'live' ? { state: 'live' as const, endedAt: null } : { state: 'unknown' as const, endedAt: null };
  return async () => ({ find: ({ id, workdirPath }) => fact((id && ids[id]) || (workdirPath ? byPath[workdirPath] : undefined)) });
}

function ctx(): JobContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { name: 'ops.disk-guard', firedAt: new Date(NOW), logger: logger as unknown as JobContext['logger'], signal: new AbortController().signal };
}

function fixture() {
  const pushed = worktree(join(data, 'worktrees', 'proj', 'pushed'), 'pushed', { push: true });
  const unpushed = worktree(join(data, 'worktrees', 'proj', 'unpushed'), 'unpushed');
  const live = worktree(join(data, 'worktrees', 'proj', 'live'), 'live', { push: true });
  const endedScratch = join(data, 'scratch', ENDED_ID);
  worktree(join(endedScratch, 'wt'), 'scratch-ended', { push: true });
  mkdirSync(join(endedScratch, 'wt', 'node_modules', 'x'), { recursive: true });
  const dirtyScratch = join(data, 'scratch', DIRTY_ID);
  worktree(join(dirtyScratch, 'wt'), 'scratch-dirty', { push: true, dirty: true });
  mkdirSync(join(dirtyScratch, 'wt', 'node_modules', 'x'), { recursive: true });
  const liveScratch = join(data, 'scratch', LIVE_ID);
  worktree(join(liveScratch, 'wt'), 'scratch-live', { push: true });
  const vitest = join(data, 'tmp', 'Z_ZDbI0uPtlv-n_CnSuaD');
  mkdirSync(join(vitest, 'client'), { recursive: true });
  mkdirSync(join(vitest, 'ssr'));
  age(data, 3 * DAY);
  return { pushed, unpushed, live, endedScratch, dirtyScratch, liveScratch, vitest };
}

it('removes what is over and pushed, flags unpushed work once, and keeps live sessions', async () => {
  const f = fixture();
  const alerts: DiskAlert[] = [];
  const job = createDiskGuardJob({
    layout: { dataDir: data, deployRoot: null, home: null, systemTmp: null },
    mode: 'apply',
    sessions: lookup({ [f.pushed]: 'ended', [f.unpushed]: 'ended', [f.live]: 'live' }),
    alert: async (a) => { alerts.push(a); },
    usage: async () => 80,
  });
  const outcome = await job.run(ctx());

  expect(existsSync(f.pushed)).toBe(false);
  expect(existsSync(f.endedScratch)).toBe(false);
  expect(existsSync(f.vitest)).toBe(false);
  expect(existsSync(f.unpushed)).toBe(true);
  expect(existsSync(f.live)).toBe(true);
  expect(existsSync(join(f.dirtyScratch, 'wt', 'uncommitted.txt'))).toBe(true);
  expect(existsSync(join(f.dirtyScratch, 'wt', 'node_modules'))).toBe(false); // ignored, regenerable
  expect(existsSync(f.liveScratch)).toBe(true);
  // Removed through git: no worktree metadata outlives a checkout.
  const listed = git(repo, 'worktree', 'list', '--porcelain');
  expect(listed).not.toContain(f.pushed);
  expect(listed).not.toContain(join(f.endedScratch, 'wt'));
  // The branch of removed work is still in the repository.
  expect(git(repo, 'branch', '--list', 'pushed')).toContain('pushed');

  const detail = outcome?.detail as { flagged: Array<{ path: string; reason: string }>; errors: unknown[] };
  expect(detail.errors).toEqual([]);
  expect(detail.flagged.map((x) => x.path).sort()).toEqual([f.unpushed, join(f.dirtyScratch, 'wt')].sort());
  expect(alerts).toHaveLength(1);
  expect(alerts[0]!.text).toContain('1 commit on no remote');
  expect(alerts[0]!.text).toContain('uncommitted changes');

  // A second run does not re-send the same flags.
  await job.run(ctx());
  expect(alerts).toHaveLength(1);
});

it('report mode plans the same sweep and deletes nothing', async () => {
  const f = fixture();
  const job = createDiskGuardJob({
    layout: { dataDir: data, deployRoot: null, home: null, systemTmp: null },
    mode: 'report',
    sessions: lookup({ [f.pushed]: 'ended', [f.unpushed]: 'ended', [f.live]: 'live' }),
    usage: async () => 50,
  });
  const outcome = await job.run(ctx());
  // pushed worktree, ended scratch dir, Vitest dump, and the dirty scratch's ignored node_modules.
  expect(outcome).toMatchObject({ affected: 0, detail: { mode: 'report', planned: 4 } });
  expect(existsSync(f.pushed)).toBe(true);
  expect(existsSync(f.endedScratch)).toBe(true);
  expect(existsSync(f.vitest)).toBe(true);
});

it('alerts the owner at 85%, escalates at 92%, and reports recovery', async () => {
  mkdirSync(data, { recursive: true });
  let used = 86;
  const alerts: DiskAlert[] = [];
  const job = createDiskGuardJob({
    layout: { dataDir: data, deployRoot: null, home: null, systemTmp: null },
    mode: 'apply', sessions: lookup({}), usage: async () => used, alert: async (a) => { alerts.push(a); },
  });
  await job.run(ctx());
  await job.run(ctx());
  used = 95; await job.run(ctx());
  used = 70; await job.run(ctx());
  expect(alerts.map((a) => a.level)).toEqual(['warn', 'critical', 'ok']);
  expect(alerts[0]!.text).toMatch(/^Disk 86% used on .* \(warn; alert at 85%, critical at 92%\)/);
});

it('keeps a scratch checkout whose remote is missing, rather than guessing it is pushed', async () => {
  const scratch = join(data, 'scratch', ENDED_ID);
  mkdirSync(scratch, { recursive: true });
  const clone = join(scratch, 'standalone');
  execFileSync('git', ['init', '-q', clone]);
  writeFileSync(join(clone, 'a.txt'), 'a');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'local only');
  age(data, 3 * DAY);
  const job = createDiskGuardJob({
    layout: { dataDir: data, deployRoot: null, home: null, systemTmp: null },
    mode: 'apply', sessions: lookup({}), usage: async () => 10,
  });
  const outcome = await job.run(ctx());
  expect(existsSync(join(clone, 'a.txt'))).toBe(true);
  expect((outcome?.detail as { flagged: Array<{ reason: string }> }).flagged[0]!.reason)
    .toBe('could not prove the work is pushed: no remote configured');
});

it('treats a write deep inside the managed TMPDIR as activity', async () => {
  const deep = join(data, 'tmp', 'claude-110', 'project', 'session', 'tasks');
  mkdirSync(deep, { recursive: true });
  age(data, 5 * DAY);
  writeFileSync(join(deep, 'task.output'), 'still running');
  const stale = join(data, 'tmp', 'old-build');
  mkdirSync(join(stale, 'out'), { recursive: true });
  age(stale, 5 * DAY);
  const job = createDiskGuardJob({
    layout: { dataDir: data, deployRoot: null, home: null, systemTmp: null },
    mode: 'apply', sessions: lookup({}), usage: async () => 10,
  });
  await job.run(ctx());
  expect(existsSync(join(deep, 'task.output'))).toBe(true);
  expect(existsSync(stale)).toBe(false);
});
