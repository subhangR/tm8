/**
 * THE SPACE-FOLDERS SEAM GROUP, as this screen consumes it.
 *
 * WHY THE SHAPE IS DECLARED HERE AND NOT IN `data/seam.ts`. `data/seam.ts` is
 * another lane's file and this lane does not edit it. The group's SIGNATURES
 * were published in advance precisely so the screen could be written against
 * them before they exist, so they are restated here as a structural type and
 * read off the seam through one narrowing accessor. When the real group lands
 * this file is where the two descriptions meet, and a mismatch is a type error
 * in exactly one place instead of a runtime surprise in six.
 *
 * THESE ARE LANE B'S MEASURED CONTRACT SHAPES, not placeholders (adapted
 * 2026-08-09 on the coordinator's relay). Three details that a provisional
 * guess got wrong and that change the screen:
 *   · paths are RELATIVE to the folder and the root is `''`, so there is no
 *     `workingDir` prefix to hide and no absolute path to show;
 *   · there is NO `parentPath` and NO `separator` — the parent is DERIVED from
 *     the relative path, and the separator is always `/`;
 *   · a file's type field is `mediaType`, not `mime`.
 *
 * `spaceFolders` is OPTIONAL and is absent in this build. That absence is a
 * fact, not an error, and the screen renders it as disabled-with-reason — never
 * as an empty folder list, which a user would read as "I have not uploaded
 * anything yet" and act on.
 *
 * When Lane B publishes its seam commit these types are deleted and the
 * `@tm8/contract` ones imported in their place; nothing outside this file and
 * `roots.ts` refers to them.
 */
import type { Seam } from '../data/seam';

export interface SpaceFolderSummary {
  id: string;
  spaceId: string;
  name: string;
  entryCount: number;
  totalSizeBytes: number;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SpaceFolderEntry {
  name: string;
  /** Relative to the folder root, `/`-separated. The root itself is `''`. */
  path: string;
  sizeBytes?: number | null;
  mediaType?: string | null;
}

export interface SpaceFolderListing {
  folderId: string;
  path: string;
  directories: readonly SpaceFolderEntry[];
  files: readonly SpaceFolderEntry[];
  truncated: boolean;
}

export interface SpaceFolderContent {
  folderId: string;
  path: string;
  mediaType: string | null;
  sizeBytes: number;
  encoding: 'utf8' | 'base64' | 'none';
  text: string | null;
  base64: string | null;
  refusal: { reason: string; detail?: string | null } | null;
  maxInlineBytes?: number;
}

/**
 * What the node did with the archive. `skipped` is NOT an error channel: a node
 * that refuses thirty members of a four-thousand-file tree has SUCCEEDED, and
 * saying "uploaded 4,812 files" while thirty were refused is a lie the user
 * will act on. It is rendered every time, including when empty.
 *
 * `added` and `replaced` are separate because they are separate facts: a
 * re-upload that replaces two thousand files and adds none is a very different
 * event from one that adds two thousand, and a single total hides which.
 */
export interface SpaceFolderUploadResult {
  folder: SpaceFolderSummary;
  added: number;
  replaced: number;
  directories: number;
  skipped: readonly { path: string; reason: string }[];
}

export interface SpaceFolderUploadOpts {
  signal?: AbortSignal;
  /** `(sent, total)` in bytes — Lane B's measured signature. */
  onProgress?: (sent: number, total: number) => void;
}

export interface SpaceFoldersPort {
  list(spaceId: string): Promise<readonly SpaceFolderSummary[]>;
  create(spaceId: string, name: string): Promise<SpaceFolderSummary>;
  upload(
    folderId: string,
    destPath: string,
    archive: Blob,
    opts?: SpaceFolderUploadOpts,
  ): Promise<SpaceFolderUploadResult>;
  browse(folderId: string, path?: string): Promise<SpaceFolderListing>;
  read(folderId: string, path: string): Promise<SpaceFolderContent>;
}

/**
 * The one narrowing. A cast lives here rather than at each call site so that
 * "the seam does not carry this yet" is a single measurable fact.
 */
export function spaceFoldersPortOf(seam: Seam): SpaceFoldersPort | undefined {
  return (seam as Seam & { spaceFolders?: SpaceFoldersPort }).spaceFolders;
}
