import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import { blockLabel, blocksIn, isDiagram, type DocBlock } from './blocks';
import type { DocSaveHandle } from './useDocSave';

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
}: {
  save: DocSaveHandle;
  /** Absent ⇒ every block's editor entry is disabled-with-reason. */
  onOpenBlock?: (block: DocBlock) => void;
  label?: string;
}) {
  const readOnly = save.unavailable !== null;
  const blocks = blocksIn(save.body);

  return (
    <div className="de-source">
      <textarea
        className="de-source__area"
        data-testid="doc-source"
        aria-label={label}
        value={save.body}
        readOnly={readOnly}
        spellCheck={false}
        onChange={(e) => save.edit({ body: e.target.value })}
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
      <BlockStrip blocks={blocks} onOpenBlock={onOpenBlock} />
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
