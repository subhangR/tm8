/**
 * RECENTLY OPENED PROJECT FILES, the source the New tab's Recent and the ⌘K
 * palette read for files (files are not entities, so the entity caches never
 * hold them). Per (viewer, space), most recent first, in localStorage; ids
 * and paths only, never content.
 */
import { useSyncExternalStore } from 'react';
import { isProjectFilePath, projectFileKey, type ProjectFileTarget } from './paths';

export interface RecentProjectFile extends ProjectFileTarget {
  openedAt: number;
}

export const RECENT_FILES_LIMIT = 20;
const EMPTY: readonly RecentProjectFile[] = [];

const storageKey = (viewerId: string, spaceId: string) => `tm8.ws.recentFiles.v1:${viewerId}:${spaceId}`;
const cache = new Map<string, readonly RecentProjectFile[]>();
const listeners = new Set<() => void>();

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(key: string): readonly RecentProjectFile[] {
  const hit = cache.get(key);
  if (hit) return hit;
  let list: RecentProjectFile[] = [];
  try {
    const raw: unknown = JSON.parse(local()?.getItem(key) ?? '[]');
    if (Array.isArray(raw)) {
      list = raw
        .filter(
          (r): r is RecentProjectFile =>
            typeof r === 'object' && r !== null &&
            typeof r.projectId === 'string' && r.projectId.length > 0 && r.projectId.length <= 200 &&
            typeof r.path === 'string' && isProjectFilePath(r.path) &&
            typeof r.openedAt === 'number',
        )
        .map(({ projectId, path, openedAt }) => ({ projectId, path, openedAt }))
        .slice(0, RECENT_FILES_LIMIT);
    }
  } catch {
    list = [];
  }
  const frozen = list.length ? list : EMPTY;
  cache.set(key, frozen);
  return frozen;
}

/** The recent files for (viewer, space), most recent first. */
export function recentProjectFiles(viewerId: string, spaceId: string): readonly RecentProjectFile[] {
  return load(storageKey(viewerId, spaceId));
}

/** Put a file at the front of the recent list. */
export function recordRecentProjectFile(viewerId: string, spaceId: string, target: ProjectFileTarget, now = Date.now()): void {
  const key = storageKey(viewerId, spaceId);
  const id = projectFileKey(target);
  const next = [
    { projectId: target.projectId, path: target.path, openedAt: now },
    ...load(key).filter((r) => projectFileKey(r) !== id),
  ].slice(0, RECENT_FILES_LIMIT);
  cache.set(key, next);
  try {
    local()?.setItem(key, JSON.stringify(next));
  } catch {
    // Quota or privacy mode: the list lives for this page only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding over `recentProjectFiles`. */
export function useRecentProjectFiles(viewerId: string | null, spaceId: string): readonly RecentProjectFile[] {
  return useSyncExternalStore(subscribe, () => (viewerId ? recentProjectFiles(viewerId, spaceId) : EMPTY));
}

/** Tests only. */
export function resetRecentProjectFilesForTest(): void {
  cache.clear();
}

/** One New-tab row: an entity, or a recent project file. */
export type RecentPick<E> =
  | { type: 'entity'; id: string; row: E }
  | { type: 'file'; id: string; file: RecentProjectFile };

/**
 * Entities (already newest first) and recent files merged newest first, up
 * to `limit`. An entity's time is its `activityAt`; a file's, when it was
 * last opened.
 */
export function mergeRecentPicks<E extends { id: string; activityAt: string }>(
  entities: readonly E[],
  files: readonly RecentProjectFile[],
  limit: number,
): RecentPick<E>[] {
  const out: RecentPick<E>[] = [];
  let e = 0;
  let f = 0;
  while (out.length < limit && (e < entities.length || f < files.length)) {
    const entity = entities[e];
    const file = files[f];
    const entityAt = entity ? Date.parse(entity.activityAt) : -Infinity;
    if (file && (!entity || !(entityAt >= file.openedAt))) {
      out.push({ type: 'file', id: `file:${file.projectId}\u0000${file.path}`, file });
      f += 1;
    } else if (entity) {
      out.push({ type: 'entity', id: entity.id, row: entity });
      e += 1;
    }
  }
  return out;
}
