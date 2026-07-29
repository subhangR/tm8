import { blockLabel, isDiagram, readDraft } from './blocks';

/**
 * THE PREVIEW STANCE — what the draft will read as, rendered from the DRAFT and
 * never from the served body. That is the whole point of a preview and it is
 * also the easy bug: reading `detail.content.body` here would show the last
 * SAVED text under a label that says "Preview", which is a confident lie.
 *
 * FOUR SHAPES, the ones `blocks.readDraft` parses and the ones T5-3's preview
 * pane actually draws (lines 163-166): heading, prose, quote, block.
 *
 * A DIAGRAM IS NOT RENDERED, AND THE PLACEHOLDER SAYS SO. The oracle draws a
 * hatched panel captioned "mermaid render · flowchart · 8 nodes" — that is a
 * drawing of a renderer we do not have. Drawing the hatch WITHOUT the sentence
 * would leave a reader believing the diagram failed to load rather than that
 * nothing was ever asked to load it. So the placeholder states the absence and
 * names the block, which is every fact we actually hold. GAP G2.
 */
export function DocPreview({ source, testId = 'doc-preview' }: { source: string; testId?: string }) {
  const segments = readDraft(source);

  if (segments.length === 0) {
    return (
      <div className="de-preview" data-testid={testId}>
        <p className="de-preview__empty">Nothing to preview yet — the draft is empty.</p>
      </div>
    );
  }

  return (
    <div className="de-preview" data-testid={testId}>
      {segments.map((segment, i) => {
        if (segment.type === 'heading') {
          return (
            <p className="de-preview__heading" data-testid="doc-preview-heading" key={i}>
              {segment.text}
            </p>
          );
        }
        if (segment.type === 'quote') {
          return (
            <blockquote className="de-preview__quote" data-testid="doc-preview-quote" key={i}>
              {segment.text}
            </blockquote>
          );
        }
        if (segment.type === 'block') {
          const { block } = segment;
          return (
            <div className="de-preview__block" data-testid="doc-preview-block" key={i}>
              <span className="de-preview__block-label">{blockLabel(block)}</span>
              <span className="de-preview__block-note">
                {isDiagram(block)
                  ? 'not rendered — no diagram renderer ships in this build'
                  : 'not rendered — shown as written'}
              </span>
            </div>
          );
        }
        return (
          <p className="de-preview__prose" data-testid="doc-preview-prose" key={i}>
            {segment.text}
          </p>
        );
      })}
    </div>
  );
}
