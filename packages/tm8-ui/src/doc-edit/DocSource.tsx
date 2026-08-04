import { useRef, useState } from 'react';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import { safeUploadReason, type FileUploadTask } from '../files/upload';
import { blockLabel, blocksIn, isDiagram, type DocBlock } from './blocks';
import { fileReference, spliceInto } from './insert';
import type { DocSaveHandle } from './useDocSave';

/**
 * Starts one upload against the document's own anchor. Bound by the host, so
 * this lane never learns which entity it is writing to. Absent ⇒ no insert
 * affordance is drawn at all: an inert "insert a file" button is worse than
 * none, because the writer believes the file is on its way.
 */
export type DocAttach = (file: File) => FileUploadTask;

/**
 * THE WRITE STANCE — markdown source in mono, and the fence chips beside it.
 *
 * A REAL `<textarea>`, AND THAT IS THE RULED DIVERGENCE. The oracle draws the
 * source as syntax-tinted spans with the mermaid fence collapsed to a chip
 * INLINE in the text flow (lines 101-111). That drawing is a static mock of a
 * rich editor; a textarea cannot host elements, and a contenteditable that
 * could is a build this wave does not have.
 *
 * The bar this wave was given decides it: link-level completeness first,
 * fidelity later. A textarea types and saves through the real seam; a div that
 * looks exactly right and cannot accept a keystroke is the more expensive lie.
 * So the source is a textarea and the blocks are drawn in their own strip,
 * directly beneath it, keeping the oracle's actual LAW ("blocks stay blocks —
 * the block body is edited in its own editor, never inline as raw code someone
 * can half-break", annotation 3) while losing its inline position. DRIFT,
 * recorded in the handover with this reason.
 *
 * SYNTAX TINT IS ABSENT, NOT FORGOTTEN — same cause, same record.
 */
export function DocSource({
  save,
  onOpenBlock,
  label = 'Document source',
  attach,
  onAttached,
}: {
  save: DocSaveHandle;
  /** Absent ⇒ every block's editor entry is disabled-with-reason. */
  onOpenBlock?: (block: DocBlock) => void;
  label?: string;
  /** Absent ⇒ the insert control is not drawn. See `DocAttach`. */
  attach?: DocAttach;
  /** An upload landed, so the host can refetch the anchor's attachment list. */
  onAttached?: () => void;
}) {
  const readOnly = save.unavailable !== null;
  const blocks = blocksIn(save.body);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const insert = useFileInsert({ save, attach, onAttached, area });

  return (
    <div className="de-source">
      <textarea
        ref={area}
        className="de-source__area"
        data-testid="doc-source"
        aria-label={label}
        value={save.body}
        readOnly={readOnly}
        spellCheck={false}
        onChange={(e) => save.edit({ body: e.target.value })}
        /* A file dropped on a textarea does nothing useful by default — some
           browsers navigate away from the app entirely, taking the draft with
           them. With an uploader wired, the drop becomes the insert; without
           one the default is still refused, because losing the draft is the
           worse outcome either way. */
        onDragOver={insert.canInsert ? (e) => e.preventDefault() : undefined}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          if (insert.canInsert) insert.begin([...e.dataTransfer.files]);
        }}
        onKeyDown={(e) => {
          /* The footer ADVERTISES these two, so they have to work — a hint for
             a shortcut that does nothing is the same defect as a dead button,
             one layer quieter. */
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save.save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // C6 layer 4: Esc inside a focused field belongs to the FIELD, so
            // it never also pops the panel stack underneath.
            e.stopPropagation();
            save.cancel();
          }
        }}
      />
      <InsertBar insert={insert} readOnly={readOnly} />
      <BlockStrip blocks={blocks} onOpenBlock={onOpenBlock} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// INSERT A FILE — upload, then write the reference where the caret was
// ---------------------------------------------------------------------------

interface FileInsert {
  canInsert: boolean;
  busy: readonly string[];
  error: string | null;
  begin(files: readonly File[]): void;
}

/**
 * ONE UPLOAD AT A TIME IS NOT ENFORCED, but the caret is read ONCE, before the
 * first upload starts, and each landed file advances it. Re-reading the live
 * selection per completion would scatter N images wherever the writer's cursor
 * happened to be N seconds later, in whatever order the network answered.
 */
