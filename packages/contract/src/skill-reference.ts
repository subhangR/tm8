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
export interface SkillPreviewResult extends EffectiveSkills { rows: SkillPreviewRow[] }
