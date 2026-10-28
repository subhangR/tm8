import { useCallback, useSyncExternalStore } from 'react';
import type {
  ContentionReport,
  EntityDetail,
  ProjectBranchTopology,
  ProjectDirectoryListing,
  ProjectResource,
  ProjectTrustLevel,
  SpaceId,
} from '@tm8/contract';

import type { Seam } from '../data/seam';

/**
 * THE PROJECT'S NODE RECORD, FOR ITS PANEL AND ITS LIST ROW.
 *
 * A project entity carries no path and no trust: both live on the folder the
 * node granted the space (`ProjectResource`). `projects.list?spaceId=` is the
 * read that returns them; the node puts `workingDir` on it only for a node
 * admin (W11), so a record WITHOUT a path is a member's view, not a missing
 * folder.
 *
 * Changing the folder or its trust is `projects.update`, which the node lets
 * only a node admin call. The port offers `update` whenever the seam can make
 * the call; the panel offers the controls only on a record that carries a
 * path, i.e. to the one viewer the node would accept them from.
 */
export interface ProjectRecordPort {
  /** Every project of the space with its folder record. */
  list(): Promise<ProjectResource[]>;
  branches(folderId: string): Promise<ProjectBranchTopology>;
  worktrees(folderId: string): Promise<ContentionReport>;
  /** Absent when this seam cannot change a folder. */
  update?(folderId: string, patch: { workingDir?: string; trust?: ProjectTrustLevel }): Promise<ProjectResource>;
  /** The node folder browser for choosing a new path; absent without one. */
  directories?(path?: string): Promise<ProjectDirectoryListing>;
}

type RecordSeam = Pick<Seam, 'projects' | 'projectBranches' | 'projectContention' | 'projectAdmin' | 'projectSetup'>;

/* One port per (seam, space): hosts call this during render, and a fresh
   object each time would re-run every read keyed on it. */
const PORTS = new WeakMap<object, Map<string, ProjectRecordPort>>();

export function projectRecordPort(seam: RecordSeam, spaceId: SpaceId | null | undefined): ProjectRecordPort | null {
  if (!spaceId) return null;
  let bySpace = PORTS.get(seam);
  if (!bySpace) PORTS.set(seam, (bySpace = new Map()));
  const known = bySpace.get(spaceId);
  if (known) return known;
  const port = buildPort(seam, spaceId);
  bySpace.set(spaceId, port);
  return port;
}

function buildPort(seam: RecordSeam, spaceId: SpaceId): ProjectRecordPort {
  const admin = seam.projectAdmin;
  const setup = seam.projectSetup;
  return {
    list: () => seam.projects(spaceId),
    branches: (folderId) => seam.projectBranches(folderId),
    worktrees: (folderId) => seam.projectContention(folderId),
    ...(admin
      ? {
          update: (folderId, patch) =>
            admin.update(folderId, { ...patch, clientMutationId: `project-update:${crypto.randomUUID()}` }),
        }
      : {}),
    ...(setup ? { directories: (path?: string) => setup.directories(path) } : {}),
  };
}

/** The record behind a project entity: matched on the entity id, or the folder id its content names. */
export function recordFor(
  records: readonly ProjectResource[],
  entityId: string,
  content?: EntityDetail['content'],
): ProjectResource | null {
  const folderId = typeof (content as { projectId?: unknown } | undefined)?.projectId === 'string'
    ? (content as { projectId: string }).projectId
    : null;
  return records.find((record) => record.projectEntityId === entityId)
    ?? (folderId ? records.find((record) => record.id === folderId) : undefined)
    ?? null;
}

export type ProjectRecordsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; records: readonly ProjectResource[] };

/*
 * ONE STORE PER PORT, so the Projects list row and the project page read the
 * same records: a folder moved or trusted on the page re-draws the row.
 */
interface RecordStore {
  state: ProjectRecordsState;
  listeners: Set<() => void>;
  started: boolean;
}
const STORES = new WeakMap<ProjectRecordPort, RecordStore>();

function storeFor(port: ProjectRecordPort): RecordStore {
  let store = STORES.get(port);
  if (!store) STORES.set(port, (store = { state: { phase: 'loading' }, listeners: new Set(), started: false }));
  return store;
}

function publish(store: RecordStore, state: ProjectRecordsState): void {
  store.state = state;
  for (const listener of store.listeners) listener();
}

const IDLE: ProjectRecordsState = { phase: 'loading' };

/** The space's project records, read once per port and shared by every reader of it. */
export function useProjectRecords(port: ProjectRecordPort | null): {
  state: ProjectRecordsState;
  replace(record: ProjectResource): void;
} {
  const subscribe = useCallback((listener: () => void) => {
    if (!port) return () => {};
    const store = storeFor(port);
    store.listeners.add(listener);
    if (!store.started) {
      store.started = true;
      port.list().then(
        (records) => publish(store, { phase: 'ready', records }),
        (cause: unknown) => {
          store.started = false;
          publish(store, { phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
        },
      );
    }
    return () => {
      store.listeners.delete(listener);
      // The next reader re-reads (a project added meanwhile shows), drawing the last answer until then.
      if (store.listeners.size === 0) store.started = false;
    };
  }, [port]);
  const state = useSyncExternalStore(subscribe, () => (port ? storeFor(port).state : IDLE));
  /* `projects.update` answers the bare folder row: the space-scoped fields
     (`projectEntityId`, `spaceId`) are kept from the record it replaces. */
  const replace = useCallback((record: ProjectResource) => {
    if (!port) return;
    const store = storeFor(port);
    const current = store.state;
    if (current.phase !== 'ready') return;
    publish(store, {
      phase: 'ready',
      records: current.records.map((row) => (row.id === record.id ? { ...row, ...record, projectEntityId: row.projectEntityId, spaceId: row.spaceId } : row)),
    });
  }, [port]);
  return { state, replace };
}

/** `/home/ada/code/tm8` → `~/code/tm8` when the home is known; otherwise the path as is. */
export function shortPath(path: string): string {
  const home = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(path);
  return home ? `~${path.slice(home[1]!.length)}` : path;
}
