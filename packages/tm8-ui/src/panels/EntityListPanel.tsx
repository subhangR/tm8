import { useEntityListSelection } from '../seen-entities/EntitySeen';
import { AttentionChipView, useAttentionOptional, useEntityChip } from '../attention';
import { Fragment, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { JevPort } from '../jev/port';
import type {
  ActorSummary,
  CollectionGroup,
  Connections,
  EntityCapabilities,
  EntityId,
  EntitySummary,
  CredentialsServiceKeysStatusView,
  ExecutionDispatchResult,
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
  crossTabBreadcrumb,
  groupSessionRows,
  isSessionState,
  sessionLineTwo,
  offeredCountOf,
  sessionRowWord,
  type GroupBulk,
  type SessionClaim,
  toRowFacts,
  VIEWER_ACTOR,
  collectionKinds,
  countLabel,
  getKind,
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
  VectorIcon,
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
import { useRunningGrace } from './list/useRunningGrace';
import './session/session-outcome.css';
import {
  EntityControlStrip,
  RowAction,
  RowActionCluster,
  RowMembershipControl,
  RowStateControl,
  type ControlHost,
  type SessionSharingPatch,
} from './controls/EntityControls';
import { HANDLED_SOURCES, renderBadge, type TileSlot } from './list/tile-badges';
import { CategoryGlyph, TabGlyph, hasCategoryGlyph, hasTabGlyph } from './list/CategoryGlyph';
import { MobileSheet, useMobileSurface } from '../mobile';
import { MaestroStatusGlyph, MaestroTaskTile, type TaskTileProgress } from './list/MaestroTaskTile';
import { type LinkedPullRequestFacts } from '../pull-requests';
import { MaestroSessionTile } from './list/MaestroSessionTile';
import { ChildCountBadge } from './list/ChildCountBadge';
import { RowLead, ToneKindIcon, leadTooltip } from './list/RowLead';
import { TileProgressBar } from './list/TileProgressBar';
import { PendingFormsChip, hasPendingFormsChip } from '../forms/PendingFormsChip';
import { usePendingForms } from '../forms/pending';
import { TileLinkCounts } from './list/TileLinkCounts';
import { hasTileLinkCounts, launchedRowsFilter, treeParentOf } from '../domain';
import { TILE_LINK_GROUPS, UNCOUNTED_LINK_GROUPS } from '../domain/tile-counts';
import { TileSignal, UrgentMark, isUrgent, signalIsAvatar } from './list/TileSignal';
import { SessionDetails } from './list/SessionDetails';
import { facetsForAnatomy, hiddenLinkGroups, linkFacet, useRowView } from './list/row-view';
import { groupOf, groupOptionsFor, rootsOnly, useListPrefs, type ListGroupBy } from './list/list-prefs';
import {
  routeMessagePulse,
  type PulseSegment,
  type SessionPulseKind,
} from './list/message-pulse';
import type { MessagePulse } from './list/useMessagePulses';
import { TileFlightLayer, type ResolvedFlight } from './list/TileFlightLayer';
import { type LaunchTeammateOption } from './launch/LaunchQuickConfig';
/* The Run/Coordinate flow opens the canvas composer as a modal tile now —
   design import 2026-09-07. `LaunchQuickConfig` remains the inline fallback
   for surfaces not yet migrated (merge flow). */
import { LaunchComposerPopup } from '../new-session';
import type { FileUploadTask } from '../files/upload';
import type { LaunchSelectionSources } from '../launch-selection';
import { newLaunchMutationId, type LoadInstalledPlugins } from '../domain/launch';
import { AttentionTileSubtitle, attentionTileLine } from '../attention/AttentionTileSubtitle';
import { isNeedsMeFilter, needsMeCount, needsMeRecheckAt } from '../attention/needs-me';
import { SettingsHomeLink } from './SettingsHomeLink';
import { useFreshGlow, useRetainLeaving } from '../domain/useFreshGlow';

const rowId = (row: EntitySummary): string => row.id;

const EMPTY_MEMBERS: readonly ActorSummary[] = Object.freeze([]);

/**
 * The four narrowing controls, named once — plus `view`, which narrows no
 * query but shares the one-popover rule (row-view.ts).
 *
 * A UNION AND NOT FOUR BOOLEANS: one popover at a time is the rule the filter
 * bar has always enforced, and four independent flags would let the sort menu
 * and a filter picker sit open over each other. On the phone each of these is a
 * bottom sheet, where two at once is not a cosmetic problem but two scrims.
 */
export type ListPicker = 'filters' | 'people' | 'sets' | 'sort' | 'view';

/** The narrowing a host may remember for one kind (`initialFilters` / `onFiltersChange`). */
export interface ListFilterState {
  selected: Readonly<Record<string, readonly string[]>>;
  selectedPeople: readonly string[];
  sortKey: SortKey | undefined;
  lensId: string | null;
}

/** Which body `renderEmpty` is asked for: still reading, nothing at all, or nothing matching. */
export type ListEmptyState =
  | { reason: 'loading' }
  /** `tier` names the open lifecycle tier when IT is empty but the kind is not known to be. */
  | { reason: 'empty'; tier?: string }
  | { reason: 'search'; query: string };

/**
 * A remembered filter state, kept only where it still names this kind's
 * filters, options and sorts — a stale seed degrades to the default.
 */
function seedFilters(config: KindConfig, seed: unknown): ListFilterState | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const raw = seed as Partial<Record<keyof ListFilterState, unknown>>;
  const selected: Record<string, readonly string[]> = {};
  if (typeof raw.selected === 'object' && raw.selected !== null) {
    for (const spec of config.list.filters) {
      const ids = (raw.selected as Record<string, unknown>)[spec.id];
      if (!Array.isArray(ids)) continue;
      const kept = ids.filter(
        (id): id is string => typeof id === 'string' && spec.options.some((o) => o.id === id),
      );
      if (kept.length > 0) selected[spec.id] = spec.multi ? kept : kept.slice(0, 1);
    }
  }
  const selectedPeople = Array.isArray(raw.selectedPeople)
    ? raw.selectedPeople.filter((id): id is string => typeof id === 'string')
    : [];
  const sortKey = config.list.sort.find((s) => s.key === raw.sortKey)?.key;
  const lensId = config.list.membership && typeof raw.lensId === 'string' ? raw.lensId : null;
  return { selected, selectedPeople, sortKey, lensId };
}

/* GONE WITH THE RELATION ACCORDION (task 01a1469f): `SESSION_CHIP_KIND` named
   the kind the leading sessions chip opened, and `EXPANDABLE_KINDS` /
   `isExpandableKind` decided which count badges were doors into an inline
   group. No tile expands anything inline any more — a count opens its group in
   the detail panel (§6) — so all three are deleted rather than left as
   plausible-looking helpers nobody calls. */
/* The `⋯` half of `FilterRow` renders no People and no lens; frozen empties
   keep its props stable across renders rather than new arrays every time. */
const NO_PEOPLE: readonly ActorSummary[] = Object.freeze([]);
const NO_SELECTED: readonly string[] = Object.freeze([]);

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
   * Rows of ANOTHER kind, for the rows this list's rows launched (331,
   * `list.launches`: the chat list's sessions). Absent ⇒ nothing nests.
   */
  rowsForKind?: (kind: string) => (filter: QueryFilter, sort?: SortKey) => readonly EntitySummary[];
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
   * Live delegation, completion and message arrivals, for
   * `list.tree.messagePulse` (the historical registry name).
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
   * STILL DECLARED, NO LONGER READ BY A TILE (task 01a1469f). Both fed chips
   * §6 cut: `linkedSessionsOf` the leading sessions chip, `linkedPullRequestsOf`
   * the PR chips. They stay on the props because four hosts pass them
   * (`WorkspaceView`, `Browser`, `EntityView`, `ChannelView`) and
   * `linkedPullRequestsOf` is live data the DETAIL panel still renders —
   * removing them here would be a four-file change that buys nothing and
   * would have to be undone the day a row wants either fact again.
   *
   * Named as unread rather than left looking wired: a prop a reader assumes
   * drives something is worse than one that says it does not.
   */
  linkedSessionsOf?: (id: string) => readonly EntitySummary[];
  linkedPullRequestsOf?: (id: string) => readonly LinkedPullRequestFacts[];

  /**
   * THE COUNTS LINE'S DOOR (§6, approved 2026-10-16): clicking a count opens
   * THAT GROUP IN THE DETAIL PANEL — "never inline under the row", which is
   * the relation accordion this replaced.
   *
   * `groupKind` is the registry kind the group names (`doc`, `pull_request`,
   * …), carried as DATA from `TILE_LINK_GROUPS` so neither this panel nor the
   * component maps a group id to a kind. Absent ⇒ the counts are plain text,
   * which is the honest rendering on a surface with no detail panel to open
   * (the `k/` collection screen, the dev harnesses).
   */
  onOpenLinks?: (entityId: string, groupKind: string) => void;

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
  /**
   * HOST-REMEMBERED SEARCH AND FILTERS (Workspace browser, Spec A §5). The
   * panel still owns the live state; these SEED it at mount and REPORT every
   * change, so a host that remounts the panel per kind restores that kind's
   * state. A seed that names options this kind no longer has is dropped, never
   * applied. Absent ⇒ the panel starts empty and reports nothing (Home, Work).
   */
  initialQuery?: string;
  onQueryChange?: (query: string) => void;
  /**
   * The HOST draws the search box (the pinned-only rail's panel top row) and
   * hands the text down: the panel follows `query` whenever it changes and
   * draws no search row of its own. Absent ⇒ the panel owns its search.
   */
  query?: string;
  searchInHost?: boolean;
  initialFilters?: unknown;
  onFiltersChange?: (filters: ListFilterState) => void;
  /** The scroll box (`.lp__body`), for a host that remembers scroll. */
  bodyRef?: React.Ref<HTMLDivElement>;
  /**
   * The host's own empty, no-match and loading body for an unfiltered band.
   * Absent ⇒ the panel's own sentences (and no loading state).
   */
  renderEmpty?: (state: ListEmptyState) => ReactNode;
  /**
   * OPT-IN BROWSER CHROME (Workspace browser, list-panel change list round 2
   * item 8): three one-line rows. Row 1 is `[toolbarStart][Search][toolbarEnd]`
   * (the host's kind control and + New around this panel's own search), row 2
   * the lifecycle tiers (`CategoryTabs`, hidden when every row is known to sit
   * in the open tier), row 3 the filter bar with its chips. Rows 2 and 3 scroll
   * sideways rather than wrap. No counts footer, and the `f` cap moves to the
   * search tooltip. Absent ⇒ `'rows'`: as before (Home, Work).
   */
  chrome?: 'rows' | 'toolbar';
  /** `chrome="toolbar"`: drawn before / after the search on row 1. */
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  /**
   * `chrome="toolbar"`: the pinned-only rail's stack (Subhang 2026-10-17) —
   * the full search bar with the funnel and `⋯`, then the kind's name with
   * `toolbarStart` / `toolbarEnd` at its end, then the lifecycle tiers as
   * tabs. Absent ⇒ the one-row header and the host's own create row.
   */
  toolbarInline?: boolean;
  /**
   * OPT-IN ROW LEAD (Workspace browser): no disclosure chevron slot on any
   * anatomy. The leading icon is the kind icon tinted by status (sessions keep
   * their agent tile), carries the child count as a subscript, and IS the
   * expand button when the row has children — the only control that changes
   * expansion. A revealed ancestor latches open (`useTreeDisclosure`
   * `latchReveal`), and a focused tree item takes Right / Left / Enter.
   * Absent ⇒ `'chevron'`: every anatomy as before (Home, Work, Board).
   */
  rowLead?: 'chevron' | 'icon';
  /** `kind` is the ROW's kind: a nested launched row (331) is not the list's. */
  onSelect?: (id: string, kind?: string) => void;
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
  /**
   * Spec D1 §5 — the session outcome verbs (Complete dialog, Stop, Dismiss,
   * Mark lost). See `ControlHost.onSessionVerb`.
   */
  onSessionVerb?: (ref: ActionRef, entityId: string) => void;
  /**
   * Spec D1 §5.3 — a session tab group's bulk verb ("Resume all", "Complete
   * all", "Stop all finished") over the group's row ids. Absent ⇒ the group
   * headers draw no bulk button.
   */
  onSessionBulk?: (bulk: GroupBulk, entityIds: readonly string[]) => void;
  /**
   * Spec D1 §6.8 — a session's `working_on` claims (active and ended), for
   * the row word ("Ready to complete", "Idle 3h") and line 2 ("Working · 2
   * tasks · 1 done"). Absent or `undefined` ⇒ claims unknown, which is not
   * "none".
   */
  linkedClaimsOf?: (sessionId: string) => readonly SessionClaim[] | undefined;
  /** The other half of that row's tail slot — see `ControlHost.onResume`. */
  onResume?: (entityId: string) => void;
  /** The row's sharing slot (187) — see `ControlHost.onShareSession`. */
  onShareSession?: (entityId: string, patch: SessionSharingPatch) => void;
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
  /**
   * The entity's current description, for the launch popup's body field —
   * the popup EDITS the task's description, so it must open showing the real
   * one, read fresh when the row's detail is not hydrated.
   */
  descriptionOf?: (entityId: string) => Promise<string | null>;
  /**
   * Persists title/description edited IN the launch popup back onto the
   * entity, as one patch. Absent ⇒ the edits still shape the session (its
   * title, the agent's briefing) but the entity keeps its own record.
   */
  onUpdateEntity?: (entityId: string, edits: { title?: string; description?: string }) => Promise<unknown> | void;
  /** Caller owns uniqueness of the optimistic-journal id. */
  mutationId: (entityId: string) => string;
  /** ✦ Ask Jev in the Run popup. Absent ⇒ the button renders refused with the reason. */
  jev?: JevPort;
  /**
   * The Claude plugins a launch by this viewer could load — the launch ···
   * menu's Plugins row. Resolves null when the node cannot say.
   */
  loadInstalledPlugins?: LoadInstalledPlugins;
  /** The launch's per-group context (I9): `launch.defaults` and the add pools. */
  selection?: LaunchSelectionSources;
  /**
   * Uploads a file into the space library for the launch card's attach row;
   * the finished file rides the launch as a reference. Absent ⇒ the card's
   * Files row says this surface cannot upload.
   */
  upload?: (file: File) => FileUploadTask;
  /**
   * `execution.dispatch`: hands `subjectId` to the space's dispatcher, which
   * chooses the teammate itself; `note` is the card's instructions. Absent ⇒
   * the launch card draws no Dispatch button.
   */
  dispatch?: (subjectId: EntityId, note?: string, clientMutationId?: string) => Promise<ExecutionDispatchResult>;
  /**
   * `credentials.serviceKeys.status`, so the v3 card's ✦ knows before the
   * first click whether a TypeSafe key (the member's, else the node's) exists.
   */
  jevKeyStatus?: () => Promise<CredentialsServiceKeysStatusView>;
  /** Sessions working on `subjectId` created since `since` — checked after a spawn timeout, before any retry. */
  sessionsSince?: (subjectId: string, since: string) => Promise<readonly { id: string; title: string }[]>;
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

/**
 * How far the hover bar (`.lp__hoverbar`, see `RowActionCluster`) rises above
 * its tile's top edge. Mirrors `--lp-hoverbar-rise` in panels.css.
 */
const HOVERBAR_RISE_PX = 24;

/**
 * WHERE THE HOVER BAR GOES on the tile under the pointer: on the top edge, or
 * tucked INSIDE the tile when there is no room above it.
 *
 * The bar rises out of its tile, and `.lp__body` is the scroll box, so it clips
 * the bar on the first tile of every list (7px of room) and on whichever tile
 * is scrolled to the top. CSS cannot ask "how far am I from my scroll
 * container's edge", so the answer is measured here, once per tile entered,
 * and published as `data-hoverbar` for the stylesheet to read. Delegated from
 * the body so no anatomy has to know about it.
 */
function placeHoverBar(event: ReactPointerEvent<HTMLElement>): void {
  if (event.pointerType !== 'mouse') return;
  const tile = (event.target as Element).closest('[data-testid="list-tile"]');
  if (!tile || tile.contains(event.relatedTarget as Node | null)) return;
  const room = tile.getBoundingClientRect().top - event.currentTarget.getBoundingClientRect().top;
  tile.setAttribute('data-hoverbar', room < HOVERBAR_RISE_PX ? 'inside' : 'above');
}

export function EntityListPanel(input: EntityListPanelProps) {
  const onSelect = useEntityListSelection(input.onSelect);
  const props = { ...input, ...(onSelect ? { onSelect } : {}) };
  const config = getKind(props.kind);
  const list = config.list;
  const listAttentionApi = useAttentionOptional();

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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((list.sections ?? []).filter((s) => s.collapsedByDefault).map((s) => s.id)),
  );
  /**
   * Selected option ids PER FilterSpec. Not a single global id: `status` is
   * `multi`, so several of its options can be active at once, while a
   * non-multi spec holds at most one.
   */
  /* Read once: a host-remembered seed (`initialFilters`) for the state below. */
  const [seed] = useState(() => seedFilters(config, props.initialFilters));
  const [selected, setSelected] = useState<Readonly<Record<string, readonly string[]>>>(seed?.selected ?? {});
  const [selectedPeople, setSelectedPeople] = useState<readonly string[]>(seed?.selectedPeople ?? []);
  const [sortKey, setSortKey] = useState(
    seed?.sortKey ?? list.sort.find((s) => s.default)?.key ?? list.sort[0]?.key,
  );
  const [query, setQuery] = useState(props.query ?? props.initialQuery ?? '');
  /* A host-drawn search box leads; the panel follows it. */
  useEffect(() => {
    if (props.query !== undefined) setQuery(props.query);
  }, [props.query]);
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
  const activeTab = mode === 'board' ? null : (list.categories?.find((t) => t.id === categoryTabId) ?? null);
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
  const [lensId, setLensId] = useState<string | null>(seed?.lensId ?? null);
  /* REPORTED, not owned: the host remembers, the panel stays the writer. The
     mount's own values are not reported back — they are the seed. */
  const { onQueryChange, onFiltersChange } = props;
  const reportedQuery = useRef(query);
  useEffect(() => {
    if (reportedQuery.current === query) return;
    reportedQuery.current = query;
    /* A host-drawn search box already holds the text; reporting it back would
       race the next keystroke and bounce between the two. */
    if (props.searchInHost) return;
    onQueryChange?.(query);
  }, [query, onQueryChange, props.searchInHost]);
  const reportedFilters = useRef<ListFilterState>({ selected, selectedPeople, sortKey, lensId });
  useEffect(() => {
    const prev = reportedFilters.current;
    if (
      prev.selected === selected &&
      prev.selectedPeople === selectedPeople &&
      prev.sortKey === sortKey &&
      prev.lensId === lensId
    ) {
      return;
    }
    reportedFilters.current = { selected, selectedPeople, sortKey, lensId };
    onFiltersChange?.(reportedFilters.current);
  }, [selected, selectedPeople, sortKey, lensId, onFiltersChange]);
  const lensSet =
    list.membership && lensId
      ? ((props.membershipSets ?? []).find((set) => set.id === lensId) ?? null)
      : null;
  /* ATTENTION v2: with an attention module mounted, "Needs me" swaps the
     body for one flat band over the queue (see the body below). */
  const selectedFilter = mergeSelectedFilters(config, selected, props.ctx);
  const needsMeActive = listAttentionApi !== null && isNeedsMeFilter(selectedFilter);
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

  /**
   * Every tab's count, computed ONCE per render and shared by the three
   * surfaces that show it (tabs, footer, selector total). They were three
   * calls to the same function; with paging state joined in it is now enough
   * work to be worth not tripling, and sharing also makes it structurally
   * impossible for the tab and the footer to disagree.
   */
  const tabCounts = (list.categories ?? []).map((tab) => ({
    tab,
    ...tabCount(props, config, tab),
  }));
  const toolbar = props.chrome === 'toolbar';
  /* An empty band under a tier says which tier is empty; "none yet" is only
     for a kind every tier's exact count says has no rows at all. */
  const kindEmpty = tabCounts.every((c) => c.exact && c.n === 0);
  const hostEmpty = props.renderEmpty;
  const bandProps: EntityListPanelProps =
    hostEmpty && activeTab && !kindEmpty
      ? {
          ...props,
          renderEmpty: (state) =>
            hostEmpty(state.reason === 'empty' ? { reason: 'empty', tier: activeTab.label } : state),
        }
      : props;
  /* NO LIFECYCLE TO SLICE: every count is exact and every row sits in the
     open tier (a teammate list reads 14 / 0 / 0 / 0). Hiding then strands
     nothing, because the other tiers are known to be empty. */
  const singleTier =
    tabCounts.length > 0 &&
    tabCounts.every((c) => c.exact && (c.tab.id === activeTab?.id || c.n === 0));
  const tierRow = toolbar && mode !== 'board' && (list.categories?.length ?? 0) > 0 && !singleTier;
  /* Spec D1 §5.3.1 case 7: every session this panel has loaded, across its
     tabs, so a child whose parent sits in ANOTHER tab can name it ("↳ under
     Coordinator X (Completed)"). The same reads the tab counts just made. */
  const crumbs = useSessionCrumbs(props, config, activeTab?.id ?? null);
  /* The selector total's `+` — carried only when a tab's number is still the
     loaded length rather than the server's. Once every tab reports an exact
     total the sum IS exact, and the hedge disappears on its own. */
  const anyTabTruncated = tabCounts.some((c) => !c.exact && c.label.endsWith('+'));
  /* Tabs that OVERLAP (`list.tabTotal`, skills) cannot be summed: `All` is
     already every row, so the total is that one tab's own count, `+` and all. */
  const totalTab = list.tabTotal ? tabCounts.find((c) => c.tab.id === list.tabTotal) : undefined;
  const kindTotal = totalTab
    ? totalTab.label
    : list.categories
      ? `${tabCounts.reduce((n, c) => n + c.n, 0)}${anyTabTruncated ? '+' : ''}`
      : undefined;

  /* chrome="toolbar": every narrowing in ONE funnel popover, pinned at the
     end of the tier row (or of row 1 when the kind has no tiers). */
  const funnel = toolbar ? (
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
      merged
      glyph={props.toolbarInline ? 'settings' : 'funnel'}
      allInOne={props.toolbarInline}
      /* The tiers are tabs in that layout, so status is not a filter too. */
      {...(props.toolbarInline && tierRow ? { omitFilterIds: ['status'] } : {})}
    />
  ) : null;
  /* The `⋯` half of the same component — View and Sort. One `FilterRow`
     rendered twice with different sections, never two copies of the option
     lists: that is how the phone's lens ended up a release behind the
     desktop's, which `narrowing`'s own header records. */
  const more = toolbar ? (
    <FilterRow
      config={config}
      picker={picker}
      onPicker={setPicker}
      selected={selected}
      onToggleOption={() => undefined}
      sortKey={sortKey}
      onSort={setSortKey}
      viewerActorId={props.ctx.viewerActorId}
      people={NO_PEOPLE}
      selectedPeople={NO_SELECTED}
      onTogglePerson={() => undefined}
      lensSet={null}
      onLens={() => undefined}
      merged
      section="view"
    />
  ) : null;
  /**
   * THE NUMBER BESIDE THE TITLE. The open tier's own count when the kind has
   * tiers (the dropdown beside it names which tier that is), else the kind's
   * total. NOT the sum across tiers while one tier is shown: a header reading
   * `Tasks 266` over eleven visible rows is a number about something the
   * reader cannot see.
   */
  const headCount = tierRow
    ? (tabCounts.find((c) => c.tab.id === categoryTabId)?.label ?? kindTotal)
    : kindTotal;

  return (
    <section
      className={`${props.compact ? 'lp lp--compact' : 'lp'}${toolbar ? ' lp--toolbar' : ''}`}
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
          total={kindTotal}
          liveCount={liveCountFor(props, config, activeTab, tabCounts)}
          alert={alertCountFor(config, tabCounts, setCategoryTabId)}
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

      {toolbar ? (
        <>
          {/*
            THE HOST'S CREATE ROW. `toolbarStart` / `toolbarEnd` is where the
            Workspace browser puts its `[+ | kind ▾]` box; it is NOT list
            chrome and it is on its way out — design doc §5 moves New to the
            top of the navigator column, where the kind is chosen ONCE. Until
            that lands (task 01a1469d), it keeps its own row, and the row is
            not drawn at all on the surfaces that pass neither slot.
          */}
          {!props.toolbarInline && (props.toolbarStart || props.toolbarEnd) ? (
            <div className="lp__toolrow">
              {props.toolbarStart}
              {props.toolbarEnd}
            </div>
          ) : null}
          {/*
            THE LIST HEADER, ONE ROW (design doc 01a1465d §5, approved
            2026-10-16):

                Tasks 18   [Open ▾]            ⌕  ⨝  ⋯

            It replaces FOUR stacked bands — a bordered search row, a 28px
            lifecycle rail, a filter-chip row and a View picker — which between
            them spent ~120px of a 300px-wide column before the first row of
            actual work. The facts did not go anywhere: the tier is the
            dropdown, the filters are the funnel, View and Sort are the `⋯`,
            and search is the 🔍 that expands over the title.
          */}
          {props.toolbarInline ? (
            /*
             * THE PINNED-ONLY RAIL'S STACK (Subhang, 2026-10-17):
             *
             *     [⌕ Search tasks…                ]
             *     Tasks [⚙]               [+|☑ ▾]
             *     To Do · In progress · Done …
             *
             * The full search bar leads; the kind's name, its one settings
             * control and the host's new box share the next row; the lifecycle
             * tiers are the tab row again, not a dropdown, for the kinds that
             * have them. There is no `⋯` in this layout.
             */
            <>
              {props.searchInHost ? null : (
                <div className="lp__searchline" data-testid="list-searchline">
                  <SearchRow
                    config={config}
                    query={query}
                    onQuery={setQuery}
                    inputRef={props.searchInputRef}
                  />
                </div>
              )}
              <div className="lp__head lp__head--stack" data-testid="list-head">
                <h2 className="lp__headtitle">
                  {/* The name only (Subhang 2026-10-17): each tier's count is
                      on its tab. */}
                  <span className="lp__headname">{config.labelPlural}</span>
                </h2>
                {/* ONE settings control beside the title; no `⋯` here. */}
                {funnel}
                {props.toolbarStart || props.toolbarEnd ? (
                  <div className="lp__headtools">
                    {props.toolbarStart}
                    {props.toolbarEnd}
                  </div>
                ) : null}
              </div>
              {tierRow && list.categories ? (
                <CategoryTabs
                  tabs={list.categories}
                  activeTabId={categoryTabId}
                  onTab={setCategoryTabId}
                  tabLabel={(tab: StatusCategoryTab) =>
                    tabCounts.find((c) => c.tab.id === tab.id)?.label ?? '0'
                  }
                  compactWhenNarrow
                />
              ) : null}
            </>
          ) : (
          <div className="lp__head" data-testid="list-head">
            <h2 className="lp__headtitle">
              <span className="lp__headname">{config.labelPlural}</span>
              {/* The visible population, from the same `tabCounts` the tier
                  dropdown's options read — one number, one source. */}
              {headCount ? <span className="lp__headcount">{headCount}</span> : null}
            </h2>
            {tierRow && list.categories ? (
              <TierMenu
                tabs={list.categories}
                activeTabId={categoryTabId}
                onTab={setCategoryTabId}
                tabLabel={(tab: StatusCategoryTab) =>
                  tabCounts.find((c) => c.tab.id === tab.id)?.label ?? '0'
                }
              />
            ) : null}
            <HeaderSearch
              config={config}
              query={query}
              onQuery={setQuery}
              inputRef={props.searchInputRef}
            />
            {funnel}
            {more}
          </div>
          )}
        </>
      ) : (
        <>
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
          activeTabId={categoryTabId}
          onTab={setCategoryTabId}
          tabLabel={(tab: StatusCategoryTab) =>
            tabCounts.find((c) => c.tab.id === tab.id)?.label ?? '0'
          }
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
        </>
      )}

      {/* THE LENS SAYS WHAT IT HIDES. A kind-scoped list showing one set's
          members is NOT the set: a mixed collection holds items of every
          kind, and a list that silently showed five of twelve would let the
          page read as the whole collection. The note carries both numbers —
          the lens query's own count (of exactly the rows below) and the
          set's total membership off its summary. */}
      {lensSet && lensFilter ? (
        <LensNote set={lensSet} filter={lensFilter} props={props} config={config} />
      ) : null}

      <div className="lp__body" ref={props.bodyRef} onPointerOver={placeHoverBar}>
        {needsMeActive ? (
          /* ATTENTION v2 — "Needs me" is the attention QUEUE, one flat list in
             queue order (needs-me.ts). Tabs, sections, people chips and the
             lens partition entities, not the queue, so none of them narrow it:
             the band reads the needs-me clause alone, and the note says so. */
          <>
            <p className="att-needs-me-note" data-testid="needs-me-note">
              Needs me lists what is waiting on you, in queue order — tabs and sections don’t apply.
            </p>
            <Band
              label={null}
              filter={selectedFilter}
              props={props}
              config={config}
              query={query}
            />
          </>
        ) : mode === 'board' && list.board ? (
          <BoardBody
            props={props}
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
              props={bandProps}
              config={config}
              query={query}
            />
          ))
        ) : (
          <SessionCrumbContext.Provider value={crumbs}>
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
            props={bandProps}
            config={config}
            query={query}
            tabId={activeTab?.id ?? null}
          />
          </SessionCrumbContext.Provider>
        )}
      </div>

      {/* T0-1 draws a footer count line on every kind: "9 to do · 4 in
          progress · 601 done · 12 cancelled". Same per-tab counts as the tabs
          above — one source, three surfaces (tabs, footer, selector total).

          The tab's LABEL, lowercased — not its `id`. The ids are the
          contract's `StatusCategory` literals, so printing them would put
          `to_do` and `in_progress` in front of a user; the label is the word
          the tab above already shows them. */}
      {/* Not for overlapping tabs (`tabTotal`): "12 all · 3 equipped · 9 not
          equipped" reads as a breakdown that adds up, and it does not. */}
      {tabCounts.length > 0 && !list.tabTotal && !toolbar ? (
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
function liveCountFor(
  props: EntityListPanelProps,
  config: KindConfig,
  tab: StatusCategoryTab | null,
  tabCounts: readonly { tab: StatusCategoryTab; n: number }[] = [],
): string | null {
  const spec = config.list.liveCount;
  if (!spec) return null;
  /* Spec D1 §5.3: "● N running" IS the Running tab's count — the server's
     total for that tab, whichever tab is open. Stale and unverified rows are
     in it on purpose: the tab holds them until the reaper says lost. */
  if (spec.tab) {
    const counted = tabCounts.find((c) => c.tab.id === spec.tab);
    if (counted) return spec.label(counted.n);
  }
  if (!props.liveIds) return null;
  const merged = narrow(spec.filter, tab?.filter);
  const rows = merged === null ? NO_ROWS : props.rowsFor(merged);
  const live = new Set(props.liveIds);
  return spec.label(rows.filter((r) => live.has(r.id)).length);
}

/**
 * Spec D1 §5.3: "⚠ M interrupted" beside the running count, linking to its
 * tab. Null at zero — an alert that says nothing is not drawn.
 */
function alertCountFor(
  config: KindConfig,
  tabCounts: readonly { tab: StatusCategoryTab; n: number }[],
  onTab: (id: string) => void,
): { label: string; onClick: () => void } | null {
  const spec = config.list.liveCount?.alertTab;
  if (!spec) return null;
  const counted = tabCounts.find((c) => c.tab.id === spec.tab);
  if (!counted || counted.n === 0) return null;
  return { label: spec.label(counted.n), onClick: () => onTab(spec.tab) };
}

// ---------------------------------------------------------------------------
// Header rows
// ---------------------------------------------------------------------------

function KindSelector({
  config,
  total,
  liveCount,
  alert,
  onKindChange,
}: {
  /** Spec D1 §5.3 — "⚠ M interrupted", which opens that tab. */
  alert?: { label: string; onClick: () => void } | null;
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
  liveCount: string | null;
  onKindChange?: (kind: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, ref, useCallback(() => setOpen(false), []));
  return (
    <div className="lp__selector" ref={ref}>
      <button type="button" className="lp__kind" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="lp__kind-glyph" aria-hidden>
          <KindIcon kind={config.kind} />
        </span>
        {config.labelPlural}
        <span className="lp__caret" aria-hidden>
          ▾
        </span>
      </button>
      <span className="lp__spacer" />
      {total !== undefined ? (
        <span className="lp__total" data-testid="kind-total">
          {total}
        </span>
      ) : null}
      {liveCount ? (
        <span className="lp__livecount" data-testid="list-live-count">
          {liveCount}
        </span>
      ) : null}
      {alert ? (
        <button type="button" className="lp__livecount lp__livecount--alert" data-testid="list-alert-count" onClick={alert.onClick}>
          {alert.label}
        </button>
      ) : null}
      {open ? (
        <ul className="lp__kindmenu" role="menu">
          {/* Only `strategy: 'collection'` kinds can BE a list: channel is a
              special route and message is anchored, so neither has a
              collection view to switch to. That exclusion is registry data. */}
          {collectionKinds().map((k) => (
            <li key={k.kind}>
              <button
                type="button"
                role="menuitem"
                className={k.kind === config.kind ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                onClick={() => {
                  setOpen(false);
                  onKindChange?.(k.kind);
                }}
              >
                <KindIcon kind={k.kind} />
                {k.labelPlural}
              </button>
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
  // A kind managed from Settings (credentials, space links) has no create door
  // here; its header links to the section that holds the human-only verbs.
  const settingsHome = config.settingsHome;
  if (!showCreate && !showLaunch && !showStart && !settingsHome) return null;

  return (
    <div className="lp__actions">
      {settingsHome ? <SettingsHomeLink home={settingsHome} compact /> : null}
      {/* Authoring mount 7a: when the host supplies a REAL create flow it
          replaces the bare button — which was INERT when onCreate was absent
          (the audit's '+New inert' row). No slot and no onCreate ⇒ nothing
          renders enabled-dead. */}
      {showCreate && createSlot ? (
        createSlot
      ) : showCreate && onCreate ? (
        <button type="button" className="lp__new" onClick={onCreate}>
          ＋ New
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
  hint = true,
}: {
  config: KindConfig;
  query: string;
  onQuery: (q: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  /** False ⇒ no `f` key cap; the shortcut is named in the tooltip instead. */
  hint?: boolean;
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
        {...(hint ? {} : { title: `Search ${config.labelPlural.toLowerCase()} (F)` })}
      />
      {hint ? <kbd className="lp__searchrow-key">f</kbd> : null}
    </div>
  );
}

/**
 * THE TIER DROPDOWN — `[Open ▾]` beside the list title (design doc 01a1465d
 * §5, approved 2026-10-16). It replaces the tier ROW, which `CategoryTabs`
 * still draws on every surface that is not the one-row header.
 *
 * WHY A MENU RATHER THAN FOUR SEGMENTS. The row was a 28px control spanning
 * the panel, so the lifecycle axis cost a whole band of the column's height
 * and still clipped `Cancelled` at the narrow widths (see `.lp__tierrow`'s
 * own comment). You are in exactly one tier at a time and you change it
 * rarely; that is a menu's shape, not a segmented control's. The trigger
 * carries the CURRENT tier's word, so nothing is hidden — what is hidden is
 * the three you are not in.
 *
 * THE COUNTS COME ALONG. Each option keeps the count the tab drew, from the
 * same `tabCounts` read, so the dropdown and the title's own number cannot
 * disagree. The trigger does NOT repeat the active tier's count: the title
 * one slot to its left already is that number.
 */
function TierMenu({
  tabs,
  activeTabId,
  onTab,
  tabLabel,
}: {
  tabs: readonly StatusCategoryTab[];
  activeTabId: string | null;
  onTab: (id: string) => void;
  tabLabel: (tab: StatusCategoryTab) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, ref, useCallback(() => setOpen(false), []));
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  if (!active) return null;
  return (
    <div className="lp__tiermenu" ref={ref}>
      <button
        type="button"
        className="lp__tiertrigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Lifecycle: ${active.label}`}
        title="Lifecycle"
        data-testid="list-tier-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="lp__tierword">{active.label}</span>
        <span className="lp__tiercaret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="lp__filtermenu lp__tierpop" role="menu" data-testid="list-tier-menu">
          {tabs.map((tab) => {
            const on = tab.id === active.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                data-tier={tab.id}
                onClick={() => {
                  onTab(tab.id);
                  setOpen(false);
                }}
              >
                <span className="lp__optlabel">{tab.label}</span>
                {/* Spec D1 §5.3: an alerting tier's count is a red badge above zero. */}
                <span
                  className={tab.alert && tabLabel(tab) !== '0' ? 'lp__tab-count lp__tab-count--alert' : 'lp__tab-count'}
                  data-alert={tab.alert && tabLabel(tab) !== '0' ? 'true' : undefined}
                >
                  {tabLabel(tab)}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * THE EXPANDING SEARCH — a 🔍 that becomes the field, in the one-row header
 * (§5). Collapsed it is one 24px glyph; open it takes the row's free space.
 *
 * THE INPUT IS ALWAYS MOUNTED, and that is the load-bearing decision here.
 * The `list.search` command focuses this panel's `searchInputRef` and never
 * touches the DOM itself (see `SearchRow`'s header) — a ref to an UNMOUNTED
 * input is a no-op, so an unmount-when-closed field would have silently
 * killed the keyboard path, with the binding still in the contract and the
 * help sheet still advertising it. Mounted-but-collapsed keeps one focus
 * target: `f` focuses it, focus expands it, and the glyph just focuses it too.
 *
 * ESC CLEARS, THEN CLOSES (§5) — two presses, in that order, because the
 * first press on a field with text in it must not also throw away the width
 * the reader was typing into. A field that is already empty closes on the
 * first press. Layer 4 makes Esc blur a focused field; this handler runs
 * first and stops the event while it still has work of its own to do.
 *
 * THE KEY IS `f`, NOT `/`, AND THAT CONTRADICTS §7 ON PURPOSE. The design doc
 * asks for `/`; D36 (`keyboard/contract.ts`) rules that `/` is the command
 * palette's GUARANTEED path because ⌘K is browser-owned on Chrome Win/Linux
 * and Firefox everywhere, and a focused list is the most common focus state —
 * spending `/` here leaves the palette unreachable on half the matrix. So the
 * expanding field is wired to the EXISTING guaranteed binding and `/` is left
 * alone. Flagged for Subhang rather than decided here; moving it is one line
 * in `keyboard/contract.ts` if he rules the other way.
 */
function HeaderSearch({
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
  const [focused, setFocused] = useState(false);
  const own = useRef<HTMLInputElement>(null);
  /* A query survives a blur: a list narrowed by text must keep saying so. */
  const open = focused || query.length > 0;
  const label = `Search ${config.labelPlural.toLowerCase()}`;
  return (
    <div className="lp__headsearch" data-open={open ? 'true' : undefined} data-testid="list-search-cell">
      <button
        type="button"
        className="lp__headsearch-glyph"
        aria-label={label}
        aria-expanded={open}
        title={`${label} (F)`}
        data-testid="list-search-open"
        onClick={() => own.current?.focus()}
      >
        <span aria-hidden>⌕</span>
      </button>
      <input
        ref={(node) => {
          own.current = node;
          if (typeof inputRef === 'function') inputRef(node);
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node;
        }}
        className="lp__headsearch-input"
        type="search"
        value={query}
        placeholder={label}
        aria-label={label}
        data-testid="list-search"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          if (query.length > 0) {
            /* Clear FIRST, and keep the field — and keep the event, so layer 4
               does not blur the thing the reader is still using. */
            event.stopPropagation();
            event.preventDefault();
            onQuery('');
            return;
          }
          setFocused(false);
          own.current?.blur();
        }}
      />
    </div>
  );
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
  compactWhenNarrow = false,
}: {
  tabs?: readonly StatusCategoryTab[];
  activeTabId: string | null;
  onTab: (id: string) => void;
  /** Already rendered — `50+` when the page is saturated, `50` when it is all. */
  tabLabel: (tab: StatusCategoryTab) => string;
  /**
   * MARKS WHEN THE WORDS WOULD BE CUT (pinned-only rail, Subhang 2026-10-17):
   * once any tab's word is clipped, every tab draws its mark and count, the
   * name moving to the tooltip and the accessible name. The row goes back to
   * words when the column is wider again than where it switched.
   */
  compactWhenNarrow?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const narrowRef = useRef(false);
  const switchedAt = useRef(0);
  const countsKey = (tabs ?? []).map((tab) => `${tab.id}:${tabLabel(tab)}`).join('|');
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!compactWhenNarrow || !el) return;
    /* THE ROW DOES NOT SHRINK — it keeps its words' width and the panel clips
       it — so "cut" is measured against what its PARENT gives it, and it is
       the parent whose resizes are watched. */
    const parent = el.parentElement;
    const available = () => {
      if (!parent) return el.clientWidth;
      const cs = getComputedStyle(el);
      return parent.clientWidth - parseFloat(cs.marginLeft || '0') - parseFloat(cs.marginRight || '0');
    };
    const measure = () => {
      const room = available();
      if (!narrowRef.current) {
        /* What the words NEED: first tab's left edge to the last tab's right.
           Not `scrollWidth` — the row itself stretches to its parent. */
        const kids = el.children;
        const need =
          kids.length > 0
            ? kids[kids.length - 1]!.getBoundingClientRect().right - kids[0]!.getBoundingClientRect().left
            : 0;
        const clipped =
          need > room + 1 ||
          Array.from(el.querySelectorAll<HTMLElement>('.lp__tab-word')).some((word) => word.scrollWidth > word.clientWidth + 1);
        if (clipped) {
          switchedAt.current = room;
          narrowRef.current = true;
          setNarrow(true);
        }
      } else if (room > switchedAt.current + 8) {
        narrowRef.current = false;
        setNarrow(false);
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(parent ?? el);
    return () => observer?.disconnect();
  }, [compactWhenNarrow, countsKey, narrow]);
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
  const marks = narrow && tabs.every((tab) => hasTabGlyph(tab.id));
  return (
    <div className="lp__tierrow" role="tablist" aria-label="Lifecycle" ref={rowRef} data-marks={marks || undefined}>
      {tabs.map((tab) => {
        // A kind's own tabs (skills) have no category mark, so on one surface
        // they keep their word rather than render an empty glyph.
        const glyph = oneSurface && hasCategoryGlyph(tab.id) ? tab.id : null;
        if (marks && !glyph) {
          const alerting = tab.alert && tabLabel(tab) !== '0';
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={tab.id === activeTabId ? 'lp__tab lp__tab--active lp__tab--mark' : 'lp__tab lp__tab--mark'}
              onClick={() => onTab(tab.id)}
              aria-label={`${tab.label}, ${tabLabel(tab)}`}
              title={`${tab.label} · ${tabLabel(tab)}`}
              data-tab-id={tab.id}
            >
              <TabGlyph id={tab.id} />
              <span
                className={alerting ? 'lp__tab-count lp__tab-count--alert' : 'lp__tab-count'}
                data-alert={alerting ? 'true' : undefined}
              >
                {tabLabel(tab)}
              </span>
            </button>
          );
        }
        return (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={tab.id === activeTabId ? 'lp__tab lp__tab--active' : 'lp__tab'}
          onClick={() => onTab(tab.id)}
          {...(glyph ? { 'aria-label': `${tab.label}, ${tabLabel(tab)}` } : {})}
        >
          {glyph ? (
            <CategoryGlyph category={glyph} />
          ) : (
            <>
              {/* THE COUNT IS A SECOND VOICE, NOT THE SAME ONE. At the label's
                  size and weight `To Do 227` reads as one blob rather than a
                  name with a quantity; at --pn-fs-fine in --pn-ink-4 it recedes
                  without being lost, and tabular figures stop the row reflowing
                  as the numbers tick. The word is the part allowed to shorten
                  (see .lp__tab-word in panels.css) — a count that truncates is
                  a wrong number, which is worse than a shortened one. */}
              <span className="lp__tab-word">{tab.label}</span>
              {/* Spec D1 §5.3: an alerting tab's count is a red badge above zero. */}
              <span
                className={tab.alert && tabLabel(tab) !== '0' ? 'lp__tab-count lp__tab-count--alert' : 'lp__tab-count'}
                data-alert={tab.alert && tabLabel(tab) !== '0' ? 'true' : undefined}
              >
                {tabLabel(tab)}
              </span>
            </>
          )}
        </button>
        );
      })}
    </div>
  );
}

/*
 * THE FILTER ROW IS ICONS, NOT WORDS. Each trigger is a glyph on the 16×16
 * grid with its name in `aria-label` and `title`, so the row fits at every
 * width without clipping its last chip, and a screen reader still hears the
 * word. The count badge stays: it is state, not a label.
 */
/** A funnel — the same shape as the phone's narrowing cluster (`NarrowGlyph`). */
const FILTER_MARK = ['M2.5 3.5H13.5L9.25 8.5V13L6.75 11.5V8.5Z'];
/** Settings sliders — two rails with a knob each — for the pinned-only rail's
    one list-settings control (Subhang 2026-10-17: "like a settings icon"). */
const SETTINGS_MARK = [
  'M2.5 5h5.5',
  'M11.5 5h2',
  'M9.75 3.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
  'M2.5 11h2',
  'M8 11h5.5',
  'M6.25 9.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
];
/** A head and shoulders. */
const PEOPLE_MARK = [
  'M10.4 5.4a2.4 2.4 0 1 1 -4.8 0a2.4 2.4 0 1 1 4.8 0Z',
  'M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4',
];
/** Stacked sets — a collection is a curated set of rows. */
const SETS_MARK = [
  'M2.5 5.5h8.5v8H2.5z',
  'M5 3h8.5v8',
];
/** An open eye — which facts each row shows. */
const VIEW_MARK = [
  'M1.5 8C3.2 4.9 5.4 3.5 8 3.5s4.8 1.4 6.5 4.5C12.8 11.1 10.6 12.5 8 12.5S3.2 11.1 1.5 8Z',
  'M10 8a2 2 0 1 1 -4 0a2 2 0 1 1 4 0Z',
];
/** A descending arrow beside shortening bars — the order rows arrive in. */
const SORT_MARK = ['M4.5 2.5v11', 'M2 11l2.5 2.5L7 11', 'M9 4h5', 'M9 8h3.5', 'M9 12h2'];

function FilterRow({
  config,
  picker,
  onPicker,
  selected,
  onToggleOption,
  sortKey,
  onSort,
  people,
  selectedPeople,
  onTogglePerson,
  viewerActorId,
  membership,
  membershipSets,
  lensSet,
  onLens,
  merged = false,
  section = 'narrow',
  glyph = 'funnel',
  allInOne = false,
  omitFilterIds,
}: {
  config: KindConfig;
  /** Which of the four is open. Held by the panel — see `ListPicker`. */
  picker: ListPicker | null;
  onPicker: (picker: ListPicker | null) => void;
  selected: Readonly<Record<string, readonly string[]>>;
  onToggleOption: (specId: string, optionId: string, multi: boolean) => void;
  sortKey: SortKey | undefined;
  onSort: (key: SortKey) => void;
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
  /** One funnel and one popover with every axis (`chrome="toolbar"`). */
  merged?: boolean;
  /**
   * WHICH HALF OF THE MERGED POPOVER THIS INSTANCE IS (one-row header, design
   * doc 01a1465d §5). Only read when `merged`.
   *
   *   'narrow' — the funnel: what the list CONTAINS. Filter, People, the
   *              collection lens. Narrowing the population is one idea.
   *   'view'   — the `⋯`: how the rows LOOK. View facets and Sort.
   *
   * They were one popover with five sections, and the ruling split them
   * because the funnel glyph promises narrowing and half of what was behind it
   * narrowed nothing: hiding the avatars changed no row's membership. Two
   * triggers, two ideas, and the Reset in each only resets its own.
   */
  section?: 'narrow' | 'view';
  /** The merged narrowing trigger's mark: the funnel, or settings sliders. */
  glyph?: 'funnel' | 'settings';
  /**
   * ONE "LIST SETTINGS" MENU (pinned-only rail, Subhang 2026-10-17): the
   * narrowing trigger also carries Sort, Group by and View (with Show
   * sub-items), and there is no `⋯`. Only read when `merged`.
   */
  allInOne?: boolean;
  /** Filter specs not offered here (the status filter where tiers are tabs). */
  omitFilterIds?: readonly string[];
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
  /* EACH TRIGGER DISMISSES ITS OWN MENU. The funnel and the `⋯` are two
     FilterRows over ONE `picker`; when both listened for any open picker, a
     pointerdown inside the `⋯` menu was "outside" the funnel's bar, and the
     funnel closed the `⋯` before the option's click landed. */
  const mine =
    picker !== null && (section === 'view' ? picker === 'view' : !merged || picker !== 'view');
  useDismissable(!inSheet && mine, barRef, useCallback(() => setPicker(null), [setPicker]));
  const sort = config.list.sort;
  const current = sort.find((s) => s.key === sortKey) ?? sort[0];
  /* VIEW — which facts each row draws (row-view.ts). Only the facets this
     kind's anatomy actually renders are offered, and the chip counts the
     hidden ones among THOSE, so a stale key from another anatomy never
     reads as "1 hidden" on a list where nothing is. */
  const view = useRowView(config.kind);
  const viewFacets = facetsForAnatomy(config.list.tile.anatomy);
  const hiddenFacetCount = viewFacets.filter((spec) => view.hidden.has(spec.id)).length;
  const listPrefs = useListPrefs(config.kind);
  const groupOptions = groupOptionsFor(config.kind);
  const filterSpecs = omitFilterIds ? config.list.filters.filter((spec) => !omitFilterIds.includes(spec.id)) : config.list.filters;

  const active = config.list.filters.flatMap((spec) =>
    (selected[spec.id] ?? []).flatMap((optionId) => {
      const option = spec.options.find((o) => o.id === optionId);
      return option ? [{ spec, option }] : [];
    }),
  );
  /* THE CHIP COUNTS THE NARROWINGS, so an active filter states how many
     without spawning one dismissable chip per selection — which is what let
     this row grow past its container. It is the same array the chips below
     are built from, so the badge cannot disagree with them. */
  const activeFilterCount = active.length;

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

  /* The option lists, one per narrowing menu below. */
  const filterOptions = (
    <>
          {filterSpecs.map((spec) => (
            <div key={spec.id}>
              <div className="lp__filtergroup">{merged ? spec.label : spec.label.toUpperCase()}</div>
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
                    {/* A REAL BOX, NOT A TRAILING TICK. These options combine,
                        and a `✓` that appears only after the click cannot say
                        so beforehand — the affordance has to be visible while
                        the option is still off. Drawn, not an <input>: the
                        button already owns `role="menuitemcheckbox"` and its
                        `aria-checked`, so a nested input would be a second,
                        conflicting control in the same accessible node. */}
                    <span className="lp__optbox" aria-hidden data-on={on ? 'yes' : 'no'} />
                    <span className="lp__optlabel">{option.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
    </>
  );
  const setsOptions = membership ? (
    <>
          {(membershipSets ?? []).length === 0 ? (
            /* An empty page is a real answer, said in its own words — never a
               bare menu that reads as "the space has none" when the truth may
               be "none exist YET". The sets source is a bounded recency page,
               so this is also where that bound is stated. */
            <p className="lp__filterempty" data-testid="collection-lens-empty">
              {`No ${membership.label.toLowerCase()} yet — create one from its own list. This menu offers the most recent page once any exist.`}
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
                    if (!merged) setPicker(null);
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
  ) : null;
  const viewOptions = (
    <>
            {viewFacets.map((spec) => {
              const on = view.shows(spec.id);
              return (
                <button
                  key={spec.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                  data-facet={spec.id}
                  onClick={() => view.toggle(spec.id)}
                >
                  <span className="lp__optbox" aria-hidden data-on={on ? 'yes' : 'no'} />
                  <span className="lp__optlabel">{spec.label}</span>
                </button>
              );
            })}
    </>
  );
  const peopleOptions = (
    <>
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
  );
  const sortOptions = (
    <>
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
                if (!merged) setPicker(null);
              }}
            >
              {spec.label}
              {spec.key === current?.key ? <span className="lp__filtercheck">✓</span> : null}
            </button>
          ))}
    </>
  );

  if (merged) {
    const defaultSort = sort.find((s) => s.default)?.key ?? sort[0]?.key;
    const sortChanged = current && current.key !== defaultSort ? 1 : 0;
    /* WHICH LINKS A ROW SHOWS (Subhang 2026-10-17): one switch per group
       on the counts line, in BOTH layouts — the rail's List settings and the
       default `⋯` — over the same facet store. Off while the whole line is
       off, and a group the server does not count yet says so rather than
       looking broken. */
    const linkGroupsHidden = hiddenLinkGroups(view.hidden).size;
    const linksSection = viewFacets.some((spec) => spec.id === 'counts') ? (
      <section className="lp__funnelsection" aria-label="Links on rows" data-testid="list-links-section">
        <div className="t-eyebrow">Links on rows</div>
        {TILE_LINK_GROUPS.map((group) => {
          const facet = linkFacet(group.id);
          const lineOn = view.shows('counts');
          const on = lineOn && view.shows(facet);
          const pending = UNCOUNTED_LINK_GROUPS.has(group.id);
          const name = getKind(group.kind).labelPlural;
          return (
            <button
              key={group.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              aria-disabled={!lineOn || undefined}
              className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
              data-link-group={group.id}
              title={pending ? `${name} are not counted by the server yet, so rows show none for now` : name}
              onClick={() => {
                if (lineOn) view.toggle(facet);
              }}
            >
              <span className="lp__optbox" aria-hidden data-on={on ? 'yes' : 'no'} />
              <KindIcon kind={group.kind} size={14} />
              <span className="lp__optlabel">{name}</span>
              {pending ? <span className="lp__opthint">not counted yet</span> : null}
            </button>
          );
        })}
      </section>
    ) : null;

    /* THE BADGE COUNTS WHAT IS NOT DEFAULT — in THIS trigger's own sections,
       so a hidden avatar never puts a number on the funnel and an active
       filter never puts one on the `⋯`. A badge that counts somebody else's
       state is a badge the reader cannot act on. */
    const changed =
      section === 'view'
        ? hiddenFacetCount + sortChanged + linkGroupsHidden
        : activeFilterCount + selectedPeople.length + (lensSet ? 1 : 0) +
          (allInOne ? hiddenFacetCount + sortChanged + listPrefs.changed + linkGroupsHidden : 0);

    /* `⋯` and the funnel must not share a picker key, or opening one would
       read as the other being open. `view` is already in `ListPicker`. */
    const key: ListPicker = section === 'view' ? 'view' : 'filters';
    const open = picker === key;
    const label = section === 'view' ? 'View and sort' : allInOne ? 'List settings' : 'Filters';
    const body =
      section === 'view' ? (
        <>
          {viewFacets.length > 0 ? (
            <section className="lp__funnelsection" aria-label="View">
              <div className="t-eyebrow">View</div>
              {viewOptions}
            </section>
          ) : null}
          {current ? (
            <section className="lp__funnelsection" aria-label="Sort">
              <div className="t-eyebrow">Sort</div>
              {sortOptions}
            </section>
          ) : null}
          {linksSection}
        </>
      ) : (
        <>
          {filterSpecs.length > 0 ? (
            <section className="lp__funnelsection" aria-label="Filter">
              <div className="t-eyebrow">Filter</div>
              {filterOptions}
            </section>
          ) : null}
          {people.length > 1 ? (
            <section className="lp__funnelsection" aria-label="People">
              <div className="t-eyebrow">People</div>
              {peopleOptions}
            </section>
          ) : null}
          {membership && membershipSets !== undefined ? (
            <section className="lp__funnelsection" aria-label={membership.label}>
              <div className="t-eyebrow">{membership.label}</div>
              {setsOptions}
            </section>
          ) : null}
          {allInOne && current ? (
            <section className="lp__funnelsection" aria-label="Sort">
              <div className="t-eyebrow">Sort</div>
              {sortOptions}
            </section>
          ) : null}
          {allInOne && groupOptions.length > 1 ? (
            <section className="lp__funnelsection" aria-label="Group by">
              <div className="t-eyebrow">Group by</div>
              {groupOptions.map((option) => {
                const on = listPrefs.groupBy === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={on ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                    data-group-by={option.id}
                    onClick={() => listPrefs.setGroupBy(option.id as ListGroupBy)}
                  >
                    {option.label}
                    {on ? <span className="lp__filtercheck">✓</span> : null}
                  </button>
                );
              })}
            </section>
          ) : null}
          {allInOne && (viewFacets.length > 0 || config.list.tree) ? (
            <section className="lp__funnelsection" aria-label="View">
              <div className="t-eyebrow">View</div>
              {viewOptions}
              {config.list.tree ? (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={listPrefs.subItems}
                  className={listPrefs.subItems ? 'lp__kindopt lp__kindopt--current' : 'lp__kindopt'}
                  data-testid="list-subitems-toggle"
                  onClick={() => listPrefs.setSubItems(!listPrefs.subItems)}
                >
                  <span className="lp__optbox" aria-hidden data-on={listPrefs.subItems ? 'yes' : 'no'} />
                  <span className="lp__optlabel">Show sub-items</span>
                </button>
              ) : null}
            </section>
          ) : null}
          {allInOne ? linksSection : null}
        </>
      );

    return (
      <div className="lp__filterbar lp__filterbar--merged" ref={barRef}>
        <button
          type="button"
          className={section === 'view' ? 'lp__chip lp__chip--icon lp__more' : 'lp__chip lp__chip--icon lp__funnel'}
          onClick={() => setPicker(open ? null : key)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={changed > 0 ? `${label}, ${changed} changed` : label}
          title={label}
          data-testid={section === 'view' ? 'list-more-trigger' : 'filter-trigger'}
        >
          {section === 'view' ? (
            <span className="lp__more-glyph" aria-hidden>⋯</span>
          ) : (
            <VectorIcon paths={glyph === 'settings' ? SETTINGS_MARK : FILTER_MARK} size={16} />
          )}
          {changed > 0 ? <span className="lp__chip-count">{changed}</span> : null}
        </button>
        {narrowing(
          key,
          label,
          section === 'view' ? 'list-more-menu' : 'filter-menu',
          'lp__filtermenu lp__filtermenu--merged lp__filtermenu--withfoot',
          (
            <>
              <div className="lp__filteropts">{body}</div>
              <div className="lp__filterfoot">
                <button
                  type="button"
                  className="lp__filterclear"
                  data-testid={section === 'view' ? 'list-more-clear-all' : 'filter-clear-all'}
                  disabled={changed === 0}
                  onClick={() => {
                    if (section === 'view') {
                      if (hiddenFacetCount > 0 || linkGroupsHidden > 0) view.reset();
                      if (defaultSort && current && current.key !== defaultSort) onSort(defaultSort);
                      return;
                    }
                    for (const { spec, option } of active) onToggleOption(spec.id, option.id, spec.multi ?? false);
                    for (const actorId of selectedPeople) onTogglePerson(actorId);
                    if (lensSet) onLens(null);
                    if (allInOne) {
                      if (hiddenFacetCount > 0 || linkGroupsHidden > 0) view.reset();
                      if (defaultSort && current && current.key !== defaultSort) onSort(defaultSort);
                      if (listPrefs.changed > 0) listPrefs.reset();
                    }
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="lp__filterdone"
                  data-testid={section === 'view' ? 'list-more-done' : 'filter-done'}
                  onClick={() => setPicker(null)}
                >
                  Done
                </button>
              </div>
            </>
          ),
        )}
      </div>
    );
  }

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
          className="lp__chip lp__chip--icon"
          onClick={() => setPicker(picker === 'filters' ? null : 'filters')}
          aria-expanded={picker === 'filters'}
          aria-haspopup="menu"
          aria-label="Filter"
          title="Filter"
          data-testid="filter-trigger"
        >
          <VectorIcon paths={FILTER_MARK} size={15} />
          {activeFilterCount > 0 ? (
            <span className="lp__chip-count">{activeFilterCount}</span>
          ) : null}
        </button>
      ) : null}
      {people.length > 1 ? (
        <button
          type="button"
          className={
            selectedPeople.length > 0
              ? 'lp__chip lp__chip--icon lp__chip--active'
              : 'lp__chip lp__chip--icon'
          }
          onClick={() => setPicker(picker === 'people' ? null : 'people')}
          aria-expanded={picker === 'people'}
          aria-haspopup="menu"
          aria-label="People"
          title="People"
          data-testid="people-filter-trigger"
        >
          <VectorIcon paths={PEOPLE_MARK} size={15} />
          {selectedPeople.length > 0 ? (
            <span className="lp__chip-count">{selectedPeople.length}</span>
          ) : null}
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
            className="lp__chip lp__chip--icon"
            onClick={() => setPicker(picker === 'sets' ? null : 'sets')}
            aria-expanded={picker === 'sets'}
            aria-haspopup="menu"
            aria-label={membership.label}
            title={membership.label}
            data-testid="collection-lens-trigger"
          >
            <VectorIcon paths={SETS_MARK} size={15} />
          </button>
        )
      ) : null}
      {viewFacets.length > 0 ? (
        <button
          type="button"
          className={
            hiddenFacetCount > 0
              ? 'lp__chip lp__chip--icon lp__chip--active'
              : 'lp__chip lp__chip--icon'
          }
          onClick={() => setPicker(picker === 'view' ? null : 'view')}
          aria-expanded={picker === 'view'}
          aria-haspopup="menu"
          title={hiddenFacetCount > 0 ? `Row view: ${hiddenFacetCount} hidden` : 'Choose what each row shows'}
          aria-label="View"
          data-testid="row-view-trigger"
        >
          <VectorIcon paths={VIEW_MARK} size={15} />
          {hiddenFacetCount > 0 ? (
            <span className="lp__chip-count">{hiddenFacetCount}</span>
          ) : null}
        </button>
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
          className="lp__chip lp__chip--icon"
          onClick={() => setPicker(picker === 'sort' ? null : 'sort')}
          aria-expanded={picker === 'sort'}
          aria-haspopup="menu"
          aria-label={`Sort: ${current.label}`}
          title={`Sorted by ${current.label}`}
          data-changed={current.key !== (sort.find((s) => s.default)?.key ?? sort[0]?.key) ? 'true' : undefined}
          data-testid="sort-trigger"
        >
          {/* The current order is named in the title and the open menu's ✓;
              the chip itself is only the glyph. */}
          <VectorIcon paths={SORT_MARK} size={15} />
        </button>
      ) : null}

    </div>
      {narrowing('sort', 'Sort', 'sort-menu', 'lp__filtermenu lp__filtermenu--sort', (
        <>
          <div className="lp__filtergroup">SORT BY</div>
          {sortOptions}
        </>
      ))}
      {/* Rendered OUTSIDE the clipping row, inside the positioned bar: the row
          keeps `overflow: hidden` as its floor guard, and the picker is still
          free to overflow it. No hardcoded offset — `top: 100%` of the bar
          works whether or not this kind renders a header-actions row. */}
      {narrowing('filters', 'Filter', 'filter-menu', 'lp__filtermenu lp__filtermenu--withfoot', (
        <>
          {/* The options scroll; the footer below does not. */}
          <div className="lp__filteropts">
          {filterOptions}
          </div>
          {/* CLEARING WAS ONLY EVER REACHABLE BY HUNTING CHIPS. Every active
              option spawned a dismissable chip in the bar, so undoing four
              filters meant finding and clicking four separate targets that
              MOVED as each one left. One verb clears the set from the surface
              that set it. `Done` only dismisses — it commits nothing, because
              every toggle above already applied; it exists so the menu has an
              obvious way out that is not "click somewhere else". */}
          <div className="lp__filterfoot">
            <button
              type="button"
              className="lp__filterclear"
              data-testid="filter-clear-all"
              disabled={active.length === 0}
              onClick={() => {
                for (const { spec, option } of active) {
                  onToggleOption(spec.id, option.id, spec.multi ?? false);
                }
              }}
            >
              Clear all
            </button>
            <button
              type="button"
              className="lp__filterdone"
              data-testid="filter-done"
              onClick={() => setPicker(null)}
            >
              Done
            </button>
          </div>
        </>
      ))}
      {membership ? narrowing('sets', membership.label, 'collection-lens-menu', 'lp__filtermenu', (
        <>
          <div className="lp__filtergroup">{membership.label.toUpperCase()}</div>
          {setsOptions}
        </>
      )) : null}
      {narrowing('view', 'View', 'row-view-menu', 'lp__filtermenu lp__filtermenu--withfoot', (
        <>
          <div className="lp__filteropts">
            <div className="lp__filtergroup">SHOW ON EACH ROW</div>
          {viewOptions}
          </div>
          <div className="lp__filterfoot">
            <button
              type="button"
              className="lp__filterclear"
              data-testid="row-view-reset"
              disabled={hiddenFacetCount === 0}
              onClick={view.reset}
            >
              Show all
            </button>
            <button
              type="button"
              className="lp__filterdone"
              data-testid="row-view-done"
              onClick={() => setPicker(null)}
            >
              Done
            </button>
          </div>
        </>
      ))}
      {narrowing('people', 'People', 'people-filter-menu', 'lp__filtermenu', (
        <>
          <div className="lp__filtergroup">PEOPLE</div>
          {peopleOptions}
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
          rows.map((row, index) => (
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
              draggable={droppable || undefined}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', row.id);
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(row);
              }}
              onDragEnd={() => onDragStart(null)}
            >
              <Tile row={row} props={props} config={config} />
            </div>
          ))
        )}
      </div>

    </section>
  );
}

// ---------------------------------------------------------------------------
// Bands, trees, tiles
// ---------------------------------------------------------------------------

function Band({
  label,
  filter,
  sort,
  collapsed,
  onToggle,
  props,
  config,
  query,
  tabId = null,
}: {
  /**
   * Spec D1 §5.3: the open tab, for the session tabs' grouping (Running's
   * "Finished, still open" divider, Interrupted's reason groups) and the
   * Running grace (§5.3.1 case 12). Any other tab id renders ungrouped.
   */
  tabId?: string | null;
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
}) {
  const bandAttention = useAttentionOptional();
  /* A row deleted live stays for its exit (R41) — see `useRetainLeaving`. */
  const rows = useRetainLeaving(filter === null ? NO_ROWS : props.rowsFor(filter, sort), rowId);
  const page = filter === null ? undefined : props.pageStateOf?.(filter, sort);
  /* "Needs me" reads LOADING for a bounded time per pulled root; nothing else
     re-renders a quiet list when that time runs out, so wake once then. */
  const [, wake] = useState(0);
  const needsMeLoadingNow = isNeedsMeFilter(filter) && page?.loading === true;
  useEffect(() => {
    if (!needsMeLoadingNow) return;
    const due = needsMeRecheckAt();
    if (due === null) return;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, due - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [needsMeLoadingNow, rows]);
  /* §5.3.1 case 12: a row that just left Running lingers ~10 s. Gated on the
     tab alone ('running' is a session tab id only), not on the rows: gating on
     "every row is a session" switched grace off exactly when the last running
     row left, so that row vanished at once. */
  const graced = useRunningGrace(rows, tabId === 'running');
  const visible = matching(graced, query ?? '');
  const sessionRows = visible.length > 0 && visible.every((r) => isSessionState(r.state));
  const attentionIds = attentionIdsOf(visible, props, config);
  const groups = sessionRows
    ? groupSessionRows(tabId, visible, (r) => r.state, (r) => ({ claims: props.linkedClaimsOf?.(r.id) }))
    : null;
  const bulkGroups = props.onSessionBulk
    ? (groups ?? []).filter((group) => group.label !== null && group.bulk !== null)
    : [];

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
        ) : isNeedsMeFilter(filter) && (!query || query.trim().length === 0) ? (
          /* Attention v2: "Needs me" is the attention queue (needs-me.ts), so
             its empty state is "nothing is waiting on you", not "create one". */
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={
              page?.loading
                ? 'Loading what needs you…'
                : needsMeCount(bandAttention, config.kind) > 0
                  /* The queue names roots this list could not load (deleted,
                     or not readable here). Saying "nothing" would contradict
                     the top bar's count. */
                  ? `${needsMeCount(bandAttention, config.kind)} waiting on you could not be shown here — open them from the top bar.`
                  : 'Nothing needs you.'
            }
          />
        ) : props.renderEmpty ? (
          props.renderEmpty(
            query && query.trim().length > 0
              ? { reason: 'search', query: query.trim() }
              : page?.loading
                ? { reason: 'loading' }
                : { reason: 'empty' },
          )
        ) : query && query.trim().length > 0 ? (
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={`No ${config.labelPlural.toLowerCase()} match “${query.trim()}”. Clear the search to see them all.`}
          />
        ) : (
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={
              config.settingsHome
                ? `No ${config.labelPlural.toLowerCase()} here yet — add them in Settings.`
                : !config.list.quickCreate
                  ? `No ${config.labelPlural.toLowerCase()} here yet.`
                  : `No ${config.labelPlural.toLowerCase()} here yet — create one, or press / and type a name.`
            }
          />
        )
      ) : (
        <>
          {/* THE TREE IS NEVER BROKEN UP (Subhang, 2026-10-17: "the tree
              structure of the sessions should always be maintained"). The
              tab's groups used to render as separate lists — "Finished, still
              open (N)" under Running, one list per reason under Interrupted —
              and a tree only nests a row whose parent is in the SAME list, so
              every group split re-rooted the children it took. The groups now
              keep only their bulk verbs, as a strip above ONE tree; which
              state a row is in is the row's own coloured signal. */}
          {/* A group earns a line only when it carries a verb this host can
              run: a bare "Finished, still open (1)" over one tree reads as a
              header for every row below it. */}
          {bulkGroups.length > 0 ? (
            <div className="lp__sgroups" data-testid="session-groups">
              {bulkGroups.map((group) => (
                <SessionGroupHeader
                  key={group.id}
                  label={group.label!}
                  bulk={group.bulk}
                  ids={group.rows.map((r) => r.id)}
                  onBulk={props.onSessionBulk}
                />
              ))}
            </div>
          ) : null}
          <TreeRows rows={visible} props={props} config={config} attentionIds={attentionIds} />
        </>
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

const BULK_LABEL: Readonly<Record<Exclude<GroupBulk, null>, string>> = {
  'complete-all': 'Complete all',
  'resume-all': 'Resume all',
  'reconnect-resume-all': 'Resume all',
  'stop-all-finished': 'Stop all finished',
};

/**
 * A session tab group's header (Spec D1 §5.3): "Server restart (12)" with its
 * bulk verb. Credentials say "Reconnect, then resume all" — resuming before
 * the credential is back would only fail again.
 */
function SessionGroupHeader({
  label,
  bulk,
  ids,
  onBulk,
}: {
  label: string;
  bulk: GroupBulk;
  ids: readonly string[];
  onBulk?: (bulk: GroupBulk, ids: readonly string[]) => void;
}) {
  return (
    <div className="lp__sgroup" data-testid="session-group" data-bulk={bulk ?? undefined}>
      <span>{label}</span>
      {bulk === 'reconnect-resume-all' ? (
        <span className="lp__sgroup-hint">Reconnect the credential in Settings, then</span>
      ) : null}
      {bulk && onBulk ? (
        <button
          type="button"
          className="lp__sgroup-bulk"
          data-testid="session-group-bulk"
          onClick={() => onBulk(bulk, ids)}
        >
          {BULK_LABEL[bulk]}
        </button>
      ) : null}
    </div>
  );
}

/** Spec D1 §5.3.1 case 7 — what a session row needs to name a parent in another tab. */
interface SessionCrumbs {
  tabId: string | null;
  rowOf: (id: string) => EntitySummary | undefined;
}

const SessionCrumbContext = createContext<SessionCrumbs | null>(null);

/**
 * Every session row loaded under any of this panel's tabs, by id. Reads the
 * same filters the tab counts read (so it asks the store nothing new), and
 * only for a tab row whose rows are sessions.
 */
function useSessionCrumbs(props: EntityListPanelProps, config: KindConfig, tabId: string | null): SessionCrumbs | null {
  const tabs = config.list.categories ?? [];
  const index = new Map<string, EntitySummary>();
  for (const tab of tabs) {
    const merged = bandFilter(tab.filter, tab, {}, config, props.ctx);
    if (merged === null) continue;
    for (const row of props.rowsFor(merged)) {
      if (!isSessionState(row.state)) return null;
      index.set(row.id, row);
    }
  }
  if (index.size === 0) return null;
  return { tabId, rowOf: (id) => index.get(id) };
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
  rows: listRows,
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
  /* THE ROWS THESE ROWS LAUNCHED (331): a chat's sessions, loaded for the
     listed launchers and nested under them by `treeParentOf`. */
  const launches = config.list.tree ? config.list.launches : undefined;
  const launchedFilter = useMemo(
    () => (launches ? launchedRowsFilter(listRows.map((row) => row.id)) : null),
    [launches, listRows],
  );
  const launched =
    launches && launchedFilter && props.rowsForKind
      ? props.rowsForKind(launches)(launchedFilter as QueryFilter)
      : NO_ROWS;
  const rows = useMemo(
    () => (launched.length === 0 ? listRows : [...listRows, ...launched.filter((row) => !listRows.some((r) => r.id === row.id))]),
    [listRows, launched],
  );
  const revealed = useMemo(() => ancestorPath(rows, props.selectedId), [rows, props.selectedId]);
  const leadMode = props.rowLead === 'icon';
  const disclosure = useTreeDisclosure(
    `list:${config.kind}`,
    revealed,
    leadMode ? { latchReveal: true } : undefined,
  );

  /* The pinned-only rail's list settings (`list-prefs.ts`): sub-items hidden ⇒
     the roots alone, flat; Group by ⇒ the roots under one heading per group.
     Every other host keeps the tree exactly as before. */
  const listPrefs = useListPrefs(config.kind);
  const inlinePrefs = Boolean(props.toolbarInline);
  const showSubItems = !inlinePrefs || listPrefs.subItems;
  const groupBy: ListGroupBy = inlinePrefs ? listPrefs.groupBy : 'none';
  const shownRows = useMemo(() => (showSubItems ? rows : rootsOnly(rows)), [rows, showSubItems]);
  const roots = useMemo(
    () => buildTileTree(shownRows, Boolean(config.list.tree) && showSubItems),
    [shownRows, config.list.tree, showSubItems],
  );
  const groups = useMemo(() => {
    if (groupBy === 'none') return null;
    const byKey = new Map<string, { key: string; label: string; rank: number; nodes: TileTreeNode[] }>();
    for (const node of roots) {
      const group = groupOf(node.row, groupBy);
      const entry = byKey.get(group.key) ?? { ...group, nodes: [] };
      entry.nodes.push(node);
      byKey.set(group.key, entry);
    }
    return [...byKey.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  }, [roots, groupBy]);

  /**
   * Live session traffic — delegation, completion and messages — resolved
   * against THIS tree's current shape. Recomputed
   * when the tree or the disclosure state changes, because a route is only true
   * for the arrangement that was on screen when it was drawn — collapsing a
   * subtree mid-flight must re-aim the pulse at the ancestor now standing in
   * for it. `isExpanded` (not the raw set) is what is passed, so a row revealed
   * by the selection routes as the open row it is drawn as.
   */
  const pulse = useMemo(
    () => resolvePulses(shownRows, disclosure.isExpanded, props.messagePulses, config),
    [shownRows, disclosure, props.messagePulses, config],
  );

  const renderNode = (node: TileTreeNode): React.ReactNode => {
    const isCollapsed = !disclosure.isExpanded(node.row.id);
    const hasChildren = node.children.length > 0;
    /* rowLead="icon": the tree item itself takes the keys — Right opens,
       Left shuts or moves to the parent, Enter opens the row. The innermost
       item handles a key and stops it, so an ancestor never acts twice. */
    const onTreeKey =
      leadMode && config.list.tree
        ? (event: React.KeyboardEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement;
            if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
            if (event.key === 'ArrowRight') {
              if (hasChildren && isCollapsed) disclosure.toggle(node.row.id);
            } else if (event.key === 'ArrowLeft') {
              if (hasChildren && !isCollapsed) disclosure.toggle(node.row.id);
              else event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
            } else if (event.key === 'Enter') {
              if (target !== event.currentTarget && !target.hasAttribute('data-lead-toggle')) return;
              selectRow(props, node.row);
            } else {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
          }
        : undefined;
    const wire = pulse.segments.get(node.row.id);
    const endpoint = pulse.endpoints.get(node.row.id);
    return (
      <div
        key={node.row.id}
        className="lp__branch"
        role={config.list.tree ? 'treeitem' : 'listitem'}
        aria-expanded={config.list.tree && hasChildren ? !isCollapsed : undefined}
        aria-selected={config.list.tree ? props.selectedId === node.row.id : undefined}
        tabIndex={onTreeKey ? -1 : undefined}
        onKeyDown={onTreeKey}
        /* Presentation only. The underlying event is already represented by
           the rows it changes; narrating the same transition from a decorative
           wire would duplicate announcements. */
        data-pulse-row={endpoint?.role}
        data-pulse-kind={endpoint?.kind}
        data-pulse-outcome={endpoint?.outcome}
      >
        <Tile
          row={node.row}
          depth={node.depth}
          props={props}
          /* A launched row (a chat's session) is drawn as ITS kind. */
          config={node.row.kind === config.kind ? config : getKind(node.row.kind)}
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
            data-pulse-kind={wire?.kind}
            data-pulse-outcome={wire?.outcome}
            style={wire ? ({
              '--lp-pulse-delay': wire.order === 0
                ? '0ms'
                : `calc(var(--pn-dur-fast) * ${wire.order})`,
            } as React.CSSProperties) : undefined}
          >
            {node.children.map(renderNode)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={treeClass(config)} role={config.list.tree ? 'tree' : 'list'}>
      {groups
        ? groups.map((group) => (
            <div key={group.key} className="lp__group" role="group" aria-label={group.label} data-testid="list-group">
              <div className="lp__grouphead" aria-hidden>
                <span className="lp__groupname">{group.label}</span>
                <span className="lp__groupcount">{group.nodes.length}</span>
              </div>
              {group.nodes.map(renderNode)}
            </div>
          ))
        : roots.map(renderNode)}
      {/* LAST, and out of flow. The layer measures against this container, so
          it must be a child of it; rendering it after the rows keeps it above
          them without a stacking context that would trap the row menus.
 */}
      {pulse.flights.length > 0 ? <TileFlightLayer flights={pulse.flights} /> : null}
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
/**
 * Opens a row. A row of ANOTHER kind than the list's (a chat's launched
 * session, 331) names its kind, so the host opens it as what it is; a row of
 * the list's own kind is opened by id alone, as it always was.
 */
function selectRow(props: EntityListPanelProps, row: EntitySummary): void {
  if (row.kind === props.kind) props.onSelect?.(row.id);
  else props.onSelect?.(row.id, row.kind);
}

function buildTileTree(rows: readonly EntitySummary[], hierarchical: boolean): TileTreeNode[] {
  if (!hierarchical) return rows.map((row) => ({ row, children: [], depth: 0 }));

  const present = new Set(rows.map((row) => row.id));
  const childrenOf = new Map<string | null, EntitySummary[]>();
  for (const row of rows) {
    // 330: a session nests under its launcher (`launched_by`), not a parent.
    const up = treeParentOf(row);
    const parent = up && present.has(up) ? up : null;
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
  segments: ReadonlyMap<string, {
    direction: PulseSegment['direction'];
    order: number;
    kind: SessionPulseKind;
    outcome?: 'exited' | 'failed';
  }>;
  /** Row → its part in a pulse, for the endpoint glow. */
  endpoints: ReadonlyMap<string, {
    role: 'from' | 'to';
    kind: SessionPulseKind;
    outcome?: 'exited' | 'failed';
  }>;
  /**
   * Arrivals with BOTH ends on a drawn row, for the glyph that flies between
   * them. A pulse appears here in addition to — never instead of — its wire
   * segments: the sweep is what survives `prefers-reduced-motion`, and it is
   * also the only half that tells the routing story the flight arc declines to
   * tell (see `tile-flight.ts`). One arrival, two complementary readings.
   */
  flights: readonly ResolvedFlight[];
}

const NO_FLIGHTS: readonly ResolvedFlight[] = Object.freeze([]);
const NO_PULSES: ResolvedPulses = {
  segments: new Map(),
  endpoints: new Map(),
  flights: NO_FLIGHTS,
};

/**
 * Turns live arrivals into per-node presentation, against the tree as it is
 * currently arranged.
 *
 * The binding is checked here and nowhere else: a list whose registry row does
 * not ask for `messagePulse` resolves to nothing, so this cannot animate a tree
 * that never opted in. Same shape as `tile.pulse` — data decides, not the kind.
 *
 * When several arrivals are in flight at once their routes are merged. A
 * contested wire keeps the newest pulse, so its colour AND its physical form
 * agree instead of combining two kinds into a fourth visual vocabulary.
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
    rows.map((row) => {
      const up = treeParentOf(row);
      return [row.id, up && present.has(up) ? up : null];
    }),
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

  const segments = new Map<string, {
    direction: PulseSegment['direction'];
    order: number;
    kind: SessionPulseKind;
    outcome?: 'exited' | 'failed';
  }>();
  const endpoints = new Map<string, {
    role: 'from' | 'to';
    kind: SessionPulseKind;
    outcome?: 'exited' | 'failed';
  }>();
  const flights: ResolvedFlight[] = [];
  for (const item of pulses) {
    const route = routeMessagePulse(item.fromId, item.toId, index);
    route.segments.forEach((segment, order) => {
      segments.set(segment.ownerId, {
        direction: segment.direction,
        order,
        kind: item.kind,
        ...(item.kind === 'completion' ? { outcome: item.outcome } : {}),
      });
    });
    // Arrival wins a contested row: a session that both sends and receives in
    // the same window is more interesting as a destination.
    const endpoint = {
      kind: item.kind,
      ...(item.kind === 'completion' ? { outcome: item.outcome } : {}),
    };
    if (route.fromRowId !== null && !endpoints.has(route.fromRowId)) {
      endpoints.set(route.fromRowId, { role: 'from', ...endpoint });
    }
    if (route.toRowId !== null) endpoints.set(route.toRowId, { role: 'to', ...endpoint });
    // A flight needs a takeoff AND a landing, and they must be different
    // rows. Same row means one collapsed subtree absorbed both ends: the
    // traffic was internal to something the viewer has closed, and the row's
    // own glow already says "in there" better than a glyph orbiting one tile.
    if (
      route.fromRowId !== null
      && route.toRowId !== null
      && route.fromRowId !== route.toRowId
    ) {
      flights.push({
        key: item.key,
        kind: item.kind,
        ...(item.kind === 'completion' ? { outcome: item.outcome } : {}),
        ...(item.at === undefined ? {} : { at: item.at }),
        fromRowId: route.fromRowId,
        toRowId: route.toRowId,
      });
    }
  }
  return {
    segments,
    endpoints,
    flights: flights.length === 0 ? NO_FLIGHTS : flights,
  };
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
  const { oneSurface } = useMobileSurface();
  const glow = useFreshGlow(row.id);
  const crumbs = useContext(SessionCrumbContext);
  /* Attention v2 (chapter 4): a CHIP replaces the words "Needs attention".
     `attention` also carries a kind's derived predicate (session liveness),
     which has no request behind it and keeps the old label. With the store
     above, a badge it has since seen settled no longer tints the tile. */
  const attentionApi = useAttentionOptional();
  const chip = useEntityChip(row);
  const flagged = attentionApi ? chip != null || (attention && !row.badges.attention) : attention;
  const chipView = chip ? <AttentionChipView chip={chip} /> : null;
  const list = config.list;
  /* The kind's own done-of-total figure, if it declares one (story: tasks). */
  const progress = list.tile.progress?.(row) ?? null;
  const controlCard = list.tile.anatomy === 'control-card';
  const sessionTree = list.tile.anatomy === 'session-tree';
  /* The viewer's View choice for THIS row's kind (row-view.ts, now reached
     through the list header's `⋯`) — a session nested under a task follows
     the Sessions list's choice. */
  const view = useRowView(config.kind);
  /* Forms this session asked the viewer to answer (decision 11). One batched
     read serves every tile in the list — see `forms/pending.ts`.
     It feeds the WAITING state two ways, and both survive the cut: the row's
     own word (`sessionRowWord`, below) and — on a standard row — the waiting
     ring that is the session's one signal.
     THE CHIP SURVIVES TOO, and that is a judgment worth stating. §6's cut list
     is a list of FACTS about an entity (its model, its lane, its tallies);
     "two forms are waiting on YOU" is a REQUEST, which is the same category as
     the attention chip §6 keeps, and it is the only place a queued answer is
     said at all. Its `forms` SWITCH is gone with the rest of them — a request
     is not a facet you turn off. */
  const pendingFormsRead = usePendingForms(sessionTree ? row.id : null);
  const verdict = props.livenessOf?.(row.id);
  /* ATTENTION v2 (F1, tab 4-5): the subtitle under the chip — a session or
     chat's `waiting on you: …`, a roll-up root's `n requests · own, via …`.
     Null outside an attention module. */
  const attentionLine = attentionTileLine(
    attentionApi,
    row,
    verdict === 'not-running' || verdict === 'stale',
  );
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
  /** The `⋯` row menu (§6). Row-local for the same reason `flowRef` is. */
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  /** Bounds for the expand's outside-click dismissal — the trigger lives here too. */
  const tileRef = useRef<HTMLDivElement>(null);
  /* The ⋯ menu closes on a pointer outside this tile. Same hook the filter
     popover uses, so one dismissal rule serves both. */
  useDismissable(rowMenuOpen, tileRef, useCallback(() => setRowMenuOpen(false), []));

  /**
   * NO RELATION ACCORDION ANY MORE (ruling 2026-10-16, message 01a14695-6b54).
   *
   * A tile used to open the linked entities of one kind INLINE under the row.
   * Three things were wrong with it and only the third is obvious once the row
   * is quiet: a list whose rows grow other rows cannot be scanned, its height
   * depends on its graph rather than on its population, and every chip that
   * opened one was a second meaning for a click on a number. The counts line
   * replaces all of it — `§6`: "clicking a count opens THAT GROUP IN THE
   * DETAIL PANEL, never inline under the row".
   *
   * What left with it: `openRelation`, `toggleRelation`, `countedRelationOf`,
   * the `RelatedGroup` block, the leading sessions chip, the PR chips and the
   * worktree door. `props.connectionsOf` is still read by the control strip
   * inside an EXPANDED row, which is a surface with room for the graph.
   */

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
   *
   * WHAT `completed` MAY NO LONGER DO IS PAINT A COMPLETION MARK. `done` is
   * the server's RESOLUTION predicate and not a lifecycle position:
   * `db/migrations/152_universal_status.sql` seeds the FACT KINDS — commit,
   * message, file, memory, artifact — into `done` on purpose, so that a fact
   * about the past cannot block a `depends_on` forever, and its header says
   * so. Reading it as "this finished" struck through every row of the
   * Artifacts, Memories, Files, Messages and Commits lists. The strikethrough
   * is therefore gone from the list for EVERY kind, tasks included (the status
   * chip, the dot and the Done tab already carry completion); `--archived`
   * stays, because archived and completed are still two facts (C2).
   *
   * `completed` survives as a computed fact because the SESSION tile still
   * consumes it — for a `done` text tag, not a strikethrough, and no fact kind
   * renders as a session.
   */
  const archived = row.deletedAt != null;
  const completed = row.category === 'done';
  const controlExpanded = controlCard && (detailsExpanded || flowRef !== null);
  const controlFacts = controlCard ? factsForControlCard(row) : null;
  /**
   * THE COUNTS LINE — the row's only second line, and the only thing left of
   * the badge sub-row (§6; `domain/tile-counts.ts` owns the five groups and
   * their order). Asked BEFORE the element is built: a JSX element is truthy
   * even when it renders null, and whether this row is 29px or ~43px tall
   * depends on the answer.
   *
   * `view.shows('counts')` is the viewer's switch for it; the groups whose
   * counters the server does not send yet simply are not in it, so a node that
   * predates task 01a14655-e507 draws the docs and memories it does count and
   * nothing where it counts nothing.
   */
  /* The per-link switches (List settings): a group the viewer turned off is
     not drawn, and a row whose only counts are hidden ones has no line. */
  const hiddenGroups = hiddenLinkGroups(view.hidden);
  const showCounts = view.shows('counts') && hasTileLinkCounts(row.counters, hiddenGroups);
  const countsLine = showCounts ? (
    <TileLinkCounts
      counters={row.counters}
      entityId={row.id}
      hiddenGroups={hiddenGroups}
      {...(props.onOpenLinks ? { onOpenGroup: props.onOpenLinks } : {})}
    />
  ) : null;

  /**
   * THE PROGRESS METER, AND WHEN A TASK HAS ONE (§6; QA finding 3, ruled
   * 2026-10-17). A meter is a statement about a subtree, so it is drawn only
   * where there is one: `childCount` is the `▸ N` chip's own number, which
   * keeps the chip and the meter one answer. The View switch still governs —
   * a viewer who turned progress off sees none either way.
   *
   * Narrowed to the figure itself rather than left a boolean so the slot below
   * can hand it straight to `TileProgressBar` without re-testing `progress`.
   */
  const progressShown = progress !== null && view.shows('progress') && childCount > 0 ? progress : null;

  /**
   * THE ONE SIGNAL, and the kind's own declaration of which it is
   * (`list.tile.signal`). The avatar shape is drawn from the `avatar` slot the
   * badge sources already resolved — see `TileSignal`'s header for why it is
   * not re-derived in there.
   */
  const signalSpec = list.tile.signal;
  const signalAvatar = signalIsAvatar(signalSpec) && avatar != null && view.shows('avatar');
  const urgent = isUrgent(row);

  /* rowLead="icon": one leading icon replaces the chevron and the status mark. */
  const leadMode = props.rowLead === 'icon';
  const leadIcon = (
    <ToneKindIcon
      kind={row.kind}
      tone={statusWord ? statusTone : null}
      hollow={Boolean(statusWord) && statusHollow}
      streaming={streaming}
    />
  );
  const lead = leadMode ? (
    <RowLead
      icon={leadIcon}
      rowTitle={row.title}
      tooltip={leadTooltip(statusTitle, getKind(row.kind).label)}
      childCount={childCount}
      expanded={expanded}
      onToggle={onToggleChildren}
    />
  ) : null;
  /**
   * THE SAME ICON, WITHOUT THE TOGGLE — for the standard anatomy only.
   *
   * §6 moves the children onto a `▸ N` chip after the title and makes THAT
   * the disclosure. On the Workspace browser the lead icon was already a
   * disclosure, so drawing both would put two controls with the same
   * accessible name ("Expand Parent, 2 children") on one row — the exact
   * ambiguity `lp__rowaction--ind`'s comment warns about one slot over.
   *
   * USED BY THE STANDARD TILE AND THE CONTROL CARD, which both moved their
   * disclosure onto the chip. `MaestroSessionTile` is the one anatomy that
   * keeps the lead as its control: a session's sub-session count rides the
   * agent mark, which §6 keeps as "the session glyph tinted by its state", and
   * rebuilding that tree's grammar was not asked for. The difference is real
   * and named rather than hidden — see the close-out on 01a1469f.
   */
  const leadQuiet = leadMode ? (
    <RowLead
      icon={leadIcon}
      rowTitle={row.title}
      tooltip={leadTooltip(statusTitle, getKind(row.kind).label)}
      childCount={0}
      expanded={expanded}
    />
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
    /* THE PERSONA STAYS, and that is a reading of §6 worth stating. The cut
       list names the "agent tool"; it does not name the face. On this anatomy
       the face IS the kind glyph — `AgentTile` draws the teammate inside the
       tool mark, tinted by state — which is exactly what §6 keeps ("the
       session glyph tinted by its state"). Nulling it would make every agent
       session look like a bare terminal, which is the defect
       `MaestroSessionTile`'s own header records as already fixed once. What
       went is the MODEL NAME beside it, which is a word, not a glyph. */
    const teammate = actorSummaryOrNull(state.teammate);
    const live = verdict === 'live';
    /* SPEC D1 §5.1/§5.2: the row word, its line 2 and the avatar's process
       dot, from the outcome × process derivation every session surface shares.
       Waiting = an idle process with forms pending for the viewer (§5.1 row 3). */
    const wordCtx = {
      claims: props.linkedClaimsOf?.(row.id),
      // §6.3 R1 / scenario 16: offered tasks are on the row, never claims.
      offered: offeredCountOf(row.state),
      streaming,
      waiting: recordedStatus === 'idle' && pendingFormsRead !== null,
      activityAt: row.activityAt,
      actorName: (id: string) => props.members?.find((m) => m.id === id)?.displayName,
    };
    const sessionWord = sessionRowWord(row.state, verdict, wordCtx);
    const lineTwo = sessionLineTwo(row.state, verdict, wordCtx);
    const launcher = treeParentOf(row);
    const crumb = crumbs && launcher && depth === 0
      ? crossTabBreadcrumb(crumbs.rowOf(launcher), crumbs.tabId)
      : null;
    return (
      <MaestroSessionTile
        leadMode={leadMode}
        id={row.id}
        title={row.title || 'Session'}
        agentTool={agentTool}
        sessionKind={sessionKind}
        teammate={teammate}
        /* The model name is cut (§6). The prop stays because `MaestroSessionTile`
           is also the EXPANDED row, and null is how that is said here. */
        model={null}
        status={recordedStatus}
        attention={flagged}
        attentionChip={chipView}
        attentionTone={chip?.tone}
        selected={selected}
        archived={archived}
        completed={completed}
        live={live}
        streaming={streaming}
        statusTone={statusTone}
        statusTitle={statusTitle}
        word={sessionWord}
        lineTwo={lineTwo}
        crumb={crumb}
        /* The quiet row's three slots, same three the other two anatomies get
           (§6; coordinator ruling 2026-10-17). The signal is built from the
           WORD's own derivation rather than from the verdict again — see
           `TileSignal` — so the mark and the word can never disagree. */
        signal={
          sessionWord ? (
            <TileSignal
              row={row}
              spec={list.tile.signal}
              session={{
                icon: sessionWord.icon,
                tone: sessionWord.tone,
                label: sessionWord.word,
                reason: sessionWord.reason,
                streaming,
                case: sessionWord.case,
              }}
            />
          ) : undefined
        }
        time={<Timestamp className="lp__time" at={row.activityAt} title="last activity" />}
        rowMenu={(verbs) => (
          <span className="lp__rowmenu" data-open={rowMenuOpen ? 'true' : undefined}>
            <button
              type="button"
              className="lp__rowmenu-trigger"
              title="Row actions"
              aria-label={`Actions for ${row.title}`}
              aria-expanded={rowMenuOpen}
              aria-haspopup="menu"
              data-testid="row-menu-trigger"
              onClick={(event) => {
                event.stopPropagation();
                setRowMenuOpen((open) => !open);
              }}
            >
              <span aria-hidden>⋯</span>
            </button>
            <span
              className="lp__rowmenu-pop lp__cluster"
              role="menu"
              data-testid="row-menu"
              onClick={(event) => event.stopPropagation()}
            >
              {verbs}
            </span>
          </span>
        )}
        /* The lane line is cut from the collapsed row (§6: the branch and the
           worktree are detail-panel facts) and so is its worktree door, which
           was the last of the inline relation accordion on this anatomy. */
        badges={attentionLine || countsLine || hasPendingFormsChip(pendingFormsRead) ? (
          <>
            <AttentionTileSubtitle line={attentionLine} />
            <PendingFormsChip pending={pendingFormsRead} />
            {countsLine}
          </>
        ) : null}
        childCount={childCount}
        childrenExpanded={expanded}
        onToggleChildren={onToggleChildren}
        onSelect={() => selectRow(props, row)}
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
        /* THE EXPANDED SESSION — its own facts, then the D67 strip (compact
           chips) for state and archive. Linked tasks are path-suppressed as
           before: a session expanded under a task must not offer that task
           back. Links are drawn whatever the View's counts switch says: the
           switch thins the COLLAPSED row, and an expanded row is asking. */
        detail={
          <SessionDetails
            id={row.id}
            state={row.state}
            word={sessionWord}
            tasks={(props.linkedTasksOf?.(row.id) ?? []).filter((task) => !(path?.has(task.id) ?? false))}
            links={hasTileLinkCounts(row.counters) ? (
              <TileLinkCounts
                counters={row.counters}
                entityId={row.id}
                {...(props.onOpenLinks ? { onOpenGroup: props.onOpenLinks } : {})}
              />
            ) : null}
            {...(props.onSelect ? { onOpenTask: props.onSelect } : {})}
            controls={<EntityControlStrip row={row} props={props} config={config} variant="chips" omitArchive={oneSurface} />}
          />
        }
      />
    );
  }

  if (controlCard && controlFacts) {
    return (
      <MaestroTaskTile
        /* `leadQuiet`, NOT `lead`: the ▸ N chip is this row's disclosure now,
           so the lead must stop being a second one AND stop drawing the count
           on its corner. Caught in a screenshot — the number rendered twice,
           once as a circled subscript on the icon and once in the chip, which
           no jsdom assertion could see. */
        lead={leadQuiet ?? undefined}
        rootRef={tileRef}
        id={row.id}
        title={row.title}
        depth={depth}
        selected={selected}
        attention={flagged}
        attentionReason={row.badges.attention?.latestReason}
        attentionChip={chipView}
        attentionTone={chip?.tone}
        archived={archived}
        childCount={childCount}
        childrenExpanded={expanded}
        onToggleChildren={onToggleChildren}
        onSelect={() => selectRow(props, row)}
        status={{
          label: statusWord ?? 'no status',
          title: statusTitle,
          tone: statusTone,
          hollow: statusHollow,
          streaming,
        }}
        /* The quiet row's three slots (§6), identical to the standard tile's
           — one answer to "what does a row show", drawn by two anatomies. */
        urgent={urgent ? <UrgentMark title={row.title} /> : undefined}
        time={<Timestamp className="lp__time" at={row.activityAt} title="last activity" />}
        rowMenu={
          <span className="lp__rowmenu" data-open={rowMenuOpen ? 'true' : undefined}>
            <button
              type="button"
              /* NOT `lp__rowaction`: that class means A ROW VERB, and the R5 #9 test
                 reads it to assert that every live one is a launch verb. This is
                 a DOOR onto the verbs, which is a different thing, so it carries
                 its own class and its own rule. */
              className="lp__rowmenu-trigger"
              title="Row actions"
              aria-label={`Actions for ${row.title}`}
              aria-expanded={rowMenuOpen}
              aria-haspopup="menu"
              data-testid="row-menu-trigger"
              onClick={(event) => {
                event.stopPropagation();
                setRowMenuOpen((open) => !open);
              }}
            >
              <span aria-hidden>⋯</span>
            </button>
            {/* The verbs live BEHIND the trigger here too, so the two
                anatomies answer "where are a row's verbs" the same way. The
                details opener stays in `pn-tt__actions` below, where it has
                always been — the opener belongs to the row, not to the menu. */}
            <span
              className="lp__rowmenu-pop lp__cluster"
              role="menu"
              data-testid="row-menu"
              onClick={(event) => event.stopPropagation()}
            >
              <RowActionCluster
                row={row}
                props={props}
                config={config}
                openFlow={flowRef}
                onFlow={setFlowRef}
                onOpenLaunch={props.launch?.onFullOptions}
              />
            </span>
          </span>
        }
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
        assignees={view.shows('avatar') ? controlFacts.assignees : EMPTY_MEMBERS}
        creator={view.shows('avatar') ? controlFacts.creator : null}
        /* No attention roll-up line here: the chip on the title row already
           says it, and the criteria count rides the progress bar alone. */
        /*
         * LINE 2 EXISTS ONLY WHEN SOMETHING IS ON IT (§6; QA finding 3, ruled
         * 2026-10-17). `badges` IS the second line — a non-null value is a
         * `pn-tt__badges` band under the title — so the condition here is the
         * row's height.
         *
         * `progress` is non-null for EVERY task: `taskTileProgress` returns a
         * figure as soon as the summary carries a percent, which it does for a
         * leaf with nothing in it. So this slot used to be non-null on every
         * task row and every one of them drew a `0%` meter on a second line.
         * A leaf task with no counts measured 49.4px where §6 asks for 30.
         *
         * `progressShown` adds the fact that makes a meter mean something:
         * SUBTASKS. `childCount` is the same number the `▸ N` chip draws, so
         * the meter and the chip appear and disappear together — a row that
         * says it has children is the row that says how far they have got. A
         * leaf task's own acceptance figure goes with it, which is §6's call:
         * the anatomy lists counts as the one second-row fact.
         */
        badges={countsLine || progressShown ? (
          <>
            {/* 307: the task's weighted progress, as the standard tile draws it.
                FIRST, before the counts: the count set varies row to row, so a
                bar drawn after it starts at a different x on every task and
                the column cannot be scanned. Leading, it lines up. */}
            {progressShown ? <TileProgressBar progress={progressShown} /> : null}
            {countsLine}
          </>
        ) : null}
        /* NULL ON PURPOSE: the cluster moved behind the `⋯` above (§6), so
           `pn-tt__actions` holds only the details opener. The slot stays in
           `MaestroTaskTile`'s type because it is also the phone's path — see
           its `oneSurface` branch — and because a host that wants the verbs in
           the row rather than behind a door should be able to say so. */
        actions={null}
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
        <EntityControlStrip row={row} props={props} config={config} variant="chips" collapseEmptyDates={oneSurface} omitArchive={oneSurface} />

        {flowRef ? (
          <div className="lp__flow lp__flow--control">
            <LaunchComposerPopup
              subject={row}
              key={flowRef}
              verbLabel={resolveAction(flowRef).label}
              {...(resolveAction(flowRef).launchMode
                ? { mode: resolveAction(flowRef).launchMode }
                : {})}
              spaceId={props.launch?.spaceId ?? props.ctx.spaceId ?? ''}
              teammates={props.launch?.teammates ?? []}
              projects={props.launch?.projects ?? []}
              capacity={props.launch?.capacity}
              jev={props.launch?.jev}
              loadInstalledPlugins={props.launch?.loadInstalledPlugins}
              selection={props.launch?.selection}
              profileFor={props.launch?.profileFor}
              upload={props.launch?.upload}
              onDispatch={props.launch?.dispatch ? (note, key) => props.launch!.dispatch!(row.id, note, key) : undefined}
              jevKeyStatus={props.launch?.jevKeyStatus}
              sessionsSince={props.launch?.sessionsSince}
              onSpawn={props.launch?.onSpawn}
              loadDescription={
                props.launch?.descriptionOf
                  ? () => props.launch!.descriptionOf!(row.id)
                  : undefined
              }
              canEditSubject={Boolean(props.launch?.onUpdateEntity)}
              onDismiss={() => setFlowRef(null)}
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
    );
  }

  return (
    <div
      {...glow.attrs}
      ref={tileRef}
      className={[
        'lp__tile',
        selected ? 'lp__tile--selected' : '',
        flagged ? 'lp__tile--attention' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-attention-tone={chip?.tone}
      data-testid="list-tile"
      /* The session anatomy publishes `data-session-node`; this is the same
         identity on the default one, so `TileFlightLayer` can find either
         tile without a ref registry threaded through every row. */
      data-flight-anchor={row.id}
      data-depth={depth}
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
      <div className="lp__tile-main" onClick={() => selectRow(props, row)}>
        {/*
          LINE 1 OF THE QUIET ROW (§6, approved 2026-10-16):

              [status mark]  Title ……  [▸ N]  [one signal]  [time]

          and nothing else. What used to sit between the title and the right
          edge — the mono meta strip (model, agent tool, share and drive mode,
          axes, due date), the priority tag, the status WORD as a pill, the
          sessions chip, the PR chips and the message tallies — is gone, not
          switched off. Seven facts competing for one line is why no reader
          could find the one that had changed.

          THE STATUS WORD IS NOT LOST, IT IS UNDRAWN. The mark keeps it in
          `title` and in screen-reader text, so "colour and glyph only" costs
          a sighted reader a hover and costs a screen-reader user nothing.
        */}
        <div className="lp__row1">
          {leadQuiet ?? (
          <span
            className={`lp__statusmark lp__statusmark--${statusTone}`}
            title={statusTitle}
          >
            {statusWord ? (
              <span
                aria-hidden
                className={[
                  'lp__dot',
                  `lp__dot--${statusTone}`,
                  statusHollow ? 'lp__dot--hollow' : '',
                  streaming ? 'lp__dot--pulse' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            ) : (
              <span className="lp__kindmark" aria-hidden><KindIcon kind={config.kind} /></span>
            )}
            {/* THE WORD, FOR A READER WHO CANNOT SEE THE COLOUR. The mark used
                to be `aria-hidden` wholesale, which was honest while a status
                PILL spelt the word out two slots to the right. With the pill
                cut, hiding this would delete the status from the accessible
                row entirely — the one thing §6 says to keep. */}
            {statusWord ? <span className="sr-only">{statusWord}</span> : null}
          </span>
          )}

          {urgent ? <UrgentMark title={row.title} /> : null}

          <button
            type="button"
            className={[
              'lp__title',
              /* ONE fact, one class. `--archived` dims (this row was FILED
                 AWAY) and is fed by `deletedAt` alone — C2, and the reason it
                 was split off a single `--done` class that `deletedAt` used to
                 drive. There is no longer a `--completed` sibling: it struck
                 the title through from `category === 'done'`, which is the
                 server's RESOLUTION predicate and which every fact kind is
                 seeded into, so the Artifacts list rendered twelve of twelve
                 titles as completed work. Completion is said by the status dot
                 and the Done tab instead. */
              archived ? 'lp__title--archived' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={row.title}
            aria-current={selected ? 'true' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              selectRow(props, row);
            }}
          >
            {row.title}
            {glow.srSuffix ? <span className="sr-only">{glow.srSuffix}</span> : null}
          </button>

          {/* ▸ N — THE CHILDREN, COLLAPSED, AFTER THE TITLE (§6). It is the
              disclosure now, and the only one: the count used to ride the
              leading mark's corner as a decorative subscript while a separate
              chevron did the folding, so the number and the control that
              changed it were in two places and neither said what the other
              did. → / ← still fold from the keyboard (`useListCursor` reads
              `aria-expanded`), which is why this is a real button with a real
              expanded state rather than a styled span. */}
          {childCount > 0 && onToggleChildren ? (
            <button
              type="button"
              className={expanded ? 'lp__kidchip lp__kidchip--expanded' : 'lp__kidchip'}
              data-testid="child-count"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.title}, ${childCount} ${childCount === 1 ? 'child' : 'children'}`}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggleChildren();
              }}
            >
              <span className="lp__kidchip-arrow" aria-hidden><TileChevron /></span>
              {childCount > 99 ? '99+' : childCount}
            </button>
          ) : null}

          {/* THE ONE SIGNAL. For task and PR that is the assignee avatar, which
              is why it is drawn from the `avatar` slot the badge sources already
              resolved rather than a second read of the same actor; every other
              shape comes from `TileSignal`. 15, not 20 — 17px is the tallest
              thing a session row contains and therefore the height of every row
              in every list. */}
          <span className="lp__signalslot">
            {signalAvatar && avatar ? (
              <Avatar actorId={avatar.actorId} provenance={avatar.provenance} label={avatar.label} size={15} src={avatar.src ?? null} />
            ) : (
              <TileSignal row={row} spec={signalSpec} />
            )}
          </span>

          {/* THE RIGHT-HAND SLOT, still `lp__badges`, and down from four
              occupants to two. The STATUS WORD pill left it (§6: colour and
              glyph only) and so did the three message tallies. What stays is
              the attention chip — a REQUEST, not a facet, and never on §6's
              list of what a row stops saying — and the progress figure. */}
          <span className="lp__badges">
            {chipView ?? (flagged ? (
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
            ) : null)}
            {progress && view.shows('progress') ? <TileProgressBar progress={progress} /> : null}
          </span>

          {/* THE TIME, AND IT YIELDS. `activityAt`, not `updatedAt`: the list's
              default order IS `activityAt_desc`, and a row whose time disagreed
              with its own position would be worse than no time at all. On hover
              CSS hides it and the `⋯` menu takes the same slot (§6), so the
              row never changes width under the pointer. */}
          <Timestamp className="lp__time" at={row.activityAt} title="last activity" />

          {/* D67 — THE DETAILS DISCLOSURE, AND IT STAYS IN THE ROW.
              DELIBERATELY NOT inside the `⋯` below: the expand is not a verb,
              it is the row's second state, and the phone keeps exactly this
              one control while hiding the verbs. Also deliberately not the
              `▸ N` chip — that means "show this row's CHILDREN" on tree kinds,
              and giving one control two meanings would make a doc's expand
              ambiguous. */}
          <button
            type="button"
            /* `--ind` names it the OPENER, the way `pn-tt__ind` does on the
               task tile. A structural selector would break the day a verb is
               added after it. */
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

          {/*
            THE ⋯ ROW MENU (§6: "on hover the time hides and a ⋯ row menu
            appears"). ONE control in the time's slot, and the verbs behind it.

            IT WRAPS `RowActionCluster` RATHER THAN RE-LISTING THE VERBS. Every
            verb's gate, refusal reason and launch flow lives in that component
            (`controls/EntityControls.tsx`); a hand-written menu here would be a
            second copy of `rowActions` that goes stale the first time a kind
            changes, and the three-state honesty (unwired renders refused) would
            have to be rebuilt. So the cluster still draws the verbs — it is the
            container around it that changed from "five icons, always on hover"
            to "one ⋯, then the icons".

            Row-local open state, like `flowRef` above and for the same reason:
            an "only one menu open" register would need an owner this panel has
            none of, and the menu closes on pointerdown outside itself.
          */}
          <span className="lp__rowmenu" data-open={rowMenuOpen ? 'true' : undefined}>
            <button
              type="button"
              /* NOT `lp__rowaction`: that class means A ROW VERB, and the R5 #9 test
                 reads it to assert that every live one is a launch verb. This is
                 a DOOR onto the verbs, which is a different thing, so it carries
                 its own class and its own rule. */
              className="lp__rowmenu-trigger"
              title="Row actions"
              aria-label={`Actions for ${row.title}`}
              aria-expanded={rowMenuOpen}
              aria-haspopup="menu"
              data-testid="row-menu-trigger"
              onClick={(event) => {
                event.stopPropagation();
                setRowMenuOpen((open) => !open);
              }}
            >
              <span aria-hidden>⋯</span>
            </button>
            {/* MOUNTED WHILE SHUT, AND HIDDEN BY CSS ALONE — not by `hidden`,
                and the difference is the phone.
                
                On a coarse pointer there is no hover and the `⋯` is
                redundant, so the stylesheet draws this cluster IN the row at
                rest, exactly as the row drew it before this change (the
                ruling `.lp__rowactions` carries). An `hidden` attribute would
                beat that rule and leave a touch device with no row verbs at
                all — which is the defect `.lp__rowactions`'s own comment
                records having shipped once. So the open state is a CSS fact
                (`.lp__rowmenu[data-open]`), and the one place that decides
                whether a surface needs the door is the stylesheet. */}
            <span
              className="lp__rowmenu-pop lp__cluster"
              role="menu"
              data-testid="row-menu"
              onClick={(event) => event.stopPropagation()}
            >
              <RowActionCluster
                row={row}
                props={props}
                config={config}
                openFlow={flowRef}
                onFlow={setFlowRef} onOpenLaunch={props.launch?.onFullOptions}
              />
            </span>
          </span>

        </div>
      </div>

      {/* LINE 2, AND THE ONLY ONE: the counts line. Its own sub-row because
          line 1 holds the 29px floor — a row with counts measures ~43px and a
          row without them is unchanged, which is the §6 geometry. */}
      <AttentionTileSubtitle line={attentionLine} />
      {countsLine ? <div className="lp__tile-counts">{countsLine}</div> : null}

      {detailsExpanded ? <EntityControlStrip row={row} props={props} config={config} /> : null}

      {/* The config pops as a modal tile now (canvas composer): the subject is
          named IN the popup's verb strip, so it stays obvious while teammate
          and model choices are changed. */}
      {flowRef ? (
        <div className="lp__flow" onClick={(e) => e.stopPropagation()}>
          <LaunchComposerPopup
            subject={row}
            key={flowRef}
            verbLabel={resolveAction(flowRef).label}
            {...(resolveAction(flowRef).launchMode
              ? { mode: resolveAction(flowRef).launchMode }
              : {})}
            spaceId={props.launch?.spaceId ?? props.ctx.spaceId ?? ''}
            teammates={props.launch?.teammates ?? []}
            projects={props.launch?.projects ?? []}
            capacity={props.launch?.capacity}
            jev={props.launch?.jev}
              loadInstalledPlugins={props.launch?.loadInstalledPlugins}
              selection={props.launch?.selection}
              profileFor={props.launch?.profileFor}
              upload={props.launch?.upload}
              onDispatch={props.launch?.dispatch ? (note, key) => props.launch!.dispatch!(row.id, note, key) : undefined}
              jevKeyStatus={props.launch?.jevKeyStatus}
              sessionsSince={props.launch?.sessionsSince}
            onSpawn={props.launch?.onSpawn}
            loadDescription={
              props.launch?.descriptionOf
                ? () => props.launch!.descriptionOf!(row.id)
                : undefined
            }
            canEditSubject={Boolean(props.launch?.onUpdateEntity)}
            onDismiss={() => setFlowRef(null)}
            newClientMutationId={() => props.launch?.mutationId(row.id) ?? newLaunchMutationId()}
          />
        </div>
      ) : null}
    </div>
  );
}

interface ControlCardFacts {
  assignees: EntitySummary['createdBy'][];
  /** Never null in practice — every row carries a creator. */
  creator: EntitySummary['createdBy'] | null;
  meta: string[];
}

/** `state.acceptance` as done/total, or null when the row carries no criteria. */
export function acceptanceProgressOf(row: EntitySummary): TaskTileProgress | null {
  const acceptance = (row.state as unknown as Record<string, unknown>).acceptance as
    | { completed?: unknown; total?: unknown }
    | undefined;
  if (typeof acceptance?.total !== 'number' || acceptance.total <= 0) return null;
  return {
    done: typeof acceptance.completed === 'number' ? acceptance.completed : 0,
    total: acceptance.total,
  };
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
  const acceptance = acceptanceProgressOf(row);
  if (acceptance) meta.push(`${acceptance.done}/${acceptance.total} criteria`);
  if (typeof state.dueDate === 'string' && state.dueDate) meta.push(`due ${state.dueDate}`);
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
