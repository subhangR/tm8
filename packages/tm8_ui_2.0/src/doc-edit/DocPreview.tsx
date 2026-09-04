import { Markdown, type MarkdownFileHref } from '../kit';

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
 * The old diagram placeholder is gone with it. A `mermaid` fence is DRAWN, by
 * `kit/Mermaid` — verified rendering on the deployed bundle 2026-08-31
 * (`phase="ok"`, a real 588×333 SVG, on the one document in the space that
 * contains a diagram). The sentence this replaces said no diagram renderer
 * shipped; one does, and the claim was stale rather than wrong when written.
 *
 * IT ALSO WEARS THE SAME `md-doc` STANCE AS THE READER, for the same reason it
 * shares the renderer: a preview set at a different size, leading or measure
 * from the surface it previews is a second opinion, not a preview.
 *
 * `blocks.readDraft` survives for the WRITE stance, which still needs the fence
 * chips to offer per-block editors — parsing for a control is a different job
 * from parsing for a rendering.
 */
export function DocPreview({
  source,
  testId = 'doc-preview',
  fileHref,
}: {
  source: string;
  testId?: string;
  /**
   * Resolves `![](tm8://file/<id>)` to bytes, from the host's attachment port.
   * Absent ⇒ an internal image states itself instead of rendering, which is
   * also what the reader does — the preview must not resolve an image the read
   * stance would refuse, or "what it will look like" stops being true.
   */
  fileHref?: MarkdownFileHref;
}) {
  if (source.trim() === '') {
    return (
      <div className="de-preview" data-testid={testId}>
        <p className="de-preview__empty">Nothing to preview yet — the draft is empty.</p>
      </div>
    );
  }

  return (
    <div className="de-preview" data-testid={testId}>
      <Markdown source={source} className="md-doc" testId={`${testId}-markdown`} fileHref={fileHref} />
    </div>
  );
}
