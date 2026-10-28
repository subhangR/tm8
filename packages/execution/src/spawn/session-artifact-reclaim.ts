/*
 * WHAT A SESSION LEAVES ON THE NODE, AND WHEN IT GOES.
 *
 * Three per-session things are written under the node's data root and, before
 * this, only one of them was ever removed:
 *
 *   - THE CODEX HOME, `<dataDir>/manifests/mcp-homes/<id>/` (`mcp-home.ts`).
 *     `codex resume` reads the conversation back from it.
 *   - THE SPACE-KEY HOME, `<dataDir>/credentials/sessions/<id>/`
 *     (`space-credential-session-home.ts`). It holds the Claude transcripts
 *     and Codex rollouts of a session that ran on a space API key: resume
 *     reads them back, AND the transcript door reads them for an ended
 *     session (its `agent_config_dir` points here). A CHAT on a space key
 *     uses the same path under its chat id (`server/src/chat/credentials.ts`).
 *   - THE MANIFEST FILE, `<dataDir>/manifests/<id>.json`. Only the running
 *     agent reads it (`TM8_MANIFEST_PATH`: `tm8 worker-init`, discoverability).
 *     Resume rewrites it before the PTY starts and replays the launch from the
 *     `session_manifests` ROW, not the file, so an ended session's file is
 *     dead weight. One production node had 956 of them.
 *
 * Each goes only when nothing can read it again, and the rules differ because
 * the readers differ:
 *
 *   codex home   no row, deleted, worktree gone; or ended past the retention
 *   space home   no entity at all, deleted; or ended past the retention. NOT
 *                worktree gone: the session is still listed and its
 *                transcript is still read from here. NOT a chat's.
 *   manifest     no row, deleted, or ended. Resume writes a fresh one.
 *
 * A session live on this node (a PTY, or claims captured by an in-flight spawn
 * or resume) is never touched, and liveness is checked again just before each
 * removal. A live STATUS keeps everything too, even on a deleted row, because
 * a process elsewhere may still be writing. Nothing here logs a file's
 * contents (I5).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { codexMcpSessionDir, listCodexMcpHomes } from './mcp-home.js';
import { spaceSessionHomeDir, spaceSessionsRoot } from './space-credential-session-home.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFEST_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json(\.tmp)?$/i;

/** What the graph knows about a session that has something on this node (372). */
export interface SessionHomeFacts {
  sessionId: string;
  status: string;
  deleted: boolean;
  workdirMode: string | null;
  workdirPath: string | null;
  /** Epoch ms. Null when the row never recorded an ending. */
  exitedAt: number | null;
}

/** For an id 372 did not answer for: is it any entity at all (373)? */
export interface SessionHomeOwnerFacts {
  id: string;
  kind: string;
  deleted: boolean;
}

export type SessionArtifact = 'codex_home' | 'space_home' | 'manifest';

export type CodexHomeReclaimReason = 'no_session' | 'deleted' | 'worktree_gone' | 'retention';
export type SpaceHomeReclaimReason = 'no_session' | 'deleted' | 'retention';
export type ManifestReclaimReason = 'no_session' | 'deleted' | 'ended';
export type SessionArtifactReclaimReason = CodexHomeReclaimReason | ManifestReclaimReason;

/** Days an ended session keeps each home. Null keeps it while it is still useful. */
export interface SessionHomeRetention {
  codexHomeMs: number | null;
  spaceHomeMs: number | null;
}

const LIVE_STATUSES = new Set(['spawning', 'running', 'idle']);
const ENDED_STATUSES = new Set(['exited', 'failed']);

function pastRetention(facts: SessionHomeFacts, now: number, retentionMs: number | null): boolean {
  return retentionMs !== null && facts.exitedAt !== null && now - facts.exitedAt > retentionMs;
}

/**
 * Whether a session can no longer use its Codex home, and why. This mirrors
 * what `SpawnService.resume` refuses: a missing or deleted row (`not_found`),
 * and a worktree session whose checkout is gone. A live status always keeps
 * the home, even on a deleted row, because the process may still be writing to
 * it. An unknown status keeps it too. A null `retentionMs` means a resumable
 * session keeps its home indefinitely.
 */
