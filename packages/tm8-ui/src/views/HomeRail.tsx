/**
 * HomeRail — the unified Home's icon rail (task 01a00932 R4).
 *
 * ENTITIES ONLY: every row is a collection kind; there are no view rows here
 * ("there is no code and shit in the rails, only entities" — reporter ruling,
 * 2026-08-16). The rows come from `homeRailGroups()` — the same registry
 * table the list header's kind switcher flattens — so the rail and the
 * switcher cannot disagree about the population; only the arrangement
 * (visual grouping) differs. Clicking a row IS the switcher: one `onSelect`,
 * one root state, one route.
 *
 * ANATOMY: collapsed by default at 72px, each mark keeping its word beneath
 * it — the #269 ruling ("collapsed keeps the word") applied to this rail;
 * an icon-only strip identifiable only by hovering is the arrangement that
 * ruling exists to prevent. Expanded, rows widen to icon-beside-word. The
 * group header is drawn at BOTH widths — same reasoning one step up: a
 * subheading the default state hides is a subheading that does not exist.
 *
 * THE COLLAPSE FLAG IS THE HOST'S, NOT THIS COMPONENT'S (task 01a00ac2).
 * It used to live here as its own `usePanelFlag('home-rail-collapsed')`.
 * That stopped working the moment column A became resizable: `HomeView`'s
 * width solver has to subtract this rail's width before it can tell whether
 * A + B still fit beside C, and 72-vs-172 is the difference between "beside"
 * and "overlay" on a laptop. Two `usePanelFlag` hooks on one key would each
 * hold their own `useState` and drift apart on the first toggle, so the flag
 * is READ ONCE in the host and handed down. The storage key is unchanged.
 *
 * THREE BANDS, TOP TO BOTTOM (task 01a0fb09 "Icon Rail Collapse", reporter
 * ruling 2026-10-02 — 26 always-open rows was "too many entities"):
 *
 *   1. NEW — the quick-create buttons (task, chat, terminal). These create;
 *      they are the only non-entity controls here, and they sit in their own
 *      labelled group so the entity rows below stay entities only.
 *   2. PINNED — kinds the viewer pinned (Chats, Tasks, Sessions to start).
 *      Every row carries a pin toggle; a pinned kind leaves its group so no
 *      row is drawn twice.
 *   3. THE GROUPS — each header toggles its section in place. A group the
 *      viewer never toggled is closed unless it holds the active kind; once
 *      toggled, the choice is remembered. A closed group holding the active
 *      kind marks its header current, so the selection is never invisible.
 *
 * Like the collapse flag, pins and open state are the HOST's (`HomeView`
 * persists them through `homeRailStore`); this component draws and reports.
 */
import { KindIcon, type HomeRailGroup, type KindConfig } from '../domain';

export interface HomeRailCreate {
  kind: string;
  /** The verb's noun — "New task", "New terminal". */
  label: string;
  /** Refused with a reason rather than hidden (the cell's ＋ rule). */
  refusal: { cause: string; remedy: string } | null;
  onCreate(): void;
}

