/**
 * FOLDER IMPORT over the seam's `projectFolderUploads` lifecycle (Amendment 8
 * — the `projects.folderUploads.*` operations Lane 1 published; owner ruling
 * R7: an imported local folder MATERIALIZES on the node's disk and is linked
 * as a Project).
 *
 * The task shape mirrors `files/upload.ts`: it owns its grant session and is
 * the only place allowed to abort it, so cancel and failure cleanup stay
 * idempotent when they race. Byte PUTs are BOUNDED (3 at a time) for the same
 * reason the library queue is: an imported tree can be a thousand files.
 *
 * TWO facts the wire enforces and this module honours rather than re-invents:
 *   - zero-byte files receive NO grant (init omits them; their emptiness is
 *     materialized from the manifest server-side), so absent grant ≠ error;
 *   - an existing root under mode 'create' answers `conflict`, and R8 rules
 *     the remedy is MERGE (in-place replacement + replacedCount), never a
 *     refusal shown to the user — so this task retries once with 'merge'.
 */
import type {
  ProjectFolderUploadEntry,
  ProjectFolderUploadGrant,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { sha256Hex, UploadCancelledError } from '../files/upload';

export interface FolderImportOutcome {
  projectName: string;
  fileCount: number;
  /** R8: files that already existed and were replaced in place. 0 on create. */
  replacedCount: number;
  /** True when the root existed and the import merged into it. */
  merged: boolean;
}

/**
 * MEASURED progress, not a spinner.
 *
 * `upload-queue.ts` refuses to invent a percentage for ONE file, and it is
 * right to: a `fetch` PUT reports no byte counter, so any bar would be
 * animation over a number nobody measured. A FOLDER is a different question —
 * the denominator is `files.length`, known before the first byte moves. So
 * counts here are real counts, and `bytesDone` accumulates only file sizes
 * that actually completed their PUT.
 *
 * `phase` exists because the slowest part of a large import is often the
 * CHECKSUM pass, before any upload starts. An import that says "0 of 1208"
 * for forty seconds looks hung; one that says "hashing" does not.
 */
export type FolderImportPhase = 'hashing' | 'starting' | 'uploading' | 'finishing';

export interface FolderImportProgress {
  phase: FolderImportPhase;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface FolderImportTask {
  result: Promise<FolderImportOutcome>;
  cancel(): void;
  /** Fires on every measurable change. Returns an unsubscribe. */
  subscribe(listener: (progress: FolderImportProgress) => void): () => void;
  progress(): FolderImportProgress;
}

interface FolderImportDeps {
  folderUploads: NonNullable<Seam['projectFolderUploads']>;
  putBytes: Seam['files']['putBytes'];
  /** The server-authorized destination browser — its `path` is the parent. */
  directories: NonNullable<Seam['projectSetup']>['directories'];
  /**
   * Runs BEFORE anything else — before `directories`, deliberately, so an
   * unauthorized caller never triggers destination discovery (Lane 3 security
   * ruling 2026-08-10: v1 folder import is node-admin-only, and the refusal
   * must be truthful, not a leak followed by a 403).
   */
  authorize?: () => Promise<void>;
  spaceId: SpaceId;
  concurrency?: number;
  newMutationId?: () => string;
  checksum?: (blob: Blob) => Promise<string>;
}

/** Every proper directory prefix of the file paths — preserves the tree shape. */
export function directoryEntries(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      dirs.add(segments.slice(0, i).join('/'));
    }
  }
  return [...dirs].sort();
}

