/**
 * THE SHARED RICH INPUT — one headless hook behind every text surface that
 * reaches agent context.
 *
 * WHY A HOOK AND NOT A COMPONENT: three composers existed because the rich
 * one (`channel-screen/Composer.tsx`) was a screen-local component nobody
 * could mount elsewhere without its screen's chrome. The reusable thing is
 * the BEHAVIOUR — trigger grammar, popover keyboard contract, the staged
 * upload machine, insert-at-caret — not the markup. A host keeps its own
 * textarea, its own chips and its own CSS; the hook owns what every surface
 * kept reimplementing (or, worse, advertising without implementing).
 *
 * CAPABILITIES ARE DECLARED, NOT WIRED-IN. A trigger whose `options` is
 * `undefined` types as plain text; an attachments spec whose `start` is
 * `undefined` leaves paste and drop honestly inert so the host can draw its
 * disabled-with-reason control. `undefined` means "capability absent" and an
 * empty array means "a measured zero" — the same distinction the composer's
 * props already drew, kept because collapsing it makes the popover lie.
 *
 * PLACEMENT IS THE HOST'S DECLARATION (R4): chat surfaces stage attachment
 * CHIPS whose entity ids ride the message; prose surfaces insert a markdown
 * reference AT THE CARET. The primitive carries both and picks neither.
 *
 * PROVENANCE, so nothing here reads as invented: the trigger grammar and the
 * staged-attachment machine are `channel-screen/Composer.tsx`'s, generalized;
 * the caret placement is `doc-edit/DocSource.tsx`'s `useFileInsert`, moved —
 * including the two timing rules its comments prove (body read at RESOLUTION
 * through a live ref; caret read ONCE and advanced per landed file) and the
 * effect that reapplies the caret after React re-renders. Those were solved
 * once, correctly, and are deliberately not solved again here.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type React from 'react';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { safeUploadReason } from '../files/upload';
import { activeTrigger, commitTrigger, filterTriggerOptions } from './triggers';
import type { ActiveTrigger, TriggerOption } from './triggers';
import { extractReadableFiles } from './clipboardFiles';
import { fileReference, spliceInto } from './caretInsert';

export interface RichInputTriggerSpec<O extends TriggerOption = TriggerOption> {
  /** Single character, start-of-word (`@`, `/`). */
  sigil: string;
  /** `undefined` ⇒ capability absent: the sigil types as plain text. */
  options: readonly O[] | undefined;
  /**
   * What committing this option means. Return the text to splice over the
   * trigger (carry your own trailing separator), or `null` when the host
   * records the selection without touching the draft.
   */
  onSelect(option: O): { insert: string } | null;
}

export type RichInputPlacement =
  | { mode: 'chip' }
  | {
      mode: 'caret';
      /**
       * The CURRENT draft, read at upload resolution — an upload takes seconds
       * and the writer keeps typing through them; splicing into a click-time
       * snapshot would silently discard every one of those keystrokes.
       */
      liveText(): string;
      setText(next: string): void;
      /** Markdown for one landed file. Default: the `tm8://file/<id>` reference. */
      reference?(uploaded: UploadedFile): string;
      /** An upload landed and was inserted — refetch the anchor's attachments. */
      onInserted?(): void;
    };

export interface RichInputAttachmentsSpec {
  /**
   * The host-bound upload lifecycle (`createFileUploadTask` behind a seam).
   * `undefined` ⇒ the capability is absent: paste and drop stay inert and the
   * host draws its disabled-with-reason affordance.
   */
  start: ((file: File) => FileUploadTask) | undefined;
  placement: RichInputPlacement;
  /**
   * Which pasted files are taken. Default: the contract's agent-readable set
   * (R2). Drop and the host's own picker are deliberately NOT filtered — an
   * explicit gesture on a named file is its own consent; paste is filtered
   * because a clipboard is a grab-bag the user did not enumerate.
   */
  accept?: (file: File) => boolean;
}

export interface StagedAttachment {
  id: number;
  phase: 'uploading' | 'uploaded' | 'failed';
  file: File;
  uploaded?: UploadedFile;
  reason?: string;
}

