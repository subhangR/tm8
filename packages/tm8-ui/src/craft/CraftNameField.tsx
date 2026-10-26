/**
 * A CRAFT'S NAME, BEING TYPED (Subhang 2026-10-18): the one inline field for
 * naming a new craft and renaming one — on the Crafts home, on a card and in
 * the craft's title. It opens focused with the text selected, so typing
 * replaces the default. Enter (or leaving the field) keeps the name; Esc
 * cancels. An empty name is not a name: it cancels too.
 */
import { useEffect, useRef, useState } from 'react';
import './craft-name-field.css';

export interface CraftNameFieldProps {
  initial: string;
  label: string;
  onCommit(name: string): void;
  onCancel(): void;
  className?: string | undefined;
  testId?: string | undefined;
  /**
   * A create form: the field plus this button (and Cancel), and leaving the
   * field does nothing — a click elsewhere must not make a craft. Absent ⇒ a
   * bare field (rename) where leaving it keeps the name.
   */
  submitLabel?: string | undefined;
}

export function CraftNameField({ initial, label, onCommit, onCancel, className, testId, submitLabel }: CraftNameFieldProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  /* One answer per field: Enter then the blur it causes must not commit twice. */
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (name) onCommit(name);
    else onCancel();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const field = (
    <input
      ref={ref}
      className={className ? `crf-name ${className}` : 'crf-name'}
      type="text"
      aria-label={label}
      value={value}
      maxLength={200}
      data-testid={testId}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
      onBlur={submitLabel ? undefined : commit}
    />
  );
  if (!submitLabel) return field;
  return (
    <form
      className="crf-name-form"
      data-testid={testId ? `${testId}-form` : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      {field}
      <button type="submit" className="dsh-btn dsh-btn--primary" data-testid={testId ? `${testId}-submit` : undefined}>
        {submitLabel}
      </button>
      <button type="button" className="dsh-btn" onClick={cancel}>
        Cancel
      </button>
    </form>
  );
}
