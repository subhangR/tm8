/**
 * SETTINGS > TASK AXES (W2, 2026-08-16) — the space curates its own taxonomy.
 *
 * THE REFUSAL THIS REPLACES WAS FALSE. `AXES_UNREADABLE` claimed "nothing in
 * the seam or the contract DEFINES the axis set for a space" — and both
 * halves were wrong the day it was measured: `TaskAxis` is in the contract
 * and `seam.spaceSettings()` already delivered `taskAxes` on the round trip
 * this shell makes for invites. This is the SECOND stale refusal found in the
 * same `reasons.ts` (the membership ones before it) — a reason names a
 * mechanism, and the mechanism moves.
 *
 * EVERY RULE IS THE SERVER'S. Space-admin authorization, name and value
 * validation, and the in-use refusals all live in SQL and are surfaced here
 * as the server's own words, never guessed client-side (the `setMemberRole`
 * law). The consequence warning under Delete is MEASURED, not imagined: the
 * node refuses to delete, rename, or remove a value while any task in the
 * space carries it (23514, `w2_delete_task_axis` / `w2_update_task_axis`) —
 * nothing is ever cleared or orphaned, so the warning says exactly that.
 *
 * THE DEFAULT AXIS IS FIXED, ITS VALUES ARE NOT (amended ruling 2026-08-16):
 * a space curates the seeded `type` axis's VALUES, but 016's two refusals —
 * "the default task axis cannot be deleted", "cannot be demoted" — stay. So
 * the seeded row's Delete is disabled-with-reason in 016's own words, while
 * Edit stays live. No demote control exists at all: the form preserves
 * `kind`, so the second refusal has no reachable trigger here.
 *
 * ── LAYOUT PASS, 2026-08-16 (SECTION-CONTRACT.md) ────────────────────────
 * The section is now built on `SectionFrame`; its hand-rolled head and
 * scroller are gone. Four things were MEASURED wrong in Chrome before that
 * and are fixed here — the numbers are in `axes-section.css`, which is this
 * section's own stylesheet and the only one this lane owns:
 *
 *   · the action column drifted 482px at 1508x882 (333px at 900x600) between
 *     the seeded row and the rows under it, because a `DisabledAction`'s
 *     96-character caption sized the flex item it sat in. The row is a grid
 *     now with a shared action track, and the drift measures 0 at both sizes;
 *   · the value set rendered as one 850px joined sentence that wrapped and
 *     dragged the axis name onto two lines. Values are a SET and are drawn as
 *     one, clamped at eight with a reveal so a pathological axis cannot bury
 *     the rows under it (clamped by COUNT, not by a scrolling pane — §3
 *     allows one scroller per section and the section already spent it);
 *   · the server's refusal rendered as a grey span at the TOP of the
 *     scroller — 155px ABOVE the button that earned it, 813px wide, hard
 *     against the scroller's left edge with no gutter — and pushed the whole
 *     list down to make room. It renders inside the row that was refused now,
 *     in the block colour, 65px BELOW its button: which is what "the refusal
 *     renders beside the act" was always supposed to mean;
 *   · the same 700px consequence sentence was re-typed under every row. It is
 *     an invariant of the registry, so it is stated once, above it.
 */
import { useState } from 'react';
import type { EntitySummary, TaskAxis, TaskAxisInput } from '@tm8/contract';
import { DisabledIconControl } from '../panels';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SETTINGS_SECTIONS } from './types';
import './axes-section.css';

type AxisWrite = Omit<TaskAxisInput, 'clientMutationId' | 'actorId'>;

/** The shell owns the heading list; this section reads it rather than
 *  re-typing the words, which is how twelve sections drifted the first time.
 *  A prop overrides it for a caller that renders the section somewhere else. */
const AXES_HEADING =
  SETTINGS_SECTIONS.find((s) => s.id === 'axes')?.heading ?? 'Task axes';

/**
 * How many value chips a row draws before it offers a reveal. Eight is two
 * wrapped lines at the 860px measure and the 9px mono the chips are set in —
 * enough that no realistic axis is truncated, low enough that a 200-value
 * axis cannot make one row taller than the card.
 */
const VALUE_CLAMP = 8;

