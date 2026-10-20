/**
 * `ops.disk-guard` — keep the node's disk from filling, and say so when it is.
 *
 * Every 30 minutes: measure the data dir's volume and alert the owner from
 * 85% (critical from 92%), then apply the retention rules in
 * `ops/disk-retention.ts`: expired temp output, over-cap caches, old deploy
 * candidates and builds, and the worktrees and scratch dirs of sessions that
 * have ended with their work pushed. Checkouts holding unpushed or uncommitted
 * work are kept and FLAGGED: logged, listed in the job status, and sent to the
 * owner once.
 *
 * `report` mode plans and reports without deleting anything.
 */
import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

import {
  classifyCheckout, defaultRetentionRules, diskLevel, planRetention, planScratchDir, shouldAlert,
  DEFAULT_DISK_THRESHOLDS, type AlertMemory, type DiskLevel, type DiskThresholds, type KeptEntry,
  type PlannedDeletion, type RetentionLayout, type ScratchChild,
} from '../../ops/disk-retention.js';
import {
  checkoutKind, ignoredRegenerable, liveCwds, measureBytes, probeCheckout, readEntries, readPinned,
  removePath, scratchChildren, type SessionLookup,
} from '../../ops/disk-inventory.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const DISK_GUARD_JOB_NAME = 'ops.disk-guard';

export interface DiskAlert {
  level: DiskLevel;
  usedPct: number;
  text: string;
}

export interface DiskGuardOptions {
  layout: RetentionLayout;
  mode: 'apply' | 'report';
  thresholds?: DiskThresholds;
  /** Who owns the sessions behind scratch dirs and worktrees. */
  sessions: () => Promise<SessionLookup>;
  /** Delivers an alert to the owner. Default: `alertCommand`, else the log only. */
  alert?: (alert: DiskAlert) => Promise<void>;
  intervalMs?: number;
  now?: () => number;
  /** Seams for tests; default to the real disk. */
  usage?: (path: string) => Promise<number | null>;
  remove?: (path: string) => Promise<void>;
}

export async function diskUsedPct(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    return total > 0 ? Math.round(((total - s.bavail * s.bsize) / total) * 1000) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * Runs the operator's `TM8_DISK_ALERT_COMMAND` with the alert in its env
 * (`TM8_ALERT_LEVEL`, `TM8_ALERT_TEXT`). The command is how an alert reaches
 * a human (a tm8 message, the WhatsApp bridge, a pager): the node has no
 * channel of its own to the owner.
 */
export function commandAlert(command: string): (alert: DiskAlert) => Promise<void> {
  return (alert) => new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', command], {
      timeout: 30_000,
      env: { ...process.env, TM8_ALERT_LEVEL: alert.level, TM8_ALERT_USED_PCT: String(alert.usedPct), TM8_ALERT_TEXT: alert.text },
    }, (error) => (error ? reject(error) : resolve()));
  });
}

/** `<root>/<id>` and `<root>/<project>/<id>`: every checkout one or two levels down. */
async function managedCheckouts(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, name);
    if (await checkoutKind(path)) { out.push(path); continue; }
    for (const child of await readdir(path).catch(() => [] as string[])) {
      if (await checkoutKind(join(path, child))) out.push(join(path, child));
    }
  }
  return out;
}

/** Checkouts nested inside a non-checkout dir, so an "other" dir never hides one. */
async function nestedCheckouts(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!name.isDirectory() || name.name === 'node_modules') continue;
    const path = join(dir, name.name);
    if (await checkoutKind(path)) out.push(path);
    else if (depth > 0) out.push(...await nestedCheckouts(path, depth - 1));
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DiskGuardRun {
  usedPct: number | null;
  level: DiskLevel;
  planned: PlannedDeletion[];
  deleted: PlannedDeletion[];
  flagged: KeptEntry[];
  errors: Array<{ path: string; message: string }>;
}

