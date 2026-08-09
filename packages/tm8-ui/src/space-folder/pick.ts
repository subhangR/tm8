import type { PickedFile, PickedTree, RefusedPath } from './preflight';

/**
 * Two ways in, and they are NOT the same mechanism.
 *
 * 1. `<input type="file" webkitdirectory>` yields a flat FileList where each
 *    File carries `webkitRelativePath` — the tree is already walked for us. It
 *    cannot report an empty directory, because a directory containing no files
 *    contributes no entry to a FileList. That is a browser limit, and the tree
 *    records it (`emptyDirectoriesObservable: false`) rather than letting the
 *    UI claim the structure was preserved.
 * 2. A DIRECTORY DROP yields nothing useful from `dataTransfer.files`; a
 *    dropped folder is not a File. The tree only exists behind
 *    `DataTransferItem.webkitGetAsEntry()` and has to be walked by hand — which
 *    is also the only path that CAN observe an empty directory.
 *
 * Both funnel into the same `PickedTree`, so preflight, archive and progress
 * never learn which door the bytes came through.
 */

/**
 * A path we will not send. Refusal is deliberate: normalising `a/../b` into `b`
 * would upload a file to a location the user never picked, and stripping a
 * leading slash would silently reparent it.
 */
export function refusePath(path: string): string | null {
  if (path.length === 0) return 'Empty path.';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'Absolute path, not relative to the folder.';
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) return 'Empty path segment.';
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'Path points outside the folder root.';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'Path contains control characters.';
  return null;
}

/**
 * The first segment of `webkitRelativePath` is the LOCAL directory's own name.
 * It is stripped: the destination root is named separately by the user, and
 * keeping both would nest the tree under itself (`<root>/<localName>/…`).
 */
export function treeFromFileList(files: readonly File[]): PickedTree {
  let rootName = '';
  const picked: PickedFile[] = [];
  const refused: RefusedPath[] = [];
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    let path: string;
    if (relative) {
      const segments = relative.split('/');
      if (!rootName && segments.length > 1) rootName = segments[0]!;
      path = segments.length > 1 ? segments.slice(1).join('/') : segments.join('/');
    } else {
      path = file.name;
    }
    const refusal = refusePath(path);
    if (refusal) refused.push({ path: relative || file.name, reason: refusal });
    else picked.push({ path, size: file.size, file });
  }
  return {
    rootName,
    files: picked,
    emptyDirectories: [],
    // A FileList cannot contain an empty directory, so "none found" here is not
    // a measurement — it is an inability to measure, and it says so.
    emptyDirectoriesObservable: false,
    refused,
  };
}

type DirectoryReaderLike = {
  readEntries(ok: (entries: FileSystemEntry[]) => void, fail?: (error: unknown) => void): void;
};
type EntryLike = {
  isFile?: boolean;
  isDirectory?: boolean;
  name: string;
  file?(ok: (file: File) => void, fail?: (error: unknown) => void): void;
  createReader?(): DirectoryReaderLike;
};

function entryFile(entry: EntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) {
      reject(new Error(`Cannot read “${entry.name}”.`));
      return;
    }
    entry.file(resolve, reject);
  });
}

/**
 * `readEntries` is capped per call (100 in Chromium) and signals the end with an
 * EMPTY batch, not with the whole listing. Reading it once silently truncates
 * any directory with more than a hundred children — which is exactly the kind of
 * directory a person uploads.
 */
function readAllEntries(reader: DirectoryReaderLike): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = () => {
      reader.readEntries((batch) => {
        if (!batch || batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

interface Walk {
  readonly files: PickedFile[];
  readonly emptyDirectories: string[];
  readonly refused: RefusedPath[];
}

/** Returns how many files were found at or beneath `entry`. */
async function walkEntry(entry: EntryLike, prefix: string, out: Walk): Promise<number> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  const refusal = refusePath(path);
  if (refusal) {
    out.refused.push({ path, reason: refusal });
    return 0;
  }
  if (entry.isFile) {
    const file = await entryFile(entry);
    out.files.push({ path, size: file.size, file });
    return 1;
  }
  if (entry.isDirectory && entry.createReader) {
    const children = await readAllEntries(entry.createReader());
    let found = 0;
    for (const child of children) {
      found += await walkEntry(child as unknown as EntryLike, path, out);
    }
    // Only the deepest empty directory is recorded; creating `a/b/c` creates
    // `a` and `a/b` too, so listing all three would triple-count the structure.
    if (found === 0) out.emptyDirectories.push(path);
    return found;
  }
  return 0;
}

export interface DataTransferLike {
  readonly items?: ArrayLike<{ webkitGetAsEntry?(): FileSystemEntry | null }> | null;
  readonly files?: ArrayLike<File> | null;
}

/**
 * Walks a directory drop. Returns null when the drop carried no directory at
 * all — the caller renders that as a refusal with a reason, because a drop that
 * quietly produces an empty tree is indistinguishable from an empty folder.
 */
export async function treeFromDataTransfer(
  transfer: DataTransferLike | null | undefined,
): Promise<PickedTree | null> {
  const items = transfer?.items;
  if (!items || items.length === 0) return null;

  // webkitGetAsEntry must be called synchronously while the drop event's items
  // are still alive; awaiting first empties the list.
  const entries: EntryLike[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index]?.webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry as unknown as EntryLike);
  }
  const directories = entries.filter((entry) => entry.isDirectory);
  if (directories.length === 0) return null;

  const root = directories[0]!;
  const walk: Walk = { files: [], emptyDirectories: [], refused: [] };
  const children = await readAllEntries(root.createReader!());
  for (const child of children) {
    await walkEntry(child as unknown as EntryLike, '', walk);
  }
  return {
    rootName: root.name,
    files: walk.files,
    emptyDirectories: walk.emptyDirectories,
    emptyDirectoriesObservable: true,
    refused: walk.refused,
  };
}

/** A destination root name the server can hold: one segment, no separators. */
export function isValidRootName(name: string): boolean {
  const clean = name.trim();
  return clean.length > 0 && clean !== '.' && clean !== '..' && !/[\\/]/.test(clean);
}
