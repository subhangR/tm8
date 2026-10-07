/**
 * `execution.gitCheckouts` / `execution.gitCheckoutDiff` — what a session
 * WITHOUT a tm8 worktree changed, read from the git checkouts it made itself.
 *
 * WHY THIS EXISTS. Measured on prod 2026-10-07: 8 of 13 live sessions had no
 * worktree, so the Changes rail refused all of them. Their agents clone into
 * their own scratch dir (`<dataDir>/scratch/<session>/w266/`), edit with shell
 * commands and COMMIT to a branch — one was 16 commits ahead, its last commit
 * two minutes old. The transcript's Edit/Write calls found 0–1 files for each.
 * The work was all there, in git, where nothing was looking.
 *
 * WHERE IT LOOKS (gate decision D8): only inside the session's own working
 * directory — its scratch dir, or for a project-mode session the project
 * checkout it was launched in — and at most two levels down. The request
 * names nothing but the session uuid; every path is derived from the
 * work_session row read under the caller's claims, `execution.transcript`'s
 * authorization story, private-credential gate included.
 *
 * READ-ONLY, ALL THE WAY DOWN (D2, A17). These checkouts belong to a running
 * agent. `--no-optional-locks` keeps `git status` from refreshing (and so
 * locking) the agent's index under it; `--no-ext-diff` / `--no-textconv` and
 * `core.fsmonitor=false` keep a repository's own config from choosing a
 * program for the server to run. No verb here writes.
 *
 * WHAT "CHANGED" MEANS: the working tree against the merge-base of HEAD and
 * the remote's default branch — committed and uncommitted work alike, which is
 * the question a reviewer asks of a branch. A checkout with no resolvable
 * upstream falls back to "uncommitted vs HEAD" and says so (`baseRef: null`).
 */
import { CollabError, type SessionCheckout, type SessionCheckoutDiff, type SessionCheckoutFile, type SessionCheckouts } from '@tm8/contract';
import { assertSafePathspec, runGit } from '@tm8/execution';

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type { Db } from '../../db/types.js';
import type { LoopbackOwner } from '../../identity/loopback.js';
import type { RequestContext } from '../../http/types.js';
import { claimsFor, requireUuidParam } from '../context.js';
import type { HandlerRegistry } from '../registry.js';

/** Checkouts reported per session. A scratch dir with more is a crawler. */
const CHECKOUTS_CAP = 12;
/** Changed files per checkout before the list is cut (the totals are not). */
const FILES_CAP = 400;
/** How far below the working directory a `.git` is looked for. */
const SCAN_DEPTH = 2;
/** Entries read per directory while scanning — a dataset dir is not a repo. */
const SCAN_ENTRIES_CAP = 400;
/** An untracked file is line-counted only below this size. */
const COUNT_BYTES_MAX = 512 * 1024;
const DIFF_BYTES_DEFAULT = 256 * 1024;
const DIFF_BYTES_MAX = 1024 * 1024;
const GIT_BYTES_MAX = 8 * 1024 * 1024;
/** Directories never descended into: dependency and build trees. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__']);

/** Every git call goes through here: read-only flags first, always. */
function git(args: readonly string[], cwd: string) {
  return runGit(
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
    { cwd, maxBufferBytes: GIT_BYTES_MAX, timeoutMs: 15_000 },
  ).catch(() => null);
}

interface SessionRow {
  workdir_path: string | null;
  workdir_mode: string | null;
  has_worktree: boolean;
  credential_allowed: boolean;
}

/** The directory this session's agent works in, or a named reason it has none. */
type Workdir =
  | { kind: 'ok'; root: string; shared: boolean }
  | { kind: 'none'; reason: SessionCheckouts['unavailableReason'] };

