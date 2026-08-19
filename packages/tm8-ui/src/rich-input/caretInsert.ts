/**
 * PUTTING AN UPLOADED FILE INTO TEXT — the two pure decisions, kept out of
 * the hook so they are testable without a DOM and without an upload.
 *
 * PROVENANCE: `doc-edit/insert.ts`, re-homed verbatim. R4 makes caret
 * placement one of the primitive's two placements (prose inserts at the
 * caret, chat stages a chip), so the splice and the reference grammar belong
 * to the shared lane; the doc editor now imports them from here. Nothing
 * changed in the move — the comments below are the original author's, and
 * they are load-bearing.
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
 * How the inserted text is separated from what surrounds it.
 *
 * `'block'` — a blank line either side, which is what a markdown draft needs:
 * a block-level image glued onto the end of a sentence renders INSIDE that
 * paragraph.
 *
 * `'inline'` — a single space, AND NEVER A NEWLINE. This exists for the
 * destination the transcript composer writes to: a PTY prompt, where the draft
 * is one line someone is still composing and a newline in it is a SUBMIT. The
 * terminal's own paste path has always injected `path + ' '` for exactly this
 * reason (`LiveTerminal`'s `injectFiles`), and a shared splice that could only
 * emit `\n\n` is a splice that surface could not use.
 */
export type SpliceSeparator = 'block' | 'inline';

/**
 * The splice, and where the caret lands after it.
 *
 * Returned rather than applied so the caller can apply both the draft and the
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
  separator: SpliceSeparator = 'block',
): { body: string; caret: number } {
  const from = Math.max(0, Math.min(start, source.length));
  const to = Math.max(from, Math.min(end, source.length));
  /*
   * Padding is added only where the neighbour does not already supply it, so
   * an insert into an empty line stays a single line — and, in `inline` mode,
   * a path dropped after a space does not get a second one.
   */
  const before = source.slice(0, from);
  const after = source.slice(to);
  const pad = separator === 'block' ? '\n\n' : ' ';
  const has = separator === 'block'
    ? { lead: (s: string) => s.endsWith('\n'), trail: (s: string) => s.startsWith('\n') }
    : { lead: (s: string) => /\s$/.test(s), trail: (s: string) => /^\s/.test(s) };
  const lead = before === '' || has.lead(before) ? '' : pad;
  /* `inline` ALWAYS lays down its trailing space, even at the end of the
     draft, so the writer's next word does not fuse onto the path. `block`
     keeps its original rule: a trailing blank line at the end of a document is
     noise nobody asked for. */
  const trail = separator === 'inline'
    ? (has.trail(after) ? '' : pad)
    : (after === '' || has.trail(after) ? '' : pad);
  const piece = `${lead}${text}${trail}`;
  return { body: `${before}${piece}${after}`, caret: from + piece.length };
}
