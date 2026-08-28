/**
 * T3-4 — FILES & ATTACHMENTS. Oracle: `T3 Files, Node & Inbox Hi-Fi.dc.html`
 * L21–L129, read whole.
 *
 * THE SENTENCE THE ORACLE OPENS WITH, and the one that shapes this file:
 * "files are attachments on entities and messages, never a kind of their own
 * — one chip grammar everywhere" (L24). So there is no file browser here.
 * There is an upload affordance, a chip, a row, and a preview, and each one
 * appears wherever files appear.
 *
 * WHAT IS REAL AND WHAT IS REFUSED, stated once so no reader has to infer it:
 *   REAL   — every READ. Attachment chips come from `MessageView.content
 *            .attachments` (contract-typed); the FILES·N list comes from an
 *            entity's `attached_to` edges; file names, mimes and sizes come
 *            from the file entity's own state.
 *   REFUSED — every WRITE and every BYTE. Upload, retry, cancel, attach,
 *            detach: contract-v1 routes with no seam verb. Download and text
 *            preview: a contract-v1 route with no seam read. See
 *            `reasons.ts`, which carries the measurement behind each.
 *
 * The download control is the one hinge: pass `downloadHref` and every
 * download link on this screen becomes real at once; pass nothing and they
 * all carry DOWNLOAD_UNAVAILABLE. There is no third state, and no control
 * that silently does nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar, Eyebrow } from '../kit';
import { DisabledAction, DisabledIconControl, HollowInline } from '../panels';
import {
  extensionOf,
  failureWord,
  formatSizeChip,
  formatSizeRow,
  glyphFor,
  previewKindOf,
  capSentence,
  type FileRow,
  type UploadItem,
} from './model';
import {
  ATTACH_UNAVAILABLE,
  DOWNLOAD_UNAVAILABLE,
  FILE_CAP_UNKNOWN,
  PDF_PREVIEW_UNAVAILABLE,
  TEXT_PREVIEW_UNAVAILABLE,
  UPLOAD_CANCEL_UNAVAILABLE,
  UPLOAD_RETRY_UNAVAILABLE,
  UPLOAD_UNAVAILABLE,
} from './reasons';

/**
 * A resolver, not a URL. The host owns transport; this lane owns the control.
 * Returning `null` for a particular file is legitimate (its bytes are not
 * reachable) and renders the same refusal as supplying no resolver at all.
 */
export type DownloadHref = (fileEntityId: string) => string | null;

export interface MessageBubble {
  authorId: string;
  authorName: string;
  authorIsAgent: boolean;
  authorAvatar?: string | null;
  /** The oracle's "to this session · 2m" — supplied whole, never assembled. */
  meta: string;
  body: string;
  files: readonly FileRow[];
}

export interface FilesScreenProps {
  /** Where an upload would land. The oracle: the drop target ALWAYS names it. */
  destinationLabel: string;
  /** The queue. Empty is the normal state in this build — nothing can start. */
  queue?: readonly UploadItem[];
  /** Per-file ceiling, in bytes. `null` ⇒ hollow; see `capSentence`. */
  maxSizeBytes?: number | null;
  /** The message the chips hang off. */
  bubble?: MessageBubble | null;
  /** The FILES · N section: files attached to an entity. */
  attached?: readonly FileRow[];
  /** Label over the attached list, e.g. the entity's own title. */
  attachedLabel?: string;
  downloadHref?: DownloadHref;
  /** Opens the preview overlay. Omitted ⇒ chips are not preview triggers. */
  onPreview?: (file: FileRow) => void;
  /**
   * THE ORACLE'S OWN SWITCH. Its annotation band sits inside
   * `<sc-if value="{{notes}}">` (L121) and its per-card captions are written
   * in the same design-note voice ("drag target names its destination…",
   * L67). Those are CANVAS ANNOTATIONS, not product copy — D47's ruling
   * about the layout picker generalises: the review board turns them on, the
   * product does not. Default `false`, and the default is the product.
   */
  notes?: boolean;
}

// ===========================================================================

