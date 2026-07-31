import { ChipById, useFacade } from '../../entity';
import { hasFileAttachmentControl } from '../../facade';
import type { FileAttachment } from '../../types/contract';

function isSafeInlineImage(mime: string): boolean {
  return mime.startsWith('image/') && mime.toLowerCase() !== 'image/svg+xml';
}

export function AttachmentPreview({ attachment }: { attachment: FileAttachment }) {
  const facade = useFacade();
  const url = hasFileAttachmentControl(facade)
    ? facade.fileDownloadUrl(attachment.fileEntityId)
    : null;

  if (url && isSafeInlineImage(attachment.mime)) {
    return (
      <figure className="cv2-thread__media" data-file-id={attachment.fileEntityId}>
        <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}>
          <img src={url} alt={attachment.name} loading="lazy" decoding="async" />
        </a>
        <figcaption><ChipById entityId={attachment.fileEntityId} /></figcaption>
      </figure>
    );
  }

  if (url && attachment.mime.startsWith('audio/')) {
    return (
      <div className="cv2-thread__media cv2-thread__media--audio" data-file-id={attachment.fileEntityId}>
        <ChipById entityId={attachment.fileEntityId} />
        <audio controls preload="metadata" src={url} aria-label={attachment.name} />
      </div>
    );
  }

  if (url && attachment.mime.startsWith('video/')) {
    return (
      <figure className="cv2-thread__media" data-file-id={attachment.fileEntityId}>
        <video controls preload="metadata" src={url} aria-label={attachment.name} />
        <figcaption><ChipById entityId={attachment.fileEntityId} /></figcaption>
      </figure>
    );
  }

  return (
    <span className="cv2-thread__attachment" title={`${attachment.name} · ${attachment.mime}`}>
      <ChipById entityId={attachment.fileEntityId} />
      {url && <a className="cv2-thread__download" href={url} download={attachment.name}>Download</a>}
    </span>
  );
}

export function AttachmentGallery({ attachments }: { attachments: readonly FileAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="cv2-thread__attachments" aria-label="Attachments">
      {attachments.map((attachment) => (
        <AttachmentPreview key={attachment.fileEntityId} attachment={attachment} />
      ))}
    </div>
  );
}
