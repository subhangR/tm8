import { useEffect, useRef, type FormEvent, type MouseEvent } from 'react';
import type { FileUploadTask } from '../files/upload';
import { ProseField, type TriggerOption } from '../rich-input';
import { RefusalCard } from './RefusalCard';
import type { EntityEditHandle } from './useEntityEdit';
import type { EntityEdits } from './commands';
import { loopScheduleProblem, nextLoopRunAt } from '../loops/schedule';
/**
 * THE PHONE ARRANGEMENT, IMPORTED BY THE COMPONENT AND NOT BY `index.ts`.
 *
 * `authoring.css` is imported by `authoring/index.ts`, on the stated reasoning
 * that a host taking one symbol gets the whole vocabulary. That reasoning has a
 * hole a lane has already fallen down (#455): a DEEP-PATH import bypasses the
 * barrel entirely, and `loops/LoopCreateControl.tsx` — which wears `.au-dialog`
 * for the whole `scheduled-work` create form — imports `../authoring/commands`
 * and `../authoring/RefusalCard` directly. It has never pulled the barrel.
 *
 * It renders styled today only because something ELSE in the bundle imported
 * the barrel first, which is exactly the failure mode that lane described: it
 * looks fine until it is the first thing on screen. Importing here binds the
 * sheet to the component that draws the markup, so it cannot be lost that way.
 */
import './authoring-phone.css';

/**
 * THE `editFields` DIALOG — one component, every kind, no kind literal.
 *
 * IT KNOWS NOTHING ABOUT CHANNELS. It is handed an array of field specs and
 * draws them; the array is registry DATA (`KindConfig.editFields`), which is
 * where per-kind divergence lives (L2) and the only place in the app a kind may
 * be named at all. `no-kind-literals.test.ts` scans this directory and fails
 * the build on the string `'channel'`, so this is not a style preference — a
 * hand-written ChannelDialog could not compile here. The upside is the reason
 * the rule exists: the members roster that lands next is one more entry in that
 * array, not a second dialog to keep in step with this one.
 *
 * THE FIELD SHAPE THIS DRAWS IS THE SERVER'S, NOT A FORM DESIGNER'S. `required`
 * is a `not null` column, `grammar` is a check constraint, and an OPTIONAL field
 * is one whose column has a default — a channel's topic is `not null default ''`
 * (001:504), so leaving it blank stores `''` rather than failing. Refusing an
 * empty required field here rather than at the server is not validation theatre:
 * `channels.name` violations surface as an opaque `invariant_violation`, which
 * is precisely the failure #42 was filed for.
 *
 * NORMALISATION IS PER-KEYSTROKE AND VISIBLE. The name field shows
 * `design-review` forming as you type "Design Review", the same decision
 * `InlineTitleEditor` took: rewriting the text silently on submit means the
 * thing you typed is not the thing that was saved, and you find out later.
 */

/** The registry's `EditFieldSpec`, structurally — see `domain/types.ts`. */
export interface DialogField {
  target: 'title' | 'content';
  source?: string;
  /** Where the CURRENT value is read from, when it is not where it is written. */
  readFrom?: 'content' | 'state';
  label: string;
  required?: boolean;
  placeholder?: string;
  multiline?: boolean;
  /** Resolved by the HOST from `grammar` — this lane may not name a kind. */
  normalize?: (raw: string) => string;
  valueType?: 'text' | 'nullable-text' | 'json-object' | 'schedule' | 'date';
}

/** `YYYY-MM-DD` — the wire shape of a `date` field, and of `<input type="date">`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The draft key for a field.
 *
 * `target` is part of it because a kind may legally carry a `content.title`
 * alongside the entity's own title; keying on `source` alone would collapse
 * them into one input that writes both.
 */
export function fieldKey(field: DialogField): string {
  return field.target === 'title' ? 'title' : `content.${field.source ?? ''}`;
}

/** The staged draft, projected onto the patch shape the contract wants. */
export function editsFrom(
  fields: readonly DialogField[],
  values: Readonly<Record<string, string>>,
  initialValues?: Readonly<Record<string, string>>,
  now = new Date(),
): EntityEdits {
  const edits: EntityEdits = {};
  for (const field of fields) {
    const value = values[fieldKey(field)] ?? '';
    if (field.target === 'title') {
      edits.title = value;
      continue;
    }
    if (!field.source) continue;
    edits.content = {
      ...(edits.content ?? {}),
      [field.source]: valueForWire(field, value),
    };
    if (
      field.valueType === 'schedule'
      && initialValues !== undefined
      && value !== (initialValues[fieldKey(field)] ?? '')
    ) {
      const next = nextLoopRunAt(value, now);
      if (next === null) throw new Error('schedule does not match any time in the next year');
      edits.content.nextRunAt = next.toISOString();
    }
  }
  return edits;
}

