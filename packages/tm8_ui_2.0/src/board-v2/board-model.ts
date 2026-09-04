/**
 * BOARD V2's pure model — the universal board under the Kind/Status/Category/
 * Workflow design (doc 01a01093-125d, rulings addendum 01a01410-ab57).
 *
 * WHAT CHANGED FROM V1, and why each change is the design and not taste:
 *
 *   · ANY KIND. The board is planned from a registry `KindConfig`, never from
 *     a kind name — the kind selector's population is `collectionKinds()` and
 *     every behavioural question below is answered by the config's declared
 *     controls or by the space's WORKFLOWS, so a custom kind that grows a
 *     workflow shows up here with zero board changes.
 *
 *   · COLUMNS ARE THE FOUR CATEGORIES by default. `category` is the only
 *     status concept a cross-kind surface may read (the closed union the
 *     whole program exists for), and every column is a REAL SERVER READ —
 *     `filters.category` per column, never a client-side grouping. A kind
 *     whose rows have no status yet (every kind but task until phase 5)
 *     honestly shows them in a 'No status yet' column fed by the unfiltered
 *     read, narrowed on the server-computed `summary.category` being ABSENT —
 *     the one fact the category filters structurally cannot return.
 *
 *   · WORKFLOW COLUMNS when one kind's workflow is known and every state is
 *     EXACTLY queryable (see `planFor`): states become columns, grouped under
 *     category bands. A state the reads cannot isolate exactly downgrades the
 *     whole board to category columns — approximating a column would draw
 *     cards in states they are not in.
 *
 *   · ARCHIVED IS A FILTER, NEVER A COLUMN (owner ruling): the toggle rides
 *     `filters.deleted`, orthogonal to every column.
 *
 *   · DROPS RESOLVE THROUGH A SEAM (`dropPlanFor`), not a matrix: the target
 *     state comes from the kind's workflow (default state of the category),
 *     falling back to the transitional category-default map only where the
 *     workflow names no settable state — and where neither answers, the drop
 *     REFUSES WITH THE REASON instead of no-opping. Transition LEGALITY stays
 *     server-side (the 149 trigger + ruled category defaults); this seam only
 *     picks the target, and a server refusal is rendered inline exactly as v1
 *     rendered one.
 *
 * The optimistic overlay survives from v1 with one honesty upgrade: a move now
 * remembers where the card CAME FROM, so a write the server accepted but
 * landed elsewhere (a trigger derived a different category than the client
 * expected) settles to the server's answer instead of pinning the card where
 * it was dropped forever.
 */
import type { EntitySummary, StatusCategory, Workflow, WorkflowState } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type { ActionRef, KindConfig, QueryFilter } from '../domain';
import { CATEGORY_DEFAULT_STATUS, getKind } from '../domain';
import { homeRowOf, liveKinds, type HomeDot } from '../home/home-model';
import type { PillTone } from '../kit';

// ---------------------------------------------------------------------------
// The category vocabulary — the closed four, in reading order
// ---------------------------------------------------------------------------

export interface CategorySpec {
  key: StatusCategory;
  label: string;
  tone: PillTone;
}

/** The closed union in its ruled reading order. Labels match the global
 * default workflow's display-named states (migration 149's seed). */
export const CATEGORY_SPECS: readonly CategorySpec[] = [
  { key: 'to_do', label: 'To Do', tone: 'idle' },
  { key: 'in_progress', label: 'In Progress', tone: 'run' },
  { key: 'done', label: 'Done', tone: 'run' },
  { key: 'cancelled', label: 'Cancelled', tone: 'idle' },
];

const CATEGORY_SPEC_OF = new Map(CATEGORY_SPECS.map((s) => [s.key, s] as const));

/** The 'No status yet' column's key — a column, never a category. */
export const UNCATEGORISED_KEY = 'uncategorised';

// ---------------------------------------------------------------------------
// Workflow resolution
// ---------------------------------------------------------------------------

/**
 * Which workflow governs this kind's board, until `entity_kinds.workflow_id`
 * (phase 5) makes the answer a column: the space workflow bound to this kind
 * when there is EXACTLY one — several (the migrated per-type-value task
 * workflows) means no single set of columns is "the" workflow, so the board
 * stays on category columns rather than picking a favourite — else the ONE
 * global default (kind null). `undefined` only while the list has not loaded.
 */
export function resolveWorkflow(
  kind: KindConfig,
  workflows: readonly Workflow[] | undefined,
): Workflow | undefined {
  if (workflows === undefined) return undefined;
  const own = workflows.filter((w) => w.kind === kind.kind);
  if (own.length === 1) return own[0];
  if (own.length === 0) return workflows.find((w) => w.kind === null);
  return workflows.find((w) => w.kind === null);
}

// ---------------------------------------------------------------------------
// The board plan — columns as (spec, server filter, drop seam)
// ---------------------------------------------------------------------------

/** What dropping a card on this column DOES — resolved at plan time so a
 * column that cannot accept a drop says so before anything is dragged. */
export type DropPlan =
  | { kind: 'set-state'; optionId: string; via?: ActionRef }
  | { kind: 'refuse'; reason: string };

