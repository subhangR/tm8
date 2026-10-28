import { parse, stringify } from '@iarna/toml';
import { mkdir, readdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
/** Session-owned Codex home: copy model login only, never inherited connector configuration. */
export async function isolateCodexMcpHome(manifestPath:string,env:Record<string,string>):Promise<void> {
 const source=env.CODEX_HOME || join(env.HOME || homedir(),'.codex');
 const target=join(dirname(manifestPath),'mcp-homes',basename(manifestPath,'.json'),'codex');
 await mkdir(target,{recursive:true,mode:0o700});await chmod(target,0o700);
 if(source!==target) {
  try{const auth=await readFile(join(source,'auth.json'));await writeFile(join(target,'auth.json'),auth,{mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(join(target,'auth.json'),{force:true});}
 }
 // Preserve model/provider and runtime preferences while clearing connector tables at every level.
 let config:ReturnType<typeof parse>={};
 try {config=parse(await readFile(join(source,'config.toml'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Codex configuration could not be isolated');}
 const clearConnectors=(value:unknown):void=>{
  if(!value || typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)clearConnectors(item);return;}
  const record=value as Record<string,unknown>;
  delete record.mcp_servers;
  for(const item of Object.values(record))clearConnectors(item);
 };
 clearConnectors(config);config.mcp_servers={};
 await writeFile(join(target,'config.toml'),stringify(config),{mode:0o600});
 env.CODEX_HOME=target;
}

/*
 * THE HOME AFTER ITS PROCESS.
 *
 * `isolateCodexMcpHome` runs at spawn and at every resume, and nothing removed
 * what it wrote. A node running a 30-minute loop kept ~600 homes and 9.4 GB in
 * two weeks, plus 600 copies of the operator's login, until its disk filled.
 * The home holds two kinds of thing, so it is cleaned in two steps:
 *
 *   - THE LOGIN COPY and Codex's rebuildable caches go when the process does:
 *     at PTY exit, on a kill, on a failed launch, and in the boot sweep that
 *     catches a crash. Resume copies `auth.json` from the source home again
 *     (SpawnService, before the PTY), so a resume loses nothing.
 *   - THE CONVERSATION (rollouts under `sessions/`, Codex's state databases)
 *     stays while the session can still be resumed, because `codex resume`
 *     reads it back from this directory. The whole home goes only when the
 *     session cannot come back: its row is gone, it was deleted, or its
 *     worktree was reclaimed (resume refuses all three). The operator can opt
 *     in to a retention window as well, which gives up resume of older
 *     sessions to save disk.
 *
 * Nothing here logs a file's contents (I5).
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What Codex writes into a home and rebuilds on its next boot: the download
 * caches (apps tool list, plugin catalog, model list, the curated plugin
 * marketplace and its staging clone, the meetings runtime binary), scratch
 * space, and the tracing log database. `codex resume` reads none of it.
 * Measured on codex-cli 0.153.2 with a ChatGPT login: one idle session's home
 * reached 264 MB within five minutes, of which `plugins/cache` was 143 MB,
 * `chatgpt-meetings/versions` 43 MB, `cache` 40 MB and `.tmp/marketplaces`
 * 33 MB, against a 4 KB rollout. Paths are relative to the `codex` directory.
 */
const REBUILDABLE_ENTRIES = [
  'cache',
  join('plugins', 'cache'),
  join('.tmp', 'marketplaces'),
  join('chatgpt-meetings', 'versions'),
  'models_cache.json',
  'tmp',
];
const LOG_DATABASE_RE = /^logs_\d+\.sqlite(-wal|-shm|-journal)?$/;

export function codexMcpHomesRoot(dataDir: string): string {
  return join(dataDir, 'manifests', 'mcp-homes');
}

/** The per-session directory that `isolateCodexMcpHome` creates `codex/` inside. */
export function codexMcpSessionDir(dataDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('work session id is not a uuid');
  return join(codexMcpHomesRoot(dataDir), sessionId);
}

/**
 * Remove the login copy and the rebuildable caches from one session's Codex
 * home and keep its conversation. Idempotent. A session that never ran Codex
 * is a no-op. Returns whether there was a login copy to remove.
 */
export async function scrubCodexMcpHome(dataDir: string, sessionId: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  const home = join(codexMcpSessionDir(dataDir, sessionId), 'codex');
  let scrubbed = false;
  try {
    await rm(join(home, 'auth.json'));
    scrubbed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return scrubbed;
    throw error;
  }
  const rebuildable = [...REBUILDABLE_ENTRIES, ...entries.filter((name) => LOG_DATABASE_RE.test(name))];
  for (const entry of rebuildable) await rm(join(home, entry), { recursive: true, force: true });
  return scrubbed;
}

/** Session ids that have a home on this node, in no particular order. */
export async function listCodexMcpHomes(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(codexMcpHomesRoot(dataDir))).filter((name) => SESSION_ID_RE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * The boot sweep: scrub every home except the ones `isLive` names. The same
 * contract as `sweepSpaceSessionSecrets`: reports ids only, and a failure is
 * reported rather than thrown.
 */
export async function sweepCodexMcpHomeSecrets(
  dataDir: string,
  isLive: (sessionId: string) => boolean,
): Promise<{ scrubbed: string[]; errors: string[] }> {
  const scrubbed: string[] = [];
  const errors: string[] = [];
  for (const sessionId of await listCodexMcpHomes(dataDir)) {
    if (isLive(sessionId)) continue;
    try {
      if (await scrubCodexMcpHome(dataDir, sessionId)) scrubbed.push(sessionId);
    } catch {
      errors.push(sessionId);
    }
  }
  return { scrubbed, errors };
}

/** What the graph knows about a session that has a home here. */
export interface CodexHomeSessionFacts {
  sessionId: string;
  status: string;
  deleted: boolean;
  workdirMode: string | null;
  workdirPath: string | null;
  /** Epoch ms. Null when the row never recorded an ending. */
  exitedAt: number | null;
}

export type CodexHomeReclaimReason = 'no_session' | 'deleted' | 'worktree_gone' | 'retention';

const LIVE_STATUSES = new Set(['spawning', 'running', 'idle']);
const ENDED_STATUSES = new Set(['exited', 'failed']);

/**
 * Whether a session can no longer use its home, and why. This mirrors what
 * `SpawnService.resume` refuses: a missing or deleted row (`not_found`), and a
 * worktree session whose checkout is gone. A live status always keeps the
 * home, even on a deleted row, because the process may still be writing to
 * it. An unknown status keeps it too. A null `retentionMs` means a resumable
 * session keeps its home indefinitely.
 */
export function codexHomeReclaimReason(
  facts: CodexHomeSessionFacts | undefined,
  opts: { now: number; retentionMs: number | null; worktreeExists: boolean },
): CodexHomeReclaimReason | null {
  if (facts === undefined) return 'no_session';
  if (LIVE_STATUSES.has(facts.status)) return null;
  if (facts.deleted) return 'deleted';
  if (!ENDED_STATUSES.has(facts.status)) return null;
  if (facts.workdirMode === 'worktree' && !opts.worktreeExists) return 'worktree_gone';
  if (opts.retentionMs !== null && facts.exitedAt !== null && opts.now - facts.exitedAt > opts.retentionMs) {
    return 'retention';
  }
  return null;
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

export interface CodexHomeReclaimReport {
  examined: number;
  reclaimed: Array<{ sessionId: string; reason: CodexHomeReclaimReason }>;
  errors: string[];
}

/**
 * Remove every home whose session can no longer be resumed.
 *
 * `facts` is called in batches of `batchSize` and must return a row for every
 * session that has one. An id missing from its answer is read as "no
 * session", so it must not be filtered by space membership. `isLive` is
 * checked before the read and again just before each removal, so a resume
 * that starts in between keeps its home. At most `maxReclaims` homes are
 * removed per call and the rest wait for the next tick.
 */
export async function reclaimCodexMcpHomes(input: {
  dataDir: string;
  isLive: (sessionId: string) => boolean;
  facts: (sessionIds: string[]) => Promise<CodexHomeSessionFacts[]>;
  retentionMs: number | null;
  now?: number;
  batchSize?: number;
  maxReclaims?: number;
}): Promise<CodexHomeReclaimReport> {
  const now = input.now ?? Date.now();
  const batchSize = input.batchSize ?? 500;
  const maxReclaims = input.maxReclaims ?? 200;
  const candidates = (await listCodexMcpHomes(input.dataDir)).filter((id) => !input.isLive(id));
  const report: CodexHomeReclaimReport = { examined: 0, reclaimed: [], errors: [] };
  for (let start = 0; start < candidates.length && report.reclaimed.length < maxReclaims; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const known = new Map((await input.facts(batch)).map((row) => [row.sessionId, row]));
    for (const sessionId of batch) {
      if (report.reclaimed.length >= maxReclaims) break;
      report.examined += 1;
      const facts = known.get(sessionId);
      const reason = codexHomeReclaimReason(facts, {
        now,
        retentionMs: input.retentionMs,
        worktreeExists: facts?.workdirMode === 'worktree' ? await worktreeExists(facts.workdirPath) : true,
      });
      if (reason === null || input.isLive(sessionId)) continue;
      try {
        await rm(codexMcpSessionDir(input.dataDir, sessionId), { recursive: true, force: true });
        report.reclaimed.push({ sessionId, reason });
      } catch {
        report.errors.push(sessionId);
      }
    }
  }
  return report;
}
