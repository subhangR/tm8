/**
 * BROAD WORKING DIRECTORIES — naming the consequence at the moment of the
 * choice, not after it.
 *
 * A project's working directory is not private to the admin who registered it:
 * `projects.files.list` is member-reachable by design, and the File browser
 * surfaces every linked project as a root. So the path chosen here decides what
 * every member of the space can read, and the only thing standing between them
 * and a secret is `project-file-policy.ts`'s DENYLIST — which by construction
 * fails open on whatever nobody thought to list.
 *
 * Picking `/` or a whole home directory is therefore not a slightly-too-wide
 * choice, it is a standing exposure that nothing later announces: the project
 * row looks like any other, and it stays until somebody notices. Browsing is
 * node-admin-only, so this can only be an admin's slip — which is exactly the
 * kind of mistake a default cannot prevent and a sentence can.
 *
 * This is a WARNING and never a refusal. A deployment that genuinely wants a
 * broad root is entitled to one; it just has to mean it.
 */

/** Segment names that hold every user's home directory, compared case-folded. */
const HOME_CONTAINERS = new Set(['home', 'users']);

interface SplitPath {
  /** `/` or `C:\`, or null when the path is not absolute in this flavour. */
  root: string | null;
  segments: string[];
}

function split(path: string, separator: '/' | '\\'): SplitPath {
  if (separator === '\\') {
    const match = /^([A-Za-z]:\\|\\\\)/.exec(path);
    if (!match) return { root: null, segments: [] };
    return { root: match[1]!, segments: path.slice(match[1]!.length).split(/[\\/]+/).filter(Boolean) };
  }
  if (!path.startsWith('/')) return { root: null, segments: [] };
  return { root: '/', segments: path.slice(1).split('/').filter(Boolean) };
}

/**
 * Why this working directory exposes far more than a project, or null when it
 * is an ordinary choice. The reason is a noun phrase, meant to be read as
 * "This folder is <reason>."
 */
export function broadWorkingDirReason(rawPath: string, separator: '/' | '\\'): string | null {
  const path = rawPath.trim();
  if (path.length === 0) return null;
  const { root, segments } = split(path, separator);
  if (root === null) return null;

  if (segments.length === 0) return 'the root of the whole filesystem';

  const first = segments[0]!.toLowerCase();
  if (segments.length === 1) {
    if (HOME_CONTAINERS.has(first)) return "the folder that holds every user's home directory";
    if (first === 'root') return "the root user's home directory";
  }
  if (segments.length === 2 && HOME_CONTAINERS.has(first)) {
    return "an entire user's home directory";
  }
  return null;
}

/** The full sentence shown beside a broad choice. */
export function broadWorkingDirWarning(reason: string): string {
  return `This folder is ${reason}. Every member of this space will be able to read files under it `
    + 'in the file browser. Choose the project\'s own folder unless you mean to share all of this.';
}
