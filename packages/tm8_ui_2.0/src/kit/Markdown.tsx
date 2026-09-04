import type { ComponentPropsWithoutRef, ComponentType } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './Mermaid';
import { VectorIcon } from './VectorIcon';
// Imported HERE rather than by the app bootstrap so any surface that renders
// markdown gets its vocabulary with it, and none can end up half-styled.
import './markdown.css';

/**
 * THE MARKDOWN RENDERER — one implementation, every doc surface.
 *
 * WHY THIS REPLACED THE HAND-ROLLED PARSERS. `panels/bodies/ReaderBody`'s
 * `readDocument` and `doc-edit/blocks`'s `readDraft` each recognised exactly
 * four shapes (heading, quote, prose, fence) and said so in their own comments:
 * "this is not a markdown renderer and does not claim to be one". That was an
 * honest floor while nothing better was wired, but the floor showed: a doc's
 * lists came out as one run-on paragraph, `**bold**` rendered as literal
 * asterisks, tables collapsed into pipes, and a code fence rendered as a chip
 * captioned "not rendered". Docs are markdown — `docFormatOf` reads the format
 * off the record and every fixture says `markdown`. So the renderer is real
 * now, and the two parsers keep only the job they were actually good at:
 * pulling an OUTLINE out of the headings.
 *
 * COMMONMARK + GFM, via `react-markdown` + `remark-gfm` — the same pair the
 * legacy `packages/ui` oracle already renders its markdown with, so this is a
 * dependency the monorepo had already accepted rather than a new one. Tables,
 * task lists, strikethrough and autolinks come from GFM; the rest is
 * CommonMark. Nothing is hand-parsed here, which is the point: every shape we
 * previously got wrong we now get wrong only if upstream does.
 *
 * SAFETY. `react-markdown` does NOT render raw HTML unless `rehype-raw` is
 * added, and it deliberately is not. A doc body is viewer-authored text that
 * other members read, so an embedded `<script>` or `<img onerror>` would be
 * stored XSS against everyone in the space. The safe default is load-bearing —
 * do not add `rehype-raw` here without an actual sanitiser beside it.
 *
 * LINKS OPEN OUT. A markdown link in a doc points at the wider web, so it
 * carries `rel="noreferrer noopener"` and a new tab — an in-place navigation
 * would replace the whole app, unsaved drafts and all.
 *
 * IMAGES DO NOT. A link is a click the READER chooses to make; an `<img src>`
 * is a request the reader's browser makes for them, silently, on open. See the
 * `img` override below for why that difference is load-bearing here.
 */

/**
 * How this renderer turns a tm8 file reference into a URL it may actually load.
 *
 * Structurally identical to `files/FilesScreen`'s `DownloadHref`, and declared
 * here rather than imported from it because `kit` is the base layer and must
 * not depend on a screen. A host that already has that resolver passes the same
 * function to both.
 */
export type MarkdownFileHref = (fileEntityId: string) => string | null;

/**
 * The file entity a markdown image src names, or `null` if it names none.
 *
 * Two spellings are internal, and both mean the same thing: `tm8://file/<id>`
 * is what an author writes, and `/v2/files/<id>/download` is the transport form
 * of the same reference (`files.download`, contract-v1) that a paste from the
 * files screen produces. Anything else — including a same-origin-looking
 * absolute URL — is treated as remote, because "looks like our path" is not a
 * proof of origin and this decision is the one guarding the request below.
 */
/**
 * `decodeURIComponent` THROWS a `URIError` on a malformed escape — `%zz`, or a
 * lone `%` at the end. A doc body is arbitrary text a person typed, so
 * `![](tm8://file/%zz)` is reachable input, and an uncaught throw here happens
 * during RENDER: it takes down the whole markdown subtree rather than one
 * image. A reference we cannot decode is simply not a file reference, which is
 * what `null` already means everywhere else in this function.
 */