export function codexHomeReclaimReason(
  facts: SessionHomeFacts | undefined,
  opts: { now: number; retentionMs: number | null; worktreeExists: boolean },
): CodexHomeReclaimReason | null {
  if (facts === undefined) return 'no_session';
  if (LIVE_STATUSES.has(facts.status)) return null;
  if (facts.deleted) return 'deleted';
  if (!ENDED_STATUSES.has(facts.status)) return null;
  if (facts.workdirMode === 'worktree' && !opts.worktreeExists) return 'worktree_gone';
  if (pastRetention(facts, opts.now, opts.retentionMs)) return 'retention';
  return null;
}

/**
 * Whether a space-key home can go. Stricter than the Codex home, because the
 * transcript door reads this directory for any session still listed: a
 * worktree that is gone keeps it. An id with no work-session row is an orphan
 * only when it is no entity at all (`owner` undefined); a chat, deleted or
 * not, keeps its home, and so does an id whose owner could not be asked
 * (`owner === null`).
 */
export function spaceHomeReclaimReason(
  facts: SessionHomeFacts | undefined,
  owner: SessionHomeOwnerFacts | null | undefined,
  opts: { now: number; retentionMs: number | null },
): SpaceHomeReclaimReason | null {
  if (facts === undefined) return owner === undefined ? 'no_session' : null;
  if (LIVE_STATUSES.has(facts.status)) return null;
  if (facts.deleted) return 'deleted';
  if (!ENDED_STATUSES.has(facts.status)) return null;
  if (pastRetention(facts, opts.now, opts.retentionMs)) return 'retention';
  return null;
}

/**
 * Whether a manifest file can go: whenever no agent of this session can be
 * running. Resume rewrites the file from the recorded launch before its PTY
 * starts, so an ended session loses nothing.
 */
export function manifestReclaimReason(facts: SessionHomeFacts | undefined): ManifestReclaimReason | null {
  if (facts === undefined) return 'no_session';
  if (LIVE_STATUSES.has(facts.status)) return null;
  if (facts.deleted) return 'deleted';
  return ENDED_STATUSES.has(facts.status) ? 'ended' : null;
}

