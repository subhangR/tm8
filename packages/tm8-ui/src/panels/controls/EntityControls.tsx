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
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type {
  ActorSummary,
  Connections,
  EntityCapabilities,
  EntityKind,
  EntitySummary,
  TaskAxis,
} from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type {
  ActionContext,
  ActionRef,
  AssignControl,
  KindConfig,
  MembershipListControl,
  StateControl,
  StatusPillSpec,
  ValueControl,
} from '../../domain';
import { KindIcon, REASONS, getKind, resolveAction } from '../../domain';
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
 * The members these controls need from a host. Optional handlers are
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
  /**
   * ASK THE HOST TO LOAD THIS ROW'S DETAIL — the read `capabilitiesOf` is
   * backed by, and the reason the strip could not act on a list row at all.
   *
   * `EntityCapabilities` rides on `EntityDetail`, never on the `EntitySummary`
   * a `collections.query` returns. Every control below therefore renders
   * `CheckingPermission` while `capabilitiesOf(id)` is `undefined` — the
   * loading vocabulary, whose whole promise is "it resolves on its own".
   *
   * On a LIST ROW it did not resolve on its own. The only caller of the host's
   * detail read was `WorkspaceView.renderPanel`, i.e. an OPEN DETAIL PANEL, so
   * a row whose strip the user expanded from the list sat in the checking
   * state permanently: state, priority, assignment, Run and — the reported
   * defect — Archive were all inert spans that swallowed the click and issued
   * no request. Deleting a task from the task list simply did nothing.
   *
   * So the strip asks. It is injected rather than reached for, like every
   * other signal here (the panel never taps the seam), and it fires ONLY from
   * the mounted strip — one deliberate expand, one row — never per rendered
   * row, which would put a detail read behind every row of a 100-row list.
   * Absent ⇒ the controls keep their honest checking state, exactly as before.
   */
  onNeedDetail?: (entityId: string) => void;
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
  /**
   * A registry `axisControls` write — ONE axis of the row's `state.axes`
   * record. `null` clears the axis back to unset, which is a real state the
   * picker offers (`no <axis>`), unlike `onSetValue` whose fields have no
   * contract-level clear. The executor merges into the stored record before
   * patching, because the server replaces the jsonb wholesale.
   */
  onSetAxis?: (entityId: string, axisName: string, next: string | null, label: string) => void;
  /**
   * The space's axis registry, for the `axisControls` pickers — PER-SPACE
   * DATA from `spaceSettings().taskAxes`, hydrated by the host like the
   * assign roster. Empty means the space defines none, and the strip renders
   * no axis controls at all (an empty picker would fabricate a taxonomy).
   */
  taskAxes?: readonly TaskAxis[];
  onAssign?: (entityId: string, actorId: string, edgeType: string, assigned: boolean) => void;
  assignableActors?: readonly ActorSummary[];
  /**
   * Put this row into / take it out of ONE curated set (the registry's
   * `list.membership`, today the `contains` pair of migration 100). Per-set
   * and not a whole-array write, for the same reason `onAssign` is per-actor:
   * a whole-collection write silently clobbers a concurrent curator.
   */
  onMembership?: (entityId: string, setId: string, member: boolean) => void;
  /**
   * The sets the membership menu may offer — one bounded recency page of the
   * registry's `setKind`, hydrated by the host exactly like the assign
   * roster. Empty ⇒ not loaded (or none exist), and the control says which.
   */
  membershipSets?: readonly EntitySummary[];
  /**
   * The row's LIVE edges, for the ✓ marks: which sets currently contain it.
   * Backed by the host's `connectionsOf` projection — `undefined` until the
   * row's detail is hydrated, which `onNeedDetail` above already triggers.
   */
  connectionsOf?: (id: string) => Connections | undefined;
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
   * THE STRIP IS MOUNTED, SO THE ROW'S PERMISSIONS ARE NOW WORTH KNOWING.
   *
   * Every control below gates on `capabilitiesOf(row.id)`, which is `undefined`
   * until the host has read this row's DETAIL. In a list that read had no other
   * trigger, so the strip rendered permanently "checking permissions" and its
   * Archive swallowed the click — see `ControlHost.onNeedDetail`.
   *
   * IN AN EFFECT, NOT IN RENDER: this asks the host to fetch, which is a state
   * write, and React forbids one during render. The host's read is idempotent
   * and claim-guarded, so the re-run when `capabilitiesOf` changes identity
   * (every store update re-creates it) costs nothing — but the `undefined`
   * check keeps even that from being asked twice for a row already loaded.
   */
  const { onNeedDetail, capabilitiesOf } = props;
  const capabilities = capabilitiesOf?.(row.id);
  useEffect(() => {
    if (capabilities === undefined) onNeedDetail?.(row.id);
  }, [capabilities, onNeedDetail, row.id]);

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

      {/* One picker per axis the SPACE defines — none defined, none drawn.
          Registry presence only marks the kind whose state carries `axes`;
          the vocabulary is the host's `taskAxes` data. */}
      {list.axisControls
        ? (props.taskAxes ?? []).map((axis) =>
            line(axisLabel(axis.name), <RowAxisControl row={row} props={props} axis={axis} />),
          )
        : null}

      {list.assignControl
        ? line(
            list.assignControl.label,
            <RowAssignControl row={row} props={props} control={list.assignControl} />,
          )
        : null}

      {list.membership
        ? line(
            list.membership.label,
            <RowMembershipControl row={row} props={props} control={list.membership} />,
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

/** User copy for an axis whose NAME is data ("type" → "Type"). */
function axisLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The picker for ONE per-space task axis (`state.axes[name]`).
 *
 * `RowValueControl`'s anatomy and refusals, with three deliberate
 * differences, each forced by axes being DATA rather than registry config:
 *
 * 1. The vocabulary is the axis row's `axisValues`, straight from the node's
 *    own registry — the same list `internal.validate_task_axes` enforces, so
 *    the picker can only offer what the trigger will accept.
 * 2. UNSET IS SELECTABLE. `no <axis>` is a real option that clears the value,
 *    because clearing is a legal write here (the executor drops the key from
 *    the record), unlike priority where nothing in the contract clears.
 * 3. `axisValues: []` means FREE TEXT per the DB comment (001:537-550). This
 *    control is a picker and cannot offer an open vocabulary, so it refuses
 *    with that named reason instead of drawing an empty select that looks
 *    like "no legal values". The CLI (`tm8 task axis`) writes free text.
 */
function RowAxisControl({
  row,
  props,
  axis,
}: {
  row: ControlSubject;
  props: ControlHost;
  axis: TaskAxis;
}) {
  const selectId = useId();
  const label = axisLabel(axis.name);
  const record = (row.state as unknown as Record<string, unknown>).axes;
  const raw =
    record !== null && typeof record === 'object'
      ? (record as Record<string, unknown>)[axis.name]
      : undefined;
  const current = typeof raw === 'string' ? raw : '';
  const emptyLabel = `no ${axis.name}`;

  const currentPill = (
    <span className="lp__statesel kit-pill--idle" data-source={`axis:${axis.name}`}>
      {current || emptyLabel}
    </span>
  );

  if (axis.axisValues.length === 0) {
    return (
      <DisabledAction
        label={`Change ${axis.name}`}
        reason={{
          cause: `The ${axis.name} axis takes free text, not a fixed list`,
          remedy: 'set it from the CLI: tm8 task axis <task-id> ' + axis.name + ' <value>',
        }}
      >
        {currentPill}
      </DisabledAction>
    );
  }

  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return <CheckingPermission label={`Change ${axis.name}`} />;
  }

  /* `canEdit`, exactly as `RowValueControl`: the value travels in the kind's
     content patch, which the server authorizes as an edit. */
  if (props.capabilitiesOf && props.capabilitiesOf(row.id)?.canEdit === false) {
    return (
      <DisabledAction label={`Change ${axis.name}`} reason={toReason(REASONS.cannotEdit)}>
        {currentPill}
      </DisabledAction>
    );
  }

  if (!props.onSetAxis) {
    return (
      <DisabledAction label={`Change ${axis.name}`} reason={NOT_WIRED_REASON}>
        {currentPill}
      </DisabledAction>
    );
  }

  const known = axis.axisValues.includes(current);
  return (
    <span className="lp__statewrap">
      <select
        id={selectId}
        className="lp__statesel lp__statesel--live kit-pill--idle"
        aria-label={`Change ${axis.name} for ${row.title}`}
        data-testid="row-axis-select"
        data-source={`axis:${axis.name}`}
        value={current}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const next = e.target.value;
          if (next === current) return;
          props.onSetAxis?.(row.id, axis.name, next === '' ? null : next, label);
        }}
      >
        {/* Unset is a real, REACHABLE state here — the one honest difference
            from RowValueControl's disabled empty option. */}
        <option value="">{emptyLabel}</option>
        {/* A stored value outside today's vocabulary still shows the truth
            (the axis was re-valued since this task was written); it is
            offered only as the current state, not as a choice. */}
        {!known && current !== '' ? (
          <option value={current} disabled>
            {current}
          </option>
        ) : null}
        {axis.axisValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * THE MENU LEAVES ITS TILE — a portal with FIXED coordinates, measured on
 * open. The first fix for "the drop downs are going under the screen" flipped
 * an absolutely-positioned menu upward, and it was not enough, because the
 * menu could not leave the tile at all: `.pn-tt` carries `overflow: hidden`
 * AND `container-type: inline-size`, whose layout containment makes the tile
 * the containing block even for `position: fixed` — the menu was CLIPPED at
 * the card edge, which reads exactly like "going under the next task". The
 * hovered `.lp__tile`'s transform traps it the same way.
 *
 * So the menu renders through a PORTAL into the `.cv2-root` (its ancestor for
 * every themed `--pn-*` variable and `.cv2-root .lp__assignmenu` rule), with
 * viewport-fixed coordinates from the trigger's rect: below it by default,
 * ABOVE it when the space below is shorter than the menu's max-height and the
 * space above is taller. Fixed coordinates do not travel, so any outside
 * scroll or a resize closes the menu rather than letting it drift off its
 * row; scrolls INSIDE the menu (its own overflow-y) are its own business.
 */
interface MenuAnchor {
  style: CSSProperties;
  host: HTMLElement;
}

function useMenuAnchor(
  open: boolean,
  boxRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): MenuAnchor | null {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const el = boxRef.current;
    const box = el?.getBoundingClientRect();
    if (!el || !box) return;
    const host = (el.closest('.cv2-root') as HTMLElement | null) ?? document.body;
    // 214 = the menu's own max-height (210, panels.css) + its 4px offset.
    const below = window.innerHeight - box.bottom;
    const up = below < 214 && box.top > below;
    setAnchor({
      host,
      style: {
        position: 'fixed',
        // Clamped so a trigger at the right edge cannot push the menu's
        // 170px minimum off-screen.
        left: Math.max(8, Math.min(box.left, window.innerWidth - 178)),
        ...(up
          ? { top: 'auto', bottom: window.innerHeight - box.top + 4 }
          : { top: box.bottom + 4 }),
        zIndex: 1000,
      },
    });
    const close = (event: Event) => {
      if (
        menuRef.current
        && event.target instanceof Node
        && menuRef.current.contains(event.target)
      ) return;
      onClose();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, boxRef, menuRef, onClose]);
  return anchor;
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
  const menuRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open, boxRef, menuRef, close);

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
      {open && anchor ? createPortal(
        <span
          ref={menuRef}
          className="lp__assignmenu"
          style={anchor.style}
          role="group"
          aria-label={`Assign ${row.title}`}
        >
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
        </span>,
        anchor.host,
      ) : null}
    </span>
  );
}

