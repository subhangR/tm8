/**
 * THE BOARD TAB — the task kanban as a full-bleed screen (`#/s/{s}/board`),
 * distinct from the rail-hosted `BoardBody` inside `EntityListPanel`: that one
 * is a MODE of a 320px list, this one owns the viewport and adds what a rail
 * board cannot carry — switchable grouping, cross-axis filters, and true
 * cross-column drag with an optimistic overlay.
 *
 * WHAT THE PIVOT MEANS AS A WRITE, because the three groupings are three
 * DIFFERENT verbs and pretending otherwise would ship a drop that lies:
 *
 *   status → `setState` (commands.work / complete via the registry's own
 *                option routing — done goes through the gated `complete`).
 *   priority   → `setValue` (a version-guarded content patch; the version is
 *                hydrated on demand through `refetchDetail`, since a board
 *                card has never been opened).
 *   assignee   → `assign` twice: ADD the target's edge, then REMOVE the
 *                source's — in that order, so a failure strands the card as
 *                over-assigned (visible, correctable) rather than orphaned.
 *                Dropping on Unassigned is a bare removal.
 *
 * OPTIMISTIC WITH A CONFESSION (§1.5): the card moves at drop time via
 * `applyMoves`; a fresh server read that agrees settles the move
 * (`settledMoves`), a refusal rolls it back and renders the reason INLINE at
 * the refusing column — no toasts, and the card visibly snaps home.
 *
 * ASYNC WRITES READ THROUGH REFS. `data.detailOf` and the lifecycle executor
 * are render-time snapshots; a write that awaited a hydration poll would
 * otherwise consult the stale render it started in and refuse against a
 * version that has long since arrived.
 *
 * The verbs, vocabularies and edge type all come off the task registry entry
 * (`stateControl` / `valueControls` / `assignControl`) — this file names the
 * KIND (legal here; the §15.2 guard fences `panels/`, not `board/`) but never
 * respells a vocabulary the registry already owns.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActorSummary, EntitySummary } from '@tm8/contract';
import { getKind } from '../domain';
import type { SetStateOutcome } from '../domain';
import { placeholderTitleFor, useNewTask } from '../authoring';
import { placeholderNameFor } from '../domain/title-grammar';
import { DisabledIconControl } from '../panels';
import { AvatarStack, Pill, shortDate } from '../kit';
import type { Notice } from '../shell/notices';
import type { GateData } from '../views/useGateData';
import { useRowLifecycle } from '../views/useRowLifecycle';
import {
  EMPTY_FILTERS,
  PIVOTS,
  PRIORITY_COLUMNS,
  STATUS_COLUMNS,
  anyFilterActive,
  applyMoves,
  buildFilters,
  columnsFor,
  KIND_PIVOT_IS_READ_ONLY,
  matching,
  settledMoves,
  type BoardColumn,
  type BoardFilterState,
  type BoardPivot,
} from './board-model';
import { FilterSelect, type FilterOption } from './FilterSelect';
import './board.css';

/** How long a priority drop will wait for the version to hydrate. */
const DETAIL_POLL_TRIES = 20;
const DETAIL_POLL_MS = 100;

/* The closed vocabularies as menu options — the SAME specs the columns are
   built from, so a filter can never offer a state no column would draw. */
const STATUS_OPTIONS: readonly FilterOption[] = STATUS_COLUMNS.map((s) => ({ id: s.key, label: s.label }));
const PRIORITY_OPTIONS: readonly FilterOption[] = PRIORITY_COLUMNS.map((p) => ({ id: p.key, label: p.label }));

/** An unloaded roster is not an empty space, and must not read as one. */
const ROSTER_EMPTY = 'The people and teammates for this space have not loaded yet.';

interface BoardScreenProps {
  data: GateData;
  viewerMemberId?: string | null;
  onNotice: (notice: Notice) => void;
  /** The workspace handoff — a card is a door, and its detail lives there. */
  onOpenEntity: (id: string) => void;
}