function decodeRef(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function fileRefIn(src: string): string | null {
  const scheme = /^tm8:\/\/file\/([^/?#]+)$/.exec(src.trim());
  if (scheme) return decodeRef(scheme[1]);
  const path = /^\/v2\/files\/([^/?#]+)\/download$/.exec(src.trim());
  if (path) return decodeRef(path[1]);
  return null;
}

/**
 * `react-markdown` blanks any URL whose scheme is not on its allow-list, which
 * is exactly the right default for an `href` — it is what keeps `javascript:`
 * out of a link — but it would blank `tm8://` and `data:` on an image `src`
 * before the `img` override below ever saw them, leaving the override unable to
 * tell an internal reference from a hostile one.
 *
 * So the allow-list is widened for IMAGE SOURCES ONLY, and only to the two
 * schemes the override then decides about itself (`tm8:` renders, `data:` is
 * refused). Every `href` keeps upstream's default untouched. The narrowness is
 * the point: this function must never become the place a `javascript:` URL
 * survives.
 */
function urlTransform(url: string, key: string, node: { tagName?: string }): string | null {
  if (key === 'src' && node.tagName === 'img' && /^(tm8|data):/i.test(url.trim())) return url;
  return defaultUrlTransform(url);
}

/* ==========================================================================
   CALLOUTS — the one structure real documents in this space were already
   writing and the renderer had no word for.

   THE MEASUREMENT THAT PRODUCED THIS (2026-08-31, 40 docs read out of the live
   space): not one document used `> [!NOTE]`, and several were using a plain
   blockquote to carry a warning that is not a quotation at all. `DESIGN 1 —
   Harness registry` opens with

       > **STATUS BANNER — added 22 Aug 2026 during the build of this task.**
       > **Every count in §1 is stale.** … nothing below should be trusted

   which rendered as grey ITALIC text behind a 2px hairline — visually
   identical to someone being quoted, and set in the least legible face in the
   sheet for the twelve lines it runs to. The author had no other vocabulary.
   Zero alert usage is therefore evidence of a MISSING FEATURE, not of an
   unwanted one: nobody writes syntax that renders as nothing.

   GitHub's spelling is the one adopted rather than an invented one, because it
   is the spelling every author here has already seen, and because a document
   written for tm8 should not read as broken anywhere else. `remark-gfm` does
   NOT implement alerts — they are a GitHub extension on top of GFM — so the
   transform below is ours, and it is deliberately a REMARK plugin rather than
   a component that sniffs its own children: at mdast the marker is one text
   node we can delete, and after render it is a string spliced through
   React children that cannot be edited without re-implementing the parser.

   THE TONE IS THE MEANING. Five tones, each bound to the token the rest of the
   package already uses for that state — info, run, brand, wait, block — so the
   colour of a callout answers "what kind of callout is this" before a word is
   read. There is no sixth tone and no author-chosen colour: colour that can be
   picked is decoration, and decoration is what the ruling above bans.
   ========================================================================== */

/** The five GitHub alert kinds, in GitHub's own order of escalation. */
const CALLOUT_TONES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
type CalloutTone = (typeof CALLOUT_TONES)[number];

/** The word the callout wears. Capitalised prose, not a shouted token. */
const CALLOUT_WORD: Record<CalloutTone, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

/**
 * The mark, as GEOMETRY on `VectorIcon`'s 16×16 grid — not a text character
 * and not an emoji.
 *
 * This is the package's standing ruling applied ("a glyph must mean something")
 * plus `VectorIcon`'s own argument: at 14px a run of pictographic characters
 * lands on five different optical baselines and half of them resolve to the
 * same blob. Each mark here carries exactly one fact — WHICH of the five kinds
 * this callout is — which is the same fact the tone colour carries, said again
 * for a reader who cannot separate the hues.
 */
const CALLOUT_ART: Record<CalloutTone, readonly string[]> = {
  // an i in a circle
  note: ['M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Z', 'M8 7.4v3.6', 'M8 5h.01'],
  // a lamp over its base
  tip: ['M8 1.7a4.1 4.1 0 0 0-2.5 7.4c.4.3.6.8.6 1.3h3.8c0-.5.2-1 .6-1.3A4.1 4.1 0 0 0 8 1.7Z', 'M6.3 12.4h3.4', 'M6.9 14.2h2.2'],
  // a bookmark — this is the part to keep
  important: ['M4.2 2.2h7.6v11.6L8 11.1l-3.8 2.7V2.2Z'],
  // a triangle with a bang
  warning: ['M8 2.1 1.5 13.5h13L8 2.1Z', 'M8 6.3v3.3', 'M8 11.5h.01'],
  // an octagon with a bang — the stop sign, not a second triangle
  caution: ['M5.7 1.8h4.6L14.2 5.7v4.6L10.3 14.2H5.7L1.8 10.3V5.7L5.7 1.8Z', 'M8 5.1v3.5', 'M8 10.8h.01'],
};

/** `[!NOTE]` on the blockquote's first line, with the line ending it owns. */
const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

/**
 * The mdast shapes this transform touches. Declared locally rather than
 * imported from `@types/mdast` because the plugin needs exactly four fields and
 * a structural type keeps `kit` free of a types-only dependency it would
 * otherwise carry into every consumer's build.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/**
 * THE TONE RIDES IN THE CLASS, NOT IN A `data-` ATTRIBUTE, and that is a
 * correctness choice rather than a style one. `hProperties` is copied to hast
 * verbatim, and how a `data-*` key survives the hast → JSX hop is an
 * implementation detail of two libraries below us. `className` is the one
 * property whose journey is specified end to end and typed on the component
 * that receives it, so the override below can read the tone back without
 * guessing. The `data-tone` the CSS actually keys on is written by us, in JSX,
 * where it cannot be normalised away.
 */
function remarkCallouts() {
  return (tree: MdNode) => {
    visitBlockquotes(tree);
  };
}

function visitBlockquotes(node: MdNode) {
  const kids = node.children;
  if (kids === undefined) return;
  for (const kid of kids) {
    if (kid.type === 'blockquote') markCallout(kid);
    visitBlockquotes(kid);
  }
}

function markCallout(quote: MdNode) {
  const para = quote.children?.[0];
  if (para === undefined || para.type !== 'paragraph') return;
  const lead = para.children?.[0];
  if (lead === undefined || lead.type !== 'text' || typeof lead.value !== 'string') return;
  const match = CALLOUT_MARKER.exec(lead.value);
  if (match === null) return;
  const tone = match[1].toLowerCase();

  /* The marker is REMOVED, not hidden. Leaving `[!NOTE]` in the rendered text
     under a heading that already says "Note" is the placeholder problem in
     miniature: the reader is shown the syntax and the thing it produced. */
  lead.value = lead.value.slice(match[0].length);
  if (lead.value === '' && para.children !== undefined) {
    para.children.shift();
    /* `> [!NOTE]␠␠` + a body line is a HARD break, which survives as its own
       node; with the marker gone it would open the callout on a blank line. A
       SOFT break needs nothing — mdast keeps it inside the text value, and the
       regex above consumed it. */
    if (para.children[0]?.type === 'break') para.children.shift();
    if (para.children.length === 0) quote.children?.shift();
  }

  const before = quote.data?.hProperties ?? {};
  quote.data = {
    ...(quote.data ?? {}),
    hProperties: { ...before, className: ['md-callout', `md-callout--${tone}`] },
  };
}

function calloutToneIn(className: string | undefined): CalloutTone | null {
  if (className === undefined) return null;
  const classes = className.split(/\s+/);
  if (!classes.includes('md-callout')) return null;
  return CALLOUT_TONES.find((t) => classes.includes(`md-callout--${t}`)) ?? null;
}

/**
 * The component table, built per render because the `img` override closes over
 * the host's resolver. Everything that needs no injection stays in the module
 * constant below and is spread in — there is still one `code`, one `a`, one
 * `table`, and no chance of two tables drifting apart.
 */
function componentsFor(source: string, fileHref?: MarkdownFileHref, extra?: Components): Components {
  return {
    ...COMPONENTS,
    ...headingComponents(source),
    /**
     * IMAGES ARE NOT FETCHED FROM THE WIDER WEB, and this is a privacy
     * boundary rather than a styling choice.
     *
     * `![](https://elsewhere/pixel.png)` in a doc body is a TRACKING BEACON.
     * The doc is authored by one space member and read by all of them, and the
     * default `<img>` would have every reader's browser request that URL the
     * moment the doc opens — handing the author's chosen host each reader's IP
     * address, their approximate location, their user-agent, and the exact
     * timestamp at which they read it. No click, no consent, no trace in the
     * UI. That is reader deanonymisation performed by us, on the author's
     * behalf, and it is the same class of hazard as the stored XSS that keeps
     * `rehype-raw` out of this file: a doc body is untrusted text.
     *
     * So the request is never issued. A remote image renders as a LINK CHIP
     * carrying the same `md-link` treatment as any other outbound link —
     * visible, honest about what it points at, and loaded only if the reader
     * decides to click. Hiding it would be the worse failure; a reader who
     * cannot see that the author put something there cannot judge the doc.
     *
     * `data:` URIs are refused too, for a second reason: a document body is
     * capped at 200k, and an inlined image spends that budget on bytes the
     * files lane already stores properly.
     *
     * An INTERNAL reference resolves and renders for real. It reaches the URL
     * through an injected `fileHref`, following the `downloadHref` precedent in
     * `files/reasons.ts` — constructing a transport URL is `src/data/**` work,
     * and same-origin luck is not a substitute for a seam. With no resolver
     * passed the reference states itself instead of guessing at a path.
     */
    img({ src, alt, title }) {
      const raw = typeof src === 'string' ? src : '';
      /* Alt text is never dropped. A markdown image with no alt still has the
         author's intent in its src, and a nameless graphic is unreadable to a
         screen reader and to anyone whose image fails to load. */
      const label = alt && alt.trim() !== '' ? alt : 'image';
      const ref = fileRefIn(raw);
      if (ref !== null) {
        const href = fileHref ? fileHref(ref) : null;
        if (href === null) {
          return (
            <span className="md-img-chip" data-testid="markdown-image-unresolved" title={raw}>
              {label} — this build has no resolver for tm8 file references
            </span>
          );
        }
        return (
          <img className="md-img" src={href} alt={label} title={title} loading="lazy" data-testid="markdown-image" />
        );
      }
      if (/^data:/i.test(raw.trim())) {
        return (
          <span className="md-img-chip" data-testid="markdown-image-rejected">
            {label} — inline image data is not rendered
          </span>
        );
      }
      /* Remote, or a shape this renderer does not recognise. Either way no
         request leaves the origin; the reader is offered the link instead. */
      return (
        <a
          href={raw}
          target="_blank"
          rel="noreferrer noopener"
          className="md-link md-img-chip"
          data-testid="markdown-image-link"
        >
          {label} — remote image, not loaded
        </a>
      );
    },
    ...extra,
  };
}

/**
 * Code fences render as REAL CODE — monospace, bordered, whitespace preserved,
 * scrolling in their own box.
 *
 * There is no syntax highlighting and none is implied: the language rides as a
 * small label, but the tokens are not coloured because no highlighter ships in
 * this build. Showing the true source under an honest label beats the old
 * placeholder, which hid the content entirely behind the words "not rendered".
 *
 * `mermaid` is the exception and is routed to `Mermaid` to be DRAWN. No other
 * language is special-cased, and `excalidraw` deliberately is not: there is no
 * renderer for it, and its source is a truer rendering than a second
 * placeholder would be.
 */
/**
 * h1–h6, each marked so an outline can find it again.
 *
 * WHY ALL SIX ARE GENERATED rather than written out: they differ in one thing
 * (the tag), and six near-identical overrides is six places for the attribute
 * to be forgotten in — which for a table of contents means a silently dead
 * entry.
 *
 * `tabIndex={-1}` is what makes the outline reachable by KEYBOARD as well as
 * by scrollbar. A heading is not focusable by default, so without it the
 * outline could only move the viewport, leaving the caret behind in the list —
 * the same defect the browser's own skip-link pattern uses this attribute to
 * avoid. `-1` keeps it out of the tab ORDER, so nothing is added to the
 * sequential path through the document.
 *
 * A heading whose source line carries no slug renders as a plain heading. That
 * is the fenced-region and Setext case: `headingsIn` deliberately skips both,
 * and the outline does not list them, so there is nothing to pair.
 */
function headingComponents(source: string): Components {
  const slugs = headingLineSlugs(source);
  const tags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
  const table: Partial<Record<(typeof tags)[number], HeadingComponent>> = {};
  for (const tag of tags) {
    const Tag = tag;
    table[tag] = function Heading({ node, children, ...rest }) {
      const line = node?.position?.start.line;
      const slug = line == null ? undefined : slugs.get(line);
      return (
        <Tag {...rest} {...(slug != null ? { [MD_HEADING_ATTR]: slug, tabIndex: -1 } : {})}>
          {children}
        </Tag>
      );
    };
  }
  return table;
}

/**
 * One override's signature. Written out because `Components` types each of the
 * six tags separately and a loop cannot narrow per iteration — the alternative
 * was six copies of the body, which is six places to forget the attribute.
 * Heading props are identical across h1-h6 (`HTMLHeadingElement` for all six),
 * so this is a restatement, not a widening.
 */
type HeadingComponent = ComponentType<ComponentPropsWithoutRef<'h1'> & ExtraProps>;

const COMPONENTS: Components = {
  code({ className, children, ...rest }) {
    const match = /language-(\w+)/.exec(className ?? '');
    // `react-markdown` v10 routes both spans and blocks here; a fenced block is
    // the one whose parent is <pre>, which it signals by passing a className
    // for the language OR by the text containing a newline. Inline code has
    // neither, and must stay inline or every sentence containing `foo` breaks.
    const text = String(children ?? '');
    const isBlock = match !== null || text.includes('\n');
    if (!isBlock) {
      return <code className="md-code" {...rest}>{children}</code>;
    }
    /* A mermaid fence is a DIAGRAM, not code — the one language this renderer
       hands off. Everything else falls through to the code block below, which
       is deliberate: `excalidraw` has no renderer either and showing its JSON
       as source claims nothing, where a second placeholder would. */
    if (match?.[1] === 'mermaid') {
      return <Mermaid source={text.replace(/\n$/, '')} />;
    }
    return (
      <span className="md-fence" data-testid="markdown-fence" data-lang={match?.[1] ?? ''}>
        {match ? <span className="md-fence__lang">{match[1]}</span> : null}
        <pre className="md-fence__pre">
          <code>{text.replace(/\n$/, '')}</code>
        </pre>
      </span>
    );
  },
  // `pre` is unwrapped: the fence above already provides its own block, and
  // leaving react-markdown's <pre> in place would nest one inside the other.
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className="md-link" {...rest}>
        {children}
      </a>
    );
  },
  /**
   * A QUOTE OR A CALLOUT — the class the remark transform above left decides,
   * and a blockquote it did not touch is still an ordinary blockquote. That
   * fall-through is the whole reason the tone is required rather than defaulted:
   * `> quoted text` must keep reading as a quotation, and a callout must never
   * be something a reader gets by accident.
   */
  blockquote({ node: _node, className, children, ...rest }) {
    const tone = calloutToneIn(className);
    if (tone === null) {
      return (
        <blockquote className={className} {...rest}>
          {children}
        </blockquote>
      );
    }
    return (
      <blockquote className="md-callout" data-tone={tone} data-testid="markdown-callout" {...rest}>
        {/* The word AND the mark, never the mark alone: a coloured triangle is
            not a word, and a reader who cannot separate wait from block gets
            nothing from the hue. The icon carries no accessible name for the
            same reason — the word beside it already says it. */}
        <p className="md-callout__title">
          <VectorIcon paths={CALLOUT_ART[tone]} size={14} />
          <span>{CALLOUT_WORD[tone]}</span>
        </p>
        {children}
      </blockquote>
    );
  },
  table({ children, ...rest }) {
    // Wrapped so a wide table scrolls inside its own box rather than forcing
    // the whole reading column sideways.
    return (
      <span className="md-tablewrap">
        <table className="md-table" {...rest}>{children}</table>
      </span>
    );
  },
};

export interface MarkdownProps {
  /** The markdown source. Empty renders nothing, not an empty paragraph. */
  source: string;
  /** Extra class on the root, for a surface that needs its own measure. */
  className?: string;
  testId?: string;
  /**
   * Resolves a tm8 file reference to a URL this renderer may load. Optional by
   * the same rule as `downloadHref`: pass one and every internal image in the
   * document renders at once; pass nothing and each says so. Remote images are
   * never loaded either way — see the `img` override.
   */
  fileHref?: MarkdownFileHref;
  /**
   * Per-surface element overrides, applied LAST so a host can replace one tag
   * without restating the table. The chat feed uses it for a single tag —
   * mentions arrive as links in the source and must come out as controls, and
   * that is knowledge about messages which has no business in `kit`.
   */
  components?: MarkdownComponents;
}

/** `react-markdown`'s component table, re-exported so hosts need not import it. */
export type MarkdownComponents = Components;

export function Markdown({ source, className, testId = 'markdown', fileHref, components }: MarkdownProps) {
  if (source.trim() === '') return null;
  return (
    <div className={className ? `md-root ${className}` : 'md-root'} data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        components={componentsFor(source, fileHref, components)}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/**
 * One heading of a document, as the outline needs it.
 *
 * `slug` is the LOOKUP KEY that pairs an outline entry with the heading element
 * this renderer draws — see `MD_HEADING_ATTR`. It is not an `id` and not a URL
 * fragment; read that attribute's docblock for why the distinction is
 * load-bearing here.
 */
export interface DocHeading {
  /** ATX depth, 1-6 — what lets the outline draw structure instead of a row. */
  level: number;
  /** Display text, inline markdown removed (`stripInline`). */
  text: string;
  /** Unique within one document, in document order. */
  slug: string;
  /** 1-based source line. The key `headingLineSlugs` pairs the render on. */
  line: number;
}

/**
 * HOW A RENDERED HEADING IS FOUND AGAIN — and why this is an attribute and
 * NOT an `id`.
 *
 * An `id` plus `href="#slug"` is the ordinary way to build a table of
 * contents, and it is wrong twice over in this app:
 *
 *  1. THE ROUTER OWNS `location.hash` (`routes/transport.ts` — every route in
 *     tm8 is `#/…`). An `href="#some-heading"` is therefore not an in-document
 *     anchor here, it is a NAVIGATION that replaces the whole route. The href
 *     would also be a broken URL if copied or middle-clicked, which is a worse
 *     lie than the caption this replaced.
 *  2. `id`s ARE GLOBAL AND THIS BODY MOUNTS MORE THAN ONCE. Two panels open on
 *     the same doc (split view), or the reader's own two-theme test render,
 *     put two copies of every heading in one document. `getElementById` would
 *     silently resolve to whichever mounted first — scrolling the wrong panel.
 *
 * So the pairing is a scoped attribute: the outline queries for it INSIDE its
 * own body root, where "the heading with this slug" has exactly one answer.
 */
export const MD_HEADING_ATTR = 'data-md-heading';

/**
 * The document's headings, in order — the ONE job the hand-rolled parsers keep.
 *
 * The reader promotes headings out of the column into its outline, and that is
 * a structural read over the source rather than a rendering concern, so it
 * stays a plain scan. ATX only (`# heading`), matching what the previous
 * `readDocument` recognised — a Setext heading (underlined with `===`) renders
 * correctly through `Markdown` above but does not reach the outline. Named
 * rather than silently half-supported.
 *
 * Fenced regions are skipped: a `# comment` inside a code block is code, not a
 * chapter, and the old parser put it in the outline.
 *
 * DEDUPLICATION LIVES HERE, ONCE. Two headings that read the same slugify the
 * same, so later collisions take a `-2`, `-3` suffix in document order. The
 * renderer below does not repeat this logic — it looks each heading's slug up
 * BY SOURCE LINE, so there is no second counter that could disagree with this
 * one.
 */
export function headingsIn(source: string): DocHeading[] {
  const headings: DocHeading[] = [];
  const used = new Map<string, number>();
  let inFence = false;
  source.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = /^(#{1,6})\s+(.+)$/.exec(raw.trim());
    if (!match) return;
    /* Trailing `#`s are ATX's optional closing sequence, not text: CommonMark
       renders `## Two ##` as "Two", so an outline that kept them would not
       match the heading it points at. */
    const text = stripInline(match[2].replace(/\s+#+\s*$/, '').trim());
    if (text === '') return;
    const base = slugify(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    headings.push({
      level: match[1].length,
      text,
      slug: seen === 0 ? base : `${base}-${seen + 1}`,
      line: i + 1,
    });
  });
  return headings;
}

/**
 * Source line → slug, the pairing the heading overrides render from.
 *
 * A LINE NUMBER rather than the heading's text is the key on purpose. The
 * overrides run per element, in whatever order React re-renders them; a
 * counter kept across those calls would be shared mutable state whose value
 * depends on render order, which is precisely how a duplicate-heading document
 * ends up with two elements claiming one slug. A line is a fact about the
 * source, so the same source always produces the same pairing.
 */
function headingLineSlugs(source: string): Map<number, string> {
  return new Map(headingsIn(source).map((h) => [h.line, h.slug]));
}

/**
 * A heading's text with inline markdown removed, for use as a LABEL.
 *
 * The outline is a list of destinations, not a second rendering of the
 * document, so `` ## The `zoom: 1.1` decision `` belongs in it as "The zoom:
 * 1.1 decision" — the previous chip row printed the backticks, asterisks and
 * link brackets verbatim, which read as punctuation noise.
 *
 * Deliberately NOT a markdown parser: it unwraps the four inline shapes whose
 * markers are pure syntax (code, emphasis, link/image text) and leaves
 * everything else alone. The rendered heading in the column is still the real
 * renderer's output — this only ever produces plain text.
 */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url), ![alt](src)
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1') // [label][ref]
    .replace(/`+([^`]+)`+/g, '$1') // `code`
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2') // ***bold italic***
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // **bold**
    .replace(/(\*|_)(.+?)\1/g, '$2') // *italic*
    .replace(/~~(.+?)~~/g, '$1') // ~~struck~~
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Heading text → a slug safe to put in an attribute and query for.
 *
 * GitHub's shape, because it is the one doc authors have seen: lowercased,
 * spaces to hyphens, anything else dropped. A heading made entirely of
 * punctuation (`## ---`) slugifies to nothing, so it falls back to a positional
 * name rather than an empty selector that would match every such heading.
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug === '' ? 'section' : slug;
}
