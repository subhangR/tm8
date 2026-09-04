import { useCallback, useRef } from 'react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { KindIcon, getKind } from '../../domain';
import { EmptyBody } from '../detail/PanelStates';
import { DisabledIconControl, NOT_WIRED_REASON, toReason } from '../honesty/DisabledWithReason';
import { MD_HEADING_ATTR, Markdown, headingsIn, type DocHeading, type MarkdownFileHref } from '../../kit';
import './reader-body.css';

/**
 * THE READER ARCHETYPE BODY — T0-4 frame 2 "DOC" (oracle lines 325-361), with
 * the Z4 "READER (doc)" frame (984-1027) and "DARK DOC" (1321-1352) cross-read.
 *
 * ANATOMY, top → bottom, exactly as the oracle's body div draws it:
 *   outline chips   (`display:flex;gap:5px;flex-wrap:wrap` of mono pills)
 *   reading column  (serif prose paragraphs, rule-quoted lines between them)
 *   facts line      (`4 chapters · markdown … history ▸`, above a hairline)
 *
 * NOT A DOC BODY — A READER BODY. Every read below is STRUCTURAL: "does this
 * content carry prose?", "does this record carry a child count?", never "is
 * this a doc?". Any kind whose registry row declares `archetype: 'reader'`
 * renders here, which is why `panels/no-branching.test.ts` can fail the build
 * on a kind literal and this file survives it.
 *
 * WHAT IT DELIBERATELY DOES NOT DRAW. The oracle paints the ⇲/breadcrumb/
 * version-pill row, the tab strip and the `v3 · autosaved · 2 readers now`
 * strip around this region — all of that is the SHARED CHROME (detail/chrome
 * .tsx), fixed for every kind, and D63 supersedes the canvas's three-row form
 * with two rows by user ruling. This file owns the interior only.
 *
 * THE READING COLUMN RENDERS MARKDOWN (user ruling 2026-07-31), which reverses
 * an earlier decision recorded here. It used to draw prose and quote only, on
 * the reasoning that the oracle's in-panel column drew no headings and a
 * heading size would therefore be eyeballed. The cost of that floor showed in
 * use: lists collapsed into one paragraph, `**bold**` rendered as asterisks,
 * tables as pipes, and code fences as a chip that said "not rendered". Docs
 * ARE markdown — every record carries `format: 'markdown'`. The sizes are no
 * longer eyeballed either; `kit/markdown.css` maps headings onto the package's
 * own `--pn-fs-*` scale, so nothing here invents a measure.
 *
 * Headings are now in BOTH places on purpose: the outline above is NAVIGATION,
 * the rendered body is the DOCUMENT.
 *
 * THE OUTLINE IS A TABLE OF CONTENTS, NOT A CHIP ROW (user ruling 2026-08-17),
 * which reverses two decisions recorded below. It used to be a wrapped row of
 * mono pills in which the heading-derived entries were inert CAPTIONS, because
 * in-document anchoring was not built. Both halves of that failed the same way
 * in use: a reader looking at fourteen chapter titles wrapped across five ragged
 * lines cannot see the document's shape, and the one thing they reach for — go
 * to that section — was the thing the chips could not do.
 *
 * So it is a list now: one entry per line, indented by heading depth, and every
 * entry is a control that goes somewhere. Nothing about R7 relaxed — the two
 * kinds of entry stay distinguishable, and an entity entry with no dispatch is
 * still disabled-with-reason. What changed is that a heading entry now HAS a
 * dispatch (`kit`'s `MD_HEADING_ATTR` pairing), so honesty no longer requires
 * it to be a caption.
 */

export interface ReaderBodyProps {
  detail: EntityDetail;
  /**
   * The registry's blocks for this kind. The reader's own three regions are
   * anatomy, not blocks — what it reads here are the registry ADDITIONS it
   * can honour: `notice` (an honest sentence under the column) and an `items`
   * block whose `params.source` names the content member holding the outline.
   * Any other declared block renders nothing, the same way GenericBody's
   * switch returns null for a block kind it does not draw.
   */
  blocks: readonly ContentBlockRef[];
  /**
   * R7 — version history is DEFERRED. `history ▸` is its in-body home and
   * renders disabled-carrying-this-reason. REQUIRED, not optional: an
   * optional reason is how a control ends up live and inert, which is the
   * defect class the rule exists for. `DetailReasons.versionHistory` is the
   * value the panel already holds.
   */
  historyUnavailableReason: string;
  /** Absent ⇒ chapter chips render disabled-with-reason, never live-and-dead. */
  onOpenEntity?: (id: string) => void;
  /**
   * Resolves `![](tm8://file/<id>)` to bytes this reader may load. Absent ⇒
   * every internal image states itself instead of rendering — see `Markdown`'s
   * `img` override, which never guesses a transport path.
   */
  fileHref?: MarkdownFileHref;
}

