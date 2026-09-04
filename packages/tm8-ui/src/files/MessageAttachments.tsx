/**
 * THE ATTACHMENTS UNDER A MESSAGE — one implementation, both chat surfaces.
 *
 * A message's `content.attachments` (`FileAttachment[]`, populated by the
 * server on every message read) rendered as the row that hangs under the body.
 * The channel feed drew this list already, as a text chip and nothing else, so
 * an uploaded screenshot was never visible as a picture anywhere; the Chat
 * transcript drew nothing at all. This file is the single answer to both.
 *
 * WHY IT LIVES IN `files/` AND NOT IN EITHER SURFACE: it is the same fact on
 * both — the same contract type, the same bytes route, the same SVG rule — and
 * the surface-specific part (where the row sits, what it is spaced against) is
 * CSS on the container, not markup. Forking it would have meant two places to
 * fix the next time the rule changes, and this lane already owns the file
 * vocabulary it needs (`canThumbnail`, `glyphFor`, `DownloadHref`).
 *
 * THE SVG RULE, inherited verbatim from `AttachmentStrip`: the node sets
 * `Content-Disposition: inline` for `image/*` EXCEPT `image/svg+xml`, because
 * an SVG is a script-bearing document and serving one inline from the app
 * origin would be stored XSS. `canThumbnail` is where that lives; an SVG gets
 * the chip, never an `<img src>`.
 *
 * WHAT IT REFUSES TO DO:
 *   · It never fabricates a URL. The bytes href comes from the host's
 *     resolver (`Seam.files.downloadHref`, Amendment 3) and nowhere else —
 *     see `files/reasons.ts:DOWNLOAD_UNAVAILABLE` for why a component-built
 *     URL is the recorded wrong answer.
 *   · No resolver, or a resolver that answers null for this file, is NOT an
 *     error state: it means "these bytes are not reachable from here", and the
 *     honest rendering of that is the chip the surface already had — a name
 *     and a mime that still opens the file entity — not a broken image.
 *   · A thumbnail whose request fails falls back to that same chip at runtime,
 *     for the same reason: the file is still a real thing to open.
 */
import { useState } from 'react';
import type { EntityId, FileAttachment } from '@tm8/contract';
import { canThumbnail } from './AttachmentStrip';
import type { DownloadHref } from './FilesScreen';
import { glyphFor } from './model';
import './message-attachments.css';

export interface MessageAttachmentsProps {
  /** The message's own list. Empty ⇒ nothing is drawn, not an empty frame. */
  attachments: readonly FileAttachment[];
  /**
   * Resolves the bytes URL for one file. Absent ⇒ every attachment renders as
   * the chip; see the header for why that is the honest degrade and not a gap.
   */
  downloadHref?: DownloadHref | undefined;
  /** Absent ⇒ chips and thumbnails are inert text, never dead buttons. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** The surface's own hook for spacing. The list styling is this lane's. */
  className?: string | undefined;
  testId?: string | undefined;
}

export function MessageAttachments({
  attachments,
  downloadHref,
  onOpenEntity,
  className,
  testId,
}: MessageAttachmentsProps) {
  if (attachments.length === 0) return null;
  return (
    <ul
      className={className ? `fa-attachments ${className}` : 'fa-attachments'}
      aria-label="Attachments"
      data-testid={testId}
    >
      {attachments.map((attachment) => (
        <li key={attachment.fileEntityId}>
          <AttachmentItem
            attachment={attachment}
            href={downloadHref?.(attachment.fileEntityId) ?? null}
            onOpenEntity={onOpenEntity}
          />
        </li>
      ))}
    </ul>
  );
}

function AttachmentItem({
  attachment,
  href,
  onOpenEntity,
}: {
  attachment: FileAttachment;
  href: string | null;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  /* A thumbnail that 404s or is refused is not a picture — it is the same
     unreachable-bytes fact the null href states, discovered later. Falling
     back to the chip keeps the file openable instead of leaving the browser's
     broken-image glyph in the transcript. */
  const [imageFailed, setImageFailed] = useState(false);
  const label = `Open attachment ${attachment.name}`;
  const open = onOpenEntity
    ? () => onOpenEntity(attachment.fileEntityId as EntityId)
    : undefined;

  if (href && canThumbnail(attachment.mime) && !imageFailed) {
    const image = (
      <img
        className="fa-attachment__thumb"
        src={href}
        alt={attachment.name}
        loading="lazy"
        decoding="async"
        onError={() => setImageFailed(true)}
      />
    );
    return open ? (
      <button type="button" className="fa-attachment fa-attachment--image" aria-label={label} onClick={open}>
        {image}
      </button>
    ) : (
      <span className="fa-attachment fa-attachment--image">{image}</span>
    );
  }

  const chip = (
    <>
      <span aria-hidden>{glyphFor(attachment.mime)}</span>
      <span>{attachment.name}</span>
      <span className="fa-attachment__mime">{attachment.mime}</span>
    </>
  );
  return open ? (
    <button type="button" className="fa-attachment" aria-label={label} onClick={open}>
      {chip}
    </button>
  ) : (
    <span className="fa-attachment">{chip}</span>
  );
}
