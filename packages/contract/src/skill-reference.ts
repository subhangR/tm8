/** Cached filesystem metadata. Bodies are loaded only for detail/spawn reads. */
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
