// @tm8/execution — file history and blame: the revisions of one path, and
// which commit last touched each line of it.
//
// READS AND ONLY READS, beside branch-topology.ts for the same reason that
// file states: all git lives here, argv-only through `runGit`, so a path or
// ref carrying `;`, `$(…)` or `>` is inert bytes. Every caller-supplied path
// passes `assertSafePathspec` (PR #76's guard, reused not re-derived) and
// rides behind a literal `--`.
//
// BOUNDED BY CONSTRUCTION. History is capped at `maxRevisions` (asked for
// cap+1 so `truncated` is a measurement, not a guess). Blame is capped at
// `maxLines`; the file's REAL line count is measured separately (a streamed
// byte count, never the file in memory) so a cut can say exactly how many
// lines it holds back. The caps bound rendering, never disclosure.

import { createReadStream } from 'node:fs';

import { runGit, WorktreeError, type GitResult } from '../worktree/git-invoker.js';
import { assertSafePathspec } from '../worktree/git-mutations.js';

export interface FileRevision {
  /** Full commit oid. */
  oid: string;
  author: string;
  authorEmail: string;
  /** Committer date, ISO-8601. */
  committedAt: string;
  subject: string;
  /** Lines added in this revision for this path; null for binary. */
  additions: number | null;
  /** Lines deleted in this revision for this path; null for binary. */
  deletions: number | null;
  /** The path AT that revision — `--follow` walks through renames. */
  path: string;
}

export interface FileHistoryResult {
  path: string;
  revisions: FileRevision[];
  /** True when `maxRevisions` cut the walk short. */
  truncated: boolean;
}

export interface FileHistoryOptions {
  /** Revision cap. Default 100. */
  maxRevisions?: number;
  /** Injected for tests; defaults to the real argv-only invoker. */
  run?: (args: readonly string[], cwd: string) => Promise<GitResult>;
}

/** All-zero oid: git blame's marker for a line not yet in any commit. */
export const UNCOMMITTED_OID = '0'.repeat(40);

export interface BlameHunk {
  /** Commit oid, or `UNCOMMITTED_OID` for working-tree-only lines. */
  oid: string;
  /** First line of the hunk in the CURRENT file, 1-based. */
  startLine: number;
  lineCount: number;
  author: string;
  /** Committer date, ISO-8601; empty for uncommitted lines. */
  committedAt: string;
  /** Commit subject; empty for uncommitted lines. */
  summary: string;
}

export interface FileBlameResult {
  path: string;
  hunks: BlameHunk[];
  /** How many lines the hunks above actually cover. */
  blamedLines: number;
  /** The file's real line count, measured — what a cut holds back is `totalLines - blamedLines`. */
  totalLines: number;
  /** True when `maxLines` cut the blame short. */
  truncated: boolean;
}

export interface FileBlameOptions {
  /** Line cap. Default 2000. */
  maxLines?: number;
  run?: (args: readonly string[], cwd: string) => Promise<GitResult>;
}

const DEFAULT_MAX_REVISIONS = 100;
const DEFAULT_MAX_LINES = 2000;
/** Porcelain blame of a large file is verbose; raise the exec buffer honestly. */
const BLAME_BUFFER_BYTES = 64 * 1024 * 1024;

/** Record separator / field separator: bytes no ref, path or subject may carry. */
const RS = '\u001e';
const FS = '\u001f';
const LOG_FORMAT = `${RS}%H${FS}%an${FS}%ae${FS}%cI${FS}%s`;

function fail(message: string, reason: string): never {
  throw new WorktreeError(message, 'invalid_input', reason);
}

/**
 * "Not a repository" is a fact about the DIRECTORY, answered by name
 * (`invalid_input`/`not_a_git_repository`) — never `internal`, which would
 * send the caller hunting a tm8 bug instead of looking at their own path.
 */
async function assertRepository(
  run: (args: readonly string[], cwd: string) => Promise<GitResult>,
  workingDir: string,
): Promise<void> {
  const inside = await run(['rev-parse', '--is-inside-work-tree'], workingDir);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    fail(`not a git repository: ${JSON.stringify(workingDir)}`, 'not_a_git_repository');
  }
}

/**
 * `git log --follow` for one path: oid, author, date, subject, and the
 * per-revision numstat for the path. `--follow` requires exactly one pathspec,
 * which is exactly this read's shape.
 */
