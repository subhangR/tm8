import { Markdown } from '../kit';

/**
 * THE PREVIEW STANCE — what the draft will read as, rendered from the DRAFT and
 * never from the served body. That is the whole point of a preview and it is
 * also the easy bug: reading `detail.content.body` here would show the last
 * SAVED text under a label that says "Preview", which is a confident lie.
 *
 * IT RENDERS THROUGH THE SAME `Markdown` AS THE READER (user ruling
 * 2026-07-31). Previously this drew its own four shapes — headings as plain
 * `<p>`, and every fenced block as a placeholder captioned "not rendered". A
 * preview that renders differently from the reader is not a preview; it is a
 * second opinion. One renderer is what makes "what it will look like" true.
 *
 * The old diagram placeholder is gone with it. A `mermaid` fence now shows its
 * real source in a labelled code block, which claims nothing: no diagram
 * renderer ships, and the source says that more honestly than a hatched panel
 * captioned with a node count nobody measured (the previous GAP G2).
 *
 * `blocks.readDraft` survives for the WRITE stance, which still needs the fence
 * chips to offer per-block editors — parsing for a control is a different job
 * from parsing for a rendering.
 */
export function DocPreview({ source, testId = 'doc-preview' }: { source: string; testId?: string }) {
  if (source.trim() === '') {
    return (
      <div className="de-preview" data-testid={testId}>
        <p className="de-preview__empty">Nothing to preview yet — the draft is empty.</p>
      </div>
    );
  }

  return (
    <div className="de-preview" data-testid={testId}>
      <Markdown source={source} testId={`${testId}-markdown`} />
    </div>
  );
}