function valueForWire(field: DialogField, value: string): unknown {
  if (field.valueType === 'nullable-text') return value.trim() === '' ? null : value.trim();
  if (field.valueType === 'json-object') return JSON.parse(value) as Record<string, unknown>;
  /**
   * AN EMPTIED DATE IS `null`, AND NOTHING ELSE WILL CLEAR IT.
   *
   * The obvious "send only what changed" patch cannot express this: the
   * server's `update_task_content` COALESCEs an absent `dueDate` to the stored
   * value and only treats an EXPLICIT `null` as a clear
   * (`handlers/entities.ts:682-685`). Omitting the key on an emptied field
   * would therefore round-trip as success and leave the old date in place —
   * the user clears the box, presses Save, and the date comes back.
   *
   * `''` is not an option either: the column is a `date`, so an empty string is
   * an invalid input rather than an empty value the way `channels.topic`'s
   * `not null default ''` makes it one.
   */
  if (field.valueType === 'date') return value.trim() === '' ? null : value.trim();
  return value;
}

/** Project a typed detail value into the dialog's editable string draft. */
export function draftValueFor(field: DialogField, raw: unknown): string {
  if (field.valueType === 'json-object') {
    return isRecord(raw) ? JSON.stringify(raw, null, 2) : '{}';
  }
  /**
   * `<input type="date">` shows a BLANK box for anything that is not exactly
   * `YYYY-MM-DD`, silently. A stored value the control cannot represent would
   * therefore read as "no due date" and the next Save would clear it for real.
   * Truncating a timestamp to its date part keeps the day the user was looking
   * at; anything else falls back to empty, which is at least the same answer
   * the control would have drawn anyway.
   */
  if (field.valueType === 'date') {
    if (typeof raw !== 'string') return '';
    const day = raw.slice(0, 10);
    return DATE_ONLY.test(day) ? day : '';
  }
  return typeof raw === 'string' ? raw : '';
}

