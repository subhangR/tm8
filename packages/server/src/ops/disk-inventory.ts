/**
 * The I/O half of disk retention: read what is on disk, probe git, and delete
 * what `disk-retention.ts` planned. Every read failure narrows the sweep (an
 * entry that cannot be read is not a candidate) and never widens it.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  POINTER_FILE, pinnedPaths, type CheckoutFacts, type InventoryEntry, type RetentionRule,
  type ScratchChild, type SessionState,
} from './disk-retention.js';

const run = promisify(execFile);

/** Newest mtime among an entry and up to `budget` descendants, `depth` levels down. */
async function newestMtime(path: string, depth: number, budget: { left: number }): Promise<number> {
  const self = await lstat(path).catch(() => null);
  if (!self) return 0;
  let newest = self.mtimeMs;
  if (!self.isDirectory() || depth <= 0) return newest;
  const children = await readdir(path).catch(() => [] as string[]);
  for (const child of children) {
    if (budget.left-- <= 0) break;
    newest = Math.max(newest, await newestMtime(join(path, child), depth - 1, budget));
  }
  return newest;
}

/**
 * Entries of `dir`, symlinks excluded (never followed, never candidates).
 * `depth` is how far down a write still counts as activity: a session's temp
 * tree is written several levels deep (`claude-<uid>/<project>/<session>/tasks/*`).
 */
export async function readEntries(dir: string, depth = 2): Promise<InventoryEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: InventoryEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    const isDir = st.isDirectory();
    out.push({
      path, name, isDir,
      mtimeMs: isDir ? await newestMtime(path, depth, { left: depth > 2 ? 5000 : 400 }) : st.mtimeMs,
      ...(isDir ? { children: await readdir(path).catch(() => [] as string[]) } : {}),
    });
  }
  return out;
}

/** `du -sxb`, bounded in time. `undefined` = not measured, which no rule reads as small. */
export async function measureBytes(path: string, timeoutMs = 120_000): Promise<number | undefined> {
  try {
    const { stdout } = await run('du', ['-sxb', path], { timeout: timeoutMs });
    const bytes = Number(stdout.split(/\s/)[0]);
    return Number.isFinite(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Paths named by `LAST_*` / `*_TREE` pointer files in the rule dirs. */
export async function readPinned(rules: readonly RetentionRule[]): Promise<Set<string>> {
  const dirs = new Set(rules.flatMap((r) => (r.kind === 'size_cap' ? [] : [r.dir])));
  const pinned = new Set<string>();
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!POINTER_FILE.test(name)) continue;
      const text = await readFile(join(dir, name), 'utf8').catch(() => '');
      for (const path of pinnedPaths(text.slice(0, 4096))) pinned.add(path);
    }
  }
  return pinned;
}

/** cwd of every process this user can read. Linux `/proc`; elsewhere empty (and the sweep is narrower for it). */
export async function liveCwds(): Promise<string[]> {
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((p) => /^\d+$/.test(p));
  const cwds = await Promise.all(pids.map((pid) => readlink(`/proc/${pid}/cwd`).catch(() => null)));
  return cwds.filter((c): c is string => !!c && c !== '/');
}

/** `GIT_OPTIONAL_LOCKS=0`: a probe never takes the index lock out from under a session's own git. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: GIT_ENV });
  return stdout;
}

export type CheckoutKind = 'worktree' | 'clone';

/** `.git` file → linked worktree; `.git` dir → clone; neither → not a checkout. */
export async function checkoutKind(path: string): Promise<CheckoutKind | null> {
  const st = await lstat(join(path, '.git')).catch(() => null);
  if (!st) return null;
  return st.isDirectory() ? 'clone' : st.isFile() ? 'worktree' : null;
}

export interface SessionLookup {
  /** By session id (a scratch dir's name) or by recorded workdir path. */
  find(key: { id?: string; workdirPath?: string }): { state: SessionState; endedAt: number | null };
  /** Set when sessions could not be read: every one is then `unknown`, the slowest case. */
  error?: string;
}

