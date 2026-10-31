import { relative, isAbsolute } from 'node:path';
import { discoverSkillFiles, type SkillRoots } from './discovery.js';
import { parseSkillFile, type ParsedSkillFile } from './parse.js';

export interface SkillScanStore {
  listReferences(): Promise<Array<{ id: string; sourcePath: string; missing: boolean }>>;
  upsert(file: ParsedSkillFile, scannedAt: string): Promise<void>;
  markMissing(ids: string[], scannedAt: string): Promise<void>;
}
export interface SkillScanContext { store: SkillScanStore; roots: SkillRoots }
export interface SkillScanResult {
  scannedAt: string; discovered: number; upserted: number; missing: number;
  errors: Array<{ path: string; error: string }>; skipped?: boolean;
}
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** A scan failure never turns an unreadable subtree into missing references. */
export async function scanSkills(context: SkillScanContext): Promise<SkillScanResult> {
  const scannedAt = new Date().toISOString();
  const discovery = await discoverSkillFiles(context.roots);
  const result: SkillScanResult = { scannedAt, discovered: discovery.candidates.length, upserted: 0, missing: 0, errors: [...discovery.errors] };
  const seen = new Set(discovery.candidates.map(c => c.path));
  for (const candidate of discovery.candidates) {
    try { await context.store.upsert(await parseSkillFile(candidate), scannedAt); result.upserted++; }
    catch (error) { result.errors.push({ path: candidate.path, error: String(error) }); }
  }
  const boundaries = context.roots.projectBoundaries ?? [];
  const selected = new Set(context.roots.projects.map(p => p.workingDir));
  const missing = (await context.store.listReferences()).filter(row =>
    !row.missing && !seen.has(row.sourcePath) &&
    !discovery.excludedRoots.some(root => within(row.sourcePath, root)) &&
    (discovery.scanRoots.some(root => within(row.sourcePath, root)) ||
      discovery.nestedRoots.some(root => {
        const parts = relative(root, row.sourcePath).split('/');
        const prefix = parts.slice(0, -4);
        return prefix.length > 0 && prefix.every(p => p && !p.startsWith('.') && !['node_modules', 'vendor'].includes(p)) &&
          parts.at(-4) === '.claude' && parts.at(-3) === 'skills' &&
          !parts.at(-2)!.startsWith('.') && parts.at(-1) === 'SKILL.md';
      })) &&
    !boundaries.some(root => !selected.has(root) && within(row.sourcePath, root)) &&
    !result.errors.some(error => within(row.sourcePath, error.path)),
  );
  if (missing.length) { await context.store.markMissing(missing.map(r => r.id), scannedAt); result.missing = missing.length; }
  return result;
}

/** Where a launch's skill set came from: this scan, a cached one, or the rows an earlier process wrote. */
export type SkillScanServed = 'scanned' | 'cached' | 'persisted';
export interface ServedSkillScan { scannedAt: string | null; served: SkillScanServed; refreshing: boolean }
export interface SkillScanDebouncerOptions {
  /** A cached scan older than this is refreshed by the next caller (in the background for `serve`). */
  intervalMs?: number;
  /**
   * The staleness bound. The sweep runs every `maxStaleMs / 2` and refreshes a
   * key served in the last `activeMs` whose scan is `maxStaleMs` old, so its
   * references are never older than 1.5 × `maxStaleMs` plus one scan. A key
   * idle for longer than `activeMs` leaves the sweep: its next launch serves
   * the last scan, however old (its `scannedAt` says so), and refreshes.
   */
  maxStaleMs?: number;
  activeMs?: number;
  now?: () => number;
  onBackgroundError?: (key: string, error: unknown) => void;
}

/**
 * Successful scans are debounced; overlapping callers share the same promise.
 *
 * `run` is the inline path (mutations, project links, the explicit rescan).
 * `serve` is the launch path, stale-while-revalidate: a key with a cached
 * scan — this process's, or the rows a previous process persisted — answers
 * at once and refreshes in the background when older than `intervalMs`. Only
 * a key with nothing cached at all waits for its first scan. A skill added on
 * disk therefore reaches the briefing of a launch that starts after the next
 * refresh lands: the one the first launch `intervalMs` after the last scan
 * starts, or the sweep's (`maxStaleMs`), whichever comes first.
 */
export class SkillScanDebouncer {
  private readonly recent = new Map<string, { at: number; result: SkillScanResult }>();
  private readonly pending = new Map<string, Promise<SkillScanResult>>();
  private readonly served = new Map<string, { at: number; scan: () => Promise<SkillScanResult> }>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly maxStaleMs: number;
  private readonly activeMs: number;
  private readonly now: () => number;
  private readonly onBackgroundError: (key: string, error: unknown) => void;
  constructor(options: number | SkillScanDebouncerOptions = {}) {
    const o = typeof options === 'number' ? { intervalMs: options } : options;
    this.intervalMs = o.intervalMs ?? 30_000;
    this.maxStaleMs = o.maxStaleMs ?? 5 * 60_000;
    this.activeMs = o.activeMs ?? 60 * 60_000;
    this.now = o.now ?? Date.now;
    this.onBackgroundError = o.onBackgroundError ?? ((key, error) =>
      console.warn(`[tm8:skills] background skill scan failed for ${key}: ${error instanceof Error ? error.message : String(error)}`));
  }
  async run(key: string, scan: () => Promise<SkillScanResult>, force = false): Promise<SkillScanResult> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const recent = this.recent.get(key);
    if (!force && recent && this.now() - recent.at < this.intervalMs) return { ...recent.result, skipped: true };
    const promise = scan().then(result => { if (!result.errors.length) this.recent.set(key, { at: this.now(), result }); return result; });
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
  /**
   * The launch path. `persisted` answers whether an earlier process left this
   * key's references in the store (and when it last saw them); it is read only
   * when this process holds no scan for the key.
   */
  async serve(key: string, scan: () => Promise<SkillScanResult>, persisted: () => Promise<string | null>): Promise<ServedSkillScan> {
    this.served.set(key, { at: this.now(), scan });
    this.startSweeper();
    const recent = this.recent.get(key);
    if (recent) {
      const refreshing = this.now() - recent.at >= this.intervalMs ? this.revalidate(key) : this.pending.has(key);
      return { scannedAt: recent.result.scannedAt, served: 'cached', refreshing };
    }
    if (!this.pending.has(key)) {
      const persistedAt = await persisted();
      if (persistedAt !== null) return { scannedAt: persistedAt, served: 'persisted', refreshing: this.revalidate(key) };
    }
    // Nothing cached anywhere (or the first scan is already in flight): the
    // briefing has no skill set to describe until that scan lands.
    return { scannedAt: (await this.run(key, scan)).scannedAt, served: 'scanned', refreshing: false };
  }
  /** Refreshes every recently served key whose scan is older than the staleness bound. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.served) {
      if (now - entry.at > this.activeMs) { this.served.delete(key); continue; }
      const recent = this.recent.get(key);
      if (!recent || now - recent.at >= this.maxStaleMs) this.revalidate(key);
    }
    if (!this.served.size) this.stopSweeper();
  }
  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1_000, Math.floor(this.maxStaleMs / 2)));
    this.sweeper.unref?.();
  }
  private revalidate(key: string): boolean {
    if (this.pending.has(key)) return true;
    const entry = this.served.get(key);
    if (!entry) return false;
    this.run(key, entry.scan, true).catch(error => this.onBackgroundError(key, error));
    return true;
  }
}
