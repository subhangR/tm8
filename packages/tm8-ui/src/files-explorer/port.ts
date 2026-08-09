/**
 * THE FILES EXPLORER PORT — the only place this module knows a seam exists.
 *
 * Same law as `files/port.ts` and `settings-space/port.ts`: the screen takes
 * plain values and callbacks and cannot tell a fixture from a real node. The
 * host wires `filesExplorerPortFromSeam(seam, spaceId)`; nothing under
 * `files-explorer/` imports a seam implementation, and no transport URL is
 * ever assembled here.
 *
 * TWO ROOT FAMILIES, deliberately distinct (owner ruling R9, task
 * 019fe5d6-a363: "entity files are different and file browser is different"):
 *
 *   - LIBRARY — the space's managed `file` ENTITIES: uploaded blobs the node
 *     itself stores. Every verb wired here is a SHIPPED capability today:
 *     upload (`seam.files` grant lifecycle, no anchor required —
 *     `FileUploadInitInput.entityId` is optional), download
 *     (`files.downloadHref`), rename (`patchEntity` title), trash/restore
 *     (`deleteEntity`/`restoreEntity`).
 *
 *   - PROJECT — a linked project's LIVE working directory on the node,
 *     read through the optional `seam.projectFiles` group. Read-only by
 *     construction: the truth of these bytes is the disk, not tm8.
 *
 * WHAT IS DECLARED AND NOT WIRED, said plainly rather than faked (owner
 * ruling R7, coordinator correction 2026-08-10): an uploaded local FOLDER is
 * MATERIALIZED on the node's disk and linked as a Project — there is NO
 * managed folder tree over file entities (a phantom zero-byte `file` entity
 * as a "folder" was explicitly ruled out). So `importFolder` (bind to
 * `projects.folderUploads.init|complete|abort` when the backend lane
 * republishes those DTOs; re-import is merge-and-replace with a visible
 * replacedCount — R8), `createFolder` and `move` are OPTIONAL members:
 * absent on the real wiring today, so the screen renders those verbs
 * disabled-with-reason instead of performing a lie. Binding them HERE lights
 * the controls with zero component churn.
 */