function useFileInsert({
  save,
  attach,
  onAttached,
  area,
}: {
  save: DocSaveHandle;
  attach?: DocAttach;
  onAttached?: () => void;
  area: React.RefObject<HTMLTextAreaElement | null>;
}): FileInsert {
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canInsert = attach !== undefined && save.unavailable === null;

  const begin = (files: readonly File[]) => {
    if (!attach || files.length === 0 || save.unavailable !== null) return;
    setError(null);
    const el = area.current;
    /* The draft is read from the handle, never from the element: while clean
       the textarea shows the SERVED body, and splicing into a stale copy would
       drop every edit made since the last save. */
    let body = save.body;
    let caret = el ? el.selectionStart : body.length;
    let end = el ? el.selectionEnd : body.length;

    for (const file of files) {
      setBusy((current) => [...current, file.name]);
      void attach(file).result.then(
        (uploaded) => {
          const next = spliceInto(
            body,
            caret,
            end,
            fileReference(uploaded.name, uploaded.fileEntityId, uploaded.mime),
          );
          body = next.body;
          caret = next.caret;
          end = next.caret;
          save.edit({ body });
          setBusy((current) => current.filter((n) => n !== file.name));
          onAttached?.();
        },
        (cause: unknown) => {
          setBusy((current) => current.filter((n) => n !== file.name));
          const why = safeUploadReason(cause);
          if (why !== 'Upload cancelled.') setError(`${file.name} — ${why}`);
        },
      );
    }
  };

  return { canInsert, busy, error, begin };
}

function InsertBar({ insert, readOnly }: { insert: FileInsert; readOnly: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);

  /* L6 applies to the ABSENT-uploader case only. A read-only draft already
     says why it cannot be written to, at the save controls and in the source
     itself; a second refusal beside it would be noise, not honesty. */
  if (!insert.canInsert) {
    if (readOnly) return null;
    return (
      <div className="de-insert">
        <DisabledIconControl
          label="Insert a file into this document"
          reason={{
            cause: 'Uploading isn’t wired here',
            remedy: 'this editor was mounted without an attachment port',
          }}
        >
          ＋ Insert a file
        </DisabledIconControl>
      </div>
    );
  }

  return (
    <div className="de-insert" data-testid="doc-insert">
      <input
        ref={input}
        type="file"
        multiple
        className="de-insert__input"
        data-testid="doc-insert-input"
        onChange={(e) => {
          insert.begin([...(e.target.files ?? [])]);
          // Same file twice in a row must fire change twice.
          e.target.value = '';
        }}
      />
      <button type="button" className="de-btn de-btn--quiet" onClick={() => input.current?.click()}>
        ＋ Insert a file
      </button>
      <span className="de-insert__hint">
        {insert.busy.length > 0 ? `uploading ${insert.busy.join(', ')}…` : 'or drop one into the text'}
      </span>
      {insert.error ? (
        <span className="de-insert__why" role="alert">
          {insert.error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The fences this draft holds. Rendered even when there are none? No — an empty
 * strip states nothing, and L9 says an empty section must not tax the surface
 * it sits beside. The blocks are visible in the source text either way.
 */
function BlockStrip({
  blocks,
  onOpenBlock,
}: {
  blocks: readonly DocBlock[];
  onOpenBlock?: (block: DocBlock) => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="de-blocks" data-testid="doc-blocks">
      {blocks.map((block) => (
        <BlockChip key={`${block.line}`} block={block} onOpenBlock={onOpenBlock} />
      ))}
    </div>
  );
}

function BlockChip({ block, onOpenBlock }: { block: DocBlock; onOpenBlock?: (block: DocBlock) => void }) {
  const diagram = isDiagram(block);
  return (
    <span className="de-block" data-testid="doc-block-chip">
      <span className="de-block__glyph" aria-hidden>
        {block.lang === 'excalidraw' ? '✎' : '◆'}
      </span>
      <span className="de-block__label">{blockLabel(block)}</span>
      {!block.terminated ? (
        /* A fact about the text, not a failure of ours: an unterminated fence
           swallows everything after it, and the writer is the only one who can
           close it. Stated quietly rather than corrected behind their back. */
        <span className="de-block__note">fence not closed</span>
      ) : null}
      {onOpenBlock && diagram ? (
        <button
          type="button"
          className="de-block__open"
          data-testid="doc-block-open"
          onClick={() => onOpenBlock(block)}
        >
          open editor ⤢
        </button>
      ) : (
        <DisabledIconControl
          label={`Open the ${block.lang === '' ? 'code' : block.lang} editor`}
          reason={
            diagram
              ? {
                  cause: 'The block editor isn’t built yet',
                  remedy: 'T5-3 draws a full-bleed mermaid/excalidraw stage; no editor and no renderer ship in this build',
                }
              : {
                  cause: `No editor for a ${block.lang === '' ? 'plain' : block.lang} fence`,
                  remedy: 'only mermaid and excalidraw get their own stage; edit this one as text above',
                }
          }
        >
          open editor ⤢
        </DisabledIconControl>
      )}
    </span>
  );
}
