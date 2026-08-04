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
 * A glyph reference. The canvases draw icons as text glyphs (the menu rail's
 * collapsed 48px state, the Z1 kind chip) and the kit renders them
 * `aria-hidden` beside a real label — so the reference IS the glyph.
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

export interface SortSpec {
  key: SortKey;
  label: string;
  /** Exactly one entry per kind carries this (asserted by §15.1). */
  default?: boolean;
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
  | 'add-child'
  | 'react'
  | 'grant-points'
  // execution verbs (R-UI-6)
  | 'run'
  | 'coordinate'
  | 'launch-session'
  | 'terminate'
  | 'prompt-session'
  // §8 share-into-session (seam-deferred, §10.7)
  | 'share-into-session'
  | 'withdraw-handoff'
  // chrome
  | 'toggle-theme'
  // R7 deferred discovery rows (§4.2 disposition table)
  | 'graph-view'
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
   */
  flow?: 'launch';
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
 * `filter` stays contract-shaped, and `archived` is honestly expressible:
 * `deleted: 'only'` is a real `CollectionQuery` member, so the archive tier is
 * a genuine query rather than an invention. Where a kind has no state that can
 * land in a tier, `unsupported` carries the reason and the tab renders
 * HONESTLY EMPTY (L6) — never hidden, and never populated by a fabricated
 * partition.
 *
 * D56: the D20 client-side partition is RETIRED. `CollectionQuery.filters`
 * gained a `sessionStatus` member (contract dd41e89), so every tier now carries
 * a contract-shaped filter the seam executes untranslated — including
 * work_session, which was the only kind that ever needed the workaround.
 */
export interface LifecycleTier {
  id: 'open' | 'done' | 'archived';
  label: string;
  filter: QueryFilter;
  /**
   * Set when this kind cannot populate this tier. The tab still renders — the
   * count is honestly zero and the reason explains why, rather than the tier
   * being silently dropped for some kinds and not others.
   */
  unsupported?: string;
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
  // Artifact wave: metadata-only preview for the `artifact` kind. Execution of
  // the bundle (the iframe) is release-gated on two open security decisions and
  // is deliberately NOT part of this block.
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
  | 'org-tree';

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

export interface KindConfig {
  kind: CoreEntityKind | CustomKindFallback;
  label: string;
  labelPlural: string;
  /** Required by the collapsed 48px menu rail state (02-LAYOUT §1). */
  icon: IconRef;
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
   * Declared here rather than by hand-listing `'run'` in `list.rowActions` and
   * `panel.primaries`, which is how it worked when task was the only launchable
   * kind: the capability then lived in three separate string arrays per kind
   * with nothing tying them together, so "which kinds can launch?" had no single
   * answer and adding a kind meant remembering all three sites. `applyLaunch`
   * in the registry derives those arrays from this one field.
   *
   * The subject need not be a task. The server derives a task to anchor the
   * session on (migration 064) and the launched entity is what the agent is
   * pointed at, so any kind that a person could sensibly ask an agent to work on
   * may set this.
   */
  launchable?: boolean;
}

/** Every custom kind resolves to the fallback row; `c:{name}` → `c-{name}`. */
export function customKindSlug(kind: CustomEntityKind): string {
  return `c-${kind.slice(2)}`;
}
