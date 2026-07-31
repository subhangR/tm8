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
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Mention, MentionsInput, type SuggestionDataItem } from 'react-mentions';
import { ENTITY_DRAG_MIME, type EntityDragPayload } from '../../entity';
import { useGraphStore } from '../../stores';
import type { EntityId, EntityKind, FileAttachment, Mention as MentionRef, SpaceId } from '../../types/contract';
import {
  AttachmentControls, type AttachmentControlsHandle, type EntityReferenceMode,
  type StagedEntityReference,
} from './AttachmentControls';
import { MENTION_MARKUP, REF_MARKUP, appendEmbed, draftFromMarkup, refToken } from './body';
import {
  TagSuggestion, mentionsForTaggedDraft, tagIdsFromMarkup, type ChannelTagTarget,
} from './tags';
import type { MentionCandidate } from './types';

/** Dropping one of these means "attach the file", not "embed a card". */
const ATTACHABLE_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['file']);
/** `@` completes actors only — the two kinds a `Mention` may point at. */
const ACTOR_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(['member', 'team_member']);

export interface ComposerProps {
  anchorId: EntityId;
  spaceId?: SpaceId;
  placeholder?: string;
  candidates: readonly MentionCandidate[];
  tagTargets?: readonly ChannelTagTarget[];
  tagSuggestionsEnabled?: boolean;
  tagsLoading?: boolean;
  tagLoadError?: string | null;
  onSubmit: (draft: {
    body: string;
    mentions: MentionRef[];
    attachments: FileAttachment[];
    selectedTagTargetIds: EntityId[];
  }) => void | Promise<void>;
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
  anchorId, spaceId,
  placeholder = 'Write a message — @ mentions, # entities, or add anything',
  candidates, tagTargets = [], tagSuggestionsEnabled = true, tagsLoading = false,
  tagLoadError = null, onSubmit, onCancel, contextLabel, disabled = false, autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [stagedEntities, setStagedEntities] = useState<StagedEntityReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentControlsRef = useRef<AttachmentControlsHandle>(null);

  const tagTargetsById = useMemo(
    () => new Map(tagTargets.map((target) => [target.id, target])),
    [tagTargets],
  );
  const actors = useMemo(() => {
    const suggestions = new Map<string, SuggestionDataItem>();
    for (const item of toSuggestions(candidates.filter((c) => ACTOR_KINDS.has(c.kind)))) {
      suggestions.set(String(item.id), item);
    }
    if (tagSuggestionsEnabled) {
      for (const target of tagTargets) {
        suggestions.set(target.id, { id: target.id, display: target.display });
      }
    }
    return [...suggestions.values()];
  }, [candidates, tagSuggestionsEnabled, tagTargets]);
  const entitySuggestions = useMemo(
    () => toSuggestions(candidates.filter((c) => !ACTOR_KINDS.has(c.kind))),
    [candidates],
  );
  const kindOf = useMemo(() => {
    const map = new Map(candidates.map((c) => [c.id, c.kind]));
    return (id: string): MentionRef['kind'] => (map.get(id) === 'team_member' ? 'team_member' : 'member');
  }, [candidates]);

  const submit = async (): Promise<void> => {
    const draft = draftFromMarkup(value, kindOf);
    const selectedTagTargetIds = tagIdsFromMarkup(value, tagTargets);
    const mentions = mentionsForTaggedDraft(draft.mentions, selectedTagTargetIds, tagTargets);
    let body = draft.body;
    for (const entity of stagedEntities) {
      body = entity.mode === 'card'
        ? appendEmbed(body, entity.entityId)
        : `${body.trimEnd()}${body.trim() ? ' ' : ''}${refToken(entity.entityId)}`;
    }
    if (!body.trim() && attachments.length > 0) {
      body = attachments.length === 1
        ? `Attached ${attachments[0].name}`
        : `Attached ${attachments.length} files`;
    }
    if (!body.trim() || uploading || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({ body, mentions, attachments, selectedTagTargetIds });
      setValue('');
      setAttachments([]);
      setStagedEntities([]);
    } catch (error) {
      setSubmitError(error instanceof Error && error.message ? error.message : 'Could not send');
    } finally {
      setSubmitting(false);
    }
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
    const nativeFiles = Array.from(e.dataTransfer.files ?? []);
    if (nativeFiles.length > 0) {
      e.preventDefault();
      attachmentControlsRef.current?.addFiles(nativeFiles);
      return;
    }
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

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    attachmentControlsRef.current?.addFiles(files);
  };

  const addAttachment = (attachment: FileAttachment): void => {
    setAttachments((current) => current.some((item) => item.fileEntityId === attachment.fileEntityId)
      ? current
      : [...current, attachment]);
  };

  const addEntity = (entity: StagedEntityReference): void => {
    setStagedEntities((current) => current.some((item) => (
      item.entityId === entity.entityId && item.mode === entity.mode
    )) ? current : [...current, entity]);
  };

  const removeEntity = (entityId: EntityId, mode: EntityReferenceMode): void => {
    setStagedEntities((current) => current.filter((item) => item.entityId !== entityId || item.mode !== mode));
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    if (e.key === 'Escape' && onCancel) onCancel();
  };

  return (
    <div
      className={`cv2-thread__composer${dropping ? ' cv2-thread__composer--dropping' : ''}`}
      data-cv2-composer="true"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ENTITY_DRAG_MIME) && !e.dataTransfer.types.includes('Files')) return;
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
        onChange={(_e, next) => {
          setValue(next);
          if (submitError) setSubmitError(null);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled || submitting}
        autoFocus={autoFocus}
        inputRef={inputRef}
        onPaste={onPaste}
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
          renderSuggestion={(suggestion, _search, highlightedDisplay, _index, focused) => {
            const target = tagTargetsById.get(String(suggestion.id));
            return target
              ? <TagSuggestion target={target} focused={focused} />
              : <span>{highlightedDisplay}</span>;
          }}
        />
        <Mention
          trigger="#"
          markup={REF_MARKUP}
          data={entitySuggestions}
          appendSpaceOnAdd
          className="cv2-mentions__mark"
        />
      </MentionsInput>

      <AttachmentControls
        ref={attachmentControlsRef}
        anchorId={anchorId}
        spaceId={spaceId}
        candidates={candidates}
        attachments={attachments}
        entities={stagedEntities}
        disabled={disabled || submitting}
        onAddAttachment={addAttachment}
        onRemoveAttachment={(fileEntityId) => setAttachments((current) => (
          current.filter((item) => item.fileEntityId !== fileEntityId)
        ))}
        onAddEntity={addEntity}
        onRemoveEntity={removeEntity}
        onUploadingChange={setUploading}
      />

      {submitError && (
        <p className="cv2-thread__error" role="alert">Could not send — {submitError}</p>
      )}

      <div className="cv2-thread__composeractions">
        <span className="cv2-thread__hint">
          {tagsLoading
            ? 'Loading team and session @Tags…'
            : tagLoadError
              ? 'Team and session @Tags unavailable · regular mentions still work'
              : 'Enter to send · Shift+Enter for a new line'}
        </span>
        <button
          type="button"
          className="cv2-actionbtn cv2-actionbtn--primary"
          disabled={disabled || uploading || submitting || (
            value.trim().length === 0 && attachments.length === 0 && stagedEntities.length === 0
          )}
          onClick={() => { void submit(); }}
        >
          {uploading ? 'Uploading…' : submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
