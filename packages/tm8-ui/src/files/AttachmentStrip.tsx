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
  /** An upload finished. The host refetches the anchor so the new edge shows. */
  onUploaded?: () => void;
  /**
   * Cuts one `attached_to` edge. Absent ⇒ no remove control is drawn, on the
   * same reasoning as `startUpload`: a Remove that cannot remove is worse than
   * no Remove, because the user believes the file went away.
   *
   * A row whose `edgeId` is null gets no control either, whatever this prop
   * says — that row was not reached through a link, so there is nothing here
   * to cut (see `FileRow.edgeId`).
   */
  onDetach?: (edgeId: string) => Promise<void>;
  /** A detach landed. Same contract as `onUploaded`: the host refetches. */
  onDetached?: () => void;
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
/**
 * A CLOSED vocabulary for a failed detach, mapped from the contract's refusal
 * codes — the same law `safeUploadReason` follows next door, for the same
 * reason: server prose can carry a transport path or an id the viewer is not
 * entitled to read, and "error" tells the user nothing they can act on.
 */
const SAFE_DETACH_ERRORS: Readonly<Record<string, string>> = {
  forbidden: 'You do not have permission to remove this attachment.',
  unauthenticated: 'Sign in again before removing attachments.',
  not_found: 'That attachment is already gone. Reload to see the current list.',
  conflict: 'This attachment changed while you were looking at it. Reload and try again.',
};

function reasonOf(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  return (code ? SAFE_DETACH_ERRORS[code] : undefined) ?? 'Could not remove this attachment. Try again.';
}

export function canThumbnail(mime: string): boolean {
  if (previewKindOf(mime) !== 'image') return false;
  return !/^image\/svg(\+xml)?$/i.test(mime.trim().toLowerCase());
}

export function AttachmentStrip({
  anchorId,
  files,
  downloadHref,
  startUpload,
  onUploaded,
  onDetach,
  onDetached,
  label = 'ATTACHMENTS',
}: AttachmentStripProps) {
  const [pending, setPending] = useState<readonly PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [detaching, setDetaching] = useState<readonly string[]>([]);
  const [detachError, setDetachError] = useState<{ edgeId: string; why: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * NO CONFIRMATION DIALOG, deliberately: this removes a LINK, and the file
   * itself survives in the space's files with its bytes intact, so the act is
   * reversible by re-attaching rather than destructive. What is NOT optional is
   * saying so when it fails — a row that silently stays put after Remove reads
   * as a broken button.
   */
  const detach = useCallback(
    (edgeId: string) => {
      if (!onDetach) return;
      setDetachError(null);
      setDetaching((current) => [...current, edgeId]);
      void onDetach(edgeId).then(
        () => {
          setDetaching((current) => current.filter((id) => id !== edgeId));
          onDetached?.();
        },
        (error: unknown) => {
          setDetaching((current) => current.filter((id) => id !== edgeId));
          setDetachError({ edgeId, why: reasonOf(error) });
        },
      );
    },
    [onDetach, onDetached],
  );

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
  if (files.length === 0 && pending.length === 0 && !startUpload) return null;

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
            <AttachmentItem
              key={file.fileEntityId}
              file={file}
              downloadHref={downloadHref}
              /* Bound HERE, so the row never has to re-derive whether it is
                 detachable — no edge, no callback, no control. */
              onDetach={onDetach && file.edgeId ? () => detach(file.edgeId as string) : undefined}
              detaching={file.edgeId !== null && detaching.includes(file.edgeId)}
              detachWhy={detachError !== null && detachError.edgeId === file.edgeId ? detachError.why : null}
            />
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
    </section>
  );
}

function AttachmentItem({
  file,
  downloadHref,
  onDetach,
  detaching,
  detachWhy,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
  onDetach?: () => void;
  detaching: boolean;
  detachWhy: string | null;
}) {
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

      {onDetach ? (
        <button
          type="button"
          className="fn-strip__detach"
          data-testid="attachment-detach"
          disabled={detaching}
          title={`Remove ${file.name} from this entity — the file itself is kept`}
          onClick={onDetach}
        >
          {detaching ? '…' : '×'}
        </button>
      ) : null}

      {detachWhy ? (
        <span className="fn-strip__detach-why" role="alert">
          {detachWhy}
        </span>
      ) : null}
    </div>
  );
}
