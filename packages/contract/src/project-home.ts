/**
 * THE HOME DEFAULT FOR A PROJECT'S WORKING DIRECTORY.
 *
 * A Space's project created with no folder gets one of its own beneath the
 * node's home directory: `~/<project-dir-name>`. Its own, not `~` itself: home
 * holds everything else on the node, and a folder can belong to only one Space
 * on a node that is not loopback-only (decision 29), so a shared `~` would let
 * only the first such project exist. The server creates the folder when it is
 * missing; the form shows the same path as its placeholder.
 */

/** `My Project!` → `my-project`; '' when nothing usable is left. */
export function projectDirName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
}

/**
 * The path a project with no folder gets: beneath `base` (the node's
 * `projectsHome`, from a directory listing) when known, else written as `~/<dir>`.
 */
export function projectHomeDisplayPath(name: string, base?: string | null): string | null {
  const dir = projectDirName(name);
  if (!dir) return null;
  return base ? `${base.replace(/\/+$/, '')}/${dir}` : `~/${dir}`;
}

/**
 * Expand a leading `~` or `~/` against `home`. Anything else is returned as
 * is (`~user` is not expanded: it names another account's home).
 */
export function expandHomePath(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${path.slice(2)}`;
  return path;
}
