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
    discovery.scanRoots.some(root => within(row.sourcePath, root)) &&
    !boundaries.some(root => !selected.has(root) && within(row.sourcePath, root)) &&
    !result.errors.some(error => within(row.sourcePath, error.path)),
  );
  if (missing.length) { await context.store.markMissing(missing.map(r => r.id), scannedAt); result.missing = missing.length; }
  return result;
}

/** Successful scans are debounced; overlapping callers share the same promise. */
export class SkillScanDebouncer {
  private readonly recent = new Map<string, { at: number; result: SkillScanResult }>();
  private readonly pending = new Map<string, Promise<SkillScanResult>>();
  constructor(private readonly intervalMs = 30_000) {}
  async run(key: string, scan: () => Promise<SkillScanResult>, force = false): Promise<SkillScanResult> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const recent = this.recent.get(key);
    if (!force && recent && Date.now() - recent.at < this.intervalMs) return { ...recent.result, skipped: true };
    const promise = scan().then(result => { if (!result.errors.length) this.recent.set(key, { at: Date.now(), result }); return result; });
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
}
