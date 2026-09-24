import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discoverSkillFiles, type SkillRoots } from '../../src/skills/discovery.js';
import { parseSkillFile } from '../../src/skills/parse.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-skills-')); dirs.push(dir);
  const put = async (path: string, body = '---\nname: demo\ndescription: A useful skill\n---\nPRIVATE BODY') => { const p = join(dir, path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); return p; };
  const roots: SkillRoots = { homes: [join(dir, 'home')], projects: [{ id: 'project', workingDir: join(dir, 'repo') }], codexAdminDir: join(dir, 'admin') };
  return { dir, put, roots };
}
describe('filesystem skill discovery', () => {
  it('preserves same-name copies and stops nested scans at other projects and git roots', async () => {
    const { dir, put, roots } = await fixture();
    for (const path of ['repo/.claude/skills/demo/SKILL.md', 'repo/.agents/skills/demo/SKILL.md', 'repo/src/.claude/skills/demo/SKILL.md', 'repo/other/.claude/skills/demo/SKILL.md', 'repo/git/.claude/skills/demo/SKILL.md']) await put(path);
    await put('repo/git/.git', 'gitdir: elsewhere');
    roots.projectBoundaries = [join(dir, 'repo/other')];
    const found = await discoverSkillFiles(roots);
    expect(found.candidates.map(c => c.level).sort()).toEqual(['nested', 'project', 'project']);
    expect(found.candidates.find(c => c.level === 'nested')?.root).toBe('src');
  });
  it('treats home projects as user scope, finds all providers, and honors disabled plugins and Codex paths', async () => {
    const { dir, put, roots } = await fixture();
    roots.projects.push({ id: 'home-project', workingDir: join(dir, 'home') });
    for (const path of ['home/.claude/skills/demo/SKILL.md', 'home/.claude/skills/synced/demo/SKILL.md', 'home/.agents/skills/demo/SKILL.md', 'home/.codex/skills/demo/SKILL.md', 'home/.codex/skills/.system/demo/SKILL.md', 'home/.hermes/skills/category/demo/SKILL.md', 'home/.claude/plugins/marketplaces/store/plugins/tool/skills/demo/SKILL.md', 'home/projects/nope/.claude/skills/demo/SKILL.md']) await put(path);
    const disabled = await put('repo/.agents/skills/demo/SKILL.md');
    await put('home/.codex/config.toml', `[[skills.config]]\npath = ${JSON.stringify(disabled)}\nenabled = false\n`);
    const found = await discoverSkillFiles(roots);
    expect(found.candidates).toHaveLength(8);
    expect(found.candidates.find(c => c.path === disabled)?.enabled).toBe(false);
    expect(found.candidates.find(c => c.level === 'plugin')?.enabled).toBe(false);
    expect(found.candidates.filter(c => c.level === 'user')).toHaveLength(4);
    expect(found.candidates.some(c => c.path.includes('/nope/'))).toBe(false);
  });
  it('parses legacy commands, tolerant frontmatter, sidecars and bundle counts without returning bodies', async () => {
    const { put, roots } = await fixture();
    await put('repo/.claude/commands/old.md', 'Legacy body');
    await put('repo/.agents/skills/demo/SKILL.md', '---\nname: demo\ndescription: >-\n  Multi line\n  description\nunknown: [one, two]\n---\nPRIVATE BODY');
    await put('repo/.agents/skills/demo/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\ninterface:\n  display_name: Demo');
    await put('repo/.agents/skills/demo/scripts/run.sh', 'echo hi');
    await put('repo/.claude/skills/broken/SKILL.md', '---\nname: [broken\n---\nPRIVATE BODY');
    const result = await discoverSkillFiles(roots);
    const parsed = await Promise.all(result.candidates.map(parseSkillFile));
    const demo = parsed.find(c => c.provider === 'agents')!;
    expect(demo.description).toBe('Multi line description');
    expect(demo.frontmatter.unknown).toEqual(['one', 'two']);
    expect(demo.sidecar.policy).toEqual({ allow_implicit_invocation: false });
    expect(demo.bundleCounts.scripts).toBe(1);
    expect(demo.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE BODY');
    expect(parsed.find(c => c.legacy)?.name).toBe('old');
    expect(parsed.find(c => c.name === 'broken')?.warnings.length).toBeGreaterThan(0);
  });
  it('discovers claude.ai-synced plugin skills keyed <name>@synced, on unless settings turn the id off', async () => {
    const { dir, put, roots } = await fixture();
    const bucket = 'home/.claude/plugins/synced/org_user';
    await put(`${bucket}/manifest.json`, JSON.stringify({ plugins: [{ name: 'sales', marketplaceName: 'knowledge-work-plugins' }, { name: 'ops' }, { name: '../escape' }] }));
    await put(`${bucket}/sales/skills/forecast/SKILL.md`);
    await put(`${bucket}/ops/skills/runbook/SKILL.md`);
    await put(`${bucket}/unlisted/skills/stray/SKILL.md`);
    await put('home/.claude/plugins/synced/no-manifest/x/skills/y/SKILL.md');
    await put('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ops@synced': false } }));
    const found = await discoverSkillFiles(roots);
    const plugins = found.candidates.filter(c => c.level === 'plugin');
    expect(plugins.map(c => ({ path: c.path.slice(dir.length + 1), pluginName: c.pluginName, root: c.root, enabled: c.enabled, provider: c.provider }))).toEqual([
      { path: `${bucket}/sales/skills/forecast/SKILL.md`, pluginName: 'sales@synced', root: 'sales@synced', enabled: true, provider: 'claude' },
      { path: `${bucket}/ops/skills/runbook/SKILL.md`, pluginName: 'ops@synced', root: 'ops@synced', enabled: false, provider: 'claude' },
    ]);
    expect(found.scanRoots).toContain(join(dir, 'home/.claude/plugins/synced'));
  });
});