export function FilesScreen(props: FilesScreenProps) {
  const notes = props.notes ?? false;
  const [preview, setPreview] = useState<FileRow | null>(null);
  const openPreview = useCallback(
    (file: FileRow) => {
      setPreview(file);
      props.onPreview?.(file);
    },
    [props],
  );

  return (
    <div className="fn-screen" data-testid="files-screen">
      <div className="fn-cols">
        <UploadCard
          destinationLabel={props.destinationLabel}
          queue={props.queue ?? []}
          maxSizeBytes={props.maxSizeBytes ?? null}
          notes={notes}
        />
        <AttachmentsCard
          bubble={props.bubble ?? null}
          attached={props.attached ?? []}
          attachedLabel={props.attachedLabel}
          downloadHref={props.downloadHref}
          onPreview={openPreview}
          notes={notes}
        />
        <PreviewCard files={props.attached ?? []} downloadHref={props.downloadHref} notes={notes} />
      </div>
      {notes ? <ScreenNotes /> : null}
      {preview ? (
        <PreviewOverlay
          file={preview}
          downloadHref={props.downloadHref}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}

// ===========================================================================
// UPLOAD — drag state + queue (oracle L30–L68)
// ===========================================================================

/**
 * The dropzone is NOT a drop target in this build, and it says so.
 *
 * A live-looking dropzone that swallows a dragged file and does nothing is
 * precisely the R5 "I click run and nothing happens" defect wearing a
 * different costume — worse, because the user believes they have handed over
 * their data. So the zone renders as `DisabledAction`: visible, labelled,
 * focusable, carrying its reason, and never accepting a drop.
 */
function UploadCard({
  destinationLabel,
  queue,
  maxSizeBytes,
  notes,
}: {
  destinationLabel: string;
  queue: readonly UploadItem[];
  maxSizeBytes: number | null;
  notes: boolean;
}) {
  const cap = capSentence(maxSizeBytes);
  return (
    <section className="fn-card fn-card--paper" data-testid="upload-card">
      <Eyebrow faint>UPLOAD — DRAG STATE + QUEUE</Eyebrow>

      <div className="fn-drop" data-testid="dropzone">
        <span className="fn-drop__glyph" aria-hidden>
          ⇣
        </span>
        <DisabledAction reason={UPLOAD_UNAVAILABLE} label={`Attach a file to ${destinationLabel}`}>
          <span className="fn-drop__title">Drop to attach to {destinationLabel}</span>
        </DisabledAction>
        <span className="fn-drop__cap">
          {cap ? (
            `or browse · ${cap}`
          ) : (
            <>
              or browse · <HollowInline caption={FILE_CAP_UNKNOWN}>— per file</HollowInline>
            </>
          )}
        </span>
      </div>

      {queue.length === 0 ? (
        /* D-law 9: an empty section states its absence in one quiet line
           rather than expanding to fill the card with nothing. */
        <p className="fn-queue-empty" data-testid="queue-empty">
          Nothing in the queue — no upload action is wired to this card.
        </p>
      ) : (
        <div className="fn-queue">
          {queue.map((item, i) => (
            <QueueRow key={`${item.name}:${i}`} item={item} />
          ))}
        </div>
      )}

      {notes ? (
        <p className="fn-note">
          drag target names its destination; failures say the cap and keep “try again” — never a
          bare ✗
        </p>
      ) : null}
    </section>
  );
}

function QueueRow({ item }: { item: UploadItem }) {
  const glyph = glyphFor(item.mime);

  if (item.phase === 'uploading') {
    return (
      <div className="fn-qrow" data-testid="queue-row" data-phase="uploading">
        <span className="fn-qrow__glyph" aria-hidden>
          {glyph}
        </span>
        <div className="fn-qrow__main">
          <div className="fn-qrow__line">
            <span className="fn-qrow__name">{item.name}</span>
            <span className="fn-qrow__pct">{item.percent}%</span>
          </div>
          {/* A real progress semantic, not a coloured div: a screen-reader
              user gets the same number the sighted user reads. */}
          <div
            className="fn-qrow__track"
            role="progressbar"
            aria-label={`${item.name} upload progress`}
            aria-valuenow={item.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="fn-qrow__fill" style={{ width: `${item.percent}%` }} />
          </div>
        </div>
        <DisabledIconControl
          label={`Cancel upload of ${item.name}`}
          reason={UPLOAD_CANCEL_UNAVAILABLE}
          glyph="✕"
        />
      </div>
    );
  }

  if (item.phase === 'uploaded') {
    return (
      <div className="fn-qrow" data-testid="queue-row" data-phase="uploaded">
        <span className="fn-qrow__glyph" aria-hidden>
          {glyph}
        </span>
        <span className="fn-qrow__name fn-qrow__name--flex">{item.name}</span>
        <span className="fn-qrow__size">{formatSizeRow(item.sizeBytes)}</span>
        <span className="fn-qrow__ok">✓ uploaded</span>
      </div>
    );
  }

  const failure = failureWord('failed');
  return (
    <div className="fn-qrow fn-qrow--failed" data-testid="queue-row" data-phase="failed">
      <div className="fn-qrow__line">
        <span className="fn-qrow__glyph fn-qrow__glyph--block" aria-hidden>
          ◇
        </span>
        <span className="fn-qrow__name fn-qrow__name--muted">{item.name}</span>
        <span className="fn-qrow__failed">{failure.word}</span>
      </div>
      <div className="fn-qrow__why">
        {/* The oracle's law (L124): a failure states the CAUSE and keeps a way
            forward. Never a bare ✗, and never a generic "error". */}
        <span className="fn-qrow__whytext">{item.why}</span>
        <DisabledAction reason={UPLOAD_RETRY_UNAVAILABLE} label={`Retry ${item.name}`}>
          <span className="fn-qrow__retry">try again</span>
        </DisabledAction>
      </div>
    </div>
  );
}

// ===========================================================================
// ATTACHMENT CHIPS — on a message, and on an entity (oracle L69–L95)
// ===========================================================================

function AttachmentsCard({
  bubble,
  attached,
  attachedLabel,
  downloadHref,
  onPreview,
  notes,
}: {
  bubble: MessageBubble | null;
  attached: readonly FileRow[];
  attachedLabel?: string;
  downloadHref?: DownloadHref;
  onPreview: (file: FileRow) => void;
  notes: boolean;
}) {
  return (
    <section className="fn-card fn-card--paper" data-testid="attachments-card">
      <Eyebrow faint>ATTACHMENT CHIPS — ON A MESSAGE</Eyebrow>

      {bubble ? (
        <div className="fn-bubble" data-testid="message-bubble">
          <div className="fn-bubble__head">
            <Avatar
              actorId={bubble.authorId}
              provenance={bubble.authorIsAgent ? 'agent' : 'human'}
              label={bubble.authorName}
              size={15}
              src={bubble.authorAvatar ?? null}
            />
            <span className="fn-bubble__author">@{bubble.authorName}</span>
            <span className="fn-bubble__meta">{bubble.meta}</span>
          </div>
          <p className="fn-bubble__body">{bubble.body}</p>
          <div className="fn-chips">
            {bubble.files.map((file) => (
              <FileChip key={file.fileEntityId} file={file} onPreview={onPreview} />
            ))}
            {/* The oracle draws no "+ attach" on the bubble, but the act it
                implies has no executor either — stated once, here, rather
                than left as an absence a reader would have to notice. */}
            <DisabledAction reason={ATTACH_UNAVAILABLE} label="Attach a file to this message">
              <span className="fn-chip fn-chip--ghost">＋ attach</span>
            </DisabledAction>
          </div>
        </div>
      ) : (
        <p className="fn-queue-empty" data-testid="bubble-empty">
          No message supplied — chips render on a message that has attachments.
        </p>
      )}

      <Eyebrow faint>{attachedLabel ? `ON ${attachedLabel}` : 'ON A TASK — CONTENT TAB SECTION'}</Eyebrow>

      <div className="fn-filelist" data-testid="file-list">
        <div className="fn-filelist__head">FILES · {attached.length}</div>
        {attached.length === 0 ? (
          /* A MEASURED zero, not a hollow one: the entity's connections were
             read and carried no `attached_to` edge. Saying "—" here would
             claim we never looked, which would be the opposite lie. */
          <p className="fn-filelist__empty" data-testid="file-list-empty">
            No files attached to this entity.
          </p>
        ) : (
          attached.map((file) => (
            <FileListRow
              key={file.fileEntityId}
              file={file}
              downloadHref={downloadHref}
              onPreview={onPreview}
            />
          ))
        )}
      </div>

      {notes ? (
        <p className="fn-note">
          one chip everywhere — glyph by type (▦ image · ❐ pdf · ▤ text · ◇ other); sourceMissing is
          wait amber, not an error
        </p>
      ) : null}
    </section>
  );
}

/**
 * THE CHIP. One grammar everywhere (L24/L94): glyph, name, size. It opens a
 * preview — a client-side act with a real handler — so it is a live button
 * and not a refusal. A chip whose bytes are missing carries the amber word
 * instead of a size and is NOT clickable, because there is nothing to show.
 */
export function FileChip({
  file,
  onPreview,
}: {
  file: FileRow;
  onPreview?: (file: FileRow) => void;
}) {
  const size = formatSizeChip(file.sizeBytes);
  const missing = failureWord('missing');

  if (file.sourceMissing) {
    return (
      <span className="fn-chip fn-chip--missing" data-testid="file-chip" data-missing="true">
        <span aria-hidden>{glyphFor(file.mime)}</span>
        {file.name}
        <span className="fn-chip__missing">{missing.word}</span>
      </span>
    );
  }

  if (!onPreview) {
    return (
      <span className="fn-chip" data-testid="file-chip">
        <span aria-hidden>{glyphFor(file.mime)}</span>
        {file.name}
        {size ? <span className="fn-chip__size">{size}</span> : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="fn-chip fn-chip--live"
      data-testid="file-chip"
      onClick={() => onPreview(file)}
    >
      <span aria-hidden>{glyphFor(file.mime)}</span>
      {file.name}
      {size ? <span className="fn-chip__size">{size}</span> : null}
    </button>
  );
}

function FileListRow({
  file,
  downloadHref,
  onPreview,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
  onPreview: (file: FileRow) => void;
}) {
  const size = formatSizeChip(file.sizeBytes);

  return (
    <div className="fn-frow" data-testid="file-row" data-missing={file.sourceMissing ? 'true' : undefined}>
      <span className="fn-frow__glyph" aria-hidden>
        {file.sourceMissing ? '◇' : glyphFor(file.mime)}
      </span>
      {file.sourceMissing ? (
        <span className="fn-frow__name fn-frow__name--muted">{file.name}</span>
      ) : (
        <button type="button" className="fn-frow__name fn-frow__name--live" onClick={() => onPreview(file)}>
          {file.name}
        </button>
      )}
      {file.sourceMissing ? (
        <span className="fn-frow__missing">{failureWord('missing').word}</span>
      ) : (
        <>
          <span className="fn-frow__meta">
            {size ? <span>{size}</span> : null}
            {size && file.attributedTo ? <span aria-hidden> · </span> : null}
            {file.attributedTo ? (
              <span className="fn-frow__actor">
                <Avatar
                  actorId={file.attributedTo.id}
                  provenance={file.attributedTo.isAgent ? 'agent' : 'human'}
                  label={file.attributedTo.displayName}
                  size={15}
                  src={file.attributedTo.avatar ?? null}
                />
                <span>{`@${file.attributedTo.displayName}`}</span>
              </span>
            ) : null}
          </span>
          <DownloadControl file={file} downloadHref={downloadHref} compact />
        </>
      )}
    </div>
  );
}

/**
 * THE ONE HINGE. Everything that can download on this screen goes through
 * here, so "is download wired?" has exactly one answer and one place to
 * change. No resolver, or a resolver that declines this file ⇒ the refusal.
 */
export function DownloadControl({
  file,
  downloadHref,
  compact = false,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
  compact?: boolean;
}) {
  const href = downloadHref ? downloadHref(file.fileEntityId) : null;
  const label = `Download ${file.name}`;

  if (href === null) {
    return compact ? (
      <DisabledIconControl label={label} reason={DOWNLOAD_UNAVAILABLE} glyph="↓" />
    ) : (
      <DisabledAction reason={DOWNLOAD_UNAVAILABLE} label={label}>
        <span className="fn-dl">↓ download</span>
      </DisabledAction>
    );
  }

  return (
    <a
      className={compact ? 'fn-dl fn-dl--compact' : 'fn-dl'}
      href={href}
      download={file.name}
      data-testid="download-link"
      aria-label={label}
    >
      {compact ? '↓' : '↓ download'}
    </a>
  );
}

// ===========================================================================
// PREVIEW (oracle L96–L119)
// ===========================================================================

/**
 * The static preview card the oracle draws on the board — image tile, text
 * tile, unpreviewable card — rendered from whatever files it is given rather
 * than from three hardcoded specimens. With no files it says so.
 *
 * ALWAYS DARK, and this is a RULING (flagged in HANDOVER for ratification):
 * inside ONE frame the oracle paints the upload and chips cards on
 * `#FBFAF6` (= light `--pn-surface`, L31/L70) and this card on `#221E15`
 * (= dark `--pn-card`, L97). Two palettes side by side in a single frame is
 * an intention, not drift — a media lightbox is dark the way the terminal
 * family is dark (design law 8 / D40), so it opens a nested dark scope
 * instead of restating a single hex.
 */
function PreviewCard({
  files,
  downloadHref,
  notes,
}: {
  files: readonly FileRow[];
  downloadHref?: DownloadHref;
  notes: boolean;
}) {
  const shown = files.slice(0, 2);
  const unpreviewable = files.find((f) => previewKindOf(f.mime) === 'none') ?? null;

  return (
    <section
      className="cv2-root fn-card fn-card--dark" data-astryx-theme="neutral"
      data-theme="dark"
      data-always-dark="true"
      data-testid="preview-card"
    >
      <Eyebrow faint>PREVIEW OVERLAY — IMAGE · TEXT · UNPREVIEWABLE</Eyebrow>

      {shown.length === 0 ? (
        <p className="fn-queue-empty">No files to preview.</p>
      ) : (
        <div className="fn-preview-row">
          {shown.map((file) => (
            <PreviewTile key={file.fileEntityId} file={file} downloadHref={downloadHref} />
          ))}
        </div>
      )}

      {unpreviewable ? (
        <UnpreviewableCard file={unpreviewable} downloadHref={downloadHref} />
      ) : null}

      {notes ? (
        <p className="fn-note fn-note--dark">
          preview opens as a Z4-style overlay (esc closes); pdf gets a paged variant of the text
          frame
        </p>
      ) : null}
    </section>
  );
}

function PreviewTile({ file, downloadHref }: { file: FileRow; downloadHref?: DownloadHref }) {
  const kind = previewKindOf(file.mime);
  const href = downloadHref ? downloadHref(file.fileEntityId) : null;

  return (
    <div className="fn-ptile" data-testid="preview-tile" data-kind={kind}>
      <PreviewSurface file={file} kind={kind} href={href} />
      <div className="fn-ptile__foot">
        <span className="fn-ptile__name">{file.name}</span>
        {kind === 'image' ? (
          <DownloadControl file={file} downloadHref={downloadHref} />
        ) : (
          <span className="fn-ptile__kindnote">{kind} · first 200 lines</span>
        )}
      </div>
    </div>
  );
}

/**
 * The frame itself. Four outcomes, and every one of them is stated:
 *   image + href  → the real bytes render;
 *   image, no href → the checkerboard, carrying the download refusal;
 *   text / pdf     → the refusal, because a byte READ is missing (a URL is
 *                    not enough — the frame prints decoded content);
 *   none           → handled by UnpreviewableCard, not here.
 */
function PreviewSurface({
  file,
  kind,
  href,
}: {
  file: FileRow;
  kind: ReturnType<typeof previewKindOf>;
  href: string | null;
}) {
  if (kind === 'image' && href !== null) {
    return (
      <div className="fn-pframe">
        <img className="fn-pframe__img" src={href} alt={file.name} data-testid="preview-image" />
      </div>
    );
  }
  if (kind === 'image') {
    return (
      <div className="fn-pframe fn-pframe--checker" data-testid="preview-placeholder">
        <DisabledAction reason={DOWNLOAD_UNAVAILABLE} label={`Preview ${file.name}`}>
          <span className="fn-pframe__ghost">image bytes unreachable</span>
        </DisabledAction>
      </div>
    );
  }
  return (
    <div className="fn-pframe fn-pframe--text" data-testid="preview-placeholder">
      <DisabledAction
        reason={kind === 'pdf' ? PDF_PREVIEW_UNAVAILABLE : TEXT_PREVIEW_UNAVAILABLE}
        label={`Preview ${file.name}`}
      >
        <span className="fn-pframe__ghost">
          {kind === 'pdf' ? 'pdf pages unreachable' : 'text unreachable'}
        </span>
      </DisabledAction>
    </div>
  );
}

/** The third failure word: neutral, and download is the way out (L109–L116). */
function UnpreviewableCard({
  file,
  downloadHref,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
}) {
  const ext = extensionOf(file.name);
  return (
    <div className="fn-nopreview" data-testid="no-preview">
      <span className="fn-nopreview__glyph" aria-hidden>
        ◇
      </span>
      <div className="fn-nopreview__text">
        <span className="fn-nopreview__title">No preview for {ext ?? file.mime}</span>
        <span className="fn-nopreview__sub">
          preview covers image · pdf · text — everything else downloads
        </span>
      </div>
      <DownloadControl file={file} downloadHref={downloadHref} />
    </div>
  );
}

/**
 * The overlay proper. Esc closes (oracle L118), and the close button is a
 * real control because closing is a client act with a real handler — the
 * screen must not refuse things it can actually do.
 */
export function PreviewOverlay({
  file,
  downloadHref,
  onClose,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const kind = previewKindOf(file.mime);
  const href = downloadHref ? downloadHref(file.fileEntityId) : null;

  return (
    <div className="fn-overlay" data-testid="preview-overlay" role="presentation" onClick={onClose}>
      <div
        className="cv2-root fn-overlay__panel" data-astryx-theme="neutral"
        data-theme="dark"
        data-always-dark="true"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview: ${file.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fn-overlay__head">
          <span className="fn-overlay__glyph" aria-hidden>
            {glyphFor(file.mime)}
          </span>
          <span className="fn-overlay__name">{file.name}</span>
          <span className="fn-overlay__size">{formatSizeRow(file.sizeBytes) ?? ''}</span>
          <button type="button" className="fn-overlay__close" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </div>
        {kind === 'none' ? (
          <UnpreviewableCard file={file} downloadHref={downloadHref} />
        ) : (
          <PreviewSurface file={file} kind={kind} href={href} />
        )}
        <div className="fn-overlay__foot">
          <span className="fn-overlay__esc">esc closes</span>
          <DownloadControl file={file} downloadHref={downloadHref} />
        </div>
      </div>
    </div>
  );
}

// ===========================================================================

/** The oracle's three legend notes (L123–L125), which ARE the screen's laws. */
function ScreenNotes() {
  return (
    <div className="fn-legend" data-testid="files-legend">
      <LegendNote title="Files belong to things.">
        Every upload lands on an entity or message; the drop target always names where. No orphan
        file library in Phase 1.
      </LegendNote>
      <LegendNote title="Three failure words:">
        failed (upload, block red, retryable) · missing from this node (wait amber — the record
        exists, the bytes don’t) · no preview (neutral — download works). Never a generic “error”.
      </LegendNote>
      <LegendNote title="Agents attach too:">
        a session’s uploads use the same chips with agent provenance — square avatar in the meta,
        nothing visually second-class.
      </LegendNote>
    </div>
  );
}

function LegendNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fn-legend__item">
      <span className="fn-legend__bullet" aria-hidden>
        ◦
      </span>
      <p className="fn-legend__text">
        <strong>{title}</strong> {children}
      </p>
    </div>
  );
}
