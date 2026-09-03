/**
 * THE KIND REGISTRY — the spine (LLD §2).
 *
 * One module drives routes, origin validation, palette entries, menu-ref
 * validation, both universal primitives, and the Z4 layouts. Totality over
 * `CoreEntityKindSchema` (16 kinds) is asserted by `registry.test.ts` — the
 * WLT §2.1 law — plus the single `c:*` fallback row that makes every custom
 * kind land on the generic archetype for free.
 *
 * Slugs, reserved words and route strategies follow WLT §2.1 exactly.
 *
 * D13 (2026-07-28): per-kind `defaultMode`/`hiddenModes` values are authored
 * here from kind semantics — neither WLT nor TM8-UI-SPEC-FINAL supplies any
 * per-kind registry DATA; both stop at the shape. `'graph'` is NEVER a member
 * of `hiddenModes` for any kind: R7 requires it visible-and-disabled in the
 * switcher, which is a different state from hidden-by-config.
 *
 * Chip glyphs were text placeholders in the canvases' own idiom, and this
 * header always said replacing them would be a DATA edit here that touched no
 * component. That edit landed: every row now carries `iconArt` — a drawn mark
 * on a 16×16 grid (`kind-art.ts`), rendered by `KindIcon`. The text `icon`
 * stays as the fallback a string-only surface can print. No component changed
 * shape to receive it, exactly as promised.
 */
import type { CoreEntityKind, EntityKind } from '@tm8/contract';
import type {
  ActionRef,
  AssignControl,
  CollectionMode,
  ContentBlockRef,
  DateControl,
  FilterSpec,
  KindConfig,
  ListConfig,
  StatusCategoryTab,
  ListRowFacts,
  LiveTreatment,
  MembershipListControl,
  QueryFilter,
  SortSpec,
  StateControl,
  ValueControl,
} from './types';
import { CUSTOM_KIND_FALLBACK, VIEWER_ACTOR } from './types';
import { KIND_ART } from './kind-art';
/* The container refusals live with the verbs that raise them, so the sentence
   a button refuses with and the sentence this row declares are one string. */
import { CONTAINER_CAPABILITY_REASONS } from './actions';
import type { SessionLiveness } from '../data/seam';

/** WLT §2.1 reserved words — never a kind slug. */
export const RESERVED_SLUGS: readonly string[] = [
  'home',
  'feed',
  'inbox',
  'workspace',
  'settings',
  'channel',
  'e',
  'k',
];

export const ALL_MODES: readonly CollectionMode[] = ['list', 'board', 'tree', 'feed', 'gallery', 'graph'];

// ---------------------------------------------------------------------------
// Shared filter / sort vocabulary (contract-shaped — the seam executes these
// without translation)
// ---------------------------------------------------------------------------

const NOT_DELETED: QueryFilter = { deleted: 'exclude' };

/* TASK_OPEN_STATUSES / TASK_CLOSED_STATUSES ARE GONE (phase 9's rename table).
   They were a hand-kept bucketing of task status LITERALS — one of the six
   incompatible bucketings the program set out to retire — and every reader of
   them now reads `filters.category` instead, which is the same partition
   expressed once, on the server, for every kind. A space that names its own
   statuses is bucketed correctly without editing this file. */

/**
 * The per-status refinement chip — FINER than the tab row, never a rival to it.
 * The tabs partition by category; this narrows to one status inside one.
 *
 * EACH OPTION CARRIES ITS CATEGORY ALONGSIDE ITS STATUS, and that second
 * member is doing real work. `narrow()` detects a contradiction by
 * INTERSECTING ARRAYS UNDER THE SAME KEY, so before phase 7 — when the tab
 * also spoke `status` — picking `Done` on the Open tab produced an empty
 * intersection and the panel said "these two contradict this tab" instead of
 * going quietly blank. The tabs speak `category` now, and a `status` chip
 * beside a `category` tab is two different keys: the merge would succeed, the
 * server would answer honestly with nothing, and the user would be back in
 * front of the unexplained empty list this refusal was built for.
 *
 * Declaring the category makes the relationship VISIBLE TO THE EXISTING RULE
 * rather than adding a new one. On its own tab it narrows to itself and costs
 * nothing (`['done'] ∩ ['done']`); on any other tab the intersection is empty
 * and the refusal fires exactly as it always did.
 *
 * The mapping mirrors `TASK_STATE_CONTROL`'s and, through it, migration 147's.
 */
const statusFilter: FilterSpec = {
  id: 'status',
  label: 'Status',
  multi: true,
  options: [
    { id: 'open', label: 'Open', filter: { status: ['open'], category: ['to_do'] } },
    { id: 'pulled', label: 'Pulled', filter: { status: ['pulled'], category: ['to_do'] } },
    { id: 'working', label: 'Working', filter: { status: ['working'], category: ['in_progress'] } },
    {
      id: 'in_review',
      label: 'In review',
      filter: { status: ['in_review'], category: ['in_progress'] },
    },
    { id: 'blocked', label: 'Blocked', filter: { status: ['blocked'], category: ['in_progress'] } },
    { id: 'done', label: 'Done', filter: { status: ['done'], category: ['done'] } },
    {
      id: 'cancelled',
      label: 'Cancelled',
      filter: { status: ['cancelled'], category: ['cancelled'] },
    },
  ],
};

/**
 * D67 — the task state picker the expanded row draws.
 *
 * ORDER IS THE WORKFLOW as this node actually enforces it, which is to say:
 * barely. `set_work_state` accepts ANY of these from ANY current value — there
 * is no transition matrix in the database — so this list is a vocabulary in
 * reading order, not a state machine, and it must not pretend otherwise by
 * hiding options that "cannot" come next. When a real workflow lands (keyed on
 * the `type` axis, space-scoped like `task_axes`), it narrows THIS list; the
 * control does not change shape.
 *
 * `done` routes through `complete`, the only operation permitted to write it,
 * and it carries a real gate: every acceptance criterion must be checked
 * first. `cancelled` does NOT — the work verb writes it directly, and it also
 * DELETES the actor's `working_on` edge, exactly as `open` does.
 */
/**
 * The task priority picker.
 *
 * TONES MATCH `tile-badges.ts:PRIORITY_TONE` VALUE FOR VALUE. The collapsed
 * row's tag and this picker paint the same fact, and D67's "the picker and the
 * badge cannot disagree" rule applies here for the same reason it applies to
 * state — it is just enforced by matching data rather than by sharing a
 * `statusPill` spec, because priority has no pill spec to share.
 *
 * The vocabulary is `PatchTaskInput['priority']` exactly. It is written through
 * the ordinary content patch, so it is VERSION-GUARDED: a stale row earns a
 * 409 the user is told about, rather than a last-write-wins overwrite.
 */
const TASK_PRIORITY_CONTROL: ValueControl = {
  source: 'priority',
  label: 'Priority',
  emptyLabel: 'no priority',
  /* Ascending, and UPPER-CASE to the letter of `tile-badges.ts`, which renders
     the same fact as `v.toUpperCase()`. The tones already match value for
     value; matching the WORD too is the other half of "the picker and the
     badge cannot disagree" — a control reading `urgent` beside a badge reading
     `URGENT` is two spellings of one fact, and the tile draws both. */
  options: [
    { id: 'low', label: 'LOW', tone: 'idle' },
    { id: 'medium', label: 'MEDIUM', tone: 'idle' },
    { id: 'high', label: 'HIGH', tone: 'block' },
    { id: 'urgent', label: 'URGENT', tone: 'block' },
  ],
};

/**
 * THE DUE DATE ON THE STRIP — user report 2026-08-28: "the task detail panel
 * should have an option to select due date. is it already there in the model,
 * i dont see it in the entity detail panel."
 *
 * It WAS in the model, end to end, and the answer to why they could not see it
 * is the whole reason this control exists. Two facts compounded:
 *
 *   1. The only write surface was the `editFields` dialog behind the panel
 *      header's `Edit` verb — one more field in a form, beside `Title`, where
 *      nothing about the panel suggests a date lives.
 *   2. `MetaGrid` draws a `Due` cell only when the field is SET, so on a task
 *      with no due date — every task, until someone opens that dialog — the
 *      panel says nothing about due dates at all. An unset optional field
 *      rendered as absence is indistinguishable from an unmodelled one, which
 *      is exactly the inference the report makes.
 *
 * So the due date joins status / priority / assignees ON THE STRIP, which is
 * where a user goes to set a task's attributes and where they looked. The
 * dialog row STAYS: it is the same registry `source` and the same patch, and
 * removing it would take the field off the create-adjacent surface to gain
 * nothing. This is not the duplication D67's amendment forbids — that was a
 * dead COPY of a live control on one surface; both of these write.
 */
const TASK_DUE_CONTROL: DateControl = {
  source: 'dueDate',
  label: 'Due date',
  /* Not "none": the strip's empty faces name their FIELD (`no priority`,
     `no assignee`), so a row of them reads as a list of unset things rather
     than a column of the same word four times. */
  emptyLabel: 'no due date',
};

/**
 * THE START DATE — migration 172, and the reason `dateControls` was written as
 * a LIST rather than a `dueControl` singleton one commit earlier.
 *
 * Everything that makes the due date work is field-agnostic already:
 * `RowDateControl` reads `state[control.source]`, the executor patches
 * `content[source]`, the css keys off `lp__datesel`, and `MetaGrid` suppresses
 * whatever `controlled` holds. So this is DATA, not a second control — which is
 * the whole test of whether that generalisation was real.
 *
 * `start_date` is nullable exactly as `due_date` is, so clearing is the same
 * explicit `null` through the same executor onto `p_clear_start_date`.
 */
const TASK_START_CONTROL: DateControl = {
  source: 'startDate',
  label: 'Start date',
  emptyLabel: 'no start date',
};

/**
 * Assignment is an EDGE, and this is the only place that says which one.
 *
 * `assigned_to` is registered in the database with its legal endpoint kinds,
 * and `internal.validate_edge` enforces them — so declaring the type here and
 * letting the node refuse an illegal pairing is one rule in one place, rather
 * than a client-side copy free to drift from the registry that decides.
 */
const TASK_ASSIGN_CONTROL: AssignControl = {
  source: 'assignees',
  label: 'Assigned',
  emptyLabel: 'Unassigned',
  edgeType: 'assigned_to',
  /* Both, because a task is assignable to a person OR to an agent, and the
     tile has always drawn the two in one row of avatars. The node validates
     the pairing regardless; this decides only who the menu offers. */
  actorKinds: ['member', 'team_member'],
};

/**
 * Channel membership, and it is the SAME control as assignment because it is
 * the same mechanic: pick an actor, write one edge, remove it by edge id. Only
 * three literals differ, and all three are data.
 *
 * `has_member` is registered by migration 080 as channel → {member,
 * team_member} and `internal.validate_edge` enforces those endpoints, so this
 * declares the type and lets the node refuse anything illegal — one rule in
 * one place, exactly as `TASK_ASSIGN_CONTROL` above.
 *
 * The label is MEMBERS, not "Assigned": a member belongs to a channel and is
 * not accountable for it. `state.members` is its own field for the same
 * reason.
 */
const CHANNEL_MEMBER_CONTROL: AssignControl = {
  source: 'members',
  label: 'Members',
  emptyLabel: 'No members',
  edgeType: 'has_member',
  actorKinds: ['member', 'team_member'],
};

const TASK_STATE_CONTROL: StateControl = {
  source: 'status',
  filterKey: 'status',
  label: 'State',
  command: 'set-state',
  /* `category` MIRRORS `internal.work_status_category()` (migration 147) and
     the server's `WORK_STATUS_CATEGORY` — the ruled mapping, including its two
     judgement calls: `pulled` is `to_do` (claimed is not started) and
     `blocked` is `in_progress` (started, and stuck is not un-started). */
  options: [
    { id: 'open', category: 'to_do' },
    { id: 'pulled', category: 'to_do' },
    { id: 'working', category: 'in_progress' },
    { id: 'in_review', category: 'in_progress' },
    { id: 'blocked', category: 'in_progress' },
    { id: 'done', category: 'done', via: 'complete' },
    { id: 'cancelled', category: 'cancelled' },
  ],
};

