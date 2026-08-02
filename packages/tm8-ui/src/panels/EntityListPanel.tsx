import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ActorSummary, EntityCapabilities, EntitySummary, ExecutionSpawnInput } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type {
  ActionContext,
  ActionRef,
  KindConfig,
  LaunchCapacity,
  LaunchProjectOption,
  LifecycleTier,
  ListRowFacts,
  LiveTreatment,
  ProfileResolution,
  QueryFilter,
  SortKey,
  StateControl,
  StatusPillSpec,
  TeammateLaunchState,
  CollectionMode,
} from '../domain';
import { ALL_MODES, collectionKinds, getKind, resolveAction } from '../domain';
import { Avatar, type PillTone } from '../kit';
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
import { HANDLED_SOURCES, renderBadge, type TileSlot } from './list/tile-badges';
import { MaestroTaskTile } from './list/MaestroTaskTile';
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
 * WHERE ROWS COME FROM. `rowsFor(filter)` is injected — the shell backs it
 * with seam-hydrated, domain-store-selected data per (kind, filter) query key.
 * The panel therefore never issues a query itself, which is also what keeps
 * it free of kind literals.
 */

export interface EntityListPanelProps {
  /** Which registry row drives this panel. A miss lands on the `c:*` row. */
  kind: string;
  /** Rows for a filter — seam-hydrated and store-selected by the shell. */
  rowsFor: (filter: QueryFilter) => readonly EntitySummary[];
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
  /** Real `working_on` targets for session tiles, projected by the shell. */
  linkedTasksOf?: (id: string) => readonly EntitySummary[];

  selectedId?: string | null;
  /** True at the 200/220px floors: metas drop, badges abbreviate. */
  compact?: boolean;

  /**
   * Focus handle for the D36 `list.search` command (`f`). The keyboard
   * controller emits the command and consumes the event; it never touches the
   * DOM — the shell calls this on the FOCUSED panel.
   */
  searchInputRef?: React.Ref<HTMLInputElement>;
  onSelect?: (id: string) => void;
  onAction?: (ref: ActionRef, entityId: string) => void;
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
   */
  onSetState?: (entityId: string, next: string, via: ActionRef) => void;

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
  const [mode, setMode] = useState<CollectionMode>(config.defaultMode);

