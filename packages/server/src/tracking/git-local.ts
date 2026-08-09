/**
 * Local git reads for the tracking surface — argv-only, read-only.
 *
 * Every function here shells out to `git` with an ARGUMENT VECTOR (never a
 * shell string), runs read-only plumbing against a worktree path this node
 * already knows from `public.worktrees`, and treats every failure as an
 * observation gap rather than an error: a worktree whose directory is gone,
 * or whose base oid is unknown to the local object store, yields `null` and
 * the caller reports "skipped", because "I could not look" must never be
 * rendered as "nothing is touched".
 */
import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 15_000;
/** Bounded output: a diff name list beyond this is a pathological lane. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, signal, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * The set of paths a worktree has TOUCHED relative to its recorded base:
 * committed changes (`base..HEAD` name-only diff) plus everything the working
 * tree currently carries (staged, unstaged, untracked — `status --porcelain`).
 *
 * Returns `null` when the worktree cannot be read at all; a readable worktree
 * with no changes returns an empty set.
 */
export async function touchedPaths(
  cwd: string,
  baseCommitOid: string,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const status = await git(cwd, ['status', '--porcelain', '--no-renames'], signal);
  if (status === null) return null;

  const out = new Set<string>();
  for (const line of status.split('\n')) {
    // porcelain v1: two status columns, a space, then the path.
    const path = line.slice(3).trim();
    if (path !== '') out.add(path);
  }

  // The committed delta. A base oid the local store does not have (e.g. after
  // an aggressive gc) fails this diff without invalidating the status read —
  // report what was readable rather than nothing.
  const diff = await git(cwd, ['diff', '--name-only', '--no-renames', `${baseCommitOid}..HEAD`], signal);
  if (diff !== null) {
    for (const line of diff.split('\n')) {
      const path = line.trim();
      if (path !== '') out.add(path);
    }
  }
  return out;
}

export interface LocalCommit {
  sha: string;
  author: string | null;
  committedAt: string | null;
  subject: string;
}

/** Unit separator — cannot appear in an author name or subject line. */
const FIELD_SEP = '\u001f';

/**
 * Commits a worktree has produced beyond its recorded base, oldest first,
 * bounded. `null` when the worktree or the base cannot be read.
 */
export async function commitsAhead(
  cwd: string,
  baseCommitOid: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<LocalCommit[] | null> {
  const raw = await git(
    cwd,
    [
      'log',
      '--reverse',
      `--max-count=${String(limit)}`,
      `--format=%H${FIELD_SEP}%an${FIELD_SEP}%cI${FIELD_SEP}%s`,
      `${baseCommitOid}..HEAD`,
    ],
    signal,
  );
  if (raw === null) return null;

  const out: LocalCommit[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const [sha, author, committedAt, subject] = line.split(FIELD_SEP);
    if (sha === undefined || !/^[a-f0-9]{7,64}$/.test(sha)) continue;
    out.push({
      sha,
      author: author === undefined || author === '' ? null : author,
      committedAt: committedAt === undefined || committedAt === '' ? null : committedAt,
      subject: subject ?? '',
    });
  }
  return out;
}

/** `owner/name` from a git remote url, or null when it cannot be derived. */
export function repoFromUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null;
  const m = /[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1] ?? null;
}