async function resolveWorkdir(
  db: Db,
  owner: LoopbackOwner,
  ctx: RequestContext,
  dataDir: string | undefined,
): Promise<{ sessionId: string; workdir: Workdir }> {
  const sessionId = requireUuidParam(ctx, 'workSessionId');
  const rows = await db.query<SessionRow>(
    claimsFor(owner, ctx),
    `select ws.workdir_path, ws.workdir_mode,
            exists (select 1 from public.edges ed
                     where ed.src_id = e.id and ed.type = 'in_worktree') as has_worktree,
            public.session_stream_credential_allowed(e.id) as credential_allowed
       from public.entities e
       join public.work_sessions ws on ws.entity_id = e.id
      where e.id = $1 and e.kind = 'work_session' and e.deleted_at is null`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) throw new CollabError('not_found', `no such work session: ${sessionId}`);
  if (!row.credential_allowed) {
    throw new CollabError('forbidden', 'this session runs on a private credential; only its owner may read it');
  }
  // A worktree session is the lane rail's business — two readers of one
  // checkout would be two answers to "what changed".
  if (row.has_worktree) return { sessionId, workdir: { kind: 'none', reason: 'has_worktree' } };
  if (row.workdir_mode === 'scratch') {
    // `workdir_path` is the pre-mint scratch ROOT for these (see the
    // transcript handler); the real cwd is derived from the session id.
    if (dataDir === undefined) return { sessionId, workdir: { kind: 'none', reason: 'node_has_no_data_dir' } };
    return { sessionId, workdir: { kind: 'ok', root: resolve(dataDir, 'scratch', sessionId), shared: false } };
  }
  if (row.workdir_path === null || row.workdir_path === '') {
    return { sessionId, workdir: { kind: 'none', reason: 'no_workdir' } };
  }
  // Project mode: the shared project checkout (D3) — everyone's changes, labelled.
  return { sessionId, workdir: { kind: 'ok', root: row.workdir_path, shared: true } };
}

/** `.git` (dir or worktree file) directly inside `dir`. */
async function isRepoRoot(dir: string): Promise<boolean> {
  return (await stat(join(dir, '.git')).catch(() => null)) !== null;
}

/** Repo roots at or below `root`, breadth-first, at most SCAN_DEPTH down. */
async function discover(root: string): Promise<{ dirs: string[]; truncated: boolean }> {
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= SCAN_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (await isRepoRoot(dir)) {
        found.push(dir);
        continue; // a repo's own subfolders are its content, not more repos
      }
      if (depth === SCAN_DEPTH) continue;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.slice(0, SCAN_ENTRIES_CAP)) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        next.push(join(dir, entry.name));
      }
    }
    level = next.sort();
  }
  return { dirs: found.slice(0, CHECKOUTS_CAP), truncated: found.length > CHECKOUTS_CAP };
}

/** A remote URL with any `user:token@` taken out — a URL is not a secret store. */
export function redactRemote(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1');
}

/** The remote's default branch as a ref this checkout can resolve, or null. */
async function upstreamBase(cwd: string): Promise<string | null> {
  const sym = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  const candidates: string[] = [];
  if (sym !== null && sym.code === 0 && sym.stdout.trim() !== '') {
    candidates.push(sym.stdout.trim().replace(/^refs\/remotes\//, ''));
  }
  candidates.push('origin/main', 'origin/master');
  for (const ref of candidates) {
    const ok = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (ok !== null && ok.code === 0) return ref;
  }
  return null;
}

/** `-z` porcelain v1 → path → XY; renames keep their destination. */
function parsePorcelainZ(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    out.set(token.slice(3), xy);
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the source rides in the next token
  }
  return out;
}

/** `diff --numstat -z` → path → counts (null = binary). Renames → destination. */
function parseNumstatZ(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
  const out = new Map<string, { additions: number | null; deletions: number | null }>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '') continue;
    const [a, d, path] = token.split('\t');
    const count = (v: string | undefined) => (v === undefined || v === '-' ? null : Number.parseInt(v, 10));
    let name = path ?? '';
    // A rename prints `a\td\t` then the source and destination as two tokens.
    if (name === '') {
      i += 2;
      name = tokens[i] ?? '';
    }
    if (name !== '') out.set(name, { additions: count(a), deletions: count(d) });
  }
  return out;
}

/** `diff --name-status -z` → path → A|M|D|R. */
function parseNameStatusZ(stdout: string): Map<string, SessionCheckoutFile['change']> {
  const out = new Map<string, SessionCheckoutFile['change']>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i]!;
    if (code === '') continue;
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const dest = tokens[i + 2] ?? '';
      i += 2;
      if (dest !== '') out.set(dest, letter === 'R' ? 'R' : 'A');
      continue;
    }
    const path = tokens[i + 1] ?? '';
    i += 1;
    if (path !== '') out.set(path, letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M');
  }
  return out;
}

