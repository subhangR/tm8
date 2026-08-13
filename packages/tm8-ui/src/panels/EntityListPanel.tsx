import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  LifecycleTier,
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
  collectionKinds,
  countLabel,
  getKind,
  needsViewer,
  resolveAction,
} from '../domain';
import { Avatar, Timestamp, type PillTone } from '../kit';
import {
  CheckingPermission,
  DisabledAction,
  DisabledIconControl,
  NOT_WIRED_REASON,
  toReason,
  type UnavailableReason,
} from './honesty/DisabledWithReason';
import { EmptyBody } from './detail/PanelStates';
import { useDismissable } from './useDismissable';
import { EntityControlStrip, RowAction, RowMembershipControl, type ControlHost } from './controls/EntityControls';
import { HANDLED_SOURCES, renderBadge, type TileSlot } from './list/tile-badges';
import { MaestroTaskTile } from './list/MaestroTaskTile';
import { LinkedPullRequestChips, type LinkedPullRequestFacts } from '../pull-requests';
import { MaestroSessionTile } from './list/MaestroSessionTile';
import { routeMessagePulse, type PulseSegment } from './list/message-pulse';
import type { MessagePulse } from './list/useMessagePulses';
import { LaunchQuickConfig, type LaunchTeammateOption } from './launch/LaunchQuickConfig';
import { newLaunchMutationId } from '../domain/launch';

const EMPTY_MEMBERS: readonly ActorSummary[] = Object.freeze([]);

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
  /** Tracked PR facts from the graph/entity projection, live by entity id. */
  linkedPullRequestsOf?: (id: string) => readonly LinkedPullRequestFacts[];

  selectedId?: string | null;
  /** True at the 200/220px floors: metas drop, badges abbreviate. */
  compact?: boolean;

  /**
   * Doc 06 §1.1 — the mode-wiring fix. The ROUTE holds the layout mode and the
   * shell passes it down; local state remains only the uncontrolled fallback
   * for hosts that do not route it. Without this pair the codec parsed
   * `?mode=` and the value died before reaching the panel.
   */
  mode?: CollectionMode;
  onMode?: (mode: CollectionMode) => void;

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
   */
  onSetValue?: (entityId: string, source: string, next: string, label: string) => void;

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

