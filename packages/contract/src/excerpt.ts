/**
 * Excerpt derivation — the ONE place a prose body becomes a one-line preview.
 *
 * WHY THIS IS SHARED. Two implementations derive previews from the same bodies
 * and have to agree: `facade/entity-read.ts` (`EntitySummary.excerpt`, 200
 * chars) and the CLI's `message list` renderer (72 chars). `events/projector.ts`
 * states the rule in as many words — widening the gap by patching only one
 * implementation is worse than the gap. Two different CAPS are fine and
 * intended; two different stripping RULES are drift a user can see. So the rule
 * lives once, in the only package both sides already import.
 *
 * WHY STRIP AT ALL. Agents write markdown, and for a message the excerpt IS the
 * title. Every list row, board card, notification and `tm8 message list` line
 * was therefore spending its character budget on `**`, `##` and backticks
 * instead of on words, and truncating the words away to make room.
 *
 * WHAT THIS IS NOT, and must never become:
 * - Not a markdown parser. It deletes markup so the cap is spent on prose; it
 *   does not build a tree and it does not need to be exact.
 * - Not a renderer, and not a producer of markup. Output is plain text, never
 *   HTML. Rendering belongs to the UI's `kit/Markdown`.
 * - Never a pre-step to rendering. A TRUNCATED excerpt must not be routed
 *   through a markdown renderer: a body cut mid-fence leaves an unterminated
 *   fence that swallows everything after it. Excerpts are stripped, not
 *   rendered.
 */

/**
 * Remove markdown markup, preserving the words and the line structure.
 *
 * Order matters throughout: block markers are anchored to line starts and so
 * must run before whitespace is flattened, images must run before links, and
 * longer emphasis delimiters must run before shorter ones.
 */
export function stripMarkdown(body: string): string {
  return (
    body
      // Fence delimiters go; the code between them is words, and stays.
      .replace(/^[ \t]*(?:```|~~~).*$/gm, '')
      // Table delimiter rows (`|---|:--:|`) are the one line with no words on it.
      .replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/gm, '')
      // Every other table row keeps its cells; only the pipes go.
      .replace(/^[ \t]*\|.*$/gm, (row) => row.replace(/\|/g, ' '))
      // Thematic breaks and setext underlines are pure decoration.
      .replace(/^[ \t]*(?:(?:[-*_][ \t]*){3,}|=+[ \t]*)$/gm, '')
      // ATX headings.
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      // Blockquote markers, however deeply nested.
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
      // Bullet and ordered list markers, then a task checkbox if one follows.
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '')
      .replace(/^\[[ xX]\][ \t]+/gm, '')
      // Images before links: an image's alt text is the only part worth keeping.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // An autolink's URL is its whole content.
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      // Inline code.
      .replace(/`+([^`]+)`+/g, '$1')
      // Emphasis, longest delimiter first. The single-character forms require a
      // non-space next to each delimiter, which is what keeps `2 * 3 * 4` and
      // `snake_case_name` intact.
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*(?![\s*])([^*\n]*?)(?<![\s*])\*/g, '$1')
      .replace(/(?<![\w\\])__([^_]+)__(?!\w)/g, '$1')
      .replace(/(?<![\w\\])_(?![\s_])([^_\n]*?)(?<![\s_])_(?!\w)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      // Backslash escapes were markup too: `\*` was always meant to read `*`.
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
  );
}

/**
 * A one-line, markup-free preview of `body`, at most `max` characters including
 * the ellipsis.
 *
 * Stripping runs BEFORE the cap, which is the entire point: the budget is spent
 * on words rather than on syntax that was going to be truncated away.
 *
 * A body made of nothing but markup — a lone thematic break, an empty fence —
 * strips to nothing, and a row with no label at all is worse than a row
 * labelled with punctuation. Such a body falls back to the flattened original,
 * so this never yields less than flattening alone did.
 */
export function plainExcerpt(body: string, max: number): string {
  const flat = flatten(stripMarkdown(body)) || flatten(body);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
