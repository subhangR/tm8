import { useEffect, useRef, type FormEvent, type MouseEvent } from 'react';
import { RefusalCard } from './RefusalCard';
import type { EntityEditHandle } from './useEntityEdit';
import type { EntityEdits } from './commands';

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
  label: string;
  required?: boolean;
  placeholder?: string;
  multiline?: boolean;
  /** Resolved by the HOST from `grammar` — this lane may not name a kind. */
  normalize?: (raw: string) => string;
}

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
): EntityEdits {
  const edits: EntityEdits = {};
  for (const field of fields) {
    const value = values[fieldKey(field)] ?? '';
    if (field.target === 'title') {
      edits.title = value;
      continue;
    }
    if (!field.source) continue;
    edits.content = { ...(edits.content ?? {}), [field.source]: value };
  }
  return edits;
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
}: {
  flow: EntityEditHandle;
  /** From the registry row, resolved by the host. Empty ⇒ nothing to draw. */
  fields: readonly DialogField[];
  /** "Edit channel" — built by the host from the registry `label`. */
  title: string;
  submitLabel?: string;
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving || missing.length > 0 || flow.unavailable) return;
    void flow.save(editsFrom(fields, flow.values));
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
                <textarea
                  ref={index === 0 ? (el) => { firstField.current = el; } : undefined}
                  className="au-dialog__input"
                  rows={3}
                  value={value}
                  placeholder={field.placeholder}
                  disabled={saving}
                  data-testid={`edit-field-${key}`}
                  onChange={(e) => flow.set(key, field.normalize ? field.normalize(e.target.value) : e.target.value)}
                />
              ) : (
                <input
                  ref={index === 0 ? (el) => { firstField.current = el; } : undefined}
                  className="au-dialog__input"
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
            disabled={saving || missing.length > 0 || flow.unavailable !== null}
          >
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
