/**
 * PROJECT FILE PATHS. A file tab holds the path RELATIVE to the project's
 * working directory, `/`-separated whatever the node's OS: it is what the
 * workspace stores (shared with the node, `@tm8/contract/workspace`), and a
 * folder moved on disk keeps its tabs. `projects.files.*` speak ABSOLUTE
 * paths, so the viewer joins the relative one onto the listing's
 * `workingDir` with its `separator` at read time.
 */
import { isFileTabPath } from '@tm8/contract/workspace';

export interface ProjectFileTarget {
  projectId: string;
  /** Relative to the project's working directory, `/`-separated. */
  path: string;
}

export type PathSeparator = '/' | '\\';

/** The absolute path the node reads, for a relative tab path. */
export function toAbsolutePath(workingDir: string, separator: PathSeparator, relative: string): string {
  const root = workingDir.endsWith(separator) ? workingDir.slice(0, -1) : workingDir;
  return `${root}${separator}${relative.split('/').join(separator)}`;
}

/**
 * The tab path for an absolute path inside `workingDir` (a listing entry's
 * `path`), or null when it is not inside it or is not a valid tab path.
 */
export function toRelativePath(workingDir: string, separator: PathSeparator, absolute: string): string | null {
  const root = workingDir.endsWith(separator) ? workingDir : `${workingDir}${separator}`;
  if (!absolute.startsWith(root)) return null;
  const relative = absolute.slice(root.length).split(separator).join('/');
  return isProjectFilePath(relative) ? relative : null;
}

/** A path a file tab may hold (the contract's rule): relative, bounded, no NUL, no `.`/`..`/empty segment. */
export function isProjectFilePath(path: unknown): path is string {
  return isFileTabPath(path);
}

/** `src/a/b.ts` → `b.ts`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `src/a/b.ts` → `['src', 'a']`. */
export function folderSegments(path: string): string[] {
  return path.split('/').slice(0, -1);
}

/** One string per (project, path): the tab identity, the recent-list key. */
export function projectFileKey(target: ProjectFileTarget): string {
  return `${target.projectId}\u0000${target.path}`;
}
