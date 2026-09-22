import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills, SkillScanDebouncer, type SkillScanStore } from '../../src/skills/scanner.js';
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
