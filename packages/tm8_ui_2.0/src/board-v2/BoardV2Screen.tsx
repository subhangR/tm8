/**
 * BOARD V2 — the universal board as a full-bleed screen (`#/s/{s}/board-v2`),
 * built on the Kind/Status/Category/Workflow model. Structure and honesty
 * rules inherited from Board v1 (optimistic-with-a-confession drops, empty
 * columns as real answers, refusals rendered inline at the refusing column);
 * what is NEW is universality:
 *
 *   · a KIND SELECTOR drives the whole board — population `collectionKinds()`,
 *     behaviour resolved per kind from the registry config and the space's
 *     workflows, never from a kind name;
 *   · columns are the FOUR CATEGORIES (each a real `filters.category` read),
 *     with a 'No status yet' column for rows the category reads structurally
 *     cannot return — server truth (`summary.category` absent), never a
 *     client-invented bucket;
 *   · WORKFLOW COLUMNS when the selected kind's workflow can be drawn exactly
 *     (see `planFor`), states grouped under category bands;
 *   · ARCHIVED IS A FILTER (`filters.deleted`), never a column;
 *   · a drop resolves through the plan's drop seam; where a kind cannot move
 *     yet, the drop REFUSES VISIBLY with the phase that unlocks it.
 *
 * A CARD OPENS ITS ENTITY HERE, not somewhere else. Pressing a card used to
 * navigate to the workspace, which unmounted the board and took the kind, the
 * filters, the search and the scroll position with it — the user asked a
 * question of the board and reading one answer destroyed the question. The
 * detail now opens as the app's ONE panel (`BoardEntityColumn` →
 * `AuxEntityPanel`) OVER the last column, at that column's width, so the board
 * is still there when it closes.
 *
 * ASYNC WRITES READ THROUGH REFS, exactly as v1: the lifecycle executor is a
 * render-time snapshot, and a write must not consult the stale render it
 * started in.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActorSummary, EntityId, EntitySummary, SpaceId, Workflow } from '@tm8/contract';
import { collectionKinds, getKind } from '../domain';
import type { SetStateOutcome } from '../domain';
import { placeholderTitleFor, useNewTask } from '../authoring';
import { placeholderNameFor } from '../domain/title-grammar';
import { DisabledIconControl, toReason, type DetailReasons } from '../panels';
import { AvatarStack, Pill } from '../kit';
import { Badge } from '@astryxdesign/core/Badge';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import type { Notice } from '../shell/notices';
import type { GateData } from '../views/useGateData';
import { useRowLifecycle } from '../views/useRowLifecycle';
import { BoardEntityColumn } from './BoardEntityColumn';
import {
  EMPTY_FILTERS,
  UNCATEGORISED_KEY,
  anyFilterActive,
  applyMoves,
  buildFilters,
  columnFilter,
  matching,
  planFor,
  resolveWorkflow,
  settledMoves,
  uncategorised,
  type BoardColumn,
  type BoardFilterState,
  type ColumnPlan,
  type Move,
} from './board-model';
import { FilterSelect, type FilterOption } from './FilterSelect';
import './board.css';

/** An unloaded roster is not an empty space, and must not read as one. */
const ROSTER_EMPTY = 'The people and teammates for this space have not loaded yet.';

interface BoardV2ScreenProps {
  data: GateData & { pull?: (id: string) => void };
  viewerMemberId?: string | null;
  onNotice: (notice: Notice) => void;
  /** The panel's refusal copy — the same bundle every other panel host takes. */
  reasons: DetailReasons;
  serverBaseUrl?: string | undefined;
}