export interface HomeRailProps {
  groups: readonly HomeRailGroup[];
  /** The pinned kinds, in pin order — already resolved against the registry. */
  pinned: readonly KindConfig[];
  /** The quick-create buttons, in order. Empty draws no band. */
  create: readonly HomeRailCreate[];
  /** The active KIND root, or null while Chats is the root (no rail row is
   *  active then — chats live in the list header, not the rail). */
  activeKind: string | null;
  onSelect(kind: string): void;
  onTogglePin(kind: string): void;
  /** Explicit per-group choices; a missing id follows the default. */
  openGroups: Readonly<Record<string, boolean>>;
  onToggleGroup(groupId: string, open: boolean): void;
  /** Owned by `HomeView` — see the docblock. */
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function HomeRail({
  groups,
  pinned,
  create,
  activeKind,
  onSelect,
  onTogglePin,
  openGroups,
  onToggleGroup,
  collapsed,
  onToggleCollapsed,
}: HomeRailProps) {
  const pinnedKinds = new Set(pinned.map((config) => config.kind));
  const row = (config: KindConfig, isPinned: boolean) => (
    <div key={config.kind} className="hr-rail__item" data-kind={config.kind}>
      <button
        type="button"
        className="hr-rail__row"
        aria-current={config.kind === activeKind ? 'true' : undefined}
        title={config.labelPlural}
        onClick={() => onSelect(config.kind)}
      >
        <span className="hr-rail__glyph" aria-hidden>
          <KindIcon kind={config.kind} />
        </span>
        <span className="hr-rail__label">{config.labelPlural}</span>
      </button>
      <button
        type="button"
        className="hr-rail__pin"
        aria-pressed={isPinned}
        aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${config.labelPlural}`}
        title={isPinned ? `Unpin ${config.labelPlural}` : `Pin ${config.labelPlural} to the top`}
        onClick={() => onTogglePin(config.kind)}
      >
        <PinGlyph filled={isPinned} />
      </button>
    </div>
  );

  return (
    <nav
      className={`hr-rail${collapsed ? ' hr-rail--collapsed' : ''}`}
      aria-label="Entity lists"
      data-testid="home-rail"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="hr-rail__scroll">
        {create.length > 0 ? (
          <div className="hr-rail__band" role="group" aria-label="Create">
            <span className="hr-rail__eyebrow">New</span>
            <div className="hr-rail__create">
              {create.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  className="hr-rail__create-btn"
                  aria-label={item.label}
                  aria-disabled={item.refusal ? 'true' : undefined}
                  title={item.refusal ? `${item.refusal.cause} — ${item.refusal.remedy}` : item.label}
                  data-quick-kind={item.kind}
                  onClick={item.refusal ? (event) => event.preventDefault() : item.onCreate}
                >
                  <KindIcon kind={item.kind} />
                  <span className="hr-rail__create-plus" aria-hidden>
                    +
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {pinned.length > 0 ? (
          <div className="hr-rail__band" role="group" aria-label="Pinned">
            <span className="hr-rail__eyebrow">Pinned</span>
            {pinned.map((config) => row(config, true))}
          </div>
        ) : null}
        {groups.map((group) => {
          const kinds = group.kinds.filter((config) => !pinnedKinds.has(config.kind));
          if (kinds.length === 0) return null;
          const holdsActive = kinds.some((config) => config.kind === activeKind);
          const open = openGroups[group.id] ?? holdsActive;
          const bodyId = `hr-rail-group-${group.id}`;
          return (
            <div
              key={group.id}
              className="hr-rail__group"
              role="group"
              aria-label={group.label}
              data-group={group.id}
            >
              {/* The header keeps the eyebrow's job (task 01a0ada5) and adds
                  the section's count, so a closed group still says how much
                  is inside it. */}
              <button
                type="button"
                className="hr-rail__eyebrow hr-rail__group-toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                aria-current={!open && holdsActive ? 'true' : undefined}
                title={`${open ? 'Collapse' : 'Expand'} ${group.label}`}
                onClick={() => onToggleGroup(group.id, !open)}
              >
                <span className="hr-rail__chevron" aria-hidden>
                  {open ? '▾' : '▸'}
                </span>
                <span className="hr-rail__group-label">{group.label}</span>
                <span className="hr-rail__count" aria-hidden>
                  {kinds.length}
                </span>
              </button>
              {open ? (
                <div id={bodyId} className="hr-rail__group-body">
                  {kinds.map((config) => row(config, false))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="hr-rail__toggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand the rail' : 'Collapse the rail'}
        onClick={onToggleCollapsed}
      >
        <span aria-hidden>{collapsed ? '»' : '«'}</span>
      </button>
    </nav>
  );
}

/** A pushpin, outlined when unpinned and solid when pinned. */
function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M10.5 1.5 14.5 5.5 12 6.5 9.5 9 10 12.5 8.5 14 5.75 11.25 2 15 1 14 4.75 10.25 2 7.5 3.5 6 7 6.5 9.5 4Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
