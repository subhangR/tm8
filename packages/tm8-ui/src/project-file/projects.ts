/**
 * THE PROJECT FACTS A FILE TAB NEEDS, read once per page and shared by every
 * tab: the project's NAME (label, tooltip, breadcrumb) from
 * `seam.projects(spaceId)`, and its ROOT (`workingDir` + `separator`, to turn
 * the tab's relative path into the absolute one the node reads) from the
 * project's root listing. A failed read is forgotten, so the next tab asks
 * again.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { ProjectId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { PathSeparator } from './paths';

export interface ProjectRoot {
  workingDir: string;
  separator: PathSeparator;
}

const names = new Map<string, ReadonlyMap<string, string>>();
const nameReads = new Map<string, Promise<void>>();
const roots = new Map<string, Promise<ProjectRoot>>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlyMap<string, string> = new Map();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the space's project names once (again after a failure). */
export function loadProjectNames(seam: Pick<Seam, 'projects'>, spaceId: string): Promise<void> {
  const pending = nameReads.get(spaceId);
  if (pending) return pending;
  const read = seam.projects(spaceId as SpaceId).then(
    (projects) => {
      names.set(spaceId, new Map(projects.map((p) => [p.id, p.name || p.workingDir || p.id])));
      notify();
    },
    () => {
      nameReads.delete(spaceId);
    },
  );
  nameReads.set(spaceId, read);
  return read;
}

/** The project's name, or null while unknown. */
export function useProjectName(seam: Pick<Seam, 'projects'>, spaceId: string, projectId: string): string | null {
  useEffect(() => {
    void loadProjectNames(seam, spaceId);
  }, [seam, spaceId]);
  const map = useSyncExternalStore(subscribe, () => names.get(spaceId) ?? EMPTY);
  return map.get(projectId) ?? null;
}

/** The project's root, from its root listing. Rejects when files are unreadable. */
export function projectRoot(seam: Pick<Seam, 'projectFiles'>, projectId: string): Promise<ProjectRoot> {
  const hit = roots.get(projectId);
  if (hit) return hit;
  const files = seam.projectFiles;
  if (!files) return Promise.reject(Object.assign(new Error('Project files are unavailable here'), { code: 'not_implemented' }));
  const read = files.list(projectId as ProjectId).then(
    (listing) => ({ workingDir: listing.workingDir, separator: listing.separator }),
    (error: unknown) => {
      roots.delete(projectId);
      throw error;
    },
  );
  roots.set(projectId, read);
  return read;
}

/** Tests only. */
export function resetProjectFactsForTest(): void {
  names.clear();
  nameReads.clear();
  roots.clear();
}
