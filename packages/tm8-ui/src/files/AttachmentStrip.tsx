/**
 * THE ATTACHMENT STRIP — files attached to ONE entity, rendered inside the
 * entity panel's content body.
 *
 * WHY IT IS NOT A FIFTH TAB (user ruling, 2026-08-01): D3 fixes the panel at
 * four tabs — Content · Discussion · Connections · Activity — for every kind,
 * no exceptions. The content body is the one legitimately kind-varying region,
 * so that is where this lives.
 *
 * WHY IT IS KIND-AGNOSTIC: the backend is. `attached_to` is an edge type, and
 * the upload lifecycle attaches to whatever entity id it is handed — task, doc,
 * work_session, a custom `c:*` kind. A per-kind attachment component would be
 * inventing a restriction the server does not have. Nothing in this file asks
 * what kind the anchor is; the strip reads the anchor's own `attached_to`
 * edges and renders the peer files.
 *
 * THE SVG RULE, matched to the server rather than guessed at. The node sets
 * `Content-Disposition: inline` for `image/*`, `audio/*` and `video/*` and
 * EXPLICITLY EXCLUDES `image/svg+xml` (server files.ts:128-145) — an SVG is a
 * script-bearing document, not a picture, and serving one inline from the app
 * origin would be stored XSS. An `<img src>` is a request for that inline
 * byte stream, so the UI must not make one either: SVG gets a chip. Rendering
 * an `<img>` there would produce a broken image on a correct server, which
 * would read as "the file is broken" rather than "we don't inline SVG".
 */
import { useCallback, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { Eyebrow } from '../kit';
import { formatSizeChip, glyphFor, previewKindOf, type FileRow } from './model';
import { safeUploadReason, type FileUploadTask } from './upload';
import type { DownloadHref } from './FilesScreen';
import type { ProjectFolderPort } from './port';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import './attachment-strip.css';

export interface AttachmentStripProps {
  /** The anchor. Uploads attach here; the rows below hang off the same id. */
  anchorId: EntityId;
  /** Already-attached files, derived from the anchor's `attached_to` edges. */
  files: readonly FileRow[];
  /**
   * Resolves the bytes URL for a file. Absent ⇒ no thumbnails and no download
   * links; every row still renders its name and size, and says why it cannot
   * be fetched rather than offering a link that goes nowhere.
   */
  downloadHref?: DownloadHref;
  /**
   * Starts one upload against the anchor. Absent ⇒ no upload affordance is
   * drawn at all: an inert dropzone that silently swallows a dragged file is
   * worse than no dropzone, because the user believes the file landed.
   */
  startUpload?: (file: File, anchorId: EntityId) => FileUploadTask;
  /**
   * Browsing a connected project folder on the node. Absent ⇒ no folder
   * affordance is drawn, for the same reason `startUpload`'s absence removes
   * the dropzone: an inert browse button is worse than none.
   */
  projectFolder?: ProjectFolderPort;
  /** An upload finished. The host refetches the anchor so the new edge shows. */
  onUploaded?: () => void;
  label?: string;
}

interface PendingUpload {
  key: string;
  name: string;
  task: FileUploadTask;
  error: string | null;
}

/**
 * An image we are willing to put in an `<img>`. Two conditions, both required:
 * the mime is an image at all, and it is not the one image type the server
 * refuses to serve inline. See the header.
 */
export function canThumbnail(mime: string): boolean {
  if (previewKindOf(mime) !== 'image') return false;
  return !/^image\/svg(\+xml)?$/i.test(mime.trim().toLowerCase());
}

export function AttachmentStrip({
  anchorId,
  files,
  downloadHref,
  startUpload,
  projectFolder,
  onUploaded,
  label = 'ATTACHMENTS',
}: AttachmentStripProps) {
  const [pending, setPending] = useState<readonly PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const begin = useCallback(
    (picked: readonly File[]) => {
      if (!startUpload || picked.length === 0) return;
      for (const file of picked) {
        const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
        const task = startUpload(file, anchorId);
        setPending((current) => [...current, { key, name: file.name, task, error: null }]);
        void task.result.then(
          () => {
            setPending((current) => current.filter((p) => p.key !== key));
            onUploaded?.();
          },
          (error: unknown) => {
            // A cancelled task leaves nothing to report — the row goes away.
            // Everything else keeps its row so the user can read the reason.
            const why = safeUploadReason(error);
            setPending((current) =>
              why === 'Upload cancelled.'
                ? current.filter((p) => p.key !== key)
                : current.map((p) => (p.key === key ? { ...p, error: why } : p)),
            );
          },
        );
      }
    },
    [anchorId, onUploaded, startUpload],
  );

  /**
   * A designed empty, not an accidental one. With nothing attached AND no way
   * to attach, the strip renders NOTHING — an empty bordered box under every
   * entity in the workspace would be chrome claiming a feature that is not
   * wired here. With an uploader present, the dropzone alone is the empty
   * state: it is the invitation, so it needs no separate "no attachments" row.
   */
  if (files.length === 0 && pending.length === 0 && !startUpload && !projectFolder) return null;

  return (
    <section
      className={`fn-strip${dragging ? ' fn-strip--dragging' : ''}`}
      data-testid="attachment-strip"
      data-count={files.length}
      onDragOver={(event) => {
        if (!startUpload) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!startUpload) return;
        event.preventDefault();
        setDragging(false);
        begin([...event.dataTransfer.files]);
      }}
    >
      <Eyebrow faint>
        {label}
        {files.length > 0 ? ` · ${files.length}` : ''}
      </Eyebrow>

      {files.length > 0 ? (
        <div className="fn-strip__items">
          {files.map((file) => (
            <AttachmentItem key={file.fileEntityId} file={file} downloadHref={downloadHref} />
          ))}
        </div>
      ) : null}

      {pending.map((item) => (
        <p className="fn-strip__pending" key={item.key} data-testid="attachment-pending">
          <span className="fn-strip__pending-name">{item.name}</span>
          {item.error ? (
            <span className="fn-strip__pending-why" role="alert">
              {item.error}
            </span>
          ) : (
            <>
              <span className="fn-strip__pending-why">uploading…</span>
              <button type="button" className="fn-strip__cancel" onClick={() => item.task.cancel()}>
                cancel
              </button>
            </>
          )}
        </p>
      ))}

      {startUpload ? (
        <div className="fn-strip__drop">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="fn-strip__input"
            data-testid="attachment-file-input"
            onChange={(event) => {
              begin([...(event.target.files ?? [])]);
              // Same file twice in a row must fire change twice.
              event.target.value = '';
            }}
          />
          <button type="button" className="fn-strip__btn" onClick={() => inputRef.current?.click()}>
            ＋ Attach a file
          </button>
          <span className="fn-strip__hint">or drop files here</span>
        </div>
      ) : null}

      {/* A SECOND, DIFFERENT SOURCE — not a second way to do the same thing.
          The input above sends bytes from this machine; this one names a file
          already sitting in a project folder on the node, which the input
          cannot reach because it never learns an absolute path. */}
      {projectFolder ? (
        <div className="fn-strip__drop">
          <button type="button" className="fn-strip__btn" onClick={() => setPicking(true)}>
            ▱ From a project folder
          </button>
          <span className="fn-strip__hint">read on the node, not uploaded</span>
        </div>
      ) : null}

      {picking && projectFolder ? (
        <ProjectFolderPicker
          port={projectFolder}
          anchorId={anchorId}
          onDismiss={() => setPicking(false)}
          onAttached={() => {
            setPicking(false);
            onUploaded?.();
          }}
        />
      ) : null}
    </section>
  );
}