export interface RichInputAttachments {
  /** Chip mode: the staged list. Caret mode: always empty. */
  staged: readonly StagedAttachment[];
  /** Caret mode: names still uploading. Chip mode: always empty. */
  busy: readonly string[];
  /** All entry points land here: paste (filtered), drop, the host's picker. */
  addFiles(files: FileList | readonly File[]): void;
  remove(id: number): void;
  retry(id: number): void;
  /** Entity ids of finished uploads, staged order — the message's `attachmentIds`. */
  uploadedIds(): string[];
  /** True while any staged upload is not finished — the Send gate. */
  blocked: boolean;
  /** Caret-mode upload failure, held beside the text that asked. */
  error: string | null;
  /** Pasted files the accept predicate refused — stated, never silent. */
  refusal: string | null;
  clearRefusal(): void;
  /** After a successful submit: forget staged uploads WITHOUT cancelling them. */
  clear(): void;
}

export interface RichInputPopover {
  sigil: string;
  query: string;
  options: readonly TriggerOption[];
  activeIndex: number;
  setActive(index: number): void;
  /** Commit an option (default: the active one) through its trigger's `onSelect`. */
  select(option?: TriggerOption): void;
  close(): void;
  listboxId: string;
  optionDomId(option: TriggerOption): string;
}

export interface RichInputAreaProps {
  onChange(event: React.ChangeEvent<HTMLTextAreaElement>): void;
  onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onDragOver(event: React.DragEvent<HTMLTextAreaElement>): void;
  onDrop(event: React.DragEvent<HTMLTextAreaElement>): void;
  'aria-controls': string | undefined;
  'aria-activedescendant': string | undefined;
}

export interface RichInput {
  /** Spread onto the host's `<textarea>`. `value` stays the host's. */
  areaProps: RichInputAreaProps;
  /** Non-null while a trigger picker is open. */
  popover: RichInputPopover | null;
  /**
   * The toolbar-button path: types the sigil at the caret (separator included)
   * and opens the picker, so the button and the typed sigil land in the SAME
   * state — a picker with two behaviours only filters in one of them.
   */
  openTrigger(sigil: string): void;
  /** Null when no attachments spec was declared. */
  attachments: RichInputAttachments | null;
}

