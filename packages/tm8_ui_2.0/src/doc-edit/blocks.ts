/**
 * THE DRAFT PARSER — the shapes T5-3 actually draws, and nothing else.
 *
 * Two consumers, ONE pass: the write stance needs the fenced blocks (to draw
 * them as chips) and the preview stance needs the whole document (headings,
 * quotes, prose, and those same blocks in place). Parsing twice is how the two
 * stances drift into disagreeing about the same text.
 *
 * THIS IS NOT A MARKDOWN RENDERER and does not claim to be one. It is the four
 * shapes the oracle's own columns draw (line 102-111: heading, prose, quote,
 * fence chip). A doc whose format is not markdown still lands here and reads as
 * prose, which is the honest floor — unstyled real text beats "cannot render".
 *
 * RELATION TO `panels/bodies/ReaderBody.tsx`'s `readDocument`. Same family,
 * deliberately NOT the same function, and this is a stated duplication rather
 * than an accident. Two real differences: the reader PROMOTES headings out of
 * the column into its outline, while an editor preview must show them where
 * they are; and the reader has no fence concept at all. Sharing would need
 * `readDocument` exported from `panels/`, which is not this lane's file to
 * edit — so the handover carries a D-entry proposing exactly that, and until
 * it lands the divergence is named here rather than left for someone to find.
 */

export interface DocBlock {
  /** Fence info word 1, lowercased. `''` for a bare ``` fence. */
  lang: string;
  /** The rest of the fence info string — the oracle's `breakpoint-cascade`. */
  name: string | null;
  /** The fenced text itself, verbatim, newline-joined. */
  source: string;
  /** 0-based line of the opening fence in the draft. Stable identity for a key. */
  line: number;
  /**
   * MEASURED, not inferred: how many non-empty lines the fence holds.
   *
   * The oracle's chip reads `8 nodes` (line 107). We do not parse mermaid, so
   * a node count here would be a claim rather than a measurement — the exact
   * move D39 calls a defect class. A line count is a fact we actually hold, so
   * that is what the chip says. Recorded as DRIFT in the handover.
   */
  lines: number;
  /** Closed by a matching fence. An unterminated fence is still a block. */
  terminated: boolean;
}

/**
 * The languages the oracle gives a full-bleed editor to (F2b, lines 175-189).
 * Any other fence is code: it still renders as a chip so the surrounding text
 * stays editable text, but it advertises no diagram editor it does not have.
 */
const DIAGRAM_LANGS: ReadonlySet<string> = new Set(['mermaid', 'excalidraw']);

export function isDiagram(block: DocBlock): boolean {
  return DIAGRAM_LANGS.has(block.lang);
}

/** The chip's own words: `mermaid · breakpoint-cascade · 3 lines`. */
export function blockLabel(block: DocBlock): string {
  const parts = [block.lang === '' ? 'code' : block.lang];
  if (block.name) parts.push(block.name);
  parts.push(`${block.lines} ${block.lines === 1 ? 'line' : 'lines'}`);
  return parts.join(' · ');
}

export type DocSegment =
  | { type: 'heading'; text: string; level: number }
  | { type: 'prose'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'block'; block: DocBlock };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const QUOTE = /^>\s?(.*)$/;

export function readDraft(source: string): DocSegment[] {
  const segments: DocSegment[] = [];
  const lines = source.split('\n');

  let buffer: string[] = [];
  let mode: 'prose' | 'quote' | null = null;
  let open: { lang: string; name: string | null; line: number; body: string[] } | null = null;

  const flush = () => {
    if (mode !== null && buffer.length > 0) segments.push({ type: mode, text: buffer.join(' ') });
    buffer = [];
    mode = null;
  };

  const closeFence = (terminated: boolean) => {
    if (open === null) return;
    const body = open.body;
    segments.push({
      type: 'block',
      block: {
        lang: open.lang,
        name: open.name,
        source: body.join('\n'),
        line: open.line,
        lines: body.filter((l) => l.trim() !== '').length,
        terminated,
      },
    });
    open = null;
  };

  lines.forEach((raw, i) => {
    const fence = FENCE.exec(raw);
    if (fence) {
      if (open === null) {
        flush();
        const info = fence[1].trim();
        const [lang, ...rest] = info.split(/\s+/).filter((w) => w !== '');
        open = { lang: (lang ?? '').toLowerCase(), name: rest.join(' ') || null, line: i, body: [] };
      } else {
        closeFence(true);
      }
      return;
    }
    if (open !== null) {
      open.body.push(raw);
      return;
    }

    const line = raw.trim();
    if (line === '') {
      flush();
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      segments.push({ type: 'heading', text: heading[2].trim(), level: heading[1].length });
      return;
    }
    const quoted = QUOTE.exec(line);
    const next = quoted ? 'quote' : 'prose';
    if (mode !== null && mode !== next) flush();
    mode = next;
    buffer.push(quoted ? quoted[1].trim() : line);
  });

  // An unterminated fence is a real state a person types their way into; it is
  // reported as a block that says so rather than swallowing the rest of the doc.
  closeFence(false);
  flush();
  return segments;
}

export function blocksIn(source: string): DocBlock[] {
  return readDraft(source)
    .filter((s): s is Extract<DocSegment, { type: 'block' }> => s.type === 'block')
    .map((s) => s.block);
}
