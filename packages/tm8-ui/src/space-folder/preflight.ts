/**
 * HONEST PRE-FLIGHT.
 *
 * A directory picker will hand you node_modules and .git without comment. The
 * temptation is to drop them quietly, and that is the one thing this module
 * must never do: a user who believes they uploaded their whole project, and did
 * not, will act on that belief. So every rule is NAMED, its cost is SHOWN in
 * both files and bytes, and every rule is individually OVERRIDABLE. Nothing is
 * removed from an upload without a line on screen saying so.
 *
 * The same rule governs the two things a folder pick can be dishonest about:
 * paths it cannot safely represent (REFUSED, never normalised into some other
 * path) and empty directories (only a recursive drop can see them at all).
 */

/** One file the user picked, path relative to the destination root. */
export interface PickedFile {
  /** POSIX-separated, relative to the destination root; no leading slash. */
  readonly path: string;
  readonly size: number;
  readonly file: File;
}

export interface RefusedPath {
  readonly path: string;
  readonly reason: string;
}

export interface PickedTree {
  /** The local directory's own name, kept only to show what was picked. */
  readonly rootName: string;
  readonly files: readonly PickedFile[];
  /**
   * Directories with no file anywhere beneath them, POSIX-separated, no
   * trailing slash. A structure carries meaning; dropping empty directories
   * silently changes the tree the user thinks they sent.
   */
  readonly emptyDirectories: readonly string[];
  /**
   * FALSE for a `webkitdirectory` pick. That path yields a flat FileList and a
   * directory containing no files simply does not appear in it — the browser
   * cannot report one. Rendering that limitation is the difference between
   * "there were none" and "we could not tell".
   */
  readonly emptyDirectoriesObservable: boolean;
  /** Paths refused as unrepresentable or unsafe. Never silently rewritten. */
  readonly refused: readonly RefusedPath[];
}

export interface ExclusionRule {
  readonly id: string;
  readonly label: string;
  /** Excluded when any path SEGMENT equals one of these. */
  readonly dirs?: readonly string[];
  /** Excluded when the BASENAME equals one of these. */
  readonly files?: readonly string[];
}

/**
 * Defaults are ON, because the common case is a project directory and the
 * common mistake is shipping a gigabyte of node_modules. They are defaults, not
 * policy: each one is a checkbox and unchecking it includes those bytes.
 */
export const DEFAULT_EXCLUSION_RULES: readonly ExclusionRule[] = [
  { id: 'vcs', label: 'Version control (.git, .hg, .svn)', dirs: ['.git', '.hg', '.svn'] },
  {
    id: 'deps',
    label: 'Installed dependencies (node_modules, .venv, venv, vendor)',
    dirs: ['node_modules', '.venv', 'venv', 'vendor'],
  },
  {
    id: 'build',
    label: 'Build output (dist, build, out, target, .next)',
    dirs: ['dist', 'build', 'out', 'target', '.next'],
  },
  {
    id: 'caches',
    label: 'Caches (.cache, .turbo, __pycache__)',
    dirs: ['.cache', '.turbo', '__pycache__'],
  },
  { id: 'os', label: 'OS metadata (.DS_Store, Thumbs.db)', files: ['.DS_Store', 'Thumbs.db'] },
];

export const DEFAULT_ACTIVE_RULE_IDS: readonly string[] = DEFAULT_EXCLUSION_RULES.map((r) => r.id);

/** The rule that excludes this path, or null. First match wins, so the
 *  reported reason is stable and a file is never counted twice. */
export function matchExclusion(
  path: string,
  rules: readonly ExclusionRule[],
): ExclusionRule | null {
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? '';
  const dirSegments = segments.slice(0, -1);
  for (const rule of rules) {
    if (rule.dirs?.some((dir) => dirSegments.includes(dir))) return rule;
    if (rule.files?.includes(basename)) return rule;
  }
  return null;
}

/** A directory is excluded when the rule names it or any ancestor of it. */
function directoryExcluded(path: string, rules: readonly ExclusionRule[]): boolean {
  const segments = path.split('/');
  return rules.some((rule) => rule.dirs?.some((dir) => segments.includes(dir)));
}

export interface ExcludedGroup {
  readonly ruleId: string;
  readonly label: string;
  readonly files: number;
  readonly bytes: number;
}

export interface Preflight {
  /** Exactly the files that will be sent, in pick order. */
  readonly included: readonly PickedFile[];
  readonly includedFiles: number;
  readonly includedBytes: number;
  /** Empty directories that survive the exclusion rules and will be created. */
  readonly includedEmptyDirectories: readonly string[];
  readonly emptyDirectoriesObservable: boolean;
  /** Only rules that actually matched something, so the list is never noise. */
  readonly excludedGroups: readonly ExcludedGroup[];
  readonly excludedFiles: number;
  readonly excludedBytes: number;
  readonly refused: readonly RefusedPath[];
  readonly totalFiles: number;
  readonly totalBytes: number;
}

export function preflight(
  tree: PickedTree,
  activeRuleIds: readonly string[],
  rules: readonly ExclusionRule[] = DEFAULT_EXCLUSION_RULES,
): Preflight {
  const active = rules.filter((rule) => activeRuleIds.includes(rule.id));
  const included: PickedFile[] = [];
  const groups = new Map<string, { label: string; files: number; bytes: number }>();
  let includedBytes = 0;
  let excludedFiles = 0;
  let excludedBytes = 0;

  for (const picked of tree.files) {
    const hit = matchExclusion(picked.path, active);
    if (!hit) {
      included.push(picked);
      includedBytes += picked.size;
      continue;
    }
    excludedFiles += 1;
    excludedBytes += picked.size;
    const group = groups.get(hit.id) ?? { label: hit.label, files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += picked.size;
    groups.set(hit.id, group);
  }

  // Report in rule order, not first-seen order, so the list does not reshuffle
  // as a different file happens to be walked first.
  const excludedGroups: ExcludedGroup[] = [];
  for (const rule of rules) {
    const group = groups.get(rule.id);
    if (group) {
      excludedGroups.push({ ruleId: rule.id, label: group.label, files: group.files, bytes: group.bytes });
    }
  }

  return {
    included,
    includedFiles: included.length,
    includedBytes,
    includedEmptyDirectories: tree.emptyDirectories.filter((path) => !directoryExcluded(path, active)),
    emptyDirectoriesObservable: tree.emptyDirectoriesObservable,
    excludedGroups,
    excludedFiles,
    excludedBytes,
    refused: tree.refused,
    totalFiles: tree.files.length,
    totalBytes: includedBytes + excludedBytes,
  };
}

/** Shared byte vocabulary so preflight and progress read the same way. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatFiles(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}