/**
 * A work session HAS a status and may not have it set. The lifecycle is
 * OBSERVED — the node reports spawning → running → idle → exited/failed from
 * the process itself — so the expanded row shows the current value read-only
 * with this reason. That is a different statement from a kind with no state at
 * all, and collapsing the two would tell a doc and a session the same lie.
 */
const SESSION_STATE_CONTROL: StateControl = {
  source: 'status',
  filterKey: 'sessionStatus',
  label: 'State',
  command: 'set-state',
  /* A session's OBSERVED lifecycle, bucketed. `failed` is `done` and not
     `cancelled`: under this model failure is a RUNTIME FACT that gets a badge
     (design invariant 4), and the run itself did reach its end — nobody
     cancelled it. `idle` is in_progress: an idle session is still alive.

     THIS TABLE IS A MIRROR, as of migration 155. The WRITER is
     `internal.session_status_category`, and the server's own copy is
     `SESSION_STATUS_CATEGORY` (packages/server/src/facade/status.ts) — the same
     three-artifact arrangement 147 made for `work_status`. Nothing here
     computes a row's tab; `EntitySummary.category` arrives with the row. These
     categories only narrow the STATUS FILTER CHIP to the open tab, so a copy
     that disagreed would offer `exited` as a filter under In Progress.

     `spawning` MOVED from `in_progress` to `to_do` with 155, and it is not a
     taste call. `public.execution_resume` returns an exited session to
     `spawning`; under `to_do` that is the ruled `done -> to_do` REOPEN, and
     under `in_progress` it is `done -> in_progress`, which
     `internal.category_transition_allowed` refuses outright — the bridge would
     have made every resume in the product a 23514. It is also 147's own
     `pulled -> to_do` ruling ("claimed is not started") applied to the same
     shape of fact: a spawning session has been ASKED for, and some have been
     asking for days. */
  options: [
    { id: 'spawning', category: 'to_do' },
    { id: 'running', category: 'in_progress' },
    { id: 'idle', category: 'in_progress' },
    { id: 'exited', category: 'done' },
    { id: 'failed', category: 'done' },
  ],
  readOnlyReason:
    'A session’s state is observed, not chosen — the node reports it from the process. Use Terminate to stop a live session.',
};

const readyToPullFilter: FilterSpec = {
  id: 'ready-to-pull',
  label: 'Ready to pull',
  options: [{ id: 'ready', label: 'Ready to pull', filter: { readyToPull: true } }],
};

/**
 * THE `deleted` CHIP IS BACK, AS `archivedFilter`, AND PHASE 7 IS WHY.
 *
 * It was deleted for a good reason that has now stopped being true. It used to
 * name the same axis the TAB ROW named — Open and Done carried
 * `deleted: 'exclude'`, Archived carried `deleted: 'only'` — and since
 * `deleted` is a scalar the two controls could only agree or overrule each
 * other. Choosing `Deleted only` on the Open tab silently showed archived rows
 * under a tab labelled Open. A chip that can only contradict the tab is not a
 * filter, it is a second control for one axis.
 *
 * Phase 7 removed the archive TAB, because archived is `deleted_at` and status
 * is a workflow position — orthogonal axes, and a tab row is a partition of
 * ONE axis. With the tabs now unanimously `deleted: 'exclude'`, the chip is
 * the only control naming `deleted`, and it composes instead of contradicting:
 * "archived, in progress" is a question the old tab row could not ask at all.
 *
 * One control per axis, still. The axis just moved.
 */

/**
 * VIEWER-SCOPED CHIPS, on every collection kind.
 *
 * `assigneeIds` is an `assigned_to` EDGE server-side, not a task column, so
 * "Assigned to me" is meaningful for anything that can be assigned. Likewise
 * `needsActorId` is the union of "awaiting my review" and "mentions me", and
 * the mention half applies to every kind that can anchor a message.
 *
 * Both carry `VIEWER_ACTOR` where an id belongs; the panel substitutes the
 * real one and refuses the option when it has none. The sentinel never reaches
 * the wire — the server `assertUuid`s these members, so a leak would surface
 * as a loud `invalid_input`, not as a quiet empty list.
 */
const assigneeFilter: FilterSpec = {
  id: 'assignee',
  label: 'Assignee',
  options: [{ id: 'mine', label: 'Assigned to me', filter: { assigneeIds: [VIEWER_ACTOR] } }],
};

const attentionFilter: FilterSpec = {
  id: 'attention',
  label: 'Needs me',
  options: [{ id: 'needs-me', label: 'Needs me', filter: { needsActorId: VIEWER_ACTOR } }],
};

/**
 * Tasks get the sharper second option too. `inReviewForActorId` adds
 * `t.work_status = 'in_review'` to the predicate, so it is genuinely
 * task-only: offering it on docs would render a control that can never match.
 * Not `multi` — the two options are nested senses of the same question, and
 * unioning them would just restate `Needs me`.
 */
const taskAttentionFilter: FilterSpec = {
  id: 'attention',
  label: 'Needs me',
  options: [
    ...attentionFilter.options,
    { id: 'in-review', label: 'In review for me', filter: { inReviewForActorId: VIEWER_ACTOR } },
  ],
};

const BY_ACTIVITY: SortSpec = { key: 'activityAt_desc', label: 'Recent activity', default: true };
const BY_UPDATED: SortSpec = { key: 'updatedAt_desc', label: 'Recently modified', default: true };
const BY_CREATED: SortSpec = { key: 'createdAt_desc', label: 'Newest' };
const BY_POSITION: SortSpec = { key: 'position', label: 'Manual order' };
const BY_DUE: SortSpec = { key: 'dueDate', label: 'Due date' };
const BY_START: SortSpec = { key: 'startDate', label: 'Start date' };
const BY_PRIORITY: SortSpec = { key: 'priority', label: 'Priority' };

/**
 * Offering a sort BESIDE the default one. Exactly one entry per kind may carry
 * `default` (§15.1, pinned by `registry.test.ts`), and both `BY_ACTIVITY` and
 * `BY_UPDATED` declare it so that either can be a kind's default — so any list
 * offering both must demote one HERE rather than at the pin.
 */
const also = (spec: SortSpec): SortSpec => ({ ...spec, default: false });

/**
 * THE FOUR SORTS EVERY ENTITY CAN ANSWER.
 *
 * The DATE sorts and `priority` are missing on purpose: server-side all three
 * coalesce absent values to a sentinel (`9999-12-31`, rank 3), so on a kind
 * with no due date every row ties and the list falls through to its id
 * tiebreak. That renders as "sorted" and is shuffled — the same class of lie
 * as a saturated page calling itself complete. A kind opts INTO them by
 * having them.
 */
const DEFAULT_SORT: readonly SortSpec[] = [BY_ACTIVITY, also(BY_UPDATED), BY_CREATED, BY_POSITION];

/**
 * COLLECTION MEMBERSHIP ON EVERY LIST (migration 101). `contains` is
 * registered collection → `*` (001:921), so any kind's rows can be curated —
 * which is why this rides `baseList` rather than being declared kind by kind.
 * One declaration powers two affordances: the expanded row's Collections
 * picker (add/remove this row) and the list's collection lens (narrow the
 * list to one set's members via `filters.edge`).
 */
const COLLECTION_MEMBERSHIP: MembershipListControl = {
  label: 'Collections',
  emptyLabel: 'In no collection',
  edgeType: 'contains',
  setKind: 'collection',
};

/**
 * The entity side of the `membership` BLOCK — which collections hold this
 * entity, and the affordance to add it to one. INCOMING because `contains`
 * runs collection → entity. One constant, many rows: the task's subtree
 * section and every generic body's COLLECTIONS section must be the same
 * declaration, or the two surfaces drift into two renderings of one fact.
 */
const COLLECTIONS_BLOCK: ContentBlockRef = {
  block: 'membership',
  label: 'COLLECTIONS',
  params: {
    edgeType: 'contains',
    direction: 'incoming',
    pickerKind: 'collection',
    addLabel: '+ add to collection',
    empty: 'In no collection yet.',
  },
};

/** The shape every kind gets before its own divergence is layered on. */
function baseList(
  overrides: Partial<Omit<ListConfig, 'categories'>> &
    Pick<ListConfig, 'tile'> & {
      /**
       * `null` means THIS KIND HAS NO WORKFLOW TO PROJECT — see the fact-kind
       * ruling below. Omitted still means "the ruled four".
       */
      categories?: readonly StatusCategoryTab[] | null;
    },
): ListConfig {
  return {
    quickCreate: true,
    sort: DEFAULT_SORT,
    // Universal for the same reason: `contains` accepts every dst kind, so
    // every list can be lensed by a collection and every row added to one.
    membership: COLLECTION_MEMBERSHIP,
    ...overrides,
    /* APPENDED AFTER THE OVERRIDES, DELIBERATELY. `filters` is a whole-array
       override — task and work_session both replace it — so a default entry
       is not a default at all, it is a suggestion two kinds ignore. The
       archive filter is universal by the same ruling the tabs are (it is the
       tab that was removed), so it is layered on top where a kind cannot drop
       it by declaring its own chips. Last in the row on purpose: it is an
       envelope disposition, not a property of the work. */
    filters: [...(overrides.filters ?? [assigneeFilter, attentionFilter]), archivedFilter],
    /* APPENDED AFTER THE OVERRIDES for the same reason `filters` is, and
       carrying the one ruling that changed here.

       D41 used to read: a kind opts INTO a richer partition, never out of
       having tabs at all. That was right while the four buckets meant one
       thing. Phase 5 (migration 152) gave them a second job — `is_resolved`
       answers `status_category = 'done'` — and for the five FACT KINDS the two
       jobs came apart. `152_universal_status.sql` seeds commit, message, file,
       memory and artifact to `done` deliberately, because a fact about the past
       must not block a `depends_on` forever. That `done` is a resolution
       predicate, NOT a lifecycle position: a memory is a recorded observation,
       not an intention, and it was never `to_do`.

       So those kinds were handed a four-stage tab row for a workflow they do
       not have — and, because the row defaults to `tabs[0]`, every one of them
       opened on To Do and showed NOTHING. All 24 memories in the production
       space were invisible on arrival; that is the bug this fixes, and it was a
       filter the whole time, not a failed read.

       `null` is therefore now an available state, and it means what absence
       always should have: no workflow to project, so no row. Every consumer
       already degrades correctly — `CategoryTabs` returns null for empty tabs,
       and `EntityTree` falls back to the unfiltered `{deleted:'exclude'}`. */
    categories:
      overrides.categories === null ? undefined : (overrides.categories ?? CATEGORY_TABS),
  };
}


// ---------------------------------------------------------------------------
// Category tabs (D41 + PHASE 7) — the closed four, identical on every kind
// ---------------------------------------------------------------------------

/**
 * THE FOUR TABS. One declaration, every kind, because `filters.category` asks
 * a question every kind can now answer (phase 5 gave all twenty a workflow).
 *
 * THIS FILE USED TO HOLD THREE DIFFERENT TAB ROWS — `TASK_TIERS` keyed on
 * `status` literals, `SESSION_TIERS` keyed on `sessionStatus` literals, and
 * `statelessTiers()` keyed on categories — that were meant to mean the same
 * thing and could not, because two of them named a per-kind vocabulary. A
 * session that FAILED counted as Done; a task that was CANCELLED counted as
 * Done; a custom status nobody listed counted as neither. The category is the
 * one axis every kind shares, so it is the one axis the tab row runs on, and a
 * space that invents `Triaged` files it under a tab without touching this file.
 *
 * `deleted: 'exclude'` on all four: archived rows are reached through the
 * ARCHIVE FILTER, which composes with whichever category tab is open. See
 * `archivedFilter` below and `StatusCategoryTab`'s docblock for why archived
 * cannot be a tab.
 */