export function EntityListPanel(props: EntityListPanelProps) {
  const config = getKind(props.kind);
  const list = config.list;

  const [tierId, setTierId] = useState<string | null>(list.lifecycle?.[0]?.id ?? null);
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
  // §1.1: route-held when the host passes the pair; local only as the
  // uncontrolled fallback. `props.mode` null-ish means "the route says
  // nothing", which falls through to local state, which seeds from registry.
  const [localMode, setLocalMode] = useState<CollectionMode>(config.defaultMode);
  const mode = props.mode ?? localMode;
  const setMode = props.onMode ?? setLocalMode;

  const activeTier = list.lifecycle?.find((t) => t.id === tierId) ?? null;
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

  /**
   * Every tier's count, computed ONCE per render and shared by the three
   * surfaces that show it (tabs, footer, selector total). They were three
   * calls to the same function; with paging state joined in it is now enough
   * work to be worth not tripling, and sharing also makes it structurally
   * impossible for the tab and the footer to disagree.
   */
  const tierCounts = (list.lifecycle ?? []).map((tier) => ({
    tier,
    ...tierCount(props, config, tier),
  }));
  const anyTierTruncated = tierCounts.some((c) => c.label.endsWith('+'));

  return (
    <section
      className={props.compact ? 'lp lp--compact' : 'lp'}
      data-testid="entity-list-panel"
      data-kind={config.kind}
      aria-label={config.labelPlural}
    >
      <KindSelector
        config={config}
        total={
          list.lifecycle
            ? `${tierCounts.reduce((n, c) => n + c.n, 0)}${anyTierTruncated ? '+' : ''}`
            : undefined
        }
        liveCount={liveCountFor(props, config)}
        onKindChange={props.onKindChange}
        mode={mode}
        onMode={setMode}
      />

      <HeaderActions
        config={config}
        ctx={props.ctx}
        onCreate={props.onCreate}
        createSlot={props.createSlot}
        onAction={props.onAction}
        {...(props.wiredActions ? { wiredActions: props.wiredActions } : {})}
      />

      <SearchRow
        config={config}
        query={query}
        onQuery={setQuery}
        inputRef={props.searchInputRef}
      />

      <TierTabs
        tiers={list.lifecycle}
        activeTierId={tierId}
        onTier={setTierId}
        tierLabel={(tier: LifecycleTier) =>
          tierCounts.find((c) => c.tier.id === tier.id)?.label ?? '0'
        }
      />

      <FilterRow
        config={config}
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
        tiers={list.lifecycle}
        activeTierId={tierId}
        onTier={setTierId}
        tierLabel={(tier: LifecycleTier) =>
          tierCounts.find((c) => c.tier.id === tier.id)?.label ?? '0'
        }
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

      <div className="lp__body">
        {mode === 'board' && list.board ? (
          <BoardBody
            props={props}
            config={config}
            tier={activeTier}
            onTier={setTierId}
            filter={
              bandFilter(
                activeTier?.filter ?? {},
                activeTier,
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
          /* A section the active tier excludes outright renders NO heading.
             Its rows would be empty by construction, and an empty band under
             "COMPLETED · 0" inside the Open tier states something false about
             the tier rather than about the data. */
          list.sections
            .filter((section) => narrow(section.filter, activeTier?.filter) !== null)
            .map((section) => (
            <Band
              key={section.id}
              label={section.label}
              filter={bandFilter(
                section.filter,
                activeTier,
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
              props={props}
              config={config}
              query={query}
            />
          ))
        ) : (
          <Band
            label={null}
            filter={bandFilter(
              activeTier?.filter ?? {},
              activeTier,
              selected,
              config,
              props.ctx,
              selectedPeople,
              lensFilter,
            )}
            sort={sortKey}
            props={props}
            config={config}
            query={query}
          />
        )}
      </div>

      {/* T0-1 draws a footer count line on every kind: "9 open · 601 done ·
          33 archived". Same per-tier counts as the tabs above — one source,
          three surfaces (tabs, footer, selector total). */}
      {tierCounts.length > 0 ? (
        <div className="lp__foot" data-testid="list-footer">
          {tierCounts.map((c) => `${c.label} ${c.tier.id}`).join(' · ')}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row sourcing
// ---------------------------------------------------------------------------

/**
 * D14 — the lifecycle-tab partition is applied CLIENT-SIDE, deliberately.
 *
 * `CollectionQuery` has no member that filters work_sessions by
 * `WorkSessionStatus` (its `filters.workStatus` is the TASK vocabulary), so
 * rather than invent a contract shape the registry declares `statuses` and
 * the panel partitions rows the seam already delivered. Read STRUCTURALLY —
 * "does this row's state carry a `status`?" — never by kind, so this stays
 * inside the no-branching law. When the contract gains the member, the
 * partition retires and no call site changes.
 */
/**
 * THE THREE AXES MUST NARROW, NOT OVERWRITE.
 *
 * A visible list is the intersection of three independently-chosen
 * constraints: the SECTION band, the lifecycle TIER, and the filter CHIPS.
 * This used to be `{...section, ...tier, ...chips}`, and object spread is the
 * wrong operator for every one of them:
 *
 *   - ARRAYS. `{workStatus:['open','pulled','working']}` spread under
 *     `{workStatus:['done']}` yields `['done']` — the Open tab showing done
 *     rows. Two lists of allowed values compose by INTERSECTION; each one
 *     says "only these", and both are still true.
 *     Concretely: on the Open tier the band headed "Completed" was queried
 *     with the OPEN statuses, so it rendered open tasks under a "Completed"
 *     heading and was an exact duplicate of the "Current" band above it. A
 *     user who marked a task done watched it stay put in a band labelled
 *     Completed, which reads as "done did not work".
 *   - SCALARS take the LATER value, because a scalar has no intersection.
 *     Argument order is therefore load-bearing: section, then tier, then
 *     chips. `deleted` is the case that matters — it is the outer lifecycle
 *     scope, and a section's `deleted:'exclude'` restates the common case
 *     rather than constraining anything, so THE TIER WINS. Reading that pair
 *     as a contradiction does not reveal a bug, it empties the Archived tier
 *     ('only') against every section ('exclude') — the one tier whose
 *     partition already worked.
 *   - EMPTY. An empty intersection is not `[]`. `workStatus: []` means NO
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
 * This subsumes `scopeToTier`, which composed the section/tier pair under
 * exactly these rules. Two functions for one law is one too many, and the
 * chips need the same treatment the tier got.
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
 * `CollectionQuery.filters.sessionStatus`, so the tier's own `filter` is an
 * ordinary filter the SEAM executes, exactly like the task tiers beside it.
 *
 * Deliberately not re-implemented against `filter.sessionStatus` — that would
 * put server-side filtering on the client as well, and the two would disagree
 * the moment a status is added. One filter, executed once, at the seam.
 */
function bandFilter(
  filter: QueryFilter,
  tier: LifecycleTier | null,
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
    tier?.filter,
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
  tier: LifecycleTier | null,
  selected: Readonly<Record<string, readonly string[]>>,
  config: KindConfig,
  selectedPeople: readonly string[] = [],
  sort?: SortKey,
): readonly EntitySummary[] {
  /**
   * D20 RETIRED (D56). The client-side status partition that used to run here
   * is DELETED, not translated: the contract gained
   * `CollectionQuery.filters.sessionStatus`, so the tier's own `filter` is an
   * ordinary filter the SEAM executes, exactly like the task tiers beside it.
   *
   * Deliberately not re-implemented against `filter.sessionStatus` — that
   * would put server-side filtering on the client as well, and the two would
   * disagree the moment a status is added. One filter, executed once, at the
   * seam.
   */
  const merged = bandFilter(filter, tier, selected, config, props.ctx, selectedPeople);
  // Disjoint band: the section asks for statuses this tier excludes, so it can
  // hold nothing. Its caller skips the heading entirely — see `sectionsFor`.
  return merged === null ? NO_ROWS : props.rowsFor(merged, sort);
}

/**
 * A tier's count is its OWN query's result size — the same source the tab
 * label, the footer line and the kind-selector total all read. A count FIELD
 * would be a second source that could disagree with the query it claims to
 * summarise (A1a's design note, and it is the right one).
 *
 * COUNTED UNDER NO SORT, DELIBERATELY. A count is order-independent, and the
 * read key includes the sort — so counting under the active sort would fire a
 * fresh query per tier every time the user changes the order, to learn a
 * number that cannot have changed.
 *
 * `more` is the honesty half. The count is `rows.length`, and rows stop at the
 * page the server served, so a saturated first page makes 601 read as 50. The
 * caller renders `50+` while the server still holds a cursor.
 *
 * An `unsupported` tier counts ZERO honestly: the kind has no state that can
 * land there, so the tab renders with its reason rather than being dropped.
 */
function tierCount(
  props: EntityListPanelProps,
  config: KindConfig,
  tier: LifecycleTier,
): { n: number; label: string } {
  if (tier.unsupported) return { n: 0, label: '0' };
  const merged = bandFilter(tier.filter, tier, {}, config, props.ctx);
  if (merged === null) return { n: 0, label: '0' };
  const n = props.rowsFor(merged).length;
  return { n, label: countLabel(n, props.pageStateOf?.(merged)) };
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
 */
function liveCountFor(props: EntityListPanelProps, config: KindConfig): string | null {
  const spec = config.list.liveCount;
  if (!spec || !props.liveIds) return null;
  const rows = props.rowsFor(spec.filter);
  const live = new Set(props.liveIds);
  return spec.label(rows.filter((r) => live.has(r.id)).length);
}

// ---------------------------------------------------------------------------
// Header rows
// ---------------------------------------------------------------------------

function KindSelector({
  config,
  total,
  liveCount,
  onKindChange,
  mode,
  onMode,
}: {
  config: KindConfig;
  /**
   * Sum of the lifecycle tiers — T0-1 draws it beside the kind name.
   *
   * A STRING, because the honest value may be `601+`. Summing three tier
   * counts each capped at a page produced `150` for a 700-row space and said
   * it with a number's confidence; carrying the `+` up from whichever tier is
   * truncated keeps the total as honest as its worst input.
   */
  total?: string;
  liveCount: string | null;
  onKindChange?: (kind: string) => void;
  mode: CollectionMode;
  onMode: (mode: CollectionMode) => void;
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
      <ViewSwitcher config={config} mode={mode} onMode={onMode} />
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

/**
 * THE VIEW SWITCHER — one control everywhere (C5), positions from registry DATA.
 *
 * `hiddenModes` hides by config; `graph` is NEVER a member of it, because R7
 * requires graph VISIBLE-labelled-unclickable rather than absent — hidden and
 * disabled are different states and only one of them teaches the user the
 * feature exists.
 *
 * In A1 only `list` has a body. The other positions render
 * disabled-with-reason rather than switching to a blank region: a switcher
 * that moves you to nothing is worse than one that says why it cannot yet.
 * The layout bodies are A2 (LLD §3.3); this control is the gate deliverable.
 */
/**
 * T0-1's own switcher set, verbatim from the canvas support code:
 *   views = [['≡','List'], ['⑂','Tree'], ['▥','Board'], ['◉','Graph']]
 * FOUR positions, not the registry's six modes — feed and gallery are
 * CollectionView layouts (k/{slug}, A2) and the composed workspace canvas
 * does not offer them in a side panel. Per-kind visibility still comes from
 * `hiddenModes`, so a kind may show fewer; none may show more.
 */
const SWITCHER_MODES: readonly CollectionMode[] = ['list', 'tree', 'board', 'graph'];
const MODE_GLYPH: Record<CollectionMode, string> = {
  list: '≡',
  tree: '⑂',
  board: '▥',
  graph: '◉',
  feed: '≡',
  gallery: '▩',
};

function ViewSwitcher({
  config,
  mode,
  onMode,
}: {
  config: KindConfig;
  mode: CollectionMode;
  onMode: (mode: CollectionMode) => void;
}) {
  const positions = SWITCHER_MODES.filter((m) => !config.hiddenModes.includes(m));
  if (positions.length <= 1) return null;
  return (
    <span className="lp__views" role="group" aria-label="Layout" data-testid="view-switcher">
      {positions.map((m) => {
        // A2: board is built for kinds that DECLARE one. A kind without a
        // `board` registry row keeps its position honestly disabled — the
        // declaration is data, so a kind gains a board by registry entry.
        const built = m === 'list' || (m === 'board' && config.list.board !== undefined);
        const reason =
          m === 'graph'
            ? 'Graph view isn’t available yet.'
            : m === 'board'
              ? `${config.labelPlural} have no board: this kind declares no board grouping in the registry.`
              : `The ${m} layout arrives with A2 — the switcher position is real, the body is not built yet.`;
        if (!built) {
          return (
            <DisabledIconControl key={m} label={`${m} layout`} glyph={MODE_GLYPH[m]} reason={toReason(reason)} />
          );
        }
        return (
          <button
            key={m}
            type="button"
            className={m === mode ? 'lp__view lp__view--active' : 'lp__view'}
            aria-pressed={m === mode}
            aria-label={`${m} layout`}
            title={`${m} layout`}
            onClick={() => onMode(m)}
          >
            {MODE_GLYPH[m]}
          </button>
        );
      })}
    </span>
  );
}

function HeaderActions({
  config,
  ctx,
  onCreate,
  createSlot,
  onAction,
  wiredActions,
}: {
  config: KindConfig;
  ctx: ActionContext;
  onCreate?: () => void;
  createSlot?: React.ReactNode;
  onAction?: (ref: ActionRef, entityId: string) => void;
  wiredActions?: readonly ActionRef[];
}) {
  const { quickCreate, quickLaunch, quickStart } = config.list;
  // Per-verb, not per-header. `chrome.tsx`'s exact expression: an unwired verb
  // is handed `undefined` and renders refused, rather than the header deciding
  // for all of its verbs at once.
  const dispatcherFor = (ref: ActionRef): typeof onAction =>
    wiredActions && !wiredActions.includes(ref) ? undefined : onAction;
  const showCreate = Boolean(quickCreate && (createSlot || onCreate));
  // `onAction`, NOT `dispatcherFor(...)`: a host with no dispatcher at all
  // still has nothing to draw, but a host that has one draws every declared
  // verb — refused where it cannot perform it. Hiding an unwired verb is the
  // failure mode this panel spent D64 removing, because a control nobody can
  // see cannot be reported as missing.
  const showLaunch = Boolean(quickLaunch && onAction);
  const showStart = Boolean(quickStart && onAction);
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
 * THE LIFECYCLE TIER TABS — Open / Done / Archived, universal across
 * collection kinds (D41, user-ratified). Their own row: a tier is the
 * lifecycle band you are looking at, and the filter chips below narrow WITHIN
 * it. T0-1 draws both, and the count on each tab comes from that tier's own
 * query — the same source as the footer line and the kind-selector total.
 */
function TierTabs({
  tiers,
  activeTierId,
  onTier,
  tierLabel,
}: {
  tiers?: readonly LifecycleTier[];
  activeTierId: string | null;
  onTier: (id: string) => void;
  /** Already rendered — `50+` when the page is saturated, `50` when it is all. */
  tierLabel: (tier: LifecycleTier) => string;
}) {
  if (!tiers || tiers.length === 0) return null;
  return (
    <div className="lp__tierrow" role="tablist" aria-label="Lifecycle">
      {tiers.map((tier) => (
        <button
          key={tier.id}
          type="button"
          role="tab"
          aria-selected={tier.id === activeTierId}
          className={tier.id === activeTierId ? 'lp__tab lp__tab--active' : 'lp__tab'}
          onClick={() => onTier(tier.id)}
          /* An unsupported tier still RENDERS — honestly empty, with its
             reason reachable — rather than being dropped for some kinds and
             not others. Hidden and empty are different states (L6), and a tab
             that vanishes per-kind teaches nothing about why. */
          title={tier.unsupported}
          data-unsupported={tier.unsupported ? 'true' : undefined}
        >
          {`${tier.label} ${tierLabel(tier)}`}
        </button>
      ))}
    </div>
  );
}

function FilterRow({
  config,
  selected,
  onToggleOption,
  sortKey,
  onSort,
  tiers,
  activeTierId,
  onTier,
  tierLabel,
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
  selected: Readonly<Record<string, readonly string[]>>;
  onToggleOption: (specId: string, optionId: string, multi: boolean) => void;
  sortKey: SortKey | undefined;
  onSort: (key: SortKey) => void;
  tiers?: readonly LifecycleTier[];
  activeTierId: string | null;
  onTier: (id: string) => void;
  /** Each tier's own query size — the one source the tabs, footer and total share. */
  tierLabel: (tier: LifecycleTier) => string;
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
  // One popover at a time, sort included. Two independent booleans would let
  // the sort menu and a filter picker sit open over each other.
  const [picker, setPicker] = useState<'filters' | 'people' | 'sets' | 'sort' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useDismissable(picker !== null, barRef, useCallback(() => setPicker(null), []));
  const sort = config.list.sort;
  const current = sort.find((s) => s.key === sortKey) ?? sort[0];

  const active = config.list.filters.flatMap((spec) =>
    (selected[spec.id] ?? []).flatMap((optionId) => {
      const option = spec.options.find((o) => o.id === optionId);
      return option ? [{ spec, option }] : [];
    }),
  );

  return (
    <div className="lp__filterbar" ref={barRef}>
    <div className="lp__filters">
      {/* Filter chips and the picker trigger. The lifecycle TABS are a
          separate row above (TierTabs): tabs are a lifecycle TIER and filters
          narrow WITHIN it, so they coexist — T0-1 draws both. They were an
          either/or here only while work_session was the one kind with tabs,
          and making tiers universal exposed that shortcut by deleting the
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
          onClick={() => setPicker((open) => open === 'filters' ? null : 'filters')}
          aria-expanded={picker === 'filters'}
          aria-haspopup="menu"
          data-testid="filter-trigger"
        >
          filter ▾
        </button>
      ) : null}
      {people.length > 1 ? (
        <button
          type="button"
          className={selectedPeople.length > 0 ? 'lp__chip lp__chip--active' : 'lp__chip'}
          onClick={() => setPicker((open) => open === 'people' ? null : 'people')}
          aria-expanded={picker === 'people'}
          aria-haspopup="menu"
          data-testid="people-filter-trigger"
        >
          {selectedPeople.length > 0 ? `people · ${selectedPeople.length}` : 'people ▾'}
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
            onClick={() => setPicker((open) => (open === 'sets' ? null : 'sets'))}
            aria-expanded={picker === 'sets'}
            aria-haspopup="menu"
            data-testid="collection-lens-trigger"
          >
            {`${membership.label.toLowerCase()} ▾`}
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
          onClick={() => setPicker((p) => (p === 'sort' ? null : 'sort'))}
          aria-expanded={picker === 'sort'}
          aria-haspopup="menu"
          title={`Sorted by ${current.label}`}
          data-testid="sort-trigger"
        >
          {/* At the floor the sort chip collapses to its glyph — T0-3 frame 4
              draws exactly `↓`. The chip never disappears. */}
          {compact ? '↓' : `↓ ${current.label}`}
        </button>
      ) : null}

    </div>
      {picker === 'sort' ? (
        <div className="lp__filtermenu lp__filtermenu--sort" role="menu" data-testid="sort-menu">
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
        </div>
      ) : null}
      {/* Rendered OUTSIDE the clipping row, inside the positioned bar: the row
          keeps `overflow: hidden` as its floor guard, and the picker is still
          free to overflow it. No hardcoded offset — `top: 100%` of the bar
          works whether or not this kind renders a header-actions row. */}
      {picker === 'filters' ? (
        <div className="lp__filtermenu" role="menu" data-testid="filter-menu">
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
        </div>
      ) : null}
      {picker === 'sets' && membership ? (
        <div className="lp__filtermenu" role="menu" data-testid="collection-lens-menu">
          <div className="lp__filtergroup">{membership.label.toUpperCase()}</div>
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
        </div>
      ) : null}
      {picker === 'people' ? (
        <div className="lp__filtermenu" role="menu" data-testid="people-filter-menu">
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
        </div>
      ) : null}
    </div>
  );
}

/**
 * Merge every selected option's contract-shaped filter. Array members UNION
 * (several `status` options combine into one `workStatus` list) rather than
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
  /** How a drop here dispatches. `null` ⇒ not a legal drop target. */
  option: StateOption | null;
  /** The §1.3 Done sink — a drop target, never a fetched column. */
  sink: boolean;
}

/**
 * Column MEMBERSHIP and ORDER = stateControl.options ∩ the active tier's
 * workStatus filter; words/tones from panel.statusPill. One source — the
 * picker, the pill and the column cannot drift (§1.3).
 */
function boardColumns(
  config: KindConfig,
  tier: LifecycleTier | null,
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

  const tierStatuses = tier?.filter.workStatus as readonly string[] | undefined;
  const columns: BoardColumnSpec[] = stateControl.options
    .filter((o) => !tierStatuses || tierStatuses.includes(o.id))
    .map((o) => ({ key: o.id, label: labelOf(o.id), tone: toneOf(o.id), option: o, sink: false }));

  // §1.3 — the Done sink. The tier rule alone would leave the Open board with
  // no terminal column, making the single most-performed Kanban action
  // impossible. Derived from DATA: the option routed `via:'complete'` that the
  // active tier excludes. `cancelled` gets no sink — a rare deliberate act
  // that stays in the state picker.
  if (tier?.id === 'open') {
    const sinkOption = stateControl.options.find(
      (o) => o.via === 'complete' && !columns.some((c) => c.key === o.id),
    );
    if (sinkOption) {
      columns.push({
        key: sinkOption.id,
        label: `${labelOf(sinkOption.id)} — drop to complete`,
        tone: toneOf(sinkOption.id),
        option: sinkOption,
        sink: true,
      });
    }
  }

  // A group key the registry does not declare renders APPENDED with the raw
  // key and neutral tone — never dropped (§1.3).
  for (const group of groups) {
    if (!columns.some((c) => c.key === group.key)) {
      columns.push({ key: group.key, label: group.label || group.key, tone: 'idle', option: null, sink: false });
    }
  }

  return columns;
}

function BoardBody({
  props,
  config,
  tier,
  onTier,
  filter,
  query,
}: {
  props: EntityListPanelProps;
  config: KindConfig;
  tier: LifecycleTier | null;
  onTier: (tierId: string) => void;
  filter: QueryFilter;
  query: string;
}) {
  const list = config.list;
  const board = list.board as NonNullable<typeof list.board>;
  const stateControl = list.stateControl;
  /** Cards completed via the sink THIS view session — its only body (§1.3). */
  const [completedHere, setCompletedHere] = useState<readonly EntitySummary[]>([]);
  /** The §1.5 inline refusal: rendered at the refusing column's header. */
  const [refusal, setRefusal] = useState<{ column: string; reason: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** The card in flight. The ROW rides along so a drop needs no cache lookup. */
  const [dragging, setDragging] = useState<EntitySummary | null>(null);
  /** §8.1 roving focus: column index + card index within it. */
  const [focus, setFocus] = useState<{ col: number; row: number }>({ col: 0, row: 0 });

  // Archived tier: board disabled with reason — archived rows have no
  // workflow. Same honesty kit as every other foreseeable refusal (§8.5).
  if (tier?.id === 'archived') {
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

  const snapshot = props.boardFor?.(filter, board.groupBy);

  // No source wired: say so. A board that silently renders nothing is
  // indistinguishable from an empty tier, and only one of those is true.
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
  const columns = boardColumns(config, tier, snapshot?.groups ?? []);
  const groupOf = new Map((snapshot?.groups ?? []).map((g) => [g.key, g] as const));
  const itemsOf = (column: BoardColumnSpec): readonly EntitySummary[] =>
    column.sink ? matching(completedHere, query) : matching(groupOf.get(column.key)?.items ?? [], query);

  // §8.4 — quick-add ONLY on the column whose status is the kind's creation
  // status: the FIRST stateControl option (creation IS that state; a quick-add
  // elsewhere would silently create a card belonging to another column).
  const creationKey = stateControl?.options[0]?.id;

  const dispatchDrop = (row: EntitySummary, column: BoardColumnSpec): void => {
    if (!column.option || !stateControl || !props.onSetState) return;
    if (!column.sink && itemsOf(column).some((r) => r.id === row.id)) return;
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
        return;
      }
      if (column.sink) setCompletedHere((prior) => [...prior, row]);
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
      if (!target || !target.option) return;
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
            createSlot={!column.sink && column.key === creationKey ? props.createSlot : undefined}
            doneTierLink={
              column.sink
                ? () => {
                    const doneTier = list.lifecycle?.find((t) =>
                      (t.filter.workStatus as readonly string[] | undefined)?.includes(column.key),
                    );
                    if (doneTier) onTier(doneTier.id);
                  }
                : undefined
            }
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
  doneTierLink,
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
  doneTierLink?: () => void;
}) {
  const droppable = Boolean(column.option && props.onSetState);

  return (
    <section
      className={
        column.sink
          ? 'lp__board-col lp__board-col--sink'
          : focused
            ? 'lp__board-col lp__board-col--focused'
            : 'lp__board-col'
      }
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
          column.sink ? (
            <p className="lp__board-empty">drop a card here to complete it</p>
          ) : (
            // §1.3: an empty column is a real answer.
            <p className="lp__board-empty">{`nothing in ${column.label}`}</p>
          )
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

      {column.sink && doneTierLink ? (
        <button type="button" className="lp__board-done-link" onClick={doneTierLink}>
          {'View all done →'}
        </button>
      ) : null}
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
}: {
  label: string | null;
  /**
   * The band's own already-narrowed query, or `null` when the section, the
   * tier and the chips cannot all hold at once. The band OWNS the read: it is
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
        ) : (
          <EmptyBody
            glyph={<KindIcon kind={config.kind} size={22} />}
            sentence={`No ${config.labelPlural.toLowerCase()} here yet — create one, or press / and type a name.`}
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
   * Collapsed, not expanded: rows remain visible by default (the existing
   * contract and the full-workspace reference both open the active subtree),
   * while a later-arriving child does not need state bookkeeping to appear.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const roots = useMemo(() => buildTileTree(rows, Boolean(config.list.tree)), [rows, config.list.tree]);

  /**
   * Live message traffic, resolved against THIS tree's current shape. Recomputed
   * when the tree or the collapsed set changes, because a route is only true for
   * the arrangement that was on screen when it was drawn — collapsing a subtree
   * mid-flight must re-aim the pulse at the ancestor now standing in for it.
   */
  const pulse = useMemo(
    () => resolvePulses(rows, collapsed, props.messagePulses, config),
    [rows, collapsed, props.messagePulses, config],
  );

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (node: TileTreeNode): React.ReactNode => {
    const isCollapsed = collapsed.has(node.row.id);
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
          onToggleChildren={hasChildren ? () => toggle(node.row.id) : undefined}
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
  collapsed: ReadonlySet<string>,
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
      if (!present.has(id) || collapsed.has(id)) return false;
      // Rendered means every ancestor is expanded, not just this row's parent.
      const guard = new Set<string>();
      let cursor = parentOf(id);
      while (typeof cursor === 'string' && !guard.has(cursor)) {
        if (collapsed.has(cursor)) return false;
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
export function Tile({
  row,
  depth = 0,
  props,
  config,
  attention = false,
  childCount = 0,
  expanded = false,
  onToggleChildren,
}: {
  row: EntitySummary;
  depth?: number;
  props: EntityListPanelProps;
  config: KindConfig;
  attention?: boolean;
  childCount?: number;
  expanded?: boolean;
  onToggleChildren?: () => void;
}) {
  const list = config.list;
  const controlCard = list.tile.anatomy === 'control-card';
  const sessionTree = list.tile.anatomy === 'session-tree';
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
  const done = row.deletedAt != null;
  const controlExpanded = controlCard && (detailsExpanded || flowRef !== null);
  const controlFacts = controlCard ? factsForControlCard(row) : null;
  const linkedPullRequests = controlCard ? (props.linkedPullRequestsOf?.(row.id) ?? []) : [];

  if (sessionTree) {
    const state = row.state as unknown as Record<string, unknown>;
    const recordedStatus = typeof state.status === 'string' ? state.status : 'idle';
    const agentTool = typeof state.agentTool === 'string' ? state.agentTool : null;
    // Passed through so the tile can tell a vanilla terminal from an agent
    // whose tool was never recorded (101). Absent stays absent — see the prop.
    const sessionKind = typeof state.sessionKind === 'string' ? state.sessionKind : null;
    const model = typeof state.model === 'string' ? state.model : null;
    const live = verdict === 'live';
    return (
      <MaestroSessionTile
        id={row.id}
        title={row.title || 'Session'}
        agentTool={agentTool}
        sessionKind={sessionKind}
        model={model}
        status={recordedStatus}
        attention={attention}
        selected={selected}
        archived={row.deletedAt != null}
        completed={recordedStatus === 'exited'}
        live={live}
        streaming={streaming}
        statusTone={statusTone}
        statusTitle={statusTitle}
        tasks={props.linkedTasksOf?.(row.id) ?? []}
        childCount={childCount}
        childrenExpanded={expanded}
        onToggleChildren={onToggleChildren}
        onSelect={() => props.onSelect?.(row.id)}
        onClose={props.onTerminate ? () => props.onTerminate?.(row.id) : undefined}
        detail={<EntityControlStrip row={row} props={props} config={config} />}
      />
    );
  }

  if (controlCard && controlFacts) {
    return (
      <MaestroTaskTile
        rootRef={tileRef}
        id={row.id}
        title={row.title}
        depth={depth}
        selected={selected}
        attention={attention}
        attentionReason={row.badges.attention?.latestReason}
        completed={done || statusWord === 'done'}
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
        assignees={controlFacts.assignees}
        creator={controlFacts.creator}
        badges={
          linkedPullRequests.length > 0 ? (
            <LinkedPullRequestChips pullRequests={linkedPullRequests} placement="tile" />
          ) : undefined
        }
        actions={[
          ...(list.rowActions ?? []).map((ref) => (
            <RowAction
              key={ref}
              ref_={ref}
              row={row}
              props={props}
              openFlow={flowRef}
              onFlow={setFlowRef}
              onOpenLaunch={props.launch?.onFullOptions}
            />
          )),
          /* The collapsed control-card gets the same icon-anatomy membership
             control as the standard tile — one component, not a second copy. */
          ...(list.membership
            ? [
                <RowMembershipControl
                  key="membership"
                  row={row}
                  props={props}
                  control={list.membership}
                  variant="icon"
                />,
              ]
            : []),
        ]}
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
    );
  }

  return (
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
      data-tree={config.list.tree ? 'true' : undefined}
      data-children={childCount > 0 ? childCount : undefined}
      data-flow={flowRef ? 'open' : undefined}
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

          <span
            className={`lp__statusmark lp__statusmark--${statusTone}`}
            aria-hidden
            title={statusTitle}
          >
            {statusWord ? (
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
            ) : (
              <span className="lp__kindmark"><KindIcon kind={config.kind} /></span>
            )}
          </span>

          {/* 15, not 20 — 17px is the tallest thing a session row contains and
              therefore the height of every row in every list. */}
          {avatar ? <Avatar actorId={avatar.actorId} provenance={avatar.provenance} label={avatar.label} size={15} src={avatar.src ?? null} /> : null}

          <button
            type="button"
            className={done ? 'lp__title lp__title--done' : 'lp__title'}
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
              <span className="lp__attention-label" title={row.badges.attention?.latestReason}>
                Needs attention
              </span>
            ) : null}
            {statusWord ? (
              <span className={`lp__word kit-pill--${statusTone}`} title={statusTitle}>
                {statusWord}
              </span>
            ) : null}
          </span>

          <span className="lp__rowactions">
            {(list.rowActions ?? []).map((ref) => (
              <RowAction
                key={ref}
                ref_={ref}
                row={row}
                props={props}
                openFlow={flowRef}
                onFlow={setFlowRef}
                onOpenLaunch={props.launch?.onFullOptions}
              />
            ))}
            {/* Add-to-collection on the COLLAPSED tile (user ruling
                2026-08-13) — the expanded strip already carries the labelled
                form; a curation verb two clicks deep is one the user reported
                as absent. Same component, icon anatomy, same gates. */}
            {list.membership ? (
              <RowMembershipControl row={row} props={props} control={list.membership} variant="icon" />
            ) : null}
            {/* D67 — the details disclosure, on EVERY standard tile.
                DELIBERATELY NOT the leading `lp__disclosure`: that chevron
                means "show this row's CHILDREN" on tree kinds, and giving one
                control two meanings would make a doc's expand ambiguous. This
                one trails the row, matching the control-card's `pn-tt__ind`. */}
            <button
              type="button"
              className={
                detailsExpanded ? 'lp__rowaction lp__rowaction--on' : 'lp__rowaction'
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
          </span>

        </div>
      </div>

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
