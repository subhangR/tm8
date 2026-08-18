import type { ReactNode } from 'react';
import type { EntityDetail, EntityState } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type { ActionContext, ActionRef, KindConfig, StatusSource } from '../../domain';
import { KindIcon, resolveAction, titleNormalizerFor } from '../../domain';
import { InlineTitleEditor } from '../../authoring';
import { Avatar, IconBtn, Pill, type PillTone } from '../../kit';
import { useMobileSurface } from '../../mobile';
import { DisabledIconControl, NOT_WIRED_REASON, toReason } from '../honesty/DisabledWithReason';
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
  liveness,
  onCommitTitle,
  titleEditable,
  titleLockReason,
  titlePlaceholder,
  autoFocusTitle,
  supplemental,
}: {
  detail: EntityDetail;
  config: KindConfig;
  breadcrumb?: string;
  liveness?: SessionLiveness;
  /**
   * THE TITLE IS REALLY EDITABLE NOW, or it does not look editable.
   *
   * What stood here was a `contentEditable` span with NO commit handler and no
   * seam call — inert since the day it was written. It carried the dotted
   * underline that means "you can change this", accepted keystrokes, and threw
   * every one of them away on blur. That is R5 #9's enabled-inert class, in the
   * most conspicuous string on the panel.
   *
   * So the dotted treatment is now tied to a real editor: pass a commit
   * handler and the caller gets `InlineTitleEditor`, which sends
   * `patchTask(expectedVersion)`; pass none and the title is a plain span that
   * makes no promise. A caller that CAN edit but has no executor should say so
   * through `SaveControls` (disabled-with-reason) rather than by dressing the
   * title up.
   */
  onCommitTitle?: (title: string) => void;
  /** False ⇒ plain span even with a handler: the kind's own lock (a message's
      excerpt, a member's name, a commit's tracked subject) or a server
      `canEdit: false`. Resolved by the caller from registry data + the seam. */
  titleEditable?: boolean;
  /** WHY it is locked — carried on the title itself, so a lock is stated. */
  titleLockReason?: string;
  /** The title is still the create flow's placeholder, not a name anyone
      chose (T5-6 paints that state in ink-4). */
  titlePlaceholder?: boolean;
  /** "＋ New → Z3 opens, title in inline-edit focus" — true once, for the row
      the create flow just made. */
  autoFocusTitle?: boolean;
  /** Optional facts directly beneath the identity row. */
  supplemental?: ReactNode;
}) {
  const editable = (titleEditable ?? false) && onCommitTitle !== undefined && !detail.deletedAt;
  return (
    <div className="pn-head" data-testid="panel-header">
      {breadcrumb ? <div className="pn-crumb">{breadcrumb}</div> : null}
      <div className="pn-head__row">
        <span className="pn-head__glyph" aria-hidden>
          <KindIcon kind={config.kind} size={16} />
        </span>
        {editable && onCommitTitle ? (
          /* `au-title` is a byte-equivalent of `pn-head__title` — same flex,
             same 14.5px/600, same nowrap+ellipsis — so this swap changes the
             behaviour and not the box. The duplication is the authoring
             lane's flagged item (HANDOVER-Authoring §7b): two class names for
             one treatment, and `panels.css` is not this seat's to delete
             from. Flagged, not silently left. */
          <InlineTitleEditor
            value={detail.title}
            editable
            placeholder={titlePlaceholder}
            autoFocus={autoFocusTitle}
            normalize={titleNormalizerFor(config)}
            onCommit={onCommitTitle}
          />
        ) : (
          <span
            className={
              detail.deletedAt ? 'pn-head__title pn-head__title--struck' : 'pn-head__title'
            }
            title={titleLockReason ? `${detail.title} — ${titleLockReason}` : detail.title}
          >
            {detail.title}
          </span>
        )}

        <StatusPillFor detail={detail} config={config} liveness={liveness} />
      </div>
      {supplemental ? <div className="pn-head__supplemental">{supplemental}</div> : null}
    </div>
  );
}

/**
 * Panel-level controls live beside the tabs, not beside the title. This keeps
 * the identity row entirely available to a long title while preserving the
 * stack controls in the compact second row.
 */
