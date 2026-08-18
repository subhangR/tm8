/**
 * THE ATTACHMENT TILES — files attached to ONE entity, rendered inside the
 * entity panel's content body (2026-08-16 addendum: a row of uniform 64px
 * tiles at the bottom of the description block, not a section of its own).
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
 * edges and renders the peer files. It is BUILT in `EntityDetailPanel` (so no
 * archetype can forget it) and handed to bodies as an `attachmentSlot`; a body
 * that consumes the slot decides only WHERE it sits, never what it is.
 *
 * THE SVG RULE, matched to the server rather than guessed at. The node sets
 * `Content-Disposition: inline` for `image/*`, `audio/*` and `video/*` and
 * EXPLICITLY EXCLUDES `image/svg+xml` (server files.ts:128-145) — an SVG is a
 * script-bearing document, not a picture, and serving one inline from the app
 * origin would be stored XSS. An `<img src>` is a request for that inline
 * byte stream, so the UI must not make one either — in the tile face NOR in
 * the lightbox. SVG gets the glyph face and file info.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { formatSizeChip, glyphFor, previewKindOf, type FileRow } from './model';
import { safeUploadReason, type FileUploadTask } from './upload';
import type { DownloadHref } from './FilesScreen';
import type { ProjectFolderPort } from './port';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import './attachment-strip.css';

export interface AttachmentStripProps {
  /** The anchor. Uploads attach here; the tiles below hang off the same id. */
  anchorId: EntityId;
  /** Already-attached files, derived from the anchor's `attached_to` edges. */
  files: readonly FileRow[];
  /**
   * Resolves the bytes URL for a file. Absent ⇒ no thumbnails and no download
   * links; every tile still renders its name, and the lightbox says why the
   * bytes cannot be fetched rather than offering a link that goes nowhere.
   */
  downloadHref?: DownloadHref;
  /**
   * Starts one upload against the anchor. Absent ⇒ no upload affordance is
   * drawn at all: an inert ＋ tile that silently swallows a dragged file is
   * worse than no tile, because the user believes the file landed.
   */
  startUpload?: (file: File, anchorId: EntityId) => FileUploadTask;
  /**
   * Browsing a connected project folder on the node. Absent ⇒ that menu item
   * is not drawn, for the same reason `startUpload`'s absence removes the
   * upload path: an inert browse control is worse than none.
   */
  projectFolder?: ProjectFolderPort;
  /** An upload finished. The host refetches the anchor so the new edge shows. */
  onUploaded?: () => void;
  /**
   * Cuts one `attached_to` edge. Absent ⇒ no Remove control is drawn, on the
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
}

interface PendingUpload {
  key: string;
  name: string;
  task: FileUploadTask;
  error: string | null;
}

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

/**
 * An image we are willing to put in an `<img>`. Two conditions, both required:
 * the mime is an image at all, and it is not the one image type the server
 * refuses to serve inline. See the header.
 */
export function canThumbnail(mime: string): boolean {
  if (previewKindOf(mime) !== 'image') return false;
  return !/^image\/svg(\+xml)?$/i.test(mime.trim().toLowerCase());
}

