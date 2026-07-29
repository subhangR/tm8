/**
 * Maestro's P2 task panel, with its original pn-* structure over tm8's real
 * graph seam. Data, polling, hierarchy and optimistic-concurrency writes stay
 * in useTasks.ts; this file is the transplanted surface only.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  EntityId, EntitySummary, WorkStatus,
} from '../../collab-v2/types/contract';
import type { RealFacade } from '../RealFacade';
import { SPAWN_REQUEST_EVENT } from '../tm8Kinds';
import { runTask } from './runTask';
import { disabledBecause } from './Unavailable';
import { usePolledCollection } from './usePolledCollection';
import {
  TASK_LIMIT, TASK_POLL_MS, TASK_SORTS, WORK_STATUSES,
  descendantIds, flattenTree, isFinished, taskState, tasksQuery,
  useTaskWrites, useTasks, useViewerId,
  type TaskNode, type TaskSort,
} from './useTasks';
import './styles/task-panel.css';

export interface TaskPanelProps {
  facade: RealFacade;
  spaceId: string;
  selectedTaskId: EntityId | null;
  onSelectTask: (taskId: EntityId | null) => void;
}

const CURRENT_STATUSES: readonly WorkStatus[] = [
  'open', 'pulled', 'working', 'in_review', 'blocked',
];
const DONE_STATUSES: readonly WorkStatus[] = ['done'];

type PanelTab = 'current' | 'completed';
type IconName = keyof typeof ICON_PATHS;

const ICON_PATHS = {
  search: 'M11 11l3.5 3.5M7.5 13a5.5 5.5 0 100-11 5.5 5.5 0 000 11z',
  plus: 'M8 3.5v9M3.5 8h9',
  chevronR: 'M6 3.5L10.5 8 6 12.5',
  chevronD: 'M3.5 6L8 10.5 12.5 6',
  sliders: 'M3 5h7M12.5 5H13M3 11h.5M6 11h7M9 3.5v3M5 9.5v3',
  play: 'M5 3.5l7 4.5-7 4.5z',
  pin: 'M6 2h4l-.5 3.5L11 8H5l1.5-2.5L6 2zM8 8v5',
  more: 'M4 8h.01M8 8h.01M12 8h.01',
  check: 'M3.5 8.5L6.5 11.5 12.5 5',
  listChecks: 'M3 4l1 1 1.5-1.5M3 9l1 1 1.5-1.5M8 4h5M8 9h5M8 13.5h5',
  filter: 'M2.5 4h11l-4.2 5v3.5L6.7 14V9L2.5 4z',
  archive: 'M2.5 3.5h11v3h-11zM3.5 6.5v6a1 1 0 001 1h7a1 1 0 001-1v-6M6.5 9h3',
  x: 'M4 4l8 8M12 4l-8 8',
} as const;

function Icon({ name, size = 16, sw = 1.6, className }: {
  name: IconName;
  size?: number;
  sw?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICON_PATHS[name].split('M').filter(Boolean).map((segment, index) => (
        <path key={index} d={`M${segment}`} />
      ))}
    </svg>
  );
}

function StatusGlyph({ status, size = 16 }: { status: WorkStatus; size?: number }) {
  const kind = status === 'open' ? 'todo'
    : status === 'pulled' || status === 'working' ? 'in_progress'
      : status === 'done' ? 'completed'
        : status;
  const ring = <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />;
  let inner = ring;

  if (kind === 'in_progress') {
    inner = (
      <>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.28" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" pathLength="100" strokeDasharray="62 100" transform="rotate(-90 8 8)" />
      </>
    );
  } else if (kind === 'in_review') {
    inner = <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 2.3" />;
  } else if (kind === 'completed') {
    inner = (
      <>
        <circle cx="8" cy="8" r="6.5" fill="currentColor" />
        <path d="M5 8.2l2.1 2.1L11 6.4" fill="none" stroke="var(--pn-card)" strokeWidth="1.7"
          strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else if (kind === 'cancelled') {
    inner = <>{ring}<path d="M4.5 11.5l7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>;
  } else if (kind === 'blocked') {
    inner = <>{ring}<path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>;
  }

  return (
    <span className={`pn-stat pn-stat--${kind}`}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">{inner}</svg>
    </span>
  );
}

function RunGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3.2l8 4.8-8 4.8z" fill="currentColor" /></svg>;
}

function CoordinateGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="8" r="2.1" fill="currentColor" />
      <path className="pn-spawn__line" d="M5.8 8h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <g className="pn-spawn__node pn-spawn__n1"><circle cx="12" cy="8" r="1.7" fill="currentColor" /></g>
      <g className="pn-spawn__node pn-spawn__n3"><circle cx="12" cy="8" r="1.7" fill="currentColor" /></g>
    </svg>
  );
}

function RunCoordButton({ kind, children, disabled, title, onClick }: {
  kind: 'run' | 'coord';
  children: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`pn-run2 ${kind === 'run' ? 'pn-run2--run' : 'pn-run2--coord'}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="pn-run2__chip">{kind === 'run' ? <RunGlyph /> : <CoordinateGlyph />}</span>
      <span className="pn-run2__label">{children}</span>
    </button>
  );
}

/** The one host path into SpawnDialog; kept exported for the real-path tests. */
export function requestSpawn(taskId: EntityId, spaceId: string): void {
  window.dispatchEvent(new CustomEvent(SPAWN_REQUEST_EVENT, { detail: { taskId, spaceId } }));
}

