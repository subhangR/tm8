/**
 * PACKING THE PICKED FOLDER INTO ONE ARCHIVE.
 *
 * One archive, not N requests: the transport ruling (FILES-DESIGN R2) is "one
 * archive, streamed, expanded server-side". A four-thousand-file folder sent as
 * four thousand requests is four thousand chances to half-succeed, and a
 * half-uploaded snapshot is worse than none because it looks complete.
 *
 * PROGRESS IS REPORTED WHILE READING, NOT AFTER. Reading a large folder off
 * disk takes real time, and a screen that shows nothing until packing finishes
 * and then jumps to "uploading" has lied about where the wait was.
 *
 * CANCELLATION IS CHECKED BETWEEN FILES, and that is the honest granularity:
 * one file's read is not interruptible, so the abort takes effect at the next
 * boundary rather than instantly. The UI says "cancelling" and then
 * "cancelled", never the other way round.
 *
 * NOTHING IS DROPPED SILENTLY. A path the archive writer will not encode is
 * REFUSED, not repaired — `../etc/passwd` never becomes `etc/passwd` — and it
 * leaves here in `skipped[]` with the reason it was refused, so the client-side
 * refusals and the server's arrive at the screen in one shape.
 */
import { type PickedFolder, totalBytesOf } from './picked-folder';
import { rejectArchivePath, type ZipEntry, zipBlob } from './zip';

export interface PackProgress {
  filesPacked: number;
  totalFiles: number;
  bytesPacked: number;
  totalBytes: number;
}

export interface PackedFolder {
  archive: Blob;
  includedFiles: number;
  includedDirectories: number;
  totalBytes: number;
  skipped: { path: string; reason: string }[];
}

export class UploadCancelled extends Error {
  constructor() {
    super('Cancelled before the upload finished.');
    this.name = 'UploadCancelled';
  }
}

/**
 * Human text for the reasons THIS PAGE produces. A reason the server invents is
 * rendered raw rather than mistranslated — an unknown code shown verbatim is
 * honest; an unknown code shown as "skipped" is not.
 */
export const SKIP_REASON_TEXT: Record<string, string> = {
  traversal: 'the path steps outside the folder (`.` or `..`), so it was refused rather than rewritten',
  absolute: 'the path is absolute, so it names somewhere other than inside this folder',
  backslash: 'the name contains a backslash, which is a legal filename character and cannot be safely read as a separator',
  'drive-letter': 'the path carries a Windows drive letter, so it names another volume',
  'control-character': 'the name contains a control character',
  'name-too-long': 'the name is longer than an archive entry can record (65,535 bytes)',
  'too-deep': 'the tree is nested deeper than 32 levels here, which is a link cycle rather than a folder',
  unreadable: 'the browser would not hand this entry over',
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UploadCancelled();
}

export async function packFolder(
  picked: PickedFolder,
  opts: { signal?: AbortSignal; onProgress?: (progress: PackProgress) => void } = {},
): Promise<PackedFolder> {
  const skipped: PackedFolder['skipped'] = picked.skipped.map((entry) => ({ ...entry }));

  const directories = picked.directories.filter((path) => {
    const rejection = rejectArchivePath(path);
    if (rejection === null) return true;
    skipped.push({ path, reason: rejection });
    return false;
  });

  const files = picked.files.filter((entry) => {
    const rejection = rejectArchivePath(entry.path);
    if (rejection === null) return true;
    skipped.push({ path: entry.path, reason: rejection });
    return false;
  });

  const totalBytes = totalBytesOf(files);
  // Directory members first: an expander that creates parents on demand does
  // not need them, and one that does not, does.
  const entries: ZipEntry[] = directories.map((path) => ({ path, kind: 'directory' as const }));
  let bytesPacked = 0;

  opts.onProgress?.({ filesPacked: 0, totalFiles: files.length, bytesPacked: 0, totalBytes });

  for (const picked_ of files) {
    throwIfAborted(opts.signal);
    const buffer = await picked_.file.arrayBuffer();
    entries.push({
      path: picked_.path,
      kind: 'file',
      bytes: new Uint8Array(buffer),
      modifiedAt: new Date(picked_.file.lastModified || Date.now()),
    });
    bytesPacked += buffer.byteLength;
    opts.onProgress?.({
      filesPacked: entries.length - directories.length,
      totalFiles: files.length,
      bytesPacked,
      totalBytes,
    });
  }

  throwIfAborted(opts.signal);
  return {
    archive: zipBlob(entries),
    includedFiles: files.length,
    includedDirectories: directories.length,
    totalBytes,
    skipped,
  };
}

/** Bytes, in the register the progress line uses. Never rounded to zero. */
export function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Thousands separators, because "4812 files" and "4,812 files" read differently. */
export function countLabel(count: number): string {
  return count.toLocaleString('en-US');
}
