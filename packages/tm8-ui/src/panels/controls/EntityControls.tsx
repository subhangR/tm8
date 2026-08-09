/**
 * THE ENTITY CONTROL STRIP — state, value, assignment and the tombstone verb,
 * in ONE implementation, mounted by every surface that offers them.
 *
 * WHY THIS FILE EXISTS, and it is the same reason twice.
 *
 * D67's amendment (2026-08-04) removed a set of STATIC status / priority /
 * assignee chips from the expanded task tile because they sat above a second,
 * working control strip: "two status controls in one expand, and the one that
 * looked like the control was the dead one". The repair was to make the chips
 * the real controls and delete the copy — and the note it left behind is the
 * law this file enforces: "A second copy of the controls, shaped like chips,
 * is exactly the duplication that produced the bug."
 *
 * The DETAIL PANEL then turned out to hold the third copy. Its `MetaGrid`
 * rendered `priority`, `assignees` and `dueDate` as `<span>`s and its header
 * rendered `workStatus` as a read-only `Pill`, so the surface a user lands on
 * the instant they press "+ New task" — the generic-create pattern commits the
 * entity immediately and opens its panel — was the one surface with no way to
 * set any of them. That is the defect as the user reported it: "while creating
 * a task I am not able to assign, edit priority".
 *
 * So the controls moved HERE, out of `EntityListPanel`, and both surfaces
 * mount them. Not a shared look — the same code. A third surface that wants a
 * state control gets these refusals, these capability gates and these words
 * without electing to.
 *
 * THE PORT IS NARROW ON PURPOSE. `EntityListPanelProps` has ~40 members and
 * this needs nine; a detail panel cannot and should not satisfy the other
 * thirty-one. `ControlHost` is a STRUCTURAL SUBSET, so `EntityListPanelProps`
 * satisfies it with no adapter and no cast (the same reasoning that made
 * `AuthoringCommands` a subset of `Seam['commands']` rather than a wrapper: an
 * adapter is a place an argument can be dropped, and a dropped argument is how
 * an inert control looks live).
 *
 * `ControlSubject` is likewise the SUBSET of an entity these controls read —
 * id, title, kind, state, deletedAt. `EntitySummary` satisfies it directly;
 * `EntityDetail` is projected onto it by the detail panel. Neither shape is
 * restated, and nothing here names a kind: the registry names the field
 * (`priority`), the edge (`assigned_to`) and the words, exactly as before.
 */
import { Fragment, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActorSummary, EntityCapabilities, EntityKind } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type {
  ActionContext,
  ActionRef,
  AssignControl,
  KindConfig,
  StateControl,
  StatusPillSpec,
  ValueControl,
} from '../../domain';
import { REASONS, getKind, resolveAction } from '../../domain';
import { Avatar, type PillTone } from '../../kit';
import {
  CheckingPermission,
  DisabledAction,
  DisabledIconControl,
  NOT_WIRED_REASON,
  toReason,
  type UnavailableReason,
} from '../honesty/DisabledWithReason';
import { useDismissable } from '../useDismissable';

/**
 * The slice of an entity these controls READ. Every member is on both
 * `EntitySummary` and `EntityDetail`, so neither host converts anything.
 *
 * `state` is `unknown`-valued rather than the `EntityState` union because the
 * controls address it BY REGISTRY-DECLARED FIELD NAME (`control.source`) and
 * must not know which variant they are looking at — that is what keeps a kind
 * literal out of this file.
 */
export interface ControlSubject {
  id: string;
  title: string;
  kind: EntityKind;
  state: unknown;
  /** The tombstone bit every kind carries. Flips archive ⇄ restore. */
  deletedAt?: string | null;
}

/**
 * The nine members these controls need from a host. Optional handlers are
 * NOT-WIRED rather than absent-and-silent: a missing one renders the control
 * disabled with that reason, never as a live button that does nothing.
 */
