import type { EntityDetail, EntitySummary } from '@tm8/contract';
import type { ContentBlockRef } from '../../domain';
import { getKind } from '../../domain';
import { EmptyBody } from '../detail/PanelStates';
import { DisabledIconControl, NOT_WIRED_REASON, toReason } from '../honesty/DisabledWithReason';
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
 * THE READING COLUMN HAS NO HEADING STYLE, and that is a decision rather than
 * an omission: the oracle's in-panel column draws prose and quote only, so a
 * heading size here would be eyeballed, which D5/§1 forbids. Headings in the
 * source text are promoted into the OUTLINE — the place the oracle actually
 * gives them — rather than restated in a size nobody measured.
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
}

export function ReaderBody({ detail, blocks, historyUnavailableReason, onOpenEntity }: ReaderBodyProps) {
  const content = detail.content as unknown as Record<string, unknown>;
  const state = detail.state as unknown as Record<string, unknown>;

  const source = firstString(content.body, content.description);
  const { headings, segments } = readDocument(source ?? '');

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

  if (outline.length === 0 && segments.length === 0 && !(chapterCount != null && chapterCount > 0)) {
    /*
     * A designed empty. The facts line goes with it: an empty document has no
     * chapters and no format worth a rule, and the deferred version-history
     * affordance is NOT lost — the panel footer's `v{n}` is its other home,
     * so R7's "never hidden" still holds for the panel as a whole.
     */
    return (
      <div className="pn-body" id="tabpanel-content" role="tabpanel" aria-labelledby="tab-content">
        <EmptyBody
          glyph={getKind(detail.kind).chip.glyph}
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
    >
      <Outline entries={outline} chapterCount={chapterCount} onOpenEntity={onOpenEntity} />

      {segments.map((segment, i) =>
        segment.type === 'quote' ? (
          <blockquote className="rd-quote" data-testid="reader-quote" key={`s${i}`}>
            {segment.text}
          </blockquote>
        ) : (
          <p className="rd-prose" data-testid="reader-prose" key={`s${i}`}>
            {segment.text}
          </p>
        ),
      )}

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
}

/**
 * ENTITIES FIRST, THE DOCUMENT'S OWN HEADINGS SECOND. A child entity is a
 * thing you can open; a heading is text we found. Both make a table of
 * contents, only the first makes a control — which is why they are kept
 * distinguishable all the way to the chip.
 */
function buildOutline(chapters: readonly EntitySummary[], headings: readonly string[]): OutlineEntry[] {
  if (chapters.length > 0) {
    return chapters.map((c) => ({ key: c.id, label: c.title, entityId: c.id }));
  }
  return headings.map((label, i) => ({ key: `h${i}`, label, entityId: null }));
}

function Outline({
  entries,
  chapterCount,
  onOpenEntity,
}: {
  entries: readonly OutlineEntry[];
  chapterCount: number | null;
  onOpenEntity?: (id: string) => void;
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
  return (
    <div className="rd-outline" data-testid="reader-outline">
      {entries.map((entry) => (
        <OutlineChip key={entry.key} entry={entry} onOpenEntity={onOpenEntity} />
      ))}
    </div>
  );
}

function OutlineChip({ entry, onOpenEntity }: { entry: OutlineEntry; onOpenEntity?: (id: string) => void }) {
  const id = entry.entityId;
  if (id == null) {
    /*
     * A LABEL, NOT A CONTROL. This entry is a heading found in the prose, and
     * in-document anchoring is not built — so the chip claims no affordance
     * at all rather than looking clickable and doing nothing (R7's other
     * half: a dead control is worse than an honest caption).
     */
    return (
      <span
        className="rd-chip rd-chip--static"
        data-testid="reader-toc-chip"
        title="Read from the document's own headings — not a linked entity"
      >
        {entry.label}
      </span>
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
    <button type="button" className="rd-chip" data-testid="reader-toc-chip" onClick={() => onOpenEntity(id)}>
      {entry.label}
    </button>
  );
}

// ---------------------------------------------------------------------------

interface ReadSegment {
  type: 'prose' | 'quote';
  text: string;
}

/**
 * The reading column's parse: headings out, quotes ruled, everything else
 * prose. Deliberately SMALL — this is not a markdown renderer and does not
 * claim to be one; it is the three shapes the oracle's column actually draws.
 * A doc whose format is not markdown still lands here and reads as prose,
 * which is the honest floor: unstyled real text beats a "cannot render".
 */
function readDocument(source: string): { headings: string[]; segments: ReadSegment[] } {
  const headings: string[] = [];
  const segments: ReadSegment[] = [];
  let buffer: string[] = [];
  let mode: ReadSegment['type'] | null = null;

  const flush = () => {
    if (mode != null && buffer.length > 0) segments.push({ type: mode, text: buffer.join(' ') });
    buffer = [];
    mode = null;
  };

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading != null) {
      flush();
      headings.push(heading[1].trim());
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    const next: ReadSegment['type'] = quoted != null ? 'quote' : 'prose';
    if (mode != null && mode !== next) flush();
    mode = next;
    buffer.push(quoted != null ? quoted[1].trim() : line);
  }
  flush();
  return { headings, segments };
}

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