/**
 * The curated-set picker — "Collections" on every list row (migration 100).
 *
 * THE SAME MECHANIC AS ASSIGNMENT, MIRRORED: one edge per menu row, toggled
 * individually, current state marked ✓. The differences are exactly the ones
 * the registry field's docblock names — the edge runs FROM the set TO this
 * row, so the current marks come from the row's INCOMING `connectionsOf`
 * projection rather than a state field, and the write goes through the
 * addItem/removeItem pair rather than the generic edge verbs.
 *
 * THE MENU IS A BOUNDED RECENCY PAGE, stated as such: `search.query` is
 * reserved, so the host hydrates one `collections.query` page of the set kind
 * and this menu offers that page — never "everything".
 *
 * NO ROW-CAPABILITY GATE beyond the loading state, deliberately: adding a row
 * to a set edits the SET (the `contains` edge hangs off the collection), so
 * the row's own `canEdit`/`canLink` answers the wrong question. The node
 * authorizes the write, and a refusal surfaces through the host's notice —
 * attempted-and-refused, the same posture as the board (§8.5).
 *
 * TWO ANATOMIES, ONE CONTROL (user ruling 2026-08-13: "every entity tile
 * should have option to add it to a collection"). `face` is the expanded
 * strip's labelled badge, exactly as before; `icon` is the COLLAPSED tile's
 * hover-cluster button — same menu, same gates, same refusal words, because a
 * second copy of a membership control is exactly the duplication D67 removed.
 * EXPORTED so the tile anatomies can mount the icon form directly.
 */