export function BoardScreen({ data, viewerMemberId, onNotice, onOpenEntity }: BoardScreenProps) {
  const lifecycle = useRowLifecycle({ data, viewerMemberId, onNotice });

  const [pivot, setPivot] = useState<BoardPivot>('status');
  const [filters, setFilters] = useState<BoardFilterState>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  /** card id → the column key it was optimistically dropped on. */
  const [moves, setMoves] = useState<ReadonlyMap<string, string>>(new Map());
  const [refusal, setRefusal] = useState<{ column: string; reason: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** The card in flight + the column it left, so a drop needs no cache walk. */
  const [dragging, setDragging] = useState<{ row: EntitySummary; from: string } | null>(null);
  /** §8.1 roving focus: column index + card index within it. */
  const [focus, setFocus] = useState<{ col: number; row: number }>({ col: 0, row: 0 });

  // Render-time snapshots made async-safe (see the module docblock).
  const dataRef = useRef(data);
  dataRef.current = data;
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  const task = getKind('task');

  /* THE CREATE CONTROL the board was shipped without: seven columns of drop
     targets and no way to add a card read as a working board that silently
     refused every new task. `useNewTask` makes one immediately (placeholder
     title, focused on open) — the same flow the docks use — and a null
     `unavailable` renders it disabled-with-reason rather than hidden. */
  const newTask = useNewTask({
    spaceId: data.spaceId,
    kind: task.kind,
    placeholderTitle: placeholderNameFor(task, placeholderTitleFor(task.label)),
    commands: data.seam.commands,
    onCreated: (id, result) => {
      data.reconcileCommand(result);
      onOpenEntity(id);
    },
  });

  const stateControl = task.list.stateControl;
  const priorityControl = task.list.valueControls?.find((c) => c.source === 'priority');
  const assignControl = task.list.assignControl;

  /**
   * The people axis: everyone assignable, with the real avatar wherever the
   * space loaded one — `useRowLifecycle.assignable` already unions the member
   * projection with the registry's roster kinds, so the board only dedups.
   */
  const roster = useMemo(() => {
    const seen = new Set<string>();
    const out: ActorSummary[] = [];
    for (const actor of lifecycle.assignable) {
      if (seen.has(actor.id as string)) continue;
      seen.add(actor.id as string);
      out.push(actor);
    }
    return out;
  }, [lifecycle.assignable]);
  const rosterSpecs = useMemo(
    () => roster.map((actor) => ({ id: actor.id as string, label: actor.displayName })),
    [roster],
  );
  /**
   * The people options, built ONCE and handed to both people axes. "Who holds
   * this" and "who handed it out" are different questions over the same
   * population, so they must never drift into two different populations.
   */
  const peopleOptions = useMemo<FilterOption[]>(
    () => roster.map((actor) => ({ id: actor.id as string, label: actor.displayName, actor })),
    [roster],
  );

  const filter = useMemo(() => buildFilters(filters), [filters]);
  const snapshot = data.boardFor('task')(filter, pivot);

  const rawColumns = useMemo(
    () => columnsFor(pivot, snapshot?.groups, filters, rosterSpecs),
    [pivot, snapshot?.groups, filters, rosterSpecs],
  );

  // A fresh read that agrees with the overlay settles it (§ board-model).
  useEffect(() => {
    if (moves.size === 0) return;
    const settled = settledMoves(rawColumns, moves);
    if (settled.length === 0) return;
    setMoves((prior) => {
      const next = new Map(prior);
      for (const id of settled) next.delete(id);
      return next;
    });
  }, [rawColumns, moves]);

  const columns = useMemo(() => applyMoves(rawColumns, moves), [rawColumns, moves]);
  const shownOf = (column: BoardColumn): readonly EntitySummary[] => matching(column.items, search);

  const onPivot = (next: BoardPivot): void => {
    if (next === pivot) return;
    setPivot(next);
    // The overlay's keys are the OLD pivot's vocabulary — meaningless now.
    setMoves(new Map());
    setRefusal(null);
    setFocus({ col: 0, row: 0 });
  };

  const toggle = (axis: keyof BoardFilterState, key: string): void => {
    setFilters((prior) => {
      const list = prior[axis];
      const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
      return { ...prior, [axis]: next };
    });
  };

  const clearAxis = (axis: keyof BoardFilterState): void => {
    setFilters((prior) => ({ ...prior, [axis]: [] }));
  };

  /** Waits for the card's detail to hydrate; the priority patch needs its version. */
  const ensureVersion = async (id: string): Promise<number | undefined> => {
    const have = dataRef.current.detailOf(id)?.version;
    if (have !== undefined) return have;
    dataRef.current.refetchDetail(id);
    for (let attempt = 0; attempt < DETAIL_POLL_TRIES; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, DETAIL_POLL_MS));
      const version = dataRef.current.detailOf(id)?.version;
      if (version !== undefined) return version;
    }
    return undefined;
  };

  const performMove = async (
    row: EntitySummary,
    fromKey: string,
    toKey: string,
  ): Promise<SetStateOutcome> => {
    if (pivot === 'status') {
      if (!stateControl) return { ok: false, reason: 'Tasks have no settable state on this build.' };
      const option = stateControl.options.find((o) => o.id === toKey);
      if (!option) return { ok: false, reason: `“${toKey}” is not a settable state.` };
      return lifecycleRef.current.setState(row.id, option.id, option.via ?? stateControl.command, {
        notify: false,
      });
    }
    /*
     * KIND (155) — the refusal, stated in the ONE sentence `board-model` holds.
     * The columns below refuse the drag outright so this should be unreachable
     * from the mouse; it is here because the KEYBOARD move path calls the same
     * function, and a silent `return` would make Mod+Arrow on this pivot look
     * broken rather than refused.
     */
    if (pivot === 'kind') {
      return { ok: false, reason: KIND_PIVOT_IS_READ_ONLY };
    }
    if (pivot === 'priority') {
      if (!priorityControl) return { ok: false, reason: 'Tasks have no priority control on this build.' };
      const version = await ensureVersion(row.id);
      if (version === undefined) {
        return {
          ok: false,
          reason:
            'Its current version could not be loaded, and changing priority without one could overwrite an edit you have not seen. Open the task, then try again.',
        };
      }
      return lifecycleRef.current.setValue(row.id, priorityControl.source, toKey, priorityControl.label, {
        notify: false,
      });
    }
    if (!assignControl) return { ok: false, reason: 'Tasks are not assignable on this build.' };
    if (toKey === '') {
      if (fromKey === '') return { ok: true };
      return lifecycleRef.current.assign(row.id, fromKey, assignControl.edgeType, false, { notify: false });
    }
    // ADD before REMOVE: a failure between the two leaves the card visibly
    // over-assigned instead of assigned to nobody the user chose.
    const added = await lifecycleRef.current.assign(row.id, toKey, assignControl.edgeType, true, {
      notify: false,
    });
    if (!added.ok || fromKey === '') return added;
    return lifecycleRef.current.assign(row.id, fromKey, assignControl.edgeType, false, { notify: false });
  };

  const dispatchDrop = (row: EntitySummary, fromKey: string, toKey: string): void => {
    if (toKey === fromKey) return;
    setRefusal(null);
    setPendingId(row.id);
    setMoves((prior) => new Map(prior).set(row.id, toKey));
    void performMove(row, fromKey, toKey).then((outcome) => {
      setPendingId((prior) => (prior === row.id ? null : prior));
      if (!outcome.ok) {
        // Roll the overlay back and confess at the column that refused (§1.5).
        setMoves((prior) => {
          const next = new Map(prior);
          next.delete(row.id);
          return next;
        });
        setRefusal({ column: toKey, reason: outcome.reason });
      }
    });
  };

  // §8.1 — drag is never the only path: mod+arrow moves the focused card
  // through the SAME dispatch a drop uses.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey;
    const colCount = columns.length;
    if (colCount === 0) return;
    const col = Math.min(focus.col, colCount - 1);
    const rows = shownOf(columns[col]!);
    const row = Math.min(focus.row, Math.max(0, rows.length - 1));
    const focused = rows[row];

    const move = (delta: number): void => {
      if (!focused) return;
      const target = columns[col + delta];
      if (!target) return;
      dispatchDrop(focused, columns[col]!.key, target.key);
    };

    switch (event.key) {
      case 'ArrowLeft':
      case 'h':
        if (mod) move(-1);
        else setFocus({ col: Math.max(0, col - 1), row: 0 });
        break;
      case 'ArrowRight':
      case 'l':
        if (mod) move(1);
        else setFocus({ col: Math.min(colCount - 1, col + 1), row: 0 });
        break;
      case 'ArrowDown':
      case 'j':
        setFocus({ col, row: Math.min(Math.max(0, rows.length - 1), row + 1) });
        break;
      case 'ArrowUp':
      case 'k':
        setFocus({ col, row: Math.max(0, row - 1) });
        break;
      case 'Enter':
        if (focused) onOpenEntity(focused.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const loading = snapshot === undefined;

  return (
    <section className="bd" data-testid="board-screen">
      {/* ONE ROW OF CHROME. Every axis is a constant-height trigger, so this
          header's height is independent of how many statuses, priorities or
          people the space has — which is the whole point: the board gets the
          rest of the screen. It wraps to a second row only when the window is
          genuinely too narrow to hold the controls. */}
      <header className="bd__bar" data-testid="bd-filters">
        <div className="bd__pivots" role="group" aria-label="Group by">
          {PIVOTS.map((p) => (
            <button
              key={p.key}
              type="button"
              className="bd__pivot"
              aria-pressed={pivot === p.key}
              data-testid={`bd-pivot-${p.key}`}
              onClick={() => onPivot(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <span className="bd__sep" aria-hidden />

        <FilterSelect
          label="Status"
          testId="bd-filter-status"
          options={STATUS_OPTIONS}
          selected={filters.statuses}
          onToggle={(key) => toggle('statuses', key)}
          onClear={() => clearAxis('statuses')}
          emptyNote="This build declares no task states."
        />
        <FilterSelect
          label="Priority"
          testId="bd-filter-priority"
          options={PRIORITY_OPTIONS}
          selected={filters.priorities}
          onToggle={(key) => toggle('priorities', key)}
          onClear={() => clearAxis('priorities')}
          emptyNote="This build declares no priorities."
        />
        <FilterSelect
          label="Assigned to"
          testId="bd-filter-person"
          options={peopleOptions}
          selected={filters.people}
          onToggle={(id) => toggle('people', id)}
          onClear={() => clearAxis('people')}
          emptyNote={ROSTER_EMPTY}
        />
        <FilterSelect
          label="Assigned by"
          testId="bd-filter-assignedby"
          options={peopleOptions}
          selected={filters.assignedBy}
          onToggle={(id) => toggle('assignedBy', id)}
          onClear={() => clearAxis('assignedBy')}
          emptyNote={ROSTER_EMPTY}
        />

        <input
          className="bd__search"
          type="search"
          placeholder="Filter by title…"
          aria-label="Filter cards by title"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {anyFilterActive(filters) ? (
          <button
            type="button"
            className="bd__clear"
            data-testid="bd-clear-filters"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            Clear filters
          </button>
        ) : null}

        {/* THE create control (§1.3): an empty board is a real answer, but a
            board with no way to add a card is a dead end. `＋ New task` sits at
            the end of the one chrome row so it never competes with a card. */}
        {newTask.unavailable === null ? (
          <button
            type="button"
            className="bd__new"
            data-testid="bd-new-task"
            onClick={() => void newTask.create()}
          >
            ＋ New {task.label.toLowerCase()}
          </button>
        ) : (
          <DisabledIconControl label={`New ${task.label.toLowerCase()}`} reason={newTask.unavailable}>
            <span className="bd__new bd__new--off" data-testid="bd-new-task">
              ＋ New {task.label.toLowerCase()}
            </span>
          </DisabledIconControl>
        )}
      </header>

      {snapshot?.error ? (
        <div className="bd__error" data-testid="bd-error" role="alert">
          <p>{`The board could not load: ${snapshot.error}`}</p>
          {snapshot.retry ? (
            <button type="button" className="bd__retry" onClick={snapshot.retry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : (
        <div className="bd__body" role="application" aria-label="Task board" tabIndex={0} onKeyDown={onKeyDown}>
          {/* §1.4 honesty: groups are page-scoped; when a further page exists
              the board says so rather than letting columns read as complete. */}
          {!loading && snapshot?.nextCursor != null ? (
            <div className="bd__banner" data-testid="bd-banner">
              {`Showing the ${snapshot.limit} most recently active tasks — headers carry the true totals.`}
            </div>
          ) : null}
          {/* 155 — the kind pivot is READ-ONLY, said up front: undraggable
              cards with no words are indistinguishable from broken ones, which
              is the same reason the assignee board states its own rule. */}
          {pivot === 'kind' ? (
            <div className="bd__banner" data-testid="bd-kind-note">
              {KIND_PIVOT_IS_READ_ONLY}
            </div>
          ) : null}
          {/* WHAT THE BOARD IS, said once, only when it is genuinely empty (no
              cards anywhere and no filter hiding them) — the columns below are
              honest drop targets but say nothing about what belongs on them. */}
          {!loading && !anyFilterActive(filters) && search.trim() === ''
            && columns.every((column) => column.items.length === 0) ? (
            <div className="bd__firstrun" data-testid="bd-firstrun">
              Every {task.label.toLowerCase()} in this space shows up here, in a column for its
              status. There are none yet — use ＋ New {task.label.toLowerCase()} above to add the
              first.
            </div>
          ) : null}
          <div className="bd__cols">
            {columns.map((column, index) => {
              const shown = loading ? undefined : shownOf(column);
              return (
                <ColumnView
                  key={column.key || 'unassigned'}
                  column={column}
                  shown={shown}
                  pivot={pivot}
                  focused={index === Math.min(focus.col, columns.length - 1)}
                  focusRow={focus.row}
                  refusal={refusal?.column === column.key ? refusal.reason : null}
                  pendingId={pendingId}
                  dragging={dragging}
                  onDragStart={setDragging}
                  onDrop={dispatchDrop}
                  onOpen={onOpenEntity}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

const STATUS_SPEC = new Map(STATUS_COLUMNS.map((s) => [s.key, s] as const));
const PRIORITY_SPEC = new Map(PRIORITY_COLUMNS.map((p) => [p.key, p] as const));

function ColumnView({
  column,
  shown,
  pivot,
  focused,
  focusRow,
  refusal,
  pendingId,
  dragging,
  onDragStart,
  onDrop,
  onOpen,
}: {
  column: BoardColumn;
  /** `undefined` ⇒ loading: header renders, body shimmers (§8.2). */
  shown: readonly EntitySummary[] | undefined;
  pivot: BoardPivot;
  focused: boolean;
  focusRow: number;
  refusal: string | null;
  pendingId: string | null;
  dragging: { row: EntitySummary; from: string } | null;
  onDragStart: (d: { row: EntitySummary; from: string } | null) => void;
  onDrop: (row: EntitySummary, fromKey: string, toKey: string) => void;
  onOpen: (id: string) => void;
}) {
  // "3 of 12" when the page under-represents the group; a bare number when it
  // does not; "n shown" only when no true total exists (loading fixture rows).
  const count =
    shown === undefined
      ? '…'
      : column.total === null
        ? `${shown.length} shown`
        : column.total === shown.length
          ? `${column.total}`
          : `${shown.length} of ${column.total}`;

  return (
    <section
      className={focused ? 'bd__col bd__col--focused' : 'bd__col'}
      data-testid="bd-column"
      data-column={column.key}
      aria-label={column.label}
      /* 155 — a KIND column is not a drop target at all: no `onDragOver`, so
         the browser's own default (reject) stands and the cursor says "no"
         before the finger lifts. Leaving the handlers on and refusing inside
         them would show a move cursor for a move that cannot happen, which is
         a promise the board would then have to break. See
         `KIND_PIVOT_IS_READ_ONLY`. */
      onDragOver={
        pivot === 'kind'
          ? undefined
          : (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
      }
      onDrop={
        pivot === 'kind'
          ? undefined
          : (event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData('text/plain');
              const drag = dragging && dragging.row.id === id ? dragging : null;
              onDragStart(null);
              if (drag) onDrop(drag.row, drag.from, column.key);
            }
      }
    >
      <header className="bd__col-head">
        <Pill tone={column.tone}>{column.label}</Pill>
        <span className="bd__col-count">{count}</span>
      </header>

      {refusal ? (
        <p className="bd__refusal" role="alert" data-testid="bd-refusal">
          {refusal}
        </p>
      ) : null}

      <div className="bd__cards" role="list">
        {shown === undefined ? (
          <>
            <div className="bd__skeleton" aria-hidden data-testid="bd-skeleton" />
            <div className="bd__skeleton" aria-hidden />
          </>
        ) : shown.length === 0 ? (
          // §1.3: an empty column is a real answer — and the drop target that
          // makes the answer changeable.
          <p className="bd__empty">{`nothing in ${column.label}`}</p>
        ) : (
          shown.map((row, index) => (
            <CardView
              key={row.id}
              row={row}
              pivot={pivot}
              fromKey={column.key}
              pending={row.id === pendingId}
              draggingId={dragging?.row.id ?? null}
              cardFocused={focused && index === focusRow}
              onDragStart={onDragStart}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}

function CardView({
  row,
  pivot,
  fromKey,
  pending,
  draggingId,
  cardFocused,
  onDragStart,
  onOpen,
}: {
  row: EntitySummary;
  pivot: BoardPivot;
  fromKey: string;
  pending: boolean;
  draggingId: string | null;
  cardFocused: boolean;
  onDragStart: (d: { row: EntitySummary; from: string } | null) => void;
  onOpen: (id: string) => void;
}) {
  const state = row.state.kind === 'task' ? row.state : null;
  const priority = state ? PRIORITY_SPEC.get(state.priority) : undefined;
  const status = state ? STATUS_SPEC.get(state.status) : undefined;
  const cls = [
    'bd__card',
    pending ? 'bd__card--pending' : '',
    row.id === draggingId ? 'bd__card--dragging' : '',
    cardFocused ? 'bd__card--focused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      role="listitem"
      className={cls}
      data-testid="bd-card"
      data-entity={row.id}
      /* 155 — not draggable on the KIND pivot: the columns accept nothing, so
         a card that could still be picked up would be offering a gesture with
         no destination. */
      draggable={pivot !== 'kind'}
      onDragStart={
        pivot === 'kind'
          ? undefined
          : (event) => {
              event.dataTransfer.setData('text/plain', row.id);
              event.dataTransfer.effectAllowed = 'move';
              onDragStart({ row, from: fromKey });
            }
      }
      onDragEnd={pivot === 'kind' ? undefined : () => onDragStart(null)}
    >
      <button type="button" className="bd__card-title" onClick={() => onOpen(row.id)}>
        {row.title}
      </button>
      <div className="bd__card-meta">
        {/* The pivot's own axis is the COLUMN — repeating it on every card
            would be noise; the other axis stays visible. */}
        {priority && pivot !== 'priority' ? <Pill tone={priority.tone}>{priority.label}</Pill> : null}
        {status && pivot !== 'status' ? <Pill tone={status.tone}>{status.label}</Pill> : null}
        {state?.dueDate ? <span className="bd__card-due">{`due ${shortDate(state.dueDate)}`}</span> : null}
        {state && state.acceptance.total > 0 ? (
          <span className="bd__card-accept">{`✓ ${state.acceptance.completed}/${state.acceptance.total}`}</span>
        ) : null}
        {state && state.assignees.length > 0 ? <AvatarStack actors={state.assignees} /> : null}
      </div>
    </article>
  );
}
