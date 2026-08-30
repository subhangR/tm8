import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type {
  ActorSummary,
  CollectionGroup,
  Connections,
  EntityCapabilities,
  EntitySummary,
  ExecutionSpawnInput,
} from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type {
  ActionContext,
  ActionRef,
  AssignControl,
  GroupByKey,
  KindConfig,
  LaunchCapacity,
  LaunchProjectOption,
  StatusCategoryTab,
  ListPageState,
  ListRowFacts,
  LiveTreatment,
  MembershipListControl,
  ProfileResolution,
  QueryFilter,
  SetStateOutcome,
  SortKey,
  StateControl,
  StateOption,
  StatusPillSpec,
  TeammateLaunchState,
  ValueControl,
  CollectionMode,
} from '../domain';
import {
  ALL_MODES,
  KindIcon,
  REASONS,
  toRowFacts,
  VIEWER_ACTOR,
  allKinds,
  collectionKinds,
  countLabel,
  getKind,
  homeRailGroups,
  needsViewer,
  resolveAction,
  workflowRefusalText,
  workflowTypeOf,
  workflowVocabularyOf,
} from '../domain';
import {
  Avatar,
  Timestamp,
  ancestorPath,
  usePanelChoice,
  useTreeDisclosure,
  type PillTone,
} from '../kit';
import {
  CheckingPermission,
  DisabledAction,
  DisabledIconControl,
  NOT_WIRED_REASON,
  toReason,
  type UnavailableReason,
} from './honesty/DisabledWithReason';
import { ReasonNote } from './honesty/ReasonNote';
import { EmptyBody } from './detail/PanelStates';
import { useDismissable } from './useDismissable';
import {
  EntityControlStrip,
  RowAction,
  RowActionCluster,
  RowMembershipControl,
  RowStateControl,
  type ControlHost,
} from './controls/EntityControls';
import { HANDLED_SOURCES, dueLabel, renderBadge, type TileSlot } from './list/tile-badges';
import { CategoryGlyph } from './list/CategoryGlyph';
import { MobileSheet, useMobileSurface } from '../mobile';
import { MaestroStatusGlyph, MaestroTaskTile } from './list/MaestroTaskTile';
import { LinkedPullRequestChips, type LinkedPullRequestFacts } from '../pull-requests';
import { MaestroSessionTile } from './list/MaestroSessionTile';
import { SessionLaneLine, sessionLaneOf } from '../git/SessionLane';
import { TileCountBadges, hasTileCounts } from './list/TileCountBadges';
import { relatedOfKind } from './list/related';
import { RelatedGroup } from './list/RelatedGroup';
import { routeMessagePulse, type PulseSegment } from './list/message-pulse';
import type { MessagePulse } from './list/useMessagePulses';
import { LaunchQuickConfig, type LaunchTeammateOption } from './launch/LaunchQuickConfig';
import { newLaunchMutationId } from '../domain/launch';
import { EntityNavigationMetrics } from '../navigation';

const EMPTY_MEMBERS: readonly ActorSummary[] = Object.freeze([]);

/**
 * The four narrowing controls, named once.
 *
 * A UNION AND NOT FOUR BOOLEANS: one popover at a time is the rule the filter
 * bar has always enforced, and four independent flags would let the sort menu
 * and a filter picker sit open over each other. On the phone each of these is a
 * bottom sheet, where two at once is not a cosmetic problem but two scrims.
 */
export type ListPicker = 'filters' | 'people' | 'sets' | 'sort';

/**
 * The live-session kind for the tile's LEADING relation chip, selected by
 * CAPABILITY (the one kind with a `liveTreatment`), never by name — the same
 * §15.2 rule WorkspaceView uses for its empty-centre roster.
 */
const SESSION_CHIP_KIND = allKinds().find((kind) => kind.list.liveTreatment != null)?.kind;

/**
 * A relation chip may expand only into a real collection kind — registry
 * DATA, so the message tallies (whose `human-message` / `agent-message`
 * badge kinds resolve to no collection) stay counts, exactly the v1 ruling.
 */
const EXPANDABLE_KINDS: ReadonlySet<string> = new Set(
  collectionKinds().map((config) => config.kind),
);
const isExpandableKind = (kind: string): boolean => EXPANDABLE_KINDS.has(kind);
const NO_LINKED: readonly EntitySummary[] = Object.freeze([]);

/**
 * EntityListPanel — the other universal primitive (L3).
 *
 * ONE COMPONENT, EVERY KIND. Sections, lifecycle tabs, trees, tiles, badges,
 * filters, sort, quick-create, quick-launch, inline edit and row actions are
 * all read from `registry(kind).list` — DATA. There is no `kind ===` in this
 * file and there cannot be one (§15.2 fails the build): "Tasks" and
 * "Sessions" look completely different on screen and are the same code path.
 *
 * TWO LAWS THIS FILE EXISTS TO KEEP:
 *
 *   1. LIVENESS IS NEVER DERIVED HERE. The only source is the seam verdict
 *      passed in as `livenessOf`, and `liveTreatment` (registry data) turns
 *      that verdict into a word and a tone. This panel never looks at
 *      `activityAt` to guess whether something is alive — that is D6's named
 *      forbidden inference, and it is the bug that would make a dead session
 *      render green.
 *
 *   2. THE PULSE IS A SEPARATE SOURCE, SUBORDINATE TO THE VERDICT. `tile.pulse`
 *      is a declarative binding, not a predicate: it says "subscribe to the
 *      pool terminal-activity signal and gate it on a live verdict". Activity
 *      may refine a live row into "streaming"; it may never make a non-live
 *      row look alive.
 *
 * WHERE ROWS COME FROM. `rowsFor(filter, sort)` is injected — the shell backs
 * it with seam-hydrated, domain-store-selected data per (kind, filter, sort)
 * query key. The panel therefore never issues a query itself, which is also
 * what keeps it free of kind literals.
 *
 * AND THE SORT GOES WITH IT. The chip used to set local state that reached
 * nothing: `rowsFor` took a filter only, so every list on every kind was
 * permanently `activityAt_desc` while the chip cheerfully read `↓ priority`.
 * Order is decided by Postgres and arrives as the ORDER OF THE PAGE — so the
 * only way to change it is to ask a different question, and the only place to
 * ask is here.
 */

export interface EntityListPanelProps {
  /** Which registry row drives this panel. A miss lands on the `c:*` row. */
  kind: string;
  /**
   * Rows for a (filter, sort) pair — seam-hydrated and store-selected by the
   * shell. `sort` absent ⇒ the server's own default.
   */
  rowsFor: (filter: QueryFilter, sort?: SortKey) => readonly EntitySummary[];
  /**
   * Paging truth for the SAME (filter, sort) the rows came from.
   *
   * Absent ⇒ this host has not wired paging, and the panel says `N` rather
   * than `N+` and mounts no scroll sentinel. That is the honest reading: with
   * no `hasMore` there is no evidence of a truncation to disclose.
   */
  pageStateOf?: (filter: QueryFilter, sort?: SortKey) => ListPageState;
  /** Append the next page for that read. Absent ⇒ no infinite scroll. */
  loadMore?: (filter: QueryFilter, sort?: SortKey) => void;
  /** Real active-space membership. The people filter exists only at 2+. */
  members?: readonly ActorSummary[];
  ctx: ActionContext;

  /** THE verdict. Required for kinds whose ListConfig has a liveTreatment. */
  livenessOf?: (id: string) => SessionLiveness;
  /** Pool activity signal, per session. Gated on the verdict. */
  activity?: Readonly<Record<string, boolean>>;
  /**
   * Live message arrivals (sender → anchor), for `list.tree.messagePulse`.
   * Injected like every other signal: the panel never taps the seam itself.
   */
  messagePulses?: readonly MessagePulse[];
  /** The seam's live set — the ONLY source for the '● N live' count. */
  liveIds?: readonly string[];
  /** Server capability truth per row. Absent ⇒ unknown ⇒ NOT permitted. */
  capabilitiesOf?: (id: string) => EntityCapabilities | undefined;
  /**
   * Load one row's DETAIL — the read `capabilitiesOf` is backed by.
   *
   * Called only from an EXPANDED row's control strip, never per rendered row:
   * see `ControlHost.onNeedDetail` for what went wrong without it (every
   * control in the expanded row, Archive included, stuck in the checking state
   * forever) and why the trigger is a deliberate expand rather than a render.
   */
  onNeedDetail?: (entityId: string) => void;
  /** Real `working_on` targets for session tiles, projected by the shell. */
  linkedTasksOf?: (id: string) => readonly EntitySummary[];
  /**
   * The inverse projection: `working_on` SOURCES per target, from the same
   * gate-graph edges. This is what lets a task tile carry its sessions chip
   * BEFORE anyone hydrates the row's connections — the workspace already
   * holds these edges, so the count is free and live (user ruling
   * 2026-08-16: sessions ride the tile, leading position).
   */
  linkedSessionsOf?: (id: string) => readonly EntitySummary[];
  /** Tracked PR facts from the graph/entity projection, live by entity id. */
  linkedPullRequestsOf?: (id: string) => readonly LinkedPullRequestFacts[];

  selectedId?: string | null;
  /** True at the 200/220px floors: metas drop, badges abbreviate. */
  compact?: boolean;

  /**
   * Doc 06 §1.1 — the mode-wiring fix. The ROUTE holds the layout mode and the
   * shell passes it down; absent, the kind's registry default applies. Without
   * this the codec parsed `?mode=` and the value died before reaching the
   * panel.
   *
   * READ-ONLY as of the switcher removal (2026-08-19): the panel no longer
   * offers an in-header control that writes it back, so there is no `onMode`
   * counterpart. `?mode=board` still renders a board — the address is now the
   * only way to ask for one.
   */
  mode?: CollectionMode;

  /**
   * WHO DRAWS THE KIND CELL — `'panel'` (the default, and every surface that
   * mounts this panel alone) or `'host'`.
   *
   * Home is the one surface that already had one. Its root header draws
   * `[Chats ＋][◫ Tasks ＋ ▾]`, and hosting this panel underneath drew
   * `◫ Tasks ▾` again directly below it: the same glyph, the same word, and
   * BOTH carets opening a kind menu over the same selection. ChatHomeScreen's
   * own comment already names this hazard for the header-vs-rail pair ("one
   * selection, two views of it"); the hosted panel was a third view of it that
   * arrived with the host, and nothing in either component could see the
   * duplicate because each is correct alone.
   *
   * `'host'` suppresses the selector ROW. The kind MENU needs no relocation —
   * the host's caret already is one.
   */
  selectorSlot?: 'panel' | 'host';

  /**
   * Board mode's data source (A2). The shell backs it with the SAME
   * `collections.query` the rows come from, plus `groupBy` — columns are
   * `CollectionResult.groups`, computed server-side; the client never groups
   * (L3). `undefined` means loading, which renders skeletons — never empty
   * columns, because "an empty column is a real answer" only works if the
   * answer is never shown before the question returns (§8.2).
   */
  boardFor?: (filter: QueryFilter, groupBy: GroupByKey) => BoardSnapshot | undefined;

  /**
   * W3 — the board's GROUPING choice, wired exactly like `mode`: the route
   * holds it (`q.groupBy`), the shell passes the pair down, and local state
   * remains the uncontrolled fallback seeded from the registry's
   * `board.groupBy` default. The choice is among `status`, `assignee`,
   * and `axis:<name>` for each axis the space defines (`taskAxes`).
   */
  groupBy?: GroupByKey;
  onGroupBy?: (groupBy: GroupByKey) => void;

  /**
   * WHICH NARROWING CONTROL IS OPEN — held by the HOST when the host has
   * another way to open one, and locally otherwise.
   *
   * On the phone the filter bar is not on screen (`mobile-screens.css` §9): its
   * four triggers moved into the floating action button, which `EntityView`
   * owns because a FAB is a property of the SCREEN and not of a panel that also
   * renders inside a workspace column. So the button that opens `filter` and
   * the popovers that ARE `filter` sit in two different components, and one of
   * them has to hold the choice.
   *
   * It is held HERE and lifted UP rather than duplicated: the option lists, the
   * selections and the toggles are all this panel's state, so a second copy of
   * "which one is open" in `EntityView` could disagree with the sheet that is
   * actually mounted — and the disagreement would look like a sheet that will
   * not close.
   *
   * Absent ⇒ this host offers no second opener and the panel owns the choice
   * itself, which is every desktop mount. Same shape as `mode` / `groupBy`
   * above, for the same reason.
   */
  picker?: ListPicker | null;
  onPicker?: (picker: ListPicker | null) => void;

  /**
   * Focus handle for the D36 `list.search` command (`f`). The keyboard
   * controller emits the command and consumes the event; it never touches the
   * DOM — the shell calls this on the FOCUSED panel.
   */
  searchInputRef?: React.Ref<HTMLInputElement>;
  onSelect?: (id: string) => void;
  onAction?: (ref: ActionRef, entityId: string) => void;
  /**
   * Which of the header verbs this host can actually PERFORM.
   *
   * Same mechanism `EntityDetailPanel` already uses (`chrome.tsx`): a verb
   * absent from the list is handed `onAction: undefined`, so it renders its
   * honest not-wired refusal instead of an enabled button whose click the
   * host's switch silently drops. Absent ⇒ every declared verb is wired, the
   * pre-existing behaviour.
   *
   * This became load-bearing when the sessions header grew a SECOND verb (101).
   * Before that the header was all-or-nothing, so `onAction` alone said enough;
   * with `Terminal` wired and `Launch session ▸` not yet, one prop cannot
   * answer for both.
   */
  wiredActions?: readonly ActionRef[];
  /** Session-row close command; separate from generic header/list actions. */
  onTerminate?: (entityId: string) => void;
  /** The other half of that row's tail slot — see `ControlHost.onResume`. */
  onResume?: (entityId: string) => void;
  onCreate?: () => void;
  /** Authoring 7a: the host's REAL create control (NewTaskControl). */
  createSlot?: React.ReactNode;
  onKindChange?: (kind: string) => void;

  /**
   * D44 — the launch flow. A verb carrying `flow: 'launch'` does NOT dispatch
   * on click; it expands the quick config beneath its row, and `Launch ▸`
   * inside that config is what commits. The marker lives in registry DATA, so
   * this panel never asks which verb or which kind — it asks the resolved
   * ActionDef whether it opens a flow.
   *
   * These props supply that config. Absent ⇒ the expand still opens and states
   * what it cannot do; a Run that silently does nothing is the failure R5 #9
   * closed everywhere else.
   */
  launch?: LaunchSources;

  /**
   * D67 — commit a state chosen in an expanded row's dropdown.
   *
   * SEPARATE FROM `onAction` because a state write carries a VALUE, and
   * `onAction(ref, entityId)` has nowhere to put one. The verb still comes
   * from registry data (`stateControl.command`, or the option's own `via`), so
   * the host decides which seam call each verb means and this panel keeps
   * knowing neither the kind nor the command — the same split `onTerminate`
   * already uses for the one session verb with its own host handler.
   *
   * Absent ⇒ the dropdown renders DISABLED WITH REASON, never enabled-inert.
   *
   * MAY return the outcome. The board renders refusals INLINE at the column
   * header (§1.5 — no toasts on the board), so it passes `{notify: false}` and
   * consumes the returned outcome; the dropdown path passes nothing and the
   * host keeps noticing. A host returning `void` still works — the board then
   * simply cannot show the reason and the card stays where the data says.
   */
  onSetState?: (
    entityId: string,
    next: string,
    via: ActionRef,
    opts?: { notify?: boolean },
  ) => void | Promise<SetStateOutcome>;

  /**
   * D67 — commit the expanded row's archive / restore.
   *
   * ITS OWN PROP, NOT `onAction`, AND THAT IS LOAD-BEARING. `onAction` is the
   * GENERAL dispatcher: supplying it turns on every verb the registry lists,
   * including `quickLaunch` in the panel header. Routing archive through it
   * lit the Sessions panel's "Launch session ▸" — a control this executor does
   * not own and would have silently ignored, i.e. enabled and inert, the exact
   * failure `gate.test.tsx` guards. A verb with a dedicated host handler takes
   * a dedicated prop, exactly as `onTerminate` already does.
   */
  onArchive?: (ref: ActionRef, entityId: string) => void;

  /**
   * The row cluster's tick — a dedicated prop for the same reason `onArchive`
   * and `onTerminate` are. See `ControlHost.onComplete`: routed through the
   * general `onAction` it reached the session-START switch, drew live, and was
   * dropped on the floor. Absent ⇒ the tick renders its not-wired refusal.
   */
  onComplete?: (entityId: string) => void;

  /**
   * Commit a value chosen in an expanded row's `valueControls` picker.
   *
   * ITS OWN PROP, NOT `onSetState`, because the two are not the same write. A
   * state goes through a command verb and is unversioned; these go through the
   * kind's content PATCH and are version-guarded, so the host has a 409 to
   * handle here that `onSetState` never sees. Passing `source` rather than a
   * field name keeps this panel free of the field it is editing.
   *
   * `label` rides beside `source` because they are two faces of one registry
   * control: `source` is the WIRE field the host patches, `label` is its USER
   * copy, and the host's failure notice is read by a person ("Priority could
   * not be changed", not "priority could not be changed"). Sending both from
   * the one `ValueControl` is what stops them disagreeing.
   *
   * Absent ⇒ the picker renders DISABLED WITH REASON, never enabled-inert.
   *
   * `null` clears, and only a `dateControls` field ever sends one — see
   * `ControlHost.onSetValue`, which this must keep satisfying structurally.
   */
  onSetValue?: (entityId: string, source: string, next: string | null, label: string) => void;

  /**
   * Set or clear (`null`) ONE axis of an expanded row's `state.axes` record.
   * Its own prop for the same reason `onSetValue` is: the write is a
   * version-guarded content patch, and additionally a MERGE — the server
   * replaces the whole axes jsonb, so the host folds this one change into the
   * stored record. See `ControlHost.onSetAxis`.
   */
  onSetAxis?: (
    entityId: string,
    axisName: string,
    next: string | null,
    label: string,
    opts?: { notify?: boolean },
  ) => void | Promise<SetStateOutcome>;

  /**
   * The space's axis registry — per-space DATA from `spaceSettings().taskAxes`,
   * hydrated by the host. The axis pickers draw one control per entry for
   * kinds whose registry declares `axisControls`; empty draws none.
   */
  taskAxes?: readonly import('@tm8/contract').TaskAxis[];

  /**
   * The space's workflow registry (W4, 132) — per-space DATA from
   * `spaceSettings().taskWorkflows`, hydrated by the host beside `taskAxes`.
   * The state control narrows its options with it, and the STATUS board
   * pre-flights a drop against it; the database trigger stays the real gate.
   */
  taskWorkflows?: readonly import('@tm8/contract').TaskWorkflow[];

  /**
   * Add or remove ONE assignment on an expanded row.
   *
   * `edgeType` is registry data, passed through rather than known here — the
   * panel is saying "this actor is / is not linked to this row by the edge the
   * kind declares", which is the whole of what it can honestly claim. Per-actor
   * and not a whole-array set, deliberately: a whole-collection write is the
   * clobber that loses a concurrent editor's assignment silently.
   */
  onAssign?: (entityId: string, actorId: string, edgeType: string, assigned: boolean) => void;

  /**
   * Who the assignee picker may offer. Injected like every other source.
   *
   * Absent or empty ⇒ the picker says the roster is not loaded rather than
   * rendering an empty menu that looks like "nobody exists in this space".
   */
  assignableActors?: readonly ActorSummary[];