export function useRichInput({
  value,
  onChange,
  areaRef,
  triggers = [],
  attachments,
  onKeyDown,
  onPaste,
}: {
  value: string;
  /** The host's draft setter — the hook never owns the text. */
  onChange(next: string): void;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  triggers?: readonly RichInputTriggerSpec[];
  attachments?: RichInputAttachmentsSpec;
  /** Host key handling, called ONLY when the popover did not consume the key. */
  onKeyDown?(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  /** Host paste handling, called ONLY when no readable file was taken. */
  onPaste?(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
}): RichInput {
  const listboxId = useId();
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
  const [active, setActiveState] = useState(0);

  /* insert.ts returns the caret precisely so the caller can apply it — "a
     caret left at its old offset after text was inserted before it is a
     cursor that has silently moved". Applied from an effect because the
     textarea still holds the PREVIOUS value at the moment the host's setter
     runs; the DOM has the new text only after React has re-rendered. */
  const pendingCaret = useRef<number | null>(null);
  const pendingFocus = useRef(false);
  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    if (pendingFocus.current) {
      pendingFocus.current = false;
      areaRef.current?.focus();
    }
    areaRef.current?.setSelectionRange(at, at);
  }, [value, areaRef]);

  const liveSigils = triggers.filter((spec) => spec.options !== undefined).map((spec) => spec.sigil);
  const spec = trigger ? triggers.find((candidate) => candidate.sigil === trigger.sigil) : undefined;
  const filtered = trigger && spec?.options !== undefined
    ? filterTriggerOptions(spec.options, trigger.query)
    : [];

  /**
   * Clamped on read rather than stored clamped: the option list shrinks as
   * the user types, and a stored index would point past the end for the
   * render between the keystroke and any correcting effect.
   */
  const activeIndex = filtered.length ? Math.min(active, filtered.length - 1) : 0;

  const close = (): void => {
    setTrigger(null);
    setActiveState(0);
  };

  const select = (option?: TriggerOption): void => {
    const chosen = option ?? filtered[activeIndex];
    if (!chosen || !trigger || !spec) return;
    const commit = spec.onSelect(chosen);
    if (commit) {
      const end = Math.min(trigger.range.end, value.length);
      const start = Math.min(trigger.range.start, end);
      const next = commitTrigger(value, { start, end }, commit.insert);
      pendingCaret.current = next.caret;
      pendingFocus.current = true;
      onChange(next.text);
    }
    close();
    areaRef.current?.focus();
  };

  const openTrigger = (sigil: string): void => {
    const specFor = triggers.find((candidate) => candidate.sigil === sigil);
    if (!specFor || specFor.options === undefined) return;
    const field = areaRef.current;
    const caret = field?.selectionStart ?? value.length;
    const prefix = value.slice(0, caret);
    const separator = prefix.length > 0 && !/\s$/.test(prefix) ? ' ' : '';
    const insertion = `${separator}${sigil}`;
    const at = caret + insertion.length;

    pendingCaret.current = at;
    pendingFocus.current = true;
    onChange(`${prefix}${insertion}${value.slice(caret)}`);
    setTrigger({ sigil, query: '', range: { start: at - sigil.length, end: at } });
    setActiveState(0);
  };

  // -------------------------------------------------------------------------
  // Attachments — one upload path, three entry points (paste, drop, picker)
  // -------------------------------------------------------------------------

  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const seq = useRef(0);
  const tasks = useRef(new Map<number, FileUploadTask>());

  useEffect(() => () => {
    for (const task of tasks.current.values()) task.cancel();
    tasks.current.clear();
  }, []);

  /* The placement handle is re-created every render; a promise callback holds
     the one from the render it was created in. The ref makes "read at
     resolution" actually read the CURRENT one rather than a stale closure. */
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const stageUpload = (file: File, reuseId?: number): void => {
    const start = attachmentsRef.current?.start;
    if (!start) return;
    const id = reuseId ?? ++seq.current;
    const task = start(file);
    tasks.current.set(id, task);
    setStaged((current) => {
      const next: StagedAttachment = { id, phase: 'uploading', file };
      return reuseId === undefined
        ? [...current, next]
        : current.map((item) => (item.id === id ? next : item));
    });
    void task.result.then((uploaded) => {
      if (tasks.current.get(id) !== task) return;
      setStaged((current) => current.map((item) =>
        item.id === id ? { id, phase: 'uploaded', file, uploaded } : item));
    }).catch((reason: unknown) => {
      if (tasks.current.get(id) !== task) return;
      setStaged((current) => current.map((item) =>
        item.id === id ? { id, phase: 'failed', file, reason: safeUploadReason(reason) } : item));
    });
  };

  /**
   * The caret-insert path, moved from `doc-edit`'s `useFileInsert`: the caret
   * is read ONCE, before the first upload starts, and each landed file
   * advances it — re-reading the live selection per completion would scatter
   * N files wherever the cursor happened to be N seconds later, in whatever
   * order the network answered. `spliceInto` clamps to the body it is given,
   * so a caret the writer's own edits have pushed past the end degrades to an
   * append: the insertion POINT may drift (cosmetic), the text is never lost.
   */
  const insertUploads = (files: readonly File[]): void => {
    const declared = attachmentsRef.current;
    if (!declared?.start || declared.placement.mode !== 'caret') return;
    setError(null);
    const el = areaRef.current;
    let caret = el ? el.selectionStart : declared.placement.liveText().length;
    let end = el ? el.selectionEnd : caret;

    for (const file of files) {
      setBusy((current) => [...current, file.name]);
      void declared.start(file).result.then(
        (uploaded) => {
          const live = attachmentsRef.current;
          if (!live || live.placement.mode !== 'caret') return;
          const placement = live.placement;
          const reference = placement.reference?.(uploaded)
            ?? fileReference(uploaded.name, uploaded.fileEntityId, uploaded.mime);
          const next = spliceInto(placement.liveText(), caret, end, reference);
          caret = next.caret;
          end = next.caret;
          pendingCaret.current = next.caret;
          placement.setText(next.body);
          setBusy((busyNow) => busyNow.filter((name) => name !== file.name));
          placement.onInserted?.();
        },
        (cause: unknown) => {
          setBusy((busyNow) => busyNow.filter((name) => name !== file.name));
          const why = safeUploadReason(cause);
          if (why !== 'Upload cancelled.') setError(`${file.name} — ${why}`);
        },
      );
    }
  };

  const addFiles = (files: FileList | readonly File[]): void => {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (attachments?.placement.mode === 'caret') insertUploads(list);
    else for (const file of list) stageUpload(file);
  };

  const attachmentsState: RichInputAttachments | null = attachments
    ? {
        staged,
        busy,
        addFiles,
        remove: (id) => {
          tasks.current.get(id)?.cancel();
          tasks.current.delete(id);
          setStaged((current) => current.filter((item) => item.id !== id));
        },
        retry: (id) => {
          const failed = staged.find((item) => item.id === id);
          if (failed) stageUpload(failed.file, id);
        },
        uploadedIds: () => staged.flatMap((item) =>
          item.phase === 'uploaded' && item.uploaded ? [item.uploaded.fileEntityId] : []),
        blocked: staged.some((item) => item.phase !== 'uploaded'),
        error,
        refusal,
        clearRefusal: () => setRefusal(null),
        clear: () => {
          // Forget WITHOUT cancelling: the uploads succeeded and their ids
          // are riding the message that was just sent.
          tasks.current.clear();
          setStaged([]);
        },
      }
    : null;

  // -------------------------------------------------------------------------
  // The textarea's handlers
  // -------------------------------------------------------------------------

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;
    onChange(next);
    const found = activeTrigger(next, caret, liveSigils);
    if (found) {
      setTrigger(found);
      if (found.sigil !== trigger?.sigil || found.range.start !== trigger.range.start) {
        setActiveState(0);
      }
    } else if (trigger) {
      // The trigger the picker was opened for no longer exists — the user
      // deleted the sigil or typed past the word. Leaving it open would float
      // a list over the composer that nothing can now filter.
      close();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && trigger) {
      event.preventDefault();
      // C6 layer 4: Esc inside a focused field belongs to the FIELD — consumed
      // here so it never also pops whatever surface hosts the composer.
      event.stopPropagation();
      close();
      return;
    }
    /**
     * The picker is driven from the textarea, never from a second focusable
     * field: focus stays where the message is being typed, so ↑/↓ browse the
     * list while every other key keeps composing. These returns must precede
     * whatever the host does with Enter — while a row is highlighted, Enter
     * commits the choice, not the message.
     */
    if (trigger && filtered.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveState((current) => (current + 1) % filtered.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveState((current) => (current - 1 + filtered.length) % filtered.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        select();
        return;
      }
    }
    onKeyDown?.(event);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const declared = attachmentsRef.current;
    if (declared?.start) {
      const { accepted, refused } = extractReadableFiles(event.clipboardData, {
        renameAll: true,
        ...(declared.accept ? { accept: declared.accept } : {}),
      });
      if (refused.length > 0) {
        setRefusal(`${refused.map((file) => file.name || 'unnamed file').join(', ')} — not attached; agents cannot read ${refused.length === 1 ? 'this file type' : 'these file types'}.`);
      }
      if (accepted.length > 0) {
        // Files win over text, as the composer always had it. Text-only
        // pastes fall through untouched — only file bytes are intercepted.
        event.preventDefault();
        addFiles(accepted);
        return;
      }
    }
    onPaste?.(event);
  };

  /* A file dropped on a textarea does nothing useful by default — some
     browsers navigate away from the app entirely, taking the draft with
     them. CANCELLED FOR FILES WHETHER OR NOT WE CAN UPLOAD THEM: per the
     drag-and-drop spec a `drop` is not dispatched at all unless the
     preceding `dragover` was cancelled, so gating this on the uploader would
     make the drop guard unreachable and hand the draft to the browser.
     Narrowed to `Files` so dragging SELECTED TEXT inside the textarea — an
     ordinary editor gesture, not a navigation — still works. */
  const handleDragOver = (event: React.DragEvent<HTMLTextAreaElement>): void => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  };

  const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>): void => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    if (attachmentsRef.current?.start) addFiles([...event.dataTransfer.files]);
  };

  const popover: RichInputPopover | null = trigger && spec?.options !== undefined
    ? {
        sigil: trigger.sigil,
        query: trigger.query,
        options: filtered,
        activeIndex,
        setActive: setActiveState,
        select,
        close,
        listboxId,
        optionDomId: (option) => `${listboxId}-${option.id}`,
      }
    : null;

  return {
    areaProps: {
      onChange: handleChange,
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      'aria-controls': popover ? listboxId : undefined,
      'aria-activedescendant': popover && filtered[activeIndex]
        ? `${listboxId}-${filtered[activeIndex].id}`
        : undefined,
    },
    popover,
    openTrigger,
    attachments: attachmentsState,
  };
}