/** The uppercase extension for a non-image tile face; null when there is none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

export function AttachmentStrip({
  anchorId,
  files,
  downloadHref,
  startUpload,
  projectFolder,
  onUploaded,
  onDetach,
  onDetached,
}: AttachmentStripProps) {
  const [pending, setPending] = useState<readonly PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [detaching, setDetaching] = useState<readonly string[]>([]);
  /* PER EDGE, not one slot. Two rows can fail independently — a `forbidden` on
     one and a `not_found` on another — and a single slot meant the second
     failure erased the first row's explanation, leaving a row that had visibly
     failed and no longer said why. */
  const [detachErrors, setDetachErrors] = useState<Readonly<Record<string, string>>>({});
  const [picking, setPicking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The open lightbox, by file entity id — null when closed. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** The tile that opened the lightbox — focus returns here on close. */
  const restoreRef = useRef<HTMLElement | null>(null);

  const active = activeId != null ? files.find((f) => f.fileEntityId === activeId) ?? null : null;

  // A refetch that removed the active file (its edge was cut, here or
  // elsewhere) closes the lightbox rather than showing a ghost.
  useEffect(() => {
    if (activeId != null && !files.some((f) => f.fileEntityId === activeId)) {
      setActiveId(null);
    }
  }, [activeId, files]);

  const closeLightbox = useCallback(() => {
    setActiveId(null);
    // Restore focus to the originating tile; a tile that vanished with its
    // edge falls back to the ＋ tile so the keyboard is never dropped.
    queueMicrotask(() => {
      const target = restoreRef.current;
      if (target && target.isConnected) target.focus();
      else plusRef.current?.focus();
    });
  }, []);

  /**
   * NO CONFIRMATION DIALOG, deliberately: this removes a LINK, and the file
   * itself survives in the space's files with its bytes intact, so the act is
   * reversible by re-attaching rather than destructive. What is NOT optional is
   * saying so when it fails — a lightbox that silently stays put after Remove
   * reads as a broken button, so failure keeps it OPEN with the reason inline.
   */
  const detach = useCallback(
    (edgeId: string) => {
      if (!onDetach) return;
      // Only THIS edge's previous explanation is cleared — a retry here says
      // nothing about the row that failed next to it.
      setDetachErrors((current) => {
        if (current[edgeId] === undefined) return current;
        const next = { ...current };
        delete next[edgeId];
        return next;
      });
      setDetaching((current) => [...current, edgeId]);
      void onDetach(edgeId).then(
        () => {
          setDetaching((current) => current.filter((id) => id !== edgeId));
          // Remove is only reachable from the open lightbox, so a success is
          // that lightbox's success: close it and hand focus back.
          closeLightbox();
          onDetached?.();
        },
        (error: unknown) => {
          setDetaching((current) => current.filter((id) => id !== edgeId));
          setDetachErrors((current) => ({ ...current, [edgeId]: reasonOf(error) }));
        },
      );
    },
    [closeLightbox, onDetach, onDetached],
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
            // A cancelled task leaves nothing to report — the tile goes away.
            // Everything else keeps its tile so the user can read the reason.
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
   * THE WHOLE DESCRIPTION BLOCK IS THE DROP TARGET (addendum §5). The strip
   * cannot own that element — it is built in `EntityDetailPanel` and only
   * PLACED inside a body — so the CONSUMING BODY marks its own host with
   * `data-attachment-drophost` and the strip hangs the listeners on its
   * closest marker. No body class names here: this file stays as agnostic of
   * its host's anatomy as it is of the anchor's kind (see the header), and a
   * future archetype opts in by marking its own element rather than adopting
   * a foreign class. Mounted with no marked ancestor, the strip is its own
   * host — exactly the old behaviour. Same `begin` semantics; only the
   * element and the styling changed.
   */
  useEffect(() => {
    if (!startUpload) return;
    const node = rootRef.current;
    if (!node) return;
    const host = (node.closest('[data-attachment-drophost]') ?? node) as HTMLElement;
    let depth = 0;
    const over = (event: DragEvent) => {
      event.preventDefault();
    };
    const enter = () => {
      depth += 1;
      setDragging(true);
    };
    const leave = () => {
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (event.dataTransfer) begin([...event.dataTransfer.files]);
    };
    host.addEventListener('dragover', over);
    host.addEventListener('dragenter', enter);
    host.addEventListener('dragleave', leave);
    host.addEventListener('drop', drop);
    return () => {
      host.removeEventListener('dragover', over);
      host.removeEventListener('dragenter', enter);
      host.removeEventListener('dragleave', leave);
      host.removeEventListener('drop', drop);
    };
  }, [begin, startUpload]);

  // The highlight rides the host element, which may be outside this tree.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const host = (node.closest('[data-attachment-drophost]') ?? node) as HTMLElement;
    host.classList.toggle('fn-drophost--active', dragging);
    return () => host.classList.remove('fn-drophost--active');
  }, [dragging]);

  // The ＋ menu dismisses on outside interaction; Esc and blur are handled on
  // the wrapper itself. Never `alert`/`confirm` — those block the page.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const wrap = menuRef.current;
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  /**
   * A designed empty, not an accidental one. With nothing attached AND no way
   * to attach, the strip renders NOTHING — an empty tile row under every
   * entity in the workspace would be chrome claiming a feature that is not
   * wired here.
   *
   * THE EMPTY STATE IS NOW SILENT TOO (owner ruling 2026-08-18). The ＋ tile
   * used to be the empty state's whole invitation, which meant ~140px of
   * dashed box under every entity that has never had a file — read off an
   * artifact panel, that is a third of the viewport spent on an offer nobody
   * made. Attaching keeps its path: DROP, on the host marked
   * `data-attachment-drophost` (the detail panel marks itself, so it is every
   * kind, not only the ones with a description block).
   *
   * `idle` HIDES rather than unmounts, and that distinction is load-bearing:
   * the drop listeners hang off `rootRef.current.closest(...)`, so a strip
   * that returned null here would take the only remaining way to attach down
   * with it. The root stays in the DOM, `display:none`, holding the wiring.
   */
  if (files.length === 0 && pending.length === 0 && !startUpload && !projectFolder) return null;
  const idle = files.length === 0 && pending.length === 0;

  const openUpload = () => {
    setMenuOpen(false);
    inputRef.current?.click();
  };
  const openFolder = () => {
    setMenuOpen(false);
    setPicking(true);
  };
  // With exactly one wired path, ＋ acts directly — a one-item menu is a
  // click tax (addendum §4).
  const plusAct =
    startUpload && projectFolder ? () => setMenuOpen((open) => !open) : startUpload ? openUpload : openFolder;

  return (
    <div
      className={idle ? 'fn-tiles fn-tiles--idle' : 'fn-tiles'}
      data-testid="attachment-strip"
      data-idle={idle ? 'true' : undefined}
      data-count={files.length}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          event.stopPropagation();
          setMenuOpen(false);
          plusRef.current?.focus();
        }
      }}
    >
      {files.map((file) => (
        <AttachmentTile
          key={file.fileEntityId}
          file={file}
          downloadHref={downloadHref}
          onOpen={(tile) => {
            restoreRef.current = tile;
            setActiveId(file.fileEntityId);
          }}
        />
      ))}

      {/* In-flight uploads are tiles too (addendum §7): a failed one keeps its
          tile and its safe reason; a cancelled one disappears. */}
      {pending.map((item) => (
        <div
          className={item.error ? 'fn-tile fn-tile--pending fn-tile--failed' : 'fn-tile fn-tile--pending'}
          data-testid="attachment-pending"
          key={item.key}
          title={item.error ?? `${item.name} — uploading…`}
        >
          <span className="fn-tile__face" aria-hidden>
            {item.error ? '!' : <span className="fn-tile__spin" />}
          </span>
          <span className="fn-tile__name">{item.name}</span>
          {item.error ? (
            <span className="fn-tile__why" role="alert">
              {item.error}
            </span>
          ) : (
            <button type="button" className="fn-tile__cancel" onClick={() => item.task.cancel()}>
              cancel
            </button>
          )}
        </div>
      ))}

      {/* The ＋ is gated on `idle`, not merely hidden by `.fn-tiles--idle`:
          jsdom loads no stylesheets, so a button left in the tree "but hidden
          by CSS" is a button every test still finds and clicks — a green suite
          asserting an affordance no browser renders. Not rendering it is the
          only version of this rule the tests can actually see. */}
      {!idle && (startUpload || projectFolder) ? (
        <span className="fn-plus" ref={menuRef} onBlur={(event) => {
          const wrap = menuRef.current;
          if (wrap && event.relatedTarget instanceof Node && wrap.contains(event.relatedTarget)) return;
          setMenuOpen(false);
        }}>
          <button
            type="button"
            className="fn-tile fn-tile--plus"
            data-testid="attachment-add"
            ref={plusRef}
            aria-haspopup={startUpload && projectFolder ? 'menu' : undefined}
            aria-expanded={startUpload && projectFolder ? menuOpen : undefined}
            title="Attach a file to this entity"
            onClick={plusAct}
          >
            <span className="fn-tile__face fn-tile__face--plus" aria-hidden>
              ＋
            </span>
            <span className="fn-tile__name">attach</span>
          </button>
          {menuOpen && startUpload && projectFolder ? (
            <div className="fn-menu" role="menu" aria-label="Attach a file">
              <button type="button" className="fn-menu__item" role="menuitem" onClick={openUpload}>
                <span className="fn-menu__label">＋ Upload from this device</span>
                <span className="fn-menu__hint">or drop files on the description</span>
              </button>
              {/* A SECOND, DIFFERENT SOURCE — not a second way to do the same
                  thing. The input sends bytes from this machine; this names a
                  file already sitting in a project folder on the node, which
                  the input cannot reach because it never learns an absolute
                  path. */}
              <button type="button" className="fn-menu__item" role="menuitem" onClick={openFolder}>
                <span className="fn-menu__label">▱ From a project folder</span>
                <span className="fn-menu__hint">read on the node, not uploaded</span>
              </button>
            </div>
          ) : null}
        </span>
      ) : null}

      {startUpload ? (
        <input
          ref={inputRef}
          type="file"
          multiple
          className="fn-tiles__input"
          data-testid="attachment-file-input"
          onChange={(event) => {
            begin([...(event.target.files ?? [])]);
            // Same file twice in a row must fire change twice.
            event.target.value = '';
          }}
        />
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

      {active ? (
        <AttachmentLightbox
          file={active}
          downloadHref={downloadHref}
          /* Bound HERE, so the lightbox never has to re-derive whether the
             file is detachable — no edge, no callback, no control. */
          onDetach={onDetach && active.edgeId ? () => detach(active.edgeId as string) : undefined}
          detaching={active.edgeId !== null && detaching.includes(active.edgeId)}
          detachWhy={active.edgeId !== null ? detachErrors[active.edgeId] ?? null : null}
          onClose={closeLightbox}
        />
      ) : null}
    </div>
  );
}