/** A field-level refusal stated before the command spends a round trip. */
export function fieldProblem(field: DialogField, value: string): string | null {
  if (field.valueType === 'schedule') return loopScheduleProblem(value);
  if (field.valueType === 'date') return dateProblem(field, value);
  if (field.valueType !== 'json-object') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? null : `${field.label} must be a JSON object.`;
  } catch {
    return `${field.label} must be valid JSON.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A calendar day the SERVER would also accept, checked here rather than there.
 *
 * Empty is not a problem — it is the clear (`valueForWire`). A browser's own
 * date picker cannot produce anything else, so this guard is for the two ways
 * around it: a form autofilled by an extension, and `2026-02-30`, which is
 * shaped like a date and is not one. Postgres refuses that second one as an
 * opaque `invariant_violation`, which is the same failure #42 was filed for.
 *
 * The round-trip through `Date` is what rejects it: `Date.UTC` normalises
 * February 30th to March 2nd, so a day that survives re-rendering is real.
 */
function dateProblem(field: DialogField, value: string): string | null {
  const day = value.trim();
  if (day === '') return null;
  const refusal = `${field.label} must be a calendar date (YYYY-MM-DD).`;
  if (!DATE_ONLY.test(day)) return refusal;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const normalized = new Date(Date.UTC(year, month - 1, date));
  return normalized.toISOString().slice(0, 10) === day ? null : refusal;
}

/** The fields whose `required` promise the draft does not keep. */
export function missingRequired(
  fields: readonly DialogField[],
  values: Readonly<Record<string, string>>,
): readonly DialogField[] {
  return fields.filter((f) => f.required && (values[fieldKey(f)] ?? '').trim() === '');
}

export function EditEntityDialog({
  flow,
  fields,
  title,
  submitLabel = 'Save',
  skillOptions,
  attach,
  onAttached,
}: {
  flow: EntityEditHandle;
  /** From the registry row, resolved by the host. Empty ⇒ nothing to draw. */
  fields: readonly DialogField[];
  /** "Edit channel" — built by the host from the registry `label`. */
  title: string;
  submitLabel?: string;
  /** Skills `/` can reference inside a multiline field (R1). */
  skillOptions?: readonly TriggerOption[];
  /**
   * Uploads a file against the entity BEING EDITED and writes its reference
   * at the caret (R4). Bound by the host, so this lane never learns which
   * entity it is writing to. Absent ⇒ drop and paste stay inert.
   */
  attach?: (file: File) => FileUploadTask;
  /** An upload landed — the host refetches so the new attachment appears. */
  onAttached?: () => void;
}) {
  const saving = flow.state.phase === 'saving';
  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!flow.open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        event.stopPropagation();
        flow.cancel();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [flow, flow.open, saving]);

  useEffect(() => {
    if (flow.open) firstField.current?.focus();
  }, [flow.open]);

  if (!flow.open || fields.length === 0) return null;

  const missing = missingRequired(fields, flow.values);
  const problems = fields
    .map((field) => ({ field, problem: fieldProblem(field, flow.values[fieldKey(field)] ?? '') }))
    .filter((item): item is { field: DialogField; problem: string } => item.problem !== null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving || missing.length > 0 || problems.length > 0 || flow.unavailable) return;
    void flow.save(editsFrom(fields, flow.values, flow.initialValues));
  };

  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div
      className="au-dialog__backdrop"
      role="presentation"
      data-testid="edit-entity-backdrop"
      onMouseDown={() => !saving && flow.cancel()}
    >
      <form
        className="au-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="edit-entity-dialog"
        onSubmit={submit}
        onMouseDown={stop}
      >
        <h2 className="au-dialog__title">{title}</h2>

        {fields.map((field, index) => {
          const key = fieldKey(field);
          const value = flow.values[key] ?? '';
          const empty = field.required && value.trim() === '';
          const problem = fieldProblem(field, value);
          return (
            <label className="au-dialog__field" key={key}>
              <span className="au-dialog__label">
                {field.label}
                {/* OPTIONAL IS SAID OUT LOUD. The alternative convention —
                    marking the required ones — reads as "everything else is
                    also expected, we just did not star it", which is the
                    opposite of what an optional topic means here. */}
                {field.required ? null : <em className="au-dialog__optional"> · optional</em>}
              </span>
              {field.multiline ? (
                /* THE MULTILINE FIELDS ARE THE ONES THAT REACH AGENT CONTEXT
                   — a description is read by every agent that opens the
                   entity — so they take the shared prose input: `/` to
                   reference a skill, and drop/paste to insert a file at the
                   caret. The one-line boxes below stay plain, per the ruling
                   on title-shaped fields. */
                <ProseField
                  value={value}
                  onChange={(next) => flow.set(key, field.normalize ? field.normalize(next) : next)}
                  label={field.label}
                  className="au-dialog__input"
                  testId={`edit-field-${key}`}
                  rows={3}
                  disabled={saving}
                  {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                  {...(index === 0 ? { inputRef: (el: HTMLTextAreaElement | null) => { firstField.current = el; } } : {})}
                  {...(skillOptions ? { skillOptions } : {})}
                  {...(attach ? { attach } : {})}
                  {...(onAttached ? { onAttached } : {})}
                />
              ) : (
                <input
                  ref={index === 0 ? (el) => { firstField.current = el; } : undefined}
                  className="au-dialog__input"
                  /*
                   * THE NATIVE PICKER, and it earns its place by being the only
                   * control that cannot produce a value the column refuses: it
                   * emits `YYYY-MM-DD` or nothing, in the viewer's own locale
                   * and calendar, with no timezone in it to shift. A text box
                   * would hand the shape problem to the user, and a JS calendar
                   * would hand it to us.
                   */
                  type={field.valueType === 'date' ? 'date' : 'text'}
                  value={value}
                  placeholder={field.placeholder}
                  disabled={saving}
                  data-testid={`edit-field-${key}`}
                  onChange={(e) => flow.set(key, field.normalize ? field.normalize(e.target.value) : e.target.value)}
                />
              )}
              {empty ? (
                <span className="au-dialog__missing" role="alert">
                  {`${field.label} is required — the server refuses an empty one.`}
                </span>
              ) : null}
              {!empty && problem ? (
                <span className="au-dialog__missing" role="alert">{problem}</span>
              ) : null}
            </label>
          );
        })}

        {/*
         * THE UNAVAILABLE REASON IS SHOWN, not silently disabling the button.
         * A Save that is greyed out with no sentence beside it is the exact
         * "I press it and nothing happens" report this whole ticket came from.
         */}
        {flow.unavailable ? (
          <p className="au-dialog__unavailable" role="note">
            <strong>{flow.unavailable.cause}</strong> — {flow.unavailable.remedy}
          </p>
        ) : null}

        {flow.state.phase === 'conflict' || flow.state.phase === 'refused' ? (
          <RefusalCard
            word={flow.state.failure.cause}
            detail={flow.state.failure.detail}
            aftermath={flow.state.failure.aftermath}
            moves={[{ label: 'back to the form', onSelect: flow.dismiss }]}
          />
        ) : null}

        <div className="au-dialog__actions">
          <button type="button" onClick={flow.cancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="au-dialog__primary"
            aria-busy={saving}
            disabled={saving || missing.length > 0 || problems.length > 0 || flow.unavailable !== null}
          >
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
