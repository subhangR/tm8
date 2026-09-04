import { useRef } from 'react';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import type { FileUploadTask } from '../files/upload';
import { skillReference, TriggerPopover, useRichInput, type TriggerOption } from '../rich-input';
import { blockLabel, blocksIn, isDiagram, type DocBlock } from './blocks';
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
 *
 * SINCE THE RICH-INPUT LIFT: upload-then-insert-at-caret (previously the
 * local `useFileInsert`), file PASTE (new — drop never implied paste until
 * now), and the `/` skill reference popover all ride `useRichInput` with the
 * caret placement (R4: prose inserts at the caret). The timing rules the old
 * hook proved — body read at resolution, caret read once and advanced per
 * landed file, the post-render caret effect — moved with it, not re-solved.
 */
export function DocSource({
  save,
  onOpenBlock,
  label = 'Document source',
  attach,
  onAttached,
  skillOptions,
}: {
  save: DocSaveHandle;
  /** Absent ⇒ every block's editor entry is disabled-with-reason. */
  onOpenBlock?: (block: DocBlock) => void;
  label?: string;
  /** Absent ⇒ the insert control is not drawn. See `DocAttach`. */
  attach?: DocAttach;
  /** An upload landed, so the host can refetch the anchor's attachment list. */
  onAttached?: () => void;
  /** Skills `/` can reference (R1). Absent ⇒ `/` types plain text. */
  skillOptions?: readonly TriggerOption[];
}) {
  const readOnly = save.unavailable !== null;
  const blocks = blocksIn(save.body);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const canInsert = attach !== undefined && save.unavailable === null;

  /* The handle is re-created every render; a promise callback holds the one
     from the render it was created in. This ref is what makes "read at
     resolution" actually read the CURRENT handle rather than a stale one. */
  const handle = useRef(save);
  handle.current = save;

  const rich = useRichInput({
    value: save.body,
    onChange: (next) => save.edit({ body: next }),
    areaRef: area,
    triggers: [{
      sigil: '/',
      options: skillOptions,
      onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
    }],
    attachments: {
      /* Withheld while read-only for the same reason the old hook guarded
         `begin`: an upload that resolves into an uneditable draft would write
         through `edit()` on a document that refuses edits. */
      start: canInsert ? attach : undefined,
      placement: {
        mode: 'caret',
        liveText: () => handle.current.liveBody(),
        setText: (body) => handle.current.edit({ body }),
        ...(onAttached ? { onInserted: onAttached } : {}),
      },
    },
    onKeyDown: (e) => {
      /* The footer ADVERTISES these two, so they have to work — a hint for
         a shortcut that does nothing is the same defect as a dead button,
         one layer quieter. */
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save.save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // C6 layer 4: Esc inside a focused field belongs to the FIELD, so
        // it never also pops the panel stack underneath. (With the skill
        // popover open, the hook already consumed Esc to close it.)
        e.stopPropagation();
        save.cancel();
      }
    },
  });
  const attachments = rich.attachments!;

  return (
    <div className="de-source">
      <div className="ri-host">
        <textarea
          ref={area}
          className="de-source__area"
          data-testid="doc-source"
          aria-label={label}
          value={save.body}
          readOnly={readOnly}
          spellCheck={false}
          {...rich.areaProps}
        />
        <TriggerPopover
          popover={rich.popover}
          label="Available skills"
          renderOption={(option) => (
            <>
              <span className="ri-popover__name">{`/${option.display}`}</span>
              {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
            </>
          )}
          emptyText="No matching skills"
        />
      </div>
      <InsertBar
        canInsert={canInsert}
        busy={attachments.busy}
        error={attachments.error ?? attachments.refusal}
        begin={attachments.addFiles}
        readOnly={readOnly}
      />
      <BlockStrip blocks={blocks} onOpenBlock={onOpenBlock} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// INSERT A FILE — upload, then write the reference where the caret was
// ---------------------------------------------------------------------------

function InsertBar({
  canInsert,
  busy,
  error,
  begin,
  readOnly,
}: {
  canInsert: boolean;
  busy: readonly string[];
  error: string | null;
  begin(files: readonly File[]): void;
  readOnly: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  /* L6 applies to the ABSENT-uploader case only. A read-only draft already
     says why it cannot be written to, at the save controls and in the source
     itself; a second refusal beside it would be noise, not honesty. */
  if (!canInsert) {
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
          + Insert a file
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
          begin([...(e.target.files ?? [])]);
          // Same file twice in a row must fire change twice.
          e.target.value = '';
        }}
      />
      <button type="button" className="de-btn de-btn--quiet" onClick={() => input.current?.click()}>
        + Insert a file
      </button>
      <span className="de-insert__hint">
        {busy.length > 0 ? `uploading ${busy.join(', ')}…` : 'or drop or paste one into the text'}
      </span>
      {error ? (
        <span className="de-insert__why" role="alert">
          {error}
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
