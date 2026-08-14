import { useEffect, useRef, type FormEvent, type MouseEvent } from 'react';
import { ProseField, type TriggerOption } from '../rich-input';
import { MEMORY_FIELDS, MEMORY_MARK_COPY, markFields } from '../domain/memory';
import type { MemoryMarkComposerHandle } from './useMemoryMarks';
import type { MemoryComposerHandle } from './useMemoryWorkingSet';

/**
 * COMPOSE A MEMORY — the four 056 scope fields, and no fifth.
 *
 * WHY IT IS NOT `EditEntityDialog`. That dialog is built on `EntityEditHandle`,
 * which opens against an EXISTING entity and captures its version to catch
 * write conflicts. There is no entity here yet and no version to pin, and a
 * memory create is two writes rather than one patch (see `useMemoryWorkingSet`).
 * Reusing it would have meant widening the edit flow to a create-with-content
 * mode it does not have. It borrows the dialog's CHROME — same class names,
 * same backdrop and escape behaviour — so the two forms are the same object to
 * a reader even though they are not the same flow.
 *
 * WHY ALL FOUR FIELDS ARE REQUIRED AND SAY SO. `create_memory` btrims and
 * length-checks every one of them, so a blank field earns a server refusal, not
 * a partially-saved memory. 056's design is that a claim which cannot state its
 * mechanism, its scope and what it does NOT establish is not a memory — it is
 * an opinion — and this form is where that rule is enforceable while the author
 * can still act on it.
 */
