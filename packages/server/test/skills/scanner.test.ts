import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills, SkillScanDebouncer, type SkillScanResult, type SkillScanStore } from '../../src/skills/scanner.js';
it('retains identity and edges when a file disappears and reappears; never persists bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tm8-scan-'));
  try {
    const dir = join(root, '.agents/skills/demo'); await mkdir(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    const body = '---\nname: demo\ndescription: Demo\n---\nBODY SECRET';
    await writeFile(path, body);
    const records = new Map<string, { id: string; sourcePath: string; missing: boolean; edges: string[] }>();
    const writes: unknown[] = [];
    const store: SkillScanStore = {
      async listReferences() { return [...records.values()]; },
      async upsert(file, scannedAt) { writes.push({ file, scannedAt }); const existing = records.get(file.path); records.set(file.path, { id: existing?.id ?? 'stable-id', sourcePath: file.path, missing: false, edges: existing?.edges ?? ['equips'] }); },
      async markMissing(ids) { for (const row of records.values()) if (ids.includes(row.id)) row.missing = true; },
    };
    const context = { roots: { projects: [{ id: 'p', workingDir: root }], homes: [], codexAdminDir: join(root, 'admin') }, store };
    expect((await scanSkills(context)).upserted).toBe(1);
    await rm(path);
    expect((await scanSkills(context)).missing).toBe(1);
    expect(records.get(path)).toMatchObject({ id: 'stable-id', missing: true, edges: ['equips'] });
    await writeFile(path, body);
    await scanSkills(context);
    expect(records.get(path)).toMatchObject({ id: 'stable-id', missing: false, edges: ['equips'] });
    expect(JSON.stringify(writes)).not.toContain('BODY SECRET');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('debounces successful scans and coalesces concurrent callers', async () => {
  const debounce = new SkillScanDebouncer(); let calls = 0;
  const scan = async () => { calls++; return { scannedAt: 'now', discovered: 0, upserted: 0, missing: 0, errors: [] }; };
  await Promise.all([debounce.run('p', scan), debounce.run('p', scan)]);
  expect(calls).toBe(1);
  expect((await debounce.run('p', scan)).skipped).toBe(true);
  await debounce.run('p', scan, true);
  expect(calls).toBe(2);
});
it('does not mark additional-dir agents skills missing during a project-only scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tm8-scan-scope-'));
  try {
    const subdir = join(root, 'subdir');
    const agents = join(subdir, '.agents/skills/demo');
    const claude = join(subdir, '.claude/skills/demo');
    await mkdir(agents, { recursive: true }); await mkdir(claude, { recursive: true });
    for (const dir of [agents, claude]) await writeFile(join(dir, 'SKILL.md'), '---\ndescription: Demo\n---\nBody');
    const records = new Map<string, { id: string; sourcePath: string; missing: boolean }>();
    const store: SkillScanStore = {
      async listReferences() { return [...records.values()]; },
      async upsert(file) { records.set(file.path, { id: file.path, sourcePath: file.path, missing: false }); },
      async markMissing(ids) { for (const row of records.values()) if (ids.includes(row.id)) row.missing = true; },
    };
    const roots = { projects: [{ id: 'p', workingDir: root }], homes: [], codexAdminDir: join(root, 'admin') };
    await scanSkills({ roots: { ...roots, additionalDirs: [subdir] }, store });
    expect((await scanSkills({ roots, store })).missing).toBe(0);
    // Even a removed agents skill is outside the project-only scan's coverage;
    // the deleted nested Claude skill IS in that coverage.
    await rm(subdir, { recursive: true });
    expect((await scanSkills({ roots, store })).missing).toBe(1);
    expect(records.get(join(agents, 'SKILL.md'))?.missing).toBe(false);
    expect(records.get(join(claude, 'SKILL.md'))?.missing).toBe(true);
    expect((await scanSkills({ roots: { ...roots, additionalDirs: [subdir] }, store })).missing).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
describe('serve: the launch path is stale-while-revalidate (D2)', () => {
  const result = (scannedAt: string): SkillScanResult => ({ scannedAt, discovered: 0, upserted: 0, missing: 0, errors: [] });
  function harness() {
    let clock = 0;
    const debounce = new SkillScanDebouncer({ intervalMs: 30_000, maxStaleMs: 300_000, activeMs: 3_600_000, now: () => clock });
    const scans: Array<() => void> = [];
    let calls = 0;
    // A scan that only finishes when the test says so: a launch that awaited
    // it would never settle.
    const scan = () => new Promise<SkillScanResult>(resolve => { calls++; const at = `scan-${calls}`; scans.push(() => resolve(result(at))); });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const settle = async () => { await tick(); scans.splice(0).forEach(done => done()); await tick(); };
    return { debounce, scan, settle, calls: () => calls, advance: (ms: number) => { clock += ms; } };
  }
  const none = async () => null;
  it('a launch after the debounce window answers from the cache without waiting on the scan', async () => {
    const h = harness();
    try {
      const first = h.debounce.serve('k', h.scan, none);
      await h.settle();
      expect(await first).toEqual({ scannedAt: 'scan-1', served: 'scanned', refreshing: false });
      h.advance(31_000);
      // The refresh this launch starts never settles here; the launch must still answer.
      const launch = await h.debounce.serve('k', h.scan, none);
      expect(launch).toEqual({ scannedAt: 'scan-1', served: 'cached', refreshing: true });
      expect(h.calls()).toBe(2);
      // A launch while that refresh runs shares it rather than starting another.
      expect(await h.debounce.serve('k', h.scan, none)).toMatchObject({ served: 'cached', refreshing: true });
      expect(h.calls()).toBe(2);
      // Once it lands, the next launch names the new scan.
      await h.settle();
      expect(await h.debounce.serve('k', h.scan, none)).toEqual({ scannedAt: 'scan-2', served: 'cached', refreshing: false });
    } finally { h.debounce.stopSweeper(); }
  });
  it('a key with only persisted references answers from them and refreshes in the background', async () => {
    const h = harness();
    try {
      const launch = await h.debounce.serve('k', h.scan, async () => '2026-10-30T00:00:00.000Z');
      expect(launch).toEqual({ scannedAt: '2026-10-30T00:00:00.000Z', served: 'persisted', refreshing: true });
      expect(h.calls()).toBe(1);
    } finally { h.debounce.stopSweeper(); }
  });
  it('the sweep keeps a recently launched key within the staleness bound', async () => {
    const h = harness();
    try {
      const first = h.debounce.serve('k', h.scan, none);
      await h.settle(); await first;
      h.advance(299_000); h.debounce.sweep();
      expect(h.calls()).toBe(1);
      h.advance(2_000); h.debounce.sweep();
      expect(h.calls()).toBe(2);
      await h.settle();
      expect(await h.debounce.serve('k', h.scan, none)).toMatchObject({ scannedAt: 'scan-2', refreshing: false });
      // A key nobody launched within activeMs drops out of the sweep.
      h.advance(3_600_001); h.debounce.sweep();
      expect(h.calls()).toBe(2);
    } finally { h.debounce.stopSweeper(); }
  });
  it('a failed background refresh is reported and the next launch retries', async () => {
    const errors: unknown[] = [];
    let clock = 0; let calls = 0;
    const debounce = new SkillScanDebouncer({ now: () => clock, onBackgroundError: (_key, error) => errors.push(error) });
    try {
      const scan = async () => { calls++; if (calls === 2) throw new Error('unreadable'); return result(`scan-${calls}`); };
      await debounce.serve('k', scan, none);
      clock += 31_000;
      expect(await debounce.serve('k', scan, none)).toMatchObject({ scannedAt: 'scan-1', refreshing: true });
      await new Promise(resolve => setImmediate(resolve));
      expect(errors).toHaveLength(1);
      await debounce.serve('k', scan, none);
      expect(calls).toBe(3);
    } finally { debounce.stopSweeper(); }
  });
});
