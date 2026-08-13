import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { CollabError, type ProjectDirectoryListing } from '@tm8/contract';

/** A picker should stay responsive even when opened on a very wide directory. */
export const MAX_PROJECT_DIRECTORIES = 500;

/**
 * The OS's own filesystem root(s) — the browse scope when the deployment has
 * not narrowed it with `TM8_PROJECT_ROOTS`.
 *
 * Defaulting to the home directory made every folder outside it unreachable:
 * a project living in `/opt`, `/srv` or another user's tree could not be
 * picked at all, and the picker offered no way up because `parentPath` goes
 * null at the root. The default is now the top of the filesystem, so browsing
 * starts where the OS starts and everything the OS lets this process read is
 * reachable. Narrowing stays available — and is the right move for a shared
 * node — by setting `TM8_PROJECT_ROOTS`.
 *
 * POSIX has exactly one root and `/` spans every mount. Windows has no single
 * root: each volume is its own tree, so the drive holding the home directory
 * is joined by every other drive letter that currently answers. A drive that
 * is absent or has no media simply never appears.
 */
function osFilesystemRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const roots = new Set<string>();
  const homeVolume = parse(homedir()).root;
  if (homeVolume) roots.add(homeVolume);
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:${sep}`;
    if (existsSync(drive)) roots.add(drive);
  }
  // A Windows host that names no volume at all would otherwise leave the
  // picker with no root to open on; the home directory is always a real one.
  return roots.size > 0 ? [...roots] : [homedir()];
}

function configuredRoots(raw = process.env.TM8_PROJECT_ROOTS): string[] {
  const roots = raw?.split(delimiter).map((value) => value.trim()).filter(Boolean) ?? [];
  return roots.length > 0 ? roots : osFilesystemRoots();
}

export function containedBy(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

export async function canonicalRoots(rawRoots = configuredRoots()): Promise<string[]> {
  const roots = await Promise.all(rawRoots.map(async (raw) => {
    if (!isAbsolute(raw)) {
      throw new CollabError('invalid_input', `TM8_PROJECT_ROOTS entries must be absolute: ${raw}`);
    }
    try {
      const canonical = await realpath(raw);
      if (!(await stat(canonical)).isDirectory()) {
        throw new CollabError('invalid_input', `project browse root is not a directory: ${raw}`);
      }
      return canonical;
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw new CollabError('upstream_unavailable', `project browse root is unavailable: ${raw}`);
    }
  }));
  return [...new Set(roots)].sort((a, b) => a.localeCompare(b));
}

export function requireAllowed(path: string, roots: readonly string[]): void {
  if (!roots.some((root) => containedBy(root, path))) {
    throw new CollabError('forbidden', 'project directory is outside TM8_PROJECT_ROOTS');
  }
}

export async function canonicalDirectory(raw: string): Promise<string> {
  if (!isAbsolute(raw)) {
    throw new CollabError('invalid_input', 'project directory path must be absolute');
  }
  try {
    const canonical = await realpath(raw);
    if (!(await stat(canonical)).isDirectory()) {
      throw new CollabError('invalid_input', `not a directory: ${raw}`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof CollabError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CollabError('not_found', `no such directory: ${raw}`);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `directory is not readable: ${raw}`);
    }
    throw new CollabError('upstream_unavailable', `could not read directory: ${raw}`);
  }
}

/**
 * Read one node-local directory for the project picker. Symlink directories are
 * omitted from rows; a requested path is canonicalized before the containment
 * check, so neither direct input nor a symlink can escape an allowed root.
 */
export async function listProjectDirectories(
  requestedPath?: string,
  rawRoots?: readonly string[],
): Promise<ProjectDirectoryListing> {
  const roots = await canonicalRoots(rawRoots ? [...rawRoots] : undefined);
  const current = await canonicalDirectory(requestedPath?.trim() || roots[0]!);
  requireAllowed(current, roots);

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `directory is not readable: ${current}`);
    }
    throw new CollabError('upstream_unavailable', `could not list directory: ${current}`);
  }

  const allDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const root = roots.find((candidate) => containedBy(candidate, current))!;
  const parent = dirname(current);

  return {
    roots,
    path: current,
    parentPath: current === root || parent === current ? null : parent,
    separator: sep as '/' | '\\',
    directories: allDirectories.slice(0, MAX_PROJECT_DIRECTORIES),
    truncated: allDirectories.length > MAX_PROJECT_DIRECTORIES,
  };
}

/**
 * Ensure exactly one missing child directory beneath an allowed canonical
 * parent. Existing directories are accepted so retries are idempotent.
 */
export async function ensureProjectWorkingDirectory(
  requestedPath: string,
  rawRoots?: readonly string[],
): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    throw new CollabError('invalid_input', 'project workingDir must be absolute');
  }
  const roots = await canonicalRoots(rawRoots ? [...rawRoots] : undefined);

  try {
    const existing = await canonicalDirectory(requestedPath);
    requireAllowed(existing, roots);
    return existing;
  } catch (error) {
    if (!(error instanceof CollabError) || error.code !== 'not_found') throw error;
  }

  const normalized = resolve(requestedPath);
  const name = normalized.slice(dirname(normalized).length).replace(/^[/\\]+/, '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new CollabError('invalid_input', 'new project directory must be one child beneath an existing directory');
  }
  const parent = await canonicalDirectory(dirname(normalized));
  requireAllowed(parent, roots);
  const target = join(parent, name);

  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CollabError('forbidden', `cannot create project directory: ${target}`);
      }
      throw new CollabError('upstream_unavailable', `could not create project directory: ${target}`);
    }
  }

  const created = await canonicalDirectory(target);
  requireAllowed(created, roots);
  return created;
}