function AttachmentItem({ file, downloadHref }: { file: FileRow; downloadHref?: DownloadHref }) {
  const href = downloadHref ? downloadHref(file.fileEntityId) : null;
  const size = formatSizeChip(file.sizeBytes);
  const thumb = href !== null && canThumbnail(file.mime);

  const body = thumb ? (
    <img
      className="fn-strip__thumb"
      src={href}
      alt={file.name}
      title={file.name}
      loading="lazy"
      /* THE SIZE GUARD lives on the element as well as in the stylesheet: a
         5000px-wide photo must not blow out a 440px panel column even if this
         component is ever rendered somewhere the stylesheet did not load. */
      style={{ maxWidth: '100%', maxHeight: '160px', objectFit: 'contain' }}
    />
  ) : (
    <span className="fn-strip__chip-face">
      <span className="fn-strip__glyph" aria-hidden="true">
        {glyphFor(file.mime)}
      </span>
      <span className="fn-strip__name">{file.name}</span>
      {size ? <span className="fn-strip__size">{size}</span> : null}
    </span>
  );

  return (
    <div
      className={thumb ? 'fn-strip__item fn-strip__item--thumb' : 'fn-strip__item'}
      data-testid="attachment-item"
      data-mime={file.mime}
      data-thumb={thumb ? 'true' : 'false'}
    >
      {href !== null ? (
        <a className="fn-strip__link" href={href} download={file.name} title={`Download ${file.name}`}>
          {body}
        </a>
      ) : (
        <>
          {body}
          {/* L6: the control is visible, dead, and says why — never a link
              that resolves to the current page. */}
          <span className="fn-strip__nolink" title="No download URL was supplied to this panel.">
            no download here
          </span>
        </>
      )}
    </div>
  );
}