const CATEGORY_TABS: readonly StatusCategoryTab[] = [
  { id: 'to_do', label: 'To Do', filter: { category: ['to_do'], deleted: 'exclude' } },
  {
    id: 'in_progress',
    label: 'In Progress',
    filter: { category: ['in_progress'], deleted: 'exclude' },
  },
  { id: 'done', label: 'Done', filter: { category: ['done'], deleted: 'exclude' } },
  { id: 'cancelled', label: 'Cancelled', filter: { category: ['cancelled'], deleted: 'exclude' } },
];

/**
 * ARCHIVED, AS A FILTER CHIP — the other half of retiring the archive tab.
 *
 * `deleted` is a SCALAR clause, so `narrow()`'s later-wins rule lets this
 * option override the `exclude` every category tab carries; picking it inside
 * the In Progress tab asks for archived in-progress rows, which the tab row
 * could never express. Not `multi`: `deleted` takes one value, and offering
 * two mutually exclusive options as though they combined would be a lie about
 * the query.
 *
 * Two options rather than one toggle because "only archived" and "archived
 * too" are different questions and the row should not make the user guess
 * which one a single chip means.
 */
const archivedFilter: FilterSpec = {
  id: 'archived',
  label: 'Archived',
  options: [
    { id: 'only', label: 'Archived only', filter: { deleted: 'only' } },
    { id: 'include', label: 'Include archived', filter: { deleted: 'include' } },
  ],
};

// ---------------------------------------------------------------------------
// work_session liveness presentation (R-UI-5: PRESENTS the seam verdict,
// never computes it)
// ---------------------------------------------------------------------------

const sessionLiveTreatment = (live: SessionLiveness): LiveTreatment => {
  switch (live) {
    case 'live':
      // T0-3 Sessions panel + T0-2 chrome strip: a live row reads `running`,
      // and `streaming` only while bytes are actually moving. `live` is the
      // live-session bar's count word (`● N live`), not a row's.
      return {
        label: 'running',
        tone: 'run',
        dot: 'solid',
        attachable: true,
        streamingLabel: 'streaming',
      };
    case 'stale':
      return {
        label: 'stale — node restarted',
        // T0-3 frame 4 rules this word at the 220px floor, verbatim.
        shortLabel: 'stale',
        tone: 'wait',
        dot: null,
        attachable: false,
        reason:
          'The record says this session is running, but the node has no live PTY for it — the node restarted since it started. Its terminal cannot be reattached.',
      };
    case 'not-running':
      return {
        // No shortLabel, deliberately: 11 chars already fits the compact
        // budget, and the tempting abbreviation `exited` would be a LIE —
        // `exited` is a WorkSessionStatus value, while `not-running` is a
        // liveness verdict. A session can be not-running without ever having
        // exited (never spawned, failed to start). Do not "shorten" this one.
        label: 'not running',
        tone: 'idle',
        dot: null,
        attachable: false,
        reason: 'This session is not running — there is no terminal to attach to.',
      };
    case 'unknown':
    default:
      return {
        label: 'running per record · unverified',
        // D27: the 9.5px chrome-strip pill cannot take the sentence. NOT
        // 'running' — the compact form must still refuse to claim life.
        shortLabel: 'unverified',
        tone: 'idle',
        dot: null,
        attachable: false,
        reason:
          'No fresh liveness snapshot from this node: the record claims running, and that claim is unverified. Unverified is never shown as live.',
      };
  }
};

/**
 * 'NEEDS YOU' grouping — designed-but-dormant per R8.
 *
 * This was written as `live === 'live' && row.status === 'idle'`, and it stayed
 * quiet for the wrong reason: `statusOf` used to answer 'not-running' for every
 * idle session, so the conjunction was UNREACHABLE. Dormancy was an accident of
 * a defect, not a property of the predicate. The moment idle was correctly
 * admitted to the live side, this fired on every quiet session at once — the
 * whole list banded as NEEDS ATTENTION, and because the attention band renders
 * flat, the session hierarchy disappeared with it.
 *
 * 'idle' means the PTY produced no output recently. That is QUIET, not BLOCKED.
 * An autonomous worker between turns is idle and wants nothing; an agent
 * genuinely waiting on a human is idle too, and nothing on this row tells the
 * two apart. A badge that fires on both is not a signal.
 *
 * So the grouping stays dormant DELIBERATELY now, and the only thing that can
 * raise it is an explicit server-side fact — `summary.badges.attention`, which
 * the call site already ORs in. When a real detector ships, give it a field on
 * ListRowFacts and test THAT here; do not re-derive attention from liveness.
 */
const sessionNeedsAttention = (_row: ListRowFacts, _live: SessionLiveness): boolean => false;

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