  const activeTier = list.lifecycle?.find((t) => t.id === tierId) ?? null;
  const members = props.members ?? EMPTY_MEMBERS;

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
            ? list.lifecycle.reduce((n, tier) => n + tierCount(props, config, tier), 0)
            : undefined
        }
        liveCount={liveCountFor(props, config)}
        onKindChange={props.onKindChange}
        mode={mode}
        onMode={setMode}
      />

      <HeaderActions config={config} ctx={props.ctx} onCreate={props.onCreate} createSlot={props.createSlot} onAction={props.onAction} />

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
        tierCount={(tier: LifecycleTier) => tierCount(props, config, tier)}
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
        tiers={list.lifecycle}
        activeTierId={tierId}
        onTier={setTierId}
        tierCount={(tier: LifecycleTier) => tierCount(props, config, tier)}
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
      />

      <div className="lp__body">
        {list.sections && list.sections.length > 0 ? (
          list.sections.map((section) => (
            <Band
              key={section.id}
              label={section.label}
              rows={matching(rowsForBand(props, section.filter, activeTier, selected, config, selectedPeople), query)}
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
            rows={matching(rowsForBand(props, activeTier?.filter ?? {}, activeTier, selected, config, selectedPeople), query)}
            props={props}
            config={config}
            query={query}
          />
        )}
      </div>

      {/* T0-1 draws a footer count line on every kind: "9 open · 601 done ·
          33 archived". Same per-tier counts as the tabs above — one source,
          three surfaces (tabs, footer, selector total). */}
      {list.lifecycle && list.lifecycle.length > 0 ? (
        <div className="lp__foot" data-testid="list-footer">
          {list.lifecycle
            .map((tier) => `${tierCount(props, config, tier)} ${tier.id}`)
            .join(' · ')}
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
function rowsForBand(
  props: EntityListPanelProps,
  filter: QueryFilter,
  tier: LifecycleTier | null,
  selected: Readonly<Record<string, readonly string[]>>,
  config: KindConfig,
  selectedPeople: readonly string[] = [],
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
  return props.rowsFor({
    ...filter,
    ...(tier?.filter ?? {}),
    ...mergeSelectedFilters(config, selected),
    ...(selectedPeople.length > 0 ? { createdByIds: selectedPeople } : {}),
  });
}

/**
 * A tier's count is its OWN query's result size — the same source the tab
 * label, the footer line and the kind-selector total all read. A count FIELD
 * would be a second source that could disagree with the query it claims to
 * summarise (A1a's design note, and it is the right one).
 *
 * An `unsupported` tier counts ZERO honestly: the kind has no state that can
 * land there, so the tab renders with its reason rather than being dropped.
 */
function tierCount(props: EntityListPanelProps, config: KindConfig, tier: LifecycleTier): number {
  if (tier.unsupported) return 0;
  return rowsForBand(props, tier.filter, tier, {}, config).length;
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
  /** Sum of the lifecycle tiers — T0-1 draws it beside the kind name. */
  total?: number;
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
          {config.chip.glyph}
        </span>
        {config.labelPlural}
        <span className="lp__caret" aria-hidden>
          ▾
        </span>
      </button>
      <span className="lp__spacer" />
      {typeof total === 'number' ? (
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
                <span aria-hidden>{k.chip.glyph}</span>
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
        const built = m === 'list';
        const reason =
          m === 'graph'
            ? 'Graph view isn’t available yet.'
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
}: {
  config: KindConfig;
  ctx: ActionContext;
  onCreate?: () => void;
  createSlot?: React.ReactNode;
  onAction?: (ref: ActionRef, entityId: string) => void;
}) {
  const { quickCreate, quickLaunch } = config.list;
  const showCreate = Boolean(quickCreate && (createSlot || onCreate));
  const showLaunch = Boolean(quickLaunch && onAction);
  if (!showCreate && !showLaunch) return null;

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
      {showLaunch && quickLaunch ? <QuickLaunch ref_={quickLaunch} ctx={ctx} onAction={onAction} /> : null}
    </div>
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
  tierCount,
}: {
  tiers?: readonly LifecycleTier[];
  activeTierId: string | null;
  onTier: (id: string) => void;
  tierCount: (tier: LifecycleTier) => number;
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
          {`${tier.label} ${tierCount(tier)}`}
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
  tierCount,
  compact,
  people,
  selectedPeople,
  onTogglePerson,
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
  tierCount: (tier: LifecycleTier) => number;
  compact?: boolean;
  people: readonly ActorSummary[];
  selectedPeople: readonly string[];
  onTogglePerson: (actorId: string) => void;
}) {
  const [picker, setPicker] = useState<'filters' | 'people' | null>(null);
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

      <span className="lp__spacer" />

      {current ? (
        <button
          type="button"
          className="lp__chip"
          onClick={() => {
            const i = sort.findIndex((s) => s.key === current.key);
            const next = sort[(i + 1) % sort.length];
            if (next) onSort(next.key);
          }}
          title={`Sort by ${current.label}`}
        >
          {/* At the floor the sort chip collapses to its glyph — T0-3 frame 4
              draws exactly `↓`. The chip never disappears. */}
          {compact ? '↓' : `↓ ${current.label}`}
        </button>
      ) : null}

    </div>
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
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
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
 */
function mergeSelectedFilters(
  config: KindConfig,
  selected: Readonly<Record<string, readonly string[]>>,
): QueryFilter {
  const out: Record<string, unknown> = {};
  for (const spec of config.list.filters) {
    for (const optionId of selected[spec.id] ?? []) {
      const option = spec.options.find((o) => o.id === optionId);
      if (!option) continue;
      for (const [key, value] of Object.entries(option.filter as Record<string, unknown>)) {
        const prior = out[key];
        out[key] =
          Array.isArray(prior) && Array.isArray(value) ? [...prior, ...value] : value;
      }
    }
  }
  return out as QueryFilter;
}

// ---------------------------------------------------------------------------
// Bands, trees, tiles
// ---------------------------------------------------------------------------

function Band({
  label,
  rows,
  collapsed,
  onToggle,
  props,
  config,
  query,
}: {
  label: string | null;
  rows: readonly EntitySummary[];
  collapsed?: boolean;
  onToggle?: () => void;
  props: EntityListPanelProps;
  config: KindConfig;
  /** Present ⇒ an empty band means "no matches", not "nothing here". */
  query?: string;
}) {
  const { attention, rest } = splitAttention(rows, props, config);

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
      {/* NEEDS ATTENTION sorts above the ordinary band. It is its own amber band
          because an explicit request for human attention is a
          different class of fact from "these are your open items". */}
      {attention.length > 0 ? (
        <>
          <div className="lp__eyebrow lp__eyebrow--attention">{`NEEDS ATTENTION · ${attention.length}`}</div>
          {/* Same tree class as the main band — a control-card kind must not
              render its NEEDS-YOU rows as gapped cards and its ordinary rows
              as an attached column. */}
          <div className={treeClass(config)} role="list">
            {attention.map((row) => (
              <div key={row.id} className="lp__branch" role="listitem">
                <Tile row={row} props={props} config={config} attention />
              </div>
            ))}
          </div>
        </>
      ) : null}

      {label ? (
        <button type="button" className="lp__eyebrow" onClick={onToggle}>
          {`${label.toUpperCase()} · ${rest.length}`}
        </button>
      ) : null}

      {rest.length === 0 && attention.length === 0 ? (
        /*
         * A filter that hides every row and says nothing looks identical to a
         * list that failed to load (A1a's ask). The two states get different
         * sentences: one names the query and offers the way back, the other
         * teaches the gesture that fills the list.
         */
        query && query.trim().length > 0 ? (
          <EmptyBody
            glyph={config.chip.glyph}
            sentence={`No ${config.labelPlural.toLowerCase()} match “${query.trim()}”. Clear the search to see them all.`}
          />
        ) : (
          <EmptyBody
            glyph={config.chip.glyph}
            sentence={`No ${config.labelPlural.toLowerCase()} here yet — create one, or press / and type a name.`}
          />
        )
      ) : (
        <TreeRows rows={rest} props={props} config={config} />
      )}
    </>
  );
}

/**
 * Explicit attention is universal entity-envelope data and therefore works
 * for every kind. A kind may additionally contribute a registry predicate
 * (currently session liveness); that predicate remains dormant without its
 * authoritative liveness source.
 */
function splitAttention(
  rows: readonly EntitySummary[],
  props: EntityListPanelProps,
  config: KindConfig,
): { attention: EntitySummary[]; rest: EntitySummary[] } {
  const predicate = config.list.needsAttentionGroup;

  const attention: EntitySummary[] = [];
  const rest: EntitySummary[] = [];
  for (const row of rows) {
    const derivedAttention = Boolean(
      predicate && props.livenessOf && predicate(toRowFacts(row), props.livenessOf(row.id)),
    );
    (row.badges.attention || derivedAttention ? attention : rest).push(row);
  }
  return { attention, rest };
}

function toRowFacts(row: EntitySummary): ListRowFacts {
  const state = row.state as unknown as Record<string, unknown>;
  return {
    id: row.id,
    kind: row.kind,
    activityAt: row.activityAt,
    status: typeof state.status === 'string' ? state.status : null,
    blockedCount: row.badges.blocked?.unresolvedHardDependencyCount ?? 0,
  };
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
}: {
  rows: readonly EntitySummary[];
  props: EntityListPanelProps;
  config: KindConfig;
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
 * D67 — THE EXPANDED ROW'S STATE + ARCHIVE STRIP, shared by every list style.
 *
 * USER RULING 2026-08-02: "in every entity list style, each entity should have
 * an option to change its state as a dropdown when the entity is expanded on
 * the entity list itself... there is also an archived state, and the archived
 * state UI state works on top of the archived state."
 *
 * ONE COMPONENT, THREE ANATOMIES. The control-card, the session tree and the
 * standard tile all mount THIS — so a task, a session and a doc get the same
 * strip from the same code, and adding a fourth anatomy cannot forget it.
 *
 * WHY ARCHIVE SITS BESIDE THE DROPDOWN RATHER THAN INSIDE IT. They are two
 * different layers, and the ruling names both: the dropdown writes the kind's
 * OWN state (a task's `workStatus`), while archive writes the TOMBSTONE
 * (`entities.deleted_at`) that every kind shares and that the Archived
 * lifecycle tier queries as `deleted: 'only'`. Folding "Archived" into the
 * state list would claim it is a work status — it is not, a task keeps its
 * `workStatus` across an archive/restore round-trip (verified on this node),
 * and only 5 of 19 kinds have a state list to fold it into at all.
 *
 * ARCHIVE FLIPS TO RESTORE ON `deletedAt`, which is a STRUCTURAL read of the
 * envelope, not a kind branch: every kind carries it.
 */
function RowDetail({
  row,
  props,
  config,
}: {
  row: EntitySummary;
  props: EntityListPanelProps;
  config: KindConfig;
}) {
  const control = config.list.stateControl;
  const archived = row.deletedAt != null;

  return (
    <div className="lp__rowdetail" onClick={(e) => e.stopPropagation()}>
      <div className="lp__rowdetail-line">
        <span className="lp__rowdetail-label">{control?.label ?? 'State'}</span>
        <RowStateControl row={row} props={props} control={control} pill={config.panel.statusPill} />
      </div>
      <div className="lp__rowdetail-line">
        <span className="lp__rowdetail-label">Archive</span>
        {/* The tombstone verb. `restore` when this row is already archived —
            the Archived tier is where a user meets these rows, and a tier that
            could only put things IN would be a one-way door. */}
        <RowAction
          ref_={archived ? 'restore' : 'archive'}
          row={row}
          props={props}
          onRun={props.onArchive}
          variant="wide"
        />
      </div>
    </div>
  );
}

/**
 * The state dropdown, or the honest reason there is not one.
 *
 * FOUR DISTINCT REFUSALS, kept apart because collapsing them is how a UI
 * starts lying about which thing is missing:
 *
 *   no `stateControl`  — this KIND has no state to set (14 of 19 core kinds).
 *   `readOnlyReason`   — it HAS a state, but the node observes it (sessions).
 *   capabilities absent — not refused, still LOADING (the CheckingPermission
 *                        vocabulary, never the disabled one).
 *   no `onSetState`    — the host did not wire the write; disabled-with-reason
 *                        rather than a select that silently drops the change.
 */
function RowStateControl({
  row,
  props,
  control,
  pill,
}: {
  row: EntitySummary;
  props: EntityListPanelProps;
  control: StateControl | undefined;
  /** The kind's existing value→word / value→tone map. The ONLY source for both. */
  pill: StatusPillSpec | undefined;
}) {
  const selectId = useId();
  const wordFor = (value: string): string =>
    pill?.labels?.[value] ?? value.replace(/_/g, ' ');
  const toneFor = (value: string): PillTone => pill?.tones?.[value] ?? 'idle';

  if (!control) {
    return (
      <DisabledAction
        label="Change state"
        reason={{
          cause: `${getKind(props.kind).label} has no state to set on this node`,
          remedy: 'the contract records no status field for this kind, so nothing could be written',
        }}
      >
        <span className="lp__statesel lp__statesel--absent">no state</span>
      </DisabledAction>
    );
  }

  // Structural read of the state envelope: the registry names the FIELD, so no
  // kind is named here and a new stateful kind needs no edit to this file.
  const state = row.state as unknown as Record<string, unknown>;
  const raw = state[control.source];
  const current = typeof raw === 'string' ? raw : '';
  const currentPill = (
    <span className={`lp__statesel kit-pill--${toneFor(current)}`}>
      {current === '' ? 'unknown' : wordFor(current)}
    </span>
  );

  if (control.readOnlyReason) {
    return (
      <DisabledAction label="Change state" reason={toReason(control.readOnlyReason)}>
        {currentPill}
      </DisabledAction>
    );
  }

  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return <CheckingPermission label="Change state" />;
  }

  const availability = resolveAction(control.command).availability({
    ...props.ctx,
    entityId: row.id,
    kind: row.kind,
    capabilities: props.capabilitiesOf?.(row.id) ?? null,
    liveness: props.livenessOf?.(row.id),
  });

  if (availability.kind === 'disabled') {
    return (
      <DisabledAction label="Change state" reason={toReason(availability.reason)}>
        {currentPill}
      </DisabledAction>
    );
  }

  if (!props.onSetState) {
    return (
      <DisabledAction label="Change state" reason={NOT_WIRED_REASON}>
        {currentPill}
      </DisabledAction>
    );
  }

  return (
    // The wrapper exists ONLY to own the caret: see `.lp__statewrap::after`.
    // The select cannot draw its own, because the pill tone class it carries
    // sets the `background` shorthand and would reset any background-image.
    <span className="lp__statewrap">
    <select
      id={selectId}
      className={`lp__statesel lp__statesel--live kit-pill--${toneFor(current)}`}
      aria-label={`Change state for ${row.title}`}
      data-testid="row-state-select"
      value={current}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.target.value;
        if (next === current) return;
        const chosen = control.options.find((o) => o.id === next);
        // The option's own `via` wins: `done` must reach the completion verb,
        // which carries the acceptance-criteria gate the work verb refuses.
        props.onSetState?.(row.id, next, chosen?.via ?? control.command);
      }}
    >
      {/* A value the registry does not list still shows, rather than the select
          silently snapping to its first option and MISREPORTING the record. */}
      {!control.options.some((o) => o.id === current) && current !== '' ? (
        <option value={current}>{wordFor(current)}</option>
      ) : null}
      {control.options.map((o) => (
        <option key={o.id} value={o.id}>
          {wordFor(o.id)}
        </option>
      ))}
    </select>
    </span>
  );
}

function Tile({
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

  if (sessionTree) {
    const state = row.state as unknown as Record<string, unknown>;
    const recordedStatus = typeof state.status === 'string' ? state.status : 'idle';
    const agentTool = typeof state.agentTool === 'string' ? state.agentTool : null;
    const model = typeof state.model === 'string' ? state.model : null;
    const live = verdict === 'live';
    return (
      <MaestroSessionTile
        id={row.id}
        title={row.title || 'Session'}
        agentTool={agentTool}
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
        detail={<RowDetail row={row} props={props} config={config} />}
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
        actions={(list.rowActions ?? []).map((ref) => (
          <RowAction
            key={ref}
            ref_={ref}
            row={row}
            props={props}
            openFlow={flowRef}
            onFlow={setFlowRef}
          />
        ))}
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
        <div className="pn-tt__metarow">
          {statusWord ? (
            <span className={`pn-badge pn-badge--status-${statusTone}`}>
              <span
                className={[
                  'lp__dot',
                  `lp__dot--${statusTone}`,
                  statusHollow ? 'lp__dot--hollow' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden
              />
              {statusWord}
            </span>
          ) : null}
          {tag ? (
            <span className={`pn-badge pn-badge--priority pn-badge--priority-${tag.tone}`}>
              {tag.label}
            </span>
          ) : null}
          <span className="pn-badge pn-badge--assignees">
            <span className="pn-badge__people" aria-hidden>
              {controlFacts.assignees.length > 0
                ? controlFacts.assignees.slice(0, 3).map((actor) => (
                    <Avatar
                      key={actor.id}
                      actorId={actor.id}
                      provenance={actor.isAgent ? 'agent' : 'human'}
                      label={actor.displayName}
                      /* 15, not 20 — the avatar sits INSIDE a 24px chip and
                         must not be what sets the chip's height. 15 is the
                         smallest step `AvatarSize` offers. */
                      size={15}
                    />
                  ))
                : '♙'}
            </span>
            {controlFacts.assigneeLabel}
          </span>
        </div>

        {flowRef ? (
          <div className="lp__flow lp__flow--control">
            <LaunchQuickConfig
              subject={row}
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
          <span className="pn-tt__time">{relativeTileTime(row.updatedAt)}</span>
        </div>

        {/* D67 — the state + archive strip. Last inside the expand, under the
            facts, because it WRITES and everything above it reads. */}
        <RowDetail row={row} props={props} config={config} />
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
              <span className="lp__kindmark">{config.chip.glyph}</span>
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
              />
            ))}
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

      {detailsExpanded ? <RowDetail row={row} props={props} config={config} /> : null}

      {/* The config is an attached card section, not a popover: the subject
          remains obvious while teammate/model choices are changed. */}
      {flowRef ? (
        <div className="lp__flow" onClick={(e) => e.stopPropagation()}>
          <LaunchQuickConfig
            subject={row}
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
  assigneeLabel: string;
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
  const assigneeLabel =
    assignees.length === 0
      ? 'Unassigned'
      : assignees.length === 1
        ? assignees[0].displayName
        : `${assignees[0].displayName} +${assignees.length - 1}`;

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

  return { assignees, assigneeLabel, meta };
}

function relativeTileTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'updated recently';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return 'updated now';
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.round(hours / 24)}d ago`;
}

/**
 * Row quick-actions are the SAME ActionRefs as the panel primaries, ⌘Enter and
 * the palette rows (§2.5) — one verb, one availability rule, one reason
 * string, four surfaces. Capabilities come from server truth; ABSENT means
 * unknown, and unknown means not permitted rather than optimistically enabled.
 */
function RowAction({
  ref_,
  row,
  props,
  openFlow,
  onFlow,
  onRun,
  variant = 'icon',
}: {
  ref_: ActionRef;
  row: EntitySummary;
  props: EntityListPanelProps;
  openFlow?: ActionRef | null;
  onFlow?: (ref: ActionRef | null) => void;
  /**
   * The handler for THIS verb, when the host wired one separately from the
   * general `onAction`. Keeps one gating path (capabilities → checking →
   * disabled → enabled) for every row verb rather than a second copy beside it.
   */
  onRun?: (ref: ActionRef, entityId: string) => void;
  /**
   * `wide` carries the LABEL beside the glyph. The hover-revealed row cluster
   * is a fixed-width icon strip; inside an expanded detail strip there is room
   * for the word, and an archive control is not one to leave as a bare glyph.
   */
  variant?: 'icon' | 'wide';
}) {
  const def = resolveAction(ref_);
  const wide = variant === 'wide';
  const ctx: ActionContext = {
    ...props.ctx,
    entityId: row.id,
    kind: row.kind,
    capabilities: props.capabilitiesOf?.(row.id) ?? null,
    liveness: props.livenessOf?.(row.id),
  };

  /**
   * D44 — a flow verb opens its config instead of dispatching, so it is NOT
   * enabled-inert without `onAction`: clicking genuinely does something, and
   * the config states for itself whether it can commit. Asking the resolved
   * def for `flow` keeps this free of both kind and action-id literals.
   */
  const opensFlow = def.flow === 'launch' && onFlow != null;

  /**
   * A `wide` control refuses in the WIDE vocabulary too.
   *
   * The icon refusal is a bare glyph with a hover tooltip, which is right for
   * a 22px cluster button and wrong here: verified in Chrome, the disabled
   * Archive rendered as an unlabelled square directly beneath a STATE row that
   * printed its reason as visible text. Same strip, same refusal, two
   * different honesty vocabularies — and the quieter one was the destructive
   * verb. `DisabledAction` carries the word and the reason, matching the row
   * above it.
   */
  const refuse = (reason: UnavailableReason) =>
    wide ? (
      <DisabledAction label={def.label} reason={reason}>
        <span className="lp__rowaction lp__rowaction--wide lp__rowaction--off">
          <span aria-hidden>{def.icon}</span>
          <span className="lp__rowaction-label">{def.label}</span>
        </span>
      </DisabledAction>
    ) : (
      <DisabledIconControl label={def.label} glyph={def.icon} reason={reason} />
    );

  const run = onRun ?? props.onAction;
  if (!run && !opensFlow) {
    return refuse(NOT_WIRED_REASON);
  }

  /**
   * Not-yet-loaded is not not-permitted. A capability SOURCE that has not
   * answered for this row yet renders in the loading vocabulary; only a
   * source that answered "no" renders the refusal. Without this split both
   * land on the same disabled button and a transient state reads as a
   * permanent one.
   */
  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return <CheckingPermission label={def.label} glyph={def.icon} />;
  }

  const availability = def.availability(ctx);

  if (availability.kind === 'disabled') {
    return refuse(toReason(availability.reason));
  }
  const expanded = openFlow === ref_;
  return (
    <button
      type="button"
      className={[
        'lp__rowaction',
        wide ? 'lp__rowaction--wide' : '',
        expanded ? 'lp__rowaction--on' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={def.label}
      aria-label={def.label}
      aria-expanded={opensFlow ? expanded : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (opensFlow) {
          onFlow?.(expanded ? null : ref_);
          return;
        }
        run?.(ref_, row.id);
      }}
    >
      <span aria-hidden>{def.icon}</span>
      {wide ? <span className="lp__rowaction-label">{def.label}</span> : null}
    </button>
  );
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
