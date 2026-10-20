/**
 * Disk retention: what this node may delete on its own, decided from facts.
 *
 * The root disk filled to 97% (Postgres lives on it) from things nothing ever
 * removed: agent worktrees and scratch dirs, Vitest's per-run module dumps in
 * /tmp, deploy candidates with DB dumps beside them, previous builds, package
 * caches. One manual cleanup freed 6 GB; this file is the rule set that makes
 * the next one unnecessary. It is PURE: the inventory comes in, a plan goes
 * out, and `disk-inventory.ts` / the `ops.disk-guard` job do the I/O.
 *
 * What it will never do, in the order the temptations arrive:
 *
 *   * Delete work that exists nowhere else. A worktree or clone is removed
 *     only when it is clean and every commit is on a remote; anything else is
 *     FLAGGED and left exactly as found.
 *   * Touch something a live process is using. A path that is, or contains,
 *     the cwd of a running process is kept, whatever its age.
 *   * Guess a session is over. A worktree whose session cannot be found waits
 *     `unknownOwnerIdleMs` of complete inactivity before it is even considered.
 *   * Delete what a pointer names. `LAST_*` / `*_TREE` files in a deploy dir
 *     pin the path they contain.
 */

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

/** One directory entry, as `disk-inventory.ts` reads it. */
export interface InventoryEntry {
  path: string;
  name: string;
  isDir: boolean;
  /** Newest mtime of the entry and its first levels; a dir touched inside is not idle. */
  mtimeMs: number;
  /** Child names, for the shape checks (`client`/`ssr` for Vitest dumps). Dirs only. */
  children?: readonly string[];
}

/** Keep the newest `keep` matches; delete older ones once they are `minAgeMs` old. */
export interface KeepNewestRule {
  kind: 'keep_newest';
  id: string;
  dir: string;
  match: RegExp;
  keep: number;
  minAgeMs: number;
}

/** Delete matches older than `maxAgeMs`. `shape` narrows by content. */
export interface MaxAgeRule {
  kind: 'max_age';
  id: string;
  dir: string;
  match: RegExp;
  maxAgeMs: number;
  /** `vitest_dump`: a dir holding only `client` / `ssr` (Vitest 4's module dump). */
  shape?: 'vitest_dump';
}

/** A regenerable cache: wiped whole when it outgrows `maxBytes`. */
export interface SizeCapRule {
  kind: 'size_cap';
  id: string;
  path: string;
  maxBytes: number;
}

export type RetentionRule = KeepNewestRule | MaxAgeRule | SizeCapRule;

export interface RetentionInventory {
  /** Entries per rule dir. A missing dir is simply absent. */
  dirs: ReadonlyMap<string, readonly InventoryEntry[]>;
  /** Measured size per size-cap path. Absent = not measured (never "zero"). */
  sizes: ReadonlyMap<string, number>;
  /** Paths named by pointer files (`LAST_BACKUP`, `UI_ROLLBACK_TREE`, ...). */
  pinned: ReadonlySet<string>;
  /** cwd of every process this user can see. */
  liveCwds: readonly string[];
}

export interface PlannedDeletion {
  path: string;
  rule: string;
  reason: string;
}

export interface KeptEntry {
  path: string;
  rule: string;
  reason: string;
}

export interface RetentionPlan {
  delete: PlannedDeletion[];
  kept: KeptEntry[];
}

/** True when `path` is `cwd` or one of its ancestors: deleting it pulls the floor from under a process. */
export function holdsLiveCwd(path: string, liveCwds: readonly string[]): boolean {
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return liveCwds.some((cwd) => cwd === path || cwd.startsWith(prefix));
}

function age(entry: InventoryEntry, now: number): number {
  return now - entry.mtimeMs;
}

function hours(ms: number): string {
  return ms >= 2 * DAY ? `${Math.round(ms / DAY)}d` : `${Math.round(ms / HOUR)}h`;
}

/**
 * How new an entry is, for "keep the newest N". A UTC stamp in the name
 * (`prod-prev.20260917T170401Z`) wins over mtime: `mv` keeps a build's old
 * mtime, so by mtime a September rollback can look older than an August one.
 */