export function BoardV2Screen({
  data,
  viewerMemberId,
  onNotice,
  reasons,
  serverBaseUrl,
}: BoardV2ScreenProps) {
  const lifecycle = useRowLifecycle({ data, viewerMemberId, onNotice });

  /* The selected KIND. Default is the kind the program's phases have already
     given real categories — found via the registry, and the same default the
     v1 board served. */
  const [kindName, setKindName] = useState<string>('task');
  const [filters, setFilters] = useState<BoardFilterState>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [useWorkflowCols, setUseWorkflowCols] = useState(false);
  /** card id → both endpoints of its optimistic move. */
  const [moves, setMoves] = useState<ReadonlyMap<string, Move>>(new Map());
  const [refusal, setRefusal] = useState<{ column: string; reason: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ row: EntitySummary; from: string } | null>(null);
  /** §8.1 roving focus: column index + card index within it. */
  const [focus, setFocus] = useState<{ col: number; row: number }>({ col: 0, row: 0 });
  /** The card whose entity the panel is showing, or null for none. */
  const [openId, setOpenId] = useState<EntityId | null>(null);

  // Render-time snapshots made async-safe (see the module docblock).
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  const kind = getKind(kindName);
  const kinds = useMemo(() => collectionKinds(), []);

  /* THE WORKFLOWS READ — `spaces.workflows.list`, once per space. A failure
     is a stated downgrade (category columns keep working off `filters.
     category` alone), never a blank board. */
  const [workflows, setWorkflows] = useState<
    { list?: Workflow[]; error?: string } | undefined
  >(undefined);
  useEffect(() => {
    if (!data.ready || !data.spaceId) return;
    let alive = true;
    setWorkflows(undefined);
    data.seam
      .workflows(data.spaceId as SpaceId)
      .then((list) => {
        if (alive) setWorkflows({ list });
      })
      .catch((error: unknown) => {
        if (alive) setWorkflows({ error: String((error as { message?: string })?.message ?? error) });
      });
    return () => {
      alive = false;
    };
  }, [data.ready, data.spaceId, data.seam]);

  const workflow = resolveWorkflow(kind, workflows?.list);
  const plan = useMemo(
    () => planFor(kind, workflow, useWorkflowCols),
    [kind, workflow, useWorkflowCols],
  );

  const newEntity = useNewTask({
    spaceId: data.spaceId,
    kind: kind.kind,
    placeholderTitle: placeholderNameFor(kind, placeholderTitleFor(kind.label)),
    commands: data.seam.commands,
    onCreated: (id, result) => {
      data.reconcileCommand(result);
      openEntity(id as EntityId);
    },
  });

  const stateControl = kind.list.stateControl;
  const assignControl = kind.list.assignControl;

  /* One door for every route in: a card press, Enter on the focused card, a
     freshly created entity, and a drill sideways from inside the panel all
     REPLACE the panel's subject rather than opening a second surface. */
  const openEntity = (id: EntityId): void => setOpenId(id);

  /* Esc closes the panel — at the DOCUMENT, because the focus may well be
     inside the panel rather than on the board's own key handler, and only when
     the event arrives unclaimed so a menu or a composer inside the panel gets
     it first. */
  useEffect(() => {
    if (openId === null) return undefined;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpenId(null);
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [openId]);

  /** The people axis (only offered when the kind is assignable at all). */
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
  const peopleOptions = useMemo<FilterOption[]>(
    () => roster.map((actor) => ({ id: actor.id as string, label: actor.displayName, actor })),
    [roster],
  );
  const kindOptions = useMemo<FilterOption[]>(
    () => kinds.map((row) => ({ id: row.kind, label: row.labelPlural })),
    [kinds],
  );

  const base = useMemo(() => buildFilters(filters), [filters]);

  /* EVERY COLUMN IS A REAL READ. `rowsFor` caches per (kind, filter) and the
     durable stream keeps each key current; `pageStateOf` distinguishes "in
     flight" from "empty" so a loading column shimmers instead of claiming
     emptiness. The uncategorised column narrows the BASE read on the
     server-computed `category` being absent. */
  const rowsOf = data.rowsFor(kind.kind);
  const pageOf = data.pageStateOf(kind.kind);
  const rawColumns: BoardColumn[] = plan.columns.map((col) => {
    const filter = columnFilter(base, col);
    const rows = col.filter === null ? uncategorised(rowsOf(filter)) : rowsOf(filter);
    const page = pageOf(filter);
    return {
      plan: col,
      items: page.loading && rows.length === 0 ? undefined : rows,
      hasMore: page.hasMore,
    };
  });

  // A fresh read that answers the overlay settles it (§ board-model).
  useEffect(() => {
    if (moves.size === 0) return;
    const settled = settledMoves(rawColumns, moves);
    if (settled.length === 0) return;
    setMoves((prior) => {
      const next = new Map(prior);
      for (const id of settled) next.delete(id);
      return next;
    });
  });

  const columns = useMemo(() => applyMoves(rawColumns, moves), [rawColumns, moves]);
  /* 'No status yet' renders only when it has something to say: it is not a
     drop target, so unlike the category columns an empty one answers no
     question and would spend a column of width claiming one. */
  const shownColumns = columns.filter(
    (c) => c.plan.key !== UNCATEGORISED_KEY || (c.items?.length ?? 0) > 0,
  );
  const shownOf = (column: BoardColumn): readonly EntitySummary[] =>
    matching(column.items ?? [], search);

  const onKind = (next: string): void => {
    if (next === kindName) return;
    setKindName(next);
    // The overlay's keys are the OLD kind's rows — meaningless now.
    setMoves(new Map());
    setRefusal(null);
    setFocus({ col: 0, row: 0 });
  };

  const toggle = (axis: 'people' | 'assignedBy', key: string): void => {
    setFilters((prior) => {
      const list = prior[axis];
      const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
      return { ...prior, [axis]: next };
    });
  };
  const clearAxis = (axis: 'people' | 'assignedBy'): void => {
    setFilters((prior) => ({ ...prior, [axis]: [] }));
  };

  const performMove = async (row: EntitySummary, plan: ColumnPlan): Promise<SetStateOutcome> => {
    if (plan.drop.kind === 'refuse') return { ok: false, reason: plan.drop.reason };
    if (!stateControl) {
      return { ok: false, reason: `${kind.labelPlural} have no settable state on this build.` };
    }
    return lifecycleRef.current.setState(
      row.id,
      plan.drop.optionId,
      plan.drop.via ?? stateControl.command,
      { notify: false },
    );
  };

  const dispatchDrop = (row: EntitySummary, fromKey: string, target: ColumnPlan): void => {
    if (target.key === fromKey) return;
    setRefusal(null);
    /* A refusing column refuses BEFORE the overlay claims anything — the card
       never moves, and the reason renders where the drop happened. */
    if (target.drop.kind === 'refuse') {
      setRefusal({ column: target.key, reason: target.drop.reason });
      return;
    }
    setPendingId(row.id);
    setMoves((prior) => new Map(prior).set(row.id, { to: target.key, from: fromKey }));
    void performMove(row, target).then((outcome) => {
      setPendingId((prior) => (prior === row.id ? null : prior));
      if (!outcome.ok) {
        // Roll the overlay back and confess at the column that refused (§1.5).
        setMoves((prior) => {
          const next = new Map(prior);
          next.delete(row.id);
          return next;
        });
        setRefusal({ column: target.key, reason: outcome.reason });
      }
    });
  };

  // §8.1 — drag is never the only path: mod+arrow moves the focused card
  // through the SAME dispatch a drop uses.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey;
    const colCount = shownColumns.length;
    if (colCount === 0) return;
    const col = Math.min(focus.col, colCount - 1);
    const rows = shownOf(shownColumns[col]!);
    const row = Math.min(focus.row, Math.max(0, rows.length - 1));
    const focused = rows[row];

    const move = (delta: number): void => {
      if (!focused) return;
      const target = shownColumns[col + delta];
      if (!target) return;
      dispatchDrop(focused, shownColumns[col]!.plan.key, target.plan);
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
        if (focused) openEntity(focused.id as EntityId);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const loading = shownColumns.every((c) => c.items === undefined);
  const workflowToggleReason =
    plan.workflowUnavailable
    ?? workflows?.error
    ?? (workflow === undefined ? 'This space’s workflows have not loaded yet.' : null);

  return (
    <section
      className="b2"
      data-testid="board-v2-screen"
      /* W3E, board edition: the selected kind's palette family as registry
         DATA (never a kind name), so board.css can rail every card in the
         same colour its list tile wears. Gray is the declared fallback,
         exactly as the tile anatomies default it. */
      data-family={kind.graphFamily ?? 'gray'}
    >
      <header className="b2__bar" data-testid="b2-filters">
        {/* THE KIND SELECTOR — what makes this board universal. Radio
            semantics on the shared dropdown: choosing a kind replaces the
            previous choice. */}
        <FilterSelect
          label="Kind"
          testId="b2-kind"
          options={kindOptions}
          selected={[kind.kind]}
          onToggle={onKind}
          onClear={() => onKind('task')}
          emptyNote="This build declares no collection kinds."
        />

        {/* WORKFLOW COLUMNS toggle — offered whenever a workflow resolves;
            disabled WITH THE REASON when its states cannot be drawn exactly. */}
        {workflowToggleReason === null ? (
          <button
            type="button"
            className="b2__pivot"
            aria-pressed={plan.mode === 'workflow'}
            data-testid="b2-workflow-toggle"
            onClick={() => setUseWorkflowCols((v) => !v)}
          >
            {plan.mode === 'workflow' ? `Workflow: ${plan.workflowName}` : 'Workflow columns'}
          </button>
        ) : (
          <DisabledIconControl label="Workflow columns" reason={toReason(workflowToggleReason)}>
            <span className="b2__pivot b2__pivot--off" data-testid="b2-workflow-toggle">
              Workflow columns
            </span>
          </DisabledIconControl>
        )}

        <span className="b2__sep" aria-hidden />

        {/* The people axes exist only for kinds the registry says are
            assignable — a filter over an axis the kind cannot carry would be
            a control that always answers nothing. */}
        {assignControl ? (
          <>
            <FilterSelect
              label="Assigned to"
              testId="b2-filter-person"
              options={peopleOptions}
              selected={filters.people}
              onToggle={(id) => toggle('people', id)}
              onClear={() => clearAxis('people')}
              emptyNote={ROSTER_EMPTY}
            />
            <FilterSelect
              label="Assigned by"
              testId="b2-filter-assignedby"
              options={peopleOptions}
              selected={filters.assignedBy}
              onToggle={(id) => toggle('assignedBy', id)}
              onClear={() => clearAxis('assignedBy')}
              emptyNote={ROSTER_EMPTY}
            />
          </>
        ) : null}

        {/* ARCHIVED IS A FILTER, NEVER A COLUMN (the ruling, verbatim): the
            toggle swaps the whole board onto the archived rows, composing
            with every column rather than replacing one. */}
        <button
          type="button"
          className="b2__pivot"
          aria-pressed={filters.archived}
          data-testid="b2-filter-archived"
          onClick={() => setFilters((prior) => ({ ...prior, archived: !prior.archived }))}
        >
          Archived
        </button>

        <input
          className="b2__search"
          type="search"
          placeholder="Filter by title…"
          aria-label="Filter cards by title"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {anyFilterActive(filters) ? (
          <button
            type="button"
            className="b2__clear"
            data-testid="b2-clear-filters"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            Clear filters
          </button>
        ) : null}

        {newEntity.unavailable === null ? (
          <button
            type="button"
            className="b2__new"
            data-testid="b2-new-task"
            onClick={() => void newEntity.create()}
          >
            ＋ New {kind.label.toLowerCase()}
          </button>
        ) : (
          <DisabledIconControl label={`New ${kind.label.toLowerCase()}`} reason={newEntity.unavailable}>
            <span className="b2__new b2__new--off" data-testid="b2-new-task">
              ＋ New {kind.label.toLowerCase()}
            </span>
          </DisabledIconControl>
        )}
      </header>

      <div
        className="b2__body"
        role="application"
        aria-label={`${kind.labelPlural} board`}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {/* WHAT THE BOARD IS, said once, only when it is genuinely empty. */}
        {!loading && !anyFilterActive(filters) && search.trim() === ''
          && shownColumns.every((column) => (column.items?.length ?? 0) === 0) ? (
          <div className="b2__firstrun" data-testid="b2-firstrun">
            Every {kind.label.toLowerCase()} in this space shows up here, in a column for where
            it stands. There are none yet — use ＋ New {kind.label.toLowerCase()} above to add
            the first.
          </div>
        ) : null}
        {/* The stage publishes the column COUNT so the panel can derive one
            column's width in CSS — see `.b2__panel`. */}
        <div
          className="b2__stage"
          style={{ ['--b2-cols' as string]: String(Math.max(1, shownColumns.length)) }}
        >
          <div className="b2__cols">
            {shownColumns.map((column, index) => (
              <ColumnView
                key={column.plan.key}
                column={column}
                shown={column.items === undefined ? undefined : shownOf(column)}
                band={plan.mode === 'workflow' ? column.plan.category : null}
                focused={index === Math.min(focus.col, shownColumns.length - 1)}
                focusRow={focus.row}
                refusal={refusal?.column === column.plan.key ? refusal.reason : null}
                pendingId={pendingId}
                dragging={dragging}
                onDragStart={setDragging}
                onDrop={dispatchDrop}
                onOpen={(id) => openEntity(id as EntityId)}
              />
            ))}
          </div>
          {openId !== null ? (
            <aside className="b2__panel" aria-label="Entity details" data-testid="b2-entity-panel">
              <BoardEntityColumn
                data={data}
                reasons={reasons}
                serverBaseUrl={serverBaseUrl}
                viewerMemberId={viewerMemberId}
                onNotice={onNotice}
                rowLifecycle={lifecycle}
                entityId={openId}
                onOpenEntity={openEntity}
                onClose={() => setOpenId(null)}
              />
            </aside>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const BAND_LABELS: Readonly<Record<string, string>> = {
  to_do: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

function ColumnView({
  column,
  shown,
  band,
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
  /** The category band a workflow-state column sits under, or null. */
  band: string | null;
  focused: boolean;
  focusRow: number;
  refusal: string | null;
  pendingId: string | null;
  dragging: { row: EntitySummary; from: string } | null;
  onDragStart: (d: { row: EntitySummary; from: string } | null) => void;
  onDrop: (row: EntitySummary, fromKey: string, target: ColumnPlan) => void;
  onOpen: (id: string) => void;
}) {
  // Page-scoped counts hedge with `+` when another page exists — a bare
  // number would claim a total this screen never read.
  const count = shown === undefined ? '…' : column.hasMore ? `${shown.length}+` : `${shown.length}`;

  return (
    <section
      className={focused ? 'b2__col b2__col--focused' : 'b2__col'}
      data-testid="b2-column"
      data-column={column.plan.key}
      aria-label={column.plan.label}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData('text/plain');
        const drag = dragging && dragging.row.id === id ? dragging : null;
        onDragStart(null);
        if (drag) onDrop(drag.row, drag.from, column.plan);
      }}
    >
      <header className="b2__col-head">
        {band !== null ? (
          <span className="b2__col-band" data-testid="b2-col-band">
            {BAND_LABELS[band] ?? band}
          </span>
        ) : null}
        <Pill tone={column.plan.tone}>{column.plan.label}</Pill>
        <span className="b2__col-count">{count}</span>
      </header>

      {refusal ? (
        <p className="b2__refusal" role="alert" data-testid="b2-refusal">
          {refusal}
        </p>
      ) : null}

      <div className="b2__cards" role="list">
        {shown === undefined ? (
          <>
            <div className="b2__skeleton" aria-hidden data-testid="b2-skeleton" />
            <div className="b2__skeleton" aria-hidden />
          </>
        ) : shown.length === 0 ? (
          // §1.3: an empty column is a real answer — and (where the plan
          // allows) the drop target that makes the answer changeable.
          <p className="b2__empty">{`nothing in ${column.plan.label}`}</p>
        ) : (
          shown.map((row, index) => (
            <CardView
              key={row.id}
              row={row}
              fromKey={column.plan.key}
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

/* Priority chips follow tm8's own tone semantics (the registry dresses `high`
   in 'block') expressed through Astryx's semantic Badge palette. A word map,
   not a kind map — any kind whose state carries `priority` gets the same
   read, and an unknown word falls back to neutral rather than lying. */
const PRIORITY_BADGE: Record<string, 'error' | 'warning' | 'info' | 'neutral'> = {
  urgent: 'error',
  high: 'error',
  medium: 'info',
  low: 'neutral',
};

function CardView({
  row,
  fromKey,
  pending,
  draggingId,
  cardFocused,
  onDragStart,
  onOpen,
}: {
  row: EntitySummary;
  fromKey: string;
  pending: boolean;
  draggingId: string | null;
  cardFocused: boolean;
  onDragStart: (d: { row: EntitySummary; from: string } | null) => void;
  onOpen: (id: string) => void;
}) {
  /* Meta renders STRUCTURALLY off the summary's state — fields that exist,
     drawn; fields the kind does not carry, absent. No kind is named. */
  const state = row.state as Partial<{
    priority: string;
    dueDate: string | null;
    assignees: ActorSummary[];
    acceptance: { total: number; completed: number };
  }>;
  const cls = [
    'b2__card',
    pending ? 'b2__card--pending' : '',
    row.id === draggingId ? 'b2__card--dragging' : '',
    cardFocused ? 'b2__card--focused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      role="listitem"
      className={cls}
      data-testid="b2-card"
      data-entity={row.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', row.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart({ row, from: fromKey });
      }}
      onDragEnd={() => onDragStart(null)}
    >
      <button type="button" className="b2__card-title" onClick={() => onOpen(row.id)}>
        {row.title}
      </button>
      <div className="b2__card-meta">
        {typeof state.priority === 'string' ? (
          <Badge variant={PRIORITY_BADGE[state.priority] ?? 'neutral'} label={state.priority} />
        ) : null}
        {state.dueDate ? (
          <span
            className="b2__card-due"
            data-overdue={new Date(state.dueDate).getTime() < Date.now() || undefined}
          >
            {'due '}
            <Timestamp value={state.dueDate} format="relative_short" hasTooltip={false} />
          </span>
        ) : null}
        {state.acceptance && state.acceptance.total > 0 ? (
          <span
            className="b2__card-accept"
            title={`${state.acceptance.completed} of ${state.acceptance.total} acceptance criteria met`}
          >
            <ProgressBar
              value={state.acceptance.completed}
              max={state.acceptance.total}
              label={`Acceptance: ${state.acceptance.completed} of ${state.acceptance.total} met`}
              isLabelHidden
            />
            <span className="b2__card-accept-count">{`${state.acceptance.completed}/${state.acceptance.total}`}</span>
          </span>
        ) : null}
        {state.assignees && state.assignees.length > 0 ? <AvatarStack actors={state.assignees} /> : null}
      </div>
    </article>
  );
}