export async function readFileHistory(
  workingDir: string,
  path: string,
  options: FileHistoryOptions = {},
): Promise<FileHistoryResult> {
  assertSafePathspec(path);
  const run = options.run ?? ((args: readonly string[], cwd: string) => runGit(args, { cwd }));
  const maxRevisions = options.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  await assertRepository(run, workingDir);

  const result = await run(
    [
      'log',
      '--follow',
      '--numstat',
      `--format=${LOG_FORMAT}`,
      `--max-count=${maxRevisions + 1}`,
      '--',
      path,
    ],
    workingDir,
  );
  if (result.code !== 0) {
    fail(
      `git log failed for ${JSON.stringify(path)}: ${result.stderr.trim()}`,
      'file_history_failed',
    );
  }

  const revisions: FileRevision[] = [];
  const records = result.stdout.split(RS);
  for (const record of records) {
    if (record.trim() === '') continue;
    const [header, ...bodyLines] = record.split('\n');
    const [oid, author, authorEmail, committedAt, ...subjectParts] = (header ?? '').split(FS);
    if (!oid || !/^[0-9a-f]{40}$/.test(oid)) continue;
    // The one numstat line for the followed path: `adds\tdels\tpath` (or the
    // rename form `adds\tdels\told => new` / `{a => b}/x`). `-` means binary.
    let additions: number | null = null;
    let deletions: number | null = null;
    let revisionPath = path;
    for (const line of bodyLines) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      additions = m[1] === '-' ? null : Number.parseInt(m[1] as string, 10);
      deletions = m[2] === '-' ? null : Number.parseInt(m[2] as string, 10);
      revisionPath = m[3] as string;
      break;
    }
    revisions.push({
      oid,
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      committedAt: committedAt ?? '',
      subject: subjectParts.join(FS),
      additions,
      deletions,
      path: revisionPath,
    });
  }

  const truncated = revisions.length > maxRevisions;
  return {
    path,
    revisions: truncated ? revisions.slice(0, maxRevisions) : revisions,
    truncated,
  };
}

/** Count `\n` in the working-tree file by streaming — never the file in memory. */
function countFileLines(absolutePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lines = 0;
    let sawAny = false;
    let endedWithNewline = true;
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (buf.length > 0) sawAny = true;
      for (const byte of buf) if (byte === 0x0a) lines += 1;
      endedWithNewline = buf.length > 0 ? buf[buf.length - 1] === 0x0a : endedWithNewline;
    });
    stream.on('end', () => resolve(lines + (sawAny && !endedWithNewline ? 1 : 0)));
    stream.on('error', reject);
  });
}

/**
 * `git blame --porcelain` of the WORKING TREE file (uncommitted lines blame
 * to the all-zero oid — the honest answer for "who last touched this line"
 * is sometimes "nobody has committed it yet").
 *
 * Bounded with `-L 1,maxLines`; when the file is shorter git refuses with
 * "has only N lines", and the read retries unbounded — two processes worst
 * case, never an unbounded first attempt.
 */
export async function readFileBlame(
  workingDir: string,
  path: string,
  options: FileBlameOptions = {},
): Promise<FileBlameResult> {
  assertSafePathspec(path);
  const run =
    options.run ??
    ((args: readonly string[], cwd: string) => runGit(args, { cwd, maxBufferBytes: BLAME_BUFFER_BYTES }));
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  await assertRepository(run, workingDir);

  let result = await run(['blame', '--porcelain', '-L', `1,${maxLines}`, '--', path], workingDir);
  if (result.code !== 0 && /has only \d+ lines/.test(result.stderr)) {
    result = await run(['blame', '--porcelain', '--', path], workingDir);
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (/no such path/i.test(stderr)) {
      fail(`no such path in the working tree: ${JSON.stringify(path)}`, 'no_such_path');
    }
    fail(`git blame failed for ${JSON.stringify(path)}: ${stderr}`, 'file_blame_failed');
  }

  // Porcelain: each line-group opens with `<oid> <origLine> <finalLine> [<n>]`;
  // commit metadata appears once per oid on first sight and is cached here.
  interface CommitMeta { author: string; committedAt: string; summary: string }
  const meta = new Map<string, CommitMeta>();
  const hunks: BlameHunk[] = [];
  let blamedLines = 0;

  let current: { oid: string; startLine: number; lineCount: number } | null = null;
  let pendingOid: string | null = null;
  const flush = (): void => {
    if (current === null) return;
    const m = meta.get(current.oid);
    const uncommitted = current.oid === UNCOMMITTED_OID;
    hunks.push({
      oid: current.oid,
      startLine: current.startLine,
      lineCount: current.lineCount,
      author: uncommitted ? 'not yet committed' : (m?.author ?? ''),
      committedAt: uncommitted ? '' : (m?.committedAt ?? ''),
      summary: uncommitted ? '' : (m?.summary ?? ''),
    });
    current = null;
  };

  for (const line of result.stdout.split('\n')) {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (head !== null) {
      const oid = head[1] as string;
      const finalLine = Number.parseInt(head[3] as string, 10);
      pendingOid = oid;
      blamedLines += 1;
      if (current !== null && current.oid === oid && current.startLine + current.lineCount === finalLine) {
        current.lineCount += 1;
      } else {
        flush();
        current = { oid, startLine: finalLine, lineCount: 1 };
      }
      continue;
    }
    if (pendingOid !== null) {
      const existing = meta.get(pendingOid) ?? { author: '', committedAt: '', summary: '' };
      if (line.startsWith('author ')) existing.author = line.slice('author '.length);
      else if (line.startsWith('committer-time ')) {
        const epoch = Number.parseInt(line.slice('committer-time '.length), 10);
        if (Number.isInteger(epoch)) existing.committedAt = new Date(epoch * 1000).toISOString();
      } else if (line.startsWith('summary ')) existing.summary = line.slice('summary '.length);
      meta.set(pendingOid, existing);
    }
  }
  flush();

  const totalLines = await countFileLines(`${workingDir}/${path}`).catch(() => blamedLines);
  return {
    path,
    hunks,
    blamedLines,
    totalLines,
    truncated: totalLines > blamedLines,
  };
}
