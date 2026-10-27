/**
 * PROJECT FILES (mockup v2, left panel): the browser column's lazy tree of a
 * connected project folder, registered as a non-entity browser source
 * (`tab-workspace/adapters/browserSources.ts`). Files are not entities; a
 * click opens a file tab through U1's `openProjectFile`.
 *
 *   [project ▾]                      picker: every connected project
 *   [filter files…]  [collapse all]
 *   ▾ packages                       folders first; .git never shown;
 *     ▸ node_modules                 node_modules dimmed (still opens)
 *     TS index.ts                    single click: preview tab (italic)
 *   More files not shown             double click: keep it
 *
 * LAZY: one `projects.files.list` per directory the person opens (the root on
 * mount); nothing is listed ahead. The open folders, filter and scroll are
 * remembered PER PROJECT (`treeStore.ts`), so switching projects and coming
 * back, or reloading, restores the tree as it was left. When the active tab
 * becomes a file of the shown project, its folders open and it scrolls into
 * view.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import type { ProjectId, ProjectResource, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useOpenProjectFile } from '../tab-workspace/adapters/projectFile';
import { activeTab } from '../tab-workspace/runtime/selectors';
import { useWorkspace, useWorkspaceState } from '../tab-workspace/view/context';
import { FileTypeBadge } from './FileTypeBadge';
import { toAbsolutePath } from './paths';
import { ancestorDirs, pendingDirs, ROOT_DIR, treeRows, type DirState, type TreeRow } from './tree';
import { EMPTY_TREE_VIEW, getProjectTreeStore, type ProjectTreeStore } from './treeStore';
import './project-file.css';
import './project-files.css';

type ProjectFilesSeam = NonNullable<Seam['projectFiles']>;
type ProjectsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projects: ProjectResource[] };

/** Scroll is written at most this often. */
const SCROLL_WRITE_MS = 150;
/** A remembered scroll waits this long for the folders to list, then gives up. */
const SCROLL_RESTORE_MS = 5_000;

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : 'Could not read this folder';
}

export function projectLabel(project: Pick<ProjectResource, 'id' | 'name' | 'workingDir'>): string {
  return project.name || project.workingDir || project.id;
}

