/**
 * Environment → `ops.disk-guard` job, and the managed session TMPDIR.
 *
 *   TM8_DISK_GUARD          apply (default on TM8_ENV=prod) | report (default elsewhere) | off
 *   TM8_DISK_ALERT_PCT      warn threshold, default 85
 *   TM8_DISK_CRITICAL_PCT   critical threshold, default 92
 *   TM8_DISK_ALERT_COMMAND  shell command run per alert, with TM8_ALERT_LEVEL /
 *                           TM8_ALERT_USED_PCT / TM8_ALERT_TEXT in its env
 *   TM8_DEPLOY_ROOT         dir holding prod/, staging/, prod-prev.*, candidates/.
 *                           Default: the parent of the server's cwd when that cwd
 *                           is a slot checkout (prod|staging|private).
 *   TM8_SESSION_TMPDIR      TMPDIR for spawned sessions; default <dataDir>/tmp, `off` to inherit
 *
 * Shared paths (/tmp, the home caches, the deploy root) are swept by ONE
 * server per machine: the prod slot by default, or the one with
 * TM8_DISK_GUARD_SHARED=1. Staging and private sweep only their own data dir,
 * so three servers on one box never race over the same files or triple-alert.
 */
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { Db, DbClaims } from '../db/types.js';
import { commandAlert, createDiskGuardJob } from '../scheduler/jobs/disk-guard.js';
import type { ScheduledJob } from '../scheduler/types.js';
import type { SessionLookup } from './disk-inventory.js';
import { DEFAULT_DISK_THRESHOLDS, type RetentionLayout, type SessionState } from './disk-retention.js';

const SLOTS = new Set(['prod', 'staging', 'private']);

/** Points spawned sessions at `<dataDir>/tmp` unless the operator chose otherwise. */
export function prepareSessionTmpdir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TM8_SESSION_TMPDIR === 'off') { delete env.TM8_SESSION_TMPDIR; return null; }
  const dir = env.TM8_SESSION_TMPDIR || join(dataDir, 'tmp');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    delete env.TM8_SESSION_TMPDIR; // unusable: sessions keep the inherited TMPDIR
    return null;
  }
  env.TM8_SESSION_TMPDIR = dir;
  return dir;
}

export function retentionLayoutFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()):
  RetentionLayout {
  const shared = env.TM8_DISK_GUARD_SHARED ? env.TM8_DISK_GUARD_SHARED === '1' : env.TM8_ENV === 'prod';
  const deployRoot = env.TM8_DEPLOY_ROOT || (SLOTS.has(basename(cwd)) ? dirname(cwd) : null);
  return {
    dataDir,
    deployRoot: shared ? deployRoot : null,
    home: shared ? (env.HOME || homedir()) : null,
    // The SERVER's own temp dir, never the managed one sessions get.
    systemTmp: shared ? tmpdir() : null,
  };
}

/**
 * Sessions by id and by recorded workdir, read under the owner's claims. A
 * session those claims cannot see is `unknown`, which the rules treat as the
 * slowest case (a week of idleness), never as ended.
 */
export function dbSessionLookup(db: Db, claims: () => Promise<DbClaims>): () => Promise<SessionLookup> {
  return async () => {
    type Row = { id: string; status: string; status_changed_at: Date | string; workdir_path: string | null };
    let rows: Row[] = [];
    let error: string | undefined;
    try {
      rows = await db.query<Row>(await claims(),
        `select entity_id::text id, status, status_changed_at, workdir_path from public.work_sessions`, []);
    } catch (e) {
      error = `could not read sessions: ${e instanceof Error ? e.message : String(e)}`;
    }
    const toFact = (row: Row): { state: SessionState; endedAt: number | null } => {
      const ended = row.status === 'exited' || row.status === 'failed';
      return { state: ended ? 'ended' : 'live', endedAt: ended ? new Date(row.status_changed_at).getTime() : null };
    };
    const byId = new Map(rows.map((r) => [r.id, toFact(r)]));
    const byPath = new Map<string, { state: SessionState; endedAt: number | null }>();
    for (const row of rows) {
      if (!row.workdir_path) continue;
      const fact = toFact(row);
      const prior = byPath.get(row.workdir_path);
      // Several sessions can share a workdir: any live one keeps it live,
      // otherwise the LATEST end counts.
      if (prior?.state === 'live') continue;
      if (!prior || fact.state === 'live' || (fact.endedAt ?? 0) > (prior.endedAt ?? 0)) byPath.set(row.workdir_path, fact);
    }
    return {
      ...(error ? { error } : {}),
      find: ({ id, workdirPath }) =>
        (id ? byId.get(id) : undefined) ?? (workdirPath ? byPath.get(workdirPath) : undefined) ?? { state: 'unknown', endedAt: null },
    };
  };
}

function pct(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

export function diskGuardJobFromEnv(input: {
  db: Db; claims: () => Promise<DbClaims>; dataDir: string; env?: NodeJS.ProcessEnv;
}): ScheduledJob | null {
  const env = input.env ?? process.env;
  const mode = env.TM8_DISK_GUARD || (env.TM8_ENV === 'prod' ? 'apply' : 'report');
  if (mode === 'off') return null;
  return createDiskGuardJob({
    layout: retentionLayoutFromEnv(input.dataDir, env),
    mode: mode === 'apply' ? 'apply' : 'report',
    thresholds: {
      warnPct: pct(env.TM8_DISK_ALERT_PCT, DEFAULT_DISK_THRESHOLDS.warnPct),
      criticalPct: pct(env.TM8_DISK_CRITICAL_PCT, DEFAULT_DISK_THRESHOLDS.criticalPct),
    },
    sessions: dbSessionLookup(input.db, input.claims),
    ...(env.TM8_DISK_ALERT_COMMAND ? { alert: commandAlert(env.TM8_DISK_ALERT_COMMAND) } : {}),
  });
}
