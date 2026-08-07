import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type ChangeEvent,
} from 'react';
import { ChipById, useFacade } from '../../entity';
import { hasFileAttachmentControl } from '../../facade';
import { messageAddMode } from '../../registry';
import { useGraphStore } from '../../stores';
import type {
  EntityId, EntityKind, EntitySummary, FileAttachment, SpaceId,
} from '../../types/contract';
import type { MentionCandidate } from './types';

export type EntityReferenceMode = 'card' | 'reference';

export interface StagedEntityReference {
  entityId: EntityId;
  title: string;
  kind: EntityKind;
  mode: EntityReferenceMode;
}

export interface AttachmentControlsHandle {
  addFiles(files: readonly File[]): void;
}

export interface AttachmentControlsProps {
  anchorId: EntityId;
  spaceId?: SpaceId;
  candidates: readonly MentionCandidate[];
  attachments: readonly FileAttachment[];
  entities: readonly StagedEntityReference[];
  disabled?: boolean;
  onAddAttachment: (attachment: FileAttachment) => void;
  onRemoveAttachment: (fileEntityId: EntityId) => void;
  onAddEntity: (entity: StagedEntityReference) => void;
  onRemoveEntity: (entityId: EntityId, mode: EntityReferenceMode) => void;
  onUploadingChange?: (uploading: boolean) => void;
}

interface UploadRow {
  id: string;
  file: File;
  status: 'uploading' | 'failed';
  error?: string;
}

let uploadRowSeq = 0;

function uploadRowId(file: File): string {
  uploadRowSeq += 1;
  return `${file.name}:${file.size}:${file.lastModified}:${uploadRowSeq}`;
}

function attachmentOf(entity: EntitySummary): FileAttachment | null {
  if (entity.state.kind !== 'file') return null;
  return {
    fileEntityId: entity.id,
    name: entity.state.name || entity.title,
    mime: entity.state.mimeType || 'application/octet-stream',
  };
}

