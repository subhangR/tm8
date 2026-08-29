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
import type { ActionRef, KindConfig, QueryFilter } from '../domain';
import { CATEGORY_DEFAULT_STATUS } from '../domain';
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
}

export const EMPTY_FILTERS: BoardFilterState = { people: [], assignedBy: [], archived: false };

export function anyFilterActive(f: BoardFilterState): boolean {
  return f.people.length > 0 || f.assignedBy.length > 0 || f.archived;
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