export async function probeCheckout(path: string, session: { state: SessionState; endedAt: number | null }, now: number):
  Promise<CheckoutFacts> {
  const base = {
    path, session: session.state,
    endedForMs: session.endedAt === null ? null : now - session.endedAt,
    idleMs: now - await newestMtime(path, 3, { left: 2000 }),
  };
  try {
    const dirty = (await git(path, ['status', '--porcelain'])).trim().length > 0;
    const remotes = (await git(path, ['remote'])).trim();
    if (!remotes) return { ...base, dirty, unpushed: 0, probeFailed: 'no remote configured' };
    const unpushed = Number((await git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim()) || 0;
    return { ...base, dirty, unpushed };
  } catch (error) {
    return { ...base, dirty: false, unpushed: 0, probeFailed: error instanceof Error ? error.message.split('\n')[0]! : String(error) };
  }
}

const REGENERABLE = new Set(['node_modules', 'dist', '.vite', 'coverage', '.turbo']);

/** Top-level children of a scratch dir, classified. Checkouts are probed by the caller. */
export async function scratchChildren(dir: string): Promise<Array<ScratchChild & { checkout?: CheckoutKind }>> {
  const out: Array<ScratchChild & { checkout?: CheckoutKind }> = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) { out.push({ path, kind: 'symlink' }); continue; }
    if (st.isDirectory()) {
      const kind = await checkoutKind(path);
      if (kind) { out.push({ path, kind: 'checkout', checkout: kind }); continue; }
      if (REGENERABLE.has(name)) { out.push({ path, kind: 'regenerable' }); continue; }
    }
    out.push({ path, kind: 'other' });
  }
  return out;
}

/**
 * `node_modules` and friends inside a checkout that git IGNORES. A tracked
 * `dist/` is work, and removing it would make a clean tree dirty.
 */
export async function ignoredRegenerable(checkout: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name === '.git') continue;
      const path = join(dir, name);
      const st = await lstat(path).catch(() => null);
      if (!st?.isDirectory()) continue;
      if (REGENERABLE.has(name)) { found.push(path); continue; }
      if (depth > 0) await walk(path, depth - 1);
    }
  };
  await walk(checkout, 2);
  const ignored: string[] = [];
  for (const path of found) {
    const ok = await run('git', ['-C', checkout, 'check-ignore', '-q', path.slice(checkout.length + 1)], { timeout: 30_000, env: GIT_ENV })
      .then(() => true, () => false);
    if (ok) ignored.push(path);
  }
  return ignored;
}

/**
 * Remove one planned path. A linked worktree goes through `git worktree remove`
 * WITHOUT `--force` (git refuses a dirty tree: a last check after the plan),
 * then `prune`, so `.git/worktrees` metadata never outlives the checkout.
 */
export async function removePath(path: string): Promise<void> {
  const kind = await checkoutKind(path);
  if (kind === 'worktree') {
    const common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const repo = basename(common) === '.git' ? dirname(common) : common;
    await git(repo, ['worktree', 'remove', path]);
    await git(repo, ['worktree', 'prune']).catch(() => undefined);
    return;
  }
  if (kind === 'clone') {
    // Same last-moment guard as `worktree remove` gives a linked worktree.
    if ((await git(path, ['status', '--porcelain'])).trim()) throw new Error(`clone became dirty: ${path}`);
  } else if (!kind) {
    // A dir holding linked worktrees (a scratch dir): each goes through git
    // first, so a tree that turned dirty since the plan stops the whole removal.
    for (const inner of await linkedWorktreesUnder(path, 3)) await removePath(inner);
  }
  await rm(path, { recursive: true, force: true });
}

async function linkedWorktreesUnder(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    const kind = await checkoutKind(path);
    if (kind === 'worktree') out.push(path);
    else if (!kind && depth > 0) out.push(...await linkedWorktreesUnder(path, depth - 1));
  }
  return out;
}