/** A path counts as gone only when stat proves it is absent. Any other error keeps the home. */
async function worktreeExists(path: string | null): Promise<boolean> {
  if (path === null) return false;
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function listSpaceSessionHomes(dataDir: string): Promise<string[]> {
  return (await listDir(spaceSessionsRoot(dataDir))).filter((name) => SESSION_ID_RE.test(name));
}

/** Manifest files by session id; a stale `.json.tmp` from a crashed write rides with its session. */
async function listManifestFiles(dataDir: string): Promise<Map<string, string[]>> {
  const bySession = new Map<string, string[]>();
  for (const name of await listDir(join(dataDir, 'manifests'))) {
    const match = MANIFEST_FILE_RE.exec(name);
    if (!match) continue;
    const id = match[1]!;
    bySession.set(id, [...(bySession.get(id) ?? []), name]);
  }
  return bySession;
}

export interface SessionArtifactReclaimReport {
  /** Sessions judged, across every artifact. */
  examined: number;
  reclaimed: Array<{ sessionId: string; artifact: SessionArtifact; reason: SessionArtifactReclaimReason }>;
  errors: Array<{ sessionId: string; artifact: SessionArtifact }>;
}

const ALL_ARTIFACTS: readonly SessionArtifact[] = ['codex_home', 'space_home', 'manifest'];

/**
 * Remove every per-session artifact on this node that nothing can read again.
 *
 * `facts` is called in batches of `batchSize` and must return a row for every
 * session that has one. An id missing from its answer is read as "no
 * session", so it must not be filtered by space membership. `owners` is asked
 * only about space-key homes whose id `facts` did not answer for, under the
 * same rule; without it such a home is kept. `isLive` is checked before the
 * read and again just before each removal, so a resume that starts in between
 * keeps everything. At most `maxReclaims` artifacts are removed per call and
 * the rest wait for the next tick. A failed read throws before anything in
 * its batch is removed.
 */
export async function reclaimSessionArtifacts(input: {
  dataDir: string;
  isLive: (sessionId: string) => boolean;
  facts: (sessionIds: string[]) => Promise<SessionHomeFacts[]>;
  owners?: (ids: string[]) => Promise<SessionHomeOwnerFacts[]>;
  retention: SessionHomeRetention;
  /** Which artifacts to consider. All three by default. */
  artifacts?: readonly SessionArtifact[];
  now?: number;
  batchSize?: number;
  maxReclaims?: number;
}): Promise<SessionArtifactReclaimReport> {
  const now = input.now ?? Date.now();
  const batchSize = input.batchSize ?? 500;
  const maxReclaims = input.maxReclaims ?? 200;
  const wanted = new Set(input.artifacts ?? ALL_ARTIFACTS);

  const codexHomes = new Set(wanted.has('codex_home') ? await listCodexMcpHomes(input.dataDir) : []);
  const spaceHomes = new Set(wanted.has('space_home') ? await listSpaceSessionHomes(input.dataDir) : []);
  const manifests = wanted.has('manifest') ? await listManifestFiles(input.dataDir) : new Map<string, string[]>();
  const candidates = [...new Set([...codexHomes, ...spaceHomes, ...manifests.keys()])]
    .filter((id) => !input.isLive(id));

  const report: SessionArtifactReclaimReport = { examined: 0, reclaimed: [], errors: [] };
  const capped = () => report.reclaimed.length >= maxReclaims;

  /** Remove one artifact, re-checking liveness first. */
  const remove = async (
    sessionId: string,
    artifact: SessionArtifact,
    reason: SessionArtifactReclaimReason,
    paths: string[],
  ): Promise<void> => {
    if (capped() || input.isLive(sessionId)) return;
    try {
      for (const path of paths) await rm(path, { recursive: true, force: true });
      report.reclaimed.push({ sessionId, artifact, reason });
    } catch {
      report.errors.push({ sessionId, artifact });
    }
  };

  for (let start = 0; start < candidates.length && !capped(); start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const known = new Map((await input.facts(batch)).map((row) => [row.sessionId, row]));
    // Only a space-key home with no work-session row needs its owner asked.
    const unowned = batch.filter((id) => spaceHomes.has(id) && !known.has(id));
    const owners: Map<string, SessionHomeOwnerFacts> | null = unowned.length === 0
      ? new Map()
      : input.owners
        ? new Map((await input.owners(unowned)).map((row) => [row.id, row]))
        : null;

    for (const sessionId of batch) {
      if (capped()) break;
      report.examined += 1;
      const facts = known.get(sessionId);

      if (manifests.has(sessionId)) {
        const reason = manifestReclaimReason(facts);
        if (reason !== null) {
          await remove(sessionId, 'manifest', reason,
            manifests.get(sessionId)!.map((name) => join(input.dataDir, 'manifests', name)));
        }
      }
      if (codexHomes.has(sessionId)) {
        const reason = codexHomeReclaimReason(facts, {
          now,
          retentionMs: input.retention.codexHomeMs,
          worktreeExists: facts?.workdirMode === 'worktree' ? await worktreeExists(facts.workdirPath) : true,
        });
        if (reason !== null) {
          await remove(sessionId, 'codex_home', reason, [codexMcpSessionDir(input.dataDir, sessionId)]);
        }
      }
      if (spaceHomes.has(sessionId)) {
        const owner = owners === null ? null : owners.get(sessionId);
        const reason = spaceHomeReclaimReason(facts, owner, { now, retentionMs: input.retention.spaceHomeMs });
        if (reason !== null) {
          await remove(sessionId, 'space_home', reason, [spaceSessionHomeDir(input.dataDir, sessionId)]);
        }
      }
    }
  }
  return report;
}
