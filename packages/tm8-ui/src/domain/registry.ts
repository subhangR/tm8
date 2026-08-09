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
  FilterSpec,
  KindConfig,
  ListConfig,
  LifecycleTier,
  ListRowFacts,
  LiveTreatment,
  QueryFilter,
  SortSpec,
  StateControl,
  ValueControl,
} from './types';
import { CUSTOM_KIND_FALLBACK, VIEWER_ACTOR } from './types';
import { KIND_ART } from './kind-art';
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

const TASK_OPEN_STATUSES = ['open', 'pulled', 'working', 'in_review', 'blocked'] as const;
const TASK_CLOSED_STATUSES = ['done', 'cancelled'] as const;

const statusFilter: FilterSpec = {
  id: 'status',
  label: 'Status',
  multi: true,
  options: [
    { id: 'open', label: 'Open', filter: { workStatus: ['open'] } },
    { id: 'pulled', label: 'Pulled', filter: { workStatus: ['pulled'] } },
    { id: 'working', label: 'Working', filter: { workStatus: ['working'] } },
    { id: 'in_review', label: 'In review', filter: { workStatus: ['in_review'] } },
    { id: 'blocked', label: 'Blocked', filter: { workStatus: ['blocked'] } },
    { id: 'done', label: 'Done', filter: { workStatus: ['done'] } },
    { id: 'cancelled', label: 'Cancelled', filter: { workStatus: ['cancelled'] } },
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
  source: 'workStatus',
  label: 'State',
  command: 'set-state',
  options: [
    { id: 'open' },
    { id: 'pulled' },
    { id: 'working' },
    { id: 'in_review' },
    { id: 'blocked' },
    { id: 'done', via: 'complete' },
    { id: 'cancelled' },
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
  label: 'State',
  command: 'set-state',
  options: [
    { id: 'spawning' },
    { id: 'running' },
    { id: 'idle' },
    { id: 'exited' },
    { id: 'failed' },
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
 * THE `deleted` CHIP IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It offered `Hide deleted` / `Deleted only` — the two values the lifecycle
 * TABS already are: Open and Done both carry `deleted: 'exclude'`, Archived
 * carries `deleted: 'only'`. `deleted` is a scalar, so a chip and a tab naming
 * it could only ever CONTRADICT each other, and the merge resolved that by
 * letting whichever applied last win. Choosing `Deleted only` on the Open tab
 * silently showed archived rows under a tab labelled Open; choosing
 * `Hide deleted` on the Archived tab emptied it with no explanation.
 *
 * A chip that can only agree with the tab or overrule it is not a filter, it
 * is a second control for the same axis. Deleting it leaves one control per
 * axis, which is also what makes `narrow`'s contradiction rule safe to apply
 * strictly below.
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
 * `dueDate` and `priority` are missing on purpose: server-side both coalesce
 * absent values to a sentinel (`9999-12-31`, rank 3), so on a kind with no due
 * date every row ties and the list falls through to its id tiebreak. That
 * renders as "sorted" and is shuffled — the same class of lie as a saturated
 * page calling itself complete. A kind opts INTO those two by having them.
 */
const DEFAULT_SORT: readonly SortSpec[] = [BY_ACTIVITY, also(BY_UPDATED), BY_CREATED, BY_POSITION];

/** The shape every kind gets before its own divergence is layered on. */
function baseList(overrides: Partial<ListConfig> & Pick<ListConfig, 'tile'>): ListConfig {
  return {
    quickCreate: true,
    filters: [assigneeFilter, attentionFilter],
    sort: DEFAULT_SORT,
    // Universal by DEFAULT (D41): a kind opts into a richer partition, never
    // out of having tiers at all. A row that forgot them would silently lose
    // its tabs, so absence is not an available state.
    lifecycle: statelessTiers(),
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// Lifecycle tiers (D41) — Open / Done / Archived, universal on collection kinds
// ---------------------------------------------------------------------------

/**
 * `archived` is the honest one: `deleted: 'only'` is a real `CollectionQuery`
 * member, so the archive tier is a genuine query for EVERY kind rather than an
 * invention. `open`/`done` are only expressible where the kind carries a state
 * axis the contract knows — task via `workStatus`, work_session via
 * `sessionStatus` (D56). Everywhere else `done` is declared UNSUPPORTED with its
 * reason: the tab renders, its count is honestly zero, and nothing fabricates
 * a completion concept the backend cannot answer for.
 */
const ARCHIVED_TIER: LifecycleTier = {
  id: 'archived',
  label: 'Archived',
  filter: { deleted: 'only' },
};

const NO_DONE_REASON =
  'This kind has no completion state on this node — the contract records no done/closed concept for it, so nothing can honestly land here.';

/** The default tiers for a kind with no state axis: open, an honest-empty done, archived. */
function statelessTiers(): readonly LifecycleTier[] {
  return [
    { id: 'open', label: 'Open', filter: NOT_DELETED },
    { id: 'done', label: 'Done', filter: NOT_DELETED, unsupported: NO_DONE_REASON },
    ARCHIVED_TIER,
  ];
}

const TASK_TIERS: readonly LifecycleTier[] = [
  { id: 'open', label: 'Open', filter: { workStatus: [...TASK_OPEN_STATUSES], deleted: 'exclude' } },
  { id: 'done', label: 'Done', filter: { workStatus: [...TASK_CLOSED_STATUSES], deleted: 'exclude' } },
  ARCHIVED_TIER,
];

// D56 — the D20 workaround is GONE. `CollectionQuery.filters.sessionStatus`
// exists now (contract dd41e89), so these are ordinary contract filters the
// seam executes untranslated, exactly like the task tiers beside them. No
// client-side partition, no structural read on the row, nothing to remember.
const SESSION_TIERS: readonly LifecycleTier[] = [
  {
    id: 'open',
    label: 'Open',
    filter: { sessionStatus: ['spawning', 'running', 'idle'], deleted: 'exclude' },
  },
  { id: 'done', label: 'Done', filter: { sessionStatus: ['exited', 'failed'], deleted: 'exclude' } },
  ARCHIVED_TIER,
];

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
 * 'NEEDS YOU' grouping — designed-but-dormant per R8. The predicate is real
 * and the group renders whenever it fires; no server detection exists in this
 * program, so on real data it stays quiet. It consumes the seam verdict and
 * the row's own recorded status — it derives neither.
 */
const sessionNeedsAttention = (row: ListRowFacts, live: SessionLiveness): boolean =>
  live === 'live' && row.status === 'idle';

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

const ROWS: readonly KindConfig[] = [
  // -- task -----------------------------------------------------------------
  {
    kind: 'task',
    launchable: true,
    label: 'Task',
    labelPlural: 'Tasks',
    icon: '◻',
    iconArt: KIND_ART.task,
    slug: 'tasks',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: [],
    chip: {
      glyph: '◻',
      tintBy: 'workStatus',
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
    card: { fields: ['workStatus', 'priority', 'assignees', 'acceptance'] },
    list: baseList({
      sections: [
        {
          id: 'current',
          label: 'Current',
          filter: { workStatus: [...TASK_OPEN_STATUSES], deleted: 'exclude' },
        },
        {
          id: 'completed',
          label: 'Completed',
          filter: { workStatus: [...TASK_CLOSED_STATUSES], deleted: 'exclude' },
          collapsedByDefault: true,
        },
      ],
      tree: { by: 'hierarchy', guideLines: true },
      tile: {
        anatomy: 'control-card',
        badges: [
          { source: 'workStatus' },
          { source: 'priority' },
          { source: 'assignees' },
          { source: 'acceptance' },
          { source: 'blocked' },
          { source: 'pulls' },
          { source: 'workingActors' },
        ],
      },
      lifecycle: TASK_TIERS,
      primaryActions: ['run', 'coordinate'],
      filters: [assigneeFilter, taskAttentionFilter, statusFilter, readyToPullFilter],
      sort: [...DEFAULT_SORT, BY_DUE, BY_PRIORITY],
      inlineEdit: { status: true, title: true },
      stateControl: TASK_STATE_CONTROL,
      valueControls: [TASK_PRIORITY_CONTROL],
      assignControl: TASK_ASSIGN_CONTROL,
      // A2: the board groups by the same field the state picker writes. The
      // server computes the groups (collections.ts groupItems); the client
      // never groups (L3).
      board: { groupBy: 'workStatus' },
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
      ],
      // The detail header keeps one task action: Run. Coordinate and Complete
      // remain available from their task-specific surfaces, not this compact
      // panel toolbar.
      primaries: ['run'],
      statusPill: {
        source: 'workStatus',
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
      lifecycle: SESSION_TIERS,
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
      rowActions: ['complete', 'terminate'],
      stateControl: SESSION_STATE_CONTROL,
    }),
    panel: {
      archetype: 'terminal',
      // USER RULING 2026-07-29: terminal panels use the same compact two-row
      // geometry as tasks. Keep the destructive session verb at the right of
      // the tab row; Complete remains available from `rowActions`, where it
      // does not squeeze the title/tabs/window controls or the terminal canvas.
      primaries: ['terminate'],
      statusPill: {
        source: 'sessionStatus',
        tones: { spawning: 'wait', running: 'run', idle: 'info', exited: 'idle', failed: 'block' },
      },
      // Availability is still pin-projected at the panel mount: the registry
      // declares the complete work-session surface vocabulary, not permission.
      contentSurfaces: ['terminal', 'chat'],
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
    launchable: true,
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
    panel: { archetype: 'hub', composition: 'chat', primaries: ['edit', 'add-child'] },
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
        { block: 'items', label: 'CURRENT WORK', params: { source: 'work', statusKey: 'workStatus' } },
      ],
    },
  },

  // -- team_member ----------------------------------------------------------
  {
    kind: 'team_member',
    launchable: true,
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
    launchable: true,
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
      blocks: [
        { block: 'link-summary', label: 'PULL REQUEST' },
        { block: 'fields', label: 'DETAILS' },
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
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'link-summary', label: 'COMMIT' },
        { block: 'fields', label: 'DETAILS' },
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
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'file-preview', label: 'PREVIEW' },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
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
        { block: 'items', label: 'ITEMS' },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
    palette: { createLabel: 'New collection' },
  },

  // -- project (restricted: generic create/patch/delete/move refused) -------
  {
    kind: 'project',
    launchable: true,
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
    launchable: true,
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

  // -- loop (a schedule + a spawn config; each firing edges back triggered_by) --
  {
    kind: 'loop',
    // NOT launchable: "Run" on a loop would mean "run the loop entity", but a
    // loop's whole job is to run something ELSE on a period. Its primary
    // actions are enable/disable and fire-now, which are patches, not launches.
    launchable: false,
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
      ],
    },
    palette: { createLabel: 'New loop' },
  },

  // -- artifact (versioned bundle; bytes served via preview/export, not here) --
  {
    kind: 'artifact',
    launchable: true,
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
    }),
    panel: {
      // Same shape `file` uses: a preview block first, then the detail fields.
      archetype: 'generic',
      blocks: [
        { block: 'artifact-preview', label: 'PREVIEW' },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
  },

  // -- worktree (server-provisioned Git checkout; lifecycle rides patch) ----
  {
    kind: 'worktree',
    launchable: true,
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
      blocks: [{ block: 'fields', label: 'FIELDS' }],
    },
  },
];

/**
 * `launchable: true` → the `run` action, in every place that renders one.
 *
 * The Run button is drawn from three independent arrays — `list.rowActions` (the
 * tile), `panel.primaries` (the detail header) and `palette.primaryAction` — and
 * before this every one of them was hand-written under `kind: 'task'`. That made
 * "which kinds can launch?" a question with three possible answers and no
 * authority, and adding a kind meant remembering all three. Deriving them here
 * means a kind opts in ONCE and cannot end up half-wired.
 *
 * Additive and idempotent: a row that already names `run` keeps its own ordering
 * (task lists `['run','complete']`, which is deliberate — Run leads), and a row
 * without the flag is returned untouched rather than rebuilt.
 */
function applyLaunch(row: KindConfig): KindConfig {
  if (!row.launchable) return row;
  const withRun = (actions: readonly ActionRef[] | undefined): ActionRef[] =>
    actions?.includes('run') ? [...actions] : ['run', ...(actions ?? [])];
  return {
    ...row,
    list: { ...row.list, rowActions: withRun(row.list.rowActions) },
    panel: { ...row.panel, primaries: withRun(row.panel.primaries) },
    palette: { ...row.palette, primaryAction: row.palette?.primaryAction ?? 'run' },
  };
}

const KINDS: readonly KindConfig[] = ROWS.map(applyLaunch);

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