export function recency(entry: InventoryEntry): number {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(entry.name);
  const stamped = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : NaN;
  return Number.isFinite(stamped) ? stamped : entry.mtimeMs;
}

function isVitestDump(entry: InventoryEntry): boolean {
  const children = entry.children ?? [];
  return entry.isDir && children.length > 0 && children.every((c) => c === 'client' || c === 'ssr');
}

export function planRetention(
  rules: readonly RetentionRule[],
  inventory: RetentionInventory,
  now: number,
): RetentionPlan {
  const plan: RetentionPlan = { delete: [], kept: [] };
  const seen = new Set<string>();
  const propose = (path: string, rule: string, reason: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    if (inventory.pinned.has(path)) {
      plan.kept.push({ path, rule, reason: 'named by a LAST_*/..._TREE pointer' });
    } else if (holdsLiveCwd(path, inventory.liveCwds)) {
      plan.kept.push({ path, rule, reason: 'a running process has its cwd here' });
    } else {
      plan.delete.push({ path, rule, reason });
    }
  };

  for (const rule of rules) {
    if (rule.kind === 'size_cap') {
      const bytes = inventory.sizes.get(rule.path);
      if (bytes !== undefined && bytes > rule.maxBytes) {
        propose(rule.path, rule.id, `cache is ${gib(bytes)}, over its ${gib(rule.maxBytes)} cap`);
      }
      continue;
    }
    const entries = (inventory.dirs.get(rule.dir) ?? []).filter((e) => rule.match.test(e.name));
    if (rule.kind === 'max_age') {
      for (const entry of entries) {
        if (rule.shape === 'vitest_dump' && !isVitestDump(entry)) continue;
        if (age(entry, now) > rule.maxAgeMs) {
          propose(entry.path, rule.id, `untouched for ${hours(age(entry, now))} (limit ${hours(rule.maxAgeMs)})`);
        }
      }
      continue;
    }
    const newestFirst = [...entries].sort((a, b) => recency(b) - recency(a));
    newestFirst.slice(rule.keep).forEach((entry) => {
      if (age(entry, now) >= rule.minAgeMs) {
        propose(entry.path, rule.id, `older than the newest ${rule.keep}`);
      }
    });
  }
  return plan;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

// ---------------------------------------------------------------------------
// Worktrees and clones
// ---------------------------------------------------------------------------

export type SessionState = 'live' | 'ended' | 'unknown';

export interface CheckoutFacts {
  path: string;
  /** The session that owns it: found by id (scratch dir) or by workdir path. */
  session: SessionState;
  /** How long since the session ended; null when not ended or not known. */
  endedForMs: number | null;
  /** Newest mtime under the checkout (bounded walk). */
  idleMs: number;
  dirty: boolean;
  /** Commits reachable from HEAD and from no remote ref. */
  unpushed: number;
  /** HEAD could not be measured (no remotes, broken repo): treat as unpushed. */
  probeFailed?: string;
}

export interface CheckoutPolicy {
  /** After a session ends, how long its checkout is kept anyway (a quick resume). */
  endedGraceMs: number;
  /** A checkout with no known session must be idle this long before it is considered. */
  unknownOwnerIdleMs: number;
}

export const DEFAULT_CHECKOUT_POLICY: CheckoutPolicy = {
  endedGraceMs: 6 * HOUR,
  unknownOwnerIdleMs: 7 * DAY,
};

export type CheckoutDecision =
  | { action: 'remove'; reason: string }
  | { action: 'keep'; reason: string }
  /** Kept because it holds work nowhere else; reported so a human can act. */
  | { action: 'flag'; reason: string };

export function classifyCheckout(
  facts: CheckoutFacts,
  liveCwds: readonly string[],
  policy: CheckoutPolicy = DEFAULT_CHECKOUT_POLICY,
): CheckoutDecision {
  if (holdsLiveCwd(facts.path, liveCwds)) return { action: 'keep', reason: 'a running process has its cwd here' };
  if (facts.session === 'live') return { action: 'keep', reason: 'its session is still live' };
  if (facts.session === 'ended') {
    const ended = facts.endedForMs ?? 0;
    if (ended < policy.endedGraceMs || facts.idleMs < policy.endedGraceMs) {
      return { action: 'keep', reason: `session ended ${hours(ended)} ago; grace is ${hours(policy.endedGraceMs)}` };
    }
  } else if (facts.idleMs < policy.unknownOwnerIdleMs) {
    return { action: 'keep', reason: `no known session; idle ${hours(facts.idleMs)} of ${hours(policy.unknownOwnerIdleMs)}` };
  }
  // From here the owner is gone. Only the work itself can keep it.
  if (facts.probeFailed) return { action: 'flag', reason: `could not prove the work is pushed: ${facts.probeFailed}` };
  if (facts.dirty) return { action: 'flag', reason: 'uncommitted changes' };
  if (facts.unpushed > 0) {
    return { action: 'flag', reason: `${facts.unpushed} commit${facts.unpushed === 1 ? '' : 's'} on no remote` };
  }
  return {
    action: 'remove',
    reason: facts.session === 'ended' ? 'session ended; clean and pushed' : 'no session, idle, clean and pushed',
  };
}

// ---------------------------------------------------------------------------
// Scratch dirs: <dataDir>/scratch/<sessionId>
// ---------------------------------------------------------------------------

export interface ScratchChild {
  path: string;
  /** `checkout`: a git worktree or clone, decided by `classifyCheckout`. */
  kind: 'checkout' | 'regenerable' | 'symlink' | 'other';
  decision?: CheckoutDecision;
}

export interface ScratchFacts {
  path: string;
  session: SessionState;
  endedForMs: number | null;
  idleMs: number;
  children: readonly ScratchChild[];
  /** `node_modules`, `dist`, `.vite` dirs found inside checkouts (depth-bounded). */
  nestedRegenerable: readonly string[];
}

export interface ScratchPolicy extends CheckoutPolicy {
  /** Loose files (logs, notes, downloads) of an ended session are kept this long. */
  looseFilesMs: number;
}

export const DEFAULT_SCRATCH_POLICY: ScratchPolicy = { ...DEFAULT_CHECKOUT_POLICY, looseFilesMs: 30 * DAY };

export interface ScratchPlan {
  delete: PlannedDeletion[];
  flagged: KeptEntry[];
  kept: KeptEntry[];
}

/**
 * A session's scratch dir goes once the session is over and nothing in it is
 * unique: clean, pushed checkouts are removed, `node_modules` and build output
 * are regenerable, and loose files expire after `looseFilesMs`. A checkout
 * with unpushed or uncommitted work keeps the dir, and is flagged.
 */
export function planScratchDir(
  facts: ScratchFacts,
  liveCwds: readonly string[],
  policy: ScratchPolicy = DEFAULT_SCRATCH_POLICY,
): ScratchPlan {
  const plan: ScratchPlan = { delete: [], flagged: [], kept: [] };
  const rule = 'scratch';
  if (holdsLiveCwd(facts.path, liveCwds)) {
    plan.kept.push({ path: facts.path, rule, reason: 'a running process has its cwd here' });
    return plan;
  }
  const over = facts.session === 'ended'
    ? (facts.endedForMs ?? 0) >= policy.endedGraceMs && facts.idleMs >= policy.endedGraceMs
    : facts.session === 'unknown' && facts.idleMs >= policy.unknownOwnerIdleMs;
  if (!over) {
    plan.kept.push({ path: facts.path, rule, reason: facts.session === 'live' ? 'its session is still live' : 'not idle long enough' });
    return plan;
  }
  const blocking = facts.children.filter((c) => c.kind === 'checkout' && c.decision?.action !== 'remove');
  const loose = facts.children.filter((c) => c.kind === 'other');
  const looseExpired = facts.idleMs >= policy.looseFilesMs;
  for (const child of blocking) {
    const entry = { path: child.path, rule, reason: child.decision?.reason ?? 'undecided' };
    if (child.decision?.action === 'flag') plan.flagged.push(entry);
    else plan.kept.push(entry);
  }
  if (!blocking.length && (!loose.length || looseExpired)) {
    plan.delete.push({ path: facts.path, rule, reason: loose.length
      ? `session over; checkouts clean and pushed; loose files untouched for ${hours(facts.idleMs)}`
      : 'session over; checkouts clean and pushed' });
    return plan;
  }
  // The dir stays, for its unique work or its loose files. What is regenerable
  // or already on a remote still goes.
  for (const child of facts.children) {
    if (child.kind === 'regenerable') plan.delete.push({ path: child.path, rule, reason: 'regenerable build/dependency output' });
    if (child.kind === 'checkout' && child.decision?.action === 'remove') {
      plan.delete.push({ path: child.path, rule, reason: child.decision.reason });
    }
  }
  for (const nested of facts.nestedRegenerable) {
    if (!plan.delete.some((d) => nested.startsWith(`${d.path}/`))) {
      plan.delete.push({ path: nested, rule, reason: 'regenerable build/dependency output' });
    }
  }
  if (loose.length && !looseExpired) {
    plan.kept.push({ path: facts.path, rule, reason: `${loose.length} loose file(s), kept ${hours(policy.looseFilesMs)} after the session` });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Disk alert
// ---------------------------------------------------------------------------

export type DiskLevel = 'ok' | 'warn' | 'critical';

export interface DiskThresholds {
  warnPct: number;
  criticalPct: number;
}

export const DEFAULT_DISK_THRESHOLDS: DiskThresholds = { warnPct: 85, criticalPct: 92 };

export function diskLevel(usedPct: number, t: DiskThresholds = DEFAULT_DISK_THRESHOLDS): DiskLevel {
  if (usedPct >= t.criticalPct) return 'critical';
  if (usedPct >= t.warnPct) return 'warn';
  return 'ok';
}

export interface AlertMemory {
  level: DiskLevel;
  /** When an alert was last SENT, not when the level was last seen. */
  sentAt: number | null;
}

/**
 * Alert on every rise, on recovery, and again every `repeatMs` while it stays
 * above warn. A full disk that alerts once and then goes quiet for a week is
 * how it reached 97%; one that alerts every 30 minutes is how alerts get muted.
 */
export function shouldAlert(previous: AlertMemory, level: DiskLevel, now: number, repeatMs: number = 6 * HOUR): boolean {
  const rank = { ok: 0, warn: 1, critical: 2 } as const;
  if (rank[level] > rank[previous.level]) return true;
  if (level === 'ok') return previous.level !== 'ok';
  return previous.sentAt === null || now - previous.sentAt >= repeatMs;
}

// ---------------------------------------------------------------------------
// The default rule set for this node's layout
// ---------------------------------------------------------------------------

export interface RetentionLayout {
  /** e.g. /opt/tm8: holds prod, staging, prod-prev.*, candidates/. Null: no deploy rules. */
  deployRoot: string | null;
  /** The server's data dir. Its `tmp/` is the managed TMPDIR. */
  dataDir: string;
  /** The user's home, for package caches. Null: not this server's to sweep. */
  home: string | null;
  /** The system temp dir (`/tmp`). Null: not this server's to sweep. */
  systemTmp: string | null;
}

const GiB = 1024 ** 3;
const DUMP = /\.(dump|sql|sql\.gz|pgdump)$/;
const NOT_DUMP = /^(?!.*\.(dump|sql|sql\.gz|pgdump)$)/;

export function defaultRetentionRules(layout: RetentionLayout): RetentionRule[] {
  const rules: RetentionRule[] = [];
  const managedTmp = `${layout.dataDir}/tmp`;
  const tmp = layout.systemTmp;
  // Vitest 4 writes a module dump to $TMPDIR/<nanoid>/{client,ssr} per run and
  // removes it only on a clean close; every killed run leaks 35-90 MB.
  for (const dir of tmp ? [tmp, managedTmp] : [managedTmp]) {
    rules.push({ kind: 'max_age', id: 'tmp.vitest-dump', dir, match: /^[A-Za-z0-9_-]{21}$/, maxAgeMs: 6 * HOUR, shape: 'vitest_dump' });
  }
  // Everything sessions write to their managed TMPDIR.
  rules.push({ kind: 'max_age', id: 'tmp.managed', dir: managedTmp, match: /^/, maxAgeMs: 2 * DAY });
  if (tmp) {
    rules.push(
      { kind: 'max_age', id: 'tmp.smoke', dir: tmp, match: /^tm8-smoke-/, maxAgeMs: 2 * DAY },
      { kind: 'size_cap', id: 'cache.node-compile', path: `${tmp}/node-compile-cache`, maxBytes: 1 * GiB },
    );
  }
  const home = layout.home;
  if (home) {
    // Regenerable caches: wiped whole when over their cap, refilled on next use.
    rules.push(
      { kind: 'size_cap', id: 'cache.npm', path: `${home}/.npm/_cacache`, maxBytes: 1 * GiB },
      { kind: 'size_cap', id: 'cache.pnpm', path: `${home}/.cache/pnpm`, maxBytes: 1 * GiB },
      { kind: 'size_cap', id: 'cache.bun', path: `${home}/.bun/install/cache`, maxBytes: 4 * GiB },
    );
  }
  const root = layout.deployRoot;
  if (root) {
    rules.push(
      // Previous builds: one rollback is the point; three is a museum.
      { kind: 'keep_newest', id: 'deploy.prod-prev', dir: root, match: /^prod-prev\./, keep: 2, minAgeMs: 1 * DAY },
      { kind: 'keep_newest', id: 'deploy.staging-prev', dir: root, match: /^staging-prev\./, keep: 1, minAgeMs: 1 * DAY },
      { kind: 'keep_newest', id: 'deploy.failed', dir: root, match: /^(prod|staging|private)-failed\./, keep: 1, minAgeMs: 3 * DAY },
      { kind: 'keep_newest', id: 'deploy.ui-candidate', dir: root, match: /^ui-candidate-/, keep: 2, minAgeMs: 3 * DAY },
      { kind: 'keep_newest', id: 'deploy.rollbacks', dir: `${root}/rollbacks`, match: /^/, keep: 2, minAgeMs: 7 * DAY },
      { kind: 'keep_newest', id: 'deploy.ui-rollbacks', dir: `${root}/ui-rollbacks`, match: /^/, keep: 2, minAgeMs: 7 * DAY },
      // Candidates are staging for ONE deploy. A DB dump there is never the
      // backup of record, so it is not kept past the deploy's aftermath.
      { kind: 'max_age', id: 'deploy.candidate-dump', dir: `${root}/candidates`, match: DUMP, maxAgeMs: 3 * DAY },
      { kind: 'keep_newest', id: 'deploy.candidates', dir: `${root}/candidates`, match: NOT_DUMP, keep: 4, minAgeMs: 3 * DAY },
      // Pre-deploy dumps: the newest few are the rollback story; LAST_BACKUP pins its own.
      { kind: 'keep_newest', id: 'deploy.backup-dumps', dir: `${root}/deploy-backups`, match: DUMP, keep: 3, minAgeMs: 7 * DAY },
      { kind: 'keep_newest', id: 'deploy.ui-dist-backups', dir: `${root}/deploy-backups`, match: /^tm8-ui-dist/, keep: 2, minAgeMs: 7 * DAY },
    );
  }
  if (home) {
    rules.push({ kind: 'keep_newest', id: 'home.backup-dumps', dir: `${home}/backups`, match: DUMP, keep: 5, minAgeMs: 7 * DAY });
  }
  return rules;
}

/** Pointer files whose content pins a path (`LAST_BACKUP`, `UI_ROLLBACK_TREE`). */
export const POINTER_FILE = /^(LAST_[A-Z_]+|[A-Z_]*_TREE)$/;

/** Every absolute path named in a pointer file's text. */
export function pinnedPaths(text: string): string[] {
  return [...text.matchAll(/(\/[^\s'"]+)/g)].map((m) => m[1]!.replace(/\/+$/, ''));
}