export interface AxesSectionProps {
  /** `null` = the settings read failed; `[]` = a measured "none defined". */
  axes: readonly TaskAxis[] | null;
  onCreate: (input: AxisWrite) => Promise<void>;
  onUpdate: (axisId: string, input: AxisWrite) => Promise<void>;
  onDelete: (axisId: string) => Promise<void>;
  /**
   * The tasks currently carrying any value on this axis — fetched only when
   * an in-use refusal fires, so its message can name WHICH tasks to act on
   * (owner ruling: surface the refusal AND the way out, never route around
   * it). Optional: without it the server's message stands alone.
   */
  tasksUsing?: (axis: TaskAxis) => Promise<readonly EntitySummary[]>;
  /** Overrides the heading read from `SETTINGS_SECTIONS`. */
  heading?: string;
}

/** `"code, design , test"` → `['code','design','test']` — the form's one parse. */
function parseValues(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Where a refusal belongs: the row that earned it, or the create form. */
type FailureAt = { where: 'row'; axisId: string } | { where: 'create' };

export function AxesSection({
  axes,
  onCreate,
  onUpdate,
  onDelete,
  tasksUsing,
  heading = AXES_HEADING,
}: AxesSectionProps) {
  const [failure, setFailure] = useState<{ at: FailureAt; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The row whose inline editor is open; one at a time, like the invite form. */
  const [editing, setEditing] = useState<string | null>(null);

  async function run(at: FailureAt, act: () => Promise<void>, axis?: TaskAxis) {
    setBusy(true);
    setFailure(null);
    try {
      await act();
      setEditing(null);
    } catch (error) {
      // The server's own words — "space admin required", "task axis is still
      // in use by tasks", "cannot remove a task axis value that tasks still
      // use" — are the product copy here, because SQL is where the rule lives.
      let message = error instanceof Error ? error.message : String(error);
      // An in-use refusal is actionable only if the user knows WHICH tasks
      // hold the value; ask, and append the names. Best effort — a failed
      // lookup leaves the server's own message standing alone.
      //
      // The lookup is awaited BEFORE the state is written, deliberately: the
      // refusal paints once, in its final length. Resolving it into an
      // already-painted alert would grow the block under the reader's cursor,
      // which is the layout shift this section was asked to avoid.
      if (axis && tasksUsing && /still use|in use/i.test(message)) {
        try {
          const rows = await tasksUsing(axis);
          if (rows.length > 0) {
            const names = rows.slice(0, 5).map((r) => r.title).join(', ');
            const more = rows.length > 5 ? ` and ${rows.length - 5} more` : '';
            // "at least", honestly: the refusal is SPACE-wide, this read is
            // viewer-scoped, so the list can be shorter than the count that
            // caused the refusal. A missing name must never read as a
            // missing refusal — which is also why an empty or failed fetch
            // leaves the server's message standing alone above.
            message = `${message} — at least ${rows.length} you can see: ${names}${more}`;
          }
        } catch {
          /* the refusal stands on its own */
        }
      }
      setFailure({ at, message });
    } finally {
      setBusy(false);
    }
  }

  const ordered =
    axes === null ? [] : [...axes].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const rowFailure = (axisId: string) =>
    failure && failure.at.where === 'row' && failure.at.axisId === axisId ? failure.message : null;

  return (
    <SectionFrame
      title={heading}
      bodyTestId="axes-body"
      // The rows carry their own `--set-gutter`, so their hairline reaches the
      // edge of the measure column and reads as a table rule (§2, `pad`).
      pad={false}
      // NO HEAD ACTION, and the reason belongs in the record rather than in a
      // silence. A `+ New axis` chip that focused the standing form was built
      // and then REMOVED: `settings.test.tsx` sweeps every enabled control on
      // every section against one shared `LIVE_VERBS` allowlist, so a section
      // cannot add a head control without editing the shell's test — a file
      // eleven parallel lanes share and SECTION-CONTRACT.md §5 puts out of
      // bounds. The create form stands open at the foot of the registry and is
      // reached through the section's one scroller, which is what that
      // scroller is for. Reported to the coordinator: `SectionFrame` advertises
      // an `action` slot no section lane can currently fill.
    >
      {axes === null ? (
        <SectionAbsent
          testId="axes-absent"
          head="The axis registry has not been read."
          why="the settings read did not resolve — this is an unread, not a space with no axes"
        />
      ) : (
        <>
          <div className="set-axes__group">
            <span className="set-eyebrow">Defined axes</span>
            <span className="set-axes__group-count" data-testid="axes-count">
              {ordered.length === 0
                ? 'none'
                : `${ordered.length} ${ordered.length === 1 ? 'axis' : 'axes'}`}
            </span>
          </div>

          {ordered.length === 0 ? (
            <SectionAbsent
              testId="axes-none"
              head="This space defines no task axes."
              why="define one below and every task gains its picker; tasks carry one value per axis"
            />
          ) : (
            <>
              {/* The invariant, stated ONCE for the registry instead of
                  re-typed under each row. Four axes used to buy four copies of
                  the same sentence and the section read as prose with data
                  hidden in it. */}
              <p className="set-axes__note" data-testid="axes-rule">
                Deleting an axis, renaming one, or removing one of its values is refused while any
                task still carries it — nothing is ever cleared or orphaned. The server owns that
                rule, and its own words appear beside whichever control it refuses.
              </p>

              {ordered.map((axis) =>
                editing === axis.id ? (
                  <AxisForm
                    key={axis.id}
                    heading={`Edit ${axis.name}`}
                    initial={axis}
                    busy={busy}
                    submitLabel="Save axis"
                    failure={rowFailure(axis.id)}
                    onSubmit={(input) =>
                      void run({ where: 'row', axisId: axis.id }, () => onUpdate(axis.id, input), axis)
                    }
                    onCancel={() => {
                      setFailure(null);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <AxisRow
                    key={axis.id}
                    axis={axis}
                    busy={busy}
                    failure={rowFailure(axis.id)}
                    onEdit={() => {
                      setFailure(null);
                      setEditing(axis.id);
                    }}
                    onDelete={() =>
                      void run({ where: 'row', axisId: axis.id }, () => onDelete(axis.id), axis)
                    }
                  />
                ),
              )}
            </>
          )}

          {/* No group heading above this one: the form carries its own
              eyebrow, and a `Define a new axis` group over a `New axis` form
              printed the same words twice in eleven vertical pixels. */}
          <AxisForm
            heading="New axis"
            create
            busy={busy}
            submitLabel="Create axis"
            failure={failure?.at.where === 'create' ? failure.message : null}
            // Land after the last row, like the node's own seed occupies 0.
            nextPosition={ordered.reduce((max, a) => Math.max(max, a.position + 1), 0)}
            onSubmit={(input) => void run({ where: 'create' }, () => onCreate(input))}
          />
        </>
      )}
    </SectionFrame>
  );
}

/**
 * The value vocabulary, drawn as the SET it is.
 *
 * Clamped by count rather than given a scrolling pane: §3 permits one scroller
 * per section, the section spends it on `.set-section__scroll`, and a second
 * one nested here would be handed zero overflow to distribute and would clip
 * instead of scroll.
 */
function AxisValues({ axis }: { axis: TaskAxis }) {
  const [expanded, setExpanded] = useState(false);
  if (axis.axisValues.length === 0) {
    // An empty vocabulary MEANS free text (001's own comment), and the row
    // says so — a blank here would read as "no legal values".
    return (
      <span className="set-axes__free" data-testid="axis-free">
        free text — this axis constrains nothing
      </span>
    );
  }
  const hidden = expanded ? 0 : Math.max(0, axis.axisValues.length - VALUE_CLAMP);
  const shown = hidden > 0 ? axis.axisValues.slice(0, VALUE_CLAMP) : axis.axisValues;
  return (
    <div className="set-axes__values" data-testid="axis-values-list">
      {shown.map((value) => (
        <span key={value} className="set-axes__value" data-testid="axis-value">
          {value}
        </span>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="set-axes__more"
          data-testid="axis-values-more"
          onClick={() => setExpanded(true)}
        >
          +{hidden} more
        </button>
      ) : null}
      {expanded && axis.axisValues.length > VALUE_CLAMP ? (
        <button
          type="button"
          className="set-axes__more"
          data-testid="axis-values-fewer"
          onClick={() => setExpanded(false)}
        >
          show fewer
        </button>
      ) : null}
    </div>
  );
}

function AxisRow({
  axis,
  busy,
  failure,
  onEdit,
  onDelete,
}: {
  axis: TaskAxis;
  busy: boolean;
  /** The server's refusal for THIS axis, or null. Rendered inside the row. */
  failure: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="set-axes__row" data-testid="axis-row">
      <div className="set-axes__ident">
        <span className="set-axes__name">{axis.name}</span>
        <AxisValues axis={axis} />
      </div>

      <div className="set-axes__acts">
        <span className="set-axes__prov">{axis.kind === 'default' ? 'seeded' : 'manual'}</span>
        <button
          type="button"
          className="set-axes__act"
          data-testid="axis-edit"
          disabled={busy}
          onClick={onEdit}
        >
          edit
        </button>
        {axis.kind === 'default' ? (
          /* 016's refusal, permanent by the amended ruling — shown in the
             node's own words, not hidden. Values stay editable next door.
             TOOLTIP form, not the inline-caption form: the caption form puts a
             96-character sentence INSIDE the control, and in a table's action
             track that sized the flex item and moved this row's controls 482px
             away from every other row's. The cause is not left to the tooltip
             alone — `.set-axes__rownote` below states it in standing prose. */
          <DisabledIconControl
            label={`delete ${axis.name}`}
            reason={{
              cause: 'the default task axis cannot be deleted',
              remedy: 'the seeded axis is structural (016, ruling 2026-08-16) — curate its values instead',
            }}
          >
            delete
          </DisabledIconControl>
        ) : (
          <button
            type="button"
            className="set-axes__act set-axes__act--danger"
            data-testid="axis-delete"
            disabled={busy}
            onClick={onDelete}
          >
            delete
          </button>
        )}
      </div>

      {axis.kind === 'default' ? (
        <span className="set-axes__rownote">
          the seeded axis is structural and cannot be deleted — its values are yours to curate
        </span>
      ) : null}

      {/* The refusal, in the row that earned it. It used to render at the top
          of the scroller, up to 362px above the button that was clicked. */}
      {failure ? (
        <span className="set-axes__refusal" role="alert" data-testid="axes-error">
          {failure}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One form for create and edit — `w2_update_task_axis` takes the whole row,
 * so the two writes have the same shape and earn the same controls.
 */
function AxisForm({
  heading,
  initial,
  create,
  nextPosition,
  busy,
  submitLabel,
  failure,
  onSubmit,
  onCancel,
}: {
  heading: string;
  initial?: TaskAxis;
  /** The standing create form at the foot of the registry, not a row editor. */
  create?: boolean;
  nextPosition?: number;
  busy: boolean;
  submitLabel: string;
  /** The server's refusal for this write, rendered inside the form. */
  failure?: string | null;
  onSubmit: (input: AxisWrite) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [values, setValues] = useState(initial?.axisValues.join(', ') ?? '');

  return (
    <div
      className={`set-axes__form${initial ? ' set-axes__form--edit' : ''}${
        create ? ' set-axes__form--create' : ''
      }`}
      data-testid="axis-form"
    >
      <span className="set-eyebrow">{heading}</span>
      {/* Labelled fields rather than two placeholder-only inputs sharing a
          line: the placeholder vanishes on the first keystroke, and "values,
          comma separated — empty means free text" was the only place the
          parse was ever stated. */}
      <div className="set-axes__fields">
        <label className="set-axes__field">
          <span className="set-axes__label">Name</span>
          <input
            className="set-field"
            aria-label="axis name"
            data-testid="axis-name"
            placeholder="stage"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="set-axes__field">
          <span className="set-axes__label">Values</span>
          <input
            className="set-field"
            aria-label="axis values, comma separated"
            data-testid="axis-values"
            placeholder="triage, doing, done"
            value={values}
            disabled={busy}
            onChange={(e) => setValues(e.target.value)}
          />
          <span className="set-axes__hint">comma separated — leave empty for free text</span>
        </label>
      </div>
      <div className="set-axes__buttons">
        <button
          type="button"
          className="set-chip set-axes__submit"
          data-testid="axis-submit"
          disabled={busy || name.trim().length === 0}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              axisValues: parseValues(values),
              // DECISION (2026-08-16), not an oversight: there is NO kind
              // selector. `kind` is preserved on edit and 'manual' on create
              // — only the node seeds 'default', and demoting the default
              // axis is refused by 016. With no control there is no door to
              // shut; adding a selector just to wire a refusal behind it
              // would be inventing one. Do not "fix" this.
              kind: initial?.kind ?? 'manual',
              position: initial?.position ?? nextPosition ?? 0,
            })
          }
        >
          {busy ? 'Working…' : submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="set-axes__act"
            data-testid="axis-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            cancel
          </button>
        ) : null}
      </div>
      {failure ? (
        <span className="set-axes__refusal" role="alert" data-testid="axes-error">
          {failure}
        </span>
      ) : null}
    </div>
  );
}
