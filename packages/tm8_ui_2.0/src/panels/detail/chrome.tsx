import { useEffect, useState, type ReactNode } from 'react';
import type { EntityDetail, EntityState } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type { ActionContext, ActionRef, KindConfig, StatusSource } from '../../domain';
import { KindIcon, processControlFor, resolveAction, titleNormalizerFor } from '../../domain';
import { InlineTitleEditor } from '../../authoring';
import { Avatar, IconBtn, Pill, VectorIcon, type PillTone } from '../../kit';
import { useMobileSurface } from '../../mobile';
import {
  DisabledIconControl,
  NOT_WIRED_REASON,
  toReason,
  type UnavailableReason,
} from '../honesty/DisabledWithReason';
import { HollowInline } from '../honesty/HollowValue';
/*
 * DEF-001 — the phone arrangement of `.pn-panelbar`, which this file renders.
 *
 * A SEPARATE STYLESHEET, imported HERE rather than appended to `panels.css`,
 * and the reason is coordination rather than taste: this fix was escalated out
 * of the lane structure to land ahead of lane integration (Terminate is a
 * SAFETY control and it was off-screen at 390), while `panels.css` has lane
 * work in flight in it. One file per defect is how this program avoids a
 * shared-file merge conflict; the import is the whole of the edit here.
 *
 * Every rule inside is scoped `.cv2-root[data-shell='mobile']`, so it cannot
 * reach the desktop shell, a tablet, or a narrow desktop window.
 */
import './panel-bar-phone.css';
/* The header's mono id tail — its own file for the same shared-css reason. */
import './panel-header-ref.css';

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

export type PanelTab = 'content' | 'connections' | 'discussion';

/**
 * THREE TABS ALWAYS, fixed order, every kind, no exceptions. Still a constant
 * and never a computed list, so no kind can grow or lose one.
 *
 * USER RULING 2026-08-19, two parts:
 *
 *   · CONNECTIONS COMES BEFORE DISCUSSION. A panel reads "what is this · what
 *     is it wired to · what was said about it". The graph is the structural
 *     fact, so it sits beside the entity rather than behind the conversation.
 *   · ACTIVITY IS GONE. It rendered `entities.activity` rows, and no host in
 *     the product ever passed them — every `EntityDetailPanel` mount left the
 *     `activity` prop absent, so the tab drew its designed empty state on
 *     every entity, on every screen, always. A permanently empty tab in the
 *     one bar the panel navigates by is worse than no tab: it takes width
 *     from the labels that do answer something (see `TabStrip`) to say
 *     nothing.
 */
/**
 * `ownsPanel` — DOES THIS TAB HAVE A `role="tabpanel"` ELEMENT TO NAME?
 *
 * Registry data rather than a condition in the render, because it is a fact
 * about the panel's structure and only this table can state it once for both
 * shells. Connections (`detail/tabs.tsx`) and Discussion (`EntityDetailPanel`)
 * each render a `#tabpanel-{id}` frame; CONTENT does not and never has — its
 * body is a per-archetype switch with six arms and no shared wrapper, and
 * inventing one would put a new div in the middle of a flex chain that has
 * produced a 2px pane twice.
 *
 * WHY IT MATTERS: `aria-controls` naming an element that is not in the document
 * is a relationship a screen reader announces and then cannot follow. The
 * render gate fails it (`controls-nothing`), and it did — on every entity route
 * added to the gate on 2026-08-31, in both themes, for all three tabs at once:
 * the two aux tabs because their panels render only while SELECTED, and Content
 * because `#tabpanel-content` has never existed at all.
 */
