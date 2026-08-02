/**
 * Composer — one input for every thread.
 *
 * `@` completes members and agents (a mention notifies the actor's owning
 * member), `#` completes entities and writes a `{{ref:id}}` chip, and dragging
 * any chip in from anywhere drops an entity into the message: a file becomes an
 * attachment, anything else becomes a `{{embed:id}}` live card. Search is
 * deferred for v1, so completion runs over what the session already knows —
 * thread participants and cached entities — not a server query.
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Mention, MentionsInput, type SuggestionDataItem } from 'react-mentions';
import { ENTITY_DRAG_MIME, ChipById, type EntityDragPayload } from '../../entity';
import { useGraphStore } from '../../stores';
import type { EntityKind, FileAttachment, Mention as MentionRef } from '../../types/contract';
import { MENTION_MARKUP, REF_MARKUP, appendEmbed, draftFromMarkup } from './body';
import type { MentionCandidate } from './types';

/** Dropping one of these means "attach the file", not "embed a card". */
const ATTACHABLE_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['file']);
/** `@` completes actors only — the two kinds a `Mention` may point at. */
const ACTOR_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['member', 'team_member']);

export interface ComposerProps {
  placeholder?: string;
  candidates: readonly MentionCandidate[];
  onSubmit: (draft: { body: string; mentions: MentionRef[]; attachments: FileAttachment[] }) => void;
  onCancel?: () => void;
  /** Rendered above the input — "Replying to …" in reply mode. */
  contextLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

function toSuggestions(list: readonly MentionCandidate[]): SuggestionDataItem[] {
  return list.map((c) => ({ id: c.id, display: c.display }));
}

export function Composer({
  placeholder = 'Write a message — @ mentions, # entities, drop a chip to embed',
  candidates, onSubmit, onCancel, contextLabel, disabled = false, autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const actors = useMemo(
    () => toSuggestions(candidates.filter((c) => ACTOR_KINDS.has(c.kind))),
    [candidates],
  );
  const entities = useMemo(
    () => toSuggestions(candidates.filter((c) => !ACTOR_KINDS.has(c.kind))),
    [candidates],
  );
  const kindOf = useMemo(() => {
    const map = new Map(candidates.map((c) => [c.id, c.kind]));
    return (id: string): MentionRef['kind'] => (map.get(id) === 'team_member' ? 'team_member' : 'member');
  }, [candidates]);

  const submit = (): void => {
    const { body, mentions } = draftFromMarkup(value, kindOf);
    if (!body.trim()) return;
    onSubmit({ body, mentions, attachments });
    setValue('');
    setAttachments([]);
  };

  const readPayload = (e: DragEvent): EntityDragPayload | null => {
    const raw = e.dataTransfer.getData(ENTITY_DRAG_MIME);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EntityDragPayload;
    } catch {
      return null;
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    setDropping(false);
    const payload = readPayload(e);
    if (!payload) return;
    e.preventDefault();
    if (ATTACHABLE_KINDS.has(payload.kind)) {
      const cached = useGraphStore.getState().entities[payload.entityId];
      const state = cached?.state as { name?: string; mimeType?: string } | undefined;
      const next: FileAttachment = {
        fileEntityId: payload.entityId,
        name: state?.name ?? payload.title,
        mime: state?.mimeType ?? 'application/octet-stream',
      };
      setAttachments((prev) => (prev.some((a) => a.fileEntityId === next.fileEntityId) ? prev : [...prev, next]));
      return;
    }
    setValue((v) => appendEmbed(v, payload.entityId));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && onCancel) onCancel();
  };

  return (
    <div
      className={`cv2-thread__composer${dropping ? ' cv2-thread__composer--dropping' : ''}`}
      data-cv2-composer="true"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ENTITY_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {contextLabel && (
        <div className="cv2-thread__composerctx">
          <span>{contextLabel}</span>
          {onCancel && <button type="button" className="cv2-thread__act" onClick={onCancel}>Cancel</button>}
        </div>
      )}

      <MentionsInput
        className="cv2-mentions"
        value={value}
        onChange={(_e, next) => setValue(next)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        inputRef={inputRef}
        aria-label="Message composer"
        a11ySuggestionsListLabel="Suggested mentions"
        allowSuggestionsAboveCursor
      >
        <Mention
          trigger="@"
          markup={MENTION_MARKUP}
          data={actors}
          appendSpaceOnAdd
          className="cv2-mentions__mark"
        />
        <Mention
          trigger="#"
          markup={REF_MARKUP}
          data={entities}
          appendSpaceOnAdd
          className="cv2-mentions__mark"
        />
      </MentionsInput>

      {attachments.length > 0 && (
        <div className="cv2-thread__attachments" aria-label="Staged attachments">
          {attachments.map((a) => (
            <span key={a.fileEntityId} className="cv2-thread__attachment">
              <ChipById entityId={a.fileEntityId} />
              <button
                type="button"
                className="cv2-thread__act"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.fileEntityId !== a.fileEntityId))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="cv2-thread__composeractions">
        <span className="cv2-thread__hint">Enter to send · Shift+Enter for a new line</span>
        <button
          type="button"
          className="cv2-actionbtn cv2-actionbtn--primary"
          disabled={disabled || value.trim().length === 0}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </div>
  );
}
