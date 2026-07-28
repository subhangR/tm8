import type { EntityDetail, EntityState } from '@tm8/contract';
import type { ActionContext, ActionRef, KindConfig, StatusSource } from '../../domain';
import { resolveAction } from '../../domain';
import { IconBtn, Pill, type PillTone } from '../../kit';
import { DisabledAction, DisabledIconControl, toReason } from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';

/**
 * THE SHARED CHROME — header · action bar · tab strip · footer.
 *
 * This anatomy is FIXED for every kind (02-LAYOUT §3, T0-4 frame 1). The only
 * per-kind region in the whole panel is the Content body; everything here is
 * driven by registry DATA, so adding a kind adds a row, never a branch (L2).
 *
 * The same component instances serve the peek stack, the pinned columns and
 * Z4 — `host` changes width and chrome, never anatomy, so a panel is
 * recognisably the same object wherever it is shown.
 */

export type PanelHost = 'stack' | 'pinned' | 'peek' | 'z4';

export type PanelTab = 'content' | 'discussion' | 'connections' | 'activity';

/**
 * D3: FOUR TABS ALWAYS, fixed order, every kind, no exceptions. The two T5-7
 * three-tab mocks are mock abbreviation, and the ruling says so explicitly —
 * so this array is a constant, never a computed list.
 */
export const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'discussion', label: 'Discussion' },
  { id: 'connections', label: 'Connections' },
  { id: 'activity', label: 'Activity' },
];

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function PanelHeader({
  detail,
  config,
  breadcrumb,
  pinned = false,
  pinRefusal,
  onPin,
  onPromote,
  onClose,
  onOverflow,
}: {
  detail: EntityDetail;
  config: KindConfig;
  breadcrumb?: string;
  pinned?: boolean;
  /** Why pinning is refused right now (floors, 3-pin cap). L6: shown, not hidden. */
  pinRefusal?: string;
  onPin?: () => void;
  onPromote?: () => void;
  onClose?: () => void;
  onOverflow?: () => void;
}) {
  const editable = detail.capabilities.canEdit && !detail.deletedAt;
  return (
    <div className="pn-head" data-testid="panel-header">
      {breadcrumb ? <div className="pn-crumb">{breadcrumb}</div> : null}
      <div className="pn-head__row">
        <span className="pn-head__glyph" aria-hidden>
          {config.chip.glyph}
        </span>
        <span
          className={
            detail.deletedAt
              ? 'pn-head__title pn-head__title--struck'
              : editable
                ? 'pn-head__title pn-head__title--editable'
                : 'pn-head__title'
          }
          title={detail.title}
          /* Inline-editable per the anatomy: dotted underline marks it, and
             tracked kinds (PR, commit) lock it because their title follows the
             source and cannot be written back. */
          contentEditable={editable ? true : undefined}
          suppressContentEditableWarning={editable}
          role={editable ? 'textbox' : undefined}
          aria-label={editable ? 'Title' : undefined}
          tabIndex={editable ? 0 : undefined}
        >
          {detail.title}
        </span>

        <StatusPillFor detail={detail} config={config} />

        <span className="pn-head__spacer" />

        <IconBtn label="More actions" onClick={onOverflow}>
          ⋯
        </IconBtn>
        {pinRefusal ? (
          /* A refused pin states WHY on the control itself rather than going
             quietly dead — the user needs to know it is a floor, not a bug. */
          <DisabledIconControl label="Pin panel" glyph="⌖" reason={toReason(pinRefusal)} />
        ) : (
          <IconBtn label={pinned ? 'Unpin panel' : 'Pin panel'} onClick={onPin}>
            ⌖
          </IconBtn>
        )}
        <IconBtn label="Open full view" onClick={onPromote}>
          ⤢
        </IconBtn>
        <IconBtn label="Close panel" danger onClick={onClose}>
          ✕
        </IconBtn>
      </div>
    </div>
  );
}

/**
 * The header status pill, driven entirely by `panel.statusPill` DATA: which
 * state scalar to read, the word per value, the tone per value. A kind with
 * no status axis (`source: 'none'`, or no spec) renders NO pill — honest,
 * because inventing "active" for a file would be a status it does not have.
 */
export function StatusPillFor({ detail, config }: { detail: EntityDetail; config: KindConfig }) {
  if (detail.deletedAt) {
    return (
      <Pill tone="idle" title="This entity is deleted">
        deleted
      </Pill>
    );
  }
  const spec = config.panel.statusPill;
  if (!spec || spec.source === 'none') return null;
  const value = statusValue(spec.source, detail.state);
  if (value == null) return null;

  const tone: PillTone = spec.tones[value] ?? 'idle';
  const label = spec.labels?.[value] ?? value.replace(/_/g, ' ');
  return (
    <Pill tone={tone} title={label}>
      {label}
    </Pill>
  );
}

/**
 * StatusSource → the `EntityState` member it names. Keyed by SOURCE, never by
 * kind: the registry says which scalar a kind's pill reads, and this only
 * knows how to fetch each named scalar. Adding a kind touches neither.
 */