  /**
   * Curated-set membership (registry `list.membership`, migration 101) — the
   * three injected sources behind the expanded row's Collections picker and
   * this panel's collection LENS. Same split as assignment: the registry
   * names the edge and the set kind, the host hydrates the sets and executes
   * the write, and this panel knows neither the kind nor the verb.
   */
  onMembership?: (entityId: string, setId: string, member: boolean) => void;
  /** One bounded recency page of the declared set kind (host-hydrated). */
  membershipSets?: readonly EntitySummary[];
  /** The row's live edges, for the picker's ✓ marks. */
  connectionsOf?: (id: string) => Connections | undefined;
}

/** Everything the inline launch config needs, supplied by the shell. */
export interface LaunchSources {
  spaceId: string;
  teammates: readonly LaunchTeammateOption[];
  projects: readonly LaunchProjectOption[];
  loadFor?: (teamMemberId: string) => TeammateLaunchState;
  capacity?: LaunchCapacity;
  profileFor?: (teamMemberId: string | null) => ProfileResolution | undefined;
  onSpawn?: (input: ExecutionSpawnInput) => void | Promise<void>;
  onFullOptions?: (entityId: string) => void;
  /** Caller owns uniqueness of the optimistic-journal id. */
  mutationId: (entityId: string) => string;
}

/**
 * One grouped read's answer, as the shell delivers it. `limit` and
 * `nextCursor` exist for the §1.4 honesty banner: groups are PAGE-SCOPED and
 * no per-group total exists yet, so the board must say "{n} shown" and name
 * the page size rather than let column heights read as complete counts.
 */
export interface BoardSnapshot {
  groups: readonly CollectionGroup[];
  nextCursor: unknown;
  limit: number;
  /** A failed fetch — the board renders the reason, never empty columns. */
  error?: string;
  retry?: () => void;
}

/** How long a destructive row verb's trace stays on screen. */
const ROW_NOTICE_MS = 5000;

/**
 * The aftermath of a destructive row verb (audit finding 3): Archive and the
 * tick both remove the row from the open band the instant they land, and until
 * this existed the panel said NOTHING — the row vanished and the only path
 * back was knowing the Archived filter exists. `undo` is present exactly when
 * the row executor contract carries the inverse verb.
 */
interface RowVerbNotice {
  text: string;
  /** Present ⇒ the inverse verb is one click away for ROW_NOTICE_MS. */
  undo?: () => void;
}