export function PanelWindowControls({
  onPromote,
  onClose,
}: {
  onPromote?: () => void;
  onClose?: () => void;
}) {
  /*
   * DEF-023 — "CLOSE PANEL" IS REMOVED ON THE PHONE, NOT RESIZED. The ruling is
   * the shell contract's (CONTRACT.md §7), written there and implemented here
   * because that file's own ownership rule keeps it out of a lane's directory.
   *
   * It is a DESKTOP PANEL-STACK VERB ON A SHELL THAT HAS NO PANEL STACK. The
   * phone shows one surface; there is no stack to close a panel out of, so the
   * control is either inert or it performs a navigation nobody asked for.
   * Growing it to 44px would have produced a comfortably tappable control for
   * an arrangement that does not exist here. The ledger records this close as
   * `wontfix-removed` and calls it a legitimate PASS rather than a dodge —
   * REMOVED is what happened, and this comment is the lane stating which of the
   * two it was.
   *
   * "Open full view" is the other half of the same 18x16 pair and is KEPT: the
   * phone HAS a full view, so that verb still means something. It keeps its
   * tap-target row and is sized in `kit.css` instead.
   *
   * `oneSurface` is the seam that exists for this and is `false` on every
   * desktop path by construction — this cannot reach a desktop arrangement.
   */
  const { oneSurface } = useMobileSurface();
  return (
    <>
      <IconBtn label="Open full view" onClick={onPromote}>
        ⤢
      </IconBtn>
      {oneSurface ? null : (
        <IconBtn label="Close panel" danger onClick={onClose}>
          ✕
        </IconBtn>
      )}
    </>
  );
}

/**
 * The header status pill, driven entirely by `panel.statusPill` DATA: which
 * state scalar to read, the word per value, the tone per value. A kind with
 * no status axis (`source: 'none'`, or no spec) renders NO pill — honest,
 * because inventing "active" for a file would be a status it does not have.
 */