export interface ColumnPlan {
  key: string;
  label: string;
  tone: PillTone;
  /** The band the column renders under; the uncategorised column has none. */
  category: StatusCategory | null;
  /**
   * The read that fills the column, MERGED over the board's base filters —
   * `null` marks the uncategorised column, whose rows come from the base
   * (unfiltered-by-status) read narrowed to `summary.category` ABSENT.
   */
  filter: QueryFilter | null;
  drop: DropPlan;
}

export interface BoardPlan {
  mode: 'category' | 'workflow';
  /** Names the workflow whose states are the columns (workflow mode only). */
  workflowName: string | null;
  /** Why workflow columns are unavailable, when a workflow exists but cannot
   * be drawn exactly — surfaced beside the mode toggle, never silent. */
  workflowUnavailable: string | null;
  columns: ColumnPlan[];
}

/** Default-first within a category: `isDefault`, then lowest position — the
 * ruled tiebreak (contract `WorkflowState.isDefault`). */
function defaultFirst(states: readonly WorkflowState[]): WorkflowState[] {
  return [...states].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.position - b.position,
  );
}

/**
 * The drop seam for a CATEGORY column: the state a card should land on when
 * dropped there, expressed strictly through the kind's own settable options.
 *
 *   1. The workflow's default state of that category, when its name is a
 *      settable option — migrated task workflows name states BY the status
 *      literals (149's join key), so this is the normal task path.
 *   2. The TRANSITIONAL category-default option (`CATEGORY_DEFAULT_STATUS`,
 *      domain/) — for a space whose kinds resolve to the display-named global
 *      default workflow, whose state names are nobody's vocabulary. Dies with
 *      phase 5, which re-keys writes to status ids.
 *   3. Neither ⇒ an honest refusal naming the kind and the reason.
 */
export function categoryDropFor(
  kind: KindConfig,
  workflow: Workflow | undefined,
  category: StatusCategory,
): DropPlan {
  const control = kind.list.stateControl;
  if (!control) {
    return {
      kind: 'refuse',
      // PHASE 5 (migration 152) made the first half of this true: every kind
      // HAS a status now. What is still missing is a settable CONTROL for it —
      // `stateControl` is wired for task and work_session only, and wiring the
      // rest is phase 7's, along with the four tabs. The refusal is narrowed to
      // say that rather than to promise a phase that has already shipped.
      reason: `${kind.labelPlural} have a status but no settable control yet — moving one by hand arrives with the four-tab phase. Nothing moved.`,
    };
  }
  const options = new Map(control.options.map((o) => [o.id, o] as const));
  for (const state of defaultFirst((workflow?.states ?? []).filter((s) => s.category === category))) {
    const option = options.get(state.name);
    if (option) return { kind: 'set-state', optionId: option.id, ...(option.via ? { via: option.via } : {}) };
  }
  const fallback = CATEGORY_DEFAULT_STATUS[category];
  const option = fallback ? options.get(fallback) : undefined;
  if (option) return { kind: 'set-state', optionId: option.id, ...(option.via ? { via: option.via } : {}) };
  return {
    kind: 'refuse',
    reason: `No settable ${kind.label.toLowerCase()} state maps to ${CATEGORY_SPEC_OF.get(category)?.label ?? category} in this space's workflow. Nothing moved.`,
  };
}

/**
 * Build the board plan for one kind.
 *
 * `useWorkflow` asks for state columns; they are granted only when EVERY state
 * of the resolved workflow is exactly queryable —
 *   · by the kind's own status axis (`state.name` is a settable option of the
 *     kind's state control, read via the matching server filter), or
 *   · by category, when the state is its category's ONLY member (the global
 *     default workflow's shape — the category read IS the state read).
 * One inexact state downgrades the whole board with the reason recorded,
 * because a board that draws six exact columns and one approximate one is
 * indistinguishable from a correct board until it lies.
 */
export function planFor(
  kind: KindConfig,
  workflow: Workflow | undefined,
  useWorkflow: boolean,
): BoardPlan {
  const control = kind.list.stateControl;
  /* The status-axis filter key this kind's states are exactly readable by —
     REGISTRY DATA (`stateControl.filterKey`), not a table keyed on
     `stateControl.source`. Phase 9 collapsed `source` to the single member
     `status` for every kind, so the old table's two rows became one key twice
     and a session's board would have asked for a task's filter. */
  const sourceKey = control?.filterKey;
  const optionIds = new Set((control?.options ?? []).map((o) => o.id));

  if (useWorkflow && workflow) {
    const columns: ColumnPlan[] = [];
    let unavailable: string | null = null;
    const ordered = [...workflow.states].sort(
      (a, b) =>
        CATEGORY_SPECS.findIndex((c) => c.key === a.category)
          - CATEGORY_SPECS.findIndex((c) => c.key === b.category)
        || a.position - b.position,
    );
    for (const state of ordered) {
      const spec = CATEGORY_SPEC_OF.get(state.category);
      const soleOfCategory = workflow.states.filter((s) => s.category === state.category).length === 1;
      const filter: QueryFilter | null =
        sourceKey && optionIds.has(state.name)
          ? ({ [sourceKey]: [state.name] } as QueryFilter)
          : soleOfCategory
            ? { category: [state.category] }
            : null;
      if (filter === null) {
        unavailable = `State “${state.name}” cannot be read exactly for ${kind.labelPlural.toLowerCase()} yet (no status axis names it), so columns stay categories.`;
        break;
      }
      const drop: DropPlan = optionIds.has(state.name)
        ? {
            kind: 'set-state',
            optionId: state.name,
            ...(control!.options.find((o) => o.id === state.name)?.via
              ? { via: control!.options.find((o) => o.id === state.name)!.via }
              : {}),
          }
        : soleOfCategory
          ? categoryDropFor(kind, workflow, state.category)
          : {
              kind: 'refuse',
              reason: `“${state.name}” is not a settable ${kind.label.toLowerCase()} state on this build. Nothing moved.`,
            };
      columns.push({
        key: state.id,
        label: state.name,
        tone: spec?.tone ?? 'idle',
        category: state.category,
        filter,
        drop,
      });
    }
    if (unavailable === null && columns.length > 0) {
      return { mode: 'workflow', workflowName: workflow.name, workflowUnavailable: null, columns };
    }
    return {
      ...categoryPlan(kind, workflow),
      workflowUnavailable:
        unavailable ?? 'This workflow declares no states, so columns stay categories.',
    };
  }

  return categoryPlan(kind, workflow);
}