import type {
  EntityId,
  EntitySummary,
  ProjectId,
  ProjectResource,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { fileKindRef } from '../files/port';
import { createFileUploadTask, type FileUploadTask } from '../files/upload';
import { startFolderImport, type FolderImportTask } from './folder-import';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ExplorerRootKind = 'library' | 'project';

export interface ExplorerRoot {
  /** Stable id for selection/back-navigation. `library` or `project:<id>`. */
  id: string;
  kind: ExplorerRootKind;
  label: string;
  /** Uploads/mutations may target this root. Project roots are read-only. */
  writable: boolean;
  projectId?: ProjectId;
  /** Honest caption when the root exists but cannot be browsed here. */
  unavailableReason?: string;
}

export interface ExplorerEntry {
  /** Display name (basename). */
  name: string;
  /** Path relative to the root; `''` is the root itself. Separator is `/`. */
  path: string;
  type: 'file' | 'dir';
  /** null = NOT KNOWN (renders a dash, never 0 — D7.2). */
  sizeBytes: number | null;
  modifiedAt: string | null;
  mime: string | null;
  /** Library entries carry their entity id; project entries carry null. */
  entityId: EntityId | null;
  /** Library soft-delete state; the trash tab lists these. */
  trashed: boolean;
  /** Optimistic-concurrency version for library mutations. */
  version: number | null;
}

export interface ExplorerListing {
  entries: ExplorerEntry[];
  /** True when the server cut the listing; the screen says so. */
  truncated: boolean;
}

export interface ExplorerUploadCapability {
  /**
   * Whether `relativePath` survives storage. The LIBRARY upload is a flat
   * blob store, so its real wiring answers false — which is why the screen
   * routes DIRECTORY picks to `importFolder` (R7) rather than through here.
   */
  preservesPaths: boolean;
  start(file: File, opts: { relativePath: string }): FileUploadTask;
}

/**
 * R7 folder import: the picked tree is materialized as a REAL directory on
 * the node's disk and linked as a Project; re-import into an existing root is
 * merge-and-replace and reports how many paths were replaced (R8). BOUND
 * 2026-08-10 to the published `projects.folderUploads.init|complete|abort`
 * lifecycle (seam Amendment 8) via `folder-import.ts`; present only when the
 * seam carries BOTH `projectFolderUploads` and `projectSetup` (the destination
 * browser). A task, not a bare promise, so an import is cancellable and a
 * cancel ABORTS the server session rather than orphaning staging.
 */
export interface ExplorerFolderImport {
  start(
    files: ReadonlyArray<{ file: File; relativePath: string }>,
    rootName: string,
  ): FolderImportTask;
}

export interface FilesExplorerPort {
  roots(): Promise<ExplorerRoot[]>;
  list(root: ExplorerRoot, path: string, opts?: { trashed?: boolean }): Promise<ExplorerListing>;
  /** Null when this entry's bytes are not reachable from a browser (project files today). */
  downloadHref(entry: ExplorerEntry): string | null;
  // -- writes: OPTIONAL capabilities; absence renders disabled-with-reason ---
  upload?: ExplorerUploadCapability;
  /** R7: a folder becomes a linked Project on the node. Unbound until the
   *  backend `projects.folderUploads.*` ops are published. */
  importFolder?: ExplorerFolderImport;
  /**
   * Set when `importFolder` is withheld for a reason the viewer could act on
   * (today: the node-admin rule), so the screen disables the control with the
   * truthful copy instead of the generic not-served-yet reason.
   */
  importFolderBlockedReason?: string;
  rename?(entry: ExplorerEntry, nextName: string): Promise<void>;
  trash?(entry: ExplorerEntry): Promise<void>;
  restore?(entry: ExplorerEntry): Promise<void>;
  createFolder?(path: string, name: string): Promise<void>;
  move?(entry: ExplorerEntry, destinationDir: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Refusal copy — the gap ledger, in code (the `files/reasons.ts` idiom)
// ---------------------------------------------------------------------------

export const EXPLORER_REASONS = {
  FOLDER_IMPORT_UNAVAILABLE:
    'Importing a folder lands it on the node as a linked project. This node does not serve the folder-import operations yet.',
  FOLDER_IMPORT_FORBIDDEN:
    'Importing a folder writes to the node’s disk, which needs node-admin rights on this node. Ask an owner to run the import or to approve a managed import root.',
  CREATE_FOLDER_UNAVAILABLE:
    'The library stores flat uploaded files; folders arrive by importing a local folder as a linked project, which this node does not serve yet.',
  MOVE_UNAVAILABLE:
    'Moving library files between folders is not supported — the library is flat; folder structure lives in linked projects.',
  PROJECT_READ_ONLY:
    'This is a live project directory on the node. It is browsable here, but changing it belongs to a session working in that project.',
  PROJECT_BROWSE_UNAVAILABLE:
    'This node build cannot list project directories from the browser.',
  PREVIEW_UNAVAILABLE:
    'No byte route exists for this entry in this build, so there is nothing honest to preview.',
  PATHS_NOT_PRESERVED:
    'This node has no folder namespace yet: every file uploads, but the folder structure will not be preserved.',
} as const;

// ---------------------------------------------------------------------------
// Real wiring
// ---------------------------------------------------------------------------

export const LIBRARY_ROOT_ID = 'library';

function libraryEntry(entity: EntitySummary): ExplorerEntry {
  const content = (entity as { content?: Record<string, unknown> }).content ?? {};
  const mime = typeof content['mime'] === 'string' ? (content['mime'] as string) : null;
  const size = typeof content['sizeBytes'] === 'number' ? (content['sizeBytes'] as number) : null;
  return {
    name: entity.title,
    path: entity.title,
    type: 'file',
    sizeBytes: size,
    modifiedAt: entity.updatedAt ?? entity.createdAt ?? null,
    mime,
    entityId: entity.id,
    trashed: entity.deletedAt != null,
    version: entity.version ?? null,
  };
}

export function filesExplorerPortFromSeam(
  seam: Seam,
  spaceId: SpaceId,
  viewerIsNodeAdmin?: boolean | null,
): FilesExplorerPort {
  const projectFiles = seam.projectFiles;
  const folderUploads = seam.projectFolderUploads;
  const projectSetup = seam.projectSetup;

  async function libraryEntities(trashed: boolean): Promise<EntitySummary[]> {
    const result = await seam.query({
      spaceId,
      kinds: [fileKindRef() as never],
      ...(trashed ? { filters: { deleted: 'only' } as never } : {}),
    });
    return result.page.items;
  }

  return {
    async roots() {
      const roots: ExplorerRoot[] = [
        { id: LIBRARY_ROOT_ID, kind: 'library', label: 'Library', writable: true },
      ];
      let projects: ProjectResource[] = [];
      try {
        projects = await seam.projects(spaceId);
      } catch {
        // No project read ⇒ no project roots; the library root stands alone.
        projects = [];
      }
      for (const project of projects) {
        roots.push({
          id: `project:${project.id}`,
          kind: 'project',
          label: project.name ?? project.workingDir ?? project.id,
          writable: false,
          projectId: project.id as ProjectId,
          ...(projectFiles ? {} : { unavailableReason: EXPLORER_REASONS.PROJECT_BROWSE_UNAVAILABLE }),
        });
      }
      return roots;
    },

    async list(root, path, opts) {
      if (root.kind === 'library') {
        const items = await libraryEntities(opts?.trashed === true);
        return { entries: items.map(libraryEntry), truncated: false };
      }
      if (!projectFiles || !root.projectId) {
        throw Object.assign(new Error(EXPLORER_REASONS.PROJECT_BROWSE_UNAVAILABLE), {
          code: 'not_implemented',
        });
      }
      const listing = await projectFiles.list(root.projectId, path === '' ? undefined : path);
      const dirs: ExplorerEntry[] = listing.directories.map((dir) => ({
        name: dir.name,
        path: dir.path,
        type: 'dir',
        sizeBytes: null,
        modifiedAt: null,
        mime: null,
        entityId: null,
        trashed: false,
        version: null,
      }));
      const files: ExplorerEntry[] = listing.files.map((file) => ({
        name: file.name,
        path: file.path,
        type: 'file',
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        mime: file.mime,
        entityId: null,
        trashed: false,
        version: null,
      }));
      return { entries: [...dirs, ...files], truncated: listing.truncated };
    },

    downloadHref(entry) {
      // Only a library entry has a byte route the browser may follow.
      return entry.entityId ? seam.files.downloadHref(entry.entityId) : null;
    },

    upload: {
      // Honest: the shipped upload lifecycle stores a flat library blob.
      preservesPaths: false,
      start: (file) =>
        createFileUploadTask({
          files: seam.files,
          file,
          spaceId,
          // No anchor: a library upload attaches to nothing.
        }),
    },

    async rename(entry, nextName) {
      if (!entry.entityId || entry.version === null) {
        throw Object.assign(new Error('This entry cannot be renamed.'), { code: 'invalid_input' });
      }
      await seam.commands.patchEntity(entry.entityId, {
        clientMutationId: crypto.randomUUID(),
        expectedVersion: entry.version,
        title: nextName,
      } as never);
    },

    async trash(entry) {
      if (!entry.entityId) {
        throw Object.assign(new Error('This entry cannot be trashed.'), { code: 'invalid_input' });
      }
      await seam.commands.deleteEntity(entry.entityId, {
        clientMutationId: crypto.randomUUID(),
      } as never);
    },

    async restore(entry) {
      if (!entry.entityId) {
        throw Object.assign(new Error('This entry cannot be restored.'), { code: 'invalid_input' });
      }
      await seam.commands.restoreEntity(entry.entityId, {
        clientMutationId: crypto.randomUUID(),
      } as never);
    },

    // R7: a folder import needs the lifecycle ops AND the destination
    // browser; with either absent the control stays disabled-with-reason.
    // Lane 3 ruling (2026-08-10): v1 folder import is NODE-ADMIN-ONLY. When
    // the host has already resolved the viewer and the answer is "not a node
    // admin", the capability is withheld UP FRONT with the truthful reason —
    // offering the OS picker only to refuse after selection is the late-403
    // leak the ruling forbids. An unresolved viewer (undefined/null) keeps
    // the capability: availability must not degrade on a failed enhancement
    // read, and `authorize` below stays the server-truth backstop.
    ...(folderUploads && projectSetup && viewerIsNodeAdmin === false
      ? { importFolderBlockedReason: EXPLORER_REASONS.FOLDER_IMPORT_FORBIDDEN }
      : {}),
    ...(folderUploads && projectSetup && viewerIsNodeAdmin !== false
      ? {
          importFolder: {
            start: (files, rootName) =>
              startFolderImport(
                {
                  folderUploads,
                  putBytes: (grant, bytes) => seam.files.putBytes(grant, bytes),
                  directories: (path?: string) => projectSetup.directories(path),
                  // Lane 3 ruling (2026-08-10): v1 folder import is
                  // NODE-ADMIN-ONLY. Checked before destination discovery so
                  // an unauthorized member's attempt leaks nothing and earns
                  // the truthful refusal, not a late 403.
                  authorize: async () => {
                    const viewer = await seam.identity();
                    if (!viewer.isNodeAdmin) {
                      throw Object.assign(new Error(EXPLORER_REASONS.FOLDER_IMPORT_FORBIDDEN), {
                        code: 'forbidden',
                      });
                    }
                  },
                  spaceId,
                },
                files,
                rootName,
              ),
          } satisfies ExplorerFolderImport,
        }
      : {}),

    // `createFolder` and `move` remain deliberately ABSENT: the library is
    // flat and folder structure lives in linked projects (R7); the
    // EXPLORER_REASONS entries carry the user-facing copy.
  };
}
