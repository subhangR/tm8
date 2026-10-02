import type { EntitySummary } from '@tm8/contract';

/**
 * FRIENDLY SCOPE — a skill's provider/level/root said in words a person reads
 * ("Project", "Claude"), with the full location kept for the tooltip. The raw
 * `agents · project · /repo` string is still what groups and filters key on, so
 * two skills from different roots never collapse into one group.
 */
const LEVEL_LABEL: Record<string, string> = {
  project: 'Project', user: 'User', nested: 'Nested', system: 'System', admin: 'Admin',
  plugin: 'Plugin', synced: 'Synced', session: 'Session', space: 'Space',
};
const PROVIDER_LABEL: Record<string, string> = {
  agents: 'Agents', claude: 'Claude', codex: 'Codex', hermes: 'Hermes', tm8: 'tm8',
};

export interface SkillScopeView {
  level: string;
  provider: string;
  /** Where the skill lives — root ref, else source path. Empty when unknown. */
  where: string;
}

interface ScopeFields {
  provider?: string;
  level?: string;
  root?: { ref: string | null } | null;
  sourcePath?: string;
}

export function scopeView(state: ScopeFields): SkillScopeView {
  return {
    level: LEVEL_LABEL[state.level ?? ''] ?? state.level ?? '',
    provider: PROVIDER_LABEL[state.provider ?? ''] ?? state.provider ?? '',
    where: state.root?.ref ?? state.sourcePath ?? '',
  };
}

/** The scope a row was found in, or null for a row that is not a skill. */
export function rowScope(row: EntitySummary): SkillScopeView | null {
  return row.state.kind === 'skill' ? scopeView(row.state) : null;
}

/** The one-line description a row carries, if any. */
export function rowDescription(row: EntitySummary): string {
  if (row.state.kind === 'skill' && typeof row.state.description === 'string' && row.state.description) return row.state.description;
  return row.excerpt ?? '';
}