export function RowMembershipControl({
  row,
  props,
  control,
  variant = 'face',
}: {
  row: ControlSubject;
  props: ControlHost;
  control: MembershipListControl;
  /** `icon` for the collapsed tile's action cluster. */
  variant?: 'face' | 'icon';
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open, boxRef, menuRef, close);

  // The sets currently containing this row: its incoming edges of the
  // declared type, sources collected. Live — the projection advances with
  // edge events and detail refetches, so a just-added ✓ appears without a
  // second click.
  const connections = props.connectionsOf?.(row.id);
  const containing = new Map<string, string>();
  for (const group of connections?.incoming ?? []) {
    if (group.type !== control.edgeType) continue;
    for (const edge of group.edges) containing.set(edge.source.id, edge.source.title);
  }
  const names = [...containing.values()];

  const icon = variant === 'icon';
  const label = `Change ${control.label.toLowerCase()} for ${row.title}`;
  /* The icon form wears the set kind's own glyph — the same mark the lens
     trigger and the collection rows carry, so the affordance reads as "this
     row, into one of those". */
  const glyph = <KindIcon kind={control.setKind} />;
  const face = icon ? (
    <span aria-hidden>{glyph}</span>
  ) : (
    <span className="pn-badge pn-badge--membership" data-testid="row-membership-face">
      {names.length === 0
        ? control.emptyLabel
        : names.length === 1
          ? names[0]
          : `${names[0]} +${names.length - 1}`}
    </span>
  );

  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return icon
      ? <CheckingPermission label={label} glyph={glyph} />
      : <CheckingPermission label={`Change ${control.label.toLowerCase()}`} />;
  }
  if (!props.onMembership || !props.connectionsOf) {
    return icon ? (
      <DisabledIconControl label={label} glyph={glyph} reason={NOT_WIRED_REASON} />
    ) : (
      <DisabledAction label={`Change ${control.label.toLowerCase()}`} reason={NOT_WIRED_REASON}>
        {face}
      </DisabledAction>
    );
  }

  /**
   * A set can never offer ITSELF as its own container — the node refuses the
   * self-edge, so offering it would be a menu row that can only fail.
   */
  const sets = (props.membershipSets ?? []).filter((candidate) => candidate.id !== row.id);
  if (sets.length === 0) {
    const reason = {
      cause: `No ${control.label.toLowerCase()} are loaded for this space.`,
      remedy: 'Create one from its own list first; the menu offers the most recent page once any exist.',
    };
    return icon ? (
      <DisabledIconControl label={label} glyph={glyph} reason={reason} />
    ) : (
      <DisabledAction label={`Change ${control.label.toLowerCase()}`} reason={reason}>
        {face}
      </DisabledAction>
    );
  }

  return (
    <span className="lp__assignwrap" ref={boxRef}>
      <button
        type="button"
        className={icon ? 'lp__rowaction' : 'lp__assignbtn'}
        data-testid="row-membership-trigger"
        title={icon ? label : undefined}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {face}
      </button>
      {open && anchor ? createPortal(
        <span
          ref={menuRef}
          className="lp__assignmenu"
          style={anchor.style}
          role="group"
          aria-label={`${control.label} for ${row.title}`}
        >
          {sets.map((set) => {
            const on = containing.has(set.id);
            return (
              <button
                key={set.id}
                type="button"
                className={on ? 'lp__assignopt lp__assignopt--on' : 'lp__assignopt'}
                data-testid="row-membership-option"
                data-set={set.id}
                aria-pressed={on}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onMembership?.(row.id, set.id, !on);
                }}
              >
                <KindIcon kind={set.kind} />
                <span className="lp__assignopt-name">{set.title}</span>
                <span className="lp__assignopt-mark" aria-hidden>
                  {on ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </span>,
        anchor.host,
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
 *
 * TWO ANATOMIES, ONE CONTROL — the same pairing `RowMembershipControl` makes,
 * for the same reason (user ruling 2026-08-16: "there is a status button on
 * the task tile... clicking on that should move it to done"). `select` is the
 * expanded strip's dropdown, unchanged; `dot` is the COLLAPSED tile's status
 * mark, which until now was an inert `<span>` that looked pressable and was
 * not. Same options, same gates, same refusal words — a second copy is exactly
 * the duplication D67 removed once already.
 *
 * THE MENU OFFERS THE WHOLE VOCABULARY, not a `done` toggle. `set_work_state`
 * accepts any value from any other, so a control that only ever wrote `done`
 * would misname itself on six of seven values and have no way back; and `done`
 * in particular routes through `complete`, which carries the acceptance gate —
 * a refusal needs somewhere to be SAID, which a bare dot has not got. The
 * unconditional one-click Complete already exists as a row action beside it.
 */
export function RowStateControl({
  row,
  props,
  control,
  pill,
  variant = 'select',
  glyph,
}: {
  row: ControlSubject;
  props: ControlHost;
  control: StateControl | undefined;
  /** The kind's existing value→word / value→tone map. The ONLY source for both. */
  pill: StatusPillSpec | undefined;
  /** `dot` for the collapsed tile's status mark. */
  variant?: 'select' | 'dot';
  /**
   * The tile's own status mark, passed in rather than drawn here: the tile
   * resolves which mark to draw against liveness precedence, and a refusal
   * must carry the SAME mark as the live control or the row changes shape at
   * the moment it refuses.
   */
  glyph?: ReactNode;
}) {
  const selectId = useId();
  const dot = variant === 'dot';
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open, boxRef, menuRef, close);
  const wordFor = (value: string): string =>
    pill?.labels?.[value] ?? value.replace(/_/g, ' ');
  const toneFor = (value: string): PillTone => pill?.tones?.[value] ?? 'idle';
  const label = `Change state for ${row.title}`;
  /* The refusal FORM follows the anatomy, not the reason: prose under a strip
     control, which has room for it; a tooltip on a 16px mark, which has not.
     Both are DisabledWithReason — the split is the one that primitive names. */
  const refuse = (reason: UnavailableReason, face: ReactNode) =>
    dot ? (
      <DisabledIconControl label={label} glyph={glyph} reason={reason} />
    ) : (
      <DisabledAction label="Change state" reason={reason}>
        {face}
      </DisabledAction>
    );

  if (!control) {
    return refuse(
      {
        cause: `${getKind(props.kind).label} has no state to set on this node`,
        remedy: 'the contract records no status field for this kind, so nothing could be written',
      },
      <span className="lp__statesel lp__statesel--absent">no state</span>,
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
    return refuse(toReason(control.readOnlyReason), currentPill);
  }

  if (props.capabilitiesOf && props.capabilitiesOf(row.id) === undefined) {
    return dot ? (
      <CheckingPermission label={label} glyph={glyph} />
    ) : (
      <CheckingPermission label="Change state" />
    );
  }

  const availability = resolveAction(control.command).availability({
    ...props.ctx,
    entityId: row.id,
    kind: row.kind,
    capabilities: props.capabilitiesOf?.(row.id) ?? null,
    liveness: props.livenessOf?.(row.id),
  });

  if (availability.kind === 'disabled') {
    return refuse(toReason(availability.reason), currentPill);
  }

  if (!props.onSetState) {
    return refuse(NOT_WIRED_REASON, currentPill);
  }

  if (dot) {
    const word = current === '' ? 'unknown' : wordFor(current);
    return (
      <span className="lp__assignwrap" ref={boxRef}>
        <button
          type="button"
          className="lp__statedot"
          data-testid="row-state-trigger"
          /* The trigger carries the CURRENT value in its name and its tooltip,
             so a value the registry does not list — which the menu has no row
             for — is still stated rather than silently unrepresented. */
          title={`${word} — change state`}
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={`${label}, currently ${word}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {glyph}
        </button>
        {open && anchor
          ? createPortal(
              <span
                ref={menuRef}
                className="lp__assignmenu"
                style={anchor.style}
                /* Radio, not the membership menu's toggles: these values are
                   mutually exclusive, and exactly one is always true. */
                role="radiogroup"
                aria-label={`State for ${row.title}`}
              >
                {control.options.map((o) => {
                  const on = o.id === current;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      className={on ? 'lp__assignopt lp__assignopt--on' : 'lp__assignopt'}
                      data-testid="row-state-option"
                      data-state={o.id}
                      aria-checked={on}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        if (on) return;
                        // The option's own `via` wins, exactly as in the
                        // select: `done` must reach the completion verb.
                        props.onSetState?.(row.id, o.id, o.via ?? control.command);
                      }}
                    >
                      {/* WORDS ONLY, exactly as the select's options are. A
                          dot per row would have to invent a tone AND a fill
                          for a value no record holds — `renderBadge` derives
                          both from a row, and there is no row to derive them
                          from until the value is chosen. The mark stays where
                          it is a fact: on the trigger. */}
                      <span className="lp__assignopt-name">{wordFor(o.id)}</span>
                      <span className="lp__assignopt-mark" aria-hidden>
                        {on ? '✓' : ''}
                      </span>
                    </button>
                  );
                })}
              </span>,
              anchor.host,
            )
          : null}
      </span>
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
