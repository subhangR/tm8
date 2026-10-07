/**
 * THE TITLE, IN THE EDITOR (New doc UX, 2026-10-06).
 *
 * A doc's title is written where its text is written, once — not in a second
 * bar reading "{title} · full view" above a source pane. It rides the same
 * `DocSaveHandle` as the body, so a rename and a body edit share one draft and
 * one base version: renaming while the body is unsaved can no longer trip a
 * conflict against yourself.
 *
 * "Untitled" — the title New doc creates with — shows as the placeholder,
 * not as text to delete first. Clearing the field saves "Untitled" again
 * rather than an empty title the server would refuse.
 *
 * Enter moves the caret to the body; Esc stays in the field and throws
 * nothing away.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FRESH_DOC_TITLE } from './freshDocs';
import type { DocSaveHandle } from './useDocSave';

const shownTitle = (title: string) => (title === FRESH_DOC_TITLE ? '' : title);

export function DocTitleField({
  save,
  autoFocus,
  onEnter,
}: {
  save: DocSaveHandle;
  autoFocus?: boolean;
  /** Where Enter sends the caret when the field sits outside the editor (a host's title bar). */
  onEnter?: () => void;
}) {
  const [text, setText] = useState(() => shownTitle(save.title));
  const focused = useRef(false);
  const field = useRef<HTMLInputElement | null>(null);

  /* Follow the saved title — a rename from elsewhere, a "load theirs" — but
     never under the person typing in this field. */
  useEffect(() => {
    if (!focused.current) setText(shownTitle(save.title));
  }, [save.title]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (onEnter) {
        onEnter();
        return;
      }
      e.currentTarget
        .closest('[data-doc-editor]')
        ?.querySelector<HTMLTextAreaElement>('[data-testid="doc-source"]')
        ?.focus();
    } else if (e.key === 'Escape') {
      // Esc inside a field belongs to the field (C6 layer 4), and here it
      // does nothing at all: nothing typed is ever thrown away by a key.
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <input
      ref={field}
      className="de-title"
      data-testid="doc-title"
      aria-label="Title"
      placeholder={FRESH_DOC_TITLE}
      value={text}
      readOnly={save.unavailable !== null}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        void save.flush();
      }}
      onChange={(e) => {
        setText(e.target.value);
        save.edit({ title: e.target.value.trim() === '' ? FRESH_DOC_TITLE : e.target.value });
      }}
      onKeyDown={onKeyDown}
    />
  );
}