function categoryPlan(kind: KindConfig, workflow: Workflow | undefined): BoardPlan {
  const columns: ColumnPlan[] = CATEGORY_SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    tone: spec.tone,
    category: spec.key,
    filter: { category: [spec.key] },
    drop: categoryDropFor(kind, workflow, spec.key),
  }));
  columns.push({
    key: UNCATEGORISED_KEY,
    label: 'No status yet',
    tone: 'wait',
    category: null,
    filter: null,
    drop: {
      kind: 'refuse',
      reason: '“No status yet” is the absence of a status, not a state — nothing can be moved into it.',
    },
  });
  return { mode: 'category', workflowName: null, workflowUnavailable: null, columns };
}

// ---------------------------------------------------------------------------
// Base filters (the axes that compose with every column)
// ---------------------------------------------------------------------------

export interface BoardFilterState {
  /** Actor ENTITY ids — `assigneeIds`, members and teammates alike. */
  people: readonly string[];
  /** Actor ids whose PERFORMED assignments select a row — `assignedByIds`. */
  assignedBy: readonly string[];
  /** THE RULING: archived is a filter, never a column. `filters.deleted`. */
  archived: boolean;
  /**
   * LIVE-WORK signals pressed. Deliberately NOT a wire filter — see
   * `liveNarrow`: there is no `filters.live` on `CollectionQuery`, and the
   * only authority for liveness is the seam's per-id verdict, which no
   * server-side collection predicate consults. This narrows the page the
   * board already read, exactly as `matching()` does for the search box, and
   * the strip says so.
   */
  live: readonly LiveSignalId[];
}

export const EMPTY_FILTERS: BoardFilterState = {
  people: [],
  assignedBy: [],
  archived: false,
  live: [],
};

export function anyFilterActive(f: BoardFilterState): boolean {
  return f.people.length > 0 || f.assignedBy.length > 0 || f.archived || f.live.length > 0;
}

/**
 * The base `CollectionQuery.filters` the whole board shares; each column
 * merges its own status/category clause on top (`columnFilter`). Empty axes
 * are OMITTED (`narrow()`'s law — an empty array is no constraint, and
 * sending one misreads "no chips pressed").
 */
export function buildFilters(f: BoardFilterState): QueryFilter | undefined {
  const out: QueryFilter = {};
  if (f.people.length > 0) out.assigneeIds = [...f.people] as NonNullable<QueryFilter['assigneeIds']>;
  if (f.assignedBy.length > 0) out.assignedByIds = [...f.assignedBy] as NonNullable<QueryFilter['assignedByIds']>;
  if (f.archived) out.deleted = 'only';
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One column's real read: the base filters plus the column's own clause. */
export function columnFilter(
  base: QueryFilter | undefined,
  column: ColumnPlan,
): QueryFilter | undefined {
  if (column.filter === null) return base;
  return { ...(base ?? {}), ...column.filter };
}

/** The uncategorised narrowing: the server-computed fact, ABSENT. */
export function uncategorised(rows: readonly EntitySummary[]): EntitySummary[] {
  return rows.filter((r) => r.category === undefined);
}

// ---------------------------------------------------------------------------
// Columns as data + the optimistic overlay
// ---------------------------------------------------------------------------

export interface BoardColumn {
  plan: ColumnPlan;
  /** `undefined` ⇒ that column's read is still in flight (skeletons). */
  items: readonly EntitySummary[] | undefined;
  /** Another page exists beyond these rows — the header hedges with `+`. */
  hasMore: boolean;
}

/** A move remembers BOTH endpoints so a write the server landed somewhere
 * else can settle to the truth instead of pinning the optimistic claim. */
export interface Move {
  to: string;
  from: string;
}

/**
 * The optimistic overlay, v1 semantics with `Move` endpoints: a dropped card
 * renders at the head of its target column and leaves every other column
 * until the next real read settles or the write's refusal rolls it back.
 */
export function applyMoves(
  columns: readonly BoardColumn[],
  moves: ReadonlyMap<string, Move>,
): BoardColumn[] {
  if (moves.size === 0) return [...columns];
  const carried = new Map<string, EntitySummary>();
  for (const col of columns) {
    for (const item of col.items ?? []) {
      const move = moves.get(item.id);
      if (move !== undefined && move.to !== col.plan.key) carried.set(item.id, item);
    }
  }
  return columns.map((col) => {
    if (col.items === undefined) return col;
    const kept = col.items.filter((i) => {
      const move = moves.get(i.id);
      return move === undefined || move.to === col.plan.key;
    });
    const gained = [...carried.values()].filter(
      (i) => moves.get(i.id)?.to === col.plan.key && !kept.some((k) => k.id === i.id),
    );
    return { ...col, items: [...gained, ...kept] };
  });
}

/**
 * Moves the fresh read has answered — called with the RAW columns. A move
 * settles when the card shows up in its TARGET column (the server agrees), or
 * in any column that is neither endpoint (the server accepted the write but
 * derived a different landing — render the truth). Still in the SOURCE column
 * ⇒ the write has not landed yet; keep claiming.
 */
export function settledMoves(
  columns: readonly BoardColumn[],
  moves: ReadonlyMap<string, Move>,
): string[] {
  const settled: string[] = [];
  for (const [id, move] of moves) {
    for (const col of columns) {
      if (!(col.items ?? []).some((i) => i.id === id)) continue;
      if (col.plan.key === move.to || col.plan.key !== move.from) {
        settled.push(id);
        break;
      }
    }
  }
  return settled;
}

/** Client-side title narrowing for the search box — display-only, page-scoped. */
export function matching(items: readonly EntitySummary[], query: string): readonly EntitySummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.title.toLowerCase().includes(q));
}

