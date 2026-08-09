/**
 * TURNING A DROPPED OR PICKED FOLDER INTO A LIST OF ENTRIES.
 *
 * THE BUG THIS FILE EXISTS TO NOT REPEAT. `files/AttachmentStrip.tsx:217-221`
 * reads `event.dataTransfer.files` on drop. For a dropped DIRECTORY that list
 * is EMPTY — not "one entry for the folder", empty — so dropping a folder there
 * does nothing at all, silently, and has for as long as the control has
 * existed. The only way a page sees inside a dropped directory is
 * `DataTransferItem.webkitGetAsEntry()` plus a recursive walk.
 *
 * THE SECOND BUG, which is subtler and is why the walk below loops.
 * `FileSystemDirectoryReader.readEntries()` does not answer the whole
 * directory. It answers a BATCH — Chrome's is 100 — and must be called again
 * until it answers an empty array. Code that calls it once appears to work on
 * every folder anyone tests by hand and silently truncates real ones at 100
 * entries. `readBatches` below is that loop, and it is asserted.
 *
 * THE THIRD, found in review: keeping only FILES loses every EMPTY directory.
 * A user who uploads a scaffold and gets back a tree missing its empty folders
 * has been quietly given something other than what they sent. So the walk
 * records DIRECTORIES too, and the archive writes them as members.
 *
 * THE TWO SOURCES ARE NOT EQUIVALENT, AND THE DIFFERENCE IS VISIBLE.
 * `<input webkitdirectory>` answers a flat `FileList`: it can only report
 * directories that contain a file, so an empty one is UNSEEABLE on that path.
 * That is a browser limitation, not a choice, and `source` carries it so the
 * screen can say so rather than silently dropping structure.
 */

export interface PickedFile {
  /** Path INSIDE the picked folder, `/`-separated, never absolute. */
  path: string;
  file: File;
}

export type PickedSkipReason = 'too-deep' | 'unreadable' | 'duplicate-name';

export interface PickedFolder {
  /** The folder the user actually pointed at, for naming the destination. */
  rootName: string;
  /**
   * How it was chosen. `picker` cannot see empty directories; `files` is a flat
   * selection with no directory structure at all.
   */
  source: 'drop' | 'picker' | 'files';
  files: PickedFile[];
  /** Every directory in the tree, `/`-separated, no trailing slash. */
  directories: string[];
  /**
   * Entries the walk itself declined, so the count the user sees is the count
   * that will be sent. Refusing quietly here would reproduce, one layer up,
   * exactly the silence this file exists to remove.
   */
  skipped: { path: string; reason: PickedSkipReason }[];
}

/**
 * A directory tree deeper than this is a symlink cycle or something equally
 * pathological. The walk is breadth-unbounded but depth-bounded, because a
 * cycle is the only way it fails to terminate.
 */
const MAX_DEPTH = 32;

/** The DOM types for this API are `@types/*`-shy, so they are named here. */
interface DirReader {
  readEntries(ok: (entries: FsEntry[]) => void, fail?: (error: unknown) => void): void;
}
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (file: File) => void, fail?: (error: unknown) => void): void;
  createReader?(): DirReader;
}

function readBatches(reader: DirReader): Promise<FsEntry[]> {
  // One `readEntries` answers ONE batch; the directory is finished only when a
  // call answers nothing.
  return new Promise((resolve, reject) => {
    const all: FsEntry[] = [];
    const pump = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) { resolve(all); return; }
        all.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

function fileOf(entry: FsEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) { reject(new Error('entry has no file accessor')); return; }
    entry.file(resolve, reject);
  });
}

interface WalkSink {
  files: PickedFile[];
  directories: string[];
  skipped: PickedFolder['skipped'];
}

async function walk(entry: FsEntry, prefix: string, depth: number, sink: WalkSink): Promise<void> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  if (depth > MAX_DEPTH) { sink.skipped.push({ path, reason: 'too-deep' }); return; }

  if (entry.isFile) {
    try {
      sink.files.push({ path, file: await fileOf(entry) });
    } catch {
      // A file the browser will not hand over is a FACT about this upload and
      // belongs in the count the user is shown, not in a swallowed catch.
      sink.skipped.push({ path, reason: 'unreadable' });
    }
    return;
  }

  if (!entry.isDirectory) return;
  // Recorded BEFORE the children are read, so an empty directory — the only
  // kind that has no other evidence it exists — still survives.
  sink.directories.push(path);
  if (!entry.createReader) return;

  let children: FsEntry[];
  try {
    children = await readBatches(entry.createReader());
  } catch {
    sink.skipped.push({ path, reason: 'unreadable' });
    return;
  }
  for (const child of children) await walk(child, path, depth + 1, sink);
}

/**
 * The DROP path. Returns `null` when the drop carried no directory at all, so
 * the caller can say "that was a file, not a folder" instead of showing an
 * empty upload.
 */
export async function folderFromDataTransfer(
  transfer: DataTransfer | null,
): Promise<PickedFolder | null> {
  const items = transfer?.items;
  if (!items) return null;

  // `items` is a live list; `webkitGetAsEntry` must be called before any await
  // or the entries are invalidated.
  const roots: FsEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i].webkitGetAsEntry?.() as FsEntry | null | undefined;
    if (entry && entry.isDirectory) roots.push(entry);
  }
  if (roots.length === 0) return null;

  const sink: WalkSink = { files: [], directories: [], skipped: [] };
  for (const root of roots) {
    const children = root.createReader ? await readBatches(root.createReader()) : [];
    for (const child of children) await walk(child, '', 1, sink);
  }
  return {
    rootName: roots[0].name,
    source: 'drop',
    files: sink.files,
    directories: sink.directories,
    skipped: sink.skipped,
  };
}

/**
 * The BUTTON path — `<input type="file" webkitdirectory>`. Every member carries
 * `webkitRelativePath` of the form `chosen-folder/a/b.txt`; the first segment is
 * the folder's own name and is stripped so both paths mean the same thing.
 *
 * Directories are DERIVED from the file paths, which is the most this API can
 * report: a directory holding no files leaves no trace in a `FileList` and
 * cannot be recovered here. `source: 'picker'` is what lets the screen say that
 * out loud instead of losing the folder silently.
 */
export function folderFromInput(list: FileList | null): PickedFolder | null {
  if (!list || list.length === 0) return null;
  const files: PickedFile[] = [];
  const directories = new Set<string>();
  let rootName = '';

  for (let i = 0; i < list.length; i += 1) {
    const file = list[i];
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const segments = relative.split('/').filter(Boolean);
    let path: string;
    if (segments.length > 1) {
      if (rootName === '') rootName = segments[0];
      path = segments.slice(1).join('/');
    } else {
      path = file.name;
    }
    files.push({ path, file });

    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join('/'));
    }
  }

  return {
    rootName: rootName || 'folder',
    source: 'picker',
    files,
    directories: [...directories],
    skipped: [],
  };
}

export function totalBytesOf(files: readonly PickedFile[]): number {
  return files.reduce((sum, picked) => sum + picked.file.size, 0);
}
