/**
 * THE PROJECT FILES TREE, AS DATA (mockup v2, left panel). The panel holds one
 * `DirState` per directory it has asked `projects.files.list` about, keyed by
 * the directory's project-RELATIVE path (`''` is the root), and this module
 * turns those, the open set and the filter into the flat rows it draws.
 *
 * Folders first, then files, each by name. `.git` is never shown; a
 * `node_modules` folder is dimmed with everything under it, but still opens.
 * A directory the node cut short (more than 500 entries) ends with a "More
 * files not shown" row. Nothing here fetches: `pendingDirs` names the open
 * directories still to be listed, one call each.
 */
import type { ProjectFileListing } from '@tm8/contract';
import { toRelativePath } from './paths';

export type DirState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; listing: ProjectFileListing };

export type TreeRow =
  | { type: 'dir'; path: string; name: string; depth: number; open: boolean; dim: boolean }
  | { type: 'file'; path: string; name: string; depth: number; dim: boolean }
  | { type: 'loading'; parent: string; depth: number }
  | { type: 'error'; parent: string; depth: number; message: string }
  | { type: 'more'; parent: string; depth: number };

export const ROOT_DIR = '';
/** Never drawn (a worktree's `.git` is a file, so files by these names are hidden too). */
export const HIDDEN_DIRS: ReadonlySet<string> = new Set(['.git']);
/** Drawn dimmed, with everything under them. */
export const DIMMED_DIRS: ReadonlySet<string> = new Set(['node_modules']);

interface Child {
  name: string;
  /** Project-relative, `/`-separated. */
  path: string;
}

const byName = (a: Child, b: Child) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name);

/** A listing's folders and files, sorted, with `.git` dropped and paths made relative. */
export function childrenOf(listing: ProjectFileListing): { dirs: Child[]; files: Child[] } {
  const relative = (entry: { name: string; path: string }): Child | null => {
    const path = toRelativePath(listing.workingDir, listing.separator, entry.path);
    return path === null ? null : { name: entry.name, path };
  };
  const dirs = listing.directories
    .filter((d) => !HIDDEN_DIRS.has(d.name))
    .map(relative)
    .filter((c): c is Child => c !== null)
    .sort(byName);
  const files = listing.files
    .filter((f) => !HIDDEN_DIRS.has(f.name))
    .map(relative)
    .filter((c): c is Child => c !== null)
    .sort(byName);
  return { dirs, files };
}

/** `a/b/c.ts` → `['a', 'a/b']`: the folders to open to show it. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The open directories that are reachable (every ancestor open and listed)
 * but not yet asked about. The root always is.
 */
export function pendingDirs(dirs: ReadonlyMap<string, DirState>, open: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (path: string) => {
    const state = dirs.get(path);
    if (!state) {
      out.push(path);
      return;
    }
    if (state.status !== 'ready') return;
    for (const child of childrenOf(state.listing).dirs) {
      if (open.has(child.path)) visit(child.path);
    }
  };
  visit(ROOT_DIR);
  return out;
}

/**
 * The rows to draw. With a filter (case-insensitive, on names), a file shows
 * when it matches, a folder when it matches or holds a match among what is
 * already listed; a folder holding a match is drawn open, and a matching
 * folder shows its own contents as usual. Only listed directories are
 * searched: the filter never lists anything itself.
 */
export function treeRows(dirs: ReadonlyMap<string, DirState>, open: ReadonlySet<string>, filter = ''): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);
  const holdsMatch = new Map<string, boolean>();
  const contains = (path: string): boolean => {
    const hit = holdsMatch.get(path);
    if (hit !== undefined) return hit;
    holdsMatch.set(path, false);
    const state = dirs.get(path);
    let found = false;
    if (state?.status === 'ready') {
      const { dirs: sub, files } = childrenOf(state.listing);
      found = files.some((f) => matches(f.name)) || sub.some((d) => matches(d.name) || contains(d.path));
    }
    holdsMatch.set(path, found);
    return found;
  };

  const rows: TreeRow[] = [];
  const walk = (path: string, depth: number, dim: boolean, filtering: boolean) => {
    const state = dirs.get(path);
    if (!state || state.status === 'loading') {
      if (!filtering) rows.push({ type: 'loading', parent: path, depth });
      return;
    }
    if (state.status === 'error') {
      if (!filtering) rows.push({ type: 'error', parent: path, depth, message: state.message });
      return;
    }
    const { dirs: sub, files } = childrenOf(state.listing);
    for (const dir of sub) {
      const dirDim = dim || DIMMED_DIRS.has(dir.name);
      if (filtering) {
        if (matches(dir.name)) {
          const isOpen = open.has(dir.path);
          rows.push({ type: 'dir', path: dir.path, name: dir.name, depth, open: isOpen, dim: dirDim });
          if (isOpen) walk(dir.path, depth + 1, dirDim, false);
        } else if (contains(dir.path)) {
          rows.push({ type: 'dir', path: dir.path, name: dir.name, depth, open: true, dim: dirDim });
          walk(dir.path, depth + 1, dirDim, true);
        }
        continue;
      }
      const isOpen = open.has(dir.path);
      rows.push({ type: 'dir', path: dir.path, name: dir.name, depth, open: isOpen, dim: dirDim });
      if (isOpen) walk(dir.path, depth + 1, dirDim, false);
    }
    for (const file of files) {
      if (filtering && !matches(file.name)) continue;
      rows.push({ type: 'file', path: file.path, name: file.name, depth, dim });
    }
    if (state.listing.truncated && !filtering) rows.push({ type: 'more', parent: path, depth });
  };
  walk(ROOT_DIR, 0, false, needle.length > 0);
  return rows;
}
