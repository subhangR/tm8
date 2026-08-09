import type { SpaceId } from '@tm8/contract';

/**
 * Lane B owns `seam.spaceFolders`. It is not in this repository at base
 * 541951a — grep for `spaceFolders` returns nothing — so this lane MIRRORS the
 * shapes Lane B published and reads the group through ONE narrowing accessor
 * (`readSpaceFoldersPort`).
 *
 * These declarations are a mirror, not a second contract. When Lane B's seam
 * commit lands, delete them and import the real types from `@tm8/contract`;
 * only this file changes.
 *
 * The uploaded tree is an IMMUTABLE SPACE FOLDER SNAPSHOT — space-owned bytes.
 * It is deliberately NOT a linked live Project and NOT one entity per file, and
 * the step says so on screen so a user cannot mistake it for connected disk.
 */

/** Mirrors `@tm8/contract`'s `SpaceFolderSummary`. */
export interface SpaceFolderSummary {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly entryCount: number;
  readonly totalSizeBytes: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A path the SERVER declined, surfaced rather than swallowed. */
export interface SpaceFolderSkipped {
  readonly path: string;
  readonly reason: string;
}

/**
 * Lane B's upload result. Note there is NO `expandedFiles` and no `totalBytes`:
 * the counts are `added`/`replaced`/`directories`, and the size of the folder
 * afterwards is `folder.totalSizeBytes`. Reporting a total the contract does not
 * return would be a number this lane invented.
 */
export interface SpaceFolderUploadResult {
  readonly folder: SpaceFolderSummary;
  readonly added: number;
  readonly replaced: number;
  readonly directories: number;
  readonly skipped: readonly SpaceFolderSkipped[];
}

export interface SpaceFolderUploadOpts {
  signal?: AbortSignal;
  onProgress?(sent: number, total: number): void;
}

export interface SpaceFoldersPort {
  create(spaceId: SpaceId, name: string): Promise<SpaceFolderSummary>;
  upload(
    folderId: string,
    destPath: string,
    archive: Blob,
    opts?: SpaceFolderUploadOpts,
  ): Promise<SpaceFolderUploadResult>;
}

/**
 * The archive expands AT the folder root, which Lane B spells as the empty
 * string. `create(spaceId, name)` has already named the root, so repeating the
 * name here would nest it under itself (`<name>/<name>/…`). Named rather than
 * inlined because it is exactly the kind of convention two lanes can disagree
 * about silently.
 */
export const SPACE_FOLDER_ROOT_DEST = '';

/** The one place that knows the group is optional and not yet on the Seam type. */
export function readSpaceFoldersPort(seam: unknown): SpaceFoldersPort | null {
  const group = (seam as { spaceFolders?: unknown } | null | undefined)?.spaceFolders as
    | Partial<SpaceFoldersPort>
    | undefined;
  if (!group || typeof group.create !== 'function' || typeof group.upload !== 'function') {
    return null;
  }
  return group as SpaceFoldersPort;
}

/**
 * Why the step is off, in the user's words. Absence is rendered as a REASON,
 * never as a step that looks available and then does nothing.
 */
export const SPACE_FOLDER_UNAVAILABLE_REASON =
  'This node does not offer Space folder storage, so a folder cannot be uploaded here. Creating the Space still works.';
