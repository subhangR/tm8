import type { PickedFile } from './preflight';

/**
 * THE ARCHIVE BOUNDARY — a TYPE and an injection point, deliberately NOT an
 * encoder.
 *
 * FORMAT RULING (Track 5 coordinator, 2026-08-09): stored ZIP, compression
 * method 0. OWNERSHIP RULING (same source): Lane C owns the one reusable
 * store-only encoder (`files-browser/archive.ts` + `zip.ts`) and this lane must
 * not land a second one. This lane had written one; it was deleted rather than
 * shipped, because two encoders for one format is exactly how two lanes end up
 * producing archives a server accepts differently.
 *
 * So the packer is INJECTED. Until Lane C's commit lands there is no packer on
 * this node, and the optional step renders disabled-with-reason — the same
 * honest absence as a missing `seam.spaceFolders`, never a control that looks
 * available and then cannot pack.
 */

export interface ArchiveSkipped {
  readonly path: string;
  readonly reason: string;
}

export interface ZipPackInput {
  readonly files: readonly PickedFile[];
  /**
   * Directories with nothing beneath them, to be written as explicit
   * zero-length members. Without them an empty directory vanishes from the
   * uploaded tree.
   */
  readonly directories: readonly string[];
}

export interface PackOptions {
  signal?: AbortSignal;
  /** Called after each member is written, so packing a tree is not a freeze. */
  onProgress?(packedMembers: number, totalMembers: number): void;
}

export interface PackedArchive {
  readonly blob: Blob;
  /** File members written. */
  readonly entries: number;
  /** Directory members written. */
  readonly directoryEntries: number;
  /** Sum of the file payload sizes — the honest "bytes of your files". */
  readonly bytes: number;
  /** Paths the encoder could NOT represent, surfaced rather than dropped. */
  readonly skipped: readonly ArchiveSkipped[];
}

/**
 * The adapter contract this lane consumes. At integration a thin wrapper over
 * Lane C's published encoder satisfies it; nothing else in this lane changes.
 */
export type ZipPacker = (input: ZipPackInput, options?: PackOptions) => Promise<PackedArchive>;

export const SPACE_FOLDER_PACKER_UNAVAILABLE_REASON =
  'This build cannot package a folder for upload yet, so the folder step is off. Creating the Space still works.';