/**
 * One 64×64 tile: image files fill it (`object-fit: cover`, so every tile is
 * identical whatever the source dimensions), everything else — SVG included,
 * see the header — gets the glyph + uppercase extension face. The truncated
 * filename sits below; the full name and size ride the title and the
 * accessible name so the ellipsis loses nothing. Clicking opens the lightbox;
 * there is deliberately NO hover × here — Remove lives in the lightbox, which
 * is what keeps the row clean.
 */
function AttachmentTile({
  file,
  downloadHref,
  onOpen,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
  onOpen: (tile: HTMLElement) => void;
}) {
  const href = downloadHref ? downloadHref(file.fileEntityId) : null;
  const size = formatSizeChip(file.sizeBytes);
  const thumb = href !== null && canThumbnail(file.mime);
  const name = size ? `${file.name} · ${size}` : file.name;
  const ext = extensionOf(file.name);

  return (
    <button
      type="button"
      className="fn-tile"
      data-testid="attachment-item"
      data-mime={file.mime}
      data-thumb={thumb ? 'true' : 'false'}
      title={name}
      aria-label={name}
      aria-haspopup="dialog"
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="fn-tile__face">
        {thumb ? (
          <img
            className="fn-tile__img"
            src={href}
            alt={file.name}
            loading="lazy"
            /* THE SIZE GUARD lives on the element as well as in the
               stylesheet: a 5000px-wide photo must not blow out the tile even
               if this component is ever rendered somewhere the stylesheet did
               not load. */
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <>
            <span className="fn-tile__glyph" aria-hidden>
              {glyphFor(file.mime)}
            </span>
            {ext ? <span className="fn-tile__ext" aria-hidden>{ext}</span> : null}
          </>
        )}
      </span>
      <span className="fn-tile__name">{file.name}</span>
    </button>
  );
}