export interface ControlHost {
  /**
   * The kind the SURFACE is showing, used only for the "this kind has no state
   * to set" refusal. Deliberately `string`, not `EntityKind`: a list can be
   * scoped to a custom `c:`-prefixed kind, and narrowing here would make
   * `EntityListPanelProps` stop satisfying this port.
   */
  kind: string;
  ctx: ActionContext;
  livenessOf?: (id: string) => SessionLiveness;
  capabilitiesOf?: (id: string) => EntityCapabilities | undefined;
  onAction?: (ref: ActionRef, entityId: string) => void;
  onSetState?: (entityId: string, next: string, via: ActionRef) => void;
  onArchive?: (ref: ActionRef, entityId: string) => void;
  /**
   * `label` rides along beside `source` because a failure notice is USER copy:
   * `source` is the wire field name, and titling a notice with it produced
   * "priority could not be changed" — lowercase mid-sentence. Both come off the
   * same registry `ValueControl`, whose `label` is required, so it is required
   * here too; an optional fourth argument would let a host silently drop it.
   */
  onSetValue?: (entityId: string, source: string, next: string, label: string) => void;
  onAssign?: (entityId: string, actorId: string, edgeType: string, assigned: boolean) => void;
  assignableActors?: readonly ActorSummary[];
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
 *
 * AMENDMENT 2026-08-04 — THE SAME STRIP, TWO LAYOUTS, AND WHY.
 *
 * The control-card used to draw its own STATIC status / priority / assignee
 * chips at the top of the expand and then mount this strip UNDERNEATH, which
 * put two status controls in one expand: three chips that looked like controls
 * and did nothing, over a dropdown that worked. The chips were never wired —
 * they were `<span>`s from the start — so the defect read as "the buttons are
 * broken" when in truth only one of them was ever a button.
 *
 * The repair is one strip with one of each control, laid out two ways:
 * `lines` (label above / beside its control) for the standard and session
 * anatomies, `chips` (the control IS the chip) for the control-card, which is
 * where the chips already were. Same components, same gates, same refusals —
 * `variant` decides only how they sit. A second copy of the controls, shaped
 * like chips, is exactly the duplication that produced the bug.
 */
export function EntityControlStrip({
  row,
  props,
  config,
  variant = 'lines',
}: {
  row: ControlSubject;
  props: ControlHost;
  config: KindConfig;
  /** `chips` for the control-card anatomy; see the amendment note above. */
  variant?: 'lines' | 'chips';
}) {
  const list = config.list;
  const control = list.stateControl;
  const archived = row.deletedAt != null;
  const chips = variant === 'chips';

  /**
   * A labelled control, in whichever of the two layouts this strip is drawn.
   *
   * In `chips` the label is the control's ACCESSIBLE name only. It is not
   * dropped — the chip's own text already reads "high" / "Ada +1", and a
   * visible "Priority:" in front of it is the noise the chip row exists to
   * avoid; a screen reader still gets the word from the control's aria-label.
   */
  const line = (label: string, node: ReactNode) =>
    chips ? (
      <Fragment key={label}>{node}</Fragment>
    ) : (
      <div className="lp__rowdetail-line" key={label}>
        <span className="lp__rowdetail-label">{label}</span>
        {node}
      </div>
    );

  return (
    <div
      className={chips ? 'lp__rowdetail lp__rowdetail--chips' : 'lp__rowdetail'}
      onClick={(e) => e.stopPropagation()}
    >
      {line(
        control?.label ?? 'State',
        <RowStateControl row={row} props={props} control={control} pill={config.panel.statusPill} />,
      )}

      {(list.valueControls ?? []).map((value) =>
        line(value.label, <RowValueControl row={row} props={props} control={value} />),
      )}

      {list.assignControl
        ? line(
            list.assignControl.label,
            <RowAssignControl row={row} props={props} control={list.assignControl} />,
          )
        : null}

      {line(
        'Archive',
        /* The tombstone verb. `restore` when this row is already archived —
           the Archived tier is where a user meets these rows, and a tier that
           could only put things IN would be a one-way door.

           A DRAWN BIN, and STILL THE WORD, in both layouts. The glyph is a
           presentational override at the one call site that already branches
           on `deletedAt`, so no action id is spelled twice. It replaces the
           def's '▢' — a typographic character sitting on its own baseline,
           which lands at a different optical height from the pills beside it.

           `wide` even in the chip row, though a bare icon would be tidier
           there: the refusal reuses this vocabulary, and the state control
           beside it refuses with a VISIBLE caption. Dropping the word would
           put two honesty vocabularies in one strip with the quieter one on
           the destructive verb — the exact regression the tests below hold,
           and the chip layout does not make it stop being true. */
        <RowAction
          ref_={archived ? 'restore' : 'archive'}
          row={row}
          props={props}
          onRun={props.onArchive}
          variant="wide"
          glyph={archived ? <RestoreIcon /> : <BinIcon />}
        />,
      )}
    </div>
  );
}

/**
 * The picker for a registry-declared `ValueControl` — priority, today.
 *
 * THE REFUSALS ARE `RowStateControl`'s, MINUS THE ONE THAT CANNOT HAPPEN. No
 * `readOnlyReason` arm: a value control is by definition author-owned (an
 * observed field would be a badge, not a control), so there is no fourth
 * refusal to keep distinct. The other three — not-loaded, refused, not-wired —
 * are the same three, in the same vocabulary, for the same reason.
 */
function RowValueControl({
  row,
  props,
  control,
}: {
  row: ControlSubject;
  props: ControlHost;
  control: ValueControl;
}) {
  const selectId = useId();
  const raw = (row.state as unknown as Record<string, unknown>)[control.source];
  const current = typeof raw === 'string' ? raw : '';
  const chosen = control.options.find((o) => o.id === current);
  /* `data-source` on the REFUSED pill as well as on the live select: the two
     are the same control in two states, and a hook that only existed on the
     enabled one would let a refusal go unasserted. */
  const currentPill = (
    <span className={`lp__statesel kit-pill--${chosen?.tone ?? 'idle'}`} data-source={control.source}>
      {chosen?.label ?? control.emptyLabel}
    </span>
  );

  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return <CheckingPermission label={`Change ${control.label.toLowerCase()}`} />;
  }

