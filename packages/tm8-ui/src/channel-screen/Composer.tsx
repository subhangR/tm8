import { useEffect, useRef, useState } from 'react';
import type { EntityId, MessageView } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { DisabledAction, DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import type { ChannelPostInput } from './feed-model';
import type { ComposerMentionOption } from './channel-tags';
import {
  safeUploadReason,
  type ChatAttachmentUploadTask,
  type UploadedChatAttachment,
} from './chat-attachments';

export type { ComposerMentionOption } from './channel-tags';

/**
 * THE T10 COMPOSER — §7's four send layers, as controls.
 *
 * The oracle's own footer states this component's contract in copy: "Enter
 * sends · Shift+Enter newline" and "draft keyed member+session · survives
 * switches & reconnects". A build that wires only the button has DRAWN a
 * promise it does not keep, so the keyboard path is tested beside the click.
 *
 * THE ONE THING THIS COMPONENT WILL NOT DO: pretend. Every refusal below names
 * which fact is missing, because the three ways Send can be unavailable are
 * three different situations for the person typing —
 *
 *   · no dispatcher wired   → the build cannot send (our gap, not theirs);
 *   · offline               → the network cannot carry it, and there is no
 *                             contracted offline queue, so a cheerful "queued"
 *                             would be a fabricated promise (S11);
 *   · session exited        → Send WORKS and stores; nothing is delivered and
 *                             nothing wakes (S21). This one is a warning, NOT
 *                             a disable — refusing here would destroy a
 *                             legitimate, permitted write.
 *
 * Draft state is deliberately local and deliberately sticky: a cancelled reply
 * keeps the text (the oracle says so in a tooltip), and a REJECTED send keeps
 * it too — when the mutation failed, the draft is the only copy that exists
 * anywhere (S17).
 */

export interface ComposerProps {
  anchorId: EntityId;
  anchorNoun: string;
  /** Absent ⇒ Send is disabled-with-reason, never enabled-inert. */
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  /** T4 honesty. `offline`/`polling` withdraw Send; nothing is queued. */
  connection?: ConnectionState;
  /** S21 — store-only composing. A warning, never a disable. */
  sessionExited?: boolean;
  replyTo: MessageView | null;
  onCancelReply: () => void;
  /** Production hosts control this from the member+session draft store. */
  draft?: string;
  onDraftChange?: (body: string) => void;
  uncertainSubmission?: {
    message: string;
    reconciling: boolean;
    onReconcile: () => void;
  } | null;
  /** Present only when immutable action discovery found the full file lifecycle. */
  onStartAttachmentUpload?: (file: File) => ChatAttachmentUploadTask;
  /** `undefined` means mentions are unavailable; an empty list is a measured zero. */
  mentionOptions?: readonly ComposerMentionOption[];
  /**
   * Workspace entities the attach picker offers (tasks, docs, people).
   * `undefined` means the host has no attach seam; an empty list is a
   * measured zero and keeps the control visible so it can say so.
   */
  attachEntityOptions?: readonly ComposerMentionOption[];
}

const NO_UPLOAD_SEAM = {
  cause: 'Attachments aren’t available for this Interaction Profile',
  remedy: 'the pinned composer policy must bind messages.post and the complete canonical file upload lifecycle',
};

type StagedAttachment =
  | { id: number; phase: 'uploading'; file: File }
  | { id: number; phase: 'uploaded'; file: File; uploaded: UploadedChatAttachment }
  | { id: number; phase: 'failed'; file: File; reason: string };

export function Composer({
  anchorId,
  anchorNoun,
  onPost,
  connection,
  sessionExited = false,
  replyTo,
  onCancelReply,
  draft,
  onDraftChange,
  uncertainSubmission = null,
  onStartAttachmentUpload,
  mentionOptions,
  attachEntityOptions,
}: ComposerProps) {
  const [localText, setLocalText] = useState('');
  const text = draft ?? localText;
  const setText = (next: string) => {
    if (draft === undefined) setLocalText(next);
    onDraftChange?.(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [attachedEntities, setAttachedEntities] = useState<ComposerMentionOption[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState('');
  const [attachActive, setAttachActive] = useState(0);
  const attachListbox = useRef<HTMLDivElement>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMentionOption[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSearch, setMentionSearch] = useState('');
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const mentionListbox = useRef<HTMLDivElement>(null);
  const attachmentSeq = useRef(0);
  const uploadTasks = useRef(new Map<number, ChatAttachmentUploadTask>());
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const disconnected = connection?.phase === 'offline' || connection?.phase === 'polling';
  /**
   * PREFIX, not substring. What the user typed after `@` is the start of a
   * name they are reaching for — matching mid-word (or against `meta`/`group`
   * blurb text, as this once did) makes the list churn with rows whose visible
   * label does not begin with what was typed, which reads as "the filter is
   * broken". Each whitespace-separated word is a valid starting point so a
   * surname or the second word of a session title still reaches its row.
   */
  const mentionQuery = mentionSearch.trim().toLowerCase();
  const availableMentionOptions = (mentionOptions ?? [])
    .filter((option) => !replyTo || !option.route)
    .filter((option) => {
      if (!mentionQuery) return true;
      const display = option.display.toLowerCase();
      return display.startsWith(mentionQuery)
        || display.split(/\s+/).some((word) => word.startsWith(mentionQuery));
    });

  /**
   * Clamped on read rather than stored clamped: the option list shrinks as the
   * user types, and a stored index would point past the end for the render
   * between the keystroke and any correcting effect.
   */
  const mentionActiveIndex = availableMentionOptions.length
    ? Math.min(mentionActive, availableMentionOptions.length - 1)
    : 0;
  const activeMentionOption = availableMentionOptions[mentionActiveIndex];

  const closeMentionPicker = (): void => {
    setMentionOpen(false);
    setMentionSearch('');
    setMentionRange(null);
    setMentionActive(0);
  };

  /**
   * The workspace-attach picker. Same PREFIX filter as the `@` list, same
   * one-column listbox — a different trigger for a different fact: attaching
   * references an entity on the message (tasks/docs also receive the message
   * on their own feed); it never inserts text into the draft and never routes
   * a session, which stays the `@` picker's contract.
   */
  const attachQuery = attachSearch.trim().toLowerCase();
  const availableAttachOptions = (attachEntityOptions ?? [])
    .filter((option) => !attachedEntities.some((item) => item.id === option.id)
      && !selectedMentions.some((item) => item.id === option.id))
    .filter((option) => {
      if (!attachQuery) return true;
      const display = option.display.toLowerCase();
      return display.startsWith(attachQuery)
        || display.split(/\s+/).some((word) => word.startsWith(attachQuery));
    });
  const attachActiveIndex = availableAttachOptions.length
    ? Math.min(attachActive, availableAttachOptions.length - 1)
    : 0;
  const activeAttachOption = availableAttachOptions[attachActiveIndex];

  const closeAttachPicker = (): void => {
    setAttachOpen(false);
    setAttachSearch('');
    setAttachActive(0);
  };

  const selectAttachOption = (option: ComposerMentionOption): void => {
    if (option.attach === 'anchor') {
      setAttachedEntities((current) => current.some((item) => item.id === option.id)
        ? current
        : [...current, option]);
    } else {
      // A person, attached: a canonical mention reference without touching
      // the draft text — the server echoes it into content.mentions.
      setSelectedMentions((current) => current.some((item) => item.id === option.id)
        ? current
        : [...current, option]);
    }
    closeAttachPicker();
    textarea.current?.focus();
  };

  /**
   * The toolbar `@` and typing `@` must land in the SAME state, or the picker
   * has two behaviours and only one of them filters. So the button types the
   * character on the user's behalf and hands focus straight back to the
   * textarea; from there every keystroke is the ordinary typed-trigger path.
   */
  const openMentionPickerAtCaret = (): void => {
    const field = textarea.current;
    const caret = field?.selectionStart ?? text.length;
    const prefix = text.slice(0, caret);
    const separator = prefix.length > 0 && !/\s$/.test(prefix) ? ' ' : '';
    const insertion = `${separator}@`;
    const at = caret + insertion.length;

    setText(`${prefix}${insertion}${text.slice(caret)}`);
    setMentionRange({ start: at - 1, end: at });
    setMentionSearch('');
    setMentionActive(0);
    setMentionOpen(true);
    window.setTimeout(() => {
      field?.focus();
      field?.setSelectionRange(at, at);
    }, 0);
  };

  const selectMention = (option: ComposerMentionOption): void => {
    setSelectedMentions((current) => current.some((item) => item.id === option.id)
      ? current
      : [...current, option]);

    if (mentionRange) {
      const before = text.slice(0, mentionRange.start);
      const after = text.slice(mentionRange.end).replace(/^\s+/, '');
      setText(`${before}@${option.display} ${after}`);
    } else if (!text.includes(`@${option.display}`)) {
      setText(`${text.trimEnd()}${text.trimEnd() ? ' ' : ''}@${option.display} `);
    }
    closeMentionPicker();
    textarea.current?.focus();
  };

  useEffect(() => {
    if (!uncertainSubmission) setError(null);
  }, [uncertainSubmission]);

  /**
   * Keep the highlighted row inside the scroll port. `scrollIntoView` is
   * optional-called because jsdom does not implement it — the guard keeps the
   * keyboard tests honest instead of stubbing the DOM.
   */
  useEffect(() => {
    if (!mentionOpen) return;
    const active = mentionListbox.current?.querySelector('[data-active="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [mentionOpen, mentionActiveIndex]);

  useEffect(() => {
    if (!attachOpen) return;
    const active = attachListbox.current?.querySelector('[data-active="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [attachOpen, attachActiveIndex]);

  useEffect(() => () => {
    for (const task of uploadTasks.current.values()) task.cancel();
    uploadTasks.current.clear();
  }, []);

  const startUpload = (file: File, reuseId?: number): void => {
    if (!onStartAttachmentUpload) return;
    const id = reuseId ?? ++attachmentSeq.current;
    const task = onStartAttachmentUpload(file);
    uploadTasks.current.set(id, task);
    setAttachments((current) => {
      const next: StagedAttachment = { id, phase: 'uploading', file };
      return reuseId === undefined
        ? [...current, next]
        : current.map((item) => item.id === id ? next : item);
    });
    void task.result.then((uploaded) => {
      if (uploadTasks.current.get(id) !== task) return;
      setAttachments((current) => current.map((item) =>
        item.id === id ? { id, phase: 'uploaded', file, uploaded } : item));
    }).catch((reason: unknown) => {
      if (uploadTasks.current.get(id) !== task) return;
      setAttachments((current) => current.map((item) =>
        item.id === id ? { id, phase: 'failed', file, reason: safeUploadReason(reason) } : item));
    });
  };

  const removeAttachment = (id: number): void => {
    uploadTasks.current.get(id)?.cancel();
    uploadTasks.current.delete(id);
    setAttachments((current) => current.filter((item) => item.id !== id));
  };

  const addFiles = (files: FileList | readonly File[]): void => {
    for (const file of Array.from(files)) startUpload(file);
  };

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy || !onPost || disconnected || uncertainSubmission) return;
    setBusy(true);
    setError(null);
    try {
      const attachmentIds = attachments.flatMap((item) =>
        item.phase === 'uploaded' ? [item.uploaded.fileEntityId] : []);
      const mentionIds = selectedMentions.flatMap((mention) =>
        mention.kind === 'member' || mention.kind === 'team_member' ? [mention.id] : []);
      const tagTargetIds = selectedMentions.flatMap((mention) => mention.route ? [mention.id] : []);
      if (replyTo && tagTargetIds.length) {
        throw new Error('Team and session @Tags are available only on top-level channel messages');
      }
      /* A reply has exactly ONE anchor — its parent's. The server enforces
         this; refusing here keeps the draft beside a reason instead of a
         round-trip rejection. */
      if (replyTo && attachedEntities.length) {
        throw new Error('Attached workspace entities are available only on top-level messages — a reply stays on its parent’s anchor');
      }
      await onPost({
        anchorIds: [...new Set([anchorId, ...attachedEntities.map((item) => item.id)])],
        body,
        parentMessageId: replyTo?.id ?? null,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(mentionIds.length ? { mentionIds: [...new Set(mentionIds)] } : {}),
        ...(tagTargetIds.length ? { tagTargetIds: [...new Set(tagTargetIds)] } : {}),
      });
      // Cleared ONLY on success. The reply target clears with it: the next
      // message is a new thought unless the user says otherwise.
      setText('');
      uploadTasks.current.clear();
      setAttachments([]);
      setAttachedEntities([]);
      setSelectedMentions([]);
      onCancelReply();
    } catch (e) {
      /*
       * The refusal is held HERE, beside the text that failed (T5-5's
       * anti-toast law: a refusal never leaves the surface that asked). And
       * the draft survives — S17's "Draft and attachments kept" is not a
       * courtesy, it is the only remaining copy of an unstored message.
       */
      setError(e instanceof Error ? e.message : 'The message was not stored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chs-composer">
      {sessionExited ? (
        <p className="chs-composer__warn" data-testid="chs-exited">
          Session exited — Send stores the message; nothing is delivered, nothing wakes.
        </p>
      ) : null}

      {error ? (
        <p className="chs-composer__error" role="alert">
          {error}
        </p>
      ) : null}

      {uncertainSubmission ? (
        <div className="chs-composer__uncertain" role="alert" data-testid="chs-uncertain">
          <span>{uncertainSubmission.message}</span>
          <button
            type="button"
            disabled={uncertainSubmission.reconciling}
            onClick={uncertainSubmission.onReconcile}
          >
            {uncertainSubmission.reconciling ? 'Reconciling…' : 'Reconcile send'}
          </button>
        </div>
      ) : null}

      {replyTo ? (
        <div className="chs-replying" data-testid="chs-replying">
          <span className="chs-replying__label">
            {`REPLYING TO ${replyTo.state.author?.displayName ?? replyTo.createdBy?.displayName ?? 'message'}`}
          </span>
          <span className="chs-replying__excerpt">{replyTo.content.body}</span>
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Cancel reply"
            title="cancel reply — draft text is kept"
            onClick={onCancelReply}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      ) : null}

      {attachments.length ? (
        <ul className="chs-upload-list" aria-label="Attachments" aria-live="polite">
          {attachments.map((item) => (
            <li key={item.id} className="chs-upload" data-phase={item.phase}>
              <span className="chs-upload__name">{item.file.name}</span>
              {item.phase === 'uploading' ? <span role="status">uploading…</span> : null}
              {item.phase === 'uploaded' ? <span>✓ uploaded</span> : null}
              {item.phase === 'failed' ? (
                <span role="alert" className="chs-upload__error">{item.reason}</span>
              ) : null}
              {item.phase === 'failed' ? (
                <button type="button" onClick={() => startUpload(item.file, item.id)} aria-label={`Try ${item.file.name} again`}>
                  Try again
                </button>
              ) : null}
              <button type="button" onClick={() => removeAttachment(item.id)} aria-label={`Remove ${item.file.name}`}>
                {item.phase === 'uploading' ? 'Cancel' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachedEntities.length ? (
        <ul className="chs-mention-list" aria-label="Attached workspace entities">
          {attachedEntities.map((entity) => (
            <li key={entity.id}>
              <span>{entity.display}</span>
              <span className="chs-attach-kind">{entity.kind === 'task' ? 'task' : 'doc'}</span>
              <button
                type="button"
                aria-label={`Remove attached ${entity.display}`}
                onClick={() => setAttachedEntities((current) => current.filter((item) => item.id !== entity.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {selectedMentions.length ? (
        <ul className="chs-mention-list" aria-label="Mentioned people and session targets">
          {selectedMentions.map((mention) => (
            <li key={mention.id}>
              <span>{`@${mention.display}`}</span>
              <button
                type="button"
                aria-label={`Remove tag ${mention.display}`}
                onClick={() => setSelectedMentions((current) => current.filter((item) => item.id !== mention.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachOpen && attachEntityOptions ? (
        <div className="chs-mention-picker" data-testid="chs-attach-picker">
          <input
            className="chs-attach-search"
            type="text"
            aria-label="Search workspace entities to attach"
            placeholder="Search tasks, docs, people…"
            autoFocus
            value={attachSearch}
            onChange={(event) => {
              setAttachSearch(event.target.value);
              setAttachActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeAttachPicker();
                textarea.current?.focus();
                return;
              }
              if (!availableAttachOptions.length) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setAttachActive((current) => (current + 1) % availableAttachOptions.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setAttachActive((current) => (
                  current - 1 + availableAttachOptions.length) % availableAttachOptions.length);
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                if (activeAttachOption) {
                  event.preventDefault();
                  selectAttachOption(activeAttachOption);
                }
              }
            }}
          />
          <div
            ref={attachListbox}
            role="listbox"
            aria-label="Attachable workspace entities"
          >
            {availableAttachOptions.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                data-active={index === attachActiveIndex}
                aria-selected={false}
                onMouseEnter={() => setAttachActive(index)}
                onClick={() => selectAttachOption(option)}
              >
                <span className="chs-mention-picker__name">{option.display}</span>
                <span className="chs-mention-picker__meta">{option.meta ?? option.group ?? option.kind}</span>
              </button>
            ))}
          </div>
          {availableAttachOptions.length ? null : (
            <p className="chs-mention-picker__empty" role="status">
              No attachable workspace entities match
            </p>
          )}
        </div>
      ) : null}

      {mentionOpen && mentionOptions ? (
        <div className="chs-mention-picker" data-testid="chs-mention-picker">
          {mentionQuery ? (
            <p className="chs-mention-picker__query">
              {`Matching “${mentionQuery}”`}
            </p>
          ) : null}
          <div
            id="chs-mention-options"
            ref={mentionListbox}
            role="listbox"
            aria-label="Available @Tag options"
          >
            {availableMentionOptions.map((option, index) => (
              <button
                key={option.id}
                id={`chs-mention-option-${option.id}`}
                type="button"
                role="option"
                data-active={index === mentionActiveIndex}
                aria-selected={selectedMentions.some((item) => item.id === option.id)}
                /* Pointer hover moves the highlight so the mouse and the arrow
                   keys never disagree about which row Enter would take. */
                onMouseEnter={() => setMentionActive(index)}
                onClick={() => selectMention(option)}
              >
                <span className="chs-mention-picker__name">{option.display}</span>
                <span className="chs-mention-picker__meta">
                  {option.meta ?? option.group ?? (option.kind === 'team_member' ? 'agent' : 'member')}
                </span>
              </button>
            ))}
          </div>
          {availableMentionOptions.length ? null : (
            <p className="chs-mention-picker__empty" role="status">No matching @Tag options</p>
          )}
        </div>
      ) : null}

      <div
        className="chs-composer__row"
        onDragOver={(event) => {
          if (onStartAttachmentUpload && event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!onStartAttachmentUpload || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        }}
      >
        {onStartAttachmentUpload ? (
          <>
            <button type="button" className="chs-iconbtn" aria-label="Attach a file" onClick={() => fileInput.current?.click()}>
              <span aria-hidden>＋</span>
            </button>
            <input
              ref={fileInput}
              className="chs-visually-hidden"
              type="file"
              multiple
              aria-label="Choose files to attach"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </>
        ) : (
          <DisabledIconControl label="Attach a file" glyph="＋" reason={NO_UPLOAD_SEAM} />
        )}
        {attachEntityOptions ? (
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Attach from workspace"
            title="attach a task, doc, or person — tasks and docs also receive this message on their Discussion"
            aria-haspopup="listbox"
            aria-expanded={attachOpen}
            onClick={() => {
              if (attachOpen) closeAttachPicker();
              else {
                closeMentionPicker();
                setAttachOpen(true);
              }
            }}
          >
            <span aria-hidden>⌗</span>
          </button>
        ) : null}
        {mentionOptions ? (
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Mention someone"
            aria-haspopup="listbox"
            aria-expanded={mentionOpen}
            onClick={() => {
              if (mentionOpen) closeMentionPicker();
              else openMentionPickerAtCaret();
            }}
          >
            <span aria-hidden>@</span>
          </button>
        ) : null}
        <textarea
          ref={textarea}
          className="chs-composer__input"
          aria-label={`Message ${anchorNoun}`}
          placeholder={`Message ${anchorNoun}…`}
          /* The textarea IS the picker's text input, so it carries the
             active-row pointer. `aria-expanded` is deliberately absent: it is
             not an allowed attribute on role=textbox, and promoting this to
             role=combobox would change how every existing query finds it. */
          aria-controls={mentionOpen ? 'chs-mention-options' : undefined}
          aria-activedescendant={mentionOpen && activeMentionOption
            ? `chs-mention-option-${activeMentionOption.id}`
            : undefined}
          value={text}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value;
            const caret = e.target.selectionStart ?? next.length;
            setText(next);
            const trigger = /(?:^|\s)@([^\s@]*)$/.exec(next.slice(0, caret));
            if (mentionOptions && trigger) {
              setMentionRange({ start: next.lastIndexOf('@', caret - 1), end: caret });
              setMentionSearch(trigger[1]);
              setMentionActive(0);
              setMentionOpen(true);
            } else if (mentionOpen) {
              // The trigger the picker was opened for no longer exists — the
              // user deleted the `@` or typed past it. Leaving it open would
              // float a list over the composer that nothing can now filter.
              closeMentionPicker();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (mentionOpen) closeMentionPicker();
              else if (replyTo) onCancelReply();
              return;
            }
            /**
             * The picker is driven from the textarea, never from a second
             * focusable field: focus stays where the message is being typed,
             * so ↑/↓ browse the list while every other key keeps composing.
             * These returns must precede the Enter-sends rule below — while a
             * target is highlighted, Enter commits the choice, not the message.
             */
            if (mentionOpen && availableMentionOptions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionActive((current) => (current + 1) % availableMentionOptions.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionActive((current) => (
                  current - 1 + availableMentionOptions.length) % availableMentionOptions.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                if (activeMentionOption) {
                  e.preventDefault();
                  selectMention(activeMentionOption);
                  return;
                }
              }
            }
            // Shift+Enter is the newline and must fall through to the textarea
            // untouched; anything else here would swallow a keystroke the
            // footer copy promises works.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <SendControl
          disconnected={disconnected}
          wired={Boolean(onPost)}
          busy={busy}
          empty={text.trim().length === 0}
          blocked={uncertainSubmission !== null}
          attachmentBlocked={attachments.some((item) => item.phase !== 'uploaded')}
          onClick={() => void submit()}
        />
      </div>

      <p className="chs-composer__hint">
        <span>Enter sends · Shift+Enter newline</span>
      </p>
    </div>
  );
}

function SendControl({
  disconnected,
  wired,
  busy,
  empty,
  blocked,
  attachmentBlocked,
  onClick,
}: {
  disconnected: boolean;
  wired: boolean;
  busy: boolean;
  empty: boolean;
  blocked: boolean;
  attachmentBlocked: boolean;
  onClick: () => void;
}) {
  if (!wired) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'Sending isn’t connected in this surface yet',
            remedy: 'the composer is real; its dispatcher is not wired at this mount point',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (disconnected) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'You’re offline — nothing is reaching the node',
            remedy: 'there is no offline queue, so your draft is kept here and sends when the connection returns',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (blocked) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'A previous send has an unknown storage outcome',
            remedy: 'reconcile that same submission before creating another message identity',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (attachmentBlocked) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'One or more attachments are not ready',
            remedy: 'wait for uploads to finish, retry failures, or remove them before sending',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  return (
    <button type="button" className="chs-composer__send" disabled={busy || empty} onClick={onClick}>
      {busy ? '…' : 'Send'}
    </button>
  );
}