/** Lines in a small text file — an untracked file's honest "+N". */
async function countLines(abs: string): Promise<number | null> {
  const st = await stat(abs).catch(() => null);
  if (st === null || !st.isFile() || st.size > COUNT_BYTES_MAX) return null;
  const buf = await readFile(abs).catch(() => null);
  if (buf === null || buf.includes(0)) return null;
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n += 1;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

async function readCheckout(root: string, dir: string, shared: boolean): Promise<SessionCheckout> {
  const name = relative(root, dir) || '.';
  const blank: SessionCheckout = {
    name,
    shared,
    readable: false,
    branch: null,
    remote: null,
    baseRef: null,
    mergeBaseOid: null,
    headOid: null,
    ahead: null,
    uncommitted: 0,
    lastCommitAt: null,
    files: [],
    filesTruncated: false,
    stat: { filesChanged: 0, additions: 0, deletions: 0 },
  };
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir);
  const headOid = head !== null && head.code === 0 ? head.stdout.trim() : null;

  const branchRun = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
  const branch = branchRun !== null && branchRun.code === 0 ? branchRun.stdout.trim() : null;
  const remoteRun = await git(['config', '--get', 'remote.origin.url'], dir);
  const remote = remoteRun !== null && remoteRun.code === 0 ? redactRemote(remoteRun.stdout.trim()) : null;

  const porcelainRun = await git(['status', '--porcelain=v1', '-z', '-uall'], dir);
  if (porcelainRun === null || porcelainRun.code !== 0) return { ...blank, branch, remote, headOid };
  const dirty = parsePorcelainZ(porcelainRun.stdout);

  const baseRef = headOid === null ? null : await upstreamBase(dir);
  let mergeBaseOid: string | null = null;
  let ahead: number | null = null;
  if (baseRef !== null) {
    const mb = await git(['merge-base', baseRef, 'HEAD'], dir);
    if (mb !== null && mb.code === 0) mergeBaseOid = mb.stdout.trim();
    const count = await git(['rev-list', '--count', `${baseRef}..HEAD`], dir);
    if (count !== null && count.code === 0) {
      const n = Number.parseInt(count.stdout.trim(), 10);
      ahead = Number.isInteger(n) ? n : null;
    }
  }
  let lastCommitAt: string | null = null;
  if (headOid !== null) {
    const log = await git(['log', '-1', '--format=%cI', 'HEAD'], dir);
    if (log !== null && log.code === 0 && log.stdout.trim() !== '') {
      lastCommitAt = new Date(log.stdout.trim()).toISOString();
    }
  }

  // Tracked changes: working tree vs the merge-base (or vs HEAD without one).
  const from = mergeBaseOid ?? headOid;
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const changes = new Map<string, SessionCheckoutFile['change']>();
  if (from !== null) {
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '-M', '-z', from];
    const ns = await git([...diffArgs.slice(0, 1), '--numstat', ...diffArgs.slice(1)], dir);
    if (ns !== null && ns.code === 0) for (const [p, c] of parseNumstatZ(ns.stdout)) counts.set(p, c);
    const st = await git([...diffArgs.slice(0, 1), '--name-status', ...diffArgs.slice(1)], dir);
    if (st !== null && st.code === 0) for (const [p, c] of parseNameStatusZ(st.stdout)) changes.set(p, c);
  }

  const files: SessionCheckoutFile[] = [];
  for (const [path, change] of changes) {
    const c = counts.get(path) ?? { additions: null, deletions: null };
    files.push({ path, change, additions: c.additions, deletions: c.deletions, uncommitted: dirty.has(path) });
  }
  for (const [path, xy] of dirty) {
    if (xy !== '??' || changes.has(path)) continue;
    files.push({
      path,
      change: '?',
      additions: await countLines(join(dir, path)),
      deletions: 0,
      uncommitted: true,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return {
    ...blank,
    readable: true,
    branch,
    remote,
    baseRef,
    mergeBaseOid,
    headOid,
    ahead,
    uncommitted: dirty.size,
    lastCommitAt,
    files: files.slice(0, FILES_CAP),
    filesTruncated: files.length > FILES_CAP,
    stat: { filesChanged: files.length, additions, deletions },
  };
}

export interface SessionCheckoutDeps {
  db: Db;
  resolveOwner: () => Promise<LoopbackOwner>;
  dataDir?: string;
}

/**
 * The two handlers, unregistered. `execution-handlers.ts` registers them with
 * literal `registry.register` calls, because the conformance inventory reads
 * that file's registrations from source.
 */
export function sessionCheckoutHandlers(deps: SessionCheckoutDeps): {
  gitCheckouts: (ctx: RequestContext) => Promise<SessionCheckouts>;
  gitCheckoutDiff: (ctx: RequestContext) => Promise<SessionCheckoutDiff>;
} {
  const gitCheckouts = async (ctx: RequestContext): Promise<SessionCheckouts> => {
    const owner = await deps.resolveOwner();
    const { sessionId, workdir } = await resolveWorkdir(deps.db, owner, ctx, deps.dataDir);
    const checkedAt = new Date().toISOString();
    if (workdir.kind === 'none') {
      return { sessionId, available: false, unavailableReason: workdir.reason, checkouts: [], checkoutsTruncated: false, checkedAt };
    }
    const rootReal = await realpath(workdir.root).catch(() => null);
    if (rootReal === null) {
      return { sessionId, available: false, unavailableReason: 'workdir_missing', checkouts: [], checkoutsTruncated: false, checkedAt };
    }
    const { dirs, truncated } = await discover(rootReal);
    // In parallel: at most CHECKOUTS_CAP readers, each a handful of read-only git calls.
    const checkouts = await Promise.all(dirs.map((dir) => readCheckout(rootReal, dir, workdir.shared)));
    // Most recently committed first: the checkout an agent is working in now
    // is the one a reviewer opened the tab for.
    checkouts.sort((a, b) => (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? ''));
    return { sessionId, available: true, unavailableReason: null, checkouts, checkoutsTruncated: truncated, checkedAt };
  };

  const gitCheckoutDiff = async (ctx: RequestContext): Promise<SessionCheckoutDiff> => {
    const owner = await deps.resolveOwner();
    const { sessionId, workdir } = await resolveWorkdir(deps.db, owner, ctx, deps.dataDir);
    const checkoutName = ctx.query.get('checkout') ?? '';
    const path = ctx.query.get('path') ?? '';
    if (checkoutName === '' || path === '') {
      throw new CollabError('invalid_input', 'checkout and path are both required');
    }
    try {
      assertSafePathspec(path);
    } catch {
      throw new CollabError('invalid_input', `unsafe path: ${path}`);
    }
    const rawMax = ctx.query.get('maxBytes');
    let maxBytes = DIFF_BYTES_DEFAULT;
    if (rawMax !== null && rawMax !== '') {
      const parsed = Number.parseInt(rawMax, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CollabError('invalid_input', `maxBytes must be a positive integer, got ${rawMax}`);
      }
      maxBytes = Math.min(parsed, DIFF_BYTES_MAX);
    }
    if (workdir.kind === 'none') {
      throw new CollabError('conflict', `session has no readable working directory (${workdir.reason})`);
    }
    const rootReal = await realpath(workdir.root).catch(() => null);
    if (rootReal === null) throw new CollabError('not_found', 'the session working directory is gone');

    // MEMBERSHIP, NOT CONSTRUCTION: the checkout must be one discovery found,
    // and the path one its listing reported. A name the listing never offered
    // — `../other-session`, an ignored `.env` — is refused before any read.
    const { dirs } = await discover(rootReal);
    const dir = dirs.find((d) => (relative(rootReal, d) || '.') === checkoutName);
    if (dir === undefined) throw new CollabError('not_found', `no such checkout in this session: ${checkoutName}`);
    const checkout = await readCheckout(rootReal, dir, workdir.shared);
    const file = checkout.files.find((f) => f.path === path);
    if (file === undefined) throw new CollabError('not_found', `${path} has no change in ${checkoutName}`);

    let diffText = '';
    if (file.change === '?') {
      const abs = resolve(dir, path);
      const real = await realpath(abs).catch(() => null);
      const dirReal = await realpath(dir).catch(() => null);
      if (real === null || dirReal === null || !(real === dirReal || real.startsWith(dirReal + sep))) {
        throw new CollabError('invalid_input', 'path resolves outside the checkout');
      }
      // `--no-index` exits 1 when the files differ — that is the answer, not a failure.
      const run = await git(
        ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', relative(dirReal, real)],
        dirReal,
      );
      diffText = run?.stdout ?? '';
    } else {
      const from = checkout.mergeBaseOid ?? checkout.headOid;
      if (from !== null) {
        const run = await git(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '-M', from, '--', path], dir);
        diffText = run !== null && run.code === 0 ? run.stdout : '';
      }
    }
    const truncated = Buffer.byteLength(diffText, 'utf8') > maxBytes;
    return {
      sessionId,
      checkout: checkoutName,
      path,
      change: file.change,
      additions: file.additions,
      deletions: file.deletions,
      baseRef: checkout.baseRef,
      diff: truncated ? Buffer.from(diffText, 'utf8').subarray(0, maxBytes).toString('utf8') : diffText,
      diffTruncated: truncated,
      checkedAt: new Date().toISOString(),
    };
  };

  return { gitCheckouts, gitCheckoutDiff };
}

/** Registers both — for tests and any caller outside `execution-handlers.ts`. */
export function registerSessionCheckoutHandlers(registry: HandlerRegistry, deps: SessionCheckoutDeps): void {
  const h = sessionCheckoutHandlers(deps);
  registry.register('execution.gitCheckouts', h.gitCheckouts);
  registry.register('execution.gitCheckoutDiff', h.gitCheckoutDiff);
}