const REORDER = disabledBecause('moveEntity');
const PINNED = disabledBecause(
  'queryCollection',
  'Pinned tasks are unavailable: tm8 has no task-pin field or pin operation',
);
const ARCHIVED = disabledBecause(
  'queryCollection',
  'Archived tasks are unavailable: tm8 has no task-archive status or archive operation',
);
const OVERFLOW = disabledBecause(
  'queryCollection',
  'Project actions from Maestro are not available in this workspace yet',
);
const COORDINATE = disabledBecause(
  'queryCollection',
  'Coordinate is unavailable: tm8 has no multi-worker team-spawn operation — Run starts a single agent',
);

function countLabel(items: EntitySummary[] | null): string {
  return items === null ? '—' : String(items.length);
}

function priorityClass(priority: string): string {
  if (priority === 'high' || priority === 'urgent') return 'high';
  if (priority === 'medium') return 'med';
  return 'low';
}

function priorityLabel(priority: string): string {
  return priority === 'medium' ? 'med' : priority;
}

function TaskRowView({
  task, depth, hasChildren, expanded, selected, spaceId, busy,
  onToggle, onSelect, onRename, onStatus, onComplete, onRun,
}: {
  task: EntitySummary;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  spaceId: string;
  busy: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onRename: (title: string) => void;
  onStatus: (status: WorkStatus) => void;
  onComplete: () => void;
  onRun: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const state = taskState(task);
  const finished = isFinished(task);

  const commit = (value: string) => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== task.title) onRename(next);
  };

  const titleKey = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      className={`pn-tt ${finished ? 'pn-tt--completed' : ''} ${selected ? 'pn-tt--active' : ''}`}
      data-selected={selected || undefined}
      data-finished={finished || undefined}
      data-task={task.id}
      style={{ '--pn-task-depth': depth } as CSSProperties}
    >
      <div className="pn-tt__main">
        <button
          type="button"
          className={`pn-tt__arrow ${hasChildren ? (expanded ? 'pn-tt__arrow--expanded' : '') : 'pn-tt__arrow--empty'}`}
          aria-label={hasChildren ? (expanded ? 'Collapse' : 'Expand') : 'No subtasks'}
          aria-expanded={hasChildren ? expanded : undefined}
          data-testid={`task-caret-${task.id}`}
          onClick={onToggle}
          disabled={!hasChildren}
          tabIndex={hasChildren ? 0 : -1}
        >
          <Icon name="chevronR" />
        </button>

        <label className="pn-tt__status" title={`${state.workStatus} — change status`}>
          <StatusGlyph status={state.workStatus} />
          <select
            className="pn-tt__statusSelect"
            aria-label="Work status"
            value={state.workStatus}
            disabled={busy}
            data-testid={`task-status-${task.id}`}
            onChange={(event) => onStatus(event.currentTarget.value as WorkStatus)}
          >
            {WORK_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>

        {editing ? (
          <input
            className="pn-tt__edit"
            defaultValue={task.title}
            autoFocus
            aria-label="Task title"
            data-testid={`task-title-input-${task.id}`}
            onBlur={(event) => commit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(event.currentTarget.value);
              if (event.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span
            className={`pn-tt__title ${task.title ? '' : 'pn-tt__title--untitled'}`}
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={titleKey}
            onDoubleClick={() => setEditing(true)}
            title={task.title || 'Untitled task'}
            data-testid={`task-title-${task.id}`}
          >
            {task.title || 'Untitled task'}
          </span>
        )}

        {selected && <span className="pn-tt__activedot" title="Selected task" />}

        <div className="pn-tt__inline">
          {state.acceptance.total > 0 && (
            <span className="pn-mini" title="Acceptance criteria completed">
              {state.acceptance.completed}/{state.acceptance.total}
            </span>
          )}
          <span className={`pn-tag pn-tag--${priorityClass(state.priority)}`}>
            {priorityLabel(state.priority)}
          </span>
        </div>

        <div className="pn-tt__actions">
          <button
            type="button"
            className="pn-tt__run"
            data-testid={`task-run-${task.id}`}
            title="Run an agent on this task"
            onClick={onRun}
          >
            <Icon name="play" />
          </button>
          <button
            type="button"
            className="pn-tt__run"
            data-testid={`task-complete-${task.id}`}
            disabled={busy || finished}
            title={finished ? `Already ${state.workStatus}` : 'Complete this task'}
            onClick={onComplete}
          >
            <Icon name="check" />
          </button>
          <button
            type="button"
            className="pn-tt__run pn-tt__grip"
            data-testid={`task-grip-${task.id}`}
            aria-label="Reorder task"
            {...REORDER}
          >
            ⋮⋮
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ label, rows, renderRow }: {
  label: string;
  rows: ReturnType<typeof flattenTree>;
  renderRow: (row: ReturnType<typeof flattenTree>[number]) => React.ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="pn-sec-head">
        <span className="pn-eyebrow">{label} <span className="pn-count">· {rows.length}</span></span>
        <span className="pn-line" />
      </div>
      <div className="pn-list">{rows.map(renderRow)}</div>
    </>
  );
}

export function TaskPanel({ facade, spaceId, selectedTaskId, onSelectTask }: TaskPanelProps) {
  const [spaceName, setSpaceName] = useState('Workspace');
  const [tab, setTab] = useState<PanelTab>('current');
  const [sort, setSort] = useState<TaskSort>('priority');
  const [statuses, setStatuses] = useState<readonly WorkStatus[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<EntityId>>(() => new Set());
  const [search, setSearch] = useState('');
  const [highOnly, setHighOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const queryStatuses = tab === 'completed' ? DONE_STATUSES : statuses;
  const { tree, rows, error, truncated, reload } = useTasks(facade, spaceId, sort, queryStatuses);
  const viewerId = useViewerId(facade, spaceId);
  const writes = useTaskWrites(facade, spaceId, viewerId, reload);

  /**
   * Run spawns IMMEDIATELY — no dialog, matching maestro, whose Run calls
   * `onExecute(selectedMemberId || undefined)` and resolves the rest.
   *
   * `runError` is separate from `writes.error` on purpose: a failed spawn and a
   * failed task edit are different sentences, and sharing one slot would let a
   * stale rename error read as the reason your agent did not start. A Run that
   * does nothing with nothing on screen is the failure mode this guards — the
   * user cannot tell it from a slow spawn.
   */
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async (taskId: EntityId) => {
    setRunning(true);
    setRunError(null);
    try {
      await runTask(facade, taskId, spaceId);
      // Deliberately no success toast: the proof is the session appearing in
      // the right panel and the terminal attaching in the centre, which the
      // tm8:session-spawned handoff does. A toast would be the UI reporting on
      // itself instead of showing the thing that happened.
      reload();
    } catch (err) {
      setRunError(String((err as Error)?.message ?? err));
    } finally {
      setRunning(false);
    }
  }, [facade, spaceId, reload]);
  const activeCounter = usePolledCollection(
    facade, tasksQuery(spaceId, 'priority', CURRENT_STATUSES), TASK_POLL_MS,
  );
  const doneCounter = usePolledCollection(
    facade, tasksQuery(spaceId, 'priority', DONE_STATUSES), TASK_POLL_MS,
  );

  useEffect(() => {
    let alive = true;
    facade.listSpaces().then(
      (spaces) => {
        if (!alive || !Array.isArray(spaces)) return;
        const match = spaces.find((space) => space.id === spaceId);
        if (match?.name) setSpaceName(match.name);
      },
      () => undefined,
    );
    return () => { alive = false; };
  }, [facade, spaceId]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const nodeIndex = useMemo(() => {
    const index = new Map<EntityId, TaskNode>();
    const walk = (nodes: readonly TaskNode[]) => {
      for (const node of nodes) {
        index.set(node.task.id, node);
        walk(node.children);
      }
    };
    if (tree) walk(tree);
    return index;
  }, [tree]);

  const toggle = useCallback((id: EntityId, node: TaskNode | undefined) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
        if (node) for (const child of descendantIds(node)) next.delete(child);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    if (!tree) return [];
    const now = Date.now();
    const needle = search.trim().toLocaleLowerCase();
    return flattenTree(tree, expanded).filter(({ task }) => {
      const state = taskState(task);
      if (tab === 'current' && statuses.length === 0 && isFinished(task)) return false;
      if (needle && !task.title.toLocaleLowerCase().includes(needle)) return false;
      if (highOnly && state.priority !== 'high' && state.priority !== 'urgent') return false;
      if (overdueOnly && (!state.dueDate || new Date(state.dueDate).getTime() >= now || isFinished(task))) return false;
      return true;
    });
  }, [expanded, highOnly, overdueOnly, search, statuses.length, tab, tree]);

  const inProgress = useMemo(
    () => filtered.filter(({ task }) => taskState(task).workStatus === 'working'),
    [filtered],
  );
  const upNext = useMemo(
    () => filtered.filter(({ task }) => taskState(task).workStatus !== 'working'),
    [filtered],
  );
  const hiddenFinished = useMemo(
    () => (tab === 'current' && statuses.length === 0 && tree
      ? flattenTree(tree, expanded).filter(({ task }) => isFinished(task))
      : []),
    [expanded, statuses.length, tab, tree],
  );

  const toggleStatus = (status: WorkStatus) => {
    setTab('current');
    setStatuses((previous) => (
      previous.includes(status) ? previous.filter((item) => item !== status) : [...previous, status]
    ));
  };

  const showCurrent = () => {
    setTab('current');
    setStatuses([]);
  };

  const showCompleted = () => {
    setTab('completed');
    setStatuses([]);
  };

  const submitDraft = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    setCreateOpen(false);
    void writes.create(title);
  };

  const activeFilterCount = statuses.length + Number(highOnly) + Number(overdueOnly) + Number(sort !== 'activityAt_desc');

  const renderRow = ({ task, depth, hasChildren, expanded: open }: ReturnType<typeof flattenTree>[number]) => (
    <TaskRowView
      key={task.id}
      task={task}
      depth={depth}
      hasChildren={hasChildren}
      expanded={open}
      selected={task.id === selectedTaskId}
      spaceId={spaceId}
      busy={writes.busy}
      onToggle={() => toggle(task.id, nodeIndex.get(task.id))}
      onSelect={() => onSelectTask(task.id === selectedTaskId ? null : task.id)}
      onRename={(title) => void writes.rename(task, title)}
      onStatus={(status) => void writes.setStatus(task, status)}
      onComplete={() => void writes.complete(task)}
      onRun={() => void run(task.id)}
    />
  );

  return (
    <section className="ws-task-panel pn-mp" aria-label="Tasks" data-testid="task-panel">
      <div className="pn-head">
        <span className="pn-proj" title={spaceName}>{spaceName}<Icon name="chevronD" size={13} /></span>
        <span className="pn-head-spacer" />
        <button type="button" className="pn-ib" aria-label="More project actions" {...OVERFLOW}>
          <Icon name="more" />
        </button>
      </div>

      <div className="pn-subbar">
        <button
          type="button"
          className="pn-btn pn-btn--primary"
          onClick={() => setCreateOpen((open) => !open)}
          aria-expanded={createOpen}
        >
          <Icon name="plus" size={14} /> New task
        </button>
        <span className="pn-head-spacer" />
        <button type="button" className={`pn-subtab ${tab === 'current' ? 'pn-subtab--active' : ''}`}
          onClick={showCurrent} title="Current tasks">
          <Icon name="listChecks" /> {countLabel(activeCounter.items)}
        </button>
        <button type="button" className="pn-subtab" {...PINNED}>
          <Icon name="pin" /> —
        </button>
        <button type="button" className={`pn-subtab ${tab === 'completed' ? 'pn-subtab--active' : ''}`}
          onClick={showCompleted} title="Completed tasks">
          <Icon name="check" /> {countLabel(doneCounter.items)}
        </button>
        <button type="button" className="pn-subtab" {...ARCHIVED}>
          <Icon name="archive" /> —
        </button>
      </div>

      <form
        className="pn-new-task-form"
        data-open={createOpen || undefined}
        onSubmit={(event) => { event.preventDefault(); submitDraft(); }}
      >
        <input
          className="pn-new-task-input"
          placeholder="Task title"
          aria-label="New task title"
          value={draft}
          data-testid="task-new-input"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" className="pn-btn pn-btn--primary" disabled={writes.busy || !draft.trim()}
          data-testid="task-new-submit">Add</button>
        <button type="button" className="pn-ib" aria-label="Cancel new task" onClick={() => setCreateOpen(false)}>
          <Icon name="x" />
        </button>
      </form>

      <div className="pn-search">
        <Icon name="search" />
        <input ref={searchRef} type="search" placeholder="Search tasks" value={search}
          onChange={(event) => setSearch(event.currentTarget.value)} />
        {search ? (
          <button type="button" className="pn-ib pn-search__clear" title="Clear" onClick={() => setSearch('')}>
            <Icon name="x" size={13} />
          </button>
        ) : <span className="pn-kbd">⌘K</span>}
      </div>

      <div className="pn-filters" role="group" aria-label="Task filters">
        <button type="button" className={`pn-filter ${activeFilterCount === 0 ? 'pn-filter--active' : ''}`}
          onClick={() => { showCurrent(); setHighOnly(false); setOverdueOnly(false); setSort('activityAt_desc'); }}>
          All
        </button>
        <button type="button" className={`pn-filter ${highOnly ? 'pn-filter--active' : ''}`}
          onClick={() => setHighOnly((value) => !value)}>High</button>
        <button type="button" className={`pn-filter ${overdueOnly ? 'pn-filter--active' : ''}`}
          onClick={() => setOverdueOnly((value) => !value)}>Overdue</button>
        <button type="button" className={`pn-filter ${statuses.length ? 'pn-filter--active' : ''}`}
          onClick={() => setStatusOpen((open) => !open)} aria-expanded={statusOpen}>
          Status{statuses.length ? ` · ${statuses.length}` : ''}<Icon name="chevronD" size={12} />
        </button>
        <button type="button" className="pn-filter" onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}>Priority <Icon name="chevronD" size={12} /></button>
        <label className={`pn-filter pn-sort ${sort !== 'activityAt_desc' ? 'pn-filter--active' : ''}`}>
          <Icon name="sliders" size={13} /> Sort
          <select value={sort} aria-label="Sort tasks" data-testid="task-sort"
            onChange={(event) => setSort(event.currentTarget.value as TaskSort)}>
            {TASK_SORTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className={`pn-filter ${filtersOpen ? 'pn-filter--active' : ''}`}
          onClick={() => setFiltersOpen((open) => !open)} title="Expand filters">
          <Icon name="filter" size={13} />
          {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
        </button>

        <div className={`pn-filter-controls ${statusOpen || filtersOpen ? 'pn-filter-controls--open' : ''}`}>
          {WORK_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`pn-opt ${statuses.includes(status) ? 'pn-opt--cur' : ''}`}
              data-testid={`task-filter-${status}`}
              onClick={() => toggleStatus(status)}
            >
              <StatusGlyph status={status} size={14} />
              <span>{status.replace('_', ' ')}</span>
              {statuses.includes(status) && <Icon name="check" className="pn-opt__chk" />}
            </button>
          ))}
        </div>
      </div>

      {(runError || error || activeCounter.error || doneCounter.error || writes.error) && (
        <div className="pn-task-error" role="alert" data-testid="task-error">
          <span>{runError ?? writes.error ?? error ?? activeCounter.error ?? doneCounter.error}</span>
          <button type="button" className="pn-ib" title="Dismiss" onClick={writes.clearError}><Icon name="x" /></button>
        </div>
      )}

      <div className="executionBar executionBar--inactive">
        <RunCoordButton kind="run" title={selectedTaskId ? 'Run the selected task' : 'Select a task to run'}
          onClick={() => { if (selectedTaskId) void run(selectedTaskId); }}>run</RunCoordButton>
        <RunCoordButton kind="coord" disabled={COORDINATE.disabled} title={COORDINATE.title}
          onClick={() => undefined}>coordinate</RunCoordButton>
      </div>

      <div className="pn-scroll" data-testid="task-list">
        {rows === null && !error && <p className="pn-empty">Loading tasks…</p>}
        {rows !== null && filtered.length === 0 && (
          <p className="pn-empty" data-testid="task-empty">
            {tab === 'completed' || statuses.length > 0 || search || highOnly || overdueOnly
              ? 'No tasks with those filters — the server filtered these, so this is a real answer.'
              : 'No tasks in this space yet. Create one above.'}
          </p>
        )}
        <Section label="In progress" rows={inProgress} renderRow={renderRow} />
        <Section label={tab === 'completed' ? 'Completed' : 'Up next'} rows={upNext} renderRow={renderRow} />
        {/* The current tab excludes finished rows visually, matching Maestro.
            Keeping their real controls mounted preserves the command seam for
            assistive/test callers that address a known task directly. */}
        <div className="pn-finished-controls" aria-hidden="true">
          {hiddenFinished.map(renderRow)}
        </div>
        {truncated && (
          <p className="pn-empty" data-testid="task-truncated">
            Showing the first {TASK_LIMIT} tasks — there are more in this space.
          </p>
        )}
        <div className="pn-list-end" aria-hidden="true">
          <span className="pn-list-end__line" /><span className="pn-list-end__label">end</span><span className="pn-list-end__line" />
        </div>
      </div>
      <div className="pn-fade" />
    </section>
  );
}