export const AttachmentControls = forwardRef<AttachmentControlsHandle, AttachmentControlsProps>(
  function AttachmentControls({
    anchorId, spaceId, candidates, attachments, entities, disabled = false,
    onAddAttachment, onRemoveAttachment, onAddEntity, onRemoveEntity, onUploadingChange,
  }, ref) {
    const facade = useFacade();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [uploads, setUploads] = useState<UploadRow[]>([]);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [fetched, setFetched] = useState<EntitySummary[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const cached = useGraphStore((state) => state.entities);
    const canUpload = hasFileAttachmentControl(facade);

    const uploading = uploads.some((row) => row.status === 'uploading');
    useEffect(() => onUploadingChange?.(uploading), [uploading, onUploadingChange]);

    const uploadOne = useCallback(async (row: UploadRow): Promise<void> => {
      if (!spaceId || !hasFileAttachmentControl(facade)) {
        setUploads((current) => current.map((item) => item.id === row.id
          ? { ...item, status: 'failed', error: 'File upload is unavailable in this workspace.' }
          : item));
        return;
      }

      setUploads((current) => current.map((item) => item.id === row.id
        ? { ...item, status: 'uploading', error: undefined }
        : item));
      try {
        const detail = await facade.uploadFile({
          spaceId,
          file: row.file,
          targetIds: [anchorId],
          clientMutationId: `channel_upload_${Date.now().toString(36)}_${row.id}`,
        });
        useGraphStore.getState().ingestDetail(detail);
        const attachment = attachmentOf(detail);
        if (!attachment) throw new Error('The uploaded entity is not a file.');
        onAddAttachment(attachment);
        setUploads((current) => current.filter((item) => item.id !== row.id));
      } catch (error) {
        setUploads((current) => current.map((item) => item.id === row.id
          ? {
              ...item,
              status: 'failed',
              error: error instanceof Error ? error.message : 'Upload failed.',
            }
          : item));
      }
    }, [anchorId, facade, onAddAttachment, spaceId]);

    const addFiles = useCallback((files: readonly File[]): void => {
      const rows = files.map((file): UploadRow => ({
        id: uploadRowId(file), file, status: 'uploading',
      }));
      if (rows.length === 0) return;
      setUploads((current) => [...current, ...rows]);
      for (const row of rows) void uploadOne(row);
    }, [uploadOne]);

    useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

    const loadEntities = useCallback(async (nextCursor?: string): Promise<void> => {
      if (!spaceId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await facade.queryCollection({
          spaceId,
          sort: 'activityAt_desc',
          limit: 100,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        const items = result.page.items.filter((entity) => messageAddMode(entity.kind) !== 'none' && !entity.deletedAt);
        useGraphStore.getState().ingestSummaries(items);
        setFetched((current) => {
          const byId = new Map((nextCursor ? current : []).map((entity) => [entity.id, entity]));
          for (const entity of items) byId.set(entity.id, entity);
          return [...byId.values()];
        });
        setCursor(result.page.nextCursor);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Could not load workspace entities.');
      } finally {
        setLoading(false);
      }
    }, [facade, spaceId]);

    useEffect(() => {
      if (!pickerOpen) return;
      setQuery('');
      setFetched([]);
      setCursor(null);
      void loadEntities();
    }, [pickerOpen, loadEntities]);

    const options = useMemo(() => {
      const byId = new Map<EntityId, { id: EntityId; title: string; kind: EntityKind; summary?: EntitySummary }>();
      for (const candidate of candidates) {
        if (messageAddMode(candidate.kind) === 'none' || candidate.id === anchorId) continue;
        byId.set(candidate.id, {
          id: candidate.id,
          title: candidate.display,
          kind: candidate.kind,
          summary: cached[candidate.id],
        });
      }
      for (const entity of fetched) {
        if (entity.id === anchorId) continue;
        byId.set(entity.id, { id: entity.id, title: entity.title, kind: entity.kind, summary: entity });
      }
      const needle = query.trim().toLocaleLowerCase();
      return [...byId.values()]
        .filter((item) => !needle
          || item.title.toLocaleLowerCase().includes(needle)
          || item.kind.toLocaleLowerCase().includes(needle))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    }, [anchorId, cached, candidates, fetched, query]);

    const addEntity = (
      item: { id: EntityId; title: string; kind: EntityKind },
      mode: EntityReferenceMode,
    ): void => {
      onAddEntity({ entityId: item.id, title: item.title, kind: item.kind, mode });
      setPickerOpen(false);
    };

    const attachExistingFile = (
      item: { id: EntityId; title: string; summary?: EntitySummary },
    ): void => {
      const summary = item.summary ?? cached[item.id];
      const attachment = summary ? attachmentOf(summary) : null;
      if (attachment) onAddAttachment(attachment);
      setPickerOpen(false);
    };

    const onFilesPicked = (event: ChangeEvent<HTMLInputElement>): void => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = '';
    };

    return (
      <div className="cv2-thread__additions">
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={onFilesPicked}
          aria-label="Choose files to attach"
        />

        <div className="cv2-thread__addactions" aria-label="Add to message">
          <button
            type="button"
            className="cv2-thread__addbtn"
            disabled={disabled}
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            ＋ Add entity
          </button>
          <button
            type="button"
            className="cv2-thread__addbtn"
            disabled={disabled || !canUpload}
            title={canUpload ? 'Upload images, documents, or any other file' : 'File upload is unavailable in this mode'}
            onClick={() => inputRef.current?.click()}
          >
            📎 Attach files
          </button>
        </div>

        {pickerOpen && (
          <div className="cv2-thread__entitypicker" role="dialog" aria-label="Add an entity to the message">
            <div className="cv2-thread__pickerhead">
              <input
                autoFocus
                type="search"
                value={query}
                aria-label="Find an entity"
                placeholder="Find tasks, docs, files, channels, agents…"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') setPickerOpen(false); }}
              />
              <button type="button" className="cv2-thread__act" onClick={() => setPickerOpen(false)}>Close</button>
            </div>
            <div className="cv2-thread__entityoptions" role="list">
              {options.map((item) => (
                <div key={item.id} className="cv2-thread__entityoption" role="listitem">
                  <span className="cv2-thread__entityidentity">
                    <ChipById entityId={item.id} />
                    <span className="t-code">{item.kind}</span>
                  </span>
                  <span className="cv2-thread__entityactions">
                    {messageAddMode(item.kind) === 'file' && (
                      <button type="button" className="cv2-thread__act"
                        aria-label={`Attach ${item.title}`}
                        onClick={() => attachExistingFile(item)}>Attach</button>
                    )}
                    <button type="button" className="cv2-thread__act"
                      aria-label={`Reference ${item.title}`}
                      onClick={() => addEntity(item, 'reference')}>Reference</button>
                    <button type="button" className="cv2-thread__act"
                      aria-label={`Add ${item.title} as card`}
                      onClick={() => addEntity(item, 'card')}>Add card</button>
                  </span>
                </div>
              ))}
              {!loading && options.length === 0 && (
                <p className="cv2-empty-line">No matching entities.</p>
              )}
            </div>
            {loadError && <p className="cv2-thread__uploaderror" role="alert">{loadError}</p>}
            {loading && <p className="cv2-empty-line" aria-live="polite">Loading entities…</p>}
            {cursor && !loading && (
              <button type="button" className="cv2-thread__more" onClick={() => void loadEntities(cursor)}>
                Load more entities
              </button>
            )}
          </div>
        )}

        {entities.length > 0 && (
          <div className="cv2-thread__staged" aria-label="Staged entities">
            {entities.map((entity) => (
              <span key={`${entity.mode}:${entity.entityId}`} className="cv2-thread__attachment">
                <ChipById entityId={entity.entityId} />
                <span className="t-code">{entity.mode}</span>
                <button type="button" className="cv2-thread__act"
                  aria-label={`Remove ${entity.title}`}
                  onClick={() => onRemoveEntity(entity.entityId, entity.mode)}>✕</button>
              </span>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="cv2-thread__staged" aria-label="Staged attachments">
            {attachments.map((attachment) => (
              <span key={attachment.fileEntityId} className="cv2-thread__attachment">
                <ChipById entityId={attachment.fileEntityId} />
                <button type="button" className="cv2-thread__act"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onRemoveAttachment(attachment.fileEntityId)}>✕</button>
              </span>
            ))}
          </div>
        )}

        {uploads.length > 0 && (
          <div className="cv2-thread__uploads" aria-label="File uploads" aria-live="polite">
            {uploads.map((row) => (
              <div key={row.id} className="cv2-thread__upload" data-status={row.status}>
                <span>{row.status === 'uploading' ? 'Uploading' : 'Upload failed'} · {row.file.name}</span>
                {row.error && <span className="cv2-thread__uploaderror">{row.error}</span>}
                {row.status === 'failed' && (
                  <>
                    <button type="button" className="cv2-thread__act"
                      aria-label={`Retry uploading ${row.file.name}`}
                      onClick={() => void uploadOne(row)}>Retry</button>
                    <button type="button" className="cv2-thread__act"
                      aria-label={`Dismiss failed upload ${row.file.name}`}
                      onClick={() => setUploads((current) => current.filter((item) => item.id !== row.id))}>Dismiss</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);
