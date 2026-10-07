/**
 * PATHS IN A CHANGES LIST — which ones belong on screen, and how they nest.
 *
 * Pure functions, shared by the two Changes bodies: the lane's git list
 * (repo-relative paths from porcelain) and the transcript list a session
 * without a worktree falls back to (whatever path the agent's Edit/Write call
 * named — absolute on every real transcript, relative in the fixtures).
 */
import type { SessionFileChange, SessionFileChanges } from '@tm8/contract';

/*
 * OUTSIDE ANY REPOSITORY (gate decision D9, 2026-10-07): an agent's notes in
 * /tmp and its memory files under the node's credentials tree are edits, but
 * they are not changes to anything a human reviews, and the credentials tree
 * must never be diffed into a browser at all.
 *
 * A DENY-LIST, AND ONLY AN APPROXIMATION OF THE RULE. "Outside any repository"
 * is a fact about the disk the browser cannot see; the server knows the repo
 * roots and will apply the exact rule. Until then these are the roots this
 * node is known to put such files under. Each is matched on a whole path
 * segment, so `/srv/tmpl/` and `/home/x/my.claude/` stay on screen.
 *
 * `.claude/projects/` and not `.claude/`: a repository may carry its own
 * `.claude/agents/*.md`, which IS repo content. `projects/` under the agent's
 * config dir is where it keeps transcripts and memory.
 */
const TEMP_ROOTS = ['/tmp/', '/var/tmp/', '/dev/shm/'] as const;
const PRIVATE_SEGMENTS = ['/prod-data/credentials/', '/.claude/projects/'] as const;

export function isOutsideAnyRepo(path: string): boolean {
  if (TEMP_ROOTS.some((root) => path.startsWith(root))) return true;
  return PRIVATE_SEGMENTS.some((segment) => path.includes(segment));
}

/**
 * A transcript accounting with the D9 paths taken out, and the totals summed
 * again over what is left — the server's totals include the hidden files, and
 * a header reading +40 over rows adding up to +12 is a sum nobody can check.
 * `hidden` is carried so the surface can say that something was left out.
 */
export function keepRepoChanges(changes: SessionFileChanges): {
  files: SessionFileChange[];
  totalAdded: number;
  totalRemoved: number;
  hidden: number;
} {
  const files = changes.files.filter((f) => !isOutsideAnyRepo(f.path));
  const hidden = changes.files.length - files.length;
  if (hidden === 0) {
    return { files, totalAdded: changes.totalAdded, totalRemoved: changes.totalRemoved, hidden };
  }
  return {
    files,
    totalAdded: files.reduce((n, f) => n + f.linesAdded, 0),
    totalRemoved: files.reduce((n, f) => n + f.linesRemoved, 0),
    hidden,
  };
}

/**
 * The deepest directory every path sits under, with its trailing `/` — or ''
 * when they share none. Shown once as the list's root, so each row can carry
 * only the part that differs: twenty rows that all begin
 * `/home/tm8/prod-data/scratch/01a…/tm8/` are a column of noise.
 *
 * Directory segments only. A lone file's root is its folder, never the file
 * itself, so a row is never left with an empty name.
 */
export function commonDir(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const dirsOf = (p: string) => p.split('/').slice(0, -1);
  let shared = dirsOf(paths[0]!);
  for (const p of paths.slice(1)) {
    const dirs = dirsOf(p);
    let i = 0;
    while (i < shared.length && i < dirs.length && shared[i] === dirs[i]) i += 1;
    shared = shared.slice(0, i);
    if (shared.length === 0) break;
  }
  // `['']` is what an absolute path's leading slash leaves behind: the shared
  // root is `/`, which is no root worth naming.
  if (shared.length === 0 || (shared.length === 1 && shared[0] === '')) return '';
  return `${shared.join('/')}/`;
}

/** `path` with `root` taken off the front, when it is there. */
export function relativeTo(root: string, path: string): string {
  return root !== '' && path.startsWith(root) ? path.slice(root.length) : path;
}

export interface ChangeTreeDir<T> {
  kind: 'dir';
  /** One segment, or several joined with `/` where a folder held one folder. */
  name: string;
  /** The folder's full relative path — its identity for collapse state. */
  path: string;
  children: ChangeTreeNode<T>[];
  /** Files anywhere beneath it. */
  fileCount: number;
}

export interface ChangeTreeFile<T> {
  kind: 'file';
  name: string;
  path: string;
  item: T;
}

export type ChangeTreeNode<T> = ChangeTreeDir<T> | ChangeTreeFile<T>;

interface Building<T> {
  dirs: Map<string, Building<T>>;
  files: ChangeTreeFile<T>[];
  path: string;
}

/**
 * Nest relative paths into folders.
 *
 * COMPACT FOLDERS. A folder whose only child is another folder is drawn as one
 * row (`packages/tm8-ui/src`), the way editors draw a changes tree. A changes
 * tree is mostly such chains, so drawing every link would push the files —
 * the only rows anyone came for — off the side of a narrow panel.
 *
 * Folders before files, each in code-point order: stable across machines,
 * which a locale-aware sort is not.
 */
export function buildChangeTree<T>(entries: readonly { rel: string; item: T }[]): ChangeTreeNode<T>[] {
  const root: Building<T> = { dirs: new Map(), files: [], path: '' };
  for (const { rel, item } of entries) {
    const parts = rel.split('/').filter((s) => s !== '');
    if (parts.length === 0) continue;
    let at = root;
    for (const segment of parts.slice(0, -1)) {
      let next = at.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: [], path: at.path === '' ? segment : `${at.path}/${segment}` };
        at.dirs.set(segment, next);
      }
      at = next;
    }
    at.files.push({ kind: 'file', name: parts[parts.length - 1]!, path: parts.join('/'), item });
  }
  return finish(root);
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function finish<T>(at: Building<T>): ChangeTreeNode<T>[] {
  const dirs: ChangeTreeDir<T>[] = [];
  for (const [segment, child] of at.dirs) {
    let name = segment;
    let node = child;
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [[nextName, next]] = [...node.dirs] as [[string, Building<T>]];
      name = `${name}/${nextName}`;
      node = next;
    }
    const children = finish(node);
    dirs.push({ kind: 'dir', name, path: node.path, children, fileCount: countFiles(children) });
  }
  return [...dirs.sort(byName), ...[...at.files].sort(byName)];
}

function countFiles<T>(nodes: readonly ChangeTreeNode<T>[]): number {
  let n = 0;
  for (const node of nodes) n += node.kind === 'file' ? 1 : node.fileCount;
  return n;
}

export interface ChangeTreeRow<T> {
  node: ChangeTreeNode<T>;
  depth: number;
}

/**
 * The rows on screen, in order: every folder, and the contents of every folder
 * not in `collapsed`. OPEN BY DEFAULT — the set holds what the viewer shut.
 * Every row in this tree is a changed file, so a tree that started shut would
 * hide exactly the list the reviewer opened the tab for.
 */
export function visibleChangeRows<T>(
  nodes: readonly ChangeTreeNode<T>[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): ChangeTreeRow<T>[] {
  const rows: ChangeTreeRow<T>[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === 'dir' && !collapsed.has(node.path)) {
      rows.push(...visibleChangeRows(node.children, collapsed, depth + 1));
    }
  }
  return rows;
}

/** Every file beneath a folder — for a folder row to summarise its contents. */
export function filesUnder<T>(node: ChangeTreeNode<T>): T[] {
  if (node.kind === 'file') return [node.item];
  return node.children.flatMap((child) => filesUnder(child));
}