const STATUS_FIELD: Record<Exclude<StatusSource, 'none'>, string> = {
  workStatus: 'workStatus',
  sessionStatus: 'status',
  prState: 'state',
  profileStatus: 'status',
  memberRole: 'role',
  equipped: 'equipped',
};

function statusValue(source: StatusSource, state: EntityState): string | null {
  if (source === 'none') return null;
  const bag = state as unknown as Record<string, unknown>;
  const raw = bag[STATUS_FIELD[source]];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw ? 'equipped' : 'library';
  return null;
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

/**
 * Generic verbs on the left, kind PRIMARIES on the right — and every one of
 * them is an ActionRef resolved through the single action registry, so the
 * same verb behind the panel button, the tile hover action, ⌘Enter and the
 * palette row is literally the same object (§2.5). Unavailable verbs render
 * disabled-with-reason, never hidden (L6).
 */
export function ActionBar({
  detail,
  config,
  ctx,
  onAction,
}: {
  detail: EntityDetail;
  config: KindConfig;
  ctx: ActionContext;
  onAction?: (ref: ActionRef) => void;
}) {
  const primaries = config.panel.primaries ?? [];
  const points = detail.counters.points;

  return (
    <div className="pn-actions" data-testid="panel-action-bar">
      <span className="pn-actions__verb" aria-label="Points">
        ▲ {points}
      </span>
      <span className="kit-vrule" aria-hidden style={{ height: 14 }} />
      <ActionButton ref_="link" ctx={ctx} onAction={onAction} />
      {config.list.primaryActions?.includes('run') ? (
        <ActionButton ref_="add-child" ctx={ctx} onAction={onAction} />
      ) : null}
      <span className="pn-head__spacer" />
      {primaries.map((ref) => (
        <ActionButton key={ref} ref_={ref} ctx={ctx} onAction={onAction} primary />
      ))}
    </div>
  );
}

function ActionButton({
  ref_,
  ctx,
  onAction,
  primary = false,
}: {
  ref_: ActionRef;
  ctx: ActionContext;
  onAction?: (ref: ActionRef) => void;
  primary?: boolean;
}) {
  const def = resolveAction(ref_);
  const availability = def.availability(ctx);

  if (availability.kind === 'disabled') {
    return <DisabledAction reason={toReason(availability.reason)}>{def.label}</DisabledAction>;
  }
  return (
    <button
      type="button"
      className={primary ? 'pn-btn pn-btn--primary' : 'pn-actions__verb'}
      onClick={() => onAction?.(ref_)}
    >
      {primary ? def.label : `${def.icon} ${def.label}`}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

export function TabStrip({
  active,
  counts,
  onSelect,
}: {
  active: PanelTab;
  /** Discussion and Connections carry counts; Content and Activity never do. */
  counts?: Partial<Record<PanelTab, number>>;
  onSelect?: (tab: PanelTab) => void;
}) {
  return (
    <div className="pn-tabs" role="tablist" aria-label="Panel sections" data-testid="panel-tabs">
      {PANEL_TABS.map(({ id, label }) => {
        const isActive = id === active;
        const count = counts?.[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={isActive}
            aria-controls={`tabpanel-${id}`}
            tabIndex={isActive ? 0 : -1}
            className={isActive ? 'pn-tab pn-tab--active' : 'pn-tab'}
            onClick={() => onSelect?.(id)}
          >
            {label}
            {/* A literal 0 is shown: measured-zero is a real answer here, and
                the count comes from a read that actually ran. */}
            {typeof count === 'number' ? <span className="pn-tab__count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/**
 * Presence · authorship · version · recency.
 *
 * TWO DAY-ONE HONESTY STATES LIVE HERE (D7):
 *   · VIEWERS renders HOLLOW. Presence is measured-empty on every node and
 *     dormant per R8, so "0 viewing" would be a lie of precision — it would
 *     claim we looked and found nobody. The dash says we never looked.
 *   · `v{n}` is the disabled-with-reason home of the deferred version-history
 *     feature (R7): the version is real and shown; the history behind it is
 *     not built, and the affordance says so instead of vanishing.
 */
export function PanelFooter({
  detail,
  presenceHollowReason,
  versionHistoryReason,
  activeAgo,
}: {
  detail: EntityDetail;
  presenceHollowReason: string;
  versionHistoryReason: string;
  activeAgo?: string;
}) {
  const author = detail.createdBy.displayName;
  return (
    <div className="pn-foot" data-testid="panel-footer">
      <span aria-hidden>◉</span>
      <HollowInline caption={presenceHollowReason}>— viewing</HollowInline>
      <span className="pn-foot__sep" aria-hidden>
        ·
      </span>
      <span>by {author}</span>
      <span className="pn-foot__sep" aria-hidden>
        ·
      </span>
      <DisabledIconControl
        label={`Version ${detail.version} — version history`}
        reason={toReason(versionHistoryReason)}
      >
        v{detail.version}
      </DisabledIconControl>
      {activeAgo ? (
        <>
          <span className="pn-foot__sep" aria-hidden>
            ·
          </span>
          <span>{activeAgo}</span>
        </>
      ) : null}
    </div>
  );
}
