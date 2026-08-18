/**
 * THE KIND REGISTRY — type vocabulary (LLD §2.1–§2.5).
 *
 * L2: per-kind divergence lives in registry DATA. A per-kind behavior with no
 * field in this file is a SPEC DEFECT, never an inline `if (kind === …)`.
 * Everything here is data-shaped on purpose: the two universal primitives read
 * these shapes and branch on nothing.
 *
 * Contract vocabulary is consumed VERBATIM (`QueryFilter`, `SortKey`,
 * `CollectionMode` are the contract's own anonymous `CollectionQuery` members,
 * not invented symbols) so a config can be executed by the seam without
 * translation.
 */
import type {
  CollectionQuery,
  CoreEntityKind,
  CustomEntityKind,
  EntityCapabilities,
  EntityId,
  EntityKind,
  SpaceId,
} from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type { PillTone } from '../kit';
import type { KindArt } from './kind-art';
import type { LaunchMode } from './launch';

// ---------------------------------------------------------------------------
// Contract-derived vocabulary (cite the member, never an invented type)
// ---------------------------------------------------------------------------

/** The contract's anonymous `CollectionQuery['filters']` member. */
export type QueryFilter = NonNullable<CollectionQuery['filters']>;
/** The contract's `CollectionQuery['sort']` union. */
export type SortKey = NonNullable<CollectionQuery['sort']>;
/** The six collection layouts — the contract's `CollectionQuery['layout']` union. */
export type CollectionMode = NonNullable<CollectionQuery['layout']>;
/** The contract's `CollectionQuery['groupBy']` union (board axis picker, D2). */
export type GroupByKey = NonNullable<CollectionQuery['groupBy']>;

/**
 * A serialized route hash (`#/s/{spaceId}/…`). Declared here rather than in
 * `routes/` because the import DAG runs domain ← routes: `routeBuilder` needs
 * the type and the registry may not import the codec.
 */
export type Hash = string;

/**
 * A glyph reference — a literal text character.
 *
 * This WAS how kinds were marked everywhere. It is now the fallback half of a
 * pair: `KindConfig.iconArt` carries the drawn mark the UI renders, and this
 * carries the character a string-only surface can still print. Actions
 * (`ActionDef.icon`) remain text-only — a verb's mark sits inside a 22px
 * control next to its own word, which is a different problem from telling
 * twenty KINDS apart at a glance.
 */
export type IconRef = string;

// ---------------------------------------------------------------------------
// Z1 / Z2 presentation specs
// ---------------------------------------------------------------------------

/**
 * The closed set of `EntityState` / `EntityBadges` sources a tile or card may
 * present. Closed on purpose: §15.1's behavior↔field matrix walks it, and a
 * display need outside this list is a new source (data), never a branch.
 */
export type TileBadgeSource =
  // task
  | 'workStatus'
  | 'priority'
  | 'assignees'
  | 'acceptance'
  | 'dueDate'
  | 'axes'
  // graph-wide badges (EntityBadges)
  | 'blocked'
  | 'pulls'
  | 'workingActors'
  | 'restricted'
  // work_session
  | 'sessionStatus'
  | 'agentTool'
  | 'model'
  | 'shareMode'
  // other kinds
  | 'channelTopic'
  | 'unread'
  | 'workingAgents'
  | 'docFormat'
  | 'childCount'
  | 'entityActor'
  | 'createdBy'
  | 'memberRole'
  | 'score'
  | 'taskDoneCount'
  | 'owner'
  | 'liveWork'
  | 'repository'
  | 'prState'
  | 'sha'
  | 'mimeType'
  | 'sizeBytes'
  | 'equipped'
  | 'collectionType'
  | 'itemCount'
  | 'projectVersion'
  | 'profileStatus'
  | 'profileVersions'
  | 'messageAuthor'
  | 'customFields'
  // counters, present on every summary
  | 'points'
  | 'messages';

export interface TileBadgeSpec {
  source: TileBadgeSource;
  /** Suppress the badge entirely when the source carries no value (default true). */
  hideWhenEmpty?: boolean;
}

/**
 * The declarative pulse binding (F1). NOT a function of `EntitySummary`:
 * presence comes from the §9.2 pool terminal-activity signal, gated on a
 * `live` verdict from `seam.liveness.statusOf`. Deriving a pulse from summary
 * recency is the forbidden inference class (D6).
 */
export interface PulseBinding {
  signal: 'terminal-activity';
  gate: 'live';
}

/**
 * The `EntityState` scalar a status pill / Z1 chip tint reads. `'none'` = the
 * kind has no status axis and renders no pill.
 */
export type StatusSource =
  | 'workStatus'
  | 'sessionStatus'
  | 'prState'
  | 'profileStatus'
  | 'memberRole'
  | 'equipped'
  | 'none';

/** Z1 — kind chip: glyph + state tint mapping. */
export interface ChipSpec {
  glyph: IconRef;
  /** Which state scalar drives the tint. */
  tintBy: StatusSource;
  /** value → tone. A value absent from the map renders the neutral `idle` tone. */
  tones?: Readonly<Record<string, PillTone>>;
}

/** Z2 — summary card: 2–4 fields off `EntityState` (asserted by §15.1). */
export interface CardSpec {
  fields: readonly CardFieldRef[];
}

export type CardFieldRef = TileBadgeSource | 'excerpt' | 'activityAt' | 'createdBy' | 'parent';