export function EntityListPanel(props: EntityListPanelProps) {
  const config = getKind(props.kind);
  const list = config.list;

  /**
   * The open category tab, REMEMBERED PER KIND (user ruling, task 01a02470:
   * "when i switch back from entity to entity, it always falls back to TO DO
   * status filter which is annoying… remembering entity level view selection").
   *
   * PER KIND, NOT PER SURFACE AND NOT GLOBAL. Home's column A, the workspace
   * list and an entity screen's list are three places to look at one kind's
   * rows, and the tab is a statement about the rows — the same scoping
   * `useTreeDisclosure` uses one screen down (`list:${kind}`), for the same
   * reason. Global would be worse than the reset it replaces: picking Done on
   * Sessions would land you in Done on Tasks, which is not what was asked.
   *
   * WHAT THIS MUST NOT UNDO (sub-doc 6, "known bug to fix while in here"): the
   * id used to be seeded once from the MOUNTING kind's first tab while
   * `onKindChange` swapped `props.kind` under it, so Tasks' tab silently became
   * Docs' tab. That is a bug about the id being resolved against the WRONG
   * kind's vocabulary, not about remembering, and the per-kind storage key plus
   * `usePanelChoice`'s required `valid` predicate keep it fixed: what comes
   * back is always one of THIS kind's tabs or this kind's default. The hook is
   * key-aware for the same reason `usePanelWidth` is — a kind switch on a
   * mounted panel re-reads during render, so no wrong tab is ever painted.
   */
  /**
   * THE LANDING TAB IS REGISTRY DATA (`list.defaultCategory`), NOT `[0]`.
   *
   * `[0]` is `to_do` for every kind, because `CATEGORY_TABS` is one shared
   * array — and that array is right. What was wrong was reading a POSITION in
   * it as "where this kind's rows are". For an AUTHORED kind the two coincide;
   * for an OBSERVED one they do not, and work_session is the case that proves
   * it: migration 155 maps `running`/`idle` to `in_progress` and only the
   * sub-second `spawning` transient to `to_do`, so the sessions list opened on
   * a band a live session is structurally incapable of being in. Measured on
   * the launch node: 477 sessions, zero of them in To Do.
   *
   * Resolved against the kind's OWN `categories` so a stale or mistaken
   * declaration degrades to the first tab rather than to no tab at all — the
   * same posture `usePanelChoice`'s `valid` predicate takes for the persisted
   * value on the line below.
   */
  const declaredDefault = list.defaultCategory;
  const defaultTabId =
    (declaredDefault && list.categories?.some((tab) => tab.id === declaredDefault)
      ? declaredDefault
      : list.categories?.[0]?.id) ?? '';
  const isCategoryTab = useCallback(
    (candidate: string) => (list.categories ?? []).some((tab) => tab.id === candidate),
    [list.categories],
  );
  const [categoryTabId, setCategoryTabId] = usePanelChoice(
    `list-category.${config.kind}`,
    defaultTabId,
    isCategoryTab,
  );

  /**
   * Every tab's count, computed ONCE per render and shared by the four
   * surfaces that read it (tabs, footer, selector total — and now the landing
   * correction below). They were three calls to the same function; with paging
   * state joined in it is now enough work to be worth not tripling, and
   * sharing also makes it structurally impossible for the tab and the footer
   * to disagree.
   */
  const tabCounts = (list.categories ?? []).map((tab) => ({
    tab,
    ...tabCount(props, config, tab),
  }));
  /* The selector total's `+` — carried only when a tab's number is still the
     loaded length rather than the server's. Once every tab reports an exact
     total the sum IS exact, and the hedge disappears on its own. */
  const anyTabTruncated = tabCounts.some((c) => !c.exact && c.label.endsWith('+'));

  /**
   * THE LANDING TAB MUST NOT BE AN EMPTY BAND OVER A POPULATED KIND — the
   * empty-default-tab audit finding (2026-08-29), measured on six screens:
   * Commits, Files, Artifacts and Memories are all seeded `done` at birth
   * (`kind_seeds_done`, 152), so each opened on "To Do 0 — No X here yet —
   * create one" while its own footer said "3 done". Existing content
   * invisible, and the empty-state copy a lie about the data on screen.
   *
   * The correction is DERIVED, never persisted, and it defers to both of the
   * standing contracts:
   *
   *   · A VIEWER'S EXPLICIT PICK ALWAYS WINS (task 01a02470). The correction
   *     runs only while `usePanelChoice` holds nothing for this kind — a
   *     stored tab, even an empty one the viewer chose to look at, is shown
   *     as stored. Not writing the corrected id back is what keeps the
   *     viewer's first real click the first thing ever persisted.
   *   · THE REGISTRY DEFAULT KEEPS ITS SEAT while its bucket has rows
   *     (work_session = In Progress): the correction fires only when the
   *     resolved default's own count is zero, so it can only ever move OFF a
   *     band that has nothing to show.
   *
   * "First" is first in the shared tab order, so the correction is as
   * deterministic as the row it reads. All counts zero (a genuinely empty
   * kind, or counts not yet loaded) corrects nothing — there is no better tab
   * to claim, and the moment a count lands the derivation re-runs.
   */
  const storedTab = hasStoredTabChoice(config.kind, isCategoryTab);
  const categoryCount = (id: string): number => tabCounts.find((c) => c.tab.id === id)?.n ?? 0;
  const firstNonEmptyTab = tabCounts.find((c) => c.n > 0)?.tab.id;
  const openTabId =
    !storedTab && categoryCount(categoryTabId) === 0 && firstNonEmptyTab !== undefined
      ? firstNonEmptyTab
      : categoryTabId;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((list.sections ?? []).filter((s) => s.collapsedByDefault).map((s) => s.id)),
  );
  /**
   * Selected option ids PER FilterSpec. Not a single global id: `status` is
   * `multi`, so several of its options can be active at once, while a
   * non-multi spec holds at most one.
   */
  const [selected, setSelected] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [selectedPeople, setSelectedPeople] = useState<readonly string[]>([]);
  const [sortKey, setSortKey] = useState(list.sort.find((s) => s.default)?.key ?? list.sort[0]?.key);
  const [query, setQuery] = useState('');
  // §1.1: route-held when the host passes it. `props.mode` null-ish means "the
  // route says nothing", which reads the registry default. There is no local
  // state behind it any more — with the switcher gone nothing inside the panel
  // can change the mode, so a second copy of it could only drift.
  const mode = props.mode ?? config.defaultMode;
  /* W3 — same §1.1 shape for the board's grouping: route-held when the host
     passes the pair, local fallback otherwise, seeded from the registry
     DEFAULT (`board.groupBy` stays the seed, no longer the pin). */
  const [localGroupBy, setLocalGroupBy] = useState<GroupByKey | null>(null);
  const groupBy = props.groupBy ?? localGroupBy ?? list.board?.groupBy ?? 'status';
  const setGroupBy = props.onGroupBy ?? setLocalGroupBy;

  /* The open narrowing control — see `picker` on the props. `!== undefined`
     rather than `??` because `null` is a MEANINGFUL host answer here ("nothing
     is open"), and `??` would fall through it to the local copy on every close. */
  const [localPicker, setLocalPicker] = useState<ListPicker | null>(null);
  const picker = props.picker !== undefined ? props.picker : localPicker;
  const setPicker = props.onPicker ?? setLocalPicker;

  /**
   * DESTRUCTIVE ROW VERBS LEAVE A TRACE (audit finding 3). Archive and the
   * tick remove the row from the open band the moment they commit — correct,
   * and previously silent, which read as the row simply vanishing. The panel
   * now interposes on the two dedicated executors it already owns the wiring
   * for and states what happened for {@link ROW_NOTICE_MS}.
   *
   * UNDO IS OFFERED WHERE THE CONTRACT HAS AN INVERSE, and only there:
   *
   *   · `onArchive` is DOCUMENTED as the archive/restore pair — the cluster
   *     itself dispatches `restore` through the same prop on an archived row —
   *     so Archive's undo is `onArchive('restore', id)`: the same executor,
   *     the inverse verb, no new host surface.
   *   · `onComplete(id)` carries NO inverse. `commands.complete` is the only
   *     operation permitted to write `done` (useRowLifecycle's map) and no
   *     un-complete verb exists in the row executor contract, so the notice
   *     states where the row went instead of offering an undo it cannot
   *     honestly perform.
   *
   * The interposition is pass-through-first: the host's executor runs exactly
   * as it did (same ref, same id — the dispatch tests hold), and the notice is
   * about the REQUEST. A server refusal still arrives through the host's own
   * failure notice, which outranks this trace.
   */
  const [rowNotice, setRowNotice] = useState<RowVerbNotice | null>(null);
  useEffect(() => {
    if (rowNotice === null) return;
    const timer = setTimeout(() => setRowNotice(null), ROW_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [rowNotice]);

  const hostArchive = props.onArchive;
  const hostComplete = props.onComplete;
  const noticingArchive = useMemo(
    () =>
      hostArchive === undefined
        ? undefined
        : (ref: ActionRef, entityId: string): void => {
            hostArchive(ref, entityId);
            /* Only the DESTRUCTIVE direction earns the trace: `restore` puts
               the row back where the viewer is already looking. The pair are
               ACTION ids (registry verbs), not kind literals — the same two
               the cluster's own `archived ? 'restore' : 'archive'` spells. */
            if (ref === 'archive') {
              setRowNotice({
                text: 'Archived',
                undo: () => {
                  hostArchive('restore', entityId);
                  setRowNotice(null);
                },
              });
            }
          },
    [hostArchive],
  );
  /* The Done tab's own word, so the trace names the band the row moved to in
     the vocabulary the tab row above already uses. */
  const doneTabLabel = (list.categories ?? []).find((tab) => tab.id === 'done')?.label ?? 'Done';
  const noticingComplete = useMemo(
    () =>
      hostComplete === undefined
        ? undefined
        : (entityId: string): void => {
            hostComplete(entityId);
            setRowNotice({ text: `Completed — now under ${doneTabLabel}` });
          },
    [hostComplete, doneTabLabel],
  );
  /**
   * The props the ROW SURFACES receive — identical to the host's except that
   * the two destructive executors pass through the trace above. Built by
   * conditional spread so an unwired executor stays ABSENT (the not-wired
   * refusals downstream key on that), and handed to every mount that renders
   * tiles (bands and board alike) so the cluster, the expanded strip and a
   * board card all share one interposition.
   */
  const rowProps: EntityListPanelProps = {
    ...props,
    ...(noticingArchive ? { onArchive: noticingArchive } : {}),
    ...(noticingComplete ? { onComplete: noticingComplete } : {}),
  };

  /**
   * The open tab — AND `null` IN BOARD MODE, deliberately.
   *
   * A board's COLUMNS are a partition of the status axis. So is the tab row.
   * Two controls for one axis is the defect that made the retired `Current` /
   * `Completed` sections wrong, and on a board it is worse than cosmetic: with
   * the tabs applied, the To Do board holds only the to_do columns, so
   * DRAGGING A CARD FROM To Do TO In Progress — the single most-performed
   * kanban gesture — has no target to land on.
   *
   * It was survivable while the tabs were `Open · Done · Archived`, because
   * `open` spanned five statuses and the board's whole in-flight vocabulary
   * fitted inside one tab. The closed four split that tab in half, and the
   * gesture with it. The board owns the axis while it is on screen; `CategoryTabs`
   * is not rendered, so nothing draws a control that is not in effect.
   */
  const activeTab = mode === 'board' ? null : (list.categories?.find((t) => t.id === openTabId) ?? null);
  /* The honest empty-state facts for the open tab: which OTHER bands hold rows
     right now, in tab order. Read by the tab band's empty state (the copy half
     of the landing-correction finding) — the sentence on screen must agree
     with the counts on screen. */
  const rowsElsewhere = activeTab
    ? tabCounts
        .filter((c) => c.tab.id !== activeTab.id && c.n > 0)
        .map((c) => ({ label: c.tab.label, n: c.n }))
    : [];
  const members = props.members ?? EMPTY_MEMBERS;

  /**
   * THE COLLECTION LENS (registry `list.membership`). One selected set at a
   * time — membership is an OR across sets, so two lenses cannot compose by
   * the intersection rule every other axis uses, and a second selection
   * REPLACES the first rather than pretending to narrow it.
   *
   * Resolved against the sets page the host injected: a set that has left the
   * page (deleted, renamed out of the recency window) deactivates the lens
   * rather than filtering by an id the menu can no longer explain.
   */
  const [lensId, setLensId] = useState<string | null>(null);
  const lensSet =
    list.membership && lensId
      ? ((props.membershipSets ?? []).find((set) => set.id === lensId) ?? null)
      : null;
  const lensFilter: QueryFilter | undefined =
    list.membership && lensSet
      ? ({
          /* The contract's own `filters.edge` clause, which the server already
             executes: members of the set are the rows with an INCOMING edge of
             the declared type from it. */
          edge: { type: list.membership.edgeType, direction: 'incoming', entityId: lensSet.id },
        } as QueryFilter)
      : undefined;

  // A space switch may keep this panel instance mounted. A selected member
  // from the prior space must not survive as a hidden createdByIds filter.
  useEffect(() => {
    const present = new Set(members.map((member) => member.id));
    setSelectedPeople((current) => {
      const next = members.length > 1 ? current.filter((id) => present.has(id)) : [];
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [members]);

  /* `tabCounts` (and its `anyTabTruncated` hedge) moved above the landing
     correction, which is the fourth reader of the same one-per-render array. */

  return (
    <section
      className={props.compact ? 'lp lp--compact' : 'lp'}
      data-testid="entity-list-panel"
      data-kind={config.kind}
      aria-label={config.labelPlural}
    >
      {/* The host's own kind cell replaces this row when it declares one —
          see `selectorSlot`. The row is not merely hidden: its live control
          (the kind menu) exists up there instead, which is why the prop names
          an owner rather than reading `hideHeader`. */}
      {props.selectorSlot === 'host' ? null : (
        <KindSelector
          config={config}
          total={
            list.categories
              ? `${tabCounts.reduce((n, c) => n + c.n, 0)}${anyTabTruncated ? '+' : ''}`
              : undefined
          }
          liveCount={liveCountFor(props, config, activeTab)}
          onKindChange={props.onKindChange}
        />
      )}

      <HeaderActions
        config={config}
        ctx={props.ctx}
        onCreate={props.onCreate}
        createSlot={props.createSlot}
        onAction={props.onAction}
        hostOwnsBirth={props.selectorSlot === 'host'}
        {...(props.wiredActions ? { wiredActions: props.wiredActions } : {})}
      />

      <SearchRow
        config={config}
        query={query}
        onQuery={setQuery}
        inputRef={props.searchInputRef}
      />

      {/* Hidden in board mode — the columns ARE this partition. See
          `activeTab`. */}
      {mode === 'board' ? null : (
        <CategoryTabs
          tabs={list.categories}
          activeTabId={openTabId}
          onTab={setCategoryTabId}
          tabLabel={(tab: StatusCategoryTab) =>
            tabCounts.find((c) => c.tab.id === tab.id)?.label ?? '0'
          }
          /*
           * EMPTY MEANS THE SERVER SAID ZERO. NOT "the label looks like a
           * zero", and — the part that matters — NOT "nothing has arrived
           * yet".
           *
           * `exact` IS THE LOAD-BEARING HALF, AND `n === 0` ALONE IS A BUG.
           * `tabCount` (:1204) computes `n: page?.total ?? loaded`, and
           * `loaded` is `rowsFor(...).length` — which is 0 while the first
           * page is still in flight (`ListPageState.loading`: "a page is in
           * flight, including the first, before anything has arrived"). So
           * `n === 0` is true of an EMPTY band and of an UNREAD one, and a
           * predicate that cannot tell those apart would demote every tab on
           * the opening read and then un-demote them as rows land.
           *
           * That is the composer's bug exactly — deriving "there is none"
           * from a value that also means "we have not asked yet" — which this
           * fleet spent the day removing from Home. It would have been
           * cheerfully reintroduced here, on every list in the product, by a
           * predicate that reads correct.
           *
           * `exact` is `page?.total !== undefined`: the server VOLUNTEERED a
           * total. That cannot be confused with silence. So the pair
           * `exact && n === 0` is a settled zero and nothing else.
           *
           * IT FAILS TOWARD SHOWING THE COUNT, on purpose and in every
           * uncertain case: a host that wired no `pageStateOf`, a page still
           * loading, a tab absent from `tabCounts`. Those tabs render exactly
           * as they do today. The cost is that a host which never reports a
           * total never gets the demotion; the alternative is asserting
           * emptiness from ignorance, which is the failure this whole pass
           * exists to stop.
           */
          tabEmpty={(tab: StatusCategoryTab) => {
            const count = tabCounts.find((c) => c.tab.id === tab.id);
            return count?.exact === true && count.n === 0;
          }}
        />
      )}

      <FilterRow
        config={config}
        picker={picker}
        onPicker={setPicker}
        selected={selected}
        onToggleOption={(specId, optionId, multi) =>
          setSelected((prev) => {
            const current = prev[specId] ?? [];
            const on = current.includes(optionId);
            const next = on
              ? current.filter((id) => id !== optionId)
              : multi
                ? [...current, optionId]
                : [optionId];
            return { ...prev, [specId]: next };
          })
        }
        sortKey={sortKey}
        onSort={setSortKey}
        viewerActorId={props.ctx.viewerActorId}
        /* THE FOUR TAB PROPS ARE GONE (sub-doc 6, "dead wiring"). `FilterRow`
           was handed `tabs` / `activeTabId` / `onTab` / `tabLabel` and never
           read one of them — the tab row is `CategoryTabs`, a separate
           component one element up, and has been since tabs got their own
           row. Four props that compute a count nobody renders. */
        compact={props.compact}
        people={members.length > 1 ? members : []}
        selectedPeople={selectedPeople}
        onTogglePerson={(actorId) =>
          setSelectedPeople((current) =>
            current.includes(actorId)
              ? current.filter((id) => id !== actorId)
              : [...current, actorId],
          )
        }
        membership={list.membership}
        membershipSets={props.membershipSets}
        lensSet={lensSet}
        onLens={setLensId}
      />

      {/* THE LENS SAYS WHAT IT HIDES. A kind-scoped list showing one set's
          members is NOT the set: a mixed collection holds items of every
          kind, and a list that silently showed five of twelve would let the
          page read as the whole collection. The note carries both numbers —
          the lens query's own count (of exactly the rows below) and the
          set's total membership off its summary. */}
      {lensSet && lensFilter ? (
        <LensNote set={lensSet} filter={lensFilter} props={props} config={config} />
      ) : null}

      {/* The destructive-verb trace (audit finding 3). `role="status"` so the
          removal is announced without stealing focus; `lp__lensnote` because
          this is the same quiet in-panel note the lens honesty line uses — no
          new floating surface, nothing portalled, nothing on document.body. */}
      {rowNotice ? (
        <div className="lp__lensnote lp__rownotice" role="status" data-testid="row-verb-notice">
          {rowNotice.text}
          {rowNotice.undo ? (
            <button
              type="button"
              className="lp__chip lp__rownotice-undo"
              data-testid="row-verb-undo"
              onClick={rowNotice.undo}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="lp__body">
        {mode === 'board' && list.board ? (
          <BoardBody
            props={rowProps}
            config={config}
            tab={activeTab}
            onTab={setCategoryTabId}
            groupBy={groupBy}
            onGroupBy={setGroupBy}
            filter={
              bandFilter(
                activeTab?.filter ?? {},
                activeTab,
                selected,
                config,
                props.ctx,
                selectedPeople,
                lensFilter,
              ) ?? {}
            }
            query={query}
          />
        ) : list.sections && list.sections.length > 0 ? (
          /* A section the active tab excludes outright renders NO heading.
             Its rows would be empty by construction, and an empty band under
             "COMPLETED · 0" inside the Open tab states something false about
             the tab rather than about the data. */
          list.sections
            .filter((section) => narrow(section.filter, activeTab?.filter) !== null)
            .map((section) => (
            <Band
              key={section.id}
              label={section.label}
              filter={bandFilter(
                section.filter,
                activeTab,
                selected,
                config,
                props.ctx,
                selectedPeople,
                lensFilter,
              )}
              sort={sortKey}
              collapsed={collapsed.has(section.id)}
              onToggle={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(section.id)) next.delete(section.id);
                  else next.add(section.id);
                  return next;
                })
              }
              props={rowProps}
              config={config}
              query={query}
            />
          ))
        ) : (
          <Band
            label={null}
            filter={bandFilter(
              activeTab?.filter ?? {},
              activeTab,
              selected,
              config,
              props.ctx,
              selectedPeople,
              lensFilter,
            )}
            sort={sortKey}
            props={rowProps}
            config={config}
            query={query}
            {...(activeTab
              ? { tabFacts: { label: activeTab.label, elsewhere: rowsElsewhere } }
              : {})}
          />
        )}
      </div>

      {/* T0-1 draws a footer count line on every kind: "9 to do · 4 in
          progress · 601 done · 12 cancelled". Same per-tab counts as the tabs
          above — one source, three surfaces (tabs, footer, selector total).

          The tab's LABEL, lowercased — not its `id`. The ids are the
          contract's `StatusCategory` literals, so printing them would put
          `to_do` and `in_progress` in front of a user; the label is the word
          the tab above already shows them. */}
      {tabCounts.length > 0 ? (
        <div className="lp__foot" data-testid="list-footer">
          {tabCounts.map((c) => `${c.label} ${c.tab.label.toLowerCase()}`).join(' · ')}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row sourcing
// ---------------------------------------------------------------------------

/**
 * THE THREE AXES MUST NARROW, NOT OVERWRITE.
 *
 * A visible list is the intersection of independently-chosen constraints: the
 * SECTION band (no kind declares one today), the CATEGORY TAB, and the filter
 * CHIPS. This used to be `{...section, ...tab, ...chips}`, and object spread
 * is the wrong operator for every one of them:
 *
 *   - ARRAYS. `{status:['open','pulled','working']}` spread under
 *     `{status:['done']}` yields `['done']` — the Open tab showing done
 *     rows. Two lists of allowed values compose by INTERSECTION; each one
 *     says "only these", and both are still true.
 *     Concretely: on the Open tab the band headed "Completed" was queried
 *     with the OPEN statuses, so it rendered open tasks under a "Completed"
 *     heading and was an exact duplicate of the "Current" band above it. A
 *     user who marked a task done watched it stay put in a band labelled
 *     Completed, which reads as "done did not work".
 *   - SCALARS take the LATER value, because a scalar has no intersection.
 *     Argument order is therefore load-bearing: section, then tab, then
 *     chips. `deleted` is the case that matters, and PHASE 7 SHARPENED IT.
 *     Every category tab now carries `deleted:'exclude'` and the ARCHIVE CHIP
 *     carries `'only'` or `'include'` — chips apply LAST, so the chip wins and
 *     "archived AND in progress" is askable. Reading that pair as a
 *     contradiction instead would empty the archive against every tab, which
 *     is exactly the failure the old Archived TAB had against every section.
 *     Archived is orthogonal to status; the composition rule is what makes it
 *     expressible as a filter rather than as a partition member.
 *   - EMPTY. An empty intersection is not `[]`. `status: []` means NO
 *     CONSTRAINT — client-side and server-side both — so emitting it would
 *     turn "nothing can satisfy this" into "show me everything", which is the
 *     loudest possible wrong answer.
 *
 * So: `null` means the constraints cannot be satisfied together, and only an
 * ARRAY can produce it. The caller must render that as a stated empty state
 * and issue NO query — asking the server a question you already know is
 * unsatisfiable wastes a round trip and gets back a `[]` indistinguishable
 * from a genuinely empty collection.
 *
 * This subsumes `scopeToTier`, which composed the section/tab pair under
 * exactly these rules. Two functions for one law is one too many, and the
 * chips need the same treatment the tab got.
 *
 * ONE CROSS-KEY RELATIONSHIP IS DECLARED RATHER THAN KNOWN HERE: a status
 * chip carries its own `category` beside its `status` (`registry.statusFilter`),
 * so picking `Done` on the To Do tab is an EMPTY ARRAY INTERSECTION under the
 * rule above and gets the stated refusal. Without that second member the tab
 * and the chip would be different keys, the merge would succeed, and the
 * server would answer honestly with nothing — an unexplained empty list, which
 * is what this function exists to prevent.
 */
export function narrow(...parts: readonly (QueryFilter | undefined | null)[]): QueryFilter | null {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part as Record<string, unknown>)) {
      if (!(key in out)) {
        out[key] = value;
        continue;
      }
      const prior = out[key];
      if (Array.isArray(prior) && Array.isArray(value)) {
        const both = prior.filter((v) => value.includes(v));
        if (both.length === 0) return null;
        out[key] = both;
        continue;
      }
      // Scalar: the later part wins. Only an ARRAY intersection can be empty,
      // so only an array can make a band unsatisfiable.
      out[key] = value;
    }
  }
  return out as QueryFilter;
}

/**
 * D20 RETIRED (D56). The client-side status partition that used to run here is
 * DELETED, not translated: the contract gained
 * `CollectionQuery.filters.sessionStatus`, so the tab's own `filter` is an
 * ordinary filter the SEAM executes, exactly like the task tabs beside it.
 *
 * Deliberately not re-implemented against `filter.sessionStatus` — that would
 * put server-side filtering on the client as well, and the two would disagree
 * the moment a status is added. One filter, executed once, at the seam.
 */
function bandFilter(
  filter: QueryFilter,
  tab: StatusCategoryTab | null,
  selected: Readonly<Record<string, readonly string[]>>,
  config: KindConfig,
  ctx: ActionContext,
  selectedPeople: readonly string[] = [],
  /* The collection lens — a fourth axis, composed by the same `narrow` rules.
     `edge` is a scalar clause (an object, not an array), and only the lens
     writes it, so the later-wins rule cannot produce a contradiction here. */
  lens?: QueryFilter,
): QueryFilter | null {
  return narrow(
    filter,
    tab?.filter,
    mergeSelectedFilters(config, selected, ctx),
    /* `createdByIds` IS NOT A MEMBER OF `CollectionQuery.filters` — it belongs
       to `EntityConnectionsQuery`. This is carried through unchanged because
       it is what the people chip already did, but it only ever type-checked
       because it was written as a SPREAD, and excess-property checking does
       not look inside one. Passed as an argument the compiler objects, hence
       the cast, which is here to keep the gap visible rather than to close it.
       The people filter is therefore very likely inert at the seam; giving it
       a real member is a contract amendment and a separate task. */
    selectedPeople.length > 0 ? ({ createdByIds: [...selectedPeople] } as QueryFilter) : undefined,
    lens,
  );
}

/** Frozen so an unsatisfiable band keeps referential identity across renders. */
const NO_ROWS: readonly EntitySummary[] = Object.freeze([]);

function rowsForBand(
  props: EntityListPanelProps,
  filter: QueryFilter,
  tab: StatusCategoryTab | null,
  selected: Readonly<Record<string, readonly string[]>>,
  config: KindConfig,
  selectedPeople: readonly string[] = [],
  sort?: SortKey,
): readonly EntitySummary[] {
  /**
   * D20 RETIRED (D56). The client-side status partition that used to run here
   * is DELETED, not translated: the contract gained
   * `CollectionQuery.filters.sessionStatus`, so the tab's own `filter` is an
   * ordinary filter the SEAM executes, exactly like the task tabs beside it.
   *
   * Deliberately not re-implemented against `filter.sessionStatus` — that
   * would put server-side filtering on the client as well, and the two would
   * disagree the moment a status is added. One filter, executed once, at the
   * seam.
   */
  const merged = bandFilter(filter, tab, selected, config, props.ctx, selectedPeople);
  // Disjoint band: the section asks for statuses this tab excludes, so it can
  // hold nothing. Its caller skips the heading entirely — see `sectionsFor`.
  return merged === null ? NO_ROWS : props.rowsFor(merged, sort);
}

/**
 * A tab's count is its OWN query's answer — the same source the tab label, the
 * footer line and the kind-selector total all read. A count FIELD on the
 * registry would be a second source, free to disagree with the query it claims
 * to summarise (A1a's design note, and it is the right one).
 *
 * PHASE 7 — THE NUMBER IS NOW A SERVER AGGREGATE. It used to be
 * `rowsFor(filter).length`: the LOADED rows, which stop at the page the server
 * served, so a 601-row Done tab read `50` and the honest `countLabel` hedge
 * turned that into `50+`. One source is what stopped the three surfaces
 * DISAGREEING; it never stopped them being wrong TOGETHER, which is the worse
 * failure because it looks like a working feature.
 *
 * `page.total` is a `CollectionResult` member the facade now populates for
 * every collection read — a `count(*)` over the same WHERE, cursor excluded.
 * `entities.status_category` is indexed (migration 147) and every tab's filter
 * is exactly that predicate, so the four counts are four index aggregates.
 *
 * `n` FALLS BACK to the loaded length when the server volunteered no total —
 * a rolling node that predates the aggregate — and `countLabel` still renders
 * the `+`. Absence stays "we do not know", never a fabricated exact number.
 *
 * COUNTED UNDER NO SORT, DELIBERATELY. A count is order-independent and the
 * read key includes the sort, so counting under the active sort would fire a
 * fresh query per tab every time the user reorders, to learn a number that
 * cannot have changed.
 */
function tabCount(
  props: EntityListPanelProps,
  config: KindConfig,
  tab: StatusCategoryTab,
): { n: number; label: string; exact: boolean } {
  const merged = bandFilter(tab.filter, tab, {}, config, props.ctx);
  if (merged === null) return { n: 0, label: '0', exact: true };
  const page = props.pageStateOf?.(merged);
  const loaded = props.rowsFor(merged).length;
  return {
    n: page?.total ?? loaded,
    label: countLabel(loaded, page),
    exact: page?.total !== undefined,
  };
}

/**
 * HAS THE VIEWER EVER PICKED A CATEGORY TAB FOR THIS KIND — the question the
 * landing correction turns on, and one `usePanelChoice` cannot answer: its
 * return conflates "nothing stored" with "the viewer stored the default", and
 * only the second may pin an empty band open (a pick always wins).
 *
 * The key mirrors the hook's exactly — `CHOICE_PREFIX` in `kit/PanelResizer`
 * plus the `list-category.${kind}` id the panel passes it. The prefix is not
 * exported and this is a read-only peek at presence, so the spelling is
 * repeated here rather than widening the kit surface for one caller; the
 * validity predicate is the same one the hook runs, so a tab id a retired
 * build wrote reads as "nothing remembered" on both paths.
 */
function hasStoredTabChoice(kind: string, valid: (candidate: string) => boolean): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(`tm8ui.panel-choice.list-category.${kind}`);
    return raw !== null && valid(raw);
  } catch {
    // Private mode / blocked storage: nothing can have been remembered.
    return false;
  }
}

/**
 * The lens's honesty line. TWO numbers from TWO sources, both named for what
 * they are: the count of THIS KIND's members is the lens query's own result
 * size (`countLabel` adds the `+` when the page saturated), and the set's
 * total membership is its summary's own aggregate, read structurally —
 * `state.itemCount` where the set kind carries one, absent otherwise. When
 * the total is unknown the sentence simply stops after the kind count rather
 * than inventing a denominator.
 */
function LensNote({
  set,
  filter,
  props,
  config,
}: {
  set: EntitySummary;
  filter: QueryFilter;
  props: EntityListPanelProps;
  config: KindConfig;
}) {
  const rows = props.rowsFor(filter);
  const label = countLabel(rows.length, props.pageStateOf?.(filter));
  const itemCount = (set.state as unknown as Record<string, unknown>).itemCount;
  const total = typeof itemCount === 'number' ? itemCount : null;
  return (
    <div className="lp__lensnote" data-testid="collection-lens-note">
      {total !== null
        ? `Only members of “${set.title}” are shown — ${label} of its ${total} item${total === 1 ? '' : 's'} are ${config.labelPlural.toLowerCase()}.`
        : `Only members of “${set.title}” are shown.`}
    </div>
  );
}

/**
 * The '● N live' count is rows ∩ the SEAM LIVE SET. Never a count of rows
 * whose record says "running" — that number would include every stale session
 * and would be exactly the overstatement the liveness read exists to fix.
 *
 * IT COUNTS THE OPEN TAB, not the kind (user report 2026-08-19: "live session
 * count is shown in both in progress and done, does it make sense"). It was
 * `rowsFor(spec.filter)` with the tab never applied, so one unchanging number
 * sat beside a tab row whose every other number moved — reading, under Done,
 * as a claim that Done holds live sessions.
 *
 * That was merely confusing while nothing live could BE under Done. It stops
 * being merely confusing with the tick: a session marked done keeps running,
 * so "live, under Done" is now a real and useful population, and a badge that
 * cannot tell you its size is answering the wrong question.
 *
 * `narrow` returns null for a contradiction — a tab whose filter cannot
 * intersect the spec's. That is zero rows and therefore zero live, which is
 * what `NO_ROWS` produces without asking the seam.
 */
interface ListLiveCount {
  value: number;
  label: string;
}

function liveCountFor(
  props: EntityListPanelProps,
  config: KindConfig,
  tab: StatusCategoryTab | null,
): ListLiveCount | null {
  const spec = config.list.liveCount;
  if (!spec || !props.liveIds) return null;
  const merged = narrow(spec.filter, tab?.filter);
  const rows = merged === null ? NO_ROWS : props.rowsFor(merged);
  const live = new Set(props.liveIds);
  const value = rows.filter((r) => live.has(r.id)).length;
  return { value, label: spec.label(value) };
}

// ---------------------------------------------------------------------------
// Header rows
// ---------------------------------------------------------------------------

function KindSelector({
  config,
  total,
  liveCount,
  onKindChange,
}: {
  config: KindConfig;
  /**
   * Sum of the lifecycle tabs — T0-1 draws it beside the kind name.
   *
   * A STRING, because the honest value may be `601+`. Summing three tab
   * counts each capped at a page produced `150` for a 700-row space and said
   * it with a number's confidence; carrying the `+` up from whichever tab is
   * truncated keeps the total as honest as its worst input.
   */
  total?: string;
  liveCount: ListLiveCount | null;
  onKindChange?: (kind: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const initialFocus = useRef<'current' | 'first' | 'last'>('current');
  const menuId = useId();
  const groups = homeRailGroups();
  const currentGroup = groups.find((group) =>
    group.kinds.some((kind) => kind.kind === config.kind),
  );
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissable(open, ref, dismiss, triggerRef);

  const menuItems = useCallback(
    () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      ),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const items = menuItems();
    const target =
      initialFocus.current === 'first'
        ? items[0]
        : initialFocus.current === 'last'
          ? items.at(-1)
          : items.find((item) => item.getAttribute('aria-current') === 'page') ?? items[0];
    target?.focus();
  }, [config.kind, menuItems, open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
    setOpen(true);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const active = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? active <= 0
              ? items.length - 1
              : active - 1
            : active < 0 || active === items.length - 1
              ? 0
              : active + 1;
    items[next]?.focus();
  };

  return (
    <div className="lp__selector" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="lp__kind k-press"
        onClick={() => {
          initialFocus.current = 'current';
          setOpen((value) => !value);
        }}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        aria-label={config.labelPlural}
      >
        <span className="lp__kind-glyph" aria-hidden>
          <KindIcon kind={config.kind} />
        </span>
        <span className="lp__kindcopy">
          <span className="lp__kindfamily k-label">{currentGroup?.label ?? 'Entities'}</span>
          <span className="lp__kindname">{config.labelPlural}</span>
        </span>
        <span className="lp__caret" aria-hidden>
          ▾
        </span>
      </button>
      <span className="lp__spacer" />
      {total !== undefined || liveCount !== null ? (
        <span className="lp__selector-metrics">
          {total !== undefined ? (
            <span data-testid="kind-total">
              <EntityNavigationMetrics total={total} />
            </span>
          ) : null}
          {liveCount !== null ? (
            <span data-testid="list-live-count">
              <EntityNavigationMetrics
                live={liveCount.value}
                showZeroLive
                liveAnnouncement={liveCount.label}
              />
            </span>
          ) : null}
        </span>
      ) : null}
      {open ? (
        <ul
          ref={menuRef}
          id={menuId}
          className="lp__kindmenu k-enter-pop"
          role="menu"
          aria-label="Entity types"
          onKeyDown={onMenuKeyDown}
        >
          {/* Only `strategy: 'collection'` kinds can be a list. Membership,
              family order and custom-kind fallback are all registry data. */}
          {groups.map((group) => (
            <li key={group.id} role="none" className="lp__kindgroup">
              <div className="lp__kindgroup-head">
                <span className="lp__kindgroup-label k-label">{group.label}</span>
                <span className="lp__kindgroup-count" aria-label={`${group.kinds.length} entity types`}>
                  {group.kinds.length}
                </span>
              </div>
              <ul
                className="lp__kindgroup-items"
                role="group"
                aria-label={`${group.label}: ${group.description}`}
              >
                {group.kinds.map((kind) => {
                  const current = kind.kind === config.kind;
                  return (
                    <li key={kind.kind} role="none">
                      <button
                        type="button"
                        role="menuitem"
                        data-kind={kind.kind}
                        aria-current={current ? 'page' : undefined}
                        className={
                          current
                            ? 'lp__kindopt lp__kindopt--current k-press'
                            : 'lp__kindopt k-press'
                        }
                        onClick={() => {
                          setOpen(false);
                          triggerRef.current?.focus();
                          onKindChange?.(kind.kind);
                        }}
                      >
                        <KindIcon kind={kind.kind} />
                        <span className="lp__kindopt-label">{kind.labelPlural}</span>
                        {current ? <span className="lp__kindopt-current">Current</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HeaderActions({
  config,
  ctx,
  onCreate,
  createSlot,
  onAction,
  wiredActions,
  hostOwnsBirth,
}: {
  config: KindConfig;
  ctx: ActionContext;
  onCreate?: () => void;
  createSlot?: React.ReactNode;
  onAction?: (ref: ActionRef, entityId: string) => void;
  wiredActions?: readonly ActionRef[];
  /**
   * The host draws the kind cell (`selectorSlot: 'host'`), so the host's ＋
   * half already carries this kind's birth verb — see `ListRootHeader`'s
   * `rootBirthAction`. USER RULING 2026-08-19: on those surfaces this row must
   * not draw it a second time. It sat directly beneath the cell that now owns
   * it, which made `▮ Terminal` the only control on the sessions list with two
   * live copies one row apart.
   *
   * Scoped to `quickStart` and to hosted cells ON PURPOSE. The `k/` collection
   * screen draws the panel's OWN `KindSelector`, whose cell has no ＋ at all,
   * so there the verb has nowhere else to live and stays here.
   */
  hostOwnsBirth?: boolean;
}) {
  const { quickCreate, quickLaunch, quickStart } = config.list;
  // Per-verb, not per-header. `chrome.tsx`'s exact expression: an unwired verb
  // is handed `undefined` and renders refused, rather than the header deciding
  // for all of its verbs at once.
  const dispatcherFor = (ref: ActionRef): typeof onAction =>
    wiredActions && !wiredActions.includes(ref) ? undefined : onAction;
  const showCreate = Boolean(quickCreate && (createSlot || onCreate));
  /*
   * `dispatcherFor(...)`, NOT `onAction` — USER RULING 2026-08-17, and it
   * narrows D64 rather than reversing it.
   *
   * D64's rule was that an unwired verb renders refused, because a control
   * nobody can see cannot be reported as missing. That rule earned its keep:
   * the header once drew NOTHING at all, and drawing `Launch session ▸`
   * refused is what made task 019ff248 reportable in the first place.
   *
   * But `wiredActions` is not "not built yet" — it is the host stating which
   * verbs it performs. `useSessionStart` omits `launch-session` deliberately
   * and PERMANENTLY: that verb opens the launch sheet against a subject, and
   * a list header has no subject to name. So the refusal could never resolve
   * into a live button no matter what anyone built. A permanently-refused
   * control is not honesty, it is furniture, and it had been sitting in the
   * sessions header explaining itself to every reader since 101.
   *
   * The distinction the two cases turn on:
   *   - `onAction` absent entirely   → the host wired NO dispatcher. Draw the
   *     declared verbs refused; the gap is real and worth reporting. (D64.)
   *   - `wiredActions` excludes it   → the host wired a dispatcher and said
   *     this verb is not one of its acts. Do not draw it.
   *
   * Scoped to this header ON PURPOSE. `detail/chrome.tsx:303` reads the same
   * prop and still refuses rather than hides — a detail panel is ABOUT one
   * entity, so a verb missing from its verb row is a question the reader will
   * actually ask.
   */
  const showLaunch = Boolean(quickLaunch && dispatcherFor(quickLaunch));
  const showStart = Boolean(!hostOwnsBirth && quickStart && dispatcherFor(quickStart));
  if (!showCreate && !showLaunch && !showStart) return null;

  return (
    <div className="lp__actions">
      {/* Authoring mount 7a: when the host supplies a REAL create flow it
          replaces the bare button — which was INERT when onCreate was absent
          (the audit's '+New inert' row). No slot and no onCreate ⇒ nothing
          renders enabled-dead. */}
      {showCreate && createSlot ? (
        createSlot
      ) : showCreate && onCreate ? (
        <button type="button" className="lp__new" onClick={onCreate}>
          + New
        </button>
      ) : null}
      {showLaunch && quickLaunch ? (
        <QuickLaunch ref_={quickLaunch} ctx={ctx} onAction={dispatcherFor(quickLaunch)} />
      ) : null}
      {/* Beside `Launch session ▸`, in the same slot (user ruling 2026-08-12).
          It is `QuickStart`, not a second `QuickLaunch`: the launch verb's
          label carries a `▸` because it EXPANDS a config, and wearing that
          glyph while committing on click would promise a card that never
          opens. */}
      {showStart && quickStart ? (
        <QuickStart ref_={quickStart} ctx={ctx} onAction={dispatcherFor(quickStart)} />
      ) : null}
    </div>
  );
}

/**
 * A header verb that COMMITS on click — the counterpart to {@link QuickLaunch},
 * which expands.
 *
 * Same three-state honesty as every other control (R5 #9): unwired renders
 * disabled-with-reason rather than enabled-inert, a refused availability
 * renders its own reason, and only a wired-and-available verb is a live button.
 */
function QuickStart({
  ref_,
  ctx,
  onAction,
}: {
  ref_: ActionRef;
  ctx: ActionContext;
  onAction?: (ref: ActionRef, entityId: string) => void;
}) {
  const def = resolveAction(ref_);
  if (!onAction) return <DisabledAction reason={NOT_WIRED_REASON}>{def.label}</DisabledAction>;
  const availability = def.availability(ctx);
  if (availability.kind === 'disabled') {
    return (
      <DisabledIconControl label={def.label} reason={toReason(availability.reason)}>
        {def.label}
      </DisabledIconControl>
    );
  }
  return (
    <button
      type="button"
      className="lp__quick"
      data-testid="list-quick-start"
      onClick={() => onAction?.(ref_, ctx.entityId ?? '')}
    >
      {`${def.icon} ${def.label}`}
    </button>
  );
}

function QuickLaunch({
  ref_,
  ctx,
  onAction,
}: {
  ref_: ActionRef;
  ctx: ActionContext;
  onAction?: (ref: ActionRef, entityId: string) => void;
}) {
  const def = resolveAction(ref_);
  // R5 #9: unwired renders disabled-with-reason, never enabled-inert.
  if (!onAction) return <DisabledAction reason={NOT_WIRED_REASON}>{`${def.label} ▸`}</DisabledAction>;
  const availability = def.availability(ctx);
  if (availability.kind === 'disabled') {
    return (
      <DisabledIconControl label={def.label} reason={toReason(availability.reason)}>
        {`${def.label} ▸`}
      </DisabledIconControl>
    );
  }
  return (
    <button type="button" className="lp__quick" onClick={() => onAction?.(ref_, ctx.entityId ?? '')}>
      {`${def.label} ▸`}
    </button>
  );
}

/**
 * THE FILTER ROW — active chips · one `filter ▾` trigger · sort.
 *
 * A `FilterSpec` is ONE CHIP, not one chip per option — the type says so
 * ("One filter chip in the list/collection filter row") and all three T0-3
 * frames draw it that way: `mine ✕  filter ▾  ↓ priority` at 280px,
 * `filter ▾  ↓ edited` with nothing active, `mine ✕  ↓` at the 200 floor.
 *
 * This previously flat-mapped every option into its own chip, which put TEN
 * chips in the task panel's row (7 status + 1 ready-to-pull + 2 deleted) and
 * overflowed it at every width. That is the D34 floor-inversion class again —
 * unbounded content in a fixed slot destroying the slot — with a different
 * root: not a long word, but a misread of what a FilterSpec IS. The row is
 * `overflow: hidden`, so the excess was silently clipped rather than wrapping,
 * which is why it read as a truncated chip label instead of as ten chips.
 *
 * The row is now bounded BY CONSTRUCTION: one chip per ACTIVE selection (the
 * user chose each one and can see it), plus exactly one trigger, plus sort.
 * The unbounded set lives in the popover, which scrolls.
 */
/**
 * THE SEARCH ROW — T0-1 draws it as its OWN 28px bordered row between the
 * create row and the tabs: `⌕ {placeholder}` … kbd hint. Not a pill in the
 * filter row, which is where I first put it.
 *
 * THE HINT READS `f`, NOT `/`. The canvas pixel says `/`; D36 supersedes it,
 * and the reasoning is worth keeping next to the code: `/` is the palette's
 * GUARANTEED path because ⌘K is browser-owned on Chrome Win/Linux and Firefox
 * everywhere. A focused list is the most common focus state, so spending `/`
 * here would leave the palette unreachable exactly where users spend their
 * time. Search gets its own guaranteed key rather than borrowing a committed
 * one.
 *
 * The keyboard controller focuses this input on the `list.search` command and
 * never touches the DOM itself; layer 4 then makes every plain key type
 * normally and Esc blur the field, so this component needs no key guards.
 */
function SearchRow({
  config,
  query,
  onQuery,
  inputRef,
}: {
  config: KindConfig;
  query: string;
  onQuery: (q: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="lp__searchrow">
      <span className="lp__searchrow-glyph" aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        className="lp__searchinput"
        type="search"
        value={query}
        placeholder={`Search ${config.labelPlural.toLowerCase()}`}
        aria-label={`Search ${config.labelPlural.toLowerCase()}`}
        onChange={(e) => onQuery(e.target.value)}
        data-testid="list-search"
      />
      <kbd className="lp__searchrow-key">f</kbd>
    </div>
  );
}

/**
 * THE THREE STATES OF A TIER TAB, resolved in one place so the class list and
 * the label can never disagree about which one a tab is in.
 *
 * ACTIVE WINS OVER EMPTY, and the order matters: the tab you are standing in
 * keeps its full weight and its count even when the band it names holds
 * nothing, because "where you are" outranks "how much is here". An empty tab
 * you are NOT in is the one that demotes. Without this precedence, landing on
 * an empty band would dim the one tab the reader most needs to locate.
 */
function tabClass(active: boolean, empty: boolean): string {
  if (active) return 'lp__tab lp__tab--active';
  return empty ? 'lp__tab lp__tab--empty' : 'lp__tab';
}

/**
 * THE LIFECYCLE TIER TABS — Open / Done / Archived, universal across
 * collection kinds (D41, user-ratified). Their own row: a tab is the
 * lifecycle band you are looking at, and the filter chips below narrow WITHIN
 * it. T0-1 draws both, and the count on each tab comes from that tab's own
 * query — the same source as the footer line and the kind-selector total.
 */
function CategoryTabs({
  tabs,
  activeTabId,
  onTab,
  tabLabel,
  tabEmpty,
}: {
  tabs?: readonly StatusCategoryTab[];
  activeTabId: string | null;
  onTab: (id: string) => void;
  /** Already rendered — `50+` when the page is saturated, `50` when it is all. */
  tabLabel: (tab: StatusCategoryTab) => string;
  /**
   * Does this tab's own query hold nothing? PASSED, not parsed back out of
   * `tabLabel`. The producer (`tabCount`) already computes `{ n, label, exact }`
   * and this component was only ever handed the rendered string, so the only
   * way to know a tab was empty was to read its label back as a number — which
   * is how `22+` becomes 22 and how `0` from a truncated page becomes a lie.
   * A fact the producer holds is threaded, never re-derived from its own
   * rendering. Absent ⇒ nothing is treated as empty, so the row is unchanged.
   */
  tabEmpty?: (tab: StatusCategoryTab) => boolean;
}) {
  /*
   * THE PHONE DRAWS THE MARKS AND NOT THE WORDS — owner ruling, 2026-08-19.
   *
   * `To Do 266` × 4 does not fit across 390px, so the row was `overflow-x:
   * auto`: four 44px-tall tabs on a scroller, of which two and a bit were ever
   * on screen. A control whose fourth position is reachable only by a
   * horizontal flick inside a vertically-scrolling screen is one most readers
   * never discover — and this is the axis the whole list is filtered on.
   *
   * Four marks fit at 97px each with the touch floor cleared twice over, and
   * the row stops scrolling. The COUNTS are not dropped, they move to
   * `aria-label` ("To Do, 266"): a screen reader still reads them, and so does
   * the tap census, which is how this program checks its own targets.
   *
   * `oneSurface`, NOT a media query — `mobile/CONTRACT.md` and the same seam
   * every other phone branch in a shared screen uses. It is false on every
   * desktop mount by construction, so the desktop DOM is byte-identical.
   */
  const { oneSurface } = useMobileSurface();
  if (!tabs || tabs.length === 0) return null;
  return (
    <div className="lp__tierrow" role="tablist" aria-label="Lifecycle">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={tabClass(tab.id === activeTabId, tabEmpty?.(tab) ?? false)}
          onClick={() => onTab(tab.id)}
          /* THE COUNT IS NEVER LOST, IT ONLY STOPS BEING PAINTED. The phone
             already moved it here because four counted tabs do not fit across
             390px; an emptied desktop tab moves it here for the same reason in
             a different currency — the zero was spending pixels and attention
             to say nothing. Either way a screen reader still hears "Cancelled,
             0", and dropping the label without this line would delete the fact
             instead of demoting it. */
          {...(oneSurface || (tabEmpty?.(tab) ?? false)
            ? { 'aria-label': `${tab.label}, ${tabLabel(tab)}` }
            : {})}
        >
          {oneSurface ? (
            <CategoryGlyph category={tab.id} />
          ) : (tabEmpty?.(tab) ?? false) ? (
            /* NAME WITHOUT COUNT. A tab reading `To Do 0` is a control
               advertising its own emptiness — the count is the only part
               saying "nothing here", and it says it in the row the reader
               scans to choose where to go. The NAME is what makes the
               workflow legible, so the name stays and the zero goes. The tab
               remains present, focusable and clickable: hiding it answers
               "where is To Do?" with silence, which is worse than a zero. */
            tab.label
          ) : (
            `${tab.label} ${tabLabel(tab)}`
          )}
        </button>
      ))}
    </div>
  );
}

function FilterRow({
  config,
  picker,
  onPicker,
  selected,
  onToggleOption,
  sortKey,
  onSort,
  compact,
  people,
  selectedPeople,
  onTogglePerson,
  viewerActorId,
  membership,
  membershipSets,
  lensSet,
  onLens,
}: {
  config: KindConfig;
  /** Which of the four is open. Held by the panel — see `ListPicker`. */
  picker: ListPicker | null;
  onPicker: (picker: ListPicker | null) => void;
  selected: Readonly<Record<string, readonly string[]>>;
  onToggleOption: (specId: string, optionId: string, multi: boolean) => void;
  sortKey: SortKey | undefined;
  onSort: (key: SortKey) => void;
  compact?: boolean;
  people: readonly ActorSummary[];
  selectedPeople: readonly string[];
  onTogglePerson: (actorId: string) => void;
  /** Absent ⇒ the viewer-scoped options render disabled with their reason. */
  viewerActorId?: string;
  /** The registry's lens declaration; absent ⇒ this kind has no lens. */
  membership?: MembershipListControl;
  /** The host-hydrated sets page. `undefined` ⇒ the host wired no source. */
  membershipSets?: readonly EntitySummary[];
  /** The active lens, resolved to its summary (title for the chip). */
  lensSet: EntitySummary | null;
  onLens: (setId: string | null) => void;
}) {
  const setPicker = onPicker;
  const barRef = useRef<HTMLDivElement>(null);
  /*
   * THE PHONE'S SHEETS ARE PORTALLED, SO OUTSIDE-CLICK IS THE WRONG DISMISSAL.
   *
   * `useDismissable` closes when a pointer lands outside `barRef`. On the phone
   * the bar itself is `display: none` (`mobile-screens.css` §9) and the picker
   * is a `MobileSheet` — a portal into the frame's sheet host, which is by
   * definition outside that ref. So the FIRST tap inside the sheet would close
   * it, and the sheet would read as one that refuses to stay open.
   *
   * The sheet already carries all three dismissal routes of its own (the ✕, the
   * backdrop, Escape) through one callback, so nothing is lost by standing this
   * down where it does not apply.
   */
  const { oneSurface, sheetHost } = useMobileSurface();
  const inSheet = oneSurface && sheetHost !== null;
  useDismissable(!inSheet && picker !== null, barRef, useCallback(() => setPicker(null), [setPicker]));
  const sort = config.list.sort;
  const current = sort.find((s) => s.key === sortKey) ?? sort[0];

  const active = config.list.filters.flatMap((spec) =>
    (selected[spec.id] ?? []).flatMap((optionId) => {
      const option = spec.options.find((o) => o.id === optionId);
      return option ? [{ spec, option }] : [];
    }),
  );

  /**
   * ONE BODY, TWO CONTAINERS — a hanging popover on a desktop, a bottom sheet
   * on a phone.
   *
   * The four option lists are the same lists either way; what differs is the
   * surface they arrive on. Writing them twice is how the phone's copy of the
   * collection lens ends up a release behind the desktop's, which is the
   * failure `MobileSheet`'s own header comment describes for the aux column.
   *
   * `.lp__filtermenu` CANNOT BE THE SHEET'S CONTAINER: it is `position:
   * absolute` at `176px` wide with a `240px` scroll cap, sized to hang off a
   * 32px row. Inside a 72%-tall sheet that is a small floating card pinned to
   * the sheet's top-left corner. So the sheet gets its own container and the
   * body it wraps is identical.
   */
  const narrowing = (
    key: ListPicker,
    title: string,
    testId: string,
    menuClass: string,
    body: ReactNode,
  ): ReactNode => {
    if (picker !== key) return null;
    if (!inSheet) {
      return (
        <div className={menuClass} role="menu" data-testid={testId}>
          {body}
        </div>
      );
    }
    return (
      <MobileSheet title={title} onDismiss={() => setPicker(null)} testId={`list-sheet-${key}`}>
        <div className="lp__sheetmenu" role="menu" data-testid={testId}>
          {body}
        </div>
      </MobileSheet>
    );
  };

  return (
    <div className="lp__filterbar" ref={barRef}>
    <div className="lp__filters">
      {/* Filter chips and the picker trigger. The lifecycle TABS are a
          separate row above (CategoryTabs): tabs are a lifecycle TIER and filters
          narrow WITHIN it, so they coexist — T0-1 draws both. They were an
          either/or here only while work_session was the one kind with tabs,
          and making tabs universal exposed that shortcut by deleting the
          filter chips from every kind at once. */}
      {active.map(({ spec, option }) => (
        <button
          key={`${spec.id}:${option.id}`}
          type="button"
          className="lp__chip lp__chip--active"
          onClick={() => onToggleOption(spec.id, option.id, spec.multi ?? false)}
          title={`Clear filter: ${option.label}`}
        >
          {`${option.label} ✕`}
        </button>
      ))}
      {selectedPeople.flatMap((actorId) => {
        const person = people.find((candidate) => candidate.id === actorId);
        return person ? [(
          <button
            key={`person:${person.id}`}
            type="button"
            className="lp__chip lp__chip--active lp__chip--person"
            onClick={() => onTogglePerson(person.id)}
            title={`Clear people filter: ${person.displayName}`}
          >
            <Avatar
              actorId={person.id}
              provenance={person.isAgent ? 'agent' : 'human'}
              label={person.displayName}
              size={15}
              src={person.avatar ?? null}
            />
            <span>{`${person.displayName} ✕`}</span>
          </button>
        )] : [];
      })}
      {config.list.filters.length > 0 ? (
        <button
          type="button"
          className="lp__chip"
          onClick={() => setPicker(picker === 'filters' ? null : 'filters')}
          aria-expanded={picker === 'filters'}
          aria-haspopup="menu"
          data-testid="filter-trigger"
        >
          {/* ONE CASING RULE FOR THE WHOLE HEADER: Title Case, because the
              tier row above already speaks it and its labels are registry
              data this file does not own. Two casing systems in adjacent rows
              is noise the reader has to resolve before deciding it means
              nothing — `To Do` / `In Progress` above, `filter` / `people` /
              `collections` below, with no semantic difference to justify the
              split. Matching UP to the row we cannot change is the only
              choice that makes the header consistent without touching the
              registry. */}
          Filter ▾
        </button>
      ) : null}
      {people.length > 1 ? (
        <button
          type="button"
          className={selectedPeople.length > 0 ? 'lp__chip lp__chip--active' : 'lp__chip'}
          onClick={() => setPicker(picker === 'people' ? null : 'people')}
          aria-expanded={picker === 'people'}
          aria-haspopup="menu"
          data-testid="people-filter-trigger"
        >
          {selectedPeople.length > 0 ? `People · ${selectedPeople.length}` : 'People ▾'}
        </button>
      ) : null}
      {/* The collection lens trigger. Rendered exactly when the registry
          declares the lens AND the host wired a sets source — an unwired
          source is the panel's ordinary "this host has no X" absence, the
          same rule the people chip and `boardFor` follow. The active lens
          renders as its own dismissable chip like every other active filter. */}
      {membership && membershipSets !== undefined ? (
        lensSet ? (
          <button
            type="button"
            className="lp__chip lp__chip--active"
            onClick={() => onLens(null)}
            title={`Clear ${membership.label.toLowerCase()} lens: ${lensSet.title}`}
            data-testid="collection-lens-chip"
          >
            {`${lensSet.title} ✕`}
          </button>
        ) : (
          <button
            type="button"
            className="lp__chip"
            onClick={() => setPicker(picker === 'sets' ? null : 'sets')}
            aria-expanded={picker === 'sets'}
            aria-haspopup="menu"
            data-testid="collection-lens-trigger"
          >
            {/* `.toLowerCase()` DROPPED, not overlooked. It was the one place
                the lowercasing was applied in code rather than typed into a
                literal, so it was also the only one that would have kept
                re-lowercasing a registry label after the other two were fixed
                — the header would have gone back to two casings the moment a
                kind declared a lens. The registry's own casing now stands. */}
            {`${membership.label} ▾`}
          </button>
        )
      ) : null}

      <span className="lp__spacer" />

      {/* A MENU, NOT A CYCLE. The chip used to advance to the next entry on
          each click, which is a fine affordance for two options and unusable
          for six: choosing `priority` from a list of six meant clicking
          through up to five orders the user did not want, each one a real
          query. It also never showed what the alternatives WERE. */}
      {current ? (
        <button
          type="button"
          className="lp__chip"
          onClick={() => setPicker(picker === 'sort' ? null : 'sort')}
          aria-expanded={picker === 'sort'}
          aria-haspopup="menu"
          title={`Sorted by ${current.label}`}
          /* A LONE GLYPH IS NOT A NAME. At the floor this collapses to `↓`,
             and an arrow is not self-describing: it could be sort direction,
             download, or scroll-to-bottom, and the reader is left inferring a
             meaning the control asserts about itself. `title` gives a pointer
             user a tooltip on hover and gives a touch user nothing at all.
             The accessible name is stated in words, always — the same
             colour+word rule the status pills follow, applied to a glyph:
             never let the mark be the only thing carrying the meaning. */
          aria-label={`Sort: ${current.label}`}
          data-testid="sort-trigger"
        >
          {/* At the floor the sort chip collapses to its glyph — T0-3 frame 4
              draws exactly `↓`. The chip never disappears. */}
          {compact ? '↓' : `↓ ${current.label}`}
        </button>
      ) : null}

    </div>
      {narrowing('sort', 'Sort', 'sort-menu', 'lp__filtermenu lp__filtermenu--sort', (
        <>
          <div className="lp__filtergroup">SORT BY</div>
          {sort.map((spec) => (
            <button
              key={spec.key}
              type="button"
              role="menuitemradio"
              aria-checked={spec.key === current?.key}
              className={
                spec.key === current?.key ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'
              }
              onClick={() => {
                onSort(spec.key);
                setPicker(null);
              }}
            >
              {spec.label}
              {spec.key === current?.key ? <span className="lp__filtercheck">✓</span> : null}
            </button>
          ))}
        </>
      ))}
      {/* Rendered OUTSIDE the clipping row, inside the positioned bar: the row
          keeps `overflow: hidden` as its floor guard, and the picker is still
          free to overflow it. No hardcoded offset — `top: 100%` of the bar
          works whether or not this kind renders a header-actions row. */}
      {narrowing('filters', 'Filter', 'filter-menu', 'lp__filtermenu', (
        <>
          {config.list.filters.map((spec) => (
            <div key={spec.id}>
              <div className="lp__filtergroup">{spec.label.toUpperCase()}</div>
              {spec.options.map((option) => {
                const on = (selected[spec.id] ?? []).includes(option.id);
                // OFFERED AND REFUSED, never offered and inert. An option
                // naming the viewer with no viewer resolved would query
                // nobody and answer "you have nothing", which is a claim
                // about the data made out of ignorance about the identity.
                const blocked = needsViewer(option.filter) && !viewerActorId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    disabled={blocked}
                    title={
                      blocked
                        ? 'Not available: this workspace has not resolved who you are, so “me” has no id to match.'
                        : undefined
                    }
                    className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                    onClick={() => onToggleOption(spec.id, option.id, spec.multi ?? false)}
                  >
                    {option.label}
                    {on ? <span className="lp__filtercheck">✓</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </>
      ))}
      {membership ? narrowing('sets', membership.label, 'collection-lens-menu', 'lp__filtermenu', (
        <>
          <div className="lp__filtergroup">{membership.label.toUpperCase()}</div>
          {(membershipSets ?? []).length === 0 ? (
            /* An empty page is a real answer, said in its own words — never a
               bare menu that reads as "the space has none" when the truth may
               be "none exist YET". The sets source is a bounded recency page,
               so this is also where that bound is stated. */
            <p className="lp__filterempty" data-testid="collection-lens-empty">
              {/* "create one from its own list" only when the SET kind's own
                  list actually offers a create — the same quickCreate gate as
                  the kind screen's birth sentence, one level down. */}
              {`No ${membership.label.toLowerCase()} yet${
                getKind(membership.setKind).list.quickCreate ? ' — create one from its own list' : ''
              }. This menu offers the most recent page once any exist.`}
            </p>
          ) : (
            (membershipSets ?? []).map((set) => {
              const on = lensSet?.id === set.id;
              return (
                <button
                  key={set.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                  data-testid="collection-lens-option"
                  onClick={() => {
                    onLens(on ? null : set.id);
                    setPicker(null);
                  }}
                >
                  <KindIcon kind={set.kind} />
                  {set.title}
                  {on ? <span className="lp__filtercheck">✓</span> : null}
                </button>
              );
            })
          )}
        </>
      )) : null}
      {narrowing('people', 'People', 'people-filter-menu', 'lp__filtermenu', (
        <>
          <div className="lp__filtergroup">PEOPLE</div>
          {people.map((person) => {
            const on = selectedPeople.includes(person.id);
            return (
              <button
                key={person.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                onClick={() => onTogglePerson(person.id)}
              >
                <Avatar
                  actorId={person.id}
                  provenance={person.isAgent ? 'agent' : 'human'}
                  label={person.displayName}
                  size={20}
                  src={person.avatar ?? null}
                />
                <span>{person.displayName}</span>
                {on ? <span className="lp__filtercheck">✓</span> : null}
              </button>
            );
          })}
        </>
      ))}
    </div>
  );
}

/**
 * Merge every selected option's contract-shaped filter. Array members UNION
 * (several `status` options combine into one `status` list) rather than
 * overwrite, which is what `multi` means in the data.
 *
 * UNION HERE, INTERSECTION IN `narrow`, AND BOTH ARE RIGHT. Two options of the
 * SAME chip are alternatives the user ticked together — Open *or* Blocked —
 * so they widen. Two different AXES each say "only these", so they narrow.
 * Collapsing the two operators into one is how "Open ✓ Blocked ✓" came to
 * show only blocked rows.
 */
function mergeSelectedFilters(
  config: KindConfig,
  selected: Readonly<Record<string, readonly string[]>>,
  ctx: ActionContext,
): QueryFilter {
  const out: Record<string, unknown> = {};
  for (const spec of config.list.filters) {
    for (const optionId of selected[spec.id] ?? []) {
      const option = spec.options.find((o) => o.id === optionId);
      // A viewer-scoped option with no viewer is DROPPED, never sent. The
      // picker already renders it disabled with its reason, so this is the
      // second half of the same refusal — and it matters, because the server
      // `assertUuid`s these members and `'@me'` would come back as a 400 that
      // reads like a broken list rather than an unknown identity.
      if (!option || (needsViewer(option.filter) && !ctx.viewerActorId)) continue;
      for (const [key, value] of Object.entries(
        resolveViewer(option.filter, ctx.viewerActorId) as Record<string, unknown>,
      )) {
        const prior = out[key];
        out[key] =
          Array.isArray(prior) && Array.isArray(value) ? [...prior, ...value] : value;
      }
    }
  }
  return out as QueryFilter;
}

/** Substitute the real actor id wherever the registry wrote `VIEWER_ACTOR`. */
function resolveViewer(filter: QueryFilter, viewerActorId: string | undefined): QueryFilter {
  if (!viewerActorId || !needsViewer(filter)) return filter;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    out[key] = Array.isArray(value)
      ? value.map((v) => (v === VIEWER_ACTOR ? viewerActorId : v))
      : value === VIEWER_ACTOR
        ? viewerActorId
        : value;
  }
  return out as QueryFilter;
}

// ---------------------------------------------------------------------------
// Board (A2, doc 06 §1) — geometry only. Columns, headers, drag. The CARD is
// the existing Tile; the vocabulary is stateControl.options; the words and
// tones are panel.statusPill. This component never reads `kind`.
// ---------------------------------------------------------------------------

interface BoardColumnSpec {
  key: string;
  label: string;
  tone: PillTone;
  /** How a STATUS drop here dispatches. `null` ⇒ not a status drop target. */
  option: StateOption | null;
  /**
   * How an AXIS drop here dispatches (W3): the value this column means, with
   * `null` for the explicit no-value column (a drop there CLEARS the axis).
   * `undefined` ⇒ this is not an axis column. A drop is one dimension or the
   * other, never both — the board must never write a status while its
   * columns say something else (W3/4).
   */
  axisValue?: string | null;
  /**
   * THE §1.3 DONE SINK IS RETIRED (phase 7). It was a synthetic drop target
   * for the option routed `via:'complete'`, and it existed for exactly one
   * reason: the Open TIER excluded `done`, so the board had no terminal column
   * and the single most-performed kanban action was impossible. The board no
   * longer runs under a category tab at all — its columns ARE that partition
   * — so `done` is an ordinary fetched column with real rows, and a synthetic
   * one beside it would be a second Done that only ever holds the cards you
   * completed in this browser tab.
   *
   * The field stays so the three column builders keep one shape; it is `false`
   * everywhere and there is no branch left that sets it.
   */
  sink: false;
}

/**
 * Column MEMBERSHIP and ORDER = stateControl.options ∩ the active CATEGORY
 * TAB; words/tones from panel.statusPill. One source — the picker, the pill
 * and the column cannot drift (§1.3).
 */
function boardColumns(
  config: KindConfig,
  tab: StatusCategoryTab | null,
  groups: readonly CollectionGroup[],
): BoardColumnSpec[] {
  const stateControl = config.list.stateControl;
  const pill = config.panel.statusPill;
  const labelOf = (id: string, fallback?: string): string =>
    pill?.labels?.[id] ?? fallback ?? id.replace(/_/g, ' ');
  const toneOf = (id: string): PillTone => pill?.tones?.[id] ?? 'idle';

  if (!stateControl) {
    // No settable state ⇒ the server's raw groups, neutral tone, never
    // invented vocabulary. (Today no board-declaring kind lacks one; this
    // branch keeps the component honest rather than reachable.)
    return groups.map((g) => ({ key: g.key, label: g.label, tone: 'idle', option: null, sink: false }));
  }

  /* PHASE 7 — the intersection runs on the CATEGORY, both sides declared.
     It used to read the tab's own `filter.status` array, which worked only
     while a tab spelled its band as task status literals; the four category
     tabs spell it as `{ category: [...] }`, and every kind's options now carry
     their own `category` (registry data). An option with no category is not
     filtered out — an unbucketable state shows on every tab rather than
     vanishing from all four. */
  const columns: BoardColumnSpec[] = stateControl.options
    .filter((o) => tab === null || o.category === undefined || o.category === tab.id)
    .map((o) => ({ key: o.id, label: labelOf(o.id), tone: toneOf(o.id), option: o, sink: false }));

  // A group key the registry does not declare renders APPENDED with the raw
  // key and neutral tone — never dropped (§1.3).
  for (const group of groups) {
    if (!columns.some((c) => c.key === group.key)) {
      columns.push({ key: group.key, label: group.label || group.key, tone: 'idle', option: null, sink: false });
    }
  }

  return columns;
}

/** User copy for an axis whose NAME is data — same rule as the W1 picker. */
function axisLabelOf(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Columns for an AXIS board (W3): the explicit no-value column first — it is
 * where every untyped task lives, and a drop there CLEARS the axis — then the
 * axis's own vocabulary in `axisValues` order (never alphabetical, never the
 * server's arrival order), then any group key outside today's vocabulary
 * appended raw and undroppable, same §1.3 posture as the status board.
 */
function axisBoardColumns(
  axis: { name: string; axisValues: readonly string[] },
  groups: readonly CollectionGroup[],
): BoardColumnSpec[] {
  const columns: BoardColumnSpec[] = [
    { key: '', label: `no ${axis.name}`, tone: 'idle', option: null, axisValue: null, sink: false },
    ...axis.axisValues.map((value) => ({
      key: value,
      label: value,
      tone: 'idle' as PillTone,
      option: null,
      axisValue: value,
      sink: false as const,
    })),
  ];
  for (const group of groups) {
    if (!columns.some((c) => c.key === group.key)) {
      columns.push({ key: group.key, label: group.label || group.key, tone: 'idle', option: null, sink: false });
    }
  }
  return columns;
}

/**
 * Columns for the ASSIGNEE board: the server's groups verbatim (key = actor
 * id, '' = Unassigned), every one UNDROPPABLE — owner ruling 2026-08-16
 * (W3/4): drag-to-reassign is out of scope, and a drop that silently wrote a
 * status under assignee columns is the exact lie this workstream exists to
 * prevent. The board states the refusal in its header note.
 */
function assigneeBoardColumns(groups: readonly CollectionGroup[]): BoardColumnSpec[] {
  const columns = groups.map((g): BoardColumnSpec => ({
    key: g.key,
    label: g.label || g.key,
    tone: 'idle',
    option: null,
    sink: false,
  }));
  // The server only emits buckets rows landed in; an assignee board with no
  // unassigned tasks still deserves the column NOT to appear invented, so
  // nothing is added here — absent groups are absent columns.
  return columns;
}

/**
 * The board card's status word + tone, from the SAME registry-declared badge
 * read the tile makes (`list.tile.badges` → `renderBadge`) — one vocabulary,
 * no kind named (§15.2). The record's own badge is the honest source HERE
 * because no board-declaring kind carries a `liveTreatment` (a sessions board
 * is refused by registry — §1.6 pins `work_session.list.board` undefined), so
 * there is no seam verdict for the badge to be outranked by. A kind that
 * declares no status badge draws no word — absence, not invention.
 */
function boardCardStatus(
  row: EntitySummary,
  config: KindConfig,
): { word: string; tone: PillTone } | null {
  const slot = config.list.tile.badges
    .map((spec) => renderBadge(spec.source, row))
    .find(
      (candidate): candidate is Extract<TileSlot, { slot: 'status' }> =>
        candidate?.slot === 'status',
    );
  return slot ? { word: slot.word, tone: slot.tone } : null;
}

function BoardBody({
  props,
  config,
  tab,
  onTab,
  groupBy,
  onGroupBy,
  filter,
  query,
}: {
  props: EntityListPanelProps;
  config: KindConfig;
  tab: StatusCategoryTab | null;
  onTab: (categoryTabId: string) => void;
  groupBy: GroupByKey;
  onGroupBy: (groupBy: GroupByKey) => void;
  filter: QueryFilter;
  query: string;
}) {
  const list = config.list;
  const stateControl = list.stateControl;
  /** The axis this board groups by, resolved from per-space DATA — or null
      for the status/assignee dimensions. */
  const axisName = groupBy.startsWith('axis:') ? groupBy.slice('axis:'.length) : null;
  const axis = axisName === null ? null : (props.taskAxes ?? []).find((a) => a.name === axisName) ?? null;
  /** The §1.5 inline refusal: rendered at the refusing column's header. */
  const [refusal, setRefusal] = useState<{ column: string; reason: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** The card in flight. The ROW rides along so a drop needs no cache lookup. */
  const [dragging, setDragging] = useState<EntitySummary | null>(null);
  /** §8.1 roving focus: column index + card index within it. */
  const [focus, setFocus] = useState<{ col: number; row: number }>({ col: 0, row: 0 });

  // ARCHIVED: board disabled with reason — an archived row is not moving
  // through a workflow, whatever status it kept. Same honesty kit as every
  // other foreseeable refusal (§8.5).
  //
  // PHASE 7: keyed on the RESOLVED FILTER, not on a tab id. Archived stopped
  // being a tab and became a filter chip that composes with any category, so
  // "am I looking at the archive" is a question only the merged filter can
  // answer now — `deleted: 'only'` is the one value that means every row on
  // screen is archived. `'include'` deliberately does NOT disable the board:
  // that view is mostly live rows, and refusing it would refuse the majority
  // to protect the minority.
  if (filter.deleted === 'only') {
    return (
      <div className="lp__board lp__board--off" data-testid="board-disabled">
        <DisabledAction
          label="Board"
          reason={toReason('Archived rows have no workflow — there is nothing to move between columns.')}
        >
          Board
        </DisabledAction>
      </div>
    );
  }

  const snapshot = props.boardFor?.(filter, groupBy);

  /**
   * The GROUP-BY PICKER (W3, D2 made true): `status`, `assignee`, and one
   * `axis:<name>` per axis the SPACE defines — per-space data, not registry
   * config, exactly like the W1 pickers. Rendered on every board state
   * (loading, error, even an unresolvable axis) so the user can always
   * choose their way out.
   */
  const groupByPicker = (
    <select
      className="lp__statesel lp__statesel--live lp__board-groupby"
      aria-label="Group board by"
      data-testid="board-groupby"
      value={groupBy}
      onChange={(e) => onGroupBy(e.target.value as GroupByKey)}
    >
      <option value="status">by status</option>
      <option value="assignee">by assignee</option>
      {(props.taskAxes ?? []).map((a) => (
        <option key={a.id} value={`axis:${a.name}`}>
          by {a.name}
        </option>
      ))}
      {/* A route can carry an axis this space no longer defines (or one not
          loaded): keep it selectABLE as the current value so the select shows
          the truth rather than snapping to status. */}
      {axisName !== null && axis === null ? (
        <option value={groupBy} disabled>
          by {axisName} (not defined here)
        </option>
      ) : null}
    </select>
  );

  /* A route naming an axis the space does not define: the board cannot render
     honest columns for it. Refuse with the reason and keep the picker — the
     way out is one choice away. */
  if (axisName !== null && axis === null) {
    return (
      <div className="lp__board lp__board--off" data-testid="board-axis-missing">
        {groupByPicker}
        <DisabledAction
          label="Board"
          reason={toReason(
            `This space defines no task axis named ${axisName} — pick another grouping, or define the axis in Settings > Task axes.`,
          )}
        >
          Board
        </DisabledAction>
      </div>
    );
  }

  // No source wired: say so. A board that silently renders nothing is
  // indistinguishable from an empty tab, and only one of those is true.
  if (!props.boardFor) {
    return (
      <div className="lp__board lp__board--off" data-testid="board-unwired">
        <DisabledAction label="Board" reason={NOT_WIRED_REASON}>
          Board
        </DisabledAction>
      </div>
    );
  }

  // §8.2 — error must not look like empty: columns collapse to a single body
  // with the reason and a retry.
  if (snapshot?.error) {
    return (
      <div className="lp__board lp__board--error" data-testid="board-error" role="alert">
        <p className="lp__board-reason">{`The board could not load: ${snapshot.error}`}</p>
        {snapshot.retry ? (
          <button type="button" className="lp__board-retry" onClick={snapshot.retry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const loading = snapshot === undefined;
  const columns =
    axis !== null
      ? axisBoardColumns(axis, snapshot?.groups ?? [])
      : groupBy === 'assignee'
        ? assigneeBoardColumns(snapshot?.groups ?? [])
        : boardColumns(config, tab, snapshot?.groups ?? []);
  const groupOf = new Map((snapshot?.groups ?? []).map((g) => [g.key, g] as const));
  const itemsOf = (column: BoardColumnSpec): readonly EntitySummary[] =>
    matching(groupOf.get(column.key)?.items ?? [], query);

  // §8.4 — quick-add ONLY on the column whose status is the kind's creation
  // status: the FIRST stateControl option (creation IS that state; a quick-add
  // elsewhere would silently create a card belonging to another column).
  const creationKey = groupBy === 'status' ? stateControl?.options[0]?.id : undefined;

  /**
   * A drop WRITES THE GROUPING DIMENSION (W3/4) — the single highest-risk
   * behaviour in this workstream. On the status board it dispatches the state
   * verb exactly as before; on an axis board it writes THE AXIS through the
   * version-guarded content patch; on the assignee board no column is a drop
   * target at all (ruling: reassign-by-drag is out of scope), so this cannot
   * fire there. It must never silently write a status while the columns say
   * something else.
   */
  const dispatchDrop = (row: EntitySummary, column: BoardColumnSpec): void => {
    if (itemsOf(column).some((r) => r.id === row.id)) return;

    if (column.axisValue !== undefined) {
      if (axis === null || !props.onSetAxis) return;
      setRefusal(null);
      setPendingId(row.id);
      const outcome = props.onSetAxis(row.id, axis.name, column.axisValue, axisLabelOf(axis.name), {
        notify: false,
      });
      void Promise.resolve(outcome).then((result) => {
        setPendingId(null);
        if (result && result.ok === false) {
          setRefusal({ column: column.key, reason: result.reason });
        }
      });
      return;
    }

    if (!column.option || !stateControl || !props.onSetState) return;

    /**
     * W4 — the PRE-FLIGHT workflow refusal, at the refusing column, WITHOUT
     * calling the server: the vocabulary is already in hand (the same
     * `spaceSettings()` data the strip narrows with), so a drop the row's
     * type forbids is foreseeable and §8.5 says a foreseeable refusal is
     * stated rather than attempted. Same words as the strip's disabled
     * option; the database trigger (132) remains the real gate for every
     * writer that is not this board.
     */
    const vocabulary = workflowVocabularyOf(props.taskWorkflows, row.state);
    if (vocabulary !== null && !vocabulary.includes(column.option.id)) {
      setPendingId(null);
      setRefusal({
        column: column.key,
        reason: workflowRefusalText(workflowTypeOf(row.state)!, column.option.id),
      });
      return;
    }

    setRefusal(null);
    setPendingId(row.id);
    const outcome = props.onSetState(
      row.id,
      column.option.id,
      column.option.via ?? stateControl.command,
      { notify: false },
    );
    void Promise.resolve(outcome).then((result) => {
      setPendingId(null);
      if (result && result.ok === false) {
        // §1.5/§8.5: attempted-and-refused renders where the act happened.
        // The card never moved (no optimistic swap), so nothing snaps back.
        setRefusal({ column: column.key, reason: result.reason });
      }
    });
  };

  // §8.1 — drag is never the only path. The same dispatch as a drop, so one
  // command path serves pointer and keyboard.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey;
    const colCount = columns.length;
    if (colCount === 0) return;
    const col = Math.min(focus.col, colCount - 1);
    const rows = itemsOf(columns[col]!);
    const row = Math.min(focus.row, Math.max(0, rows.length - 1));
    const focused = rows[row];

    const move = (delta: number): void => {
      if (!focused) return;
      const target = columns[col + delta];
      if (!target || (!target.option && target.axisValue === undefined)) return;
      dispatchDrop(focused, target);
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
        if (focused) props.onSelect?.(focused.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="lp__board"
      data-testid="board-body"
      role="application"
      aria-label={`${config.labelPlural} board`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {groupByPicker}

      {/* Ruling 2026-08-16 (W3/4): the assignee board is READ-ONLY — the
          named reason, stated up front, because undraggable cards with no
          words are indistinguishable from broken ones. */}
      {groupBy === 'assignee' ? (
        <div className="lp__board-banner" data-testid="board-assignee-note">
          Drag is off on this board — reassigning from a drop is not built; use a card&rsquo;s
          Assigned control instead.
        </div>
      ) : null}

      {/* §1.4 — the honesty banner. Groups are page-scoped and no total is
          returned, so column heights are not complete counts and the board
          says so whenever a further page exists. */}
      {!loading && snapshot?.nextCursor != null ? (
        <div className="lp__board-banner" data-testid="board-banner">
          {`Showing the ${snapshot.limit} most recently active ${config.labelPlural.toLowerCase()} — columns are not complete counts.`}
        </div>
      ) : null}

      <div className="lp__board-cols">
        {columns.map((column, index) => (
          <BoardColumn
            key={column.key}
            column={column}
            rows={loading ? undefined : itemsOf(column)}
            props={props}
            config={config}
            focused={index === Math.min(focus.col, columns.length - 1)}
            focusRow={focus.row}
            refusal={refusal?.column === column.key ? refusal.reason : null}
            pendingId={pendingId}
            dragging={dragging}
            onDragStart={setDragging}
            onDrop={dispatchDrop}
            createSlot={column.key === creationKey ? props.createSlot : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function BoardColumn({
  column,
  rows,
  props,
  config,
  focused,
  focusRow,
  refusal,
  pendingId,
  dragging,
  onDragStart,
  onDrop,
  createSlot,
  doneTabLink,
}: {
  column: BoardColumnSpec;
  /** `undefined` ⇒ loading: header renders from the registry, body shimmers. */
  rows: readonly EntitySummary[] | undefined;
  props: EntityListPanelProps;
  config: KindConfig;
  focused: boolean;
  focusRow: number;
  refusal: string | null;
  pendingId: string | null;
  dragging: EntitySummary | null;
  onDragStart: (row: EntitySummary | null) => void;
  onDrop: (row: EntitySummary, column: BoardColumnSpec) => void;
  createSlot?: ReactNode;
  doneTabLink?: () => void;
}) {
  const droppable = Boolean(
    (column.option && props.onSetState) || (column.axisValue !== undefined && props.onSetAxis),
  );
  /**
   * W3E, extended to the board (wave 3): the CARD WRAPPER carries the same
   * `data-family` the three tile anatomies publish, so panels.css can hang
   * the family accent bar and glyph ink on the card itself — the same
   * registry read `Tile` makes, no kind named (§15.2).
   */
  const family = config.graphFamily ?? 'gray';

  return (
    <section
      className={focused ? 'lp__board-col lp__board-col--focused' : 'lp__board-col'}
      data-testid="board-column"
      data-column={column.key}
      aria-label={column.label}
      onDragOver={
        droppable
          ? (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          : undefined
      }
      onDrop={
        droppable
          ? (event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData('text/plain');
              const row = dragging && dragging.id === id ? dragging : null;
              onDragStart(null);
              if (row) onDrop(row, column);
            }
          : undefined
      }
    >
      <header className="lp__board-head">
        <span className={`kit-pill kit-pill--${column.tone} lp__board-pill`}>{column.label}</span>
        {/* "{n} shown", never "{n}" — no per-group total exists yet (§1.4). */}
        <span className="lp__board-count">{rows === undefined ? '…' : `${rows.length} shown`}</span>
      </header>

      {refusal ? (
        // Attempted-and-refused: inline, at the column that refused (§8.5).
        <p className="lp__board-refusal" role="alert" data-testid="board-refusal">
          {refusal}
        </p>
      ) : null}

      {createSlot ? <div className="lp__board-add">{createSlot}</div> : null}

      <div className="lp__board-cards" role="list">
        {rows === undefined ? (
          // §8.2 loading: skeletons, never empty-state text before the answer.
          <>
            <div className="lp__board-skeleton" aria-hidden data-testid="board-skeleton" />
            <div className="lp__board-skeleton" aria-hidden />
          </>
        ) : rows.length === 0 ? (
          // §1.3: an empty column is a real answer.
          <p className="lp__board-empty">{`nothing in ${column.label}`}</p>
        ) : (
          rows.map((row, index) => {
            const cardStatus = boardCardStatus(row, config);
            return (
            <div
              key={row.id}
              role="listitem"
              className={
                row.id === pendingId
                  ? 'lp__board-card lp__board-card--pending'
                  : row.id === dragging?.id
                    ? 'lp__board-card lp__board-card--dragging'
                    : focused && index === focusRow
                      ? 'lp__board-card lp__board-card--focused'
                      : 'lp__board-card'
              }
              data-family={family}
              draggable={droppable || undefined}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', row.id);
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(row);
              }}
              onDragEnd={() => onDragStart(null)}
            >
              {/* The card's identity strip: kind glyph in the family ink, and
                  the record's status word in its tone. `aria-hidden` because
                  both facts are already announced — the kind by the board's
                  own label, the status by the tile's sr text — so this is
                  presentation for the eye scanning a column, not a second
                  reading for the ear. */}
              <div className="lp__board-card-chrome" aria-hidden>
                <span className="lp__board-card-glyph">
                  <KindIcon kind={config.kind} size={12} />
                </span>
                {cardStatus ? (
                  <span className={`lp__board-card-status kit-pill--${cardStatus.tone}`}>
                    {cardStatus.word}
                  </span>
                ) : null}
              </div>
              <Tile row={row} props={props} config={config} />
            </div>
            );
          })
        )}
      </div>

    </section>
  );
}

// ---------------------------------------------------------------------------
// Bands, trees, tiles
// ---------------------------------------------------------------------------

/**
 * WHICH LIFECYCLES EARN THE DONE STRIKETHROUGH — exhaustive over the registry
 * union ON PURPOSE (a `Record`, not `lifecycle === 'work'`): the moment
 * `ListConfig.lifecycle` grows a value, this map stops compiling until
 * someone decides whether that lifecycle's done rows are FINISHED WORK
 * (struck) or STORED MATERIAL (not). A bare equality would let a new
 * vocabulary word silently inherit "no strike", which is a presentation
 * verdict this file never actually reached — the costume question must fail
 * loudly, the way `HANDLED_SOURCES` fails for an unrendered badge.
 */
const STRUCK_WHEN_DONE: Record<NonNullable<KindConfig['list']['lifecycle']>, boolean> = {
  work: true,
  library: false,
  /* `record` (wave 3, work_session): a done session is the RECORD OF A RUN —
     it ended, it was not finished-away, so no strike; failure stays visible
     as the `failed` status badge. The verdict this map exists to force. */
  record: false,
};

/**
 * THE BIRTH SENTENCE — what a genuinely empty kind screen says about getting
 * a first row, derived from the registry's own birth declarations instead of
 * one hardcoded story for all kinds.
 *
 * The hardcoded sentence — "create one, or press / and type a name" — was a
 * lie on every kind that refuses quick-create: sessions are LAUNCHED
 * (`quickCreate:false`, the create door refused server-side), and commits,
 * pull requests, members, projects, memories, artifacts and worktrees are
 * never created from their list at all. The screen was teaching a dead
 * gesture precisely to the user with zero rows, who has no other evidence of
 * how the kind is born.
 *
 * Every branch below is a REGISTRY FIELD, never a kind name (§15.2):
 *
 *  - `quickCreate` + `createForm`: birth is a staged form, not a typed name —
 *    the sentence uses the form's own verb ("Upload file to add one").
 *  - `quickCreate`: the original sentence, kept verbatim where it is true
 *    (the header ＋ exists and the palette carries the create label).
 *  - `quickLaunch`: the kind is launched; the verb comes from
 *    `palette.createLabel` ('Launch session' → "launch one").
 *  - none of those: an honest refusal. The registry has no per-kind
 *    birth-hint field yet, so the sentence states that rows arrive from
 *    elsewhere without naming a door this screen does not have.
 */
function birthSentence(config: KindConfig): string {
  const plural = config.labelPlural.toLowerCase();
  const createLabel = config.palette?.createLabel;
  if (config.list.quickCreate) {
    if (config.createForm && createLabel) {
      return `No ${plural} here yet — ${createLabel} to add one.`;
    }
    return `No ${plural} here yet — create one, or press / and type a name.`;
  }
  if (config.list.quickLaunch && createLabel) {
    const verb = createLabel.trim().split(/\s+/)[0]?.toLowerCase() ?? 'start';
    return `No ${plural} here yet — ${verb} one to begin.`;
  }
  return `No ${plural} here yet — new ${plural} arrive from work done elsewhere; nothing creates one from this screen.`;
}

function Band({
  label,
  filter,
  sort,
  collapsed,
  onToggle,
  props,
  config,
  query,
  tabFacts,
}: {
  label: string | null;
  /**
   * The band's own already-narrowed query, or `null` when the section, the
   * tab and the chips cannot all hold at once. The band OWNS the read: it is
   * the only place that knows which question these rows answer, and paging
   * needs that question back to ask for the next page.
   */
  filter: QueryFilter | null;
  sort?: SortKey;
  collapsed?: boolean;
  onToggle?: () => void;
  props: EntityListPanelProps;
  config: KindConfig;
  /** Present ⇒ an empty band means "no matches", not "nothing here". */
  query?: string;
  /**
   * The open category tab's word and its siblings' live counts, passed only by
   * the TAB band (the sectionless mount whose emptiness IS the tab's). An
   * empty tab over a populated kind must never claim "no X here yet" — the
   * footer two rows down is simultaneously printing "3 done" — so the empty
   * state names the tab and points at the bands that do hold rows.
   */
  tabFacts?: { label: string; elsewhere: readonly { label: string; n: number }[] };
}) {
  const rows = filter === null ? NO_ROWS : props.rowsFor(filter, sort);
  const page = filter === null ? undefined : props.pageStateOf?.(filter, sort);
  const visible = matching(rows, query ?? '');
  const attentionIds = attentionIdsOf(visible, props, config);

  if (label && collapsed) {
    // A collapsed section reduces to ONE clickable line pinned at the bottom —
    // still counted, still reachable, never silently gone.
    return (
      <button type="button" className="lp__collapsed" onClick={onToggle}>
        {`▸ ${label.toUpperCase()} · ${rows.length}`}
      </button>
    );
  }

  return (
    <>
      {/* USER RULING — attention is marked IN PLACE, never hoisted.
          Needing attention used to promote a row into its own flat band above
          the list. That band pulled the row OUT of the set `buildTileTree`
          arranges, and a tree only nests a row whose parent is also in that
          set — so flagging one parent session re-rooted every child it had and
          the hierarchy the user was reading fell apart. The row is the same
          row; being flagged is a fact ABOUT it, not a reason to move it. The
          amber tile treatment and its `Needs attention` label already say so
          without disturbing the shape around it. */}
      {label ? (
        <button type="button" className="lp__eyebrow" onClick={onToggle}>
          {`${label.toUpperCase()} · ${visible.length}`}
        </button>
      ) : null}

      {visible.length === 0 ? (
        /*
         * A filter that hides every row and says nothing looks identical to a
         * list that failed to load (A1a's ask). The states get different
         * sentences: one names the CONTRADICTION and where it came from, one
         * names the search and offers the way back, the last teaches the
         * gesture that fills the list.
         */
        filter === null ? (
          <EmptyBody
            glyph={config.chip.glyph}
            sentence={`No rows: the filters you have picked contradict this tab, so nothing could satisfy both. Clear a filter chip or switch tabs.`}
          />
        ) : query && query.trim().length > 0 ? (
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={`No ${config.labelPlural.toLowerCase()} match “${query.trim()}”. Clear the search to see them all.`}
          />
        ) : tabFacts && tabFacts.elsewhere.length > 0 ? (
          /* An empty TAB over a populated kind. "No X here yet — create one"
             was a lie the footer contradicted on the same screen; the honest
             sentence names the band and says where the rows are. */
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={`Nothing in ${tabFacts.label} — ${tabFacts.elsewhere
              .map((other) => `${other.n} in ${other.label}`)
              .join(' · ')}.`}
          />
        ) : (
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={birthSentence(config)}
          />
        )
      ) : (
        <TreeRows rows={visible} props={props} config={config} attentionIds={attentionIds} />
      )}

      {/* PAGING IS THE BAND'S, because the query is the band's. Rendered after
          the rows so the observer sits at the true bottom of this band's
          content, and only when the server actually left a cursor. */}
      {filter !== null && page?.hasMore && props.loadMore ? (
        <LoadMoreSentinel
          loading={page.loading}
          onReach={() => props.loadMore?.(filter, sort)}
        />
      ) : null}
    </>
  );
}

/**
 * INFINITE SCROLL, WITH A BUTTON UNDER IT.
 *
 * An IntersectionObserver on a zero-height marker: when the bottom of the list
 * scrolls into view, ask for the next keyset page. `root: null` watches the
 * viewport AND any scrolling ancestor's clipping, which is what a panel inside
 * the rail needs.
 *
 * The BUTTON is not a fallback for old browsers, it is the honest surface for
 * the cases the observer cannot cover: a list shorter than its container never
 * scrolls, so the sentinel is permanently visible and firing is the right
 * behaviour; and jsdom has no observer at all, so without it the paging path
 * would be untestable except in a real browser. It also gives a keyboard user
 * a way to reach row 51.
 */
function LoadMoreSentinel({ loading, onReach }: { loading: boolean; onReach: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so the observer is created ONCE. Passing the callback as an
  // effect dependency would tear down and rebuild the observer on every
  // render — and a fresh observer fires immediately for an already-visible
  // target, which is a request loop, not a subscription.
  const reach = useRef(onReach);
  reach.current = onReach;

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) reach.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="lp__more" ref={ref} data-testid="list-load-more">
      <button
        type="button"
        className="lp__morebtn"
        onClick={() => reach.current()}
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

/**
 * Explicit attention is universal entity-envelope data and therefore works
 * for every kind. A kind may additionally contribute a registry predicate
 * (currently session liveness); that predicate remains dormant without its
 * authoritative liveness source.
 */
function attentionIdsOf(
  rows: readonly EntitySummary[],
  props: EntityListPanelProps,
  config: KindConfig,
): ReadonlySet<string> {
  const predicate = config.list.needsAttentionGroup;

  const marked = new Set<string>();
  for (const row of rows) {
    const derivedAttention = Boolean(
      predicate && props.livenessOf && predicate(toRowFacts(row), props.livenessOf(row.id)),
    );
    if (row.badges.attention || derivedAttention) marked.add(row.id);
  }
  return marked;
}

/**
 * Hierarchy rendering. Guide lines are one 1px hairline per ancestor level;
 * indent steps 17px per depth, matching the T0-3 tree-geometry reference.
 * Only rows whose parent is ALSO in this row set nest — an orphan renders at
 * root rather than disappearing, because a row you cannot see is worse than a
 * row at the wrong indent.
 */
function TreeRows({
  rows,
  props,
  config,
  attentionIds,
}: {
  rows: readonly EntitySummary[];
  props: EntityListPanelProps;
  config: KindConfig;
  /** Rows to mark amber where they stand. Absent ⇒ nothing is flagged. */
  attentionIds?: ReadonlySet<string>;
}) {
  /**
   * EXPANDED, NOT COLLAPSED — the inversion is the whole point (user ruling
   * 2026-08-17, "it's always showing expanded full tree… by default it should
   * be collapsed"). This used to be a `collapsed` set that started EMPTY, i.e.
   * default-OPEN: every parent drew its whole subtree on first paint, and a
   * child arriving later from the event stream appeared inside it unasked. Now
   * the set holds the rows the VIEWER opened, so an untouched row — and every
   * row that arrives later — is shut, and the state persists per kind.
   *
   * See `kit/useTreeDisclosure` for why the set is safe to persist and how the
   * selection is kept visible without being written to storage.
   */
  const revealed = useMemo(() => ancestorPath(rows, props.selectedId), [rows, props.selectedId]);
  const disclosure = useTreeDisclosure(`list:${config.kind}`, revealed);

  const roots = useMemo(() => buildTileTree(rows, Boolean(config.list.tree)), [rows, config.list.tree]);

  /**
   * Live message traffic, resolved against THIS tree's current shape. Recomputed
   * when the tree or the disclosure state changes, because a route is only true
   * for the arrangement that was on screen when it was drawn — collapsing a
   * subtree mid-flight must re-aim the pulse at the ancestor now standing in
   * for it. `isExpanded` (not the raw set) is what is passed, so a row revealed
   * by the selection routes as the open row it is drawn as.
   */
  const pulse = useMemo(
    () => resolvePulses(rows, disclosure.isExpanded, props.messagePulses, config),
    [rows, disclosure, props.messagePulses, config],
  );

  const renderNode = (node: TileTreeNode): React.ReactNode => {
    const isCollapsed = !disclosure.isExpanded(node.row.id);
    const hasChildren = node.children.length > 0;
    const wire = pulse.segments.get(node.row.id);
    const endpoint = pulse.endpoints.get(node.row.id);
    return (
      <div
        key={node.row.id}
        className="lp__branch"
        role={config.list.tree ? 'treeitem' : 'listitem'}
        aria-expanded={config.list.tree && hasChildren ? !isCollapsed : undefined}
        aria-selected={config.list.tree ? props.selectedId === node.row.id : undefined}
        /* Presentation only. The pulse is decoration over a message that is
           already announced on its own anchor, so it carries no ARIA and no
           live region — narrating every inter-session message here would be
           noise on a tree the user is trying to read. */
        data-pulse-row={endpoint}
      >
        <Tile
          row={node.row}
          depth={node.depth}
          props={props}
          config={config}
          attention={attentionIds?.has(node.row.id) ?? false}
          childCount={node.children.length}
          expanded={!isCollapsed}
          onToggleChildren={hasChildren ? () => disclosure.toggle(node.row.id) : undefined}
        />
        {hasChildren && !isCollapsed ? (
          <div
            className="lp__children"
            role="group"
            data-testid="list-tile-children"
            data-pulse={wire?.direction}
            style={wire ? ({ '--lp-pulse-delay': `${wire.order * 90}ms` } as React.CSSProperties) : undefined}
          >
            {node.children.map(renderNode)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={treeClass(config)} role={config.list.tree ? 'tree' : 'list'}>
      {roots.map(renderNode)}
    </div>
  );
}

/**
 * The session caret, as an SVG. The default tile drew `›` — a typographic arrow
 * sits on its own font's baseline, so it landed at a different optical height
 * from the same caret in the session and task lists, which draw a path in a
 * square viewBox. Same reason `MaestroTaskTile` stopped using the glyph.
 */
function TileChevron() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Control cards are an attached column; every other anatomy stays gapped. */
function treeClass(config: KindConfig): string {
  if (config.list.tile.anatomy === 'control-card') return 'lp__tree lp__tree--control';
  if (config.list.tile.anatomy === 'session-tree') return 'lp__tree lp__tree--session';
  return 'lp__tree';
}

interface TileTreeNode {
  row: EntitySummary;
  children: TileTreeNode[];
  depth: number;
}

/**
 * Turns a flat query page into the disclosure tree rendered above. A missing
 * parent roots its child instead of hiding it. The `seen` guard also keeps a
 * malformed parent cycle visible as roots rather than recursing forever.
 */
function buildTileTree(rows: readonly EntitySummary[], hierarchical: boolean): TileTreeNode[] {
  if (!hierarchical) return rows.map((row) => ({ row, children: [], depth: 0 }));

  const present = new Set(rows.map((row) => row.id));
  const childrenOf = new Map<string | null, EntitySummary[]>();
  for (const row of rows) {
    const parent = row.parentId && present.has(row.parentId) ? row.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row]);
  }

  const seen = new Set<string>();
  const attach = (row: EntitySummary, depth: number): TileTreeNode => {
    seen.add(row.id);
    return {
      row,
      depth,
      children: (childrenOf.get(row.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .map((child) => attach(child, depth + 1)),
    };
  };

  const roots = (childrenOf.get(null) ?? []).map((row) => attach(row, 0));
  for (const row of rows) {
    if (!seen.has(row.id)) roots.push(attach(row, 0));
  }
  return roots;
}

interface ResolvedPulses {
  /** Wire owner → how its hairline sweeps, and where in the flight it does so. */
  segments: ReadonlyMap<string, { direction: PulseSegment['direction']; order: number }>;
  /** Row → its part in a pulse, for the endpoint glow. */
  endpoints: ReadonlyMap<string, 'from' | 'to'>;
}

const NO_PULSES: ResolvedPulses = { segments: new Map(), endpoints: new Map() };

/**
 * Turns live arrivals into per-node presentation, against the tree as it is
 * currently arranged.
 *
 * The binding is checked here and nowhere else: a list whose registry row does
 * not ask for `messagePulse` resolves to nothing, so this cannot animate a tree
 * that never opted in. Same shape as `tile.pulse` — data decides, not the kind.
 *
 * When several messages are in flight at once their routes are merged, and a
 * wire carrying more than one keeps the EARLIEST position in flight, so a long
 * route already under way is not restarted by a short one that crosses it.
 */
function resolvePulses(
  rows: readonly EntitySummary[],
  /**
   * Does this row draw its children? A PREDICATE, not the persisted set: a row
   * on the path to the selection is open on screen without being in storage,
   * and a route that consulted the set alone would re-aim a pulse at an
   * ancestor while the real row is plainly visible.
   */
  isExpanded: (id: string) => boolean,
  pulses: readonly MessagePulse[] | undefined,
  config: KindConfig,
): ResolvedPulses {
  if (config.list.tree?.messagePulse !== true) return NO_PULSES;
  if (pulses === undefined || pulses.length === 0) return NO_PULSES;

  // Same parent resolution as `buildTileTree`: a row whose parent is not on
  // this page is a root here, and the route must agree with what is drawn.
  const present = new Set(rows.map((row) => row.id));
  const parents = new Map<string, string | null>(
    rows.map((row) => [row.id, row.parentId && present.has(row.parentId) ? row.parentId : null]),
  );
  const parentOf = (id: string) => parents.get(id);

  const index = {
    parentOf,
    isVisible: (id: string) => {
      if (!present.has(id)) return false;
      // A ROW IS VISIBLE WHEN EVERY ANCESTOR IS OPEN — its own disclosure state
      // is about its CHILDREN, not itself, so it is deliberately not consulted
      // here. (Under the old default-open set this read `collapsed.has(id)`
      // first, which was wrong in the same way and merely never observable
      // while nothing started closed.)
      const guard = new Set<string>();
      let cursor = parentOf(id);
      while (typeof cursor === 'string' && !guard.has(cursor)) {
        if (!isExpanded(cursor)) return false;
        guard.add(cursor);
        cursor = parentOf(cursor);
      }
      return true;
    },
  };

  const segments = new Map<string, { direction: PulseSegment['direction']; order: number }>();
  const endpoints = new Map<string, 'from' | 'to'>();
  for (const item of pulses) {
    const route = routeMessagePulse(item.fromId, item.toId, index);
    route.segments.forEach((segment, order) => {
      const existing = segments.get(segment.ownerId);
      if (existing === undefined || order < existing.order) {
        segments.set(segment.ownerId, { direction: segment.direction, order });
      }
    });
    // Arrival wins a contested row: a session that both sends and receives in
    // the same window is more interesting as a destination.
    if (route.fromRowId !== null && !endpoints.has(route.fromRowId)) endpoints.set(route.fromRowId, 'from');
    if (route.toRowId !== null) endpoints.set(route.toRowId, 'to');
  }
  return { segments, endpoints };
}


/**
 * EXPORTED for the membership block (user ruling 2026-08-13): a collection's
 * ITEMS render as REAL tiles — the same anatomies, badges, PR chips and
 * control strip as the kind's own list — not as a second, poorer chip
 * vocabulary. One tile implementation; a copy is how the control-card's
 * chips drifted dead once already (D67).
 */
/**
 * An `ActorSummary` off a loosely-typed state bag, or null.
 *
 * Structural, not kind-tested: §15.2 forbids a component from naming a kind,
 * and the question here is only "did the server send an actor" — a payload
 * from a node that predates the field sends nothing, and null is the answer
 * for that as much as for a run with no persona.
 */
function actorSummaryOrNull(value: unknown): ActorSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const actor = value as Partial<ActorSummary>;
  return typeof actor.id === 'string' && typeof actor.displayName === 'string'
    ? (actor as ActorSummary)
    : null;
}

export function Tile({
  row,
  depth = 0,
  props,
  config,
  attention = false,
  childCount = 0,
  expanded = false,
  onToggleChildren,
  path,
}: {
  row: EntitySummary;
  depth?: number;
  props: EntityListPanelProps;
  config: KindConfig;
  attention?: boolean;
  childCount?: number;
  expanded?: boolean;
  onToggleChildren?: () => void;
  /**
   * The relation-traversal path: every entity id this tile hangs UNDER via
   * open relation groups, so an edge pointing back at an ancestor is
   * suppressed rather than drawn as a loop (user ruling 2026-08-16 —
   * parent → child → parent renders once). Absent at the top level.
   */
  path?: ReadonlySet<string>;
}) {
  const list = config.list;
  const controlCard = list.tile.anatomy === 'control-card';
  const sessionTree = list.tile.anatomy === 'session-tree';
  /**
   * W3E — the kind's palette family, stamped as `data-family` on every
   * anatomy's ROOT (standard, control-card, session-tree) so W3C's accent
   * rules can tint a tile without this file naming a kind. Registry DATA,
   * read exactly the way the graph cards read it (`GraphView`); a kind
   * without a family draws the neutral gray one.
   */
  const family = config.graphFamily ?? 'gray';
  const verdict = props.livenessOf?.(row.id);
  const treatment: LiveTreatment | null =
    list.liveTreatment && verdict ? list.liveTreatment(verdict) : null;

  /**
   * Which flow verb this row has expanded, if any. Row-local on purpose: the
   * config dismisses on outside click, so opening one row's closes another's
   * without a shared "only one open" register to keep in sync.
   */
  const [flowRef, setFlowRef] = useState<ActionRef | null>(null);
  /** Maestro's trailing chevron opens row facts independently of Run. */
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  /** Bounds for the expand's outside-click dismissal — the trigger lives here too. */
  const tileRef = useRef<HTMLDivElement>(null);

  /**
   * THE RELATIONAL PANEL (user ruling 2026-08-16): the tile's relation chips
   * open the linked entities of ONE kind inline under the row. One group per
   * tile — clicking another chip REPLACES the open one (the accordion the
   * ruling chose); clicking the open chip closes it. Row-local for the same
   * reason `flowRef` is: outside state would need an "only one open"
   * register this panel has no owner for.
   */
  const [openRelation, setOpenRelation] = useState<{
    kind: string;
    /* The counted edge, captured AT CLICK TIME from the badge's own spec —
       a live counter update that removes the badge must not retroactively
       widen an already-open group to "every relation". */
    edge?: { type: string; direction: 'incoming' | 'outgoing' };
  } | null>(null);
  /** The group's stable DOM id — the chips' `aria-controls` target. */
  const relatedGroupId = useId();
  const connections = props.connectionsOf?.(row.id);
  /** This tile's own id joins the path its expansion hands down. */
  const nestedPath = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set(path ?? []);
    ids.add(row.id);
    return ids;
  }, [path, row.id]);
  const linkedSessions =
    (SESSION_CHIP_KIND ? props.linkedSessionsOf?.(row.id) : undefined) ?? NO_LINKED;
  const sessionRows = SESSION_CHIP_KIND
    ? relatedOfKind(row.id, connections, SESSION_CHIP_KIND, linkedSessions, path)
    : NO_LINKED;
  const toggleRelation = (
    kind: string,
    edge?: { type: string; direction: 'incoming' | 'outgoing' },
  ): void => {
    /* Opening asks for the row's detail exactly like the control strip does —
       `connectionsOf` is backed by hydration, so an unhydrated row would
       otherwise say "loading" forever. The fill is idempotent (see
       `onNeedDetail`), so a re-click cannot stampede the seam. */
    if (openRelation?.kind !== kind && connections === undefined) props.onNeedDetail?.(row.id);
    setOpenRelation((prev) => (prev?.kind === kind ? null : { kind, ...(edge ? { edge } : {}) }));
  };

  /**
   * THE SHARED VISIBLE COUNT (PR #272 re-review, blocking): once this row's
   * connections are hydrated, a count badge shows the length of the EXACT
   * read its group renders — same edge spec, same traversal path — so chip
   * and rows cannot disagree, including the deterministic case where the
   * counted peer is an ancestor of this very expansion (the chip then
   * reads zero and unmounts). Before hydration the server counter remains
   * the discovery value and the group withholds any numeric claim.
   */
  const countedRelationOf = (
    kind: string,
    relation?: { type: string; direction: 'incoming' | 'outgoing' },
  ): number | undefined =>
    connections === undefined || !isExpandableKind(kind)
      ? undefined
      : relatedOfKind(row.id, connections, kind, NO_LINKED, path, relation).length;

  const streaming = Boolean(
    list.tile.pulse && props.activity?.[row.id] && treatment?.streamingLabel,
  );

  // ---- the Z1 badge vocabulary, from registry DATA ------------------------
  const slots = list.tile.badges
    .map((spec) => renderBadge(spec.source, row))
    .filter((slot): slot is TileSlot => slot != null);

  const badgeStatus = slots.find((s) => s.slot === 'status');
  const tag = slots.find((s) => s.slot === 'tag');
  const avatar = slots.find((s) => s.slot === 'avatar');
  const metas = slots.filter((s) => s.slot === 'meta').map((s) => s.text);

  /**
   * PRECEDENCE: the seam VERDICT outranks the record's own status badge.
   *
   * A work_session declares a `sessionStatus` badge AND has a `liveTreatment`.
   * If the badge won, a session whose record says "running" would print
   * "running" while the node reports it stale — the precise lie D6 exists to
   * forbid. So liveness, where it exists, owns the status slot; the record
   * badge fills it only for kinds with no verdict to consult.
   */
  const statusWord = treatment
    ? streaming
      ? treatment.streamingLabel
      : props.compact
        ? (treatment.shortLabel ?? treatment.label)
        : treatment.label
    : badgeStatus?.word;
  const statusTone = treatment ? treatment.tone : (badgeStatus?.tone ?? 'idle');
  const statusHollow = treatment ? treatment.dot === null : badgeStatus?.dot === 'hollow';
  const statusTitle = treatment?.reason ?? treatment?.label ?? badgeStatus?.word;

  const selected = props.selectedId === row.id;
  /**
   * TWO FACTS, TWO NAMES — sub-doc 5, collisions C2 and C3.
   *
   * `archived` was called `done` and meant `deletedAt != null`, and it fed the
   * task tile's `completed` prop. So an ARCHIVED task rendered with the
   * COMPLETED strikethrough, and would have kept doing it the moment a real
   * `done` entered this file — a wrong answer that looks like a right one.
   *
   * `completed` now has exactly ONE definition, here, for every kind:
   * `category === 'done'`. It used to have two, 36 lines apart — the session
   * tile read `recordedStatus === 'exited'` (which files a CRASHED session as
   * unfinished while the Done tab counted it) and the task tile read
   * `archived || statusWord === 'done'` (which files an archived to-do as
   * finished, and reads a WORD off a badge that liveness may have replaced).
   * Neither matched the tab above them.
   *
   * `category` rides the summary (phase 1), so this is a fact that arrives
   * with the row — no hydration lottery, and a collapsed tile answers it. Its
   * ABSENCE means the entity has no status at all, which is not `done`.
   *
   * `cancelled` is deliberately NOT completed: a cancelled task stopped, it
   * did not finish, and the fourth category exists to say so.
   */
  const archived = row.deletedAt != null;
  const completed = row.category === 'done';
  /**
   * THE FACT AND ITS COSTUME ARE TWO THINGS (audit finding 2). `completed`
   * stays the one definition above — `category === 'done'`, every kind. What
   * is NOT universal is whether done earns the strikethrough: on a `work`
   * kind a done row is finished and the strike is right; on a `library` kind
   * (registry `list.lifecycle` — file, artifact, memory, collection, spell,
   * skill) rows are seeded `done` at birth (`kind_seeds_done`, 152), so the
   * same treatment crossed out every healthy row and read as deleted. The
   * divergence is REGISTRY DATA (§15.2), and the tile publishes it as
   * `data-lifecycle` so styling can key on the same fact.
   */
  const lifecycle = list.lifecycle ?? 'work';
  const struck = completed && STRUCK_WHEN_DONE[lifecycle];
  const controlExpanded = controlCard && (detailsExpanded || flowRef !== null);
  const controlFacts = controlCard ? factsForControlCard(row) : null;
  // Session tiles carry the same chip slot: the index resolves a session's
  // PRs through its working_on task's tracks edges.
  const linkedPullRequests = (controlCard || sessionTree) ? (props.linkedPullRequestsOf?.(row.id) ?? []) : [];

  /**
   * The LEADING sessions chip (user ruling 2026-08-16: "sessions also, at the
   * start, with terminal icons and number"). Counted from the graph
   * projection UNION the row's connections, path-suppressed — the same read
   * the open group renders from, so the chip can never promise a row the
   * group refuses to draw.
   */
  const sessionsOpen = openRelation?.kind === SESSION_CHIP_KIND;
  const sessionsPlural = SESSION_CHIP_KIND
    ? `${sessionRows.length} linked ${getKind(SESSION_CHIP_KIND).label.toLowerCase()}${sessionRows.length === 1 ? '' : 's'}`
    : '';
  const sessionChip = SESSION_CHIP_KIND && sessionRows.length > 0 ? (
    <button
      type="button"
      className={
        sessionsOpen
          ? 'pn-st__count pn-st__count--btn pn-st__count--open'
          : 'pn-st__count pn-st__count--btn'
      }
      data-testid="session-chip"
      data-count-kind={SESSION_CHIP_KIND}
      data-relation-owner={relatedGroupId}
      title={`${sessionsPlural} — click to show them under this row`}
      /* The visible content is a decorative glyph and a number; the name
         must say kind, count and action itself (PR #272 review, 3). */
      aria-label={`${sessionsOpen ? 'Hide' : 'Show'} ${sessionsPlural} under this row`}
      aria-expanded={sessionsOpen}
      aria-controls={sessionsOpen ? relatedGroupId : undefined}
      onClick={(event) => {
        event.stopPropagation();
        toggleRelation(SESSION_CHIP_KIND);
      }}
    >
      <KindIcon kind={SESSION_CHIP_KIND} size={12} />
      {sessionRows.length}
    </button>
  ) : null;

  /** ONE badge sub-row for EVERY anatomy — session-tree, control-card and
      standard alike, or traversal would dead-end at the first doc: sessions
      chip first, then PR chips (on the anatomies that resolve them), then
      the count badges — doors where a count names a real collection kind.
      Clickability requires a wired `connectionsOf`; without the projection
      an opened group could never fill. */
  const tileBadges =
    sessionChip != null || linkedPullRequests.length > 0 || hasTileCounts(row.counters) ? (
      <>
        {sessionChip}
        {linkedPullRequests.length > 0 ? (
          <LinkedPullRequestChips pullRequests={linkedPullRequests} placement="tile" />
        ) : null}
        <TileCountBadges
          counters={row.counters}
          humanAuthors={row.badges.humanMessageAuthors}
          openKind={openRelation?.kind ?? null}
          onToggleKind={props.connectionsOf ? toggleRelation : undefined}
          expandableKind={isExpandableKind}
          controlsId={relatedGroupId}
          countOf={countedRelationOf}
        />
      </>
    ) : undefined;

  /**
   * The open relation group, rendered AFTER the tile at the tile's own level
   * — offset stays the hierarchy tree's vocabulary; a thin rail marks
   * ownership instead (see RelatedGroup). Rows are REAL tiles of their own
   * kind (the 2026-08-13 rule), so a session under a task is the same
   * MaestroSessionTile the sessions list draws, liveness and terminate
   * included — and each nested tile carries its own chips, which is what
   * makes the graph traversable in the panel itself.
   */
  const relatedRows = openRelation
    ? relatedOfKind(
        row.id,
        connections,
        openRelation.kind,
        openRelation.kind === SESSION_CHIP_KIND ? linkedSessions : NO_LINKED,
        nestedPath,
        openRelation.edge,
      )
    : NO_LINKED;
  const relatedBlock = openRelation ? (
    <RelatedGroup
      id={relatedGroupId}
      kind={openRelation.kind}
      label={getKind(openRelation.kind).labelPlural}
      count={relatedRows.length}
      loading={connections === undefined}
      onClose={() => setOpenRelation(null)}
    >
      {relatedRows.map((related) => (
        <Tile
          key={related.id}
          row={related}
          props={props}
          config={getKind(related.kind)}
          path={nestedPath}
        />
      ))}
    </RelatedGroup>
  ) : null;

  if (sessionTree) {
    const state = row.state as unknown as Record<string, unknown>;
    const recordedStatus = typeof state.status === 'string' ? state.status : 'idle';
    const agentTool = typeof state.agentTool === 'string' ? state.agentTool : null;
    // Passed through so the tile can tell a vanilla terminal from an agent
    // whose tool was never recorded (101). Absent stays absent — see the prop.
    const sessionKind = typeof state.sessionKind === 'string' ? state.sessionKind : null;
    // The persona behind the run, when the server resolved one. Read off the
    // summary rather than the graph so the tile's identity cannot flicker on a
    // page that happened to miss the `participates_in` edge.
    const teammate = actorSummaryOrNull(state.teammate);
    const model = typeof state.model === 'string' ? state.model : null;
    const live = verdict === 'live';
    // The lane facts ride the summary state (107) — no edge read needed, so
    // the badge cannot flicker when the bounded graph page misses an edge.
    const lane = sessionLaneOf(row.state);
    return (
      <>
      <MaestroSessionTile
        id={row.id}
        family={family}
        title={row.title || 'Session'}
        agentTool={agentTool}
        sessionKind={sessionKind}
        teammate={teammate}
        model={model}
        status={recordedStatus}
        attention={attention}
        selected={selected}
        archived={archived}
        completed={struck}
        live={live}
        streaming={streaming}
        statusTone={statusTone}
        statusTitle={statusTitle}
        /* Path-suppressed: a session expanded UNDER a task must not offer
           that same task as a chip one level down — the loop the ruling
           names (parent → child → parent renders once). */
        tasks={(props.linkedTasksOf?.(row.id) ?? []).filter((task) => !(path?.has(task.id) ?? false))}
        lane={lane !== null ? <SessionLaneLine lane={lane} /> : undefined}
        badges={tileBadges}
        childCount={childCount}
        childrenExpanded={expanded}
        onToggleChildren={onToggleChildren}
        onSelect={() => props.onSelect?.(row.id)}
        actions={(own) => (
          <RowActionCluster
            row={row}
            props={props}
            config={config}
            openFlow={flowRef}
            onFlow={setFlowRef}
            onOpenLaunch={props.launch?.onFullOptions}
            /* Copy — this anatomy's own affordance, placed by the cluster so
               it lands before Terminate. See `MaestroSessionTile.actions`. */
            anatomyActions={own}
          />
        )}
        detail={<EntityControlStrip row={row} props={props} config={config} />}
      />
      {relatedBlock}
      </>
    );
  }

  if (controlCard && controlFacts) {
    return (
      <>
      <MaestroTaskTile
        rootRef={tileRef}
        id={row.id}
        family={family}
        title={row.title}
        depth={depth}
        selected={selected}
        attention={attention}
        attentionReason={row.badges.attention?.latestReason}
        archived={archived}
        completed={struck}
        childCount={childCount}
        childrenExpanded={expanded}
        onToggleChildren={onToggleChildren}
        onSelect={() => props.onSelect?.(row.id)}
        status={{
          label: statusWord ?? 'no status',
          title: statusTitle,
          tone: statusTone,
          hollow: statusHollow,
          streaming,
        }}
        /* The mark becomes the state control — the same one the expanded strip
           mounts, so the collapsed row writes through exactly the gates and
           refusals the open row does.
           NOT when a liveness `treatment` owns the status: there the dot paints
           the node's verdict, not the record's field, and a picker beside it
           would offer to write the value the dot is not showing. */
        statusControl={
          list.stateControl && !treatment ? (
            <RowStateControl
              row={row}
              props={props}
              control={list.stateControl}
              pill={config.panel.statusPill}
              variant="dot"
              glyph={
                <MaestroStatusGlyph
                  tone={statusTone}
                  hollow={statusHollow}
                  streaming={streaming}
                />
              }
            />
          ) : undefined
        }
        assignees={controlFacts.assignees}
        creator={controlFacts.creator}
        badges={tileBadges}
        /* The same cluster the standard tile draws, in the same order — one
           component, not a second copy. The control-card's own chevron lives
           inside `MaestroTaskTile` after this slot, so no `trailing` here. */
        actions={
          <RowActionCluster
            row={row}
            props={props}
            config={config}
            openFlow={flowRef}
            onFlow={setFlowRef} onOpenLaunch={props.launch?.onFullOptions}
          />
        }
        detailsExpanded={controlExpanded}
        flowOpen={flowRef !== null}
        onToggleDetails={() => {
          if (controlExpanded) {
            setDetailsExpanded(false);
            setFlowRef(null);
          } else {
            setDetailsExpanded(true);
          }
        }}
      >
        {/* D67 — status, priority, assigned and archive, as the FIRST row of
            the expand. These used to be three static <span> badges here and a
            second, working State+Archive strip at the bottom of the same
            expand: two status controls, one of them inert. One strip now, in
            the place the chips already occupied, so the thing that looks like
            the control IS the control. */}
        <EntityControlStrip row={row} props={props} config={config} variant="chips" />

        {flowRef ? (
          <div className="lp__flow lp__flow--control">
            <LaunchQuickConfig
              subject={row}
              key={flowRef}
            verbLabel={resolveAction(flowRef).label}
              {...(resolveAction(flowRef).launchMode
                ? { mode: resolveAction(flowRef).launchMode }
                : {})}
              spaceId={props.launch?.spaceId ?? props.ctx.spaceId ?? ''}
              teammates={props.launch?.teammates ?? []}
              projects={props.launch?.projects ?? []}
              loadFor={props.launch?.loadFor}
              capacity={props.launch?.capacity}
              profileFor={props.launch?.profileFor}
              onSpawn={props.launch?.onSpawn}
              onFullOptions={
                props.launch?.onFullOptions
                  ? () => props.launch?.onFullOptions?.(row.id)
                  : undefined
              }
              onDismiss={() => setFlowRef(null)}
              boundsRef={tileRef}
              newClientMutationId={() => props.launch?.mutationId(row.id) ?? newLaunchMutationId()}
            />
          </div>
        ) : null}

        <div className="pn-tt__metarow">
          {controlFacts.meta.map((fact) => (
            <span key={fact} className="pn-toggle pn-toggle--static">
              {fact}
            </span>
          ))}
          {/* activityAt, not updatedAt: the list's default order IS
              activityAt_desc, and a row whose time disagreed with its own
              position would be worse than no time at all. */}
          <Timestamp className="pn-tt__time" at={row.activityAt} prefix="active" title="last activity" />
        </div>
      </MaestroTaskTile>
      {relatedBlock}
      </>
    );
  }

  return (
    <>
    <div
      ref={tileRef}
      className={[
        'lp__tile',
        selected ? 'lp__tile--selected' : '',
        attention ? 'lp__tile--attention' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="list-tile"
      data-depth={depth}
      /* The registry's lifecycle answer, CSS-consumable — the one attribute
         finding 2 hangs styling on, so a stylesheet can key `[data-lifecycle=
         'library']` without this file ever naming a kind. */
      data-lifecycle={lifecycle}
      /* W3E — same family attribute the other two anatomies carry. */
      data-family={family}
      data-tree={config.list.tree ? 'true' : undefined}
      data-children={childCount > 0 ? childCount : undefined}
      data-flow={flowRef ? 'open' : undefined}
      /* The task tile has carried this since #435; the standard anatomy needed
         it for the same reason. The phone drops the row's verbs while the row
         is CLOSED, and "closed" is a fact only this tile knows — a descendant
         selector cannot read a sibling's `useState`. */
      data-details={detailsExpanded ? 'open' : undefined}
      data-streaming={streaming ? 'true' : 'false'}
    >
      <div className="lp__tile-main" onClick={() => props.onSelect?.(row.id)}>
        {/* Line 1 — disclosure · status mark · avatar · title · status. */}
        <div className="lp__row1">
          {config.list.tree ? (
            onToggleChildren ? (
              <button
                type="button"
                className={expanded ? 'lp__disclosure lp__disclosure--expanded' : 'lp__disclosure'}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.title}, ${childCount} ${childCount === 1 ? 'child' : 'children'}`}
                aria-expanded={expanded}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleChildren();
                }}
              >
                <span aria-hidden><TileChevron /></span>
              </button>
            ) : (
              <span className="lp__disclosure lp__disclosure--empty" aria-hidden>
                <TileChevron />
              </span>
            )
          ) : null}

          {/* W3E — the kind's drawn mark on EVERY standard row, not only the
              statusless ones. The glyph used to be the statusmark's fallback,
              so a row with a status word had no kind identity at all. It rides
              its own `lp__statusmark` slot (the shared 16px grid centring, so
              the `lp__tile-main` row floor is untouched) under `lp__kindglyph`
              — the hook W3C tints via the root's `data-family`. */}
          <span className="lp__statusmark lp__kindglyph" aria-hidden>
            <KindIcon kind={config.kind} size={14} />
          </span>

          {statusWord ? (
            <span
              className={`lp__statusmark lp__statusmark--${statusTone}`}
              aria-hidden
              title={statusTitle}
            >
              <span
                className={[
                  'lp__dot',
                  `lp__dot--${statusTone}`,
                  statusHollow ? 'lp__dot--hollow' : '',
                  streaming ? 'lp__dot--pulse' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            </span>
          ) : null}

          {/* 15, not 20 — 17px is the tallest thing a session row contains and
              therefore the height of every row in every list. */}
          {avatar ? <Avatar actorId={avatar.actorId} provenance={avatar.provenance} label={avatar.label} size={15} src={avatar.src ?? null} /> : null}

          <button
            type="button"
            className={[
              'lp__title',
              /* Two facts, two classes — C2. `--completed` is the
                 strikethrough (this row FINISHED); `--archived` only dims
                 (this row was FILED AWAY). The one class used to be named
                 `--done` and was driven by `deletedAt`, so archiving struck a
                 row through as though it had been completed. `struck`, not
                 `completed`: a library kind's done is storage, not finishing
                 — see the lifecycle note above. */
              struck ? 'lp__title--completed' : '',
              archived ? 'lp__title--archived' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={row.title}
            aria-current={selected ? 'true' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect?.(row.id);
            }}
          >
            {row.title}
          </button>

          {/* Quiet facts and the priority tag ride IN the row, the way a
              session carries its model inline — they used to be a second line,
              which is what made every non-session row twice a session row's
              height. Both ellipsise before the title gives up any width. */}
          {metas.length > 0 ? (
            <span className="lp__meta" title={metas.join(' · ')}>
              {metas.join(' · ')}
            </span>
          ) : null}
          {tag ? (
            <span className={`lp__tag kit-pill--${tag.tone}`}>
              {props.compact ? tag.label.slice(0, 2) : tag.label}
            </span>
          ) : null}

          {/* The badge slot YIELDS to the action cluster on hover — the card
              never grows, so hovering cannot reflow the list under the cursor. */}
          <span className="lp__badges">
            {attention ? (
              /* WHY it needs attention was `title`-only, and `title` renders on
                 hover and nowhere else — so on a phone this row said "Needs
                 attention" and refused to say why, with the reason present in
                 the data and reachable by nobody. Attention is a core concept
                 here; a request with an unreadable reason is a demand.
                 The mouse loses nothing: `.hon-tip` still opens on hover, and
                 now on focus and on tap as well. */
              row.badges.attention?.latestReason ? (
                <ReasonNote
                  className="lp__attention-label"
                  reason={row.badges.attention.latestReason}
                  label="Needs attention — why"
                  testid="attention-reason"
                >
                  Needs attention
                </ReasonNote>
              ) : (
                <span className="lp__attention-label">Needs attention</span>
              )
            ) : null}
            {statusWord ? (
              <span className={`lp__word kit-pill--${statusTone}`} title={statusTitle}>
                {statusWord}
              </span>
            ) : null}
          </span>

          <span className="lp__rowactions lp__cluster">
            {/* Collections · Run · Archive — the shared frame. See
                `RowActionCluster` for why the order lives there and not in
                three separate JSX literals. */}
            <RowActionCluster
              row={row}
              props={props}
              config={config}
              openFlow={flowRef}
              onFlow={setFlowRef} onOpenLaunch={props.launch?.onFullOptions}
              trailing={
                /* D67 — the details disclosure, on EVERY standard tile.
                   DELIBERATELY NOT the leading `lp__disclosure`: that chevron
                   means "show this row's CHILDREN" on tree kinds, and giving one
                   control two meanings would make a doc's expand ambiguous. This
                   one trails the row, matching the control-card's `pn-tt__ind`. */
                <button
                  type="button"
                  /* `--ind` names it the OPENER, the way `pn-tt__ind` does on
                     the task tile. The phone hides this cluster's verbs while
                     the row is closed and must keep exactly this one; a
                     structural selector would break the day a verb is added
                     after it. */
                  className={
                    detailsExpanded
                      ? 'lp__rowaction lp__rowaction--ind lp__rowaction--on'
                      : 'lp__rowaction lp__rowaction--ind'
                  }
                  title="Details"
                  aria-label={`${detailsExpanded ? 'Collapse' : 'Expand'} details for ${row.title}`}
                  aria-expanded={detailsExpanded}
                  data-testid="row-details-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDetailsExpanded((open) => !open);
                  }}
                >
                  <span aria-hidden><TileChevron /></span>
                </button>
              }
            />
          </span>

        </div>
      </div>

      {/* THE RELATION BAND, ON THE STANDARD ANATOMY TOO (PR #272 review,
          blocking 2): the graph is traversable through EVERY tile, so a doc
          expanded under a task carries the same chips and can keep going.
          Rendered as its own sub-row because the standard tile's main row
          holds the 17px floor. */}
      {tileBadges ? <div className="lp__tile-badges">{tileBadges}</div> : null}

      {detailsExpanded ? <EntityControlStrip row={row} props={props} config={config} /> : null}

      {/* The config is an attached card section, not a popover: the subject
          remains obvious while teammate/model choices are changed. */}
      {flowRef ? (
        <div className="lp__flow" onClick={(e) => e.stopPropagation()}>
          <LaunchQuickConfig
            subject={row}
            key={flowRef}
            verbLabel={resolveAction(flowRef).label}
            {...(resolveAction(flowRef).launchMode
              ? { mode: resolveAction(flowRef).launchMode }
              : {})}
            spaceId={props.launch?.spaceId ?? props.ctx.spaceId ?? ''}
            teammates={props.launch?.teammates ?? []}
            projects={props.launch?.projects ?? []}
            loadFor={props.launch?.loadFor}
            capacity={props.launch?.capacity}
            profileFor={props.launch?.profileFor}
            onSpawn={props.launch?.onSpawn}
            onFullOptions={
              props.launch?.onFullOptions
                ? () => props.launch?.onFullOptions?.(row.id)
                : undefined
            }
            onDismiss={() => setFlowRef(null)}
            boundsRef={tileRef}
            newClientMutationId={() => props.launch?.mutationId(row.id) ?? newLaunchMutationId()}
          />
        </div>
      ) : null}
    </div>
    {relatedBlock}
    </>
  );
}

interface ControlCardFacts {
  assignees: EntitySummary['createdBy'][];
  /** Never null in practice — every row carries a creator. */
  creator: EntitySummary['createdBy'] | null;
  meta: string[];
}

/**
 * Maps the registry-selected control-card anatomy onto fields the summary
 * actually carries. This is intentionally structural: another registry row
 * with the same anatomy and fields gets the same component without teaching
 * this panel an entity kind.
 */
function factsForControlCard(row: EntitySummary): ControlCardFacts {
  const state = row.state as unknown as Record<string, unknown>;
  const rawAssignees = Array.isArray(state.assignees) ? state.assignees : [];
  const assignees = rawAssignees.filter(
    (value): value is EntitySummary['createdBy'] =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { displayName?: unknown }).displayName === 'string',
  );
  const meta: string[] = [];
  const acceptance = state.acceptance as { completed?: unknown; total?: unknown } | undefined;
  if (typeof acceptance?.total === 'number' && acceptance.total > 0) {
    meta.push(`${typeof acceptance.completed === 'number' ? acceptance.completed : 0}/${acceptance.total} criteria`);
  }
  if (typeof state.dueDate === 'string' && state.dueDate) {
    // One fact, one spelling: the same humanizer the collapsed badge uses —
    // `due 2026-09-01` on the expanded card was the raw-ISO debug voice.
    meta.push(dueLabel(state.dueDate)?.label ?? `due ${state.dueDate}`);
  }
  const blockers = row.badges.blocked?.unresolvedHardDependencyCount ?? 0;
  if (blockers > 0) meta.push(`${blockers} ${blockers === 1 ? 'blocker' : 'blockers'}`);
  const pulls = row.badges.pulls?.length ?? 0;
  if (pulls > 0) meta.push(`${pulls} pulled`);

  return { assignees, creator: row.createdBy ?? null, meta };
}



/**
 * Client-side row match for the in-panel search (finding #2).
 *
 * Deliberately NOT a `search.query` seam call: that op is reserved in the
 * catalog and the full results VIEW is deferred under R7. This narrows rows
 * the seam has already delivered — the same shape as the D20 lifecycle
 * partition — so the panel gains search without inventing a seam surface.
 * Case-insensitive over the title, which is the only field every kind has.
 */
function matching(rows: readonly EntitySummary[], query: string): readonly EntitySummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.title.toLowerCase().includes(q));
}
