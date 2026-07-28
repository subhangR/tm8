import { useCallback, useMemo, useRef, useState } from 'react';
import type { EntityCapabilities, EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type {
  ActionContext,
  ActionRef,
  KindConfig,
  LifecycleTab,
  ListRowFacts,
  LiveTreatment,
  QueryFilter,
  SortKey,
} from '../domain';
import { collectionKinds, getKind, resolveAction } from '../domain';
import { DisabledAction, DisabledIconControl, toReason } from './honesty/DisabledWithReason';
import { EmptyBody } from './detail/PanelStates';
import { useDismissable } from './useDismissable';

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

  onSelect?: (id: string) => void;
  onAction?: (ref: ActionRef, entityId: string) => void;
  onCreate?: () => void;
  onKindChange?: (kind: string) => void;
}

export function EntityListPanel(props: EntityListPanelProps) {
  const config = getKind(props.kind);
  const list = config.list;

  const [tabId, setTabId] = useState<string | null>(list.lifecycleTabs?.[0]?.id ?? null);
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

  const activeTab = list.lifecycleTabs?.find((t) => t.id === tabId) ?? null;

  return (
    <section
      className={props.compact ? 'lp lp--compact' : 'lp'}
      data-testid="entity-list-panel"
      data-kind={config.kind}
      aria-label={config.labelPlural}
    >
      <KindSelector
        config={config}
        liveCount={liveCountFor(props, config)}
        onKindChange={props.onKindChange}
      />

      <HeaderActions config={config} ctx={props.ctx} onCreate={props.onCreate} onAction={props.onAction} />

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
        tabs={list.lifecycleTabs}
        activeTabId={tabId}
        onTab={setTabId}
        compact={props.compact}
      />

      <div className="lp__body">
        {list.sections && list.sections.length > 0 ? (
          list.sections.map((section) => (
            <Band
              key={section.id}
              label={section.label}
              rows={rowsForBand(props, section.filter, activeTab, selected, config)}
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
            />
          ))
        ) : (
          <Band
            label={null}
            rows={rowsForBand(props, activeTab?.filter ?? {}, activeTab, selected, config)}
            props={props}
            config={config}
          />
        )}
      </div>
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
  tab: LifecycleTab | null,
  selected: Readonly<Record<string, readonly string[]>>,
  config: KindConfig,
): readonly EntitySummary[] {
  const rows = props.rowsFor({
    ...filter,
    ...(tab?.filter ?? {}),
    ...mergeSelectedFilters(config, selected),
  });
  if (!tab?.statuses) return rows;

  const allowed = new Set<string>(tab.statuses);
  return rows.filter((row) => {
    const state = row.state as unknown as Record<string, unknown>;
    return typeof state.status === 'string' && allowed.has(state.status);
  });
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
  liveCount,
  onKindChange,
}: {
  config: KindConfig;
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
          {config.chip.glyph}
        </span>
        {config.labelPlural}
        <span className="lp__caret" aria-hidden>
          ▾
        </span>
      </button>
      <span className="lp__spacer" />
      {liveCount ? (
        <span className="lp__livecount" data-testid="list-live-count">
          {liveCount}
        </span>
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
function FilterRow({
  config,
  selected,
  onToggleOption,
  sortKey,
  onSort,
  tabs,
  activeTabId,
  onTab,
  compact,
}: {
  config: KindConfig;
  selected: Readonly<Record<string, readonly string[]>>;
  onToggleOption: (specId: string, optionId: string, multi: boolean) => void;
  sortKey: SortKey | undefined;
  onSort: (key: SortKey) => void;
  tabs?: readonly LifecycleTab[];
  activeTabId: string | null;
  onTab: (id: string) => void;
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
      {/* Lifecycle tabs are SHELVES, not filters: a session leaves "live" by
          exiting, not by the viewer changing their mind. They replace the
          filter chips on the kinds that have them. */}
      {tabs && tabs.length > 0 ? (
        <span className="lp__tabs" role="tablist" aria-label="Lifecycle">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={tab.id === activeTabId ? 'lp__tab lp__tab--active' : 'lp__tab'}
              onClick={() => onTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </span>
      ) : (
        <>
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
        </>
      )}

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
}: {
  label: string | null;
  rows: readonly EntitySummary[];
  collapsed?: boolean;
  onToggle?: () => void;
  props: EntityListPanelProps;
  config: KindConfig;
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
        <EmptyBody
          glyph={config.chip.glyph}
          sentence={`No ${config.labelPlural.toLowerCase()} here yet — create one, or press / and type a name.`}
        />
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

  /**
   * THE GATE, in one expression. All three must hold: the registry declares
   * the pulse binding, the pool reports activity, and the verdict's treatment
   * actually carries a `streamingLabel`.
   *
   * That third term is the load-bearing one, and it is a SHAPE rather than a
   * rule I have to remember: the registry emits `streamingLabel` only for the
   * `live` verdict — stale, not-running and unknown deliberately carry none —
   * so there is no streaming word for this code to reach for on a non-live
   * row even if activity were somehow attributed to it. "Activity may refine a
   * live verdict but never promote a non-live one" is therefore enforced by
   * the data, not by this expression's good behaviour.
   */
  const streaming = Boolean(
    list.tile.pulse && props.activity?.[row.id] && treatment?.streamingLabel,
  );

  // The canvases word a live-and-moving session "streaming" and a live-and-
  // quiet one "running". The verdict alone cannot tell them apart, so the
  // registry supplies both words and the pulse binding picks between them.
  const fullWord = treatment ? (streaming ? treatment.streamingLabel : treatment.label) : null;
  /**
   * At the floors the SHORT word survives and the long form moves to detail —
   * T0-3 frame 4 draws exactly this ("stale", not "stale — node restarted",
   * captioned 'state word survives; "node restarted" moves to detail').
   * Without it a 31-character label sits in a nowrap flex:none slot wider than
   * the whole 200px row, and the title — the one element that is supposed to
   * absorb the loss — collapses to nothing instead (D34).
   *
   * `shortLabel ?? label` is the whole rule: a verdict whose label already
   * fits carries no shortLabel, so this is one expression rather than a table.
   * Streaming keeps its own word at any width — "streaming" is 9 characters.
   */
  const word =
    props.compact && treatment && !streaming ? (treatment.shortLabel ?? treatment.label) : fullWord;

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

      {treatment ? (
        <span
          className={[
            'lp__dot',
            `lp__dot--${treatment.tone}`,
            treatment.dot === null ? 'lp__dot--hollow' : '',
            streaming ? 'lp__dot--pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden
        />
      ) : null}

      <span className={done ? 'lp__title lp__title--done' : 'lp__title'} title={row.title}>
        {row.title}
      </span>

      {/* The badge slot YIELDS to the hover action cluster — the row never
          grows, so a hover cannot reflow the list under the cursor. */}
      <span className="lp__badges">
        {word ? (
          /* The full sentence never disappears — it stays on `title` for the
             pointer and on the reason for anyone reading the row aloud. */
          <span className={`lp__word kit-pill--${treatment?.tone}`} title={treatment?.reason ?? fullWord ?? word}>
            {word}
          </span>
        ) : null}
      </span>

      <span className="lp__rowactions">
        {(list.rowActions ?? []).map((ref) => (
          <RowAction key={ref} ref_={ref} row={row} props={props} />
        ))}
      </span>
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

