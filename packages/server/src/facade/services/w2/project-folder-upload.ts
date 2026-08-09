import { createHash } from 'node:crypto';
import { access, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
  /**
   * 'create' (default) reserves a NEW root exclusively; 'merge' re-uploads
   * into an EXISTING root (R8): every byte is staged and verified in a
   * sibling temp directory first, then matching paths are replaced by atomic
   * rename and new paths added. Nothing under the root is deleted.
   */
  mode?: 'create' | 'merge';
}

export interface MaterializedProjectFolder {
  workingDir: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  /** Files that already existed and were replaced in place (0 for 'create'). */
  replacedCount: number;
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

/**
 * Reconstruct a validated upload beneath a server-approved parent. Creating
 * the destination root is the exclusive reservation: an existing target is
 * never replaced, and any failed verification removes only that new root.
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

  const mode = input.mode ?? 'create';
  if (mode === 'merge') {
    return mergeProjectFolder(input, resolvedParent, workingDir);
  }

  let ownsDestination = false;
  try {
    await mkdir(workingDir, { recursive: false });
    ownsDestination = true;

    for (const directory of input.manifest.directories) {
      await mkdir(resolve(workingDir, ...directory.split('/')), { recursive: true });
    }

    for (const file of input.manifest.files) {
      const bytes = await verifiedBytes(input, file);
      const segments = file.relativePath.split('/');
      if (segments.length > 1) {
        await mkdir(resolve(workingDir, ...segments.slice(0, -1)), { recursive: true });
      }
      await writeFile(resolve(workingDir, ...segments), bytes, { flag: 'wx' });
    }

    // Re-check the parent after writing. This catches a parent symlink swap
    // before the result is returned and therefore before a Project is linked.
    const finalParent = await realpath(input.destinationParent);
    if (finalParent !== resolvedParent) throw new Error('destination parent changed during upload');

    return {
      workingDir,
      fileCount: input.manifest.files.length,
      directoryCount: input.manifest.directories.length,
      totalBytes: input.manifest.totalBytes,
      replacedCount: 0,
    };
  } catch (error) {
    if (ownsDestination) await rm(workingDir, { recursive: true, force: true });
    throw error;
  }
}

async function verifiedBytes(
  input: MaterializeProjectFolderInput,
  file: NormalizedProjectFolderFile,
): Promise<Uint8Array> {
  const bytes = await input.readBytes(file.relativePath);
  if (bytes.byteLength !== file.sizeBytes) {
    throw new Error(`size mismatch for ${file.relativePath}`);
  }
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== file.checksumSha256) {
    throw new Error(`checksum mismatch for ${file.relativePath}`);
  }
  return bytes;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * R8 merge-and-replace. The existing root is REQUIRED. Every byte is written
 * and verified inside a sibling staging directory first, so a size or
 * checksum failure leaves the existing root byte-identical; only the apply
 * phase (atomic per-file renames on one filesystem) touches it.
 */
async function mergeProjectFolder(
  input: MaterializeProjectFolderInput,
  resolvedParent: string,
  workingDir: string,
): Promise<MaterializedProjectFolder> {
  const resolvedWorkingDir = await realpath(workingDir).catch(() => {
    throw new Error('merge destination does not exist');
  });
  if (!isWithinRoot(resolvedWorkingDir, resolvedParent)) {
    throw new Error('merge destination escapes its parent');
  }

  const stagingDir = resolve(resolvedParent, `.tm8-folder-upload-${input.folderUploadId}`);
  let replacedCount = 0;
  try {
    await mkdir(stagingDir, { recursive: false });

    for (const file of input.manifest.files) {
      const bytes = await verifiedBytes(input, file);
      const segments = file.relativePath.split('/');
      if (segments.length > 1) {
        await mkdir(resolve(stagingDir, ...segments.slice(0, -1)), { recursive: true });
      }
      await writeFile(resolve(stagingDir, ...segments), bytes, { flag: 'wx' });
    }

    // Everything verified; apply. Directories first, then per-file rename.
    for (const directory of input.manifest.directories) {
      await mkdir(resolve(workingDir, ...directory.split('/')), { recursive: true });
    }
    for (const file of input.manifest.files) {
      const segments = file.relativePath.split('/');
      const target = resolve(workingDir, ...segments);
      if (segments.length > 1) {
        await mkdir(resolve(workingDir, ...segments.slice(0, -1)), { recursive: true });
      }
      if (await exists(target)) replacedCount += 1;
      await rename(resolve(stagingDir, ...segments), target);
    }

    const finalParent = await realpath(input.destinationParent);
    if (finalParent !== resolvedParent) throw new Error('destination parent changed during upload');

    return {
      workingDir,
      fileCount: input.manifest.files.length,
      directoryCount: input.manifest.directories.length,
      totalBytes: input.manifest.totalBytes,
      replacedCount,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