/**
 * THE LIGHTBOX — click a tile, see the file; Download and Remove live here
 * (addendum §6). Focus-trapped, Esc and scrim-click close, focus returns to
 * the originating tile. Non-images and SVG render file info only: an SVG in
 * an `<img>` is the request the server refuses, in the large frame exactly as
 * in the tile.
 */
function AttachmentLightbox({
  file,
  downloadHref,
  onDetach,
  detaching,
  detachWhy,
  onClose,
}: {
  file: FileRow;
  downloadHref?: DownloadHref;
  onDetach?: () => void;
  detaching: boolean;
  detachWhy: string | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const href = downloadHref ? downloadHref(file.fileEntityId) : null;
  const thumb = href !== null && canThumbnail(file.mime);
  const size = formatSizeChip(file.sizeBytes);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const trap = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])'),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fn-lightbox"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="fn-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={trap}
      >
        <div className="fn-lightbox__head">
          <span className="fn-lightbox__title" id={titleId}>
            {file.name}
            {size ? ` · ${size}` : ''} · {file.mime}
          </span>
          <button type="button" className="fn-lightbox__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {thumb ? (
          <img className="fn-lightbox__img" src={href} alt={file.name} />
        ) : (
          <dl className="fn-lightbox__info">
            <dt>name</dt>
            <dd>{file.name}</dd>
            <dt>type</dt>
            <dd>{file.mime}</dd>
            {size ? (
              <>
                <dt>size</dt>
                <dd>{size}</dd>
              </>
            ) : null}
          </dl>
        )}

        <div className="fn-lightbox__actions">
          {href !== null ? (
            <a className="fn-lightbox__btn" href={href} download={file.name} title={`Download ${file.name}`}>
              Download
            </a>
          ) : (
            /* L6: the control is visible, dead, and says why — never a link
               that resolves to the current page. */
            <span className="fn-lightbox__nolink" title="No download URL was supplied to this panel.">
              no download here
            </span>
          )}
          {onDetach ? (
            /* NEVER natively disabled, even mid-flight: a disabled control
               leaves the tab order, the browser blurs it, and the next Tab
               walks out of a dialog that is still aria-modal — precisely when
               a failure needs the trap intact. Busy instead: focusable, says
               so, and the guard keeps it from firing twice. */
            <button
              type="button"
              className="fn-lightbox__btn fn-lightbox__btn--remove"
              data-testid="attachment-detach"
              aria-busy={detaching || undefined}
              title={
                detaching
                  ? `Removing ${file.name} — a removal is already in progress`
                  : `Remove ${file.name} from this entity — the file itself is kept`
              }
              onClick={() => {
                if (detaching) return;
                onDetach();
              }}
            >
              {detaching ? '…' : 'Remove'}
            </button>
          ) : null}
        </div>

        {detachWhy ? (
          <p className="fn-lightbox__why" role="alert">
            {detachWhy}
          </p>
        ) : null}
      </div>
    </div>
  );
}
