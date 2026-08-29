/**
 * PICKER & DROP TRAVERSAL — how local files and whole folders enter the queue
 * with their relative paths intact.
 *
 * Three entry doors, one output shape (`PickedFile { file, relativePath }`):
 *
 *   1. `<input type="file" multiple>` — plain files, relativePath = name.
 *   2. `<input webkitdirectory>` — the browser fills `webkitRelativePath`
 *      (`folder/sub/name.ext`); it is preserved verbatim.
 *   3. Drag-drop — `DataTransferItem.webkitGetAsEntry()` walks dropped
 *      directories recursively. `readEntries()` MUST be called until it
 *      answers an empty batch: Chromium returns at most 100 entries per call,
 *      and stopping after one call silently drops file 101 — a data-loss bug
 *      that no small test folder ever shows.
 *
 * Paths are POSIX-normalised and traversal-refused here at the boundary
 * (`..`, absolute, backslash, NUL), because the queue and the node must never
 * see a hostile path shape — the same refusal list the server's manifest
 * validator enforces, applied client-side first so the user gets words
 * instead of a 400.
 */

export interface PickedFile {
  file: File;
  /** Root-relative POSIX path, always ending in the file's name. */
  relativePath: string;
}

export interface PickResult {
  files: PickedFile[];
  /** Paths refused at the boundary, with the offending shape named. */
  refused: Array<{ path: string; reason: string }>;
}

/** True when the path is safe to carry; the reason otherwise. */
export function refuseReason(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (path.includes('\0')) return 'NUL byte in path';
  if (path.includes('\\')) return 'backslash separator';
  if (path.startsWith('/')) return 'absolute path';
  const segments = path.split('/');
  if (segments.some((s) => s === '..')) return 'path traversal (..)';
  if (segments.some((s) => s === '' || s === '.')) return 'empty or dot segment';
  return null;
}

function collect(result: PickResult, file: File, rawPath: string) {
  const path = rawPath || file.name;
  const reason = refuseReason(path);
  if (reason) result.refused.push({ path, reason });
  else result.files.push({ file, relativePath: path });
}

/** Door 1 + 2: a change event on a file input (plain or `webkitdirectory`). */
export function filesFromInput(list: FileList | null): PickResult {
  const result: PickResult = { files: [], refused: [] };
  if (!list) return result;
  for (const file of Array.from(list)) {
    const relative = (file as { webkitRelativePath?: string }).webkitRelativePath;
    collect(result, file, relative && relative.length > 0 ? relative : file.name);
  }
  return result;
}

// -- Door 3: drag-drop ------------------------------------------------------

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: EntryLike[]) => void, err: (e: unknown) => void): void };
}

async function walkEntry(entry: EntryLike, prefix: string, result: PickResult): Promise<void> {
  const path = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file!((f) => resolve(f), () => resolve(null));
    });
    if (file) collect(result, file, path);
    else result.refused.push({ path, reason: 'unreadable file' });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // Drain until an EMPTY batch — Chromium pages readEntries at 100.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((resolve) => {
        reader.readEntries((entries) => resolve(entries), () => resolve([]));
      });
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, path, result);
    }
  }
}

/**
 * Door 3: a drop event's DataTransfer. Falls back to the flat file list when
 * `webkitGetAsEntry` is absent (then a dropped directory yields nothing and
 * the caller should say so rather than pretend).
 */
export async function filesFromDataTransfer(data: DataTransfer | null): Promise<PickResult> {
  const result: PickResult = { files: [], refused: [] };
  if (!data) return result;
  const items = Array.from(data.items ?? []);
  const entries = items
    .map((item) => (item as { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is EntryLike => entry !== null);
  if (entries.length > 0) {
    for (const entry of entries) await walkEntry(entry, '', result);
    return result;
  }
  for (const file of Array.from(data.files ?? [])) collect(result, file, file.name);
  return result;
}

// -- Conflict preflight -----------------------------------------------------

export type ConflictChoice = 'keep-both' | 'replace' | 'skip';

export interface UploadConflict {
  relativePath: string;
  /** The existing entry's name the upload would collide with. */
  existingName: string;
}

/** Names that would collide with entries already in the destination. */
export function findConflicts(
  picked: readonly PickedFile[],
  existingNames: ReadonlySet<string>,
): UploadConflict[] {
  const conflicts: UploadConflict[] = [];
  for (const { relativePath } of picked) {
    const top = relativePath.split('/')[0]!;
    if (existingNames.has(top)) conflicts.push({ relativePath, existingName: top });
  }
  return conflicts;
}

/**
 * `keep-both` renaming: `name.ext` → `name (2).ext`, counting up past any
 * taken candidate. Applied to the TOP segment so a whole dropped folder is
 * kept-both once, not per file.
 */
export function keepBothName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.startsWith('.') ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Apply one choice to every conflicted pick; non-conflicted picks pass through. */
export function resolveConflicts(
  picked: readonly PickedFile[],
  existingNames: ReadonlySet<string>,
  choice: ConflictChoice,
): PickedFile[] {
  const conflicted = new Set(findConflicts(picked, existingNames).map((c) => c.relativePath));
  if (conflicted.size === 0 || choice === 'replace') return [...picked];
  if (choice === 'skip') return picked.filter((p) => !conflicted.has(p.relativePath));
  // keep-both: rename the top segment consistently per distinct collision.
  const renames = new Map<string, string>();
  const taken = new Set(existingNames);
  return picked.map((p) => {
    if (!conflicted.has(p.relativePath)) return p;
    const segments = p.relativePath.split('/');
    const top = segments[0]!;
    let renamed = renames.get(top);
    if (!renamed) {
      renamed = keepBothName(top, taken);
      taken.add(renamed);
      renames.set(top, renamed);
    }
    return { file: p.file, relativePath: [renamed, ...segments.slice(1)].join('/') };
  });
}