export function ProjectFilesPanel() {
  const { gate, spaceId } = useWorkspace();
  const seam = gate.data.seam;
  const files = seam.projectFiles;
  const store = useMemo(() => getProjectTreeStore(spaceId), [spaceId]);
  const storedId = useStore(store, (s) => s.projectId);
  const [projects, setProjects] = useState<ProjectsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!files) return;
    let alive = true;
    setProjects({ status: 'loading' });
    seam.projects(spaceId as SpaceId).then(
      (list) => alive && setProjects({ status: 'ready', projects: list }),
      (error: unknown) => alive && setProjects({ status: 'error', message: messageOf(error) }),
    );
    return () => {
      alive = false;
    };
  }, [seam, files, spaceId, attempt]);

  const list = projects.status === 'ready' ? projects.projects : [];
  const selected = list.find((p) => p.id === storedId) ?? list[0] ?? null;

  let body;
  if (!files) {
    body = <PanelState text="Project files unavailable" detail="This node can't read project folders." />;
  } else if (projects.status === 'loading') {
    body = <PanelState text="Loading projects…" />;
  } else if (projects.status === 'error') {
    body = <PanelState text="Couldn't load projects" detail={projects.message} action={{ label: 'Retry', run: () => setAttempt((n) => n + 1) }} />;
  } else if (!selected) {
    body = <PanelState text="No projects connected" detail="Connect a project folder to browse its files here." />;
  } else {
    body = <ProjectTree key={selected.id} projectId={selected.id} files={files} store={store} />;
  }

  return (
    <section className="pft" aria-label="Project files" data-testid="pft">
      {selected && list.length > 0 ? (
        <div className="pft-picker">
          <select
            className="pft-picker__select"
            aria-label="Project"
            data-testid="pft-project"
            value={selected.id}
            onChange={(event) => store.getState().selectProject(event.target.value)}
          >
            {list.map((project) => (
              <option key={project.id} value={project.id}>
                {projectLabel(project)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {body}
    </section>
  );
}

function ProjectTree({ projectId, files, store }: { projectId: string; files: ProjectFilesSeam; store: ProjectTreeStore }) {
  const view = useStore(store, (s) => s.views[projectId] ?? EMPTY_TREE_VIEW);
  const open = useMemo(() => new Set(view.open), [view.open]);
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(() => new Map());
  const openFile = useOpenProjectFile();

  /* LAZY: list each reachable open directory not yet asked about, once. */
  useEffect(() => {
    const pending = pendingDirs(dirs, open);
    if (pending.length === 0) return;
    const root = dirs.get(ROOT_DIR);
    setDirs((now) => {
      const next = new Map(now);
      for (const path of pending) next.set(path, { status: 'loading' });
      return next;
    });
    for (const path of pending) {
      const absolute =
        path === ROOT_DIR || root?.status !== 'ready'
          ? undefined
          : toAbsolutePath(root.listing.workingDir, root.listing.separator, path);
      files.list(projectId as ProjectId, absolute).then(
        (listing) => setDirs((now) => new Map(now).set(path, { status: 'ready', listing })),
        (error: unknown) => setDirs((now) => new Map(now).set(path, { status: 'error', message: messageOf(error) })),
      );
    }
  }, [dirs, open, files, projectId]);

  const retry = useCallback((path: string) => {
    setDirs((now) => {
      const next = new Map(now);
      next.delete(path);
      return next;
    });
  }, []);

  const rows = useMemo(() => treeRows(dirs, open, view.filter), [dirs, open, view.filter]);

  /* REVEAL: the active tab, when it is a file of this project. */
  const active = useWorkspaceState(activeTab);
  const activePath = active?.type === 'file' && active.projectId === projectId ? active.path : null;
  const [reveal, setReveal] = useState<string | null>(() => (view.scrollTop === 0 ? activePath : null));
  const lastActive = useRef(activePath);
  useEffect(() => {
    if (activePath === lastActive.current) return;
    lastActive.current = activePath;
    setReveal(activePath);
  }, [activePath]);
  useEffect(() => {
    if (reveal !== null) store.getState().openAll(projectId, ancestorDirs(reveal));
  }, [reveal, store, projectId]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const scroll = useRememberedTreeScroll(bodyRef, view.scrollTop, (top) => store.getState().setScroll(projectId, top), rows);

  useLayoutEffect(() => {
    if (reveal === null) return;
    const row = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? []).find(
      (el) => el.dataset.filePath === reveal,
    );
    if (!row) return;
    scroll.stopRestoring();
    row.scrollIntoView?.({ block: 'nearest' });
    setReveal(null);
  }, [rows, reveal, scroll]);

  const setFilter = (filter: string) => store.getState().setFilter(projectId, filter);
  const root = dirs.get(ROOT_DIR);
  const filtering = view.filter.trim().length > 0;
  const empty = root?.status === 'ready' && rows.length === 0;

  return (
    <>
      <div className="pft-tools">
        <input
          type="search"
          className="pft-filter"
          placeholder="Filter files"
          aria-label="Filter files"
          data-testid="pft-filter"
          value={view.filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && view.filter) {
              event.stopPropagation();
              setFilter('');
            }
          }}
        />
        <button
          type="button"
          className="pft-collapse"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          data-testid="pft-collapse"
          disabled={view.open.length === 0}
          onClick={() => store.getState().collapseAll(projectId)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5" />
          </svg>
        </button>
      </div>
      <div className="pft-body" ref={bodyRef} data-testid="pft-body">
        {empty ? (
          filtering ? (
            <PanelState text={`No files match “${view.filter.trim()}”`} detail="Only opened folders are searched." action={{ label: 'Clear filter', run: () => setFilter('') }} />
          ) : (
            <PanelState text="This folder is empty" />
          )
        ) : (
          <div role="tree" aria-label="Project files" className="pft-tree">
            {rows.map((row) => (
              <Row
                key={rowKey(row)}
                row={row}
                selected={row.type === 'file' && row.path === activePath}
                onToggle={(path, isOpen) => store.getState().setOpen(projectId, path, isOpen)}
                onOpenFile={(path, preview) => openFile({ projectId, path }, { preview })}
                onRetry={retry}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function rowKey(row: TreeRow): string {
  return row.type === 'dir' || row.type === 'file' ? `${row.type}:${row.path}` : `${row.type}:${row.parent}`;
}

function Row({
  row,
  selected,
  onToggle,
  onOpenFile,
  onRetry,
}: {
  row: TreeRow;
  selected: boolean;
  onToggle(path: string, open: boolean): void;
  onOpenFile(path: string, preview: boolean): void;
  onRetry(path: string): void;
}) {
  const indent = { '--pft-depth': row.depth } as CSSProperties;
  switch (row.type) {
    case 'dir':
      return (
        <button
          type="button"
          role="treeitem"
          className="pft-row"
          style={indent}
          aria-level={row.depth + 1}
          aria-expanded={row.open}
          data-dim={row.dim || undefined}
          data-dir-path={row.path}
          title={row.path}
          onClick={() => onToggle(row.path, !row.open)}
        >
          <span className="pft-chevron" aria-hidden>
            {row.open ? '▾' : '▸'}
          </span>
          <span className="pft-name">{row.name}</span>
        </button>
      );
    case 'file':
      return (
        <button
          type="button"
          role="treeitem"
          className="pft-row"
          style={indent}
          aria-level={row.depth + 1}
          aria-selected={selected}
          data-dim={row.dim || undefined}
          data-file-path={row.path}
          title={`${row.path} — click to preview, double-click to keep open`}
          onClick={() => onOpenFile(row.path, true)}
          onDoubleClick={() => onOpenFile(row.path, false)}
        >
          <span className="pft-chevron" aria-hidden />
          <FileTypeBadge path={row.path} />
          <span className="pft-name">{row.name}</span>
        </button>
      );
    case 'loading':
      return (
        <div className="pft-row pft-row--note" style={indent} role="status" aria-busy="true">
          <span className="pft-chevron" aria-hidden />
          Loading…
        </div>
      );
    case 'error':
      return (
        <div className="pft-row pft-row--note pft-row--error" style={indent} role="alert" data-testid="pft-dir-error">
          <span className="pft-chevron" aria-hidden />
          <span className="pft-name" title={row.message}>
            {row.message}
          </span>
          <button type="button" className="pft-retry" onClick={() => onRetry(row.parent)}>
            Retry
          </button>
        </div>
      );
    case 'more':
      return (
        <div className="pft-row pft-row--note" style={indent} data-testid="pft-more">
          <span className="pft-chevron" aria-hidden />
          More files not shown
        </div>
      );
  }
}

/**
 * The tree's scroll, remembered per project. While folders are still listing
 * it keeps re-applying the remembered offset (bounded), unless the person
 * scrolls first; every later scroll is written back, throttled.
 */
function useRememberedTreeScroll(
  ref: { current: HTMLDivElement | null },
  remembered: number,
  write: (top: number) => void,
  rows: readonly TreeRow[],
) {
  const target = useRef<number | null>(remembered > 0 ? remembered : null);
  const writeRef = useRef(write);
  writeRef.current = write;
  const stopRestoring = useCallback(() => {
    target.current = null;
  }, []);

  useLayoutEffect(() => {
    const body = ref.current;
    if (!body || target.current === null) return;
    body.scrollTop = target.current;
    if (Math.abs(body.scrollTop - target.current) < 1) target.current = null;
  }, [ref, rows]);

  useEffect(() => {
    const body = ref.current;
    if (!body) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const giveUp = setTimeout(stopRestoring, SCROLL_RESTORE_MS);
    const onScroll = () => {
      if (target.current !== null || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        writeRef.current(Math.round(body.scrollTop));
      }, SCROLL_WRITE_MS);
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    body.addEventListener('wheel', stopRestoring, { passive: true });
    body.addEventListener('pointerdown', stopRestoring);
    body.addEventListener('keydown', stopRestoring);
    return () => {
      clearTimeout(giveUp);
      if (timer !== null) clearTimeout(timer);
      body.removeEventListener('scroll', onScroll);
      body.removeEventListener('wheel', stopRestoring);
      body.removeEventListener('pointerdown', stopRestoring);
      body.removeEventListener('keydown', stopRestoring);
    };
  }, [ref, stopRestoring]);

  return useMemo(() => ({ stopRestoring }), [stopRestoring]);
}

/** One line and an optional text action: the panel's empty, unavailable and error states. */
function PanelState({ text, detail, action }: { text: string; detail?: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="pft-state" role="status">
      <p className="pft-state__text">{text}</p>
      {detail ? <p className="pft-state__detail">{detail}</p> : null}
      {action ? (
        <button type="button" className="pft-state__action" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
