/**
 * A PROSE FIELD — the caret placement's view, for the surfaces that are just
 * a textarea.
 *
 * WHY THIS EXISTS AT ALL. `TriggerPopover` and `AttachmentChips` are views for
 * hosts that own their own markup around them. Four surfaces do not: the entity
 * field editor, the two memory forms and the task description are each a bare
 * `<textarea>` inside someone else's layout, and every one of them needed the
 * SAME three things bolted on — the popover positioned over the field, the
 * caret placement's live-text wiring, and a line to hold what the uploads are
 * doing. Written four times that is four chances to drift, which is the exact
 * failure this whole migration exists to end. Written once it is one component
 * whose props say what each surface declared.
 *
 * IT IS A VIEW, NOT A SECOND PRIMITIVE. Every behaviour here belongs to
 * `useRichInput`; this file contributes markup, an aria-label and a footer
 * sentence. A surface that needs anything else — the chat composer's send
 * layers, the doc editor's block strip — keeps its own markup over the hook,
 * exactly as they do today.
 *
 * NO PICKER BUTTON, DELIBERATELY. Prose fields take files by DROP and PASTE;
 * a ＋ per field would put four buttons in one memory form, and the surfaces
 * that want an explicit picker (the doc editor, the composers) already draw
 * their own beside their other controls. What is never dropped is the
 * REFUSAL: a pasted file the agent-readable filter declined, and an upload
 * that failed, are both stated here, beside the text that asked for them.
 */
import { useRef } from 'react';
import type React from 'react';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { TriggerPopover } from './TriggerPopover';
import { skillReference } from './skills';
import type { TriggerOption } from './triggers';
import { useRichInput } from './useRichInput';

export function ProseField({
  value,
  onChange,
  label,
  placeholder,
  rows = 3,
  disabled = false,
  readOnly = false,
  className,
  testId,
  inputRef,
  skillOptions,
  attach,
  onAttached,
  reference,
  onKeyDown,
  hint,
  title,
}: {
  value: string;
  onChange(next: string): void;
  /** The accessible name. These fields sit inside host-drawn labels. */
  label: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  testId?: string;
  /** For a host that focuses this field (a dialog's first box, say). */
  inputRef?: (element: HTMLTextAreaElement | null) => void;
  /** Skills `/` can REFERENCE (R1). `undefined` ⇒ `/` types plain text. */
  skillOptions?: readonly TriggerOption[];
  /**
   * Uploads one file against this field's anchor and splices a markdown
   * reference in at the caret (R4). `undefined` ⇒ the capability is absent:
   * paste and drop stay inert and no affordance claims otherwise. An
   * ANCHORLESS surface — a form for an entity that does not exist yet — is
   * exactly this case, and it needs no special path.
   */
  attach?: (file: File) => FileUploadTask;
  /** An upload landed, so a host holding an attachment list can refetch it. */
  onAttached?: () => void;
  /** Override the markdown written for one landed file. */
  reference?: (uploaded: UploadedFile) => string;
  onKeyDown?(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  /** Replaces the default "drop or paste" line. */
  hint?: string;
  /** A host's own tooltip — a read-only field's reason, typically. */
  title?: string;
}) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  /* The draft as it stands AT UPLOAD RESOLUTION, not as it stood at paste:
     an upload takes seconds and the writer keeps typing through them, so
     splicing into a click-time snapshot would discard every keystroke since. */
  const live = useRef(value);
  live.current = value;

  const writable = !disabled && !readOnly;
  const rich = useRichInput({
    value,
    onChange,
    areaRef: area,
    triggers: [{
      sigil: '/',
      options: skillOptions,
      onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
    }],
    attachments: {
      /* Withheld while the field cannot be written to: an upload that
         resolved into a read-only draft would write through `onChange` on a
         field that refuses edits. */
      start: writable ? attach : undefined,
      placement: {
        mode: 'caret',
        liveText: () => live.current,
        setText: onChange,
        ...(reference ? { reference } : {}),
        ...(onAttached ? { onInserted: onAttached } : {}),
      },
    },
    ...(onKeyDown ? { onKeyDown } : {}),
  });
  const attachments = rich.attachments!;

  const busy = attachments.busy.length > 0 ? `uploading ${attachments.busy.join(', ')}…` : null;
  const problem = attachments.error ?? attachments.refusal;
  const line = busy ?? (attach && writable ? hint ?? 'drop or paste a file to insert it here' : null);

  return (
    <div className="ri-field">
      <div className="ri-host">
        <textarea
          ref={(element) => {
            area.current = element;
            inputRef?.(element);
          }}
          className={className}
          aria-label={label}
          data-testid={testId}
          title={title}
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          {...rich.areaProps}
        />
        <TriggerPopover
          popover={rich.popover}
          label="Available skills"
          renderOption={(option) => (
            <>
              <span className="ri-popover__name">{`/${option.display}`}</span>
              {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
            </>
          )}
          emptyText="No matching skills"
        />
      </div>
      {problem ? (
        <p className="ri-field__why" role="alert">
          <span>{problem}</span>
          {attachments.refusal ? (
            <button type="button" onClick={attachments.clearRefusal} aria-label="Dismiss">
              ✕
            </button>
          ) : null}
        </p>
      ) : null}
      {line ? <p className="ri-field__hint">{line}</p> : null}
    </div>
  );
}