export const PANEL_TABS: readonly { id: PanelTab; label: string; ownsPanel: boolean }[] = [
  { id: 'content', label: 'Content', ownsPanel: false },
  { id: 'connections', label: 'Connections', ownsPanel: true },
  { id: 'discussion', label: 'Discussion', ownsPanel: true },
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
  /*
   * THE BREADCRUMB, FROM DATA THE DETAIL ALREADY CARRIES. The `breadcrumb`
   * prop has existed since the header was written and NO host in the product
   * ever passed one — so `pn-crumb` rendered only on the permission-lost
   * panel, and "where does this live" was answerable only two tabs over. The
   * detail's `hierarchy.path` is the ancestor chain root-first (server:
   * recursive CTE; `parent = path.at(-1)`), so the sentence costs no read and
   * cannot disagree with the PARENT chip. A host that passes `breadcrumb`
   * still wins; an entity with no ancestors keeps no crumb line, exactly as
   * before — absence of a place is not a place.
   */
  const derivedCrumb =
    breadcrumb ?? (detail.hierarchy.path.length > 0
      ? detail.hierarchy.path.map((ancestor) => ancestor.title).join(' › ')
      : undefined);
  return (
    <div className="pn-head" data-testid="panel-header">
      {derivedCrumb ? <div className="pn-crumb">{derivedCrumb}</div> : null}
      <div className="pn-head__row">
        <span className="pn-head__glyph" aria-hidden>
          <KindIcon kind={config.kind} size={16} />
        </span>
        {/* The id's own mono tail — TASK-grammar `82DF`, the ticket-number
            read, echoing the graph card's `gv-node__ref` so the two surfaces
            corroborate each other. It is the LAST FOUR of the real id, never
            invented, and `aria-hidden` because the full id is content (the
            MetaGrid ID cell), not name. */}
        <span className="pn-header__ref" aria-hidden>
          {detail.id.slice(-4).toUpperCase()}
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
  promoteHidden = false,
  pinned = false,
  pinRefusal,
  onPin,
}: {
  onPromote?: () => void;
  onClose?: () => void;
  /**
   * THE PIN — the third window verb, and the panel's one wholly dead prop set
   * until wave 3: `pinned`/`pinRefusal`/`onPin` were declared on
   * `EntityDetailPanelProps` and passed by WorkspaceView (admission refusal
   * and all) since the pin engine shipped, and no chrome ever rendered them.
   * Anyone "fixing the pin button" first had to learn there was no button.
   *
   * RENDERED ONLY WHERE A HOST SAYS SOMETHING — `onPin` or `pinRefusal`
   * present. The four hosts that pass neither (EntityView, ChannelView,
   * GraphScreen, the aux column) have no pin stack for the verb to act on, so
   * for them this is the `TransferControl` exception: not a deferred feature
   * but a concept that does not apply to the surface, and a permanently
   * refused row would apologise for a promise nobody made. `panels.test`
   * pins that absence by aria-label.
   *
   * REFUSED WITH ITS REASON where the host passed one (`pinRefusal` is the
   * admission engine's cause—remedy sentence, e.g. the C_min floor), and the
   * refusal never applies to UN-pinning — a pinned panel's pin is always
   * live, or a full stack could strand its own columns.
   *
   * PRESSED STATE IS STRUCTURAL: `aria-pressed` plus the FILLED form of the
   * same drawn mark (stroked ⇒ not pinned, solid ⇒ pinned) — the kit's own
   * "shape is provenance" move, no color needed, so it reads in both themes.
   */
  pinned?: boolean;
  pinRefusal?: string;
  onPin?: () => void;
  /**
   * DROP "OPEN FULL VIEW" — user ruling 2026-08-19, for the work-session bar.
   *
   * That bar is the crowded one: alone among the kinds it also carries the five
   * content-surface chips, and the four panel tabs beside them were absorbing
   * the whole overflow. ⤢ is the cheapest thing in the cluster to lose, because
   * a session panel is reached by an address that already opens it full.
   *
   * IT IS IGNORED ON A PHONE, and that is a correctness gate rather than a
   * caller's option. DEF-023 below removes ✕ on `oneSurface` and keeps ⤢
   * DELIBERATELY, because the phone HAS a full view and that verb is the only
   * one of the pair that still means anything there. Honouring this flag on a
   * phone would take the second of two controls after the first was already
   * taken, leaving the panel with no window verb at all — a desktop economy
   * quietly stranding a surface it was never measured on.
   */
  promoteHidden?: boolean;
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
  /*
   * The pin follows ✕'s DEF-023 ruling on a phone, for the identical reason:
   * it is a desktop panel-STACK verb, and this shell has no stack of pinned
   * columns to hold a panel in. Removed, not disabled — a permanent refusal
   * would be the "apologising for a feature nobody was promised" row the
   * 2026-08-20 owner ruling deleted from the action menu.
   */
  const pinVerb = pinned ? 'Unpin panel' : 'Pin panel';
  const pin = oneSurface || (!onPin && !pinRefusal) ? null : pinRefusal && !pinned ? (
    <DisabledIconControl
      label="Pin panel"
      glyph={<VectorIcon paths={PIN_ICON} size={16} />}
      reason={toReason(pinRefusal)}
    />
  ) : (
    <button
      type="button"
      /* `kit-iconbtn` for the cluster's shared geometry and focus ring; a raw
         button rather than `IconBtn` because the kit atom carries no pressed
         state and this control IS one (aria-pressed) — the same reason the
         Connections List|Graph switch is raw. */
      className="kit-iconbtn"
      aria-label={pinVerb}
      aria-pressed={pinned}
      title={pinVerb}
      data-testid="panel-pin"
      onClick={onPin}
    >
      <span aria-hidden>
        <VectorIcon paths={PIN_ICON} size={16} filled={pinned} />
      </span>
    </button>
  );
  return (
    <>
      {pin}
      {promoteHidden && !oneSurface ? null : (
        <IconBtn label="Open full view" onClick={onPromote}>
          ⤢
        </IconBtn>
      )}
      {oneSurface ? null : (
        <IconBtn label="Close panel" danger onClick={onClose}>
          ✕
        </IconBtn>
      )}
    </>
  );
}

/**
 * The drawn pin — a pushpin on the 16×16 grid, stroked like every house mark
 * (`domain/kind-art.ts` discipline) and FILLED when pressed. Drawn rather
 * than a character for Terminate's reason (`ActionDef.iconArt`): the pushpin
 * codepoints tofu or emoji-render across the system fonts, and a window verb
 * cannot be a gamble per platform.
 */
const PIN_ICON: readonly string[] = [
  // Head + shoulder: the flat cap and the tapering body of a pushpin.
  'M6.2 2.2h3.6l.5 4.2 1.9 2.2v1.2H3.8V8.6l1.9-2.2Z',
  // The needle.
  'M8 9.8v4',
];

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
 * THE CONTEXT A PRIMARY VERB IS ASKED ABOUT, filled from the detail the panel is
 * already holding.
 *
 * A host builds `ctx` before it has the entity — `EntityView` passes little more
 * than a space and an id — so four fields that decide availability arrive only
 * with the detail. Terminate refuses itself on a session that has already ended,
 * and without `category` and `liveness` the panel's copy of the verb was the one
 * place that could not see that: it offered Terminate on a finished session
 * while the row cluster correctly refused it.
 *
 * The host's own value always WINS where it set one; this only fills gaps. And
 * it is a function rather than four lines of spread at each call site because
 * there are now two call sites — the action bar and the phone's action menu —
 * and a verb that reads as live in one and refused in the other is precisely the
 * disagreement this program keeps filing rows about.
 */
export function panelActionContext(
  detail: EntityDetail,
  ctx: ActionContext,
  /** The seam's verdict, which is the panel's prop and not the detail's field. */
  liveness?: SessionLiveness,
): ActionContext {
  return {
    ...ctx,
    entityId: ctx.entityId ?? detail.id,
    kind: ctx.kind ?? detail.kind,
    capabilities: ctx.capabilities ?? detail.capabilities,
    liveness: ctx.liveness ?? liveness,
    category: ctx.category ?? detail.category,
  };
}

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
  onOpenLaunch,
  launchSubjectId,
  markPrimaries = false,
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
  barRef?: React.RefObject<HTMLDivElement | null>;
  /** The flow verb whose config is currently expanded, if any. */
  openFlow?: ActionRef | null;
  /** Toggles that expand. Absent ⇒ a flow verb falls back to `onAction`. */
  onFlow?: (ref: ActionRef | null) => void;
  /**
   * THE FULL LAUNCH SHEET, when the host mounts one — DEF-004.
   *
   * `RowAction` in the list has carried this rule since D44 and states it in
   * one line: **"the sheet OUTRANKS the inline expand: where the host mounted
   * the full launch sheet, one click on Run opens it directly and the tile
   * never expands."** The detail panel's Run did not have the rule, so the same
   * verb on the same entity behaved differently depending on which surface you
   * pressed it from — the inconsistency this program keeps filing rows about,
   * in the one pair of controls a person is most likely to compare.
   *
   * IT MATTERS MOST ON A PHONE, which is why it is arriving now. The inline
   * expand is `.pn-actions__flow`: absolutely positioned, 300px wide, anchored
   * to a 30px bar. `mobile/CONTRACT.md` §4 rules that anchored popovers "do not
   * survive the trip to a 390px header" — that is the whole reason the account
   * menu is a sheet. The full sheet HAS a phone arrangement now; the quick
   * config does not.
   *
   * ABSENT ⇒ UNCHANGED. The expand is what every host without a sheet keeps,
   * and its disabled-with-reason path is untouched. This is a precedence rule,
   * not a replacement.
   */
  onOpenLaunch?: (entityId: string) => void;
  /** The subject the sheet would be opened FOR. Required alongside
      `onOpenLaunch` for the same reason `RowAction` takes `row.id`: a sheet is
      bound to an entity and there is no subject in an action ref. */
  launchSubjectId?: string;
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
  /**
   * DRAW THE PRIMARIES AS MARKS, NOT WORDS — for a bar that has run out of room.
   *
   * The work-session panel is the one that has: it is the only kind whose bar
   * ALSO carries the five content-surface chips, and the four panel tabs beside
   * them are the only flexible thing in the row (`TabStrip` below). A labelled
   * "Terminate" was the last ~90px of a cluster that had already pushed
   * "Activity" off the edge.
   *
   * THE VERB KEEPS ITS TONE. `pn-btn--primary` still applies, so Terminate is
   * still the one control in the row wearing the brand ring — it is a safety
   * verb and DEF-001 was filed because it was HARD TO REACH, so shrinking it to
   * an anonymous icon would be answering one row by reopening another. It loses
   * its width, not its prominence, and it keeps its name as tooltip and
   * accessible name.
   *
   * OFF BY DEFAULT: every other kind's bar renders exactly as before. This is a
   * request from the one host that needs it, not a new house style.
   */
  markPrimaries?: boolean;
}) {
  /**
   * THE PROCESS CONTROL, IN THE PANEL — the same one-slot swap the row cluster
   * makes, from the same predicate (user ruling 2026-08-19).
   *
   * The panel had the identical hole and it is the worse of the two places to
   * have it: a user who opens a dead session looks at this bar first, and it
   * offered one refused Terminate and no way back. `ctx` here is already
   * filled from the detail with both `liveness` and `category`
   * (EntityDetailPanel), so the question is answerable without a new read.
   *
   * Written as a swap over the declared list rather than as registry data for
   * the reason the row cluster gives: `panel.primaries` is static per-kind and
   * listing both would draw one live verb beside one permanently refused one.
   * A kind that never declares `terminate` is untouched by construction.
   */
  const primaries = (config.panel.primaries ?? []).map((ref) => processControlFor(ref, ctx));
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
          {...(onOpenLaunch && launchSubjectId
            ? { onOpenLaunch, launchSubjectId }
            : {})}
          primary
          mark={markPrimaries}
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

/**
 * WHICH SURFACE A PRIMARY VERB REACHES, given what the host wired.
 *
 * Three facts, and every consumer needs all three: `opensSheet` and `opensFlow`
 * decide what a press DOES, and all three together decide whether the verb is
 * refused at all. They were computed inline in `ActionButton` and were correct
 * there; they are lifted because the FAB asks the identical question about the
 * identical verb, and two independent answers to "can this be pressed" is how
 * two surfaces start disagreeing about the same entity.
 */
export interface ActionWiring {
  /** The host's dispatcher can perform this ref. */
  readonly wired: boolean;
  /** The host mounted the full launch sheet for a subject — D44's precedence. */
  readonly opensSheet: boolean;
  /** The verb declares a flow and the host can expand it in place. */
  readonly opensFlow: boolean;
}

/**
 * Resolve `ActionWiring` from the four props every primary-rendering surface
 * already holds. The two derivations inside are `ActionButton`'s, unchanged;
 * see the docblocks at the call sites below for D44 and the §15.2 argument for
 * testing a flow's PRESENCE rather than its name.
 */
export function actionWiring(
  ref: ActionRef,
  wired: boolean,
  hosts: {
    readonly onOpenLaunch?: ((entityId: string) => void) | undefined;
    readonly launchSubjectId?: string | undefined;
    readonly canExpandFlow?: boolean;
  },
): ActionWiring {
  const def = resolveAction(ref);
  const opensSheet =
    def.flow === 'launch' && hosts.onOpenLaunch != null && hosts.launchSubjectId != null;
  const opensFlow = def.flow != null && !opensSheet && (hosts.canExpandFlow ?? false);
  return { wired, opensSheet, opensFlow };
}

/**
 * IS THIS VERB REFUSED, AND WHY — asked once, answered once.
 *
 * THE PRECEDENCE IS THE POINT, and it is why this is a function rather than
 * three checks each surface repeats:
 *
 *   1. NOTHING CAN PERFORM IT (R5 #9's structural check — no dispatcher, no
 *      sheet, no expand) ⇒ `NOT_WIRED_REASON`. This outranks availability
 *      deliberately: a verb the build cannot dispatch is not "unavailable
 *      because the entity is in the wrong state", it is absent plumbing, and
 *      reporting the entity's reason for it would send the reader to fix
 *      something that is not broken.
 *   2. THE REGISTRY REFUSES IT for this entity ⇒ the registry's own reason.
 *   3. Otherwise live.
 *
 * `null` means live. Nothing here decides PRESENTATION — the bar draws a
 * `DisabledIconControl`, the phone FAB draws a dimmed row with a caption — so
 * the two surfaces can look different while being unable to disagree about
 * whether the verb can be pressed, or about why not.
 */
export function actionRefusal(
  ref: ActionRef,
  ctx: ActionContext,
  wiring: ActionWiring,
): UnavailableReason | null {
  if (!wiring.wired && !wiring.opensFlow && !wiring.opensSheet) return NOT_WIRED_REASON;
  const availability = resolveAction(ref).availability(ctx);
  return availability.kind === 'disabled' ? toReason(availability.reason) : null;
}

function ActionButton({
  ref_,
  ctx,
  onAction,
  openFlow,
  onFlow,
  onOpenLaunch,
  launchSubjectId,
  primary = false,
  mark = false,
}: {
  ref_: ActionRef;
  ctx: ActionContext;
  onAction?: (ref: ActionRef) => void;
  openFlow?: ActionRef | null;
  onFlow?: (ref: ActionRef | null) => void;
  onOpenLaunch?: (entityId: string) => void;
  launchSubjectId?: string;
  primary?: boolean;
  /** Render the primary as its glyph rather than its word — see `markPrimaries`. */
  mark?: boolean;
}) {
  const def = resolveAction(ref_);

  /*
   * THE DRAWN MARK OUTRANKS THE CHARACTER wherever the registry provides one
   * (`ActionDef.iconArt`). Terminate's U+23FB tofus in the system fonts —
   * the panel's one safety verb rendered as an unreadable rectangle — and the
   * fix is data plus this one lookup, never a `ref === 'terminate'` branch.
   * 16px, stroked in `currentColor`, the same treatment as the kind marks.
   */
  const drawnIcon = def.iconArt ? <VectorIcon paths={def.iconArt} size={16} /> : null;

  /*
   * THE ONE-STEP CONFIRM (`ActionDef.confirm`, registry data). First press
   * ARMS — the verb redraws as `armedLabel` ("sure?") and dispatches nothing;
   * the press that performs is the second one inside `windowMs`, after which
   * the arm expires silently back to the resting verb. Audit 2026-08-29:
   * Terminate dispatched instantly, one slip away from Close. State is local
   * because arming is a property of THIS control's conversation with the
   * pointer, not of the entity; a re-render that swaps the ref disarms via
   * the effect below rather than carrying an arm onto a different verb.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const windowMs = def.confirm?.windowMs ?? 0;
    const timer = window.setTimeout(() => setArmed(false), windowMs);
    return () => window.clearTimeout(timer);
  }, [armed, def.confirm]);
  // A different verb in the same slot (the terminate↔resume swap) must not
  // inherit the previous verb's arm.
  useEffect(() => {
    setArmed(false);
  }, [ref_]);

  /*
   * THE SHEET OUTRANKS THE INLINE EXPAND (D44, `RowAction`'s rule), and the
   * flow test is on the flow's PRESENCE rather than on `'launch'` — the
   * registry says which verbs stop for a surface before they commit, and this
   * only honours it. Both derivations moved into `actionWiring` above, verbatim,
   * so the FAB cannot answer either question differently; the reasons they are
   * written the way they are live in that function's docblock.
   */
  const wiring = actionWiring(ref_, onAction != null, {
    onOpenLaunch,
    launchSubjectId,
    canExpandFlow: onFlow != null,
  });
  const { opensSheet, opensFlow } = wiring;

  /*
   * R5 #9's unwired check and the registry's own refusal, in that order — see
   * `actionRefusal`. They render IDENTICALLY here and always did; what differed
   * was only which sentence they carried, which is exactly the part that is now
   * decided in one place.
   *
   * TOOLTIP form, not the inline-caption form. The action bar is a fixed 32px
   * overflow-hidden row; the caption variant stacks a control plus a full
   * sentence, so three disabled verbs emitted three sentences that clipped
   * mid-word across the bar at the R5 gate. T0-4 2.2 draws disabled action-bar
   * verbs as a dimmed control carrying its reason on hover and focus — the
   * reason stays reachable, the row keeps its height.
   */
  const refusal = actionRefusal(ref_, ctx, wiring);
  if (refusal) {
    return (
      <DisabledIconControl label={def.label} glyph={drawnIcon ?? def.icon} reason={refusal}>
        {/* A marked primary is its glyph alone — `DisabledIconControl` already
            carries the label as the accessible name and draws the reason. */}
        {primary && !mark ? def.label : null}
      </DisabledIconControl>
    );
  }
  const expanded = openFlow === ref_;
  return (
    <button
      type="button"
      /*
       * A NAMED WITNESS FOR THE VERB, added for DEF-001's grading and useful
       * beyond it.
       *
       * The row this serves is "Terminate is off-screen on a phone", and the
       * trap in grading it is that A CONTROL WHICH FAILED TO RENDER ALSO
       * SCORES ZERO OVERFLOW — the fix and the disappearance produce the same
       * clean number, and the clean number reads as success. So the census
       * needs something to assert PRESENCE on before it grades a rect.
       *
       * IT MARKS THE LIVE ARM ONLY, and that is deliberate rather than
       * incomplete. The two arms above answer a different question: an unwired
       * or unavailable verb renders `DisabledIconControl` (`.hon-disabled`,
       * carrying its reason), and giving both the same testid would collapse
       * "Terminate is pressable" and "Terminate is refused-with-reason" into
       * one boolean — the exact conflation this program has now been bitten by
       * repeatedly. Present here means live; the refusal is found by its own
       * class and its accessible name, and the two are reported separately.
       *
       * Derived from the action ref, so every primary gets one and no verb
       * needs naming here (§15.2).
       */
      data-testid={primary ? `panel-primary-${ref_}` : undefined}
      className={[
        primary ? 'pn-btn pn-btn--primary' : 'pn-actions__verb',
        primary && mark ? 'pn-btn--mark' : '',
        expanded ? 'pn-actions__verb--on' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      /* The word becomes the name and the tooltip when the glyph replaces it,
         so the verb is still findable by `getByRole('button', { name })` and
         still says what it is on hover. While ARMED the accessible name says
         what the next press does — "sure?" alone names nothing. */
      {...(primary && mark
        ? {
            'aria-label': armed ? `${def.label} — press again to confirm` : def.label,
            title: armed ? `${def.label} — press again to confirm` : def.label,
          }
        : armed
          ? {
              'aria-label': `${def.label} — press again to confirm`,
              title: `${def.label} — press again to confirm`,
            }
          : {})}
      data-armed={armed ? 'true' : undefined}
      aria-expanded={opensFlow ? expanded : undefined}
      onClick={() => {
        if (opensSheet) {
          onOpenLaunch?.(launchSubjectId as string);
          return;
        }
        if (opensFlow) {
          onFlow?.(expanded ? null : ref_);
          return;
        }
        if (def.confirm && !armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onAction?.(ref_);
      }}
    >
      {armed ? (
        /* The armed rendering is the QUESTION, in text, whatever the resting
           form was — a glyph cannot ask "sure?". */
        def.confirm?.armedLabel
      ) : primary && mark ? (
        <span aria-hidden>{drawnIcon ?? def.icon}</span>
      ) : primary ? (
        def.label
      ) : drawnIcon ? (
        <>
          <span aria-hidden>{drawnIcon}</span> {def.label}
        </>
      ) : (
        `${def.icon} ${def.label}`
      )}
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
  /** Discussion and Connections carry counts; Content never does. */
  counts?: Partial<Record<PanelTab, number>>;
  /** USER RULING 2026-07-29: the first tab names WHAT you are looking at —
      the kind's singular label ("Task", "Doc", "Session") — instead of the
      word "Content". Registry data in, no kind literal here. */
  contentLabel?: string;
  /** Primary entity actions and panel controls, fixed at the right edge. */
  end?: React.ReactNode;
  onSelect?: (tab: PanelTab) => void;
}) {
  /*
   * THE PHONE HAS NO TAB ROW — user ruling 2026-08-20.
   *
   * The two navigational tabs and the kind's primary verbs move into the
   * floating action button; what is left of this region on a phone is the
   * inline save affordance and nothing else, and where THAT is absent the
   * region is absent with it. An empty padded strip with a hairline under it is
   * the dead chrome this removal exists to reclaim — ~90px of a 844px screen
   * spent before the body starts.
   *
   * `PANEL_TABS` and `PanelTab` are UNTOUCHED. The desktop still renders three
   * tabs off the same constant; this is one shell declining to draw a
   * vocabulary, not the vocabulary being trimmed to fit a shell. (A fourth tab
   * WAS deleted from that constant on 2026-08-19, for being permanently empty
   * on every kind — a different question, already settled, and the reason the
   * constant is left exactly as it stands.)
   *
   * `oneSurface` is `false` on every desktop path by construction, so the
   * desktop arrangement below cannot be reached by this branch.
   */
  const { oneSurface } = useMobileSurface();
  if (oneSurface) return end ? <PhonePanelBar>{end}</PhonePanelBar> : null;
  return (
    <div className="pn-panelbar" data-testid="panel-toolbar">
      <div className="pn-tabs" role="tablist" aria-label="Panel sections" data-testid="panel-tabs">
        {PANEL_TABS.map(({ id, label: defaultLabel, ownsPanel }) => {
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
              /* ONLY WHEN THERE IS SOMETHING TO NAME. The panel is rendered for
                 the SELECTED tab only, so an unselected tab's `aria-controls`
                 points at nothing; and Content has no panel element in any
                 state (`ownsPanel`). `aria-selected` already carries which tab
                 is current, and the panels carry `aria-labelledby` back to
                 their tab, so the relationship is stated in the direction that
                 can always be true. */
              aria-controls={isActive && ownsPanel ? `tabpanel-${id}` : undefined}
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

/**
 * What is left of the panel bar on a phone: the inline save affordance, and the
 * transfer control when a remote server makes it apply.
 *
 * IT COLLAPSES WHEN IT IS EMPTY, AND THE COLLAPSE IS CSS. Both children
 * self-gate to `null` — `SaveControls` while the edit is clean, `TransferControl`
 * on a node with no remote — and neither can be asked in advance, because
 * transfer's answer arrives from an async directory read that `src/transfer`
 * owns and this file must not second-guess (§15.2). So the element renders
 * unconditionally and `:empty` removes its padding, its hairline and its box —
 * see `panel-bar-phone.css`. Structurally the row is still one node with zero
 * element children, which is what a test can assert; that it also occupies zero
 * pixels is a stylesheet fact, and no vitest in this repo loads one.
 */
function PhonePanelBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="pn-panelbar pn-panelbar--phone"
      data-testid="panel-phone-bar"
      /* Deliberately NOT `panel-toolbar`: that id means "the row with the tabs
         and the action cluster in it", and four suites assert its anatomy. A
         row that shares the name while containing neither would make every one
         of those assertions ambiguous rather than failing. */
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The phone's action menu — what the tab row became
// ---------------------------------------------------------------------------

/**
 * ONE ROW OF THE PHONE'S FLOATING ACTION MENU, produced here and drawn by
 * `EntityFab`.
 *
 * DECLARED BY THE PRODUCER, not imported from the consumer, and that is a
 * layering decision worth one sentence: the panel's chrome knows what verbs an
 * entity has; the phone shell knows how to draw a menu. Data flows one way, so
 * the dependency points one way, and `panels/` does not reach into `mobile/` for
 * a type. The field names match `EntityFabItem`'s exactly and TypeScript is
 * structural, so this is assignable to it without either side importing the
 * other.
 */
export interface PanelMenuItem {
  /** Action ref or tab id — opaque to the menu, which never interprets it. */
  readonly id: string;
  readonly label: string;
  readonly glyph?: string;
  /** A count beside the label. `0` is a measured answer and renders. */
  readonly count?: number;
  /**
   * Present ⇒ REFUSED: the row is drawn dimmed and non-activating, and sorts to
   * the top of the menu. The string is NOT drawn — `EntityFab` carries it for
   * assistive technology only (owner ruling 2026-08-20). It is still required,
   * because a refusal with no reason recorded anywhere is a dead control.
   */
  readonly reason?: string;
  readonly onSelect?: () => void;
}

/**
 * A refusal reason, as one sentence. The same join `DisabledAction` makes for
 * its inline caption, so a verb refused in the bar and the same verb refused in
 * the menu read as the same sentence to whoever reaches it.
 */
function captionOf(reason: UnavailableReason): string {
  return reason.remedy ? `${reason.cause} — ${reason.remedy}` : reason.cause;
}

/**
 * A FLOW VERB WITH NOWHERE TO OPEN, on a phone.
 *
 * `.pn-actions__flow` is the inline expand: absolutely positioned, 300px wide,
 * anchored to the action bar — and on a phone there IS no action bar any more,
 * so an expand would be anchored to nothing. `mobile/CONTRACT.md` §4 had already
 * ruled that arrangement out at 390px before this row removed its anchor.
 *
 * The launch flow is unaffected and this is not its refusal: where the host
 * mounts the full sheet, Run opens the sheet (D44's precedence, `actionWiring`),
 * and where it does not, the verb is simply unwired. What lands here is the
 * merge confirm — a commitment card with no phone arrangement — and it is
 * refused BY NAME rather than dispatched. Dispatching it would perform a merge
 * with its confirmation step silently skipped, which is the one outcome worse
 * than refusing it.
 */
const NO_PHONE_FLOW_REASON: UnavailableReason = {
  cause: 'This verb stops at a confirmation card that has no phone arrangement',
  remedy: 'open this entity on a desktop to reach it',
};

export interface PanelMenuInput {
  readonly config: KindConfig;
  /** The ENRICHED context — see `panelActionContext`. */
  readonly ctx: ActionContext;
  /** The same counts `TabStrip` receives, so the two cannot disagree. */
  readonly counts?: Partial<Record<PanelTab, number>>;
  readonly onSelectTab: (tab: PanelTab) => void;
  readonly onAction?: (ref: ActionRef) => void;
  readonly wiredActions?: readonly ActionRef[];
  readonly onOpenLaunch?: (entityId: string) => void;
  readonly launchSubjectId?: string;
}

/**
 * WHAT THE PHONE'S ACTION MENU CONTAINS — derived, never typed out.
 *
 * Two sources, in this order:
 *
 *   1. THE TWO NAVIGATIONAL TABS the phone no longer has a strip for. They keep
 *      `onTabChange`, which already routes both to a `MobileSheet` through
 *      `EntityView`'s aux column — the menu is a new way in to an existing
 *      route, not a second route.
 *   2. `config.panel.primaries`, through the SAME `processControlFor` swap
 *      `ActionBar` makes, so a session that has ended offers Resume rather than
 *      a refused Terminate.
 *
 * ── AND NOT `⤢ OPEN FULL VIEW`, WHICH THIS MENU CARRIED UNTIL 2026-08-20 ───
 *
 * Owner ruling, on seeing it: "who asked for full screen — if it's not there,
 * don't show it". It was a THIRD source, in a lower group of one, and it was
 * refused-with-reason on every phone mount that exists, because `EntityView`
 * never wired `onPromote` and there is nowhere on this shell for it to promote
 * a panel INTO. Disabled-with-reason is the honest treatment of a verb the
 * product HAS and this viewer cannot reach right now; it is the wrong treatment
 * of a verb that has no phone implementation at all, where it reduces to a
 * permanent row apologising for a feature nobody was promised. The verb is
 * untouched on the desktop, where `PanelWindowControls` owns it and it works.
 *
 * REGISTRY-DRIVEN THROUGHOUT (§15.2). No kind is named, no action id is named:
 * a kind that declares a new primary gains a row here the moment the registry
 * says so, and this function does not change.
 *
 * A REFUSED VERB IS STILL IN THE LIST, dimmed and carrying its reason (house
 * rule 1) — `reason` present is the whole of that signal, and it is never
 * omission. The refusal comes from `actionRefusal`, which is also what the
 * action bar asks, so the two surfaces cannot disagree about whether a verb can
 * be pressed. What the ruling above removes is a row for a verb this shell does
 * not implement, which is a different thing from a verb it cannot perform yet.
 */
export function panelMenuItems(input: PanelMenuInput): PanelMenuItem[] {
  const { config, ctx, counts, onSelectTab, onAction, wiredActions } = input;

  const tabs: PanelMenuItem[] = PANEL_TABS.filter((t) => t.id !== 'content').map(({ id, label }) => {
    const count = counts?.[id];
    return {
      id,
      label,
      ...(typeof count === 'number' ? { count } : {}),
      onSelect: () => onSelectTab(id),
    };
  });

  const primaries: PanelMenuItem[] = (config.panel.primaries ?? [])
    .map((declared) => processControlFor(declared, ctx))
    .map((ref) => {
      const def = resolveAction(ref);
      const wiring = actionWiring(
        ref,
        onAction != null && (wiredActions == null || wiredActions.includes(ref)),
        {
          onOpenLaunch: input.onOpenLaunch,
          launchSubjectId: input.launchSubjectId,
          /* No inline expand on a phone — see NO_PHONE_FLOW_REASON. */
          canExpandFlow: false,
        },
      );
      /* A flow verb that reaches neither its sheet nor a dispatcher is refused
         for the arrangement it needs, not for missing plumbing — the plumbing
         is there on a desktop. `def.flow` is read as PRESENCE, never by name. */
      const reason =
        def.flow != null && !wiring.opensSheet && !wiring.wired
          ? NO_PHONE_FLOW_REASON
          : actionRefusal(ref, ctx, wiring);
      return {
        id: ref,
        label: def.label,
        ...(def.icon ? { glyph: def.icon } : {}),
        ...(reason
          ? { reason: captionOf(reason) }
          : {
              onSelect: () => {
                if (wiring.opensSheet) {
                  input.onOpenLaunch?.(input.launchSubjectId as string);
                  return;
                }
                onAction?.(ref);
              },
            }),
      };
    });

  return [...tabs, ...primaries];
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
