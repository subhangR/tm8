/** Cached filesystem metadata. Bodies are loaded only for detail reads; spawn consumes cached metadata. */
export type SkillProvider = 'claude' | 'agents' | 'codex' | 'hermes' | 'tm8';
export type SkillLevel = 'system' | 'admin' | 'user' | 'project' | 'nested' | 'plugin' | 'synced' | 'session' | 'space';
export type SkillRootKind = 'home' | 'project' | 'plugin' | 'subdir';
export interface SkillReference {
  provider: SkillProvider;
  level: SkillLevel;
  root?: { kind: SkillRootKind; ref: string | null };
  sourcePath?: string;
  dirName?: string;
  frontmatter: Record<string, unknown>;
  loaderMetadata?: Record<string, unknown>;
  contentHash?: string;
  fileMtime?: string;
  bodyBytes?: number;
  bundle?: { scripts: number; references: number; assets: number };
  missing: boolean;
  lastSeenAt?: string;
}

/** Compact equipment index; no body may cross this interface. */
export interface SkillIndexEntry {
  entityId: string;
  name: string;
  description: string;
  provider: SkillProvider;
  level: SkillLevel;
  sourcePath?: string;
  loadPointer: string;
  native: boolean;
  hash?: string;
  allowImplicitInvocation?: boolean;
  /** The spawn task whose `equips` edge brought this skill; absent for persona equipment. */
  viaTaskId?: string;
}
export interface SkippedSkill {
  entityId: string;
  name: string;
  hash?: string;
  sourcePath?: string;
  /**
   * Why the skill is not in the session's index. A free string so an older
   * manifest's value still reads; the vocabulary written today:
   * - `missing` — the reference's file is gone.
   * - `native-shadowed` — a native copy of the same skill won.
   * - `byte-budget` — the index would have exceeded its byte budget.
   * - `not-selected` — equipped, but left unticked in an `execution.spawn`
   *   `selection` (design 01a0cb80 §5.2).
   * - `task-name-collision` — equipped on a spawn task, but an earlier task
   *   skill has the same name (or path); the first in task order won.
   * - `relevance` — legacy: spawn-time Jev trimmed it. No longer written.
   */
  reason: string;
}
export interface EffectiveSkills {
  native: SkillIndexEntry[];
  indexed: SkillIndexEntry[];
  skipped: SkippedSkill[];
  scannedAt: string | null;
}

export interface SkillPreviewRow {
  entityId: string;
  entityVersion?: number;
  name: string;
  description: string;
  provider: SkillProvider;
  level: SkillLevel;
  sourcePath?: string;
  scope: 'native' | 'indexed' | 'skipped';
  indexLine: string | null;
  contentHash?: string;
  missing: boolean;
  equippedBy: 'persona' | 'ancestor' | null;
  disableModelInvocation: boolean;
  allowImplicitInvocation: boolean;
  reason?: string;
}
export interface SkillPreviewResult extends EffectiveSkills {
  rows: SkillPreviewRow[];
  /**
   * Claude plugin ids (`<name>@<marketplace>`) a claude-code launch by this
   * caller could load — the caller's credential home plus the node's config
   * home. What the launch UI's Plugins menu offers. Absent when the node has
   * no credential root to read.
   */
  installedPlugins?: string[];
  /**
   * Per `installedPlugins` id, the live skill entities of that plugin
   * (`level:'plugin'` Claude skill rows whose `pluginName` the id matches, by
   * the same `isPluginAllowed` rule spawn's allow set uses). A plugin with no
   * entry has no skill entity (MCP-only). Design 01a0d348 §3.5, F3: the launch
   * composer ticks these into `selection.skillIds` instead of `plugins`.
   * Absent whenever `installedPlugins` is.
   */
  pluginSkillIds?: Record<string, string[]>;
  /**
   * The launch's edge-driven skill DEFAULTS, in spawn's order: the spawn
   * tasks' `equips` (when `taskIds` was asked), then the teammate's and its
   * ancestors'. A present `selection.skillIds` is an exact set, so a composer
   * that adds plugin skills sends these ∪ the plugin's skills, never the
   * plugin's skills alone (F3).
   */
  defaultSkillIds?: string[];
}
