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
 */
import { useState } from 'react';
import type { EntitySummary, TaskAxis, TaskAxisInput } from '@tm8/contract';
import { DisabledAction } from '../panels';

type AxisWrite = Omit<TaskAxisInput, 'clientMutationId' | 'actorId'>;

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
}

/** `"code, design , test"` → `['code','design','test']` — the form's one parse. */
function parseValues(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function AxesSection({ axes, onCreate, onUpdate, onDelete, tasksUsing }: AxesSectionProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The row whose inline editor is open; one at a time, like the invite form. */
  const [editing, setEditing] = useState<string | null>(null);

  async function run(act: () => Promise<void>, axis?: TaskAxis) {
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
      setFailure(message);
    } finally {
      setBusy(false);
    }
  }

  const ordered = axes === null ? [] : [...axes].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Task axes</span>
        <div className="set-section__grow" />
      </div>

      <div className="set-section__scroll">
        {failure ? (
          <span className="set-absent__why" role="alert" data-testid="axes-error">
            {failure}
          </span>
        ) : null}

        {axes === null ? (
          <div className="set-absent" data-testid="axes-absent">
            <span className="set-absent__head">The axis registry has not been read.</span>
            <span className="set-absent__why">
              the settings read did not resolve — this is an unread, not a space with no axes
            </span>
          </div>
        ) : (
          <>
            {ordered.length === 0 ? (
              <div className="set-absent" data-testid="axes-none">
                <span className="set-absent__head">This space defines no task axes.</span>
                <span className="set-absent__why">
                  define one below and every task gains its picker; tasks carry one value per axis
                </span>
              </div>
            ) : (
              ordered.map((axis) =>
                editing === axis.id ? (
                  <AxisForm
                    key={axis.id}
                    heading={`Edit ${axis.name}`}
                    initial={axis}
                    busy={busy}
                    submitLabel="Save axis"
                    onSubmit={(input) => void run(() => onUpdate(axis.id, input), axis)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <AxisRow
                    key={axis.id}
                    axis={axis}
                    busy={busy}
                    onEdit={() => {
                      setFailure(null);
                      setEditing(axis.id);
                    }}
                    onDelete={() => void run(() => onDelete(axis.id), axis)}
                  />
                ),
              )
            )}

            <AxisForm
              heading="New axis"
              busy={busy}
              submitLabel="Create axis"
              // Land after the last row, like the node's own seed occupies 0.
              nextPosition={ordered.reduce((max, a) => Math.max(max, a.position + 1), 0)}
              onSubmit={(input) => void run(() => onCreate(input))}
            />
          </>
        )}
      </div>
    </>
  );
}

function AxisRow({
  axis,
  busy,
  onEdit,
  onDelete,
}: {
  axis: TaskAxis;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="set-invite" data-testid="axis-row">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="set-invite__code">{axis.name}</span>
        <span className="set-invite__meta">
          {/* An empty vocabulary MEANS free text (001's own comment), and the
              row says so — a blank here would read as "no legal values". */}
          {axis.axisValues.length > 0 ? axis.axisValues.join(' · ') : 'free text'}
        </span>
        <div className="set-section__grow" />
        <span className="set-invite__meta">{axis.kind === 'default' ? 'seeded' : 'manual'}</span>
        <button
          type="button"
          className="set-invite__meta"
          data-testid="axis-edit"
          disabled={busy}
          onClick={onEdit}
        >
          edit
        </button>
        {axis.kind === 'default' ? (
          /* 016's refusal, permanent by the amended ruling — shown in the
             node's own words, not hidden. Values stay editable next door. */
          <DisabledAction
            label={`delete ${axis.name}`}
            reason={{
              cause: 'the default task axis cannot be deleted',
              remedy: 'the seeded axis is structural (016, ruling 2026-08-16) — curate its values instead',
            }}
          >
            delete
          </DisabledAction>
        ) : (
          <button
            type="button"
            className="set-invite__meta"
            data-testid="axis-delete"
            disabled={busy}
            onClick={onDelete}
          >
            delete
          </button>
        )}
      </div>
      <span className="set-invite__stamp">
        {/* The MEASURED consequence, stated before the click: the node refuses
            while any task uses the axis; it never clears or orphans a value. */}
        {axis.kind === 'default'
          ? `the seeded axis cannot be deleted; renaming or removing a value is refused while any task carries it`
          : `deleting is refused while any task carries a ${axis.name} value — nothing is ever cleared silently`}
      </span>
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
  nextPosition,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  heading: string;
  initial?: TaskAxis;
  nextPosition?: number;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: AxisWrite) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [values, setValues] = useState(initial?.axisValues.join(', ') ?? '');

  return (
    <div className="set-invite-form" data-testid="axis-form">
      <span className="set-eyebrow">{heading}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="set-field set-field--grow"
          aria-label="axis name"
          data-testid="axis-name"
          placeholder="axis name"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="set-field set-field--grow"
          aria-label="axis values, comma separated"
          data-testid="axis-values"
          placeholder="values, comma separated — empty means free text"
          value={values}
          disabled={busy}
          onChange={(e) => setValues(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="set-refuse--block"
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
          <button type="button" className="set-invite__meta" data-testid="axis-cancel" disabled={busy} onClick={onCancel}>
            cancel
          </button>
        ) : null}
      </div>
      <span className="set-absent__why">
        renaming an axis or removing a value is refused while any task still carries it — the server
        owns that rule and its words are shown here when it fires
      </span>
    </div>
  );
}
