import { useCallback, useMemo, useRef, useState } from 'react';
import type { EntityCapabilities, EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type {
  ActionContext,
  ActionRef,
  KindConfig,
  LifecycleTier,
  ListRowFacts,
  LiveTreatment,
  QueryFilter,
  SortKey,
  CollectionMode,
} from '../domain';
import { ALL_MODES, collectionKinds, getKind, resolveAction } from '../domain';
import { Avatar } from '../kit';
import { DisabledAction, DisabledIconControl, toReason } from './honesty/DisabledWithReason';
import { EmptyBody } from './detail/PanelStates';
import { useDismissable } from './useDismissable';
import { HANDLED_SOURCES, renderBadge, type TileSlot } from './list/tile-badges';

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
  ctx: ActionContext;

  /** THE verdict. Required for kinds whose ListConfig has a liveTreatment. */
  livenessOf?: (id: string) => SessionLiveness;
  /** Pool activity signal, per session. Gated on the verdict. */
  activity?: Readonly<Record<string, boolean>>;
  /** The seam's live set — the ONLY source for the '● N live' count. */
  liveIds?: readonly string[];
  /** Server capability truth per row. Absent ⇒ unknown ⇒ NOT permitted. */
  capabilitiesOf?: (id: string) => EntityCapabilities | undefined;

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
  onCreate?: () => void;
  onKindChange?: (kind: string) => void;
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
  const [sortKey, setSortKey] = useState(list.sort.find((s) => s.default)?.key ?? list.sort[0]?.key);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<CollectionMode>(config.defaultMode);

  const activeTier = list.lifecycle?.find((t) => t.id === tierId) ?? null;

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

      <HeaderActions config={config} ctx={props.ctx} onCreate={props.onCreate} onAction={props.onAction} />

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
      />

      <div className="lp__body">
        {list.sections && list.sections.length > 0 ? (
          list.sections.map((section) => (
            <Band
              key={section.id}
              label={section.label}
              rows={matching(rowsForBand(props, section.filter, activeTier, selected, config), query)}
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
            rows={matching(rowsForBand(props, activeTier?.filter ?? {}, activeTier, selected, config), query)}
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
): readonly EntitySummary[] {
  const rows = props.rowsFor({
    ...filter,
    ...(tier?.filter ?? {}),
    ...mergeSelectedFilters(config, selected),
  });
  // D20's client partition survives the rename unchanged: read STRUCTURALLY,
  // never by kind literal.
  if (!tier?.statuses) return rows;

  const allowed = new Set<string>(tier.statuses);
  return rows.filter((row) => {
    const state = row.state as unknown as Record<string, unknown>;
    return typeof state.status === 'string' && allowed.has(state.status);
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
  onAction,
}: {
  config: KindConfig;
  ctx: ActionContext;
  onCreate?: () => void;
  onAction?: (ref: ActionRef, entityId: string) => void;
}) {
  const { quickCreate, quickLaunch } = config.list;
  if (!quickCreate && !quickLaunch) return null;

  return (
    <div className="lp__actions">
      {quickCreate ? (
        <button type="button" className="lp__new" onClick={onCreate}>
          ＋ New
        </button>
      ) : null}
      {quickLaunch ? <QuickLaunch ref_={quickLaunch} ctx={ctx} onAction={onAction} /> : null}
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
  const availability = def.availability(ctx);
  if (availability.kind === 'disabled') {
    return <DisabledAction reason={toReason(availability.reason)}>{`${def.label} ▸`}</DisabledAction>;
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
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useDismissable(pickerOpen, barRef, useCallback(() => setPickerOpen(false), []));
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
      {config.list.filters.length > 0 ? (
        <button
          type="button"
          className="lp__chip"
          onClick={() => setPickerOpen((o) => !o)}
          aria-expanded={pickerOpen}
          aria-haspopup="menu"
          data-testid="filter-trigger"
        >
          filter ▾
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
      {pickerOpen ? (
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
      {/* NEEDS YOU sorts above idle (R8-dormant predicate). It is its own band
          with its own amber eyebrow, because "an agent is waiting on you" is a
          different class of fact from "these are your open items". */}
      {attention.length > 0 ? (
        <>
          <div className="lp__eyebrow lp__eyebrow--attention">{`NEEDS YOU · ${attention.length}`}</div>
          {attention.map((row) => (
            <Tile key={row.id} row={row} props={props} config={config} attention />
          ))}
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
 * The NEEDS-YOU split. The predicate is registry data and takes the seam
 * verdict as a PARAMETER — it never computes liveness. Without a verdict
 * source the group simply does not fire, which is the correct dormant
 * behaviour rather than a guess.
 */
function splitAttention(
  rows: readonly EntitySummary[],
  props: EntityListPanelProps,
  config: KindConfig,
): { attention: EntitySummary[]; rest: EntitySummary[] } {
  const predicate = config.list.needsAttentionGroup;
  if (!predicate || !props.livenessOf) return { attention: [], rest: [...rows] };

  const attention: EntitySummary[] = [];
  const rest: EntitySummary[] = [];
  for (const row of rows) {
    (predicate(toRowFacts(row), props.livenessOf(row.id)) ? attention : rest).push(row);
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
  const ordered = useMemo(() => {
    if (!config.list.tree) return rows.map((row) => ({ row, depth: 0 }));

    const present = new Set(rows.map((r) => r.id));
    const childrenOf = new Map<string, EntitySummary[]>();
    const roots: EntitySummary[] = [];
    for (const row of rows) {
      const parent = row.parentId && present.has(row.parentId) ? row.parentId : null;
      if (!parent) roots.push(row);
      else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row]);
    }
    const out: Array<{ row: EntitySummary; depth: number }> = [];
    const walk = (row: EntitySummary, depth: number) => {
      out.push({ row, depth });
      for (const child of childrenOf.get(row.id) ?? []) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    return out;
  }, [rows, config.list.tree]);

  return (
    <>
      {ordered.map(({ row, depth }) => (
        <Tile key={row.id} row={row} depth={depth} props={props} config={config} />
      ))}
    </>
  );
}

function Tile({
  row,
  depth = 0,
  props,
  config,
  attention = false,
}: {
  row: EntitySummary;
  depth?: number;
  props: EntityListPanelProps;
  config: KindConfig;
  attention?: boolean;
}) {
  const list = config.list;
  const verdict = props.livenessOf?.(row.id);
  const treatment: LiveTreatment | null =
    list.liveTreatment && verdict ? list.liveTreatment(verdict) : null;

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

  return (
    <div
      className={[
        'lp__tile',
        selected ? 'lp__tile--selected' : '',
        attention ? 'lp__tile--attention' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={depth > 0 ? { paddingLeft: 10 + depth * 17 } : undefined}
      data-testid="list-tile"
      data-depth={depth}
      data-streaming={streaming ? 'true' : 'false'}
      onClick={() => props.onSelect?.(row.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect?.(row.id);
        }
      }}
    >
      {config.list.tree && depth > 0 ? (
        <span className="lp__guide" style={{ left: 4 + depth * 17 }} aria-hidden />
      ) : null}

      {/* Line 1 — dot · avatar · title · status word (T0-1 1e). */}
      <div className="lp__row1">
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
            aria-hidden
          />
        ) : null}

        {avatar ? (
          <Avatar provenance={avatar.provenance} label={avatar.label} size={15} />
        ) : null}

        <span className={done ? 'lp__title lp__title--done' : 'lp__title'} title={row.title}>
          {row.title}
        </span>

        {/* The badge slot YIELDS to the action cluster on hover — the row never
            grows, so hovering cannot reflow the list under the cursor. */}
        <span className="lp__badges">
          {statusWord ? (
            <span className={`lp__word kit-pill--${statusTone}`} title={statusTitle}>
              {statusWord}
            </span>
          ) : null}
        </span>

        <span className="lp__rowactions">
          {(list.rowActions ?? []).map((ref) => (
            <RowAction key={ref} ref_={ref} row={row} props={props} />
          ))}
        </span>
      </div>

      {/* Line 2 — mono meta, then the priority tag. Rendered only when the
          row actually has something to say; an empty second line would be
          chrome pretending to be content. */}
      {metas.length > 0 || tag ? (
        <div className="lp__row2">
          <span className="lp__meta">{metas.join(' · ')}</span>
          {tag ? (
            <span className={`lp__tag kit-pill--${tag.tone}`}>
              {props.compact ? tag.label.slice(0, 2) : tag.label}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
}: {
  ref_: ActionRef;
  row: EntitySummary;
  props: EntityListPanelProps;
}) {
  const def = resolveAction(ref_);
  const ctx: ActionContext = {
    ...props.ctx,
    entityId: row.id,
    kind: row.kind,
    capabilities: props.capabilitiesOf?.(row.id) ?? null,
    liveness: props.livenessOf?.(row.id),
  };
  const availability = def.availability(ctx);

  if (availability.kind === 'disabled') {
    return (
      <DisabledIconControl
        label={`${def.label} — unavailable`}
        glyph={def.icon}
        reason={toReason(availability.reason)}
      />
    );
  }
  return (
    <button
      type="button"
      className="lp__rowaction"
      title={def.label}
      aria-label={def.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onAction?.(ref_, row.id);
      }}
    >
      {def.icon}
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