export function createDiskGuardJob(options: DiskGuardOptions): ScheduledJob {
  const now = options.now ?? Date.now;
  const thresholds = options.thresholds ?? DEFAULT_DISK_THRESHOLDS;
  const usage = options.usage ?? diskUsedPct;
  const remove = options.remove ?? removePath;
  const memory: AlertMemory = { level: 'ok', sentAt: null };
  const flaggedSent = new Set<string>();

  const send = async (ctx: JobContext, alert: DiskAlert): Promise<void> => {
    const log = alert.level === 'critical' ? ctx.logger.error : ctx.logger.warn;
    log.call(ctx.logger, `disk alert: ${alert.text}`);
    await options.alert?.(alert).catch((error: unknown) =>
      ctx.logger.error(`disk alert delivery failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  const sweep = async (): Promise<Omit<DiskGuardRun, 'usedPct' | 'level' | 'deleted' | 'errors'> & { lookupError?: string }> => {
    const { layout } = options;
    const at = now();
    const rules = defaultRetentionRules(layout);
    const cwds = await liveCwds();
    const dirs = new Map<string, Awaited<ReturnType<typeof readEntries>>>();
    const sizes = new Map<string, number>();
    for (const rule of rules) {
      if (rule.kind === 'size_cap') {
        const bytes = await measureBytes(rule.path);
        if (bytes !== undefined) sizes.set(rule.path, bytes);
      } else if (!dirs.has(rule.dir)) {
        const managedTmp = rule.dir === join(layout.dataDir, 'tmp');
        dirs.set(rule.dir, await readEntries(rule.dir, managedTmp ? 5 : 2));
      }
    }
    const plan = planRetention(rules, { dirs, sizes, pinned: await readPinned(rules), liveCwds: cwds }, at);
    const planned = [...plan.delete];
    const flagged: KeptEntry[] = [];

    const lookup = await options.sessions();
    // Managed worktrees: removed alone; their allocation row turns `missing`
    // at the next reconciliation, and the worktree entity is never touched.
    for (const path of await managedCheckouts(join(layout.dataDir, 'worktrees'))) {
      const facts = await probeCheckout(path, lookup.find({ workdirPath: path }), at);
      const decision = classifyCheckout(facts, cwds);
      if (decision.action === 'remove') planned.push({ path, rule: 'worktree', reason: decision.reason });
      if (decision.action === 'flag') flagged.push({ path, rule: 'worktree', reason: decision.reason });
    }
    // Scratch dirs are named for the session that made them.
    const scratchRoot = join(layout.dataDir, 'scratch');
    for (const entry of await readEntries(scratchRoot)) {
      if (!entry.isDir) continue;
      const { path, name } = entry;
      const session = UUID.test(name) ? lookup.find({ id: name }) : { state: 'unknown' as const, endedAt: null };
      const raw = await scratchChildren(path);
      const children: ScratchChild[] = [];
      const nestedRegenerable: string[] = [];
      for (const child of raw) {
        if (child.kind === 'checkout') {
          const facts = await probeCheckout(child.path, session.state === 'unknown' ? lookup.find({ workdirPath: child.path }) : session, at);
          const decision = classifyCheckout(facts, cwds);
          children.push({ path: child.path, kind: 'checkout', decision });
          nestedRegenerable.push(...await ignoredRegenerable(child.path));
        } else if (child.kind === 'other') {
          // A plain dir can still hold a checkout further down: it decides for the dir.
          const inner = await nestedCheckouts(child.path, 2);
          const decisions = await Promise.all(inner.map(async (p) => classifyCheckout(await probeCheckout(p, session, at), cwds)));
          const blocking = decisions.find((d) => d.action !== 'remove');
          children.push(blocking ? { path: child.path, kind: 'checkout', decision: blocking } : child);
        } else {
          children.push(child);
        }
      }
      const scratch = planScratchDir({
        path, session: session.state, endedForMs: session.endedAt === null ? null : at - session.endedAt,
        idleMs: at - entry.mtimeMs, children, nestedRegenerable,
      }, cwds);
      planned.push(...scratch.delete);
      flagged.push(...scratch.flagged);
    }
    return { planned, flagged, ...(lookup.error ? { lookupError: lookup.error } : {}) };
  };

  return {
    name: DISK_GUARD_JOB_NAME,
    intervalMs: options.intervalMs ?? 30 * 60_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 20 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      const before = await usage(options.layout.dataDir);
      const { planned, flagged, lookupError } = await sweep();
      const deleted: PlannedDeletion[] = [];
      const errors: Array<{ path: string; message: string }> = [];
      if (lookupError) {
        ctx.logger.warn(`disk-guard: ${lookupError}; every session treated as unknown`);
        errors.push({ path: '(sessions)', message: lookupError });
      }
      if (options.mode === 'apply') {
        for (const item of planned) {
          if (ctx.signal.aborted) break;
          try {
            await remove(item.path);
            deleted.push(item);
            ctx.logger.info(`disk-guard removed ${item.path} (${item.rule}: ${item.reason})`);
          } catch (error) {
            errors.push({ path: item.path, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const usedPct = options.mode === 'apply' && deleted.length ? await usage(options.layout.dataDir) : before;
      const level = usedPct === null ? 'ok' : diskLevel(usedPct, thresholds);

      const fresh = flagged.filter((f) => !flaggedSent.has(f.path));
      for (const f of fresh) ctx.logger.warn(`disk-guard kept ${f.path}: ${f.reason}`);
      if (usedPct !== null && shouldAlert(memory, level, now())) {
        const text = level === 'ok'
          ? `Disk back to ${usedPct}% used on ${options.layout.dataDir}.`
          : `Disk ${usedPct}% used on ${options.layout.dataDir} (${level}; alert at ${thresholds.warnPct}%, critical at ${thresholds.criticalPct}%). `
            + `Retention removed ${deleted.length} item(s) this run; ${flagged.length} checkout(s) hold unpushed or uncommitted work.`;
        await send(ctx, { level, usedPct, text });
        memory.sentAt = now();
      }
      memory.level = level;
      if (fresh.length) {
        await send(ctx, { level, usedPct: usedPct ?? 0, text: `Kept ${fresh.length} ended session checkout(s) with work on no remote: `
          + fresh.slice(0, 10).map((f) => `${f.path} (${f.reason})`).join('; ') + (fresh.length > 10 ? '; ...' : '') });
        for (const f of fresh) flaggedSent.add(f.path);
      }
      return {
        affected: deleted.length,
        detail: {
          mode: options.mode, usedPct, level,
          planned: planned.length, deleted: deleted.slice(0, 50), flagged: flagged.slice(0, 50), errors: errors.slice(0, 20),
          // In report mode, what `apply` would remove: the list to read before switching it on.
          ...(options.mode === 'report' ? { wouldDelete: planned.slice(0, 200) } : {}),
        },
      };
    },
  };
}