export function MemoryComposer({
  composer,
  holderLabel,
  skillOptions,
}: {
  composer: MemoryComposerHandle;
  /** Whose set this lands in, so the form says where it is going. */
  holderLabel: string;
  /**
   * Skills `/` can REFERENCE (R1). A memory is injected verbatim into agent
   * context at spawn (`--memory`), so a skill named in one reaches the agent
   * the same way it reaches one named in a message body.
   *
   * NO `attach` HERE, AND THAT IS STRUCTURAL, NOT AN OVERSIGHT: this form
   * authors an entity that DOES NOT EXIST YET (see the header — there is no
   * version to pin and no id to upload against), so there is no anchor for a
   * file to attach to. The primitive's answer to an anchorless surface is the
   * same as to any absent capability: declare it absent, and paste and drop
   * stay honestly inert.
   */
  skillOptions?: readonly TriggerOption[];
}) {
  const firstField = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!composer.open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || composer.saving) return;
      // Exactly one surface consumes the key — the layer law the launch sheet
      // states. Without this the panel underneath would also close.
      event.stopPropagation();
      composer.cancel();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [composer]);

  useEffect(() => {
    if (composer.open) firstField.current?.focus();
  }, [composer.open]);

  if (!composer.open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    composer.submit();
  };
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div
      className="au-dialog__backdrop"
      role="presentation"
      data-testid="memory-composer-backdrop"
      onMouseDown={() => !composer.saving && composer.cancel()}
    >
      <form
        className="au-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Compose a memory"
        data-testid="memory-composer"
        onSubmit={submit}
        onMouseDown={stop}
      >
        <h2 className="au-dialog__title">Remember something</h2>
        <p className="au-dialog__unavailable" role="note">
          Lands in <strong>{holderLabel}</strong>&apos;s working set and is injected at spawn.
        </p>

        {MEMORY_FIELDS.map((field, index) => {
          const value = composer.values[field.key] ?? '';
          const empty = value.trim() === '';
          return (
            <label className="au-dialog__field" key={field.key}>
              <span className="au-dialog__label">
                {field.label}
                <em className="au-dialog__optional"> · {field.hint}</em>
              </span>
              <ProseField
                value={value}
                onChange={(next) => composer.set(field.key, next)}
                label={field.label}
                className="au-dialog__input"
                testId={`memory-field-${field.key}`}
                rows={2}
                disabled={composer.saving}
                {...(index === 0 ? { inputRef: (el: HTMLTextAreaElement | null) => { firstField.current = el; } } : {})}
                {...(skillOptions ? { skillOptions } : {})}
              />
              {empty ? (
                <span className="au-dialog__missing" role="alert">
                  {`${field.label} is required — create_memory btrims it and refuses a blank.`}
                </span>
              ) : null}
            </label>
          );
        })}

        <div className="au-dialog__actions">
          <button type="button" onClick={composer.cancel} disabled={composer.saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="au-dialog__primary"
            aria-busy={composer.saving}
            disabled={composer.saving || composer.refusal !== null}
            title={composer.refusal ?? undefined}
          >
            {composer.saving ? 'Remembering…' : 'Remember'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * MARK A MEMORY — the `supersedes` / `disputes` form.
 *
 * SAME FOUR SCOPE FIELDS FIRST, then the edge's own required props, because
 * that is genuinely what happens: both marks author a NEW memory carrying the
 * evidence and then point an edge at the target (056 registers both edges with
 * evidence-bearing sources, so a mark without a claim behind it cannot be
 * stored). Showing one form makes the two-step visible instead of hiding it
 * behind a button that looks like a toggle.
 *
 * THE PERMANENCE IS STATED BEFORE THE WRITE, not after. Both edge types are
 * `append_only`; a dispute is answered by a verification and never deleted.
 * A form that let someone discover that afterwards would be the "I pressed it
 * and could not undo it" report waiting to happen.
 */
export function MemoryMarkComposer({
  composer,
  targetTitle,
  skillOptions,
}: {
  composer: MemoryMarkComposerHandle;
  /** The memory being marked, so the form never asks "which one?". */
  targetTitle: string;
  /** Same contract as `MemoryComposer` — a mark authors a NEW memory, so it
      is anchorless for the same reason and takes `/` for the same one. */
  skillOptions?: readonly TriggerOption[];
}) {
  const firstField = useRef<HTMLTextAreaElement | null>(null);
  const mark = composer.mark;

  useEffect(() => {
    if (!mark) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || composer.saving) return;
      event.stopPropagation();
      composer.cancel();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [composer, mark]);

  useEffect(() => {
    if (mark) firstField.current?.focus();
  }, [mark]);

  if (!mark) return null;
  const copy = MEMORY_MARK_COPY[mark];
  const fields = [...MEMORY_FIELDS, ...markFields(mark)];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    composer.submit();
  };
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div
      className="au-dialog__backdrop"
      role="presentation"
      data-testid="memory-mark-backdrop"
      onMouseDown={() => !composer.saving && composer.cancel()}
    >
      <form
        className="au-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        data-testid="memory-mark-composer"
        data-mark={mark}
        onSubmit={submit}
        onMouseDown={stop}
      >
        <h2 className="au-dialog__title">{copy.title}</h2>
        <p className="au-dialog__unavailable" role="note">
          Target: <strong>{targetTitle}</strong>. {copy.permanence}
        </p>

        {fields.map((field, index) => {
          const value = composer.values[field.key] ?? '';
          const empty = value.trim() === '';
          return (
            <label className="au-dialog__field" key={field.key}>
              <span className="au-dialog__label">
                {field.label}
                <em className="au-dialog__optional"> · {field.hint}</em>
              </span>
              <ProseField
                value={value}
                onChange={(next) => composer.set(field.key, next)}
                label={field.label}
                className="au-dialog__input"
                testId={`memory-mark-field-${field.key}`}
                rows={2}
                disabled={composer.saving}
                {...(index === 0 ? { inputRef: (el: HTMLTextAreaElement | null) => { firstField.current = el; } } : {})}
                {...(skillOptions ? { skillOptions } : {})}
              />
              {empty ? (
                <span className="au-dialog__missing" role="alert">
                  {`${field.label} is required — the edge\u2019s props_schema closes with additionalProperties:false, so a blank is refused at the write.`}
                </span>
              ) : null}
            </label>
          );
        })}

        <div className="au-dialog__actions">
          <button type="button" onClick={composer.cancel} disabled={composer.saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="au-dialog__primary"
            aria-busy={composer.saving}
            disabled={composer.saving || composer.refusal !== null}
            title={composer.refusal ?? copy.permanence}
          >
            {composer.saving ? 'Writing\u2026' : copy.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
