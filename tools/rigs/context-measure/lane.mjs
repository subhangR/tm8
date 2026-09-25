// Lane-process helpers shared by run-lane.mjs (I10a) and context-eval/lanes.mjs.
// Pure process/filesystem probes: no tm8 writes happen here.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts }).trim();
export const uptime = () => sh('uptime', []).replace(/.*load averages?:\s*/, '');
export const load1 = () => Number(uptime().split(/\s+/)[0]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pid of the claude process carrying TM8_SESSION_ID=<sessionId>, or null. */
export function lanePid(sessionId) {
  let pids = '';
  try {
    pids = sh('pgrep', ['-f', 'claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // pgrep exits 1 on no match
  }
  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      if (sh('ps', ['eww', '-p', pid]).includes(`TM8_SESSION_ID=${sessionId}`)) return pid;
    } catch {
      /* exited */
    }
  }
  return null;
}

/** Which `tm8` the lane process resolves on ITS OWN PATH, and its version. */
export function laneCli(pid) {
  const env = sh('ps', ['eww', '-p', pid]).split(/\s+/).find((w) => w.startsWith('PATH='));
  const path = env ? env.slice(5) : '';
  const bin = sh('/bin/sh', ['-c', 'command -v tm8 || true'], { env: { PATH: path } });
  let version = null;
  try {
    version = sh(bin, ['--version'], { env: { PATH: path, HOME: homedir() } });
  } catch {
    version = null;
  }
  return { bin, version };
}

/** The lane's native claude session id, from its command line. */
export function nativeSessionId(pid) {
  return /--session-id\s+(\S+)/.exec(sh('ps', ['-o', 'command=', '-p', pid]))?.[1] ?? null;
}

/** The Claude Code transcript for a worktree (+ native id). Throws on an ambiguous directory. */
export function transcriptFor(worktree, nativeId) {
  const slug = worktree.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', slug);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (nativeId && files.includes(`${nativeId}.jsonl`)) return join(dir, `${nativeId}.jsonl`);
  // Without the native id, only an unambiguous directory is trusted: measuring
  // the wrong session's transcript would be a plausible, wrong row.
  if (files.length > 1) throw new Error(`${dir}: ${files.length} transcripts and no native session id to pick one`);
  return files[0] ? join(dir, files[0]) : null;
}
