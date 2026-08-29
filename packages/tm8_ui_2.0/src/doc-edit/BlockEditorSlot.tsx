import { DisabledAction, DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import { blockLabel, isDiagram, type DocBlock } from './blocks';

/**
 * T5-3 FRAME 2b — THE FULL-BLEED BLOCK EDITOR (oracle lines 175-189).
 *
 * IT IS DRAWN, AND IT IS HONEST. The oracle gives mermaid and excalidraw the
 * whole stage: a source pane beside a live render, `⇲ back to doc`, and an
 * `Apply to draft` that writes into the OPEN DRAFT rather than the document.
 * None of that can work today — the package has no mermaid renderer, no
 * excalidraw canvas, and no block-editor surface — so the question is only
 * whether the user learns the feature exists.
 *
 * R7 answers it: never hidden, never live-and-inert. The stage renders with its
 * real anatomy, the diagram area states that nothing rendered it, and both
 * verbs carry their reason. What is NOT drawn is the tool palette (line 187):
 * three tool buttons for a canvas that does not exist would be three more dead
 * controls, and the stage already states the absence once.
 *
 * `onApply` EXISTS IN THE SIGNATURE ON PURPOSE. When a real block editor
 * arrives it hands back edited source and this component becomes live with no
 * change at its call site — and until then the structural check (is there a
 * handler?) is what keeps the honesty from drifting out of sync with the wiring.
 */
export function BlockEditorSlot({
  block,
  onApply,
  onBack,
}: {
  block: DocBlock;
  /** Writes back into the OPEN DRAFT, never the document (annotation, line 190). */
  onApply?: (block: DocBlock, source: string) => void;
  onBack?: () => void;
}) {
  return (
    <div className="de-blockstage" data-testid="doc-block-editor">
      <div className="de-blockstage__bar">
        {onBack ? (
          <button type="button" className="de-btn de-btn--quiet" data-testid="doc-block-back" onClick={onBack}>
            ⇲ back to doc
          </button>
        ) : (
          <DisabledIconControl
            label="Back to the document"
            reason={{
              cause: 'Back isn’t connected here',
              remedy: 'this stage was mounted without a return dispatch',
            }}
          >
            ⇲ back to doc
          </DisabledIconControl>
        )}
        <span className="de-blockstage__label">
          <span aria-hidden>{block.lang === 'excalidraw' ? '✎' : '◆'}</span> {blockLabel(block)}
        </span>
        <span className="de-bar__spacer" />
        {onApply ? (
          <button
            type="button"
            className="de-btn de-btn--primary"
            data-testid="doc-block-apply"
            onClick={() => onApply(block, block.source)}
          >
            Apply to draft
          </button>
        ) : (
          <DisabledAction
            label="Apply to draft"
            reason={{
              cause: 'Nothing to apply — this block cannot be edited yet',
              remedy: 'the mermaid/excalidraw stage is drawn but not built; the doc itself still saves normally',
            }}
          >
            Apply to draft
          </DisabledAction>
        )}
      </div>

      <div className="de-blockstage__panes">
        <pre className="de-blockstage__source" data-testid="doc-block-source">
          {block.source}
        </pre>
        <div className="de-blockstage__canvas" data-testid="doc-block-canvas">
          <span className="de-blockstage__note">
            {isDiagram(block)
              ? `no ${block.lang} renderer ships in this build — the source beside this is the whole truth`
              : 'nothing renders a plain fence — the source beside this is the whole truth'}
          </span>
        </div>
      </div>
    </div>
  );
}