  /**
   * `canEdit`, because this IS an entity edit: the value travels in the kind's
   * content patch, which the server authorizes as an edit and not as its own
   * verb. Asking the capability the write actually needs is what stops the
   * control being enabled for a viewer the node will refuse.
   */
  if (props.capabilitiesOf && props.capabilitiesOf(row.id)?.canEdit === false) {
    return (
      <DisabledAction label={`Change ${control.label.toLowerCase()}`} reason={toReason(REASONS.cannotEdit)}>
        {currentPill}
      </DisabledAction>
    );
  }

  if (!props.onSetValue) {
    return (
      <DisabledAction label={`Change ${control.label.toLowerCase()}`} reason={NOT_WIRED_REASON}>
        {currentPill}
      </DisabledAction>
    );
  }

  return (
    <span className="lp__statewrap">
      <select
        id={selectId}
        className={`lp__statesel lp__statesel--live kit-pill--${chosen?.tone ?? 'idle'}`}
        aria-label={`Change ${control.label.toLowerCase()} for ${row.title}`}
        data-testid="row-value-select"
        data-source={control.source}
        value={current}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const next = e.target.value;
          if (next === current) return;
          props.onSetValue?.(row.id, control.source, next, control.label);
        }}
      >
        {/* An UNSET field is a real state and gets a real option, so the select
            shows the truth instead of snapping to `low` and claiming a priority
            the record does not carry. It is not selectable back to: nothing in
            the contract clears the field. */}
        {chosen === undefined ? (
          <option value={current} disabled>
            {control.emptyLabel}
          </option>
        ) : null}
        {control.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * The assignee picker.
 *
 * IT WRITES EDGES, ONE AT A TIME. `state.assignees` is a projection of
 * `assigned_to` (server `entity-read.ts:551`), so there is no array to PUT —
 * each row in the menu is its own add or remove. That is also why it is not a
 * `<select multiple>`: a multi-select commits a whole collection, and a whole-
 * collection write silently drops an assignment another client made between
 * the read and the write.
 *
 * `canLink`, not `canEdit`: the server authorizes edge writes as linking.
 */
function RowAssignControl({
  row,
  props,
  control,
}: {
  row: ControlSubject;
  props: ControlHost;
  control: AssignControl;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  useDismissable(open, boxRef, () => setOpen(false));

  const raw = (row.state as unknown as Record<string, unknown>)[control.source];
  const assigned: readonly ActorSummary[] = Array.isArray(raw)
    ? (raw.filter(
        (v): v is ActorSummary =>
          typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string',
      ) as ActorSummary[])
    : [];
  const assignedIds = new Set(assigned.map((a) => a.id));

  const face = (
    <span className="pn-badge pn-badge--assignees">
      <span className="pn-badge__people" aria-hidden>
        {assigned.length > 0
          ? assigned.slice(0, 3).map((actor) => (
              <Avatar
                key={actor.id}
                actorId={actor.id}
                provenance={actor.isAgent ? 'agent' : 'human'}
                label={actor.displayName}
                /* 15, not 20 — the avatar sits INSIDE a 24px chip and must not
                   be what sets the chip's height. 15 is the smallest step
                   `AvatarSize` offers. */
                size={15}
                src={actor.avatar ?? null}
              />
            ))
          : '♙'}
      </span>
      {assigned.length === 0
        ? control.emptyLabel
        : assigned.length === 1
          ? assigned[0].displayName
          : `${assigned[0].displayName} +${assigned.length - 1}`}
    </span>
  );

  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return <CheckingPermission label="Change assignment" />;
  }
  if (props.capabilitiesOf && props.capabilitiesOf(row.id)?.canLink === false) {
    return (
      <DisabledAction label="Change assignment" reason={toReason(REASONS.cannotLink)}>
        {face}
      </DisabledAction>
    );
  }
  if (!props.onAssign) {
    return (
      <DisabledAction label="Change assignment" reason={NOT_WIRED_REASON}>
        {face}
      </DisabledAction>
    );
  }

  /**
   * An EMPTY roster is not an empty space, and it must not read as one. The
   * host injects this list; nothing was injected means nothing was loaded, and
   * a menu drawn over it would say "there is nobody to assign" on a node full
   * of members.
   */
  // You cannot assign work to a process. `ActorSummary.kind` now honestly
  // carries run-shaped summaries (a session whose persona is unknown); those
  // may appear in actor payloads but are never OFFERABLE. The gate is the
  // registry's own `actorKinds` declaration — no kind literal here (§15.2) —
  // and it runs BEFORE the emptiness check, so a roster of only runs reads as
  // "not loaded", never as a menu of processes.
  const roster = (props.assignableActors ?? []).filter((actor) =>
    control.actorKinds.includes(actor.kind),
  );
  if (roster.length === 0) {
    return (
      <DisabledAction
        label="Change assignment"
        reason={{
          cause: 'The list of people and teammates for this space has not loaded.',
          remedy: 'It arrives with the space; if it does not, the node did not answer the members read.',
        }}
      >
        {face}
      </DisabledAction>
    );
  }

  return (
    <span className="lp__assignwrap" ref={boxRef}>
      <button
        type="button"
        className="lp__assignbtn"
        data-testid="row-assign-trigger"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Change assignment for ${row.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {face}
      </button>
      {open ? (
        <span className="lp__assignmenu" role="group" aria-label={`Assign ${row.title}`}>
          {roster.map((actor) => {
            const on = assignedIds.has(actor.id);
            return (
              <button
                key={actor.id}
                type="button"
                className={on ? 'lp__assignopt lp__assignopt--on' : 'lp__assignopt'}
                data-testid="row-assign-option"
                data-actor={actor.id}
                aria-pressed={on}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onAssign?.(row.id, actor.id, control.edgeType, !on);
                }}
              >
                <Avatar
                  actorId={actor.id}
                  provenance={actor.isAgent ? 'agent' : 'human'}
                  label={actor.displayName}
                  size={15}
                  src={actor.avatar ?? null}
                />
                <span className="lp__assignopt-name">{actor.displayName}</span>
                <span className="lp__assignopt-mark" aria-hidden>
                  {on ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </span>
      ) : null}
    </span>
  );
}

/* A real bin, not '▢'. Same reason the chevrons became SVG in
   `MaestroTaskTile`: a typographic glyph sits on its own font's baseline and
   lands at a different optical height from the chips beside it. */
function BinIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false" width="14" height="14">
      <path
        d="M3 4.5h10M6.5 4.5V3.2h3v1.3M4.4 4.5l.6 8.1h6l.6-8.1M6.7 6.8v3.6M9.3 6.8v3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false" width="14" height="14">
      <path
        d="M3.4 8a4.6 4.6 0 1 0 1.5-3.4M3 3v2.6h2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
  row: ControlSubject;
  props: ControlHost;
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


/**
 * Row quick-actions are the SAME ActionRefs as the panel primaries, ⌘Enter and
 * the palette rows (§2.5) — one verb, one availability rule, one reason
 * string, four surfaces. Capabilities come from server truth; ABSENT means
 * unknown, and unknown means not permitted rather than optimistically enabled.
 */
export function RowAction({
  ref_,
  row,
  props,
  openFlow,
  onFlow,
  onRun,
  onOpenLaunch,
  variant = 'icon',
  glyph,
}: {
  ref_: ActionRef;
  row: ControlSubject;
  props: ControlHost;
  openFlow?: ActionRef | null;
  onFlow?: (ref: ActionRef | null) => void;
  /**
   * The handler for THIS verb, when the host wired one separately from the
   * general `onAction`. Keeps one gating path (capabilities → checking →
   * disabled → enabled) for every row verb rather than a second copy beside it.
   */
  onRun?: (ref: ActionRef, entityId: string) => void;
  /**
   * Opens the FULL launch sheet for a `flow: 'launch'` verb. When wired, Run
   * goes STRAIGHT to the sheet — no inline expand in between (user ruling:
   * the two-step tile expand made the important configuration a second click
   * away). The inline quick config remains the fallback for hosts that mount
   * no sheet (kind screens), so Run never silently does nothing.
   */
  onOpenLaunch?: (entityId: string) => void;
  /**
   * `wide` carries the LABEL beside the glyph. The hover-revealed row cluster
   * is a fixed-width icon strip; inside an expanded detail strip there is room
   * for the word, and an archive control is not one to leave as a bare glyph.
   */
  variant?: 'icon' | 'wide';
  /**
   * A PRESENTATIONAL override for the action def's own `icon`, and nothing
   * more: same verb, same availability rule, same reason string, same handler.
   * It exists because the def's glyph is a text character sized for the 22px
   * hover cluster, and the archive control in a chip row needs a drawn bin at
   * the chips' optical height. The word still comes from `def.label`, so the
   * accessible name cannot drift from the action it dispatches.
   */
  glyph?: ReactNode;
}) {
  const def = resolveAction(ref_);
  const wide = variant === 'wide';
  const mark = glyph ?? def.icon;
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
   *
   * The sheet OUTRANKS the inline expand: where the host mounted the full
   * launch sheet, one click on Run opens it directly and the tile never
   * expands. The inline quick config only serves hosts without a sheet.
   */
  const opensSheet = def.flow === 'launch' && onOpenLaunch != null;
  const opensFlow = def.flow === 'launch' && !opensSheet && onFlow != null;

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
          <span aria-hidden>{mark}</span>
          <span className="lp__rowaction-label">{def.label}</span>
        </span>
      </DisabledAction>
    ) : (
      <DisabledIconControl label={def.label} glyph={mark} reason={reason} />
    );

  const run = onRun ?? props.onAction;
  if (!run && !opensFlow && !opensSheet) {
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
    return <CheckingPermission label={def.label} glyph={mark} />;
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
        if (opensSheet) {
          onOpenLaunch?.(row.id);
          return;
        }
        if (opensFlow) {
          onFlow?.(expanded ? null : ref_);
          return;
        }
        run?.(ref_, row.id);
      }}
    >
      <span aria-hidden>{mark}</span>
      {wide ? <span className="lp__rowaction-label">{def.label}</span> : null}
    </button>
  );
}
