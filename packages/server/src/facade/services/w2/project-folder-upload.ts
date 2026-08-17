import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES,
  PROJECT_FOLDER_UPLOAD_MAX_FILES,
  PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES,
  PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES,
  type ProjectFolderUploadEntry,
} from '@tm8/contract';

interface NormalizedProjectFolderFile {
  kind: 'file';
  relativePath: string;
  sizeBytes: number;
  checksumSha256: string;
  mime: string;
}

export interface NormalizedProjectFolderManifest {
  directories: string[];
  files: NormalizedProjectFolderFile[];
  totalBytes: number;
}

export interface MaterializeProjectFolderInput {
  folderUploadId: string;
  destinationParent: string;
  rootName: string;
  manifest: NormalizedProjectFolderManifest;
  allowedRoots: string[];
  readBytes: (relativePath: string) => Promise<Uint8Array>;
}

export interface MaterializedProjectFolder {
  workingDir: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  /** Manifest files that had no entry at their destination path. */
  addedCount: number;
  /** Manifest files that overwrote something already at their destination path. */
  replacedCount: number;
  /** True when this call created the destination root rather than merging into one. */
  createdRoot: boolean;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function validateRelativePath(relativePath: string): string[] {
  if (relativePath.length === 0) throw new Error('relative path must not be empty');
  if (Buffer.byteLength(relativePath, 'utf8') > PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES) {
    throw new Error(`relative path exceeds ${PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES} bytes`);
  }
  if (relativePath.includes('\0')) throw new Error('relative path contains NUL');
  if (relativePath.includes('\\')) throw new Error('relative path must use POSIX separators');
  if (relativePath.startsWith('/') || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error('relative path must not be absolute');
  }

  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('relative path contains an empty, dot, or dot-dot segment');
  }
  return segments;
}

function collisionKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Validate the client manifest before any upload grant or filesystem write.
 * Paths are refused rather than normalised so logs retain the exact hostile
 * input. The returned directory list includes parents implied by file paths.
 */
export function normalizeProjectFolderManifest(
  entries: ProjectFolderUploadEntry[],
): NormalizedProjectFolderManifest {
  const explicitKinds = new Map<string, ProjectFolderUploadEntry['kind']>();
  const canonicalPaths = new Map<string, string>();
  const directories = new Set<string>();
  const files: NormalizedProjectFolderFile[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const segments = validateRelativePath(entry.relativePath);
    const key = collisionKey(entry.relativePath);
    const collidedWith = canonicalPaths.get(key);
    if (collidedWith !== undefined) {
      throw new Error(`path collision between ${collidedWith} and ${entry.relativePath}`);
    }
    canonicalPaths.set(key, entry.relativePath);
    explicitKinds.set(entry.relativePath, entry.kind);

    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }

    if (entry.kind === 'directory') {
      directories.add(entry.relativePath);
      continue;
    }

    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error(`file ${entry.relativePath} has an invalid size`);
    }
    if (!SHA256_HEX.test(entry.checksumSha256)) {
      throw new Error(`file ${entry.relativePath} has an invalid sha-256 checksum`);
    }
    totalBytes += entry.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES) {
      throw new Error(`folder upload exceeds ${PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES} bytes`);
    }
    files.push({ ...entry });
  }

  if (files.length > PROJECT_FOLDER_UPLOAD_MAX_FILES) {
    throw new Error(`folder upload exceeds ${PROJECT_FOLDER_UPLOAD_MAX_FILES} files`);
  }
  if (directories.size > PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES) {
    throw new Error(`folder upload exceeds ${PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES} directories`);
  }

  for (const directory of directories) {
    if (explicitKinds.get(directory) === 'file') {
      throw new Error(`file/directory parent collision at ${directory}`);
    }
  }

  return {
    directories: [...directories].sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length;
      return depth === 0 ? left.localeCompare(right) : depth;
    }),
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    totalBytes,
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

function validateRootName(rootName: string): void {
  if (
    rootName.length === 0
    || rootName === '.'
    || rootName === '..'
    || rootName.includes('/')
    || rootName.includes('\\')
    || rootName.includes('\0')
  ) {
    throw new Error('rootName must be one directory name');
  }
}

async function entryTypeAt(path: string): Promise<'file' | 'directory' | 'other' | 'absent'> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

/**
 * Ensure `<root>/<...segments>` exists as a directory and still resolves inside
 * `root`. The containment re-check is the point: `mkdir -p` happily follows an
 * existing subdirectory that is a symlink out of the tree, so proving the
 * destination parent at the start of the call does not prove where a nested
 * write lands.
 */
async function ensureContainedDirectory(root: string, segments: string[]): Promise<string> {
  const target = resolve(root, ...segments);
  await mkdir(target, { recursive: true });
  const resolved = await realpath(target);
  if (!isWithinRoot(resolved, root)) {
    throw new Error(`directory ${segments.join('/')} resolves outside the destination root`);
  }
  return resolved;
}

