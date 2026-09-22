import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { parse as parseToml } from '@iarna/toml';

export type SkillProvider = 'claude' | 'agents' | 'codex' | 'hermes';
export type SkillLevel = 'system' | 'admin' | 'user' | 'project' | 'nested' | 'plugin' | 'synced' | 'session';
export interface SkillCandidate {
  path: string; provider: SkillProvider; level: SkillLevel; root: string;
  scanRoot: string; projectId?: string; pluginName?: string; enabled: boolean; legacy?: boolean;
}
export interface SkillRoots {
  projects: Array<{ id: string; workingDir: string }>;
  homes: string[];
  /** All authorized project boundaries, even during a scoped project scan. */
  projectBoundaries?: string[];
  codexHomes?: string[];
  hermesHomes?: string[];
  claudeManagedDir?: string;
  codexAdminDir?: string;
  additionalDirs?: string[];
}
export interface DiscoveryResult { candidates: SkillCandidate[]; scanRoots: string[]; excludedRoots: string[]; errors: Array<{ path: string; error: string }> }

/** Do not follow directory symlinks: provider trees cannot escape authorized roots. */
export async function discoverSkillFiles(roots: SkillRoots): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { candidates: [], scanRoots: [], excludedRoots: [], errors: [] };
  const seen = new Set<string>();
  const disabledPaths = new Set<string>();
  const boundaries = new Set([...(roots.projectBoundaries ?? []), ...roots.projects.map(p => p.workingDir)].map(p => resolve(p)));
  const homes = new Set(roots.homes.map(p => resolve(p)));
  const entries = async (path: string) => {
    try { return await readdir(path, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.errors.push({ path, error: String(e) }); return []; }
  };
  const add = (path: string, base: Omit<SkillCandidate, 'path'>) => {
    path = resolve(path);
    if (!seen.has(path)) { seen.add(path); result.candidates.push({ ...base, path }); }
  };
  const tree = async (path: string, base: Omit<SkillCandidate, 'path'>, recursive = false) => {
    result.scanRoots.push(resolve(path));
    const visit = async (dir: string) => {
      for (const entry of await entries(dir)) {
        if (entry.isFile() && entry.name === 'SKILL.md') add(join(dir, entry.name), base);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const child = join(dir, entry.name);
          if (recursive) await visit(child);
          else for (const f of await entries(child)) if (f.isFile() && f.name === 'SKILL.md') add(join(child, f.name), base);
        }
      }
    };
    await visit(path);
  };
  const conventions = async (dir: string, level: SkillLevel, root: string, projectId?: string) => {
    for (const provider of ['claude', 'agents'] as const) {
      const path = join(dir, `.${provider}`, 'skills');
      await tree(path, { provider, level, root, projectId, scanRoot: path, enabled: true });
    }
    const commands = join(dir, '.claude', 'commands');
    result.scanRoots.push(commands);
    for (const e of await entries(commands)) if (e.isFile() && e.name.endsWith('.md')) add(join(commands, e.name), { provider: 'claude', level, root, projectId, scanRoot: commands, enabled: true, legacy: true });
  };
  for (const home of homes) {
    await conventions(home, 'user', home);
    const synced = join(home, '.claude/skills/synced');
    await tree(synced, { provider: 'claude', level: 'synced', root: home, scanRoot: synced, enabled: true, pluginName: 'anthropic-skills' });
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8')); } catch { /* optional settings */ }
    const marketplaces = join(home, '.claude/plugins/marketplaces');
    result.scanRoots.push(marketplaces);
    for (const market of await entries(marketplaces)) if (market.isDirectory()) {
      const plugins = join(marketplaces, market.name, 'plugins');
      for (const plugin of await entries(plugins)) if (plugin.isDirectory()) {
        const path = join(plugins, plugin.name);
        const enabledPlugins = settings.enabledPlugins as Record<string, unknown> | undefined;
        const base = { provider: 'claude' as const, level: 'plugin' as const, root: plugin.name, pluginName: plugin.name, scanRoot: marketplaces, enabled: enabledPlugins?.[`${plugin.name}@${market.name}`] === true };
        for (const e of await entries(path)) if (e.isFile() && e.name === 'SKILL.md') add(join(path, e.name), base);
        await tree(join(path, 'skills'), base);
      }
    }
  }
  for (const codexHome of new Set([...roots.homes.map(h => join(h, '.codex')), ...(roots.codexHomes ?? [])])) {
    const path = join(codexHome, 'skills');
    await tree(path, { provider: 'codex', level: 'user', root: codexHome, scanRoot: path, enabled: true });
    await tree(join(path, '.system'), { provider: 'codex', level: 'system', root: codexHome, scanRoot: path, enabled: true });
    try {
      const config = parseToml(await readFile(join(codexHome, 'config.toml'), 'utf8')) as unknown as { skills?: { config?: Array<{ path?: string; enabled?: boolean }> } };
      for (const item of config.skills?.config ?? []) if (item.path && item.enabled === false) {
        const disabled = resolve(codexHome, item.path);
        disabledPaths.add(disabled);
        disabledPaths.add(join(disabled, 'SKILL.md'));
      }
    } catch { /* optional or invalid config does not suppress discovery */ }
  }
  for (const hermes of new Set([...roots.homes.map(h => join(h, '.hermes')), ...(roots.hermesHomes ?? [])])) {
    const path = join(hermes, 'skills');
    await tree(path, { provider: 'hermes', level: 'user', root: hermes, scanRoot: path, enabled: true }, true);
  }
  for (const project of roots.projects) {
    const dir = resolve(project.workingDir);
    if (homes.has(dir)) continue;
    await conventions(dir, 'project', project.id, project.id);
    const nested = async (parent: string) => {
      for (const e of await entries(parent)) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'vendor'].includes(e.name)) {
        const child = join(parent, e.name);
        if (boundaries.has(child)) { result.excludedRoots.push(child); continue; }
        try { await lstat(join(child, '.git')); result.excludedRoots.push(child); continue; } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
        const path = join(child, '.claude/skills');
        await tree(path, { provider: 'claude', level: 'nested', root: relative(dir, child), projectId: project.id, scanRoot: dir, enabled: true });
        await nested(child);
      }
    };
    result.scanRoots.push(dir);
    await nested(dir);
  }
  for (const dir of roots.additionalDirs ?? []) await conventions(dir, 'session', resolve(dir));
  if (roots.claudeManagedDir) {
    const path = join(roots.claudeManagedDir, '.claude/skills');
    await tree(path, { provider: 'claude', level: 'admin', root: roots.claudeManagedDir, scanRoot: path, enabled: true });
  }
  const admin = roots.codexAdminDir ?? '/etc/codex/skills';
  await tree(admin, { provider: 'codex', level: 'admin', root: admin, scanRoot: admin, enabled: true });
  for (const c of result.candidates) if (disabledPaths.has(c.path)) c.enabled = false;
  result.scanRoots = [...new Set(result.scanRoots)];
  return result;
}