// ===========================================================================
// THE TWO VIEWS
// ===========================================================================

/**
 * Owner, 2026-08-31: "when you click on board there must be nice dashboard and
 * workflow columns I don't see much use case, also create project timeline
 * board".
 *
 * A VIEW, NOT A ROUTE. Columns and Timeline answer the same question of the
 * same rows — "where does this work stand" — in two shapes, so switching must
 * not cost the kind, the filters, the search or the open panel. That is the
 * same reason a card opens the panel here instead of navigating (see the
 * screen's docblock), applied one level up.
 *
 * COLUMNS STAYS THE DEFAULT. It is what the board has always been; a new view
 * earns its place by being chosen, not by being imposed on every reader.
 */
export type BoardView = 'columns' | 'timeline';

export const BOARD_VIEWS: readonly { id: BoardView; label: string }[] = [
  { id: 'columns', label: 'Columns' },
  { id: 'timeline', label: 'Timeline' },
];

// ===========================================================================
// LIVE — ONE DEFINITION, BORROWED RATHER THAN RE-INVENTED
// ===========================================================================

/**
 * WHERE "LIVE" COMES FROM, and why this file computes none of it.
 *
 * Home settled this: a row is live when the dot it draws is `pulse` or
 * `solid` (`home-model.ts`, `composeMyWork` → `liveCount`). That dot is not a
 * field — `homeRowOf` builds it from the seam's liveness VERDICT run through
 * the kind's registry `liveTreatment`, so `unknown` and `stale` can never
 * reach it and a record that merely CLAIMS running is not enough (D39/R-UI-5).
 *
 * This module therefore imports `homeRowOf` and restates the predicate as one
 * exported function (`isLiveDot`) rather than writing a second one. If Home's
 * definition of live ever moves, the board moves with it — which is the whole
 * point, because a board that disagrees with Home about what is running is
 * worse than a board with no live filter at all.
 *
 * NOTHING HERE READS A STATUS FIELD. `state.status` says what the record
 * claims; the verdict says what the node can see. They disagree routinely
 * (that disagreement is the entire reason `stale` exists) and only the second
 * one may be called live.
 */
export interface LiveContext {
  /** THE verdict function — `GateData.livenessOf`. Never re-derived. */
  livenessOf: (id: string) => SessionLiveness;
  /** §9.2 pool byte-activity. Can only REFINE a live verdict, never promote. */
  activity: Readonly<Record<string, boolean>>;
}

/** Home's predicate, in one place, so there is exactly one of it. */
export function isLiveDot(dot: HomeDot): boolean {
  return dot === 'pulse' || dot === 'solid';
}

/**
 * A bare session id, projected through the SAME function Home projects rows
 * with. The board holds `via.sessionId` (below) without holding the session's
 * summary — the id is all a `working_on` edge carries — and `homeRowOf` needs
 * a row. This builds the minimum one: only `kind` matters, because a kind with
 * a `liveTreatment` takes the treatment branch and never looks at `state`.
 *
 * WHICH KIND IS REGISTRY DATA, NOT A LITERAL (§15.2). "The kinds a liveness
 * verdict governs" is exactly `liveKinds()` — the same call `composeMyWork`
 * makes for its live-count label — and every one of them is asked, so a second
 * kind gaining a `liveTreatment` is answered here with no edit.
 */
function liveById(id: string, ctx: LiveContext): boolean {
  return liveKinds().some((config) =>
    isLiveDot(
      homeRowOf(
        { id, kind: config.kind, title: '', state: {}, badges: {} } as unknown as EntitySummary,
        { liveness: ctx.livenessOf(id), streaming: ctx.activity[id] === true },
      ).dot,
    ),
  );
}

