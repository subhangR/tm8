/**
 * PUTTING AN UPLOADED FILE INTO THE TEXT — the two pure decisions, kept out of
 * the component so they are testable without a DOM and without an upload.
 *
 * WHY AN INSERT AT ALL, when the attachment strip beneath the body already
 * uploads. The strip answers "what is attached to this entity"; it does not put
 * anything IN the document. A writer who wants a screenshot in the middle of a
 * paragraph had to upload it, then hand-write a `tm8://file/<uuid>` reference
 * with a UUID nothing in the UI showed them. That is not a feature with a rough
 * edge, it is a feature nobody can use.
 *
 * BOTH PATHS PRODUCE THE SAME EDGE. The insert rides `startUpload`, which is
 * the same canonical grant lifecycle the strip uses and attaches to the same
 * anchor — so an inserted image is also a listed attachment, with one
 * `attached_to` edge, not two records of the same fact.
 */

/**
 * The markdown one file deserves.
 *
 * IMAGE ⇒ `![alt](…)`, everything else ⇒ a plain link. A PDF written as an
 * image reference renders as `Markdown`'s broken-image chip, which reads as
 * "this file is broken" rather than "this is not a picture" — the same
 * distinction the attachment strip's `canThumbnail` draws, one layer up.
 *
 * `image/svg+xml` is deliberately NOT special-cased here. The reference is
 * correct either way; whether the bytes are shown inline is `Markdown`'s
 * decision and the server's, and duplicating that rule in a text generator is
 * how the two copies come to disagree.
 */
export function fileReference(name: string, fileEntityId: string, mime: string): string {
  const label = escapeLabel(name.trim() === '' ? 'file' : name);
  const target = `tm8://file/${encodeURIComponent(fileEntityId)}`;
  return /^image\//i.test(mime.trim()) ? `![${label}](${target})` : `[${label}](${target})`;
}

/**
 * `]` closes a markdown label early, so a file called `a]b.png` would otherwise
 * produce a reference that renders as literal text with the URL beside it.
 * Backslash-escaping is CommonMark's own answer.
 */
function escapeLabel(name: string): string {
  return name.replace(/([[\]\\])/g, '\\$1');
}

/**
 * The splice, and where the caret lands after it.
 *
 * Returned rather than applied so the caller can set both the draft and the
 * selection in one place — a caret left at its old offset after text was
 * inserted before it is a cursor that has silently moved in the document.
 *
 * `start`/`end` come from the textarea's own selection, so a selection is
 * REPLACED (the ordinary editor behaviour) rather than being left beside the
 * new text.
 */
export function spliceInto(
  source: string,
  start: number,
  end: number,
  text: string,
): { body: string; caret: number } {
  const from = Math.max(0, Math.min(start, source.length));
  const to = Math.max(from, Math.min(end, source.length));
  /*
   * A block-level image glued onto the end of a sentence renders INSIDE that
   * paragraph. Padding is added only where the neighbouring character is not
   * already a newline, so an insert into an empty line stays a single line.
   */
  const before = source.slice(0, from);
  const after = source.slice(to);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n\n';
  const piece = `${lead}${text}${trail}`;
  return { body: `${before}${piece}${after}`, caret: from + piece.length };
}
