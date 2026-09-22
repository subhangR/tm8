import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { EffectiveSkills, SkillIndexEntry } from '@tm8/contract';
import { resolveSkills, type ResolvedSkillRow } from './skills.js';

export interface EffectiveSkillsInput {
  agentTool: string;
  workdir: string;
  projectRoot: string | null;
  equips: readonly ResolvedSkillRow[];
  scannedAt?: string | null;
  /** Actual provider config directory (credential homes can differ from OS home). */
  agentConfigDir?: string;
  homeDir?: string;
}
const within = (child: string, parent: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Pure metadata computation, shared by spawn and the authorized launch preview. */
export function computeEffectiveSkills(input: EffectiveSkillsInput): EffectiveSkills {
  const result: EffectiveSkills = { native: [], indexed: [], skipped: [], scannedAt: input.scannedAt ?? null };
  const home = input.homeDir ?? homedir();
  const config = input.agentConfigDir ?? resolve(home, input.agentTool === 'codex' ? '.codex' : '.claude');
  const rows = resolveSkills(input.equips).skills;
  const nativeRows: Array<{ row: ResolvedSkillRow; entry: SkillIndexEntry }> = [];
  for (const row of rows) {
    const provider = row.provider ?? 'tm8';
    const level = row.level ?? 'space';
    const metadata = row.loaderMetadata ?? {};
    const skip = (reason: string) => result.skipped.push({ entityId: row.entityId, name: row.name, ...(row.contentHash ? { hash: row.contentHash } : {}), reason, ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}) });
    if (row.missing) { skip('missing'); continue; }
    if (input.agentTool === 'codex' && metadata.codexDisabled === true) { skip('disabled'); continue; }
    const path = row.sourcePath;
    const invoke = row.dirName ?? row.name;
    const compatible = input.agentTool === 'claude-code' ? provider === 'claude' || provider === 'agents' : input.agentTool === 'codex' && (provider === 'codex' || provider === 'agents');
    let native = false;
    let qualifier = '';
    if (path && compatible && isAbsolute(path)) {
      if (level === 'admin') native = true;
      if (level === 'user' || level === 'system' || level === 'synced') {
        native = within(path, provider === 'agents' ? resolve(home, '.agents/skills') : resolve(config, 'skills'));
        if (level === 'synced') qualifier = 'anthropic-skills:';
      }
      if (level === 'project' || level === 'nested') {
        const marker = provider === 'agents' ? '/.agents/' : provider === 'claude' ? '/.claude/' : '/.codex/';
        const boundary = path.lastIndexOf(marker);
        const sourceRoot = boundary >= 0 ? path.slice(0, boundary) || '/' : null;
        native = !!sourceRoot && !!input.projectRoot && within(input.workdir, input.projectRoot) && within(sourceRoot, input.projectRoot) &&
          (within(input.workdir, sourceRoot) || (level === 'nested' && input.agentTool === 'claude-code'));
        if (level === 'nested' && sourceRoot && input.projectRoot) qualifier = `${relative(input.projectRoot, sourceRoot).split(sep).join('/')}:`;
      }
      // Additional directories need a launch-time --add-dir fact. An equipped row
      // alone cannot prove they were passed, so session-scoped files use paths.
      if (level === 'plugin') {
        native = metadata.enabled === true && within(path, resolve(config, 'plugins')) && typeof metadata.pluginName === 'string';
        qualifier = `${metadata.pluginName ?? row.root?.ref ?? 'plugin'}:`;
      }
    }
    const implicit = input.agentTool === 'codex'
      ? object(object(metadata.openai).policy).allow_implicit_invocation !== false
      : row.frontmatter?.['disable-model-invocation'] !== true;
    const entry: SkillIndexEntry = {
      entityId: row.entityId, name: row.name,
      description: row.description || (typeof row.frontmatter?.when_to_use === 'string' ? row.frontmatter.when_to_use : ''),
      provider, level, ...(path ? { sourcePath: path } : {}), native,
      loadPointer: native ? `${input.agentTool === 'codex' ? '$' : '/'}${qualifier}${invoke}` : path ?? `tm8 entity get ${row.entityId}`,
      ...(row.contentHash ? { hash: row.contentHash } : {}),
      allowImplicitInvocation: implicit,
    };
    if (native) nativeRows.push({ row, entry }); else result.indexed.push(entry);
  }
  // Claude's native loader resolves collisions independently of graph ancestry.
  // Codex intentionally exposes every distinct path with a matching name.
  const score = (row: ResolvedSkillRow) => (row.loaderMetadata?.legacyCommand === true ? -10 : 0) + (({ admin: 4, user: 3, project: 2, synced: -20 } as Record<string, number>)[row.level ?? 'space'] ?? 1);
  const winners = new Map<string, { row: ResolvedSkillRow; entry: SkillIndexEntry }>();
  for (const item of nativeRows) {
    if (input.agentTool !== 'claude-code') { result.native.push(item.entry); continue; }
    const key = item.row.level === 'synced' ? `/${item.row.dirName ?? item.row.name}` : item.entry.loadPointer;
    const prior = winners.get(key);
    if (!prior || score(item.row) > score(prior.row)) {
      if (prior) result.skipped.push({ entityId: prior.entry.entityId, name: prior.entry.name, hash: prior.entry.hash, sourcePath: prior.entry.sourcePath, reason: 'native-shadowed' });
      winners.set(key, item);
    } else if (score(item.row) < score(prior.row)) result.skipped.push({ entityId: item.entry.entityId, name: item.entry.name, hash: item.entry.hash, sourcePath: item.entry.sourcePath, reason: 'native-shadowed' });
    else throw new Error(`ambiguous native skill "${item.entry.name}" at ${item.entry.loadPointer}`);
  }
  if (input.agentTool === 'claude-code') result.native.push(...[...winners.values()].map(item => item.entry));
  return result;
}