/**
 * WHAT KIND OF LIVE a chip asks about. Two, and each one is offered only where
 * the REGISTRY says the selected kind can answer it:
 *
 *   · `verdict`   — this row IS a run. Offered when the kind declares a
 *                   `liveTreatment`, which is the registry's statement that
 *                   the seam's verdict governs its presentation. On the
 *                   session board this is "live sessions" — and, because a
 *                   chat in tm8 IS a work_session, it is also "live chats".
 *   · `worked-on` — something live is running ON this row. Offered when the
 *                   kind's tile declares a `workingActors` badge, i.e. the
 *                   node projects `working_on` edges onto its summaries. On
 *                   the task board this is "live tasks".
 *
 * `worked-on` is NOT "has a working_on edge". The edge is a claim by the row;
 * the verdict is what the node can see. Each edge's actor carries
 * `via.sessionId` (contract `ActorSummary.via`, "the run it acted through"),
 * and the chip asks THAT id the same question `verdict` asks — so a task whose
 * session died is not live, which is the whole distinction `stale` exists for.
 */
export type LiveSignalId = 'verdict' | 'worked-on';

export interface LiveSignalSpec {
  id: LiveSignalId;
  /** Chip copy. Derived from the kind's own plural — never a kind name here. */
  label: string;
  /** What the chip actually asks the data, for the menu and the strip. */
  describe: string;
}

/** Which live chips this kind can honestly offer. Empty ⇒ the axis is not drawn. */
export function liveSignalsFor(kind: KindConfig): LiveSignalSpec[] {
  const out: LiveSignalSpec[] = [];
  const plural = kind.labelPlural.toLowerCase();
  if (kind.list.liveTreatment) {
    out.push({
      id: 'verdict',
      label: `Live ${plural}`,
      describe: `${kind.labelPlural} the node can currently see running — the seam's liveness verdict, not the record's claim.`,
    });
  }
  if (kind.list.tile.badges.some((badge) => badge.source === 'workingActors')) {
    out.push({
      id: 'worked-on',
      label: `Live work`,
      describe: `${kind.labelPlural} a session is running on right now — the working_on actor's session, asked the same liveness question.`,
    });
  }
  return out;
}

/** Does this row answer this one signal? */
export function isLiveBy(signal: LiveSignalId, row: EntitySummary, ctx: LiveContext): boolean {
  if (signal === 'verdict') {
    if (!getKind(row.kind).list.liveTreatment) return false;
    return isLiveDot(
      homeRowOf(row, {
        liveness: ctx.livenessOf(row.id),
        streaming: ctx.activity[row.id] === true,
      }).dot,
    );
  }
  return (row.badges?.workingActors ?? []).some((work) => {
    const sessionId = work.actor?.via?.sessionId;
    return typeof sessionId === 'string' && liveById(sessionId, ctx);
  });
}

/**
 * Live by ANY of the signals asked about. Called with the EMPTY list this
 * answers false, which is why `liveNarrow` short-circuits instead: "no chip
 * pressed" is no constraint, never "nothing is live".
 */
export function isLive(
  row: EntitySummary,
  signals: readonly LiveSignalId[],
  ctx: LiveContext,
): boolean {
  return signals.some((signal) => isLiveBy(signal, row, ctx));
}

/** Page-scoped live narrowing, the sibling of `matching()`. */
export function liveNarrow(
  items: readonly EntitySummary[],
  signals: readonly LiveSignalId[],
  ctx: LiveContext,
): readonly EntitySummary[] {
  if (signals.length === 0) return items;
  return items.filter((row) => isLive(row, signals, ctx));
}

// ===========================================================================
// DAYS — the one clock the axis and the bars share
// ===========================================================================

/**
 * THE TIMEZONE RULING, stated because getting it wrong shifts every bar by a
 * column for half the planet.
 *
 * A task's `startDate`/`dueDate` are DATE-ONLY strings on the wire
 * (`YYYY-MM-DD`, contract `CoreEntityState` task arm). A date-only string has
 * no instant and no zone: "2026-07-30" is the thirtieth, and `new Date(
 * '2026-07-30')` is midnight UTC, which in any negative offset is the
 * TWENTY-NINTH locally. Rendering that through `getDate()` draws the bar one
 * day early for every reader west of Greenwich, silently, forever.
 *
 * So: a date-only string is taken VERBATIM and never becomes a `Date`. An
 * instant (anything with a time) is projected with `toISOString()`, i.e. UTC.
 * Day arithmetic is `Date.UTC` + whole days, which no DST transition can
 * perturb. Nothing in this section calls a local-time getter, and that is the
 * invariant `board-model.test.ts` pins with an explicit boundary case.
 *
 * `todayKey()` is UTC for the same reason — one clock for the axis and the
 * bars, since mixing a local "today" with UTC day keys puts the today marker
 * in a column that does not belong to it. Every function below takes `today`
 * as an ARGUMENT rather than reading the clock, so a later ruling that the
 * marker should follow the viewer's zone is one call site, not a sweep.
 */
export type DayKey = string;

