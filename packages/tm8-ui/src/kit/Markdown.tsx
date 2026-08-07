import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './Mermaid';
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

/**
 * The component table, built per render because the `img` override closes over
 * the host's resolver. Everything that needs no injection stays in the module
 * constant below and is spread in — there is still one `code`, one `a`, one
 * `table`, and no chance of two tables drifting apart.
 */
function componentsFor(fileHref?: MarkdownFileHref, extra?: Components): Components {
  return {
    ...COMPONENTS,
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
        remarkPlugins={[remarkGfm]}
        components={componentsFor(fileHref, components)}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The document's headings, in order — the ONE job the hand-rolled parsers keep.
 *
 * The reader promotes headings out of the column into its outline chips, and
 * that is a structural read over the source rather than a rendering concern,
 * so it stays a plain scan. ATX only (`# heading`), matching what the previous
 * `readDocument` recognised — a Setext heading (underlined with `===`) renders
 * correctly through `Markdown` above but does not reach the outline. Named
 * rather than silently half-supported.
 *
 * Fenced regions are skipped: a `# comment` inside a code block is code, not a
 * chapter, and the old parser put it in the outline.
 */
export function headingsIn(source: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const raw of source.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+)$/.exec(raw.trim());
    if (match) headings.push(match[1].trim());
  }
  return headings;
}