/**
 * Reconstruct a validated upload beneath a server-approved parent, MERGING into
 * an existing root when one is already there (ruling R8): a manifest path
 * replaces whatever sits at that path, a path the manifest does not name is
 * left alone, and the caller is told how many were replaced rather than being
 * left to infer it.
 *
 * Every byte is verified against its declared size and sha-256 while landing in
 * a staging directory, and only then moved into the destination. So a corrupt
 * or truncated blob cannot destroy a file that was already there — the failure
 * happens before the destination is touched at all.
 *
 * The commit walk itself is not atomic across files: once moves begin, an I/O
 * failure part-way leaves a partially merged tree. That is stated rather than
 * papered over, because the alternative (build a whole new tree and swap it)
 * would delete every path the manifest does not name, which is exactly what R8
 * says must not happen.
 */
export async function materializeProjectFolder(
  input: MaterializeProjectFolderInput,
): Promise<MaterializedProjectFolder> {
  validateRootName(input.rootName);
  if (input.allowedRoots.length === 0) throw new Error('no server upload roots are configured');

  const [resolvedParent, ...resolvedRoots] = await Promise.all([
    realpath(input.destinationParent),
    ...input.allowedRoots.map((root) => realpath(root)),
  ]);
  if (!resolvedRoots.some((root) => isWithinRoot(resolvedParent, root))) {
    throw new Error('destination parent is outside the allowed server roots');
  }

  const workingDir = resolve(resolvedParent, input.rootName);
  if (!isWithinRoot(workingDir, resolvedParent)) {
    throw new Error('destination root escapes its parent');
  }

  const rootType = await entryTypeAt(workingDir);
  if (rootType === 'file' || rootType === 'other') {
    // Includes a symlink: lstat does not follow it, so a link named like the
    // upload root is refused instead of being merged into whatever it points at.
    throw new Error('destination root exists and is not a directory');
  }
  const createdRoot = rootType === 'absent';

  const stagingDir = resolve(resolvedParent, `.tm8-folder-upload-${input.folderUploadId}`);
  if (!isWithinRoot(stagingDir, resolvedParent)) {
    throw new Error('staging directory escapes its parent');
  }
  await mkdir(stagingDir, { recursive: false });

  try {
    // --- stage and verify: nothing below reaches the destination -------------
    for (const file of input.manifest.files) {
      const bytes = await input.readBytes(file.relativePath);
      if (bytes.byteLength !== file.sizeBytes) {
        throw new Error(`size mismatch for ${file.relativePath}`);
      }
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (checksum !== file.checksumSha256) {
        throw new Error(`checksum mismatch for ${file.relativePath}`);
      }
      const segments = file.relativePath.split('/');
      if (segments.length > 1) {
        await mkdir(resolve(stagingDir, ...segments.slice(0, -1)), { recursive: true });
      }
      await writeFile(resolve(stagingDir, ...segments), bytes, { flag: 'wx' });
    }

    // A parent symlink swap during the transfer would move the destination out
    // from under the containment proof taken above.
    const finalParent = await realpath(input.destinationParent);
    if (finalParent !== resolvedParent) throw new Error('destination parent changed during upload');

    // --- commit --------------------------------------------------------------
    if (createdRoot) await mkdir(workingDir, { recursive: false });

    for (const directory of input.manifest.directories) {
      await ensureContainedDirectory(workingDir, directory.split('/'));
    }

    let addedCount = 0;
    let replacedCount = 0;
    for (const file of input.manifest.files) {
      const segments = file.relativePath.split('/');
      const parent = segments.length > 1
        ? await ensureContainedDirectory(workingDir, segments.slice(0, -1))
        : workingDir;
      const destination = resolve(parent, segments[segments.length - 1]!);

      const existing = await entryTypeAt(destination);
      if (existing === 'directory') {
        // Replacing a directory with a file would mean deleting everything under
        // it, which is a destruction the manifest never described.
        throw new Error(`${file.relativePath} exists as a directory at the destination`);
      }
      if (existing === 'absent') addedCount += 1;
      else replacedCount += 1;

      // rename replaces the destination entry itself, so a symlink sitting there
      // is overwritten rather than written THROUGH.
      await rename(resolve(stagingDir, ...segments), destination);
    }

    return {
      workingDir,
      fileCount: input.manifest.files.length,
      directoryCount: input.manifest.directories.length,
      totalBytes: input.manifest.totalBytes,
      addedCount,
      replacedCount,
      createdRoot,
    };
  } catch (error) {
    // Only a root this call created is removed. A pre-existing root belongs to
    // whoever put it there and is never deleted on a failed merge.
    if (createdRoot) await rm(workingDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