const DAY_MS = 86_400_000;
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` for a wire date, or null when there is nothing to read. */
export function dayKeyOf(value: string | null | undefined): DayKey | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const match = DAY_ONLY.exec(trimmed);
  // The leading ten characters ARE the day, whatever follows them. Verbatim.
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/** Today, in UTC. Injectable so a test never depends on when it runs. */
export function todayKey(now: number = Date.now()): DayKey {
  return new Date(now).toISOString().slice(0, 10);
}

function utcOf(day: DayKey): number {
  const match = DAY_ONLY.exec(day);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function addDays(day: DayKey, delta: number): DayKey {
  return new Date(utcOf(day) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
}

/** `YYYY-MM-DD` sorts correctly as a string; this exists to say so out loud. */
export function compareDays(a: DayKey, b: DayKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 0 = Sunday, 1 = Monday … — UTC, like everything else here. */
export function weekdayOf(day: DayKey): number {
  return new Date(utcOf(day)).getUTCDay();
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export function monthLabelOf(day: DayKey): string {
  const match = DAY_ONLY.exec(day);
  if (!match) return day;
  return `${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

// ===========================================================================
// THE SPAN — and the one thing this whole view must not get wrong
// ===========================================================================

/**
 * Owner, 2026-08-31: "some tasks might not have a start and end date make it
 * one week by default so it doesn't become issue".
 *
 * THE DEFAULT WEEK IS A GUESS AND THE MODEL SAYS SO IN ITS TYPE. `TaskSpan`
 * carries the range and, inseparably, what was actually STATED — so a caller
 * cannot take the dates and lose the provenance. There is no overload that
 * returns a bare range; the only way to draw a bar is to hold the reason it
 * exists. That is deliberate: a guess rendered identically to a fact is the
 * one failure this view could ship that nobody would ever notice.
 *
 * `stated` is the fact; `inferred` is the consequence, kept as its own field
 * because it is what the pixels branch on and a boolean the renderer derives
 * is a boolean the renderer can derive wrongly.
 */
export const DEFAULT_SPAN_DAYS = 7;

export type SpanStated = 'both' | 'start' | 'end' | 'none';

export interface TaskSpan {
  startDay: DayKey;
  endDay: DayKey;
  /** WHICH ENDPOINTS THE RECORD CARRIED. `none` is the defaulted week. */
  stated: SpanStated;
  /** At least one endpoint was DRAWN rather than read. Never true for `both`. */
  inferred: boolean;
  /**
   * The record named an end BEFORE its start. Flagged, never silently fixed:
   * the bar spans the two dates the record actually carries, and says that
   * the record contradicts itself rather than quietly choosing a winner.
   */
  contradictory: boolean;
  /**
   * The sentence the bar carries — tooltip AND accessible name, so the
   * distinction survives for a reader who cannot see a dashed edge. Null only
   * when both dates were stated and agree; every other case says what it is.
   */
  note: string | null;
}

/**
 * Read a row's dates STRUCTURALLY off its state — the fields that exist are
 * used, the ones the kind does not carry are absent, and no kind is named
 * (the same rule `CardView` follows for `dueDate` today).
 */
export function spanOf(
  state: unknown,
  today: DayKey,
  spanDays: number = DEFAULT_SPAN_DAYS,
): TaskSpan {
  const bag = state as Partial<{ startDate: string | null; dueDate: string | null }> | null;
  const start = dayKeyOf(bag?.startDate);
  const end = dayKeyOf(bag?.dueDate);
  const width = Math.max(1, Math.trunc(spanDays)) - 1;

  if (start !== null && end !== null) {
    if (compareDays(end, start) < 0) {
      return {
        startDay: end,
        endDay: start,
        stated: 'both',
        inferred: false,
        contradictory: true,
        note: `Both dates are set, but the due date (${end}) is before the start date (${start}). The bar spans the two dates as recorded; nothing has been corrected.`,
      };
    }
    return { startDay: start, endDay: end, stated: 'both', inferred: false, contradictory: false, note: null };
  }

  if (start !== null) {
    return {
      startDay: start,
      endDay: addDays(start, width),
      stated: 'start',
      inferred: true,
      contradictory: false,
      note: `No end date set; showing a default ${spanDays}-day week from the start date (${start}).`,
    };
  }

  if (end !== null) {
    return {
      startDay: addDays(end, -width),
      endDay: end,
      stated: 'end',
      inferred: true,
      contradictory: false,
      note: `No start date set; showing a default ${spanDays}-day week ending on the due date (${end}).`,
    };
  }

  return {
    startDay: today,
    endDay: addDays(today, width),
    stated: 'none',
    inferred: true,
    contradictory: false,
    note: `No dates set; showing a default ${spanDays}-day week from today.`,
  };
}

// ===========================================================================
// THE AXIS
// ===========================================================================

/** Never fewer than three weeks — a one-bar board still reads as a calendar. */
export const MIN_AXIS_DAYS = 21;
/**
 * Never more than half a year of columns. A task dated two years out would
 * otherwise mint 700 DOM cells per row; the window stops and the view SAYS how
 * many rows reach past it, rather than clipping them into invisibility.
 */
export const MAX_AXIS_DAYS = 182;

export interface AxisDay {
  key: DayKey;
  /** 1–31, the number the header prints. */
  dayOfMonth: number;
  weekday: number;
  isToday: boolean;
  /** Monday — where the week rules and the month label may break. */
  isWeekStart: boolean;
  isWeekend: boolean;
  /** Non-null on the window's first day and on every 1st of a month. */
  monthLabel: string | null;
}

export interface TimelineAxis {
  days: readonly AxisDay[];
  /** -1 when today falls outside the window, so the marker is simply absent. */
  todayIndex: number;
  /** Spans that reach past an edge of the window — stated, never hidden. */
  truncated: { before: number; after: number };
}

/**
 * The dated axis: whole days, Monday-aligned, covering every span the board
 * drew plus today.
 *
 * MONDAY ALIGNMENT is what makes 200 rows scannable — the week rules land in
 * the same columns on every row, so a bar's length is read against a grid
 * rather than counted. Weekends are marked (not removed): work does happen on
 * them, and dropping the columns would make a 7-day bar 5 cells long.
 */
export function axisFor(
  spans: readonly TaskSpan[],
  today: DayKey,
  limits: { min?: number; max?: number } = {},
): TimelineAxis {
  const min = limits.min ?? MIN_AXIS_DAYS;
  const max = limits.max ?? MAX_AXIS_DAYS;

  let first = today;
  let last = today;
  for (const span of spans) {
    if (compareDays(span.startDay, first) < 0) first = span.startDay;
    if (compareDays(span.endDay, last) > 0) last = span.endDay;
  }

  // Back to Monday. `(weekday + 6) % 7` is days since Monday with Sunday = 6.
  first = addDays(first, -((weekdayOf(first) + 6) % 7));
  // Forward to Sunday, then out to the floor, then in to the ceiling.
  last = addDays(last, 6 - ((weekdayOf(last) + 6) % 7));
  let count = daysBetween(first, last) + 1;
  if (count < min) count = Math.ceil(min / 7) * 7;
  if (count > max) {
    count = max;
    /* TODAY IS THE ONE DAY THE WINDOW MAY NOT LOSE. Capping by trimming the
       tail is right while today still fits; when one very old row would drag
       the window's start six months back, trimming the tail throws away the
       present, and a timeline with no today on it cannot be read at all. In
       that case the window SLIDES to end on the Sunday of today's week, and
       the rows now off the left edge are counted in `truncated.before` — the
       same confession, at the other end. */
    if (compareDays(today, addDays(first, count - 1)) > 0) {
      first = addDays(addDays(today, 6 - ((weekdayOf(today) + 6) % 7)), -(count - 1));
    }
  }
  const windowEnd = addDays(first, count - 1);

  const days: AxisDay[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = addDays(first, i);
    const dayOfMonth = Number(key.slice(8, 10));
    const weekday = weekdayOf(key);
    days.push({
      key,
      dayOfMonth,
      weekday,
      isToday: key === today,
      isWeekStart: weekday === 1,
      isWeekend: weekday === 0 || weekday === 6,
      monthLabel: i === 0 || dayOfMonth === 1 ? monthLabelOf(key) : null,
    });
  }

  return {
    days,
    todayIndex: days.findIndex((day) => day.isToday),
    truncated: {
      before: spans.filter((span) => compareDays(span.startDay, first) < 0).length,
      after: spans.filter((span) => compareDays(span.endDay, windowEnd) > 0).length,
    },
  };
}

export interface BarGeometry {
  /** 0-based index into `axis.days` where the bar begins. */
  startIndex: number;
  /** How many day columns it covers. Always >= 1. */
  dayCount: number;
  /** The real span reaches past this edge of the window. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** Where one span sits on one axis, or null when it is wholly outside it. */
export function barIn(span: TaskSpan, axis: TimelineAxis): BarGeometry | null {
  const days = axis.days;
  if (days.length === 0) return null;
  const first = days[0]!.key;
  const last = days[days.length - 1]!.key;
  if (compareDays(span.endDay, first) < 0 || compareDays(span.startDay, last) > 0) return null;
  const clippedStart = compareDays(span.startDay, first) < 0;
  const clippedEnd = compareDays(span.endDay, last) > 0;
  const startIndex = clippedStart ? 0 : daysBetween(first, span.startDay);
  const endIndex = clippedEnd ? days.length - 1 : daysBetween(first, span.endDay);
  return { startIndex, dayCount: Math.max(1, endIndex - startIndex + 1), clippedStart, clippedEnd };
}

// ===========================================================================
// TONES — colour that reinforces the word, never replaces it
// ===========================================================================

/**
 * THE BAR PALETTE. Four categories, four of the shared status ramps
 * (`--pn-run` / `--pn-wait` / `--pn-info` / `--pn-block`), plus `none` for a
 * row whose category the server did not send.
 *
 * WHY THIS IS NOT `CategorySpec.tone`. A pill's tone is chosen to sit quietly
 * BESIDE a word: `CATEGORY_SPECS` gives To Do and Cancelled the same `idle`,
 * and In Progress and Done the same `run`, which is right for a pill and
 * useless for a bar — half the board would be one colour and the other half
 * another, and the colour would carry no information the word does not. A bar
 * is read at a distance, in a wall of other bars, so its four values must be
 * four values. Two maps, two jobs, both named for what they are.
 *
 * COLOUR NEVER STANDS ALONE. Every bar keeps its category WORD, and `none` has
 * no status colour at all rather than borrowing one — an entity with no
 * category is not "to do", and painting it as though it were is exactly the
 * fabrication the four-category rule exists to prevent.
 *
 * The token itself lives in `board-timeline.css`, keyed on this value: the
 * mapping category → tone is testable here, the mapping tone → token is
 * testable as CSS source, and neither is a hex.
 */
export type TimelineTone = 'run' | 'wait' | 'info' | 'block' | 'none';

export const TIMELINE_TONES: Readonly<Record<StatusCategory, TimelineTone>> = {
  // Waiting to be picked up.
  to_do: 'wait',
  // Running now — the same green every live thing in this app wears.
  in_progress: 'run',
  // Settled; a record rather than a demand.
  done: 'info',
  // Stopped.
  cancelled: 'block',
};

export function timelineTone(category: StatusCategory | null | undefined): TimelineTone {
  return category ? (TIMELINE_TONES[category] ?? 'none') : 'none';
}

// ===========================================================================
// ROWS AND GROUPS
// ===========================================================================

export interface TimelineRow {
  row: EntitySummary;
  span: TaskSpan;
  /** The column's own status word — the label the bar carries. */
  word: string;
}

export interface TimelineGroup {
  key: string;
  label: string;
  tone: TimelineTone;
  rows: readonly TimelineRow[];
  /** The column's read has another page; the group count hedges with `+`. */
  hasMore: boolean;
}

/**
 * ONE GROUP PER COLUMN, in the board's own order, and that is the whole
 * justification for how this reads at 200 rows.
 *
 * The alternative — one flat list sorted by date — makes a 200-row wall in
 * which the only way to find "what is blocked" is to read every label. Reusing
 * the columns means the Timeline and the Columns view group identically, so
 * switching views re-shapes the same answer instead of asking a new question;
 * it also means workflow columns come for free (in workflow mode the groups
 * are the states, banded exactly as the columns are), and the 'No status yet'
 * column keeps its honest separateness instead of being folded into a
 * category it is not in.
 *
 * WITHIN A GROUP: earliest start first, then earliest end, then title. Bars
 * then stair-step down the group, which is the shape that lets an eye follow a
 * sequence. Rows with NO stated dates sort LAST — they are the least
 * informative rows in the group and they are the ones whose position on the
 * axis is a default rather than a fact, so they must not lead it.
 */
export function timelineGroups(
  columns: readonly { plan: ColumnPlan; items: readonly EntitySummary[] | undefined; hasMore: boolean }[],
  shown: readonly (readonly EntitySummary[])[],
  today: DayKey,
  spanDays: number = DEFAULT_SPAN_DAYS,
): TimelineGroup[] {
  return columns.map((column, index) => {
    const rows: TimelineRow[] = (shown[index] ?? []).map((row) => ({
      row,
      span: spanOf(row.state, today, spanDays),
      word: column.plan.label,
    }));
    rows.sort((a, b) => {
      const aDefaulted = a.span.stated === 'none' ? 1 : 0;
      const bDefaulted = b.span.stated === 'none' ? 1 : 0;
      return (
        aDefaulted - bDefaulted
        || compareDays(a.span.startDay, b.span.startDay)
        || compareDays(a.span.endDay, b.span.endDay)
        || a.row.title.localeCompare(b.row.title)
      );
    });
    return {
      key: column.plan.key,
      label: column.plan.label,
      tone: timelineTone(column.plan.category),
      rows,
      hasMore: column.hasMore,
    };
  });
}

// ===========================================================================
// THE STRIP — "a nice dashboard", and every number a real read
// ===========================================================================

export interface BoardSummaryLine {
  key: string;
  label: string;
  tone: TimelineTone;
  count: number;
}

export interface BoardSummary {
  /** Rows the board is actually drawing, after every filter and the search. */
  total: number;
  lines: readonly BoardSummaryLine[];
  /** Rows live by ANY signal the selected kind can answer. */
  live: number;
  /** No start AND no due date — the rows wearing a defaulted week. */
  undated: number;
  /** Exactly one endpoint stated; the other half of the bar is a default. */
  partiallyDated: number;
  /**
   * Some column has another page, so every count above is PAGE-SCOPED and the
   * strip must hedge. A bare number here would claim a space-wide total this
   * screen never read — the same hedge the column headers already make.
   */
  hedged: boolean;
  /** At least one column's read is still in flight; the strip says so. */
  loading: boolean;
}

/**
 * Counts of what is ON SCREEN, from the rows the board drew. Nothing here is
 * asked of the server a second time and nothing is estimated: `shown[i]` is
 * literally the array `ColumnView` renders, so a number in the strip and the
 * number in a column header cannot disagree.
 */
export function summarise(
  columns: readonly { plan: ColumnPlan; items: readonly EntitySummary[] | undefined; hasMore: boolean }[],
  shown: readonly (readonly EntitySummary[])[],
  today: DayKey,
  isRowLive: (row: EntitySummary) => boolean,
  spanDays: number = DEFAULT_SPAN_DAYS,
): BoardSummary {
  const lines: BoardSummaryLine[] = [];
  let total = 0;
  let live = 0;
  let undated = 0;
  let partiallyDated = 0;

  columns.forEach((column, index) => {
    const rows = shown[index] ?? [];
    lines.push({
      key: column.plan.key,
      label: column.plan.label,
      tone: timelineTone(column.plan.category),
      count: rows.length,
    });
    total += rows.length;
    for (const row of rows) {
      if (isRowLive(row)) live += 1;
      const stated = spanOf(row.state, today, spanDays).stated;
      if (stated === 'none') undated += 1;
      else if (stated !== 'both') partiallyDated += 1;
    }
  });

  return {
    total,
    lines,
    live,
    undated,
    partiallyDated,
    hedged: columns.some((column) => column.hasMore),
    loading: columns.some((column) => column.items === undefined),
  };
}