export function ReaderBody({ detail, blocks, historyUnavailableReason, onOpenEntity, fileHref }: ReaderBodyProps) {
  /**
   * The search scope for an outline jump, and the reason it is a ref rather
   * than `document`. This body mounts more than once — two panels split on the
   * same doc, and the reader's own test renders it twice for both themes — so
   * "the heading with this slug" only has one answer WITHIN one body. See
   * `MD_HEADING_ATTR` for the same argument at the other end of the pairing.
   */
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onJumpToHeading = useCallback((slug: string) => {
    const root = rootRef.current;
    if (root == null) return;
    /*
     * THE SLUG IS NEVER INTERPOLATED INTO A SELECTOR. It is derived from
     * author text, so `[data-md-heading="…"]` built by concatenation is a
     * string from a document being fed to a parser — a heading containing a
     * quote or a backslash makes it a `SyntaxError` thrown out of a click
     * handler, and `CSS.escape` is the fix everyone reaches for and is
     * undefined in jsdom, which means the escaping would be UNTESTED here.
     * Matching on the attribute's presence and comparing the value in JS has
     * neither problem and needs no escaping to reason about.
     */
    const target = [...root.querySelectorAll<HTMLElement>(`[${MD_HEADING_ATTR}]`)].find(
      (el) => el.getAttribute(MD_HEADING_ATTR) === slug,
    );
    if (target == null) return;
    target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    /*
     * FOCUS FOLLOWS THE JUMP, and it must not scroll a second time. A keyboard
     * or screen-reader user who activates an outline entry has to arrive at
     * the heading, or the viewport moves and their caret stays in the list —
     * every subsequent Tab then walks the outline again instead of the section
     * they asked for. `preventScroll` leaves the smooth scroll above in charge;
     * without it the browser's own instant scroll-into-view races it and the
     * animation is lost.
     */
    target.focus({ preventScroll: true });
  }, []);

  const content = detail.content as unknown as Record<string, unknown>;
  const state = detail.state as unknown as Record<string, unknown>;

  const source = firstString(content.body, content.description);
  const headings = headingsIn(source ?? '');

  const outlineSource = blocks.find((b) => b.block === 'items')?.params?.source;
  const declared = typeof outlineSource === 'string' ? content[outlineSource] : undefined;
  const chapters: EntitySummary[] = Array.isArray(declared)
    ? (declared as EntitySummary[])
    : detail.hierarchy.children.items;

  const outline = buildOutline(chapters, headings);

  /**
   * TWO SOURCES, AND THE VERDICT IS WHAT WE HOLD (D6's shape, one surface
   * over). The record's child count and the outline we were actually given
   * are different facts; drawing N chips from the number would invent
   * entities. Where they disagree, the gap is STATED.
   */
  const chapterCount = typeof state.childCount === 'number' ? state.childCount : null;
  const format = firstString(content.format, state.format);

  const notices = blocks
    .filter((b) => b.block === 'notice')
    .map((b) => (typeof b.params?.text === 'string' ? b.params.text : null))
    .filter((t): t is string => t != null);

  const hasProse = (source ?? '').trim() !== '';
  if (outline.length === 0 && !hasProse && !(chapterCount != null && chapterCount > 0)) {
    /*
     * A designed empty. The facts line goes with it: an empty document has no
     * chapters and no format worth a rule, and the deferred version-history
     * affordance is NOT lost — the panel footer's `v{n}` is its other home,
     * so R7's "never hidden" still holds for the panel as a whole.
     */
    return (
      <div className="pn-body" id="tabpanel-content" role="tabpanel" aria-labelledby="tab-content">
        <EmptyBody
          glyph={<KindIcon kind={detail.kind} />}
          sentence="This document has no content yet. Nothing is invented to fill it."
        />
      </div>
    );
  }

  return (
    <div
      className="pn-body"
      id="tabpanel-content"
      role="tabpanel"
      aria-labelledby="tab-content"
      data-testid="reader-body"
      ref={rootRef}
    >
      <Outline
        entries={outline}
        chapterCount={chapterCount}
        onOpenEntity={onOpenEntity}
        onJumpToHeading={onJumpToHeading}
      />

      {/* THE DOCUMENT, RENDERED (user ruling 2026-07-31). This used to be a
          flat run of <p>/<blockquote> from a four-shape hand parser, which
          turned every list into one run-on paragraph and printed `**bold**`
          as asterisks. `Markdown` is CommonMark + GFM; the headings it draws
          in place are the SAME ones the outline above lists, which is
          deliberate — the outline is navigation, the body is the document. */}
      {/* `md-doc` is `kit/markdown.css`'s DOCUMENT stance — the reading size and
          leading the chat transcript already uses, plus a measure so an
          expanded panel does not serve a 1,400px line of prose. `.md-root` is
          worn by chat bubbles and task descriptions too, and only this one is
          read for minutes at a time, so the stance is opt-in rather than the
          base. `rd-md` stays as the reader's own hook. */}
      <Markdown source={source ?? ''} className="rd-md md-doc" testId="reader-markdown" fileHref={fileHref} />

      {notices.map((text) => (
        <p className="pn-notice" data-testid="reader-notice" key={text}>
          {text}
        </p>
      ))}

      <div className="rd-facts" data-testid="reader-facts">
        <span>{factWords(chapterCount, format)}</span>
        <span className="rd-facts__spacer" />
        {/* The oracle draws `history ▸` as a live brass link (line 353). R7
            rules it DISABLED-WITH-REASON until the timeline exists — a
            deliberate divergence from the canvas, in the canvas's own
            position. */}
        <DisabledIconControl label="Version history" reason={toReason(historyUnavailableReason)}>
          history ▸
        </DisabledIconControl>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface OutlineEntry {
  key: string;
  label: string;
  /** Set when the entry is a real entity; null when it was read out of prose. */
  entityId: string | null;
  /** Set when the entry is a heading in THIS document; null for an entity. */
  slug: string | null;
  /**
   * Indent depth, 0-based. Heading entries carry the document's own nesting;
   * chapter entities are siblings in the hierarchy we were given and are all
   * drawn flat — an invented depth would claim a structure the record does not
   * hold.
   */
  depth: number;
}

/**
 * ENTITIES FIRST, THE DOCUMENT'S OWN HEADINGS SECOND. A child entity is a
 * thing you can OPEN; a heading is a place in this document you can GO TO.
 * Both make a table of contents and both are now real controls, but they do
 * different things — which is why they stay distinguishable all the way to the
 * row.
 *
 * DEPTH IS NORMALISED TO WHAT THE DOCUMENT USES, not to the raw `#` count. A
 * doc whose every heading is `##` has one level, not a uniform one-step indent,
 * so the shallowest heading present becomes depth 0. Deeper levels then step
 * one per level, and depth is capped — see `rd-toc__row` for why the CSS could
 * not be trusted with an unbounded number.
 */
function buildOutline(chapters: readonly EntitySummary[], headings: readonly DocHeading[]): OutlineEntry[] {
  if (chapters.length > 0) {
    return chapters.map((c) => ({ key: c.id, label: c.title, entityId: c.id, slug: null, depth: 0 }));
  }
  const top = headings.reduce((min, h) => Math.min(min, h.level), 6);
  return headings.map((h) => ({
    key: h.slug,
    label: h.text,
    entityId: null,
    slug: h.slug,
    depth: Math.min(h.level - top, MAX_OUTLINE_DEPTH),
  }));
}

/**
 * Indents past this collapse to one measure. A `######` under an `#` is four
 * steps deep, and at the panel's width every further step is width taken from
 * a label that is already ellipsing — the nesting stops being readable long
 * before the levels run out.
 */
const MAX_OUTLINE_DEPTH = 3;

function Outline({
  entries,
  chapterCount,
  onOpenEntity,
  onJumpToHeading,
}: {
  entries: readonly OutlineEntry[];
  chapterCount: number | null;
  onOpenEntity?: (id: string) => void;
  onJumpToHeading: (slug: string) => void;
}) {
  if (entries.length === 0) {
    if (chapterCount == null || chapterCount <= 0) return null;
    /*
     * The honest absence, ONE LINE and quieter than the column (L9): an
     * absence is stated, not shouted, and it must not tax the reading
     * surface it sits above.
     */
    return (
      <p className="rd-absent" data-testid="reader-outline-absent">
        {`${chapterCount} chapters recorded · outline not loaded`}
      </p>
    );
  }
  /*
   * A <nav> around an <ol>, because that is what this is. The chip row was a
   * bare div of pills — to a screen reader an unlabelled run of buttons with
   * no count and no boundary, indistinguishable from the toolbar it sat under.
   * The list makes the count and the nesting audible, and the label is what
   * lets a user skip the table of contents to reach the document.
   */
  return (
    <nav className="rd-toc" data-testid="reader-outline" aria-label="Table of contents">
      {/* THE REGION SAYS WHAT IT IS. `aria-label` above told a screen reader
          and nobody else; the reported defect was that a sighted reader saw
          nineteen grey lines with "no indication they are navigation". The
          <nav> keeps the accessible name, so this word is presentational and
          carries `aria-hidden` rather than being announced twice. */}
      <p className="rd-toc__head" aria-hidden="true">
        Contents
      </p>
      <ol className="rd-toc__list">
        {entries.map((entry) => (
          <li className="rd-toc__item" data-depth={entry.depth} key={entry.key}>
            <OutlineEntryControl entry={entry} onOpenEntity={onOpenEntity} onJumpToHeading={onJumpToHeading} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * `data-testid="reader-toc-chip"` OUTLIVES THE CHIP, deliberately. The name no
 * longer describes the element, and it is kept anyway because it is a selector
 * two suites reach for — including `e2e/entity-view.spec.ts`, which drives a
 * real browser this change cannot re-run. Renaming it would be a cosmetic
 * improvement bought with an unverifiable edit to a test guarding a different
 * behaviour (a chapter opening beside the document). The stale name is the
 * cheaper honesty; this comment is the pointer for whoever renames it next
 * with the e2e in reach.
 */
function OutlineEntryControl({
  entry,
  onOpenEntity,
  onJumpToHeading,
}: {
  entry: OutlineEntry;
  onOpenEntity?: (id: string) => void;
  onJumpToHeading: (slug: string) => void;
}) {
  const id = entry.entityId;
  if (id == null) {
    /*
     * A HEADING IN THIS DOCUMENT — a jump, not a navigation.
     *
     * A <button>, and NOT an `<a href="#slug">`, even though a link is what
     * this looks and reads like. tm8's router owns `location.hash` (every
     * route is `#/…`), so that href would leave the document rather than
     * scroll it, and would be a broken URL the moment anyone copied it. The
     * full argument lives on `MD_HEADING_ATTR`, next to the other end of the
     * pairing.
     *
     * `slug` is non-null for every heading entry by construction; the guard is
     * for the type, and falling back to no-op beats a non-null assertion that
     * would throw in the one case the type says cannot happen.
     */
    return (
      <button
        type="button"
        className="rd-toc__row rd-toc__row--heading"
        data-testid="reader-toc-chip"
        onClick={() => (entry.slug ? onJumpToHeading(entry.slug) : undefined)}
      >
        <span className="rd-toc__label">{entry.label}</span>
      </button>
    );
  }
  if (!onOpenEntity) {
    // Structural, so it cannot drift from what is wired (chrome's ActionButton
    // precedent): no dispatch ⇒ the control states that, it does not pretend.
    return (
      <DisabledIconControl label={`Open ${entry.label}`} reason={NOT_WIRED_REASON}>
        {entry.label}
      </DisabledIconControl>
    );
  }
  return (
    <button
      type="button"
      className="rd-toc__row rd-toc__row--entity"
      data-testid="reader-toc-chip"
      onClick={() => onOpenEntity(id)}
    >
      <span className="rd-toc__label">{entry.label}</span>
    </button>
  );
}

/**
 * Whether this reader may animate a jump.
 *
 * Read at CLICK TIME rather than held in state: the jump is the only thing that
 * consults it, and a media-query listener kept alive for the life of every
 * mounted document body would be subscription cost for a value nothing renders
 * from. Guarded for the environment because jsdom implements `matchMedia`
 * only when a test asks it to.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------



/**
 * The facts the record actually carries, in the oracle's order. A count we do
 * not hold is OMITTED rather than printed as `0 chapters` — a measured zero is
 * a real answer, an unmeasured one is a claim (the same distinction the tab
 * counts make in the other direction).
 */
function factWords(chapterCount: number | null, format: string | null): string {
  const parts: string[] = [];
  if (chapterCount != null && chapterCount > 0) parts.push(`${chapterCount} chapters`);
  if (format != null) parts.push(format);
  return parts.join(' · ');
}

function firstString(...values: readonly unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
