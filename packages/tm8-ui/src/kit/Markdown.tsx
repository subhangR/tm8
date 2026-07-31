import ReactMarkdown, { type Components } from 'react-markdown';
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
 */

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
}

export function Markdown({ source, className, testId = 'markdown' }: MarkdownProps) {
  if (source.trim() === '') return null;
  return (
    <div className={className ? `md-root ${className}` : 'md-root'} data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
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