export function startFolderImport(
  deps: FolderImportDeps,
  files: ReadonlyArray<{ file: File; relativePath: string }>,
  rootName: string,
): FolderImportTask {
  const {
    folderUploads,
    putBytes,
    directories,
    authorize,
    spaceId,
    concurrency = 3,
    newMutationId = () => crypto.randomUUID(),
    checksum = sha256Hex,
  } = deps;

  let cancelled = false;
  let sessionId: string | null = null;
  let completed = false;
  let aborting: Promise<void> | null = null;

  const listeners = new Set<(progress: FolderImportProgress) => void>();
  let snapshot: FolderImportProgress = {
    phase: 'hashing',
    filesDone: 0,
    filesTotal: files.length,
    bytesTotal: files.reduce((total, entry) => total + entry.file.size, 0),
    bytesDone: 0,
  };
  const advance = (patch: Partial<FolderImportProgress>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener(snapshot);
  };

  const abortSession = (): Promise<void> => {
    if (sessionId === null || completed) return Promise.resolve();
    const id = sessionId;
    aborting ??= folderUploads
      .abort(id, { clientMutationId: newMutationId() })
      .catch(() => undefined);
    return aborting;
  };

  const assertActive = async (): Promise<void> => {
    if (!cancelled) return;
    await abortSession();
    throw new UploadCancelledError();
  };

  const result = (async (): Promise<FolderImportOutcome> => {
    try {
      if (files.length === 0) {
        throw Object.assign(new Error('Nothing to import.'), { code: 'invalid_input' });
      }
      // Authorization FIRST — before manifests, before destination discovery.
      await authorize?.();
      await assertActive();
      const byPath = new Map(files.map((f) => [f.relativePath, f.file]));
      const entries: ProjectFolderUploadEntry[] = [
        ...directoryEntries([...byPath.keys()]).map(
          (relativePath): ProjectFolderUploadEntry => ({ kind: 'directory', relativePath }),
        ),
        ...(await Promise.all(
          files.map(async ({ file, relativePath }): Promise<ProjectFolderUploadEntry> => ({
            kind: 'file',
            relativePath,
            sizeBytes: file.size,
            checksumSha256: file.size > 0 ? await checksum(file) : await checksum(new Blob([])),
            mime: file.type || 'application/octet-stream',
          })),
        )),
      ];
      await assertActive();

      advance({ phase: 'starting' });
      const destinationParent = (await directories()).path;
      await assertActive();

      const initInput = {
        clientMutationId: newMutationId(),
        projectName: rootName,
        destinationParent,
        rootName,
        entries,
      };
      let merged = false;
      let grant: ProjectFolderUploadGrant;
      try {
        grant = await folderUploads.init(spaceId, { ...initInput, mode: 'create' });
      } catch (error) {
        // R8: an existing root MERGES rather than refusing.
        if ((error as { code?: string }).code !== 'conflict') throw error;
        merged = true;
        grant = await folderUploads.init(spaceId, {
          ...initInput,
          clientMutationId: newMutationId(),
          mode: 'merge',
        });
      }
      sessionId = grant.folderUploadId;
      await assertActive();

      // Bounded byte PUTs. Zero-byte files legitimately have no grant.
      // Files WITHOUT a grant are already done as far as the user is
      // concerned — counting only granted files would leave a tree of empty
      // files reporting "0 of 40" right up until it succeeded.
      const granted = new Set(grant.files.map((file) => file.relativePath));
      const ungrantedBytes = files
        .filter((entry) => !granted.has(entry.relativePath))
        .reduce((total, entry) => total + entry.file.size, 0);
      advance({
        phase: 'uploading',
        filesDone: files.length - grant.files.length,
        bytesDone: ungrantedBytes,
      });
      const queue = [...grant.files];
      const worker = async (): Promise<void> => {
        for (;;) {
          const fileGrant = queue.shift();
          if (!fileGrant) return;
          await assertActive();
          const file = byPath.get(fileGrant.relativePath);
          if (!file) {
            throw Object.assign(
              new Error(`The node granted a path this import never named: a stale session.`),
              { code: 'invariant_violation' },
            );
          }
          await putBytes(fileGrant, file);
          advance({
            filesDone: snapshot.filesDone + 1,
            bytesDone: snapshot.bytesDone + file.size,
          });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
      );
      await assertActive();

      advance({ phase: 'finishing' });
      const done = await folderUploads.complete(sessionId, { clientMutationId: newMutationId() });
      completed = true;
      return {
        projectName: done.project.name ?? rootName,
        fileCount: done.fileCount,
        replacedCount: done.replacedCount,
        merged,
      };
    } catch (error) {
      await abortSession();
      if (cancelled && !(error instanceof UploadCancelledError)) {
        throw new UploadCancelledError();
      }
      throw error;
    }
  })();

  return {
    result,
    cancel() {
      cancelled = true;
      void abortSession();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    progress: () => snapshot,
  };
}
