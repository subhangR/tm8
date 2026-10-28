import { parse, stringify } from '@iarna/toml';
import { mkdir, readdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
/** Where a session's launch manifest lives under the node data dir. */
export function sessionManifestPath(dataDir:string,sessionId:string):string {
 return join(dataDir,'manifests',`${sessionId}.json`);
}
/**
 * The CODEX_HOME a session's child actually runs with, derived from its
 * manifest path the same way `isolateCodexMcpHome` creates it. Codex writes
 * the session's rollouts under `<this>/sessions`, so resume and the
 * transcript readers must look here; recording the pre-isolation home instead
 * names a directory the child never wrote to.
 */
export function codexMcpHomeFor(manifestPath:string):string {
 return join(dirname(manifestPath),'mcp-homes',basename(manifestPath,'.json'),'codex');
}
const SESSION_UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `codexMcpHomeFor` from a data dir and session id; null for a non-uuid id, so no caller can steer it outside the data dir. */
export function codexSessionHome(dataDir:string,sessionId:string):string|null {
 if(!SESSION_UUID_RE.test(sessionId))return null;
 return codexMcpHomeFor(sessionManifestPath(dataDir,sessionId));
}
/** Session-owned Codex home: copy model login only, never inherited connector configuration. */
export async function isolateCodexMcpHome(manifestPath:string,env:Record<string,string>):Promise<void> {
 const source=env.CODEX_HOME || join(env.HOME || homedir(),'.codex');
 const target=codexMcpHomeFor(manifestPath);
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
 *     sessions to save disk. That removal lives in
 *     `session-artifact-reclaim.ts`, beside the session's other node-local
 *     leftovers.
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