/** Header status pill: which state scalar feeds it, and the color WORD per value. */
export interface StatusPillSpec {
  source: StatusSource;
  tones: Readonly<Record<string, PillTone>>;
  /** Display word per value; falls back to the raw value humanized. */
  labels?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Filters & sort
// ---------------------------------------------------------------------------

/** One filter chip in the list/collection filter row. */
export interface FilterSpec {
  id: string;
  label: string;
  /** Chip options; the selected option's filter merges into the CollectionQuery. */
  options: readonly FilterOption[];
  /** Chips whose options combine rather than replace (status is multi, assignee is not). */
  multi?: boolean;
}

export interface FilterOption {
  id: string;
  label: string;
  filter: QueryFilter;
}

/**
 * THE VIEWER, WRITTEN AS DATA.
 *
 * "Assigned to me" and "Needs me" are the two filters the user asked for, and
 * both name a person the registry cannot know: the registry is a static module
 * evaluated once at import, and the viewer is a per-session fact. Writing them
 * as a `kind === … ? myId : …` branch is exactly what §15.2 forbids, and
 * passing the id into the registry would make it a function of the session.
 *
 * So the option's filter carries this SENTINEL where an actor id goes, and the
 * panel substitutes the real id at merge time. The vocabulary stays data, the
 * identity stays runtime, and neither one learns about the other.
 *
 * UNRESOLVED IS REFUSED, NEVER SILENT. A viewer-scoped option offered with no
 * id to put in it would query `assigneeIds: ['@me']` and return zero rows —
 * "you have nothing assigned" instead of "I do not know who you are". The
 * panel disables the option and says so.
 */
export const VIEWER_ACTOR = '@me';

/** Does this option's filter name the viewer, and so need an id to be usable? */
export function needsViewer(filter: QueryFilter): boolean {
  return Object.values(filter as Record<string, unknown>).some((value) =>
    Array.isArray(value) ? value.includes(VIEWER_ACTOR) : value === VIEWER_ACTOR,
  );
}

export interface SortSpec {
  key: SortKey;
  label: string;
  /** Exactly one entry per kind carries this (asserted by §15.1). */
  default?: boolean;
}

/**
 * Paging truth for ONE (filter, sort) read, supplied by the shell.
 *
 * Declared here rather than beside the hook that produces it because both the
 * producer (`useGateData`) and the consumer (`EntityListPanel`) need it, and
 * the panel must not import from `views/` — the dependency runs the other way.
 */
export interface ListPageState {
  /** The server left a cursor: there are rows beyond the ones delivered. */
  hasMore: boolean;
  /** A page is in flight (including the first, before anything has arrived). */
  loading: boolean;
  /**
   * Exact size of the whole match, when the server volunteered one.
   *
   * Absent is the normal case today — the facade does not populate
   * `Page.total` — and absent MUST render as `N+` while `hasMore`, never as
   * `N`. That conflation is the defect: a 601-row Done tab reported `50`
   * because the first page was full and nobody asked what full meant.
   */
  total?: number;
}

/** How many rows a list is showing, said honestly. */
export function countLabel(shown: number, page?: ListPageState): string {
  if (page?.total !== undefined) return String(page.total);
  return page?.hasMore ? `${shown}+` : String(shown);
}

// ---------------------------------------------------------------------------
// Liveness presentation (never derivation — R-UI-5, §10.2.2)
// ---------------------------------------------------------------------------

/**
 * How a `SessionLiveness` VERDICT presents. The verdict comes exclusively from
 * `seam.liveness.statusOf`; this shape only decides how it looks and whether
 * the row's click target may attach to a terminal. `unknown` is neutral, never
 * live (D6).
 */
export interface LiveTreatment {
  /**
   * The WORD the VERDICT alone justifies. Status is always color + word
   * (C8/L10). A live session with no bytes moving reads `running` — `live` is
   * the live-session BAR's count word (`● N live`), never a row's.
   */
  label: string;
  tone: PillTone;
  /** The steady verdict dot. `pulse` belongs to the activity source, not here. */
  dot: 'solid' | null;
  /** May the row open a live terminal host? */
  attachable: boolean;
  /** Honest explanation for the degraded verdicts (rendered as the disabled reason). */
  reason?: string;
  /**
   * The word to show INSTEAD of `label` while the §9.2 pool activity signal is
   * firing — the second source, gated on this same `live` verdict (F1, D6).
   * Present only on verdicts where streaming is possible, so activity can
   * REFINE a live verdict and can never promote a non-live one: a verdict with
   * no `streamingLabel` has no streaming presentation to reach for.
   */
  streamingLabel?: string;
  /**
   * The compact form for width-constrained slots — the 220px/200px panel
   * floors and the 34px chrome strip's 9.5px pill. Consumers render
   * `shortLabel ?? label`, so a verdict whose label already fits needs none.
   *
   * The canvas rules this, it is not an invention: T0-3 frame 4 draws the
   * 220px Sessions panel with the word `stale` and captions it "state word
   * survives; 'node restarted' moves to detail". The long form is never lost —
   * it stays on `title` and in the detail body, so a hover or a screen reader
   * still reaches the full sentence.
   *
   * Why it lives HERE and not in a compact branch: D22 — the words live in the
   * registry, not in a render path. Otherwise every width-constrained surface
   * re-derives its own abbreviation and they drift.
   */
  shortLabel?: string;
}

// ---------------------------------------------------------------------------
// Actions (§2.5) — the single place a verb exists
// ---------------------------------------------------------------------------

/**
 * Closed vocabulary. Tile quick-actions, panel primaries, ⌘Enter and palette
 * rows all resolve through it, so the same verb is never wired twice. The
 * trailing group is the R7 deferred set: they exist so the palette can render
 * them disabled-with-reason (never hidden, never built).
 */
export type ActionRef =
  // entity verbs
  | 'open'
  | 'create'
  | 'complete'
  | 'set-state'
  // D67 — archive is the TOMBSTONE (`entities.delete` / `entities.restore`),
  // the one lifecycle bit every kind shares. Named `archive` rather than
  // `delete` because that is what the Archived lifecycle tier reads back:
  // the tier is `deleted: 'only'`, so the verb and the tab describe one act.
  | 'archive'
  | 'restore'
  | 'pull'
  | 'link'
  // Opens the kind's `editFields` dialog. A SEPARATE VERB from the inline
  // title editor on purpose: inline edit reaches exactly one member (the
  // title) with one gesture, and a kind whose shape needs more than that —
  // a channel's optional topic, the members roster that lands next — has
  // nowhere to put the rest. Rendered only where `editFields` is declared,
  // so a kind that has nothing to edit does not grow an empty dialog.
  | 'edit'
  | 'add-child'
  | 'react'
  | 'grant-points'
  // execution verbs (R-UI-6)
  | 'run'
  | 'coordinate'
  | 'launch-session'
  // A VANILLA TERMINAL (101) — a shell session with no agent attached. Its own
  // verb rather than `launch-session` with a null tool, because it opens no
  // launch config: there is no teammate, model or profile to choose, so the
  // two-clicks-to-launch rule that governs a spawn has nothing to show in
  // between and the verb commits directly.
  | 'start-terminal'
  | 'terminate'
  | 'prompt-session'
  // §8 share-into-session (seam-deferred, §10.7)
  | 'share-into-session'
  | 'withdraw-handoff'
  // chrome
  | 'toggle-theme'
  // B10 (git placement map §4.3): merge the PR — the sanctioned landing
  // path for a lane, deferred until a forge WRITE client exists.
  | 'merge-pr'
  // R7 deferred discovery rows (§4.2 disposition table)
  //
  // `graph-view` was a member here until 2026-08-15. Graph shipped as a route
  // and a rail destination, never as a verb, so retiring its deferral removed
  // the ref outright instead of promoting it — see `domain/actions.ts`.
  | 'undo'
  | 'version-history'
  | 'leaderboard'
  | 'awards'
  | 'saved-views'
  | 'search-results'
  | 'activity-screen'
  | 'add-server'
  // T0-4 kind primaries (Surface Audit 2026-07-29: drawn in the canvas,
  // absent from this union — the vocabulary edit precedes any registry
  // wiring, because a verb that cannot exist as DATA cannot surface).
  | 'equip'
  | 'refresh'
  | 'untrust'
  | 'unlink'
  | 'set-as-default'
  | 'mark-read'
  | 'quote';

export type ActionAvailability = { kind: 'available' } | { kind: 'disabled'; reason: string };

/**
 * Outcome of a state write, for surfaces that must render the refusal INLINE
 * where the act happened (board §1.5: column-header reason, no toasts). The
 * dropdown path keeps its notice; the board asks for the outcome instead.
 */
export type SetStateOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Everything an action needs to decide availability and to run, with NO seam
 * import: the shell injects `dispatch`, so `domain/` stays free of `data/`
 * beyond the `SessionLiveness` verdict type.
 */
export interface ActionContext {
  spaceId: SpaceId;
  entityId?: EntityId;
  kind?: EntityKind;
  /** Server truth (`EntityDetail.capabilities`). Absent ⇒ unknown, not permitted. */
  capabilities?: EntityCapabilities | null;
  /** Seam verdict for work_session targets. Never computed here. */
  liveness?: SessionLiveness;
  /**
   * WHO IS LOOKING — the viewer's own actor id in this space, resolved by the
   * shell from the identity read.
   *
   * The one input the viewer-scoped filters (`VIEWER_ACTOR`) need. Optional
   * because it genuinely can be unknown (identity not read yet, or a fixture
   * seam with no memberships), and those filters then refuse rather than
   * quietly matching nobody.
   */
  viewerActorId?: EntityId;
  /**
   * Ops the facade has already refused this session (LLD §10.3 gate 2):
   * catalog op name → the honest reason. One probe per op, cached by the shell.
   */
  opUnavailable?: Readonly<Record<string, string>>;
  /** Injected executor; actions never import the seam. */
  dispatch?: ActionDispatch;
}

export interface ActionIntent {
  action: ActionRef;
  entityId?: EntityId;
  payload?: unknown;
}

export type ActionDispatch = (intent: ActionIntent) => Promise<void>;

export interface ActionDef {
  id: ActionRef;
  label: string;
  icon: IconRef;
  availability(ctx: ActionContext): ActionAvailability;
  run(ctx: ActionContext): Promise<void> | void;
  /**
   * D44: this verb opens a CONFIGURATION FLOW before it dispatches. `run` is
   * still the single entry point — surfaces call it and the shell opens the
   * flow — so the tile button, the panel primary, ⌘Enter and the palette row
   * all reach the same launch config rather than one of them firing a bare
   * spawn. A verb without `flow` dispatches immediately, as before.
   *
   * `'merge-pr'` (B10) joins for a different reason than `'launch'`: not
   * configuration, but CONFIRMATION. `tracking.pr.merge` refuses from facts
   * this context does not carry — PR state, mergeability, CI — and widening
   * `ActionContext` with them would put one kind's words on the shared type
   * every verb sees (§15.2). So the action bar's verb gates on op availability
   * only, and the flow surface owns the fact-refusals: the click that
   * discovers a refusal is the click that reads it.
   */
  flow?: 'launch' | 'merge-pr';
  /**
   * The session mode this flow verb commits, when it is not the default.
   *
   * DATA, because the alternative is a surface asking `ref === 'coordinate'` —
   * an action-id literal of exactly the kind §15.2 keeps out of components.
   * Every launch verb shares ONE config, and before this existed the config
   * seeded `mode: 'worker'` unconditionally: pressing **Coordinate** opened
   * Run's card and spawned a WORKER. The button named one thing and did
   * another. A verb that omits this gets the config's own default.
   */
  launchMode?: LaunchMode;
}

// ---------------------------------------------------------------------------
// ListConfig (§2.2) — EntityListPanel behavior as data
// ---------------------------------------------------------------------------

export interface ListSection {
  id: string;
  label: string;
  filter: QueryFilter;
  collapsedByDefault?: boolean;
}

/**
 * A lifecycle TIER — the Open / Done / Archived tabs the composed T0-1 canvas
 * draws on EVERY collection kind (user-ratified 2026-07-28, D41).
 *
 * A tier is a different axis from a `ListSection`: the tier is the lifecycle
 * band you are looking at, the sections are triage grouping WITHIN it. T0-1
 * draws both at once — tabs above, `NEEDS ATTENTION` / `IN PROGRESS` group
 * headers below — so neither supersedes the other.
 *
 * `filter` stays contract-shaped, and every tier is now honestly expressible:
 * `deleted: 'only'` is a real `CollectionQuery` member, and so — since phase 1 —
 * is `category`.
 *
 * D56: the D20 client-side partition is RETIRED. `CollectionQuery.filters`
 * gained a `sessionStatus` member (contract dd41e89), so every tier now carries
 * a contract-shaped filter the seam executes untranslated — including
 * work_session, which was the only kind that ever needed the workaround.
 *
 * PHASE 5 (migration 152): `unsupported` IS GONE. It existed for the kinds the
 * contract recorded no done/closed concept for, and there are none left — every
 * kind has a workflow and every entity a status, so every tier of every kind is
 * a query that can return rows. A tier that cannot be populated is no longer a
 * state this type can represent, which is the point: the field was the honest
 * name for a hole, and the hole is filled.
 */
export interface LifecycleTier {
  id: 'open' | 'done' | 'archived';
  label: string;
  filter: QueryFilter;
}

export interface ListConfig {
  /** task: current / completed. */
  sections?: readonly ListSection[];
  /**
   * Open / Done / Archived — universal across collection kinds (D41).
   *
   * Counts are NOT a field here. Each tier's count is its own query's
   * `CollectionResult.page.total`, which feeds the tab label, the footer line
   * ("9 open · 601 done · 33 archived") and the kind-selector total from ONE
   * source. A count field would be a second source that could disagree with
   * the query it claims to summarise.
   */
  lifecycle?: readonly LifecycleTier[];
  /** task subtree; session coordinator→worker. */
  /**
   * `messagePulse` binds the tree's hairlines to live message provenance: a
   * message from one row to another sweeps the wires between them. It is a
   * BINDING, not a predicate — like `tile.pulse`, it subscribes to a signal the
   * panel is handed and never derives one. Requires `guideLines`, since it
   * animates the wire those draw.
   */
  tree?: { by: 'hierarchy'; guideLines: boolean; messagePulse?: boolean };
  tile: {
    badges: readonly TileBadgeSpec[];
    /**
     * Registry-selected card anatomy. `control-card` is the Maestro-shaped
     * work surface: a strong command row with an expandable facts/config
     * region. The component still knows presentation data, never entity kinds.
     */
    anatomy?: 'standard' | 'control-card' | 'session-tree';
    /** The two-source law: pool activity signal, gated on a `live` verdict (F1). */
    pulse?: PulseBinding;
  };
  /** '● N live'. The count is rows ∩ the seam liveness snapshot, never a derivation. */
  liveCount?: { filter: QueryFilter; label: (n: number) => string };
  quickCreate: boolean;
  quickLaunch?: ActionRef;
  /**
   * A second header verb, rendered BESIDE `quickLaunch` (user ruling
   * 2026-08-12: "these options should be on the top of sessions entity list
   * panel", "beside launch session").
   *
   * Separate from `quickLaunch` rather than a list, because the two are not
   * interchangeable: `quickLaunch` carries `flow: 'launch'` and EXPANDS a
   * config, while this one commits on click. Collapsing them into one array
   * would put that difference in the reader's head instead of in the type.
   */
  quickStart?: ActionRef;
  primaryActions?: readonly ActionRef[];
  filters: readonly FilterSpec[];
  sort: readonly SortSpec[];
  /** 'NEEDS YOU' grouping — designed-but-dormant (R8). Consumes the verdict. */
  needsAttentionGroup?: (summary: ListRowFacts, live: SessionLiveness) => boolean;
  /** Presentation of the seam verdict — never its computation (R-UI-5). */
  liveTreatment?: (live: SessionLiveness) => LiveTreatment;
  /** WLT §3 'inline status/edit' on tiles; both capability-gated per row. */
  inlineEdit?: { status?: boolean; title?: boolean };
  /** WLT §3 'inline complete' + the R-UI-6 verbs, kind-scoped. */
  rowActions?: readonly ActionRef[];
  /**
   * The expanded row's STATE PICKER (D67, user ruling 2026-08-02: "in every
   * entity list style, each entity should have an option to change its state
   * as a dropdown when the entity is expanded on the entity list itself").
   *
   * Absent means this kind HAS NO SETTABLE STATE, and the expanded row states
   * that rather than drawing a dead control — 14 of 19 core kinds carry no
   * state field at all, and a dropdown over an empty vocabulary would be the
   * fabrication L6 forbids.
   */
  stateControl?: StateControl;
  /**
   * OTHER settable enum fields the expanded row offers — priority, today.
   *
   * SEPARATE FROM `stateControl` because the two are written differently and
   * the difference is not cosmetic: a state goes through a COMMAND VERB
   * (`entities.commands.work` / `complete`, unversioned, with side effects on
   * the actor's `working_on` edge), while these go through the kind's ordinary
   * content PATCH and are therefore version-guarded. Folding them into one
   * control would force one dispatch rule onto two operations with different
   * guarantees, and the 409 path would have nowhere to live.
   *
   * A plural list rather than a `priorityControl` field, because nothing here
   * is about priority: it is "an enum member of `EntityState` this kind lets a
   * user set", and the second one must not need a new prop.
   */
  valueControls?: readonly ValueControl[];
  /**
   * The expanded row's ASSIGNEE picker. Absent ⇒ this kind is not assignable.
   *
   * Assignment is neither a state nor a content field: `state.assignees` is a
   * PROJECTION of `assigned_to` edges (server `entity-read.ts:551`), so it is
   * written by creating and deleting edges, not by patching the entity. Its
   * own declaration, for the same reason `valueControls` is not `stateControl`.
   */
  assignControl?: AssignControl;
  /**
   * The expanded row's PER-SPACE AXIS pickers (`state.axes`, migration 001's
   * `task_axes` registry).
   *
   * SEPARATE FROM `valueControls` because the vocabulary is not the registry's
   * to declare: a `ValueControl` carries a static `options` list, while an
   * axis's legal values are PER-SPACE DATA the host reads from the node
   * (`spaceSettings().taskAxes`) and hands over as `ControlHost.taskAxes`.
   * Presence here only marks the kind whose state carries the `axes` record;
   * a space with no axes renders no control at all, and a second axis arrives
   * by server data alone — no registry edit, which is the whole point.
   *
   * The write is also different from `valueControls`: the server stores axes
   * as ONE jsonb the patch replaces wholesale (`update_task_content`:
   * `axes = coalesce(p_axes, axes)`, 038), so the executor merges the record
   * before writing — one axis moves and the others survive.
   */
  axisControls?: { source: 'axes' };
  /**
   * Board mode (A2, doc 06 §1). Presence IS the declaration — a kind without
   * this field keeps its switcher position honestly disabled.
   *
   * Deliberately ONLY the grouping axis. Column vocabulary and ORDER come from
   * `stateControl.options`; header words and tones from `panel.statusPill` —
   * the same single sources the state picker and the collapsed row's pill
   * already read, so the picker, the pill and the column cannot drift. A label
   * or tone field here would be the second copy that disagrees first.
   */
  board?: { groupBy: GroupByKey };
  /**
   * Curated-set membership on the LIST surface (the `contains` pair,
   * migration 101): the expanded row's "Collections" picker, and the list's
   * collection LENS — pick a set and the list narrows to its members via the
   * contract's `filters.edge` clause, which the server already executes.
   *
   * ITS OWN FIELD, NOT `assignControl`, because the write is different in
   * kind: an assignment is an edge FROM this row to an actor, written by the
   * generic edge verbs; membership is an edge FROM the set TO this row,
   * written by the `collections.addItem`/`removeItem` pair (auto-position,
   * pair-addressed remove). Folding them together would force one dispatch
   * rule onto two operations — the same reason `valueControls` is not
   * `stateControl`.
   */
  membership?: MembershipListControl;
}

/**
 * The list surface's membership declaration. The panel never spells the edge
 * or the set kind itself — a kind whose rows can be curated declares them
 * here, and the hosts hydrate `setKind` exactly as they hydrate the assign
 * roster's `actorKinds`.
 */
export interface MembershipListControl {
  /** User copy for the control and the lens chip ("Collections"). */
  label: string;
  /** Shown when the row is in no set. Not an option: absence is not a value. */
  emptyLabel: string;
  /** The edge a membership IS. `contains` runs set → member (incoming here). */
  edgeType: string;
  /** The kind whose rows are the curated sets. Hosts hydrate it as data. */
  setKind: string;
}

/** One value in a `ValueControl`'s vocabulary. */
export interface ValueOption {
  id: string;
  label: string;
  tone: PillTone;
}

export interface ValueControl {
  /**
   * Which `EntityState` member carries the current value — read structurally,
   * and written back under the SAME name in the kind's content patch. One
   * name, so the control cannot read one field and write another.
   */
  source: string;
  label: string;
  /** Shown when the field is unset. Not an option: null is not a value. */
  emptyLabel: string;
  /**
   * The settable vocabulary in reading order. Unlike `StateControl` these
   * carry their own label and tone, because no `statusPill` spec exists for
   * them — there is no second source here to disagree with.
   */
  options: readonly ValueOption[];
}

export interface AssignControl {
  /** The `EntityState` member carrying the current `ActorSummary[]`. */
  source: string;
  label: string;
  /** Shown when nobody is assigned. */
  emptyLabel: string;
  /** The edge type an assignment IS. The panel never spells this itself. */
  edgeType: string;
  /**
   * Which kinds may appear in the menu. DATA, because the HOST has to hydrate
   * them and the host is not allowed a kind literal either: the roster is the
   * union of this list across every kind that declares an assign control, so a
   * kind that becomes assignable arrives by registry entry alone.
   */
  actorKinds: readonly string[];
}

/**
 * One selectable state, and how it is written.
 *
 * `via` exists because a state's value does not imply its command. A task's
 * `done` is refused by the work verb outright (`set_work_state`: "completion
 * goes through complete_task") because completion has an acceptance-criteria
 * GATE, so a dropdown that wrote it through the same call as `working` would
 * surface a server refusal as a mystery. Declaring the routing as DATA lets
 * the panel dispatch the right verb without knowing which kind it is holding.
 */
export interface StateOption {
  id: string;
  /** Route this value through a different verb than the control's default. */
  via?: ActionRef;
}

export interface StateControl {
  /**
   * Which `EntityState` member carries the CURRENT value. Read structurally,
   * so the panel never names a kind to find the field it is editing.
   */
  source: 'workStatus' | 'status';
  label: string;
  /** The verb every option dispatches through unless it declares its own `via`. */
  command: ActionRef;
  /**
   * The SETTABLE vocabulary, in reading order — ids only.
   *
   * DELIBERATELY NOT carrying its own label and tone. The kind ALREADY
   * declares `panel.statusPill.{tones,labels}` for these same values, and the
   * badge on the collapsed row is painted from it; a second copy here would be
   * two sources for one fact, free to disagree the first time someone retones
   * `blocked` in one of them. The picker reads the pill spec, so the option in
   * the dropdown and the badge above it cannot drift.
   */
  options: readonly StateOption[];
  /**
   * Set when the kind HAS a state but the user may not author it — a work
   * session's status is OBSERVED (spawning → running → exited), never chosen.
   * The expanded row then shows the current value read-only with this reason,
   * which is a different statement from having no state at all.
   */
  readOnlyReason?: string;
}

/**
 * The subset of `EntitySummary` a row predicate may read. Deliberately narrow:
 * a predicate that wants more is asking to derive something the seam owns.
 */
export interface ListRowFacts {
  id: EntityId;
  kind: EntityKind;
  activityAt: string;
  /** `EntityState.status` where the kind has one (work_session), else null. */
  status: string | null;
  /** Unresolved hard-dependency count off `EntityBadges.blocked`. */
  blockedCount: number;
}

// ---------------------------------------------------------------------------
// PanelConfig (§2.3) + generic content blocks (§2.4)
// ---------------------------------------------------------------------------

export type BodyArchetype =
  | 'subtree'
  | 'reader'
  | 'hub'
  | 'profile'
  | 'generic'
  | 'terminal'
  // Surface wave (kind-bodies-2): project's governed body and
  // interaction_profile's restricted body.
  | 'governed'
  | 'restricted';

export type ContentBlockKind =
  | 'fields'
  | 'link-summary'
  | 'file-preview'
  // The blueprint canvas — a `graph` row's vertices AND edges drawn from the
  // ONE content object it stores (R1), so the picture is a pure fold of the
  // row and needs no seam, no per-node reads and no host wiring. Craft's
  // studio is where you EDIT a blueprint; this block is where every other
  // surface can SEE it, so a graph stops rendering two different ways.
  | 'blueprint'
  // Artifact viewer: the artifact kind's rendered bundle, in-block. The iframe
  // SHIPS here and autoruns when the detail opens (owner ruling 2026-08-16,
  // superseding the earlier click-gate); the sandbox posture is unchanged —
  // exactly `allow-scripts`, nothing else — and the preview URL is an opaque
  // server-minted capability, origin-agnostic and never parsed or built by the
  // UI. Full posture on `ArtifactPreviewBlock` in GenericBody.
  | 'artifact-preview'
  | 'items'
  | 'lifecycle'
  | 'notice'
  // Surface wave (kind-bodies-2): the governed body's four blocks…
  | 'path-row'
  | 'trust-card'
  | 'live-sessions'
  | 'unlink-footer'
  // …and the restricted body's five.
  | 'status-banner'
  | 'preview'
  | 'field-rows'
  | 'restrictions'
  | 'pin-provenance'
  // Scheduled-work management. The block owns enable/disable and queue-now;
  // its presence is registry data, so GenericBody never asks for a kind.
  | 'loop-controls'
  // Collection membership over the `contains` edge, both directions: a
  // collection's ITEMS (outgoing) and an entity's COLLECTIONS (incoming).
  // Edge-typed like `memory-set`; which side it is on is registry params.
  | 'membership'
  // Profile wave: the six blocks ProfileBody draws (T0-4 MEMBER lines 400–448,
  // AGENT lines 452–496). `items` above is reused deliberately — one block
  // name, one meaning, two renderers (GenericBody and ProfileBody).
  | 'identity'
  | 'bio'
  | 'stat-tiles'
  | 'field-grid'
  | 'live-work'
  | 'session-rows'
  // …plus the org tree: a teammate's place in the entity hierarchy, which
  // db/migrations/002_identity.sql:110 rules IS the org tree (leader = parent).
  | 'org-tree'
  // …plus the memory working set: the memories an entity `remembers` (056,
  // 084, 085). Named for the EDGE it reads and not for a kind, because 085
  // widened `remembers.src_kinds` to the wildcard — the same block row serves
  // a teammate and a task.
  | 'memory-set'
  // …the epistemic standing of an entity: every `badges.staleness` reason it
  // carries, the verification caveat, and the mark verbs (056 §5).
  | 'epistemics'
  // …and the plainest edge block there is: the peers on the other end of a
  // named edge type, each labelled with its KIND. Needed because 085 made
  // `remembers` a mixed-kind list, where the kind is the only distinguisher.
  | 'peer-rows';

export interface ContentBlockRef {
  block: ContentBlockKind;
  /** Section eyebrow above the block. */
  label?: string;
  /** Block parameters — the 'new display need = a new block parameter' seam. */
  params?: Readonly<Record<string, string | number | boolean>>;
}

/** Complete work-session Content vocabulary; pin projection gates Chat. */
export type ContentSurfaces = readonly ['terminal'] | readonly ['terminal', 'chat'];

export interface PanelConfig {
  archetype: BodyArchetype;
  /** generic archetype: ordered blocks (§2.4). */
  blocks?: readonly ContentBlockRef[];
  primaries?: readonly ActionRef[];
  statusPill?: StatusPillSpec;
  /**
   * L6 wording for capabilities the SERVER turns off. Server truth
   * (`EntityDetail.capabilities`) decides ON/OFF; this only supplies the
   * honest sentence.
   */
  capabilityReasons?: Partial<Record<keyof EntityCapabilities, string>>;
  /** work_session only. */
  contentSurfaces?: ContentSurfaces;
  /**
   * Git UI wave: the subtree body mounts the git section (tracked PRs,
   * commit provenance, completion-gate honesty) when the REGISTRY says so —
   * archetype law, never `kind === 'task'` in a component (§15.2).
   */
  gitSection?: boolean;
  /**
   * 'chat': the content body is a conversation that ENDS at its composer —
   * the panel mounts no AttachmentStrip (the composer's + owns attach) and no
   * PanelFooter below it. Terminal panels already skip both via the archetype
   * arm; this flag states the same reason structurally for chat surfaces.
   */
  composition?: 'chat';
  /**
   * The kind's chat surface reads THREAD ROOTS and opens a reply branch in a
   * side pane (the Slack-thread model). REGISTRY DATA, not a kind literal: the
   * hosts that mount a chat surface pass this through, and the surface itself
   * never asks what kind its anchor is. Absent ⇒ the flat conversation the
   * session surface draws, replies inline where they landed.
   */
  threads?: boolean;
  z4?: { immersive?: boolean };
}

// ---------------------------------------------------------------------------
// The registry row (§2.1)
// ---------------------------------------------------------------------------

/** WLT §2.1 route strategies. */
export type RouteStrategy = 'collection' | 'special' | 'anchored';

/** The single custom-kind fallback row. */
export const CUSTOM_KIND_FALLBACK = 'c:*' as const;
export type CustomKindFallback = typeof CUSTOM_KIND_FALLBACK;

/**
 * ONE FIELD IN THE `edit` DIALOG.
 *
 * The two targets are NOT interchangeable and the split is the contract's, not
 * a style choice: `PatchEntityInput` carries `title` as its own member and
 * everything else inside `content`, which the server then routes to the kind's
 * update RPC (`update_channel(p_name, p_topic)`, entities-commands-tracking.ts
 * :1114). A field that named `content.title` would be silently dropped.
 *
 * `required` is about the SERVER'S constraint, not about taste. A channel's
 * name is its `channels.name` column — `not null`, check-constrained, unique
 * per space — so an empty one is a refusal, and the dialog says so before
 * spending a round trip. `topic` is `not null default ''`, which is exactly
 * what makes it OPTIONAL here: omitting it is a real, storable value.
 */
export interface EditFieldSpec {
  /** `'title'` patches `PatchEntityInput.title`; `'content'` patches `content[source]`. */
  target: 'title' | 'content';
  /** The member name inside `content`. Required when `target` is `'content'`. */
  source?: string;
  /**
   * WHERE THE CURRENT VALUE IS READ FROM, when that is not where it is WRITTEN.
   *
   * Defaults to `'content'`, because for almost every field the two are the
   * same place: a channel's topic is patched as `content.topic` and read back
   * from `EntityDetail.content.topic`.
   *
   * `dueDate` is the exception, and it is the server's asymmetry rather than
   * one invented here. `contentOf` builds a task's content from description,
   * acceptanceCriteria and pointsEstimate ONLY (`entity-read.ts:1502-1508`),
   * while `stateOf` is what projects `due_date` (`:1112`) — so the field is
   * patched through `content.dueDate` and readable only from `state.dueDate`.
   *
   * THIS IS NOT COSMETIC. Seeding the dialog from `content` for a field that
   * lives in `state` yields a BLANK box on a task that has a due date, and an
   * emptied date field is an explicit `null` — so merely opening the dialog and
   * pressing Save would silently clear it. Naming the read side is what makes
   * that unrepresentable rather than a comment someone has to remember.
   */
  readFrom?: 'content' | 'state';
  label: string;
  /** Empty is refused in the dialog rather than at the server. */
  required?: boolean;
  /** Coerce every keystroke through `titleNormalizerFor`'s grammar. */
  grammar?: 'slug';
  placeholder?: string;
  /** Draw a textarea rather than an input. */
  multiline?: boolean;
  /**
   * The wire value represented by the draft string.
   *
   * `nullable-text` turns an empty draft into an explicit `null` (the loop
   * door's clear flag); `json-object` parses before Save and refuses arrays or
   * invalid JSON visibly; `schedule` validates against the executor grammar
   * and recomputes `nextRunAt` only when this field changed.
   *
   * `date` IS A CALENDAR DAY, NOT A TIMESTAMP, and that is the server's shape
   * rather than a simplification made here: `tasks.due_date` is a `date`
   * column, `entity-read.ts` projects it through `dateOnly()`, and
   * `handlers/collections.ts` sorts it as `::date`. A control offering a time
   * would invent precision the column cannot hold. Like `nullable-text` an
   * empty draft is an explicit `null` — which is the ONLY way to clear one,
   * since `update_task_content` COALESCEs an absent `dueDate` to the stored
   * value (`handlers/entities.ts:682-685`).
   */
  valueType?: 'text' | 'nullable-text' | 'json-object' | 'schedule' | 'date';
}

export interface KindConfig {
  kind: CoreEntityKind | CustomKindFallback;
  label: string;
  labelPlural: string;
  /**
   * The TEXT fallback mark. Still required — it is what a plain-string surface
   * (a `title=` tooltip, a palette row, a console dump) can show — but it is
   * no longer what the UI DRAWS. `iconArt` is.
   */
  icon: IconRef;
  /**
   * The DRAWN mark: SVG path data on a 16×16 grid (`domain/kind-art.ts`),
   * rendered by `KindIcon`.
   *
   * This is a data field for the reason the module header gives — per-kind
   * divergence lives in registry DATA (L2), and an icon is the purest case of
   * it. It is REQUIRED rather than optional so that adding a kind cannot
   * silently ship the ◇ fallback: totality is asserted in `registry.test.ts`,
   * along with uniqueness, which is the actual defect this field was added to
   * end — thirteen of the twenty text glyphs were the same small lozenge.
   */
  iconArt: KindArt;
  /**
   * The grammar the SERVER enforces on this kind's title, when it is narrower
   * than free text. Absent means free text.
   *
   * `'slug'` is `channels.name`'s check constraint (001_core_graph.sql:503,
   * and 053:61 for voice_channels): `^[a-z0-9][a-z0-9_-]{0,79}$`. For these
   * kinds the name IS the title — `internal.create_envelope` stores no title
   * column, so the read side derives one from `channels.name`. The RPC only
   * `lower(btrim())`s it, which fixes CASE and not SPACES, so "Untitled
   * channel" was refused by Postgres with an opaque `invariant_violation` at
   * both create and rename. Stating the grammar as registry data lets the
   * editor show the real name while it is being typed instead.
   */
  titleGrammar?: 'slug';
  /**
   * The fields the `edit` verb's dialog offers, in the order it draws them.
   *
   * REGISTRY DATA, and it has to be. The dialog is ONE component serving every
   * kind — `src/authoring/` is scanned by `no-kind-literals.test.ts`, which
   * fails the build on the string `'channel'` appearing anywhere in that lane,
   * so a hand-written per-kind form cannot live where the save flow lives. The
   * kind declares its shape here and the component renders whatever it is
   * handed, exactly as `list` and `panel` already work.
   *
   * ABSENT MEANS NO DIALOG, not an empty one: `edit` is filtered out of the
   * action bar for a kind that declares nothing, so no kind grows a verb that
   * opens onto nothing.
   */
  editFields?: readonly EditFieldSpec[];
  /**
   * A kind whose required create payload cannot be produced by the immediate
   * placeholder flow. Presence selects the staged, scheduler-aware form while
   * `list.quickCreate` continues to decide whether the header has a create
   * affordance at all.
   */
  createForm?: 'scheduled-work' | 'file-upload';
  /** WLT §2.1; null for channel (special — reserved word) AND message (anchored). */
  slug: string | null;
  strategy: RouteStrategy;
  /** strategy='special' (channel). */
  routeBuilder?: (spaceId: SpaceId, id: EntityId) => Hash;
  defaultMode: CollectionMode;
  /**
   * Hidden BY CONFIG, never hard-coded away. `'graph'` is never a member:
   * R7 requires it visible-and-disabled in the switcher, which is a different
   * state from hidden (asserted by §15.1).
   */
  hiddenModes: readonly CollectionMode[];
  chip: ChipSpec;
  card: CardSpec;
  list: ListConfig;
  panel: PanelConfig;
  palette?: { createLabel?: string; primaryAction?: ActionRef };
  /**
   * Can a session be launched ON this kind — the Run button.
   *
   * DERIVED, NOT DECLARED. A kind config does not set this; `applyLaunch` in
   * the registry writes it from the `NOT_LAUNCHABLE` denylist, which is the one
   * authority, and derives `list.rowActions`, `panel.primaries` and
   * `palette.primaryAction` from the same answer so the three cannot disagree.
   *
   * It was declared per-row when `task` was the only launchable kind, and the
   * cost of that showed up as absence: launching is open to every kind the
   * server will derive a task for (migration 064 — all but `work_session`), but
   * eleven kinds simply never set the flag and so never grew a Run button.
   * Making the permissive case the default turns a forgotten flag from a
   * silently missing feature into a deliberate opt-out.
   *
   * The subject need not be a task. The server derives a task to anchor the
   * session on and the launched entity is what the agent is pointed at.
   */
  launchable?: boolean;
}

/** Every custom kind resolves to the fallback row; `c:{name}` → `c-{name}`. */
export function customKindSlug(kind: CustomEntityKind): string {
  return `c-${kind.slice(2)}`;
}