const ROWS: readonly KindConfig[] = [
  // -- task -----------------------------------------------------------------
  {
    kind: 'task',
    label: 'Task',
    labelPlural: 'Tasks',
    icon: '◻',
    iconArt: KIND_ART.task,
    /**
     * TITLE AND THE TWO DATES — the write surface `dueDate` never had, and the
     * one `startDate` is born with rather than waiting for its own report.
     *
     * The due date was modelled end to end and reachable from nowhere: the
     * column, the `PatchTaskInput` member, the `::date` sort and the read
     * projection all existed, and no control in the app wrote one. So `BY_DUE`
     * below sorted a field only the CLI could fill, which is a sort that works
     * perfectly and can never have anything to order.
     *
     * WHY THE DIALOG AND NOT A `valueControl`. That list is explicitly "an enum
     * member of `EntityState` this kind lets a user set" — it renders a picker
     * over declared `options`, and a calendar has none. The dialog is the
     * surface that already draws arbitrary typed fields, so a due date is one
     * more `editFields` row rather than a new control shape.
     *
     * TITLE RIDES ALONG because the dialog is "Edit task" and a form that
     * cannot touch the name reads broken. It grants nothing new — the row and
     * the panel header already edit the title inline (`inlineEdit.title`) — and
     * it is not `required` theatre: `entities.title` is `not null`, so an empty
     * one is a refusal the dialog states before spending a round trip.
     *
     * DESCRIPTION IS DELIBERATELY ABSENT. It is a body, not a field; the panel
     * renders it as prose, and a three-row textarea in a dialog is where a long
     * description goes to get truncated by hand.
     */
    editFields: [
      { target: 'title', label: 'Title', required: true, placeholder: 'What needs doing' },
      {
        target: 'content',
        source: 'startDate',
        /* Same split halves as `dueDate` below — projected onto `state`, absent
           from `contentOf` — so the same `readFrom`. Without it the dialog
           opens blank on a task that HAS a start date and Save clears it. */
        readFrom: 'state',
        label: 'Start date',
        valueType: 'date',
      },
      {
        target: 'content',
        source: 'dueDate',
        /*
         * WRITTEN to `content.dueDate`, READ from `state.dueDate`. The server
         * projects the column onto state (`entity-read.ts:1112`) and leaves it
         * out of `contentOf` (`:1502-1508`), so this is the one field in the
         * app whose two halves live in different places. Without this the
         * dialog opens blank on a task that has a due date and Save clears it.
         */
        readFrom: 'state',
        label: 'Due date',
        /*
         * OPTIONAL, and unusually literally so: `tasks.due_date` is a NULLABLE
         * column, so "no due date" is a value the database holds rather than a
         * hole in the record. Clearing the box sends an explicit `null`, which
         * is the only thing the server reads as a clear — see `valueForWire`.
         */
        valueType: 'date',
      },
    ],
    slug: 'tasks',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: [],
    chip: {
      glyph: '◻',
      tintBy: 'status',
      tones: {
        open: 'idle',
        pulled: 'info',
        working: 'run',
        in_review: 'wait',
        blocked: 'block',
        done: 'idle',
        cancelled: 'idle',
      },
    },
    card: { fields: ['status', 'priority', 'assignees', 'acceptance'] },
    list: baseList({
      /* THE `Current` / `Completed` SECTIONS ARE GONE (phase 7).
         They partitioned the task list on exactly the axis the tab row now
         partitions it on, so under four category tabs they were the deleted
         `deleted` chip's defect again in a different control: every row in the
         Done tab fell into a `Completed` section that is `collapsedByDefault`,
         so opening Done would have shown a collapsed heading and no work. One
         control per axis — the tabs own this one. Sections remain in the type
         for triage grouping that is NOT the status axis. */
      tree: { by: 'hierarchy', guideLines: true },
      tile: {
        anatomy: 'control-card',
        badges: [
          { source: 'status' },
          { source: 'priority' },
          { source: 'axes' },
          { source: 'assignees' },
          { source: 'acceptance' },
          { source: 'blocked' },
          { source: 'pulls' },
          { source: 'workingActors' },
        ],
      },
      primaryActions: ['run', 'coordinate'],
      filters: [assigneeFilter, taskAttentionFilter, statusFilter, readyToPullFilter],
      /* `BY_START` beside `BY_DUE`, in the order the two dates read: a task
         starts and then it is due. Both are offered because the task kind is
         the one that HAS them — the opt-in the `DEFAULT_SORT` note describes. */
      sort: [...DEFAULT_SORT, BY_START, BY_DUE, BY_PRIORITY],
      inlineEdit: { status: true, title: true },
      stateControl: TASK_STATE_CONTROL,
      valueControls: [TASK_PRIORITY_CONTROL],
      /* Start before due — the order they read as a pair, and the order the
         strip draws them in. */
      dateControls: [TASK_START_CONTROL, TASK_DUE_CONTROL],
      /* The per-space `type` taxonomy (and any axis the space defines). The
         vocabulary is server data, not a static options list — see the
         `ListConfig.axisControls` docblock for why this is not a
         `ValueControl`. */
      axisControls: { source: 'axes' },
      assignControl: TASK_ASSIGN_CONTROL,
      // A2: the board's DEFAULT grouping — the field the state picker
      // writes. Since W3 this is a seed, not a pin: the board's own picker
      // offers `status`, `assignee`, and `axis:<name>` per axis the
      // SPACE defines, and the choice rides the route (`q.groupBy`). The
      // server computes the groups (collections.ts groupItems); the client
      // never groups (L3).
      board: { groupBy: 'status' },
      // D44: every task ROW gets Run, not just the panel primary. It resolves
      // to the same ActionRef the panel and palette use, and its `flow:'launch'`
      // marker means the row opens the launch config rather than bare-spawning.
      rowActions: ['run', 'complete'],
    }),
    panel: {
      archetype: 'subtree',
      /* The task's memory working set (085 widened `remembers.src_kinds` to
         the wildcard; P2 auto-injects a spawn task's remembered memories).
         Declared as the SAME block the teammate row uses — `SubtreeBody`
         renders it as one named section, so the two hosts cannot drift into
         two renderings of one fact. Before this existed these edges fell
         through `peersOf` into LINKED as anonymous chips. */
      blocks: [
        {
          block: 'memory-set',
          label: 'MEMORIES',
          params: { edgeType: 'remembers', direction: 'outgoing', dstKind: 'memory' },
        },
        /* WHY THIS TASK EXISTS, when a loop made it (086 `triggered_by`,
           src task|work_session → dst loop). Provenance, not a generic link:
           without its own row it would fall through `peersOf` into LINKED as
           an anonymous chip — the same defect `remembers` had, which is why
           both edge types now sit in `OWN_SECTION_EDGES`. */
        {
          block: 'peer-rows',
          label: 'TRIGGERED BY',
          params: {
            edgeType: 'triggered_by',
            direction: 'outgoing',
            empty: 'Not triggered by a loop — this task was created directly.',
          },
        },
        /* The entity side of collection membership (2026-08-12): which
           collections hold this task, and the affordance to add it to one.
           Same defect class as `remembers`/`triggered_by` before their own
           rows: without this the edge fell through `peersOf` into LINKED as
           an anonymous chip, and nothing could write one. */
        COLLECTIONS_BLOCK,
      ],
      /*
       * The detail header keeps Run and Edit. Coordinate and Complete remain
       * available from their task-specific surfaces, not this compact panel
       * toolbar — but `edit` is not a fourth verb competing for that space, it
       * is the ONLY door to `editFields` (§15.1 pins the two together, and
       * `useEntityVerbs` drops the verb on a kind that declares nothing). A
       * task with fields and no verb would be the "declared and unreachable"
       * half of that rule.
       */
      primaries: ['run', 'edit'],
      // Git UI wave: tasks carry the git section (tracked PRs, provenance,
      // gate honesty). A registry field, so the panel never asks the kind.
      gitSection: true,
      statusPill: {
        source: 'status',
        tones: {
          open: 'idle',
          pulled: 'info',
          working: 'run',
          in_review: 'wait',
          blocked: 'block',
          done: 'idle',
          cancelled: 'idle',
        },
        labels: { in_review: 'in review' },
      },
    },
    palette: { createLabel: 'New task', primaryAction: 'run' },
  },

  // -- work_session ---------------------------------------------------------
  {
    kind: 'work_session',
    label: 'Session',
    labelPlural: 'Sessions',
    icon: '▸',
    iconArt: KIND_ART.work_session,
    slug: 'sessions',
    strategy: 'collection',
    defaultMode: 'list',
    // 'board' joined the moment board mode rendered (doc 06 §1.6): server
    // grouping guards on `state.kind === 'task'` (collections.ts groupItems),
    // so a sessions board would render one dishonest "open" column. It comes
    // back when `groupBy:'sessionStatus'` lands, as a drag-disabled board —
    // session status is observed, never chosen.
    hiddenModes: ['board', 'gallery'],
    chip: {
      glyph: '▸',
      tintBy: 'sessionStatus',
      tones: { spawning: 'wait', running: 'run', idle: 'info', exited: 'idle', failed: 'block' },
    },
    card: { fields: ['sessionStatus', 'agentTool', 'model', 'activityAt'] },
    list: baseList({
      /**
       * OPEN ON THE LIVE ONES — the reported defect, stated as data.
       *
       * A session's category is OBSERVED, not authored: 155 derives it from the
       * process (spawning→to_do, running/idle→in_progress, exited/failed→done).
       * `spawning` is the sub-second gap between "asked for" and "started", so
       * To Do holds a session only by accident of timing, and NEVER holds a
       * running one. Landing there is landing on an empty screen — 477 sessions
       * on the launch node, To Do 0 / In Progress 6 / Done 471 — which is
       * exactly the report: "doesn't show me live sessions."
       *
       * In Progress rather than Done, though Done is where 471 of the 477 are:
       * the question this list opens on is "what is running", not "what has
       * ever run". Done is one click away and remembered per kind once picked.
       *
       * NOT A NEW FILTER, and deliberately so. `filters.sessionStatus` already
       * exists and already works (contract A22, server `ws.status = any(...)`);
       * what was broken was never the vocabulary's ability to say `running`,
       * only which band this panel opened on. See the PR body.
       */
      defaultCategory: 'in_progress',
      tree: { by: 'hierarchy', guideLines: true, messagePulse: true },
      tile: {
        anatomy: 'session-tree',
        badges: [
          { source: 'sessionStatus' },
          { source: 'createdBy' },
          { source: 'agentTool' },
          { source: 'model' },
          { source: 'shareMode' },
          { source: 'workingActors' },
        ],
        pulse: { signal: 'terminal-activity', gate: 'live' },
      },
      liveCount: { filter: NOT_DELETED, label: (n) => `● ${n} live` },
      // Sessions are LAUNCHED, not created: `quickLaunch` below is the real
      // affordance, so the inherited quickCreate:true only mounted a Create
      // control that refuses. Same defect class as the rowActions note below —
      // "Keeping this true mounted a refused Save control whose full reason
      // squeezed Discussion/Connections/Activity out of the compact panel
      // row" — ruled once already; a refused control is not a control.
      quickCreate: false,
      quickLaunch: 'launch-session',
      // Beside it, not beneath it (user ruling 2026-08-12). A vanilla terminal
      // is the OTHER way to get a session, so it belongs in the same header
      // slot as the way you get an agent one — not buried in a row action,
      // where you would have to already have a session to find out how to
      // start one.
      quickStart: 'start-terminal',
      filters: [assigneeFilter, attentionFilter],
      sort: DEFAULT_SORT,
      needsAttentionGroup: sessionNeedsAttention,
      liveTreatment: sessionLiveTreatment,
      // A session title IS an authoring surface, as of 085 — the spawn-time
      // default (the first linked task's title) is a guess, and two sessions on
      // one task were called the same thing forever.
      //
      // WHY THIS WAS FALSE BEFORE, and what actually changed: keeping it true
      // mounted a REFUSED Save control whose full reason squeezed
      // Discussion/Connections/Activity out of the compact panel row. That
      // refusal was `capabilities.canEdit === false` — the node had no patch
      // door for a work_session — and `SaveControls` renders a permanent
      // disabled-with-reason in exactly that state. With the door open the
      // control renders NULL while clean, so the compact row is unaffected and
      // the earlier ruling's premise no longer holds.
      inlineEdit: { title: true },
      /**
       * THE TICK IS BACK, AND NOW IT IS A REAL VERB — USER RULING 2026-08-19:
       * "we need the tick mark there, tick marks the session done, but does not
       * close it … i want to mark sessions done, but not close them to revisit
       * later, this is through the tick mark."
       *
       * #423 removed `complete` from this array, and the removal was right for
       * the reasons it gave: the server refused the affordance, the door
       * selected `where kind = 'task'`, and there was nothing for it to write.
       * All three were true. NONE of them was a statement that the verb is
       * meaningless for a session — they were a statement that nobody had
       * built it. Migration 156 and the session arm of `entities.commands.
       * complete` build it, so the ruling that removed it ("a refused control
       * is not a control") no longer applies: it is not refused.
       *
       * WHAT IT MEANS HERE, and why it is not Terminate wearing a tick. The two
       * verbs answer different questions and now sit side by side saying so:
       *
       *   terminate  ends the PROCESS. Destructive, irreversible, and the row
       *              lands in Done because it genuinely finished.
       *   complete   ends the ROW'S CLAIM ON YOUR ATTENTION. The process keeps
       *              running, the terminal keeps streaming, and the session
       *              files itself under Done so you can come back to it.
       *
       * A session's STATUS remains observed — `SESSION_STATE_CONTROL.
       * readOnlyReason` still holds and this writes nothing to it. What the
       * tick authors is the ENVELOPE's category, which is a different column
       * and a different question: the node says what the process is doing, the
       * user says whether they are done with it.
       *
       * IT IS A TOGGLE (ruled 2026-08-19 over the one-way alternative): ticking
       * a done session reopens it and the category goes back to following the
       * process. `expectedVersion` is what makes a toggling command safe — a
       * double submit is a version conflict, not a silent flip back.
       *
       * AND ON A FINISHED RUN IT IS NOT DRAWN AT ALL (ruled 2026-08-19, with
       * the process control below). Both verbs above are declared for the row
       * a session spends its ACTIVE life as; once the run has ended the tick
       * has no subject — "is this row's claim on my attention over?" is
       * structurally, permanently yes — so `RowActionCluster` drops it and
       * swaps Terminate for Resume, leaving ONE control rather than two with
       * one greyed. Measured before that: `exited` drew a refused Terminate
       * beside a tick that dispatched, wrote, and moved nothing.
       *
       * `resume` IS NOT IN THIS ARRAY, and that is a decision rather than an
       * omission. `rowActions` is STATIC per-kind data and `ActionAvailability`
       * has no `hidden` (a rowActions entry cannot hide itself), so a fifth
       * entry here would render a permanently refused Resume beside a live
       * Terminate on every running session — the "a refused control is not a
       * control" ruling that took the tick out in the first place. The swap is
       * per-ROW state, so the component that sees the row owns it; this array
       * keeps saying which verbs the kind HAS.
       */
      rowActions: ['complete', 'terminate'],
      stateControl: SESSION_STATE_CONTROL,
    }),
    panel: {
      archetype: 'terminal',
      // USER RULING 2026-07-29: terminal panels use the same compact two-row
      // geometry as tasks. Keep the destructive session verb at the right of
      // the tab row, where it does not squeeze the title/tabs/window controls
      // or the terminal canvas. (This note used to add "Complete remains
      // available from rowActions" — it does not, and never did: see the
      // rowActions block above for the three things that refused it.)
      //
      // ONE ENTRY, TWO VERBS — the process control, exactly as in the row
      // cluster: `ActionBar` draws Resume in this slot once the run has ended.
      // The panel had the identical hole and it is the worse place for it, a
      // user who opens a dead session looks here first. Declared as the one
      // verb for the same reason `rowActions` omits `resume`: this array is
      // static per-kind and listing both would put a permanently refused
      // control beside the live one.
      primaries: ['terminate'],
      statusPill: {
        source: 'sessionStatus',
        tones: { spawning: 'wait', running: 'run', idle: 'info', exited: 'idle', failed: 'block' },
      },
      // Already excluded from strip/footer via the terminal archetype arm;
      // the flag states the reason structurally: this body ends at a composer.
      composition: 'chat',
      z4: { immersive: true },
    },
    palette: { createLabel: 'Launch session', primaryAction: 'launch-session' },
  },

  // -- doc ------------------------------------------------------------------
  {
    kind: 'doc',
    label: 'Doc',
    labelPlural: 'Docs',
    icon: '▤',
    iconArt: KIND_ART.doc,
    slug: 'docs',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board'],
    chip: { glyph: '▤', tintBy: 'none' },
    card: { fields: ['docFormat', 'childCount', 'activityAt'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'docFormat' }, { source: 'childCount' }, { source: 'messages' }] },
      // A doc's default is when it was last EDITED, not last touched — the
      // only kind that inverts the pair, which is why it lists them itself.
      sort: [BY_UPDATED, also(BY_ACTIVITY), BY_CREATED, BY_POSITION],
      inlineEdit: { title: true },
    }),
    panel: { archetype: 'reader', primaries: ['add-child'] },
    palette: { createLabel: 'New doc' },
  },

  // -- channel (COLLECTION as of 2026-08-01 — user ruling) ------------------
  //
  // Was `special` + `slug: null` for as long as channels lived in the rail as
  // their own section. The user ruling moved them into the Entity List Panel:
  // a channel is an entity, it is listed and opened exactly like a task or a
  // doc, so it is a collection kind and the panel's kind switcher (which reads
  // `collectionKinds()`) offers it without any per-kind wiring.
  //
  // THE SLUG IS PLURAL BY NECESSITY, not by style: `channel` is a WLT §2.1
  // RESERVED word (it is the `#/s/{space}/channel/{id}` route segment), so it
  // can never be a kind slug. `channels` is not reserved and the collection
  // route it produces — `#/s/{space}/k/channels` — is a different path from
  // the `#/s/{space}/channels` view ref, which keeps working.
  //
  // `routeBuilder` deliberately KEEPS the singular channel route: that is
  // where a single channel is addressed, and it did not change just because
  // the collection got a home.
  {
    kind: 'channel',
    label: 'Channel',
    labelPlural: 'Channels',
    icon: '#',
    iconArt: KIND_ART.channel,
    titleGrammar: 'slug',
    /**
     * NAME AND TOPIC, AND DELIBERATELY NOTHING ELSE (user ruling 2026-08-07,
     * task 019fd744 "feature/Channels" items 1/3/5/6).
     *
     * The ticket is a list of things a channel is NOT: not stateful, not
     * assigned, not prioritised, no acceptance criteria, no subtree, no runs,
     * no attachments. Those were never channel fields — `＋ New channel`
     * created a TASK until #42, and a task panel is what the reporter was
     * looking at. What was missing once that was fixed is the other half:
     * `channels.topic` has been readable in the hub body since the archetype
     * landed and writable from nowhere in the app.
     *
     * TOPIC IS OPTIONAL because the column is `not null default ''` (001:504)
     * — an omitted topic is a value the database already stores, not a hole.
     * `update_channel` COALESCEs a null topic to the existing one (007:1095),
     * so clearing it sends `''` and not `null`.
     *
     * MEMBERS ARE STILL NOT AN `editFields` ENTRY, and now for a different
     * reason than when this comment was written. The edge exists (`has_member`,
     * migration 080) and membership IS settable — through
     * `list.assignControl`, the same actor picker that assigns a task, because
     * membership is the same mechanic: one edge, one actor, removed by edge id.
     * An `editFields` row would be a second way to write the same edge, with
     * its own dirty-state and its own bugs. A member added there would also be
     * written by a DIFFERENT verb than the dialog's `patch_entity`, so a failed
     * save would leave the roster changed and the name not — two writes wearing
     * one Save button.
     *
     * Adding members AT CREATION is `CreateEntityInput.connections`, which
     * `attachInitialConnections` writes inside the create transaction.
     */
    editFields: [
      {
        target: 'title',
        label: 'Name',
        required: true,
        grammar: 'slug',
        placeholder: 'design-review',
      },
      {
        target: 'content',
        source: 'topic',
        label: 'Topic',
        placeholder: 'What is this channel about?',
        multiline: true,
      },
    ],
    slug: 'channels',
    strategy: 'collection',
    routeBuilder: (spaceId, id) => `#/s/${spaceId}/channel/${id}`,
    defaultMode: 'list',
    hiddenModes: ['board', 'gallery'],
    chip: { glyph: '#', tintBy: 'none' },
    card: { fields: ['channelTopic', 'unread', 'workingAgents'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'unread' }, { source: 'workingAgents' }, { source: 'messages' }] },
      inlineEdit: { title: true },
      assignControl: CHANNEL_MEMBER_CONTROL,
    }),
    // composition:'chat' — the hub body is a conversation ending at its
    // composer: no AttachmentStrip (the composer's + owns attach) and no
    // PanelFooter below it.
    /**
     * `add-child` IS THE SUBCHANNEL VERB (user ruling 2026-08-07). The graph
     * has always allowed it — `entities.parentId` is kind-agnostic and this
     * row's `tree: { by: 'hierarchy' }` already draws the nesting — but the
     * verb rendered disabled-with-reason on every panel in the app because no
     * host ever passed an `onAction`. It is wired now (`views/useEntityVerbs`),
     * so the channel that is open is the parent of what it creates.
     */
    /**
     * `threads: true` — a channel reads as THREAD ROOTS (`channel_threads_v1`)
     * and opens each branch in a thread pane (slice 2 of the Slack-threads
     * programme). Registry data rather than a kind check in the surface: the
     * session chat mounts the SAME ChannelScreen and must keep its flat,
     * replies-inline read (threading sessions is explicitly out of scope —
     * channels end-to-end first).
     */
    panel: { archetype: 'hub', composition: 'chat', threads: true, primaries: ['edit', 'add-child'] },
    palette: { createLabel: 'New channel' },
  },

  // -- voice_channel (special strategy — a ROOM, not a feed) ----------------
  //
  // Deliberately `special` + `slug: null`, exactly like `channel`: that keeps
  // it OUT of `collectionKinds()`, so it is neither a list-kind switcher entry
  // nor a menu-editor row. The rail supplies voice rows from a DYNAMIC group
  // over the space's live voice entities, the same way Collab v2 supplies
  // channel rows — a `k/` collection list would be a second, divergent home.
  //
  // Adapted from `channel` rather than copied: a voice channel carries NO
  // message feed and NO topic (its contract content arm is `{ kind }` and
  // nothing else), so `channelTopic` / `unread` / `messages` have no honest
  // source here and are absent instead of rendering empty.
  {
    kind: 'voice_channel',
    label: 'Voice channel',
    labelPlural: 'Voice channels',
    // A placeholder in the canvases' own monochrome text idiom (see the module
    // header): a speaker glyph from the pictograph block tofus in the system
    // font, so the audio note stands in until the canvas-extracted set lands.
    icon: '♪',
    iconArt: KIND_ART.voice_channel,
    titleGrammar: 'slug',
    slug: null,
    strategy: 'special',
    routeBuilder: (spaceId, id) => `#/s/${spaceId}/voice/${id}`,
    defaultMode: 'list',
    hiddenModes: ['board', 'gallery'],
    chip: { glyph: '♪', tintBy: 'none' },
    card: { fields: ['workingActors', 'activityAt'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'workingActors' }] },
      inlineEdit: { title: true },
    }),
    // `hub` matches `channel`'s archetype, but WITHOUT `add-child`: a voice
    // room has no child-authoring surface to promise.
    panel: { archetype: 'hub' },
    palette: { createLabel: 'New voice channel' },
  },

  // -- message (anchored strategy — no k/ view) -----------------------------
  {
    kind: 'message',
    label: 'Message',
    labelPlural: 'Messages',
    icon: '✉',
    iconArt: KIND_ART.message,
    slug: null,
    strategy: 'anchored',
    // Canonical route = the containing channel + ?msg=. Parent missing ⇒
    // e/{messageId} with a tombstone banner and NO companion (WLT §2.1).
    defaultMode: 'feed',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '✉', tintBy: 'none' },
    card: { fields: ['messageAuthor', 'excerpt', 'activityAt'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'messageAuthor' }, { source: 'points' }] },
      sort: [BY_CREATED, BY_ACTIVITY],
      // A FACT KIND (migration 152 `kind_seeds_done`): born `done` as a
      // resolution predicate, with no lifecycle to project. No tab row.
      categories: null,
    }),
    panel: { archetype: 'generic', blocks: [{ block: 'fields', label: 'MESSAGE' }] },
  },

  // -- member ---------------------------------------------------------------
  {
    kind: 'member',
    label: 'Member',
    labelPlural: 'Members',
    icon: '◍',
    iconArt: KIND_ART.member,
    slug: 'members',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: {
      glyph: '◍',
      tintBy: 'memberRole',
      tones: { owner: 'brand', admin: 'info', member: 'idle' },
    },
    card: { fields: ['memberRole', 'score', 'taskDoneCount'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'entityActor' }, { source: 'memberRole' }, { source: 'score' }, { source: 'taskDoneCount' }] },
    }),
    panel: {
      archetype: 'profile',
      statusPill: { source: 'memberRole', tones: { owner: 'brand', admin: 'info', member: 'idle' } },
      /* T0-4 MEMBER frame (oracle lines 400–448). The anatomy IS this list —
         ProfileBody carries no kind branch, so the human frame and the agent
         frame below differ only in the blocks their row declares. */
      blocks: [
        {
          block: 'identity',
          params: { provenance: 'human', tagKey: 'role', caption: 'human member', presence: true },
        },
        {
          block: 'stat-tiles',
          params: { tiles: 'taskDoneCount=tasks done,score=points,teamMembers=teammates' },
        },
        { block: 'items', label: 'TEAMMATES OWNED', params: { source: 'teamMembers' } },
        { block: 'items', label: 'CURRENT WORK', params: { source: 'work', statusKey: 'status' } },
      ],
    },
  },

  // -- team_member ----------------------------------------------------------
  {
    kind: 'team_member',
    label: 'Teammate',
    labelPlural: 'Teammates',
    icon: '◆',
    iconArt: KIND_ART.team_member,
    slug: 'teammates',
    strategy: 'collection',
    defaultMode: 'list',
    /* `tree` is NOT hidden: db/migrations/002_identity.sql:110 rules that the
       org tree IS the entity hierarchy (leader = parent), so the generic
       EntityTree — which builds from `parentId` and roots orphans rather than
       dropping them — renders the team structure with no teammate-specific
       code. A flat team draws one flat level, which is the honest picture of a
       team nobody has given a leader. */
    hiddenModes: ['board'],
    chip: { glyph: '◆', tintBy: 'none' },
    card: { fields: ['owner', 'model', 'liveWork'] },
    list: baseList({
      tile: { badges: [{ source: 'entityActor' }, { source: 'owner' }, { source: 'agentTool' }, { source: 'model' }, { source: 'liveWork' }] },
      inlineEdit: { title: true },
      tree: { by: 'hierarchy', guideLines: true },
    }),
    panel: {
      archetype: 'profile',
      primaries: ['coordinate'],
      /* T0-4 AGENT frame (oracle lines 452–496), verbatim in order… */
      blocks: [
        { block: 'bio', params: { source: 'identity' } },
        /* `memories=Memories` is GONE from this grid, and its removal is a fix
           rather than a trim: `FieldValue` prints an array as its length, the
           source was the `team_members.memories` jsonb, and migration 084
           emptied that column after moving every entry into the graph. The cell
           could only ever print `0` — a measurement-shaped zero for a column
           nobody writes. The real working set is the `memory-set` block below,
           read from the `remembers` edges 084/085 established. */
        {
          block: 'field-grid',
          params: { fields: 'model=Model,agentTool=Tool,owner=Owner' },
        },
        { block: 'live-work', params: { source: 'liveWork' } },
        { block: 'items', label: 'EQUIPPED', params: { source: 'equipped', count: true } },
        /* The working set that spawn actually injects (`loadSpawnContext`).
           Edge-backed and kind-free: 085 widened `remembers.src_kinds` to the
           wildcard, so this identical row on a task panel needs no new code. */
        {
          block: 'memory-set',
          label: 'MEMORIES',
          /* `dstKind` is what the authoring flow creates when this set gains a
             member. It is DATA here and not a literal in the authoring lane
             because §15.2 is enforced there by `no-kind-literals.test.ts`: the
             create/save flows must reach a kind through the registry, so the
             row that declares the block also declares what the block authors. */
          params: { edgeType: 'remembers', direction: 'outgoing', dstKind: 'memory', count: true },
        },
        {
          block: 'session-rows',
          label: 'RECENT SESSIONS',
          params: { edgeType: 'relates_to', direction: 'incoming' },
        },
        /* …then one ADDITION the oracle does not draw, appended so the frame
           above stays contiguous and oracle-exact: this teammate's place in
           the org tree, read from `hierarchy` and never written. */
        { block: 'org-tree', label: 'TEAM' },
      ],
    },
    palette: { createLabel: 'New teammate' },
  },

  // -- pull_request ---------------------------------------------------------
  {
    kind: 'pull_request',
    label: 'Pull request',
    labelPlural: 'Pull requests',
    icon: '⑂',
    iconArt: KIND_ART.pull_request,
    slug: 'pulls',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['tree', 'gallery'],
    chip: {
      glyph: '⑂',
      tintBy: 'prState',
      tones: { open: 'run', draft: 'idle', merged: 'brand', closed: 'idle' },
    },
    card: { fields: ['prState', 'repository', 'activityAt'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'prState' }, { source: 'repository' }, { source: 'messages' }] },
    }),
    panel: {
      archetype: 'generic',
      // B10 (git placement map §4.3): "Merge…" is the ActionBar PRIMARY — the
      // missing counterpart to the session rail's deliberate exclusion of
      // landing-on-base. It renders disabled with its named reason until a
      // forge WRITE client exists (the tracker is read-only today).
      primaries: ['merge-pr'],
      blocks: [
        { block: 'link-summary', label: 'PULL REQUEST' },
        { block: 'fields', label: 'DETAILS' },
        COLLECTIONS_BLOCK,
      ],
      statusPill: {
        source: 'prState',
        tones: { open: 'run', draft: 'idle', merged: 'brand', closed: 'idle' },
      },
    },
  },

  // -- commit ---------------------------------------------------------------
  {
    kind: 'commit',
    label: 'Commit',
    labelPlural: 'Commits',
    icon: '◉',
    iconArt: KIND_ART.commit,
    slug: 'commits',
    strategy: 'collection',
    defaultMode: 'feed',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '◉', tintBy: 'none' },
    card: { fields: ['repository', 'sha', 'createdBy'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'repository' }, { source: 'sha' }] },
      sort: [BY_CREATED, BY_ACTIVITY],
      // A FACT KIND (migration 152 `kind_seeds_done`): born `done` as a
      // resolution predicate, with no lifecycle to project. No tab row.
      categories: null,
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'link-summary', label: 'COMMIT' },
        { block: 'fields', label: 'DETAILS' },
        COLLECTIONS_BLOCK,
      ],
    },
  },

  // -- file -----------------------------------------------------------------
  {
    kind: 'file',
    label: 'File',
    labelPlural: 'Files',
    icon: '▣',
    iconArt: KIND_ART.file,
    slug: 'files',
    strategy: 'collection',
    defaultMode: 'gallery',
    hiddenModes: ['board'],
    chip: { glyph: '▣', tintBy: 'none' },
    card: { fields: ['mimeType', 'sizeBytes', 'createdBy'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'mimeType' }, { source: 'sizeBytes' }] },
      inlineEdit: { title: true },
      // A FACT KIND (migration 152 `kind_seeds_done`): born `done` as a
      // resolution predicate, with no lifecycle to project. No tab row.
      categories: null,
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'file-preview', label: 'PREVIEW' },
        { block: 'fields', label: 'DETAILS' },
        COLLECTIONS_BLOCK,
      ],
    },
    // The create door for a `file` is an UPLOAD, not a placeholder row. The
    // generic immediate-create flow commits an entity titled "Untitled file"
    // with no blob behind it: it lists in the browser, offers a Download link
    // and 404s when that link is followed, because `files.download` joins onto
    // `public.files` and finds nothing. Three such orphans exist in the
    // production space, all created by pressing this very button.
    createForm: 'file-upload',
    palette: { createLabel: 'Upload file' },
  },

  // -- spell ----------------------------------------------------------------
  {
    kind: 'spell',
    label: 'Spell',
    labelPlural: 'Spells',
    icon: '✧',
    iconArt: KIND_ART.spell,
    slug: 'spells',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: { glyph: '✧', tintBy: 'equipped', tones: { true: 'run', false: 'idle' } },
    card: { fields: ['equipped', 'excerpt', 'activityAt'] },
    list: baseList({
      tile: { badges: [{ source: 'equipped' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'fields', label: 'DEFINITION' },
        { block: 'items', label: 'EQUIPPED BY' },
        COLLECTIONS_BLOCK,
      ],
    },
    palette: { createLabel: 'New spell' },
  },

  // -- skill ----------------------------------------------------------------
  {
    kind: 'skill',
    label: 'Skill',
    labelPlural: 'Skills',
    icon: '✦',
    iconArt: KIND_ART.skill,
    slug: 'skills',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: { glyph: '✦', tintBy: 'equipped', tones: { true: 'run', false: 'idle' } },
    card: { fields: ['equipped', 'excerpt', 'activityAt'] },
    list: baseList({
      tile: { badges: [{ source: 'equipped' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'fields', label: 'DEFINITION' },
        { block: 'items', label: 'EQUIPPED BY' },
        COLLECTIONS_BLOCK,
      ],
    },
    palette: { createLabel: 'New skill' },
  },

  // -- collection -----------------------------------------------------------
  {
    kind: 'collection',
    label: 'Collection',
    labelPlural: 'Collections',
    icon: '▦',
    iconArt: KIND_ART.collection,
    slug: 'collections',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board'],
    chip: { glyph: '▦', tintBy: 'none' },
    card: { fields: ['collectionType', 'itemCount', 'activityAt'] },
    list: baseList({
      tile: { badges: [{ source: 'collectionType' }, { source: 'itemCount' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        /* ITEMS stopped being the inert `content.items` chip list on
           2026-08-12: membership is a `contains` edge and this block writes
           it (add via picker, remove per row). `count: true` puts the edge
           count in the eyebrow, so the tile's itemCount badge and this label
           read the same fact. */
        {
          block: 'membership',
          label: 'ITEMS',
          params: { edgeType: 'contains', direction: 'outgoing', count: true, addLabel: '+ add entity' },
        },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
    palette: { createLabel: 'New collection' },
  },

  // -- project (restricted: generic create/patch/delete/move refused) -------
  {
    kind: 'project',
    label: 'Project',
    labelPlural: 'Projects',
    icon: '⬢',
    iconArt: KIND_ART.project,
    slug: 'projects',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '⬢', tintBy: 'none' },
    card: { fields: ['projectVersion', 'activityAt', 'createdBy'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'projectVersion' }] },
    }),
    panel: {
      /* kind-bodies-2 handover, applied verbatim: the GOVERNED body. */
      archetype: 'governed',
      blocks: [
        { block: 'path-row' },
        { block: 'trust-card', params: { action: 'untrust' } },
        { block: 'live-sessions' },
        { block: 'unlink-footer', params: { action: 'unlink' } },
        {
          block: 'notice',
          params: {
            text: 'Projects are a materialized per-space projection of node-level registry rows. Editing, deleting and moving them here is refused by design — manage them in node settings.',
          },
        },
      ],
      capabilityReasons: {
        canEdit: 'Projects are materialized from the node registry — they cannot be edited from a space.',
        canDelete: 'Projects are materialized from the node registry — unlink instead of deleting.',
      },
    },
  },

  // -- interaction_profile (restricted lifecycle family) -------------------
  {
    kind: 'interaction_profile',
    label: 'Interaction profile',
    labelPlural: 'Interaction profiles',
    icon: '⌬',
    iconArt: KIND_ART.interaction_profile,
    slug: 'interaction-profiles',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: {
      glyph: '⌬',
      tintBy: 'profileStatus',
      tones: { draft: 'idle', active: 'run', retired: 'idle' },
    },
    card: { fields: ['profileStatus', 'profileVersions', 'activityAt'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'profileStatus' }, { source: 'profileVersions' }] },
    }),
    panel: {
      /* kind-bodies-2 handover, applied verbatim: the RESTRICTED body. */
      archetype: 'restricted',
      blocks: [
        { block: 'status-banner', params: {
            source: 'status',
            draft: 'preview only — activate to offer it at launch.',
            retired: 'sessions pinned to it keep running — new launches can’t pick it.',
          } },
        { block: 'preview', label: 'PREVIEW' },
        { block: 'field-rows', params: { fields: 'voice=VOICE,risk=RISK,tools=TOOLS' } },
        { block: 'items', label: 'DEFAULT FOR', params: { source: 'defaultFor' } },
        { block: 'restrictions' },
        { block: 'pin-provenance', params: { countSource: 'pinnedBy' } },
      ],
      statusPill: {
        source: 'profileStatus',
        tones: { draft: 'idle', active: 'run', retired: 'idle' },
      },
      capabilityReasons: {
        canEdit:
          'Interaction profiles change through their own lifecycle operations (draft → activate → retire), not through generic edits.',
        canDelete: 'Interaction profiles are retired, never deleted — the version history is the record.',
      },
    },
  },

  // -- memory (scope-carrying claims; staleness derived server-side) --------
  {
    kind: 'memory',
    label: 'Memory',
    labelPlural: 'Memories',
    icon: '◈',
    iconArt: KIND_ART.memory,
    slug: 'memories',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '◈', tintBy: 'none' },
    card: { fields: ['excerpt', 'activityAt', 'createdBy'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'messages' }] },
      // A FACT KIND (migration 152 `kind_seeds_done`): born `done` as a
      // resolution predicate, with no lifecycle to project. No tab row.
      categories: null,
    }),
    /*
     * PROFILE, not generic — and this is the archetype working as designed
     * rather than a teammate surface being borrowed.
     *
     * `ProfileBody`'s own docblock states the rule: the anatomy IS the ordered
     * block list the registry row carries, there is no `kind ===` in it, and
     * "a third profile-shaped kind is a registry row, not an edit here". A
     * memory needs exactly what that body already draws — prose, a fact grid,
     * edge-backed rows — plus the two blocks added with it (`epistemics`,
     * `peer-rows`), which are equally kind-free.
     *
     * The generic `fields` block could not carry any of it: it cannot render a
     * staleness badge, cannot list edge peers, and cannot offer a verb.
     */
    panel: {
      archetype: 'profile',
      blocks: [
        /* The claim itself, as prose. `statement` is CONTENT — the only 056
           field that is, since the four scope fields ride in `state` so they
           travel with every summary. */
        { block: 'bio', params: { source: 'statement' } },
        /* The conditions the claim is true under. `lookup` reads state before
           content, and these are state, so they arrive without a second read.
           `doesNotEstablish` is here and not hidden behind a disclosure: it is
           the field that stops a memory being over-applied, which is the whole
           reason 056 made it required. */
        {
          block: 'field-grid',
          label: 'SCOPE',
          params: {
            fields: 'subjectScope=Ranges over,mechanism=Measured by,doesNotEstablish=Does not establish,measuredAt=Measured at',
          },
        },
        { block: 'epistemics', label: 'STANDING' },
        /* WHO HOLDS IT. Mixed kinds since 085 widened `remembers` src to the
           wildcard — teammates, tasks and sessions all land in one list, and
           each row names its kind because the edge no longer distinguishes
           them. Injection follows these edges, so this is also the answer to
           "who will be told this". */
        {
          block: 'peer-rows',
          label: 'REMEMBERED BY',
          params: {
            edgeType: 'remembers',
            direction: 'incoming',
            count: true,
            empty: 'Nobody remembers this yet — it exists as a claim but no working set carries it, so no session will be told it.',
          },
        },
        /* AUTHORSHIP IS A DIFFERENT EDGE (D10). The server writes
           `authored_from` when a session creates a memory, and it is kept
           separate from `remembers` precisely so consolidation can move working
           sets around without rewriting who wrote what. Never inferred from a
           holder's kind. */
        {
          block: 'peer-rows',
          label: 'AUTHORED IN',
          params: {
            edgeType: 'authored_from',
            direction: 'outgoing',
            empty: 'No authoring session recorded — written outside a session, or before authorship was tracked.',
          },
        },
      ],
    },
    palette: { createLabel: 'New memory' },
  },

  // -- graph (Craft P1: ONE ROW holds vertices AND edges — the blueprint) --
  {
    kind: 'graph',
    label: 'Graph',
    labelPlural: 'Graphs',
    icon: '⬡',
    iconArt: KIND_ART.graph,
    slug: 'graphs',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '⬡', tintBy: 'none' },
    card: { fields: ['excerpt', 'activityAt', 'createdBy'] },
    list: baseList({
      // The generic placeholder flow CAN mint a graph: title + the 'entity'
      // default type is a valid empty blueprint the craft chat then grows.
      quickCreate: true,
      tile: { badges: [{ source: 'messages' }] },
    }),
    /*
     * GENERIC, WITH THE CANVAS FIRST — this reverses the P1 ruling that the
     * canvas "lives on the Craft screen, not in the side panel".
     *
     * That ruling was made for a real reason, but the reason was the HEADER,
     * not the canvas: the studio's pane header cost one row and the panel's
     * cost three, so nobody would spend a Craft column on panel chrome. With
     * the studio's header and the panel bar both at 30px the objection is
     * gone, and what remains is the plain fact that a graph was rendering two
     * different ways — a picture in Craft, a fields list everywhere else.
     *
     * It is CHEAP because R1 made it cheap: one row holds the vertices AND
     * the edges, so `blueprintView` is a pure fold of `detail.content` with
     * no seam, no per-node connections read and no host prop to wire through
     * five mount sites. The block is READ-ONLY; Craft remains the place a
     * blueprint is edited, and `edit` is still the door.
     */
    panel: {
      archetype: 'generic',
      blocks: [{ block: 'blueprint' }, { block: 'fields', label: 'GRAPH' }, COLLECTIONS_BLOCK],
      /* §15.1: declared fields must be reachable — edit is the door. */
      primaries: ['edit'],
    },
    editFields: [
      { target: 'title', label: 'Title', required: true, placeholder: 'Launch flow' },
    ],
  },

  /*
   * -- chat (migration 176: a conversation with a teammate, as an entity) --
   *
   * WAVE 2 MAKES THIS THE REAL ROW. Wave 1 shipped the honest minimum — a
   * generic fields body and a one-badge tile — because `registry.test.ts`
   * asserts totality over `CoreEntityKindSchema` and a kind with no row is a
   * build failure. The surfaces are here now.
   *
   *   * `panel.archetype: 'conversation'` — the body IS the transcript and its
   *     composer, with nothing above it. See the archetype's own docblock in
   *     `types.ts` for why this is neither `hub` (which hangs a feed beneath
   *     front-door regions a chat does not have) nor `terminal`.
   *   * `panel.conversation: 'chat-thread'` — WHICH conversation, as registry
   *     DATA, so `defaultConversationSurfaceKind` never reads a kind literal.
   *   * `composition: 'chat'` — the body ends at its composer, so no strip, no
   *     attention section, no footer under it. The same declaration `channel`
   *     and `work_session` carry, for the same reason.
   *   * `panel.threads` is ABSENT, i.e. false: a chat is FLAT (176 §1.3 — every
   *     turn is a root message on the chat and the user→agent pairing lives in
   *     `chat_turns`). A thread pane here would offer to branch a conversation
   *     the data model cannot branch.
   *   * `quickCreate: false` — a chat is born from `chat.start`, which needs a
   *     teammate, a model and a mode. The placeholder-only generic flow cannot
   *     supply them, and `chat` is excluded from `CreatableEntityKind` for
   *     exactly that reason. A refused Create control is not a control (the
   *     `work_session` ruling above, same shape). The list header points at the
   *     composer instead — see `quickLaunch` below.
   *   * `rowActions` names NO verbs of its own. `run` arrives by derivation
   *     (`applyLaunch`) and `chat-about` by derivation (`applyChatAbout`), and
   *     a chat has no third verb a row can perform: it cannot be completed
   *     (no category vocabulary of its own) and it cannot be terminated (the
   *     runtime is stopped from the composer, which knows whether a turn is in
   *     flight).
   *
   * THE TILE PRINTS WHAT THE ROW ACTUALLY CARRIES. `model`, `mode`,
   * `turnState` and `lastTurnAt` are all on `state` (contract `kind: 'chat'`).
   * The TEAMMATE'S NAME is not — the state carries `teammateId` and nothing
   * else, and a tile that rendered a uuid would be worse than one that renders
   * nothing. The name is visible where the conversation is (the thread header
   * resolves it through `listTeammates`), and putting it on the row needs one
   * server-side join in `entity-read.ts`'s chat arm. Recorded rather than
   * faked.
   */
  {
    kind: 'chat',
    label: 'Chat',
    labelPlural: 'Chats',
    icon: '❝',
    iconArt: KIND_ART.chat,
    slug: 'chats',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '❝', tintBy: 'none' },
    card: { fields: ['excerpt', 'activityAt', 'createdBy'] },
    list: baseList({
      quickCreate: false,
      tile: {
        badges: [
          { source: 'chatTurnState' },
          { source: 'model' },
          { source: 'chatMode' },
          { source: 'chatLastTurnAt' },
          { source: 'messages' },
        ],
      },
      // The header verb is the ONE door a chat is actually born through, and
      // it is `chat-about` rather than `create` for the same reason
      // `quickCreate` is false: the composer is the configuration.
      //
      // `quickStart`, NOT `quickLaunch` — the two are not interchangeable and
      // the difference is exactly this verb's shape: `quickLaunch` carries
      // `flow: 'launch'` and EXPANDS the spawn config in place, while this one
      // commits on click (it navigates to the composer). Declared as
      // `quickLaunch` it would open a five-section execution card for a chat.
      //
      // At the HEADER there is no row, so the verb opens a chat about nothing
      // — which is bare Home's new conversation, the honest reading of "start
      // a chat" from a list of chats. See the action's availability: a subject
      // is optional, not required.
      quickStart: 'chat-about',
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'conversation',
      conversation: 'chat-thread',
      composition: 'chat',
    },
  },

  // -- container (a machine as an entity; migration 177, Design §13.1) --------
  //
  // THE ONLY PLACE THE KIND IS SPELLED. Everything a container looks like —
  // the chip tint, the tile badges, the panel body, the verbs on the bar — is
  // read from this row. `EntityDetailPanel` has NO kind switch: the body comes
  // from `panel.archetype`, and a kind literal outside `domain/` fails the
  // §15.2 build guard. So a change of appearance is an edit HERE, never a
  // branch in a component.
  {
    kind: 'container',
    label: 'Container',
    labelPlural: 'Containers',
    /*
     * `◫`, NOT the `▣` Design §13.1 names. That glyph is already `file`'s
     * (registry.ts:1376), and while the artwork test only guards the DRAWN
     * mark, shipping a duplicate text glyph would re-open the exact defect the
     * icon set was rebuilt to close — two kinds indistinguishable in every
     * string-only surface. `◫` is a divided box, which is what KIND_ART.container
     * draws, so the fallback and the artwork say the same thing.
     */
    icon: '◫',
    iconArt: KIND_ART.container,
    slug: 'containers',
    strategy: 'collection',
    defaultMode: 'list',
    // Board is hidden for work_session's reason, and it applies twice over
    // here: server grouping guards on `state.kind === 'task'`, and a
    // container's status is OBSERVED (the single writer is
    // `public.set_container_status`), so a drag-to-move board column would be
    // a control that cannot commit. Gallery has no image to draw.
    hiddenModes: ['board', 'gallery'],
    /*
     * ALL NINE STATUSES ARE KEYED. A value absent from this map renders the
     * neutral `idle` tone — silently, and NO vitest can see it, because jsdom
     * loads no stylesheets. The map is therefore asserted AS DATA in
     * `registry.test.ts` rather than by reading a rendered colour.
     */
    chip: {
      glyph: '◫',
      tintBy: 'containerStatus',
      tones: {
        requested: 'wait',
        provisioning: 'wait',
        running: 'run',
        paused: 'info',
        stopping: 'wait',
        stopped: 'idle',
        destroying: 'wait',
        destroyed: 'idle',
        failed: 'block',
      },
    },
    card: { fields: ['containerStatus', 'profile', 'provider', 'activityAt'] },
    list: baseList({
      // Same reading as work_session's: a container's category is OBSERVED,
      // and the question this list opens on is "what is running".
      defaultCategory: 'in_progress',
      // Nesting is real (a dind/microvm container may parent children), so the
      // tree is the honest arrangement rather than a flat list.
      tree: { by: 'hierarchy', guideLines: true },
      tile: {
        anatomy: 'session-tree',
        badges: [
          { source: 'containerStatus' },
          { source: 'profile' },
          { source: 'provider' },
          { source: 'isolation' },
          { source: 'createdBy' },
          { source: 'shareMode' },
        ],
        /*
         * NO `pulse` IN P0, and its absence is deliberate rather than
         * forgotten. Design §13.1 asks for `{ signal: 'surface-activity',
         * gate: 'live' }`, but `PulseBinding.signal` is the closed value
         * `'terminal-activity'` and NOTHING emits a surface signal until the
         * surfaces exist (P1/P2). Declaring a pulse now would bind a tile
         * animation to a pool no producer writes to — dead data that reads as
         * a working feature, which is the failure `HANDLED_SOURCES` exists to
         * make loud one field over. The surface lane adds the signal and this
         * binding together.
         */
      },
      liveCount: { filter: NOT_DELETED, label: (n) => `● ${n} running` },
      /*
       * NOT `quickCreate`. The birth verb is `containers.create`, NEVER
       * `entities.create`: `container` joins `CreatableEntityKind`'s exclusion
       * and the node refuses a generic create with "owned by the container
       * lifecycle", exactly as it does for `work_session`. The placeholder flow
       * `quickCreate: true` mounts would therefore be a Create control that
       * always refuses, and a refused control is not a control (the ruling
       * already made for work_session's row).
       */
      quickCreate: false,
      quickStart: 'new-container',
      filters: [attentionFilter],
      sort: DEFAULT_SORT,
      inlineEdit: { title: true },
    }),
    panel: {
      /*
       * A NEW ARCHETYPE (§13.2), and explicitly not a special case of
       * `terminal` — see the `'machine'` member's own note in `types.ts` for
       * why folding it in would put a kind branch inside `WorkSessionContent`.
       */
      archetype: 'machine',
      /*
       * `frame`: the body is a VIEWPORT onto a machine and the panel exists to
       * show it, so no attachment strip and no footer are stapled underneath.
       *
       * READ `MachineBody`'s stylesheet before adding a floored region here.
       * The artifact panel — the other `frame` kind — shipped a section with
       * `min-height: 0` above a child holding a 420px floor, and on a short
       * panel THE FRAME PAINTED STRAIGHT OVER THE BLOCK BELOW IT. MachineBody
       * carries no px floor for exactly that reason.
       */
      composition: 'frame',
      primaries: [
        'container-start',
        'container-stop',
        'container-destroy',
        'container-terminal',
        'container-screen',
      ],
      statusPill: {
        source: 'containerStatus',
        // The chip's map, restated: the pill and the chip must never disagree
        // about what `failed` looks like. `registry.test.ts` asserts they are
        // equal rather than trusting two hand-kept copies.
        tones: {
          requested: 'wait',
          provisioning: 'wait',
          running: 'run',
          paused: 'info',
          stopping: 'wait',
          stopped: 'idle',
          destroying: 'wait',
          destroyed: 'idle',
          failed: 'block',
        },
      },
      /*
       * L6 wording for the capabilities the SERVER turns off. Server truth
       * decides ON/OFF; these only supply the honest sentence.
       */
      capabilityReasons: CONTAINER_CAPABILITY_REASONS,
      z4: { immersive: true },
    },
    palette: { createLabel: 'New container', primaryAction: 'new-container' },
    // Title only. `containers.update` patches title/lifecycle/share/labels, but
    // lifecycle and policy are their own verbs with their own version guards —
    // an `editFields` dialog that offered them would send a bare patch where
    // the contract requires `expectedVersion` on a named command.
    editFields: [
      { target: 'title', label: 'Title', required: true, placeholder: 'build box' },
    ],
  },

  // -- loop (a schedule + a spawn config; each firing edges back triggered_by) --
  {
    kind: 'loop',
    label: 'Loop',
    labelPlural: 'Loops',
    icon: '↻',
    iconArt: KIND_ART.loop,
    createForm: 'scheduled-work',
    editFields: [
      { target: 'title', label: 'Title', required: true, placeholder: 'Daily project sweep' },
      {
        target: 'content', source: 'schedule', label: 'Schedule', required: true,
        placeholder: 'every 1d or 0 9 * * *', valueType: 'schedule',
      },
      {
        target: 'content', source: 'teamMemberId', label: 'Runner entity ID',
        placeholder: 'blank routes through Dispatcher', valueType: 'nullable-text',
      },
      {
        target: 'content', source: 'subjectId', label: 'Subject entity ID',
        placeholder: 'blank uses this loop', valueType: 'nullable-text',
      },
      {
        target: 'content', source: 'prompt', label: 'Prompt',
        placeholder: 'Instruction sent on every firing', multiline: true,
      },
      {
        target: 'content', source: 'config', label: 'Spawn config (JSON)',
        placeholder: '{"model":"…","accessMode":"…"}', multiline: true,
        valueType: 'json-object',
      },
    ],
    slug: 'loops',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '↻', tintBy: 'none' },
    card: { fields: ['excerpt', 'activityAt', 'createdBy'] },
    list: baseList({
      // The scheduled-work form writes the required schedule and first
      // `nextRunAt`; the placeholder-only generic flow cannot create a loop.
      quickCreate: true,
      tile: { badges: [{ source: 'messages' }] },
    }),
    /*
     * GENERIC, because a loop is the one kind a human OPERATES rather than
     * reads: enable/disable and Run now are patch commands, and only the
     * generic body is handed a command executor. `loop-controls` renders the
     * schedule summary and those verbs together, so the fact and the control
     * that changes it cannot drift apart.
     *
     * MERGE NOTE (integration): the memories/loops UI lane declared this panel
     * `profile` — `bio`, a SCHEDULE `field-grid` and a `peer-rows` RUN HISTORY
     * — while the controls lane declared it `generic` with `loop-controls`.
     * Both were right about a fact the other dropped, and the archetype could
     * not be both: `loop-controls` mutates, and `ProfileBody` is presentation
     * that raises intent rather than holding an executor (its own header).
     *
     * So the body follows the VERBS and the read blocks came here instead:
     * `peer-rows` is now drawn by `GenericBody` from the same extracted
     * component `ProfileBody` and `SubtreeBody` use, and the two facts the
     * profile grid carried — the null runner meaning "routed through the
     * Dispatcher", and `lastError` beside `enabled` — moved into the controls
     * summary itself. No fact either lane drew was dropped.
     */
    panel: {
      archetype: 'generic',
      primaries: ['edit'],
      blocks: [
        { block: 'loop-controls', label: 'SCHEDULE' },
        { block: 'fields', label: 'DETAILS' },
        {
          block: 'peer-rows',
          label: 'RUNS',
          params: {
            edgeType: 'triggered_by',
            direction: 'incoming',
            count: true,
            empty: 'No firings recorded yet. Each firing derives a task and edges back here, so this list IS the run history — an empty one means it has not fired.',
          },
        },
        COLLECTIONS_BLOCK,
      ],
    },
    palette: { createLabel: 'New loop' },
  },

  // -- artifact (versioned bundle; bytes served via preview/export, not here) --
  {
    kind: 'artifact',
    label: 'Artifact',
    labelPlural: 'Artifacts',
    icon: '❖',
    iconArt: KIND_ART.artifact,
    slug: 'artifacts',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '❖', tintBy: 'none' },
    card: { fields: ['excerpt', 'activityAt', 'createdBy'] },
    // Generic create is refused for artifacts server-side (contract create
    // resource excludes the kind) — they are born from a publish RPC, so no
    // quickCreate and no generic palette create, exactly like `project`.
    list: baseList({
      quickCreate: false,
      tile: { badges: [] },
      // A FACT KIND (migration 152 `kind_seeds_done`): born `done` as a
      // resolution predicate, with no lifecycle to project. No tab row.
      categories: null,
    }),
    panel: {
      /*
       * THE PANEL IS THE FRAME, AND NOW IT IS ONLY THE FRAME — owner ruling
       * 2026-08-20, closing what the 2026-08-18 ruling started.
       *
       * That pass took the banner, the PREVIEW eyebrow and the empty ＋ tile,
       * and the screen still read as a small window with a filing cabinet under
       * it: DETAILS (five rows of manifest bookkeeping), COLLECTIONS (chips
       * plus an add control), the attachment strip and the footer together held
       * ~320px below a frame floored at 420. `composition: 'frame'` retires the
       * last three at once, and the two blocks come off here.
       *
       * NOTHING IS STRANDED BY THE TWO BLOCKS LEAVING, which is why they could
       * go rather than shrink:
       *   · COLLECTIONS was `contains`/incoming — the same edge the CONNECTIONS
       *     TAB lists, so the membership is still on screen, one tab over. The
       *     WRITE side lives on the collection's own panel ("+ add entity",
       *     membership/outgoing), so adding an artifact to a collection is
       *     untouched.
       *   · Of DETAILS' rows, revision · file count · total size are already in
       *     the frame's accessible name, and entrypoint · manifest sha256 ride
       *     the revision picker's tooltip (see `ArtifactPreviewBlock`).
       *
       * The viewer block still carries NO label: an eyebrow reading PREVIEW
       * over a frame that is visibly a preview is a row of height spent on a
       * word, and this panel's whole job is the frame.
       */
      archetype: 'generic',
      composition: 'frame',
      blocks: [{ block: 'artifact-preview' }],
    },
  },

  // -- worktree (server-provisioned Git checkout; lifecycle rides patch) ----
  {
    kind: 'worktree',
    label: 'Worktree',
    labelPlural: 'Worktrees',
    icon: '⎇',
    iconArt: KIND_ART.worktree,
    slug: 'worktrees',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '⎇', tintBy: 'none' },
    card: { fields: ['activityAt', 'createdBy'] },
    // Worktrees are born only from the server's provisioning saga (generic
    // create is refused server-side, same posture as `artifact`/`project`):
    // no quickCreate, no palette create. Status pill deferred with Phase 5 —
    // it needs a `worktreeStatus` StatusSource wired through the shared
    // status-key maps, which is UI-lane work, not registry data.
    list: baseList({
      quickCreate: false,
      tile: { badges: [] },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'fields', label: 'CHECKOUT' },
        COLLECTIONS_BLOCK,
      ],
      capabilityReasons: {
        canEdit:
          'A worktree accepts exactly one edit: the forward-only status transition (merged / abandoned / deleted). Every other field is immutable after creation.',
      },
    },
  },

  // -- the single custom-kind fallback row ----------------------------------
  {
    kind: CUSTOM_KIND_FALLBACK,
    label: 'Item',
    labelPlural: 'Items',
    icon: '◇',
    iconArt: KIND_ART.custom,
    // Slug is computed per custom kind (`c:{name}` → `c-{name}`); the fallback
    // row itself has none.
    slug: null,
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: [],
    chip: { glyph: '◇', tintBy: 'none' },
    card: { fields: ['customFields', 'activityAt', 'createdBy'] },
    list: baseList({
      tile: { badges: [{ source: 'customFields' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      /* Custom kinds get the COLLECTIONS section for free, like everything
         else on this row: `contains` accepts any dst kind, custom included. */
      blocks: [{ block: 'fields', label: 'FIELDS' }, COLLECTIONS_BLOCK],
    },
  },
];

/**
 * The ONE authority for "which kinds cannot launch" — a DENYLIST, because the
 * answer is now "all of them but one".
 *
 * `derive_task_for_entity` (064) raises for `work_session` and auto-derives a
 * "Work on: <title>" task for every other live kind, so the backend's answer to
 * "can I point an agent at this?" is yes-except-one. Expressing that as ~20
 * hand-written `launchable: true` rows made the common case the one you had to
 * remember, and the flag was in fact missing from eleven kinds that the server
 * would have happily launched — Run simply did not appear on them.
 *
 * Inverted, `launchable` stops being an input a row can forget and becomes
 * DERIVED OUTPUT of this set (see below), so a new kind is launchable by
 * default and opting out is a deliberate, visible edit in one place.
 */
const NOT_LAUNCHABLE: ReadonlySet<string> = new Set([
  // The only refusal, and it is the BACKEND's: `derive_task_for_entity` raises
  // for `work_session`. A session is a run — it is not something you run.
  'work_session',
  //
  // `graph` and `loop` were here briefly, carried over from the `launchable:
  // false` rows this set replaced. Owner ruling 2026-08-17: both launch. Their
  // old rationale argued that Run MEANS something else on those kinds (a graph
  // is orchestrated from the Craft tab; a loop's job is to run something else
  // on a period) — but that is an argument about which verb should be PRIMARY,
  // not about whether an agent can be pointed at the row, and the server will
  // derive a task for either. Whatever else a kind offers, "work on this" is
  // still a coherent thing to ask for.
]);

/**
 * `run` — the launch action, in every place that renders one.
 *
 * The Run button is drawn from three independent arrays — `list.rowActions` (the
 * tile), `panel.primaries` (the detail header) and `palette.primaryAction` — and
 * before this every one of them was hand-written under `kind: 'task'`. That made
 * "which kinds can launch?" a question with three possible answers and no
 * authority, and adding a kind meant remembering all three. Deriving them here
 * means a kind cannot end up half-wired.
 *
 * Additive and idempotent: a row that already names `run` keeps its own ordering
 * (task lists `['run','complete']`, which is deliberate — Run leads), and a
 * denied row is returned untouched rather than rebuilt.
 *
 * `launchable` is written here rather than read here: it is the derived answer
 * to `NOT_LAUNCHABLE`, kept on the config so a consumer can still ask a kind
 * whether it launches without importing the set.
 */
function applyLaunch(row: KindConfig): KindConfig {
  if (NOT_LAUNCHABLE.has(row.kind)) return { ...row, launchable: false };
  row = { ...row, launchable: true };
  const withRun = (actions: readonly ActionRef[] | undefined): ActionRef[] =>
    actions?.includes('run') ? [...actions] : ['run', ...(actions ?? [])];
  return {
    ...row,
    list: { ...row.list, rowActions: withRun(row.list.rowActions) },
    panel: { ...row.panel, primaries: withRun(row.panel.primaries) },
    palette: { ...row.palette, primaryAction: row.palette?.primaryAction ?? 'run' },
  };
}

/**
 * `chat-about` — "open a chat about this", on every row that can BE talked
 * about, which is every row.
 *
 * DERIVED FOR THE SAME REASON `run` IS. The verb is drawn from the tile's
 * `list.rowActions`, and writing it into nineteen arrays by hand would make
 * "which kinds can you open a chat about?" a question with nineteen possible
 * answers and no authority — the exact drift `applyLaunch` was extracted to
 * end. Here it has one answer, and it is the graph's: `about` is registered
 * with `dst_kinds = array['*']` (migration 056:203), so every kind is a legal
 * subject and no per-kind list belongs in this package.
 *
 * TWO EXCLUSIONS, both structural rather than editorial:
 *
 *   · `message` — `strategy: 'anchored'` with `slug: null`. It has no
 *     collection surface, so it has no tile for the verb to sit on; declaring
 *     it would be a control on a list that does not exist.
 *   · `chat` itself — the verb OPENS a chat, and a chat about a chat is a
 *     nesting nobody asked for. Its row still gets the HEADER verb
 *     (`quickStart`), which is where starting a conversation belongs on a list
 *     of conversations.
 *
 * Appended LAST rather than prepended: `run` leads the cluster by ruling
 * (`RULED_ORDER`), and an unranked verb keeps its declared position, so this
 * lands after the kind's own verbs and before the tail's process control.
 * Idempotent — a row that already names it keeps its own ordering.
 */
const NO_CHAT_ABOUT: ReadonlySet<string> = new Set(['message', 'chat']);

function applyChatAbout(row: KindConfig): KindConfig {
  if (NO_CHAT_ABOUT.has(row.kind)) return row;
  const declared = row.list.rowActions ?? [];
  if (declared.includes('chat-about')) return row;
  return { ...row, list: { ...row.list, rowActions: [...declared, 'chat-about'] } };
}

const KINDS: readonly KindConfig[] = ROWS.map(applyLaunch).map(applyChatAbout);

const BY_KIND: ReadonlyMap<string, KindConfig> = new Map(KINDS.map((row) => [row.kind, row]));

const FALLBACK = BY_KIND.get(CUSTOM_KIND_FALLBACK) as KindConfig;

/**
 * Registry lookup. Takes a plain string so unvalidated URL/server values can be
 * passed directly; a MISS falls back to the `c:*` row and never throws — that
 * is how custom kinds land on the generic archetype for free (LLD §2.3).
 */
export function getKind(kind: string): KindConfig {
  return BY_KIND.get(kind) ?? FALLBACK;
}

/** Every row, fallback included. */
export function allKinds(): KindConfig[] {
  return [...KINDS];
}

/** Rows the list-panel kind selector offers: `strategy === 'collection'`. */
export function collectionKinds(): KindConfig[] {
  return KINDS.filter((row) => row.strategy === 'collection' && row.kind !== CUSTOM_KIND_FALLBACK);
}

/** Slug → row, for the `k/{slug}` route and `origin` validation. */
export function kindBySlug(slug: string): KindConfig | null {
  return KINDS.find((row) => row.slug === slug) ?? null;
}

/** The `c:{name}` → `c-{name}` slug for a custom kind, collision-checked by callers. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug);
}

/** The kind a slug addresses, custom kinds included. */
export function kindOfSlug(slug: string): EntityKind | null {
  const row = kindBySlug(slug);
  if (row) return row.kind as CoreEntityKind;
  if (slug.startsWith('c-') && slug.length > 2) return `c:${slug.slice(2)}` as EntityKind;
  return null;
}

/** The slug that addresses a kind (custom kinds computed), or null when it has none. */
export function slugOfKind(kind: string): string | null {
  if (kind.startsWith('c:') && kind.length > 2) return `c-${kind.slice(2)}`;
  return BY_KIND.get(kind)?.slug ?? null;
}
