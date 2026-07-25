/**
 * Task-axis management — the whole point of "default and manual axes are
 * indistinguishable": every axis here is the same row, and adding one makes it
 * immediately available as a `groupBy` pivot on every collection.
 *
 * Full CRUD against the facade's axis commands (`createTaskAxis`,
 * `updateTaskAxis`, `deleteTaskAxis`). Default axes are not deletable — the
 * facade rejects that with `forbidden`, so the row simply doesn't offer it.
 */
import { useCallback, useState } from 'react';
import { IconBtn, Pill } from '../../kit';
import { isCollabError } from '../../types';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { SpaceId, TaskAxis } from '../../types/contract';

const DEFAULT_AXIS_KIND: TaskAxis['kind'] = 'default';

function splitValues(raw: string): string[] {
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

function describe(e: unknown): string {
  if (isCollabError(e)) {
    switch (e.code) {
      case 'invalid_input': return 'That name is already taken — pick another.';
      case 'forbidden': return 'A default axis cannot be changed here.';
      case 'not_found': return 'That axis is already gone.';
      default: return e.message;
    }
  }
  return 'Something went wrong.';
}

export interface TaskAxesSectionProps {
  facade: CollabFacade;
  spaceId: SpaceId;
  axes: TaskAxis[];
  /** The node cannot serve axes at all — distinct from "none defined yet". */
  unavailable?: boolean;
  /** Re-read the axes after a write (the settings screen owns the read). */
  onChanged: () => void;
}

export function TaskAxesSection({ facade, spaceId, axes, unavailable = false, onChanged }: TaskAxesSectionProps) {
  const [name, setName] = useState('');
  const [values, setValues] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await op();
      onChanged();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const add = (): void => {
    const axisValues = splitValues(values);
    if (!name.trim() || axisValues.length === 0) {
      setError('An axis needs a name and at least one value.');
      return;
    }
    void run(async () => {
      await facade.createTaskAxis(spaceId, {
        name: name.trim(),
        axisValues,
        kind: 'manual',
        position: axes.length,
      });
      setName('');
      setValues('');
    });
  };

  return (
    <section className="cv2-set__section" aria-label="Task axes">
      <header className="cv2-set__sectionhead">
        <h2 className="cv2-set__h2">Task axes</h2>
        <p className="cv2-set__note">
          Any axis can group any collection. Manual axes behave exactly like the built-ins.
        </p>
      </header>

      <div className="cv2-set__rows" data-testid="settings-axes">
        {axes.map((axis) => (
          <AxisRow
            key={axis.id}
            axis={axis}
            busy={busy}
            onRename={(next) => void run(() => facade.updateTaskAxis(spaceId, axis.id, next))}
            onDelete={() => void run(() => facade.deleteTaskAxis(spaceId, axis.id))}
          />
        ))}
        {axes.length === 0 && (
          <p className="cv2-empty-line">
            {unavailable
              ? 'Task axes are not available on this node — the axis operations are not built yet.'
              : 'No axes yet.'}
          </p>
        )}
      </div>

      <div className="cv2-set__form">
        <input
          className="cv2-set__input"
          aria-label="New axis name"
          placeholder="axis name (e.g. surface)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="cv2-set__input cv2-set__input--wide"
          aria-label="New axis values"
          placeholder="values, comma separated (e.g. ui, server, cli)"
          value={values}
          onChange={(e) => setValues(e.target.value)}
        />
        <button
          type="button"
          className="cv2-actionbtn"
          data-testid="settings-axis-add"
          disabled={busy}
          onClick={add}
        >
          + Add axis
        </button>
      </div>
      {error && <p className="cv2-set__error" role="alert">{error}</p>}
    </section>
  );
}

function AxisRow({ axis, busy, onRename, onDelete }: {
  axis: TaskAxis;
  busy: boolean;
  onRename: (input: { name?: string; axisValues?: string[] }) => void;
  onDelete: () => void;
}) {
  const isDefault = axis.kind === DEFAULT_AXIS_KIND;
  const [editing, setEditing] = useState(false);
  const [draftValues, setDraftValues] = useState(axis.axisValues.join(', '));

  if (editing) {
    return (
      <div className="cv2-set__row" data-axis={axis.id}>
        <span className="cv2-set__rowname t-mono">{axis.name}</span>
        <input
          className="cv2-set__input cv2-set__input--wide"
          aria-label={`Values for ${axis.name}`}
          value={draftValues}
          onChange={(e) => setDraftValues(e.target.value)}
        />
        <button
          type="button"
          className="cv2-actionbtn"
          disabled={busy}
          onClick={() => {
            onRename({ axisValues: splitValues(draftValues) });
            setEditing(false);
          }}
        >
          Save
        </button>
        <IconBtn aria-label="Cancel" onClick={() => { setDraftValues(axis.axisValues.join(', ')); setEditing(false); }}>
          ✕
        </IconBtn>
      </div>
    );
  }

  return (
    <div className="cv2-set__row" data-axis={axis.id} data-testid={`settings-axis-${axis.name}`}>
      <span className="cv2-set__rowname t-mono">{axis.name}</span>
      <Pill tone={isDefault ? 'brand' : 'neutral'} dot={false}>{axis.kind}</Pill>
      <span className="cv2-set__rowvalues t-mono">{axis.axisValues.join(' · ')}</span>
      <span className="cv2-set__rowspace" />
      <IconBtn aria-label={`Edit ${axis.name}`} disabled={busy} onClick={() => setEditing(true)}>✎</IconBtn>
      {!isDefault && (
        <IconBtn aria-label={`Delete ${axis.name}`} disabled={busy} onClick={onDelete}>🗑</IconBtn>
      )}
    </div>
  );
}