export function StatusPillFor({
  detail,
  config,
  liveness,
}: {
  detail: EntityDetail;
  config: KindConfig;
  /** The seam verdict, when this kind has one. */
  liveness?: SessionLiveness;
}) {
  if (detail.deletedAt) {
    return (
      <Pill tone="idle" title="This entity is deleted">
        deleted
      </Pill>
    );
  }
  /**
   * PRECEDENCE: THE VERDICT OUTRANKS THE RECORD (D6, R-UI-5, D22).
   *
   * A work_session's statusPill reads state.status, which says "running" even
   * when the node reports the session stale. Rendering that in live green
   * above a stale session is precisely the lie D6 forbids — and it reached the
   * user's screen at the R5 gate because this consumer was never given the
   * verdict the panel was already holding.
   *
   * Where a liveTreatment exists, it owns the pill. The record's claim is not
   * discarded — the registry's authored label states and withdraws it in one
   * breath ("running per record · unverified") — but it never wears the live
   * treatment on its own.
   */
  const treatment = liveness && config.list.liveTreatment ? config.list.liveTreatment(liveness) : null;
  if (treatment) {
    return (
      <Pill tone={treatment.tone} title={treatment.reason ?? treatment.label}>
        {treatment.label}
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
  status: 'status',
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
 * The compact panel toolbar renders only the kind's primary verbs. Secondary
 * entity operations (points, linking and child creation) belong to their
 * content surfaces and no longer compete with navigation or the title.
 */
export function ActionBar({
  config,
  ctx,
  onAction,
  openFlow,
  onFlow,
  flowSurface,
  barRef,
  wiredActions,
}: {
  config: KindConfig;
  ctx: ActionContext;
  onAction?: (ref: ActionRef) => void;
  /**
   * WHICH verbs the host's dispatcher can actually perform.
   *
   * R5 #9 used to gate on the mere PRESENCE of `onAction`, which is only
   * correct while a host either performs every primary or none. It does not:
   * a host wires Terminate and has no executor for a doc's `add-child`, and
   * under a presence-only check that unimplemented verb would light up and do
   * nothing — trading one enabled-inert button for another.
   *
   * Absent ⇒ presence-only, the original behaviour, for hosts and tests that
   * genuinely cover every primary they render.
   */
  wiredActions?: readonly ActionRef[];
  /**
   * The bar element, for a host that needs the TRIGGER and the expand inside
   * one dismissal boundary — see `flowSurface`.
   */
  barRef?: React.RefObject<HTMLDivElement>;
  /** The flow verb whose config is currently expanded, if any. */
  openFlow?: ActionRef | null;
  /** Toggles that expand. Absent ⇒ a flow verb falls back to `onAction`. */
  onFlow?: (ref: ActionRef | null) => void;
  /**
   * The expanded flow's own surface, rendered by the host.
   *
   * It hangs off THIS row rather than taking one of its own: the bar is a
   * fixed 32px strip beside the tabs and the header is already dense, so an
   * expand that occupied layout height would push the body down every time
   * someone pressed Run. `pn-actions--inline` opens the positioning context;
   * `pn-actions__flow` is absolute, so the popover costs the header no pixels
   * and the terminal below it never moves.
   */
  flowSurface?: ReactNode;
}) {
  const primaries = config.panel.primaries ?? [];
  return (
    <div className="pn-actions pn-actions--inline" data-testid="panel-action-bar" ref={barRef}>
      {primaries.map((ref) => (
        <ActionButton
          key={ref}
          ref_={ref}
          ctx={ctx}
          onAction={wiredActions && !wiredActions.includes(ref) ? undefined : onAction}
          openFlow={openFlow}
          onFlow={onFlow}
          primary
        />
      ))}
      {flowSurface ? (
        <div className="pn-actions__flow" data-testid="panel-action-flow">
          {flowSurface}
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  ref_,
  ctx,
  onAction,
  openFlow,
  onFlow,
  primary = false,
}: {
  ref_: ActionRef;
  ctx: ActionContext;
  onAction?: (ref: ActionRef) => void;
  openFlow?: ActionRef | null;
  onFlow?: (ref: ActionRef | null) => void;
  primary?: boolean;
}) {
  const def = resolveAction(ref_);
  const availability = def.availability(ctx);

  /*
   * D44 — a flow verb OPENS ITS SURFACE instead of dispatching, exactly as the
   * list row's `RowAction` does. Asking the resolved def for `flow` keeps this
   * free of both kind and action-id literals (§15.2): the registry says which
   * verbs stop for a surface before they commit, and this only knows how to
   * honour it. It tests for a flow's PRESENCE, not for `'launch'` — the moment
   * a second flow existed (B10's merge confirm) the equality check was itself
   * the action-id literal this comment claims not to have.
   *
   * It is therefore NOT enabled-inert without `onAction` — clicking genuinely
   * does something, and the config states for itself whether it can commit.
   */
  const opensFlow = def.flow != null && onFlow != null;

  /*
   * R5 #9: an unwired verb is DISABLED-WITH-REASON, not enabled-inert. The
   * primaries landed ahead of their behaviour and rendered as live buttons
   * that did nothing when clicked — the user cannot distinguish that from a
   * broken app. Structural check, so it cannot drift from what is wired.
   */
  if (!onAction && !opensFlow) {
    return (
      <DisabledIconControl label={def.label} glyph={def.icon} reason={NOT_WIRED_REASON}>
        {primary ? def.label : null}
      </DisabledIconControl>
    );
  }

  if (availability.kind === 'disabled') {
    /*
     * TOOLTIP form, not the inline-caption form. The action bar is a fixed
     * 32px overflow-hidden row; the caption variant stacks a control plus a
     * full sentence, so three disabled verbs emitted three sentences that
     * clipped mid-word across the bar at the R5 gate. T0-4 2.2 draws disabled
     * action-bar verbs as a dimmed control carrying its reason on hover and
     * focus — the reason stays reachable, the row keeps its height.
     */
    return (
      <DisabledIconControl label={def.label} glyph={def.icon} reason={toReason(availability.reason)}>
        {primary ? def.label : null}
      </DisabledIconControl>
    );
  }
  const expanded = openFlow === ref_;
  return (
    <button
      type="button"
      className={[
        primary ? 'pn-btn pn-btn--primary' : 'pn-actions__verb',
        expanded ? 'pn-actions__verb--on' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-expanded={opensFlow ? expanded : undefined}
      onClick={() => {
        if (opensFlow) {
          onFlow?.(expanded ? null : ref_);
          return;
        }
        onAction?.(ref_);
      }}
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
  contentLabel,
  end,
  onSelect,
}: {
  active: PanelTab;
  /** Discussion and Connections carry counts; Content and Activity never do. */
  counts?: Partial<Record<PanelTab, number>>;
  /** USER RULING 2026-07-29: the first tab names WHAT you are looking at —
      the kind's singular label ("Task", "Doc", "Session") — instead of the
      word "Content". Registry data in, no kind literal here. */
  contentLabel?: string;
  /** Primary entity actions and panel controls, fixed at the right edge. */
  end?: React.ReactNode;
  onSelect?: (tab: PanelTab) => void;
}) {
  return (
    <div className="pn-panelbar" data-testid="panel-toolbar">
      <div className="pn-tabs" role="tablist" aria-label="Panel sections" data-testid="panel-tabs">
        {PANEL_TABS.map(({ id, label: defaultLabel }) => {
          const label = id === 'content' && contentLabel ? contentLabel : defaultLabel;
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
      {end ? <div className="pn-panelbar__end">{end}</div> : null}
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
      <span className="pn-foot__by">
        <Avatar
          actorId={detail.createdBy.id}
          provenance={detail.createdBy.isAgent ? 'agent' : 'human'}
          label={author}
          size={15}
          src={detail.createdBy.avatar ?? null}
        />
        <span>by {author}</span>
      </span>
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
