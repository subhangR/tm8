import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillDestination, writeSkillFile, renderSkillFile } from '../../src/skills/authoring.js';
import { discoverSkillFiles } from '../../src/skills/discovery.js';
import { parseSkillFile } from '../../src/skills/parse.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'tm8-author-')); dirs.push(dir); return dir; }
it('writes a discoverable skill and refreshes metadata after editing', async () => {
 const root = await temp(); const path = skillDestination(root, 'agents', 'demo');
 await writeSkillFile(root, path, { name: 'demo', description: 'before', body: 'First body' }, true);
 const discovery = await discoverSkillFiles({ projects: [{ id: 'p', workingDir: root }], homes: [], codexAdminDir: join(root, 'absent') });
 const before = await parseSkillFile(discovery.candidates[0]!);
 expect(before.description).toBe('before');
 await writeSkillFile(root, path, { description: 'after', body: 'Second body' }, false, before.contentHash);
 const after = await parseSkillFile(discovery.candidates[0]!);
 expect(after.description).toBe('after'); expect(after.contentHash).not.toBe(before.contentHash);
 await expect(writeSkillFile(root, path, { body: 'stale' }, false, before.contentHash)).rejects.toMatchObject({ code: 'conflict' });
 expect(await readFile(path, 'utf8')).toContain('Second body');
 await expect(writeSkillFile(root, path, {}, true)).rejects.toMatchObject({ code: 'EEXIST' });
});
it('preserves unknown nested frontmatter while updating supported fields', () => {
 const next = renderSkillFile('---\nname: old\nx-private:\n  flag: true\n---\nOriginal', { name: 'new' });
 expect(next).toContain('flag: true'); expect(next).toContain('name: new'); expect(next).toContain('Original');
});
it('rejects traversal, destination symlinks and escaped roots', async () => {
 const root = await temp(); const outside = await temp();
 expect(() => skillDestination(root, 'agents', '../escape')).toThrow();
 await mkdir(join(root, '.agents')); await symlink(outside, join(root, '.agents/skills'));
 await expect(writeSkillFile(root, skillDestination(root, 'agents', 'demo'), {}, true)).rejects.toMatchObject({ code: 'forbidden' });
 await expect(writeSkillFile(root, join(outside, 'SKILL.md'), {}, true)).rejects.toMatchObject({ code: 'forbidden' });
});
