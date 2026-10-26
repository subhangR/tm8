/**
 * The Project files panel's remembered state, per space and UI-local (as
 * `tab-workspace/runtime/railStore.ts` keeps the rail's): which project the
 * panel shows, and FOR EACH PROJECT its open folders, filter and scroll, so
 * switching projects and coming back (or reloading) restores the tree as it
 * was left. Folders are project-relative paths.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface ProjectTreeView {
  open: readonly string[];
  filter: string;
  scrollTop: number;
}

export const EMPTY_TREE_VIEW: ProjectTreeView = { open: [], filter: '', scrollTop: 0 };

export const projectTreeKey = (spaceId: string) => `tm8.workspace.project-tree:${spaceId}`;

/** Remembered projects beyond this are forgotten, oldest first. */
const MAX_PROJECTS = 32;

export interface ProjectTreeState {
  projectId: string | null;
  views: Readonly<Record<string, ProjectTreeView>>;
  selectProject(projectId: string): void;
  setOpen(projectId: string, path: string, open: boolean): void;
  /** Open every folder in `paths` (revealing a file). */
  openAll(projectId: string, paths: readonly string[]): void;
  collapseAll(projectId: string): void;
  setFilter(projectId: string, filter: string): void;
  setScroll(projectId: string, scrollTop: number): void;
}
export type ProjectTreeStore = StoreApi<ProjectTreeState>;

type Stored = Pick<ProjectTreeState, 'projectId' | 'views'>;

function viewOf(raw: unknown): ProjectTreeView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Partial<Record<keyof ProjectTreeView, unknown>>;
  return {
    open: Array.isArray(v.open) ? v.open.filter((p): p is string => typeof p === 'string') : [],
    filter: typeof v.filter === 'string' ? v.filter : '',
    scrollTop: typeof v.scrollTop === 'number' && v.scrollTop >= 0 ? v.scrollTop : 0,
  };
}

function load(spaceId: string): Stored {
  try {
    const raw = window.localStorage.getItem(projectTreeKey(spaceId));
    const parsed = raw === null ? null : (JSON.parse(raw) as { projectId?: unknown; views?: unknown });
    const views: Record<string, ProjectTreeView> = {};
    if (parsed && typeof parsed.views === 'object' && parsed.views !== null) {
      for (const [id, raw] of Object.entries(parsed.views)) {
        const view = viewOf(raw);
        if (view) views[id] = view;
      }
    }
    return { projectId: typeof parsed?.projectId === 'string' ? parsed.projectId : null, views };
  } catch {
    return { projectId: null, views: {} };
  }
}

function save(spaceId: string, state: Stored): void {
  try {
    window.localStorage.setItem(projectTreeKey(spaceId), JSON.stringify({ projectId: state.projectId, views: state.views }));
  } catch {
    // No storage ⇒ the tree is remembered as long as the page.
  }
}

export function createProjectTreeStore(spaceId: string): ProjectTreeStore {
  return createStore<ProjectTreeState>()((set, get) => {
    const update = (projectId: string, change: (view: ProjectTreeView) => ProjectTreeView) => {
      const { [projectId]: current, ...rest } = get().views;
      const next = change(current ?? EMPTY_TREE_VIEW);
      if (current && next.open === current.open && next.filter === current.filter && next.scrollTop === current.scrollTop) return;
      /* The project touched last goes last; the oldest fall off the front. */
      const ids = Object.keys(rest).slice(-(MAX_PROJECTS - 1));
      const views = Object.fromEntries([...ids.map((id) => [id, rest[id]!] as const), [projectId, next] as const]);
      set({ views });
      save(spaceId, { projectId: get().projectId, views });
    };
    return {
      ...load(spaceId),
      selectProject(projectId) {
        if (get().projectId === projectId) return;
        set({ projectId });
        save(spaceId, get());
      },
      setOpen(projectId, path, open) {
        update(projectId, (view) => {
          const has = view.open.includes(path);
          if (has === open) return view;
          return { ...view, open: open ? [...view.open, path] : view.open.filter((p) => p !== path) };
        });
      },
      openAll(projectId, paths) {
        update(projectId, (view) => {
          const missing = paths.filter((p) => !view.open.includes(p));
          return missing.length === 0 ? view : { ...view, open: [...view.open, ...missing] };
        });
      },
      collapseAll(projectId) {
        update(projectId, (view) => (view.open.length === 0 ? view : { ...view, open: [] }));
      },
      setFilter(projectId, filter) {
        update(projectId, (view) => (view.filter === filter ? view : { ...view, filter }));
      },
      setScroll(projectId, scrollTop) {
        update(projectId, (view) => (view.scrollTop === scrollTop ? view : { ...view, scrollTop }));
      },
    };
  });
}

const stores = new Map<string, ProjectTreeStore>();

/** The kept-alive tree store for a space; read from storage on first use. */
export function getProjectTreeStore(spaceId: string): ProjectTreeStore {
  let store = stores.get(spaceId);
  if (!store) {
    store = createProjectTreeStore(spaceId);
    stores.set(spaceId, store);
  }
  return store;
}

/** Test seam: forget the kept-alive stores so the next read re-loads storage. */
export function resetProjectTreeStores(): void {
  stores.clear();
}
