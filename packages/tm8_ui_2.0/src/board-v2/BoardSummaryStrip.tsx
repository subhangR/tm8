/**
 * THE SUMMARY STRIP — owner, 2026-08-31: "when you click on board there must
 * be nice dashboard".
 *
 * EVERY NUMBER IS A REAL READ, and it is the SAME read the board below it
 * draws: `summarise()` counts the exact arrays `ColumnView` and
 * `BoardTimeline` render, so a figure here and a figure in a column header
 * cannot disagree. Nothing is a placeholder and nothing is a constant.
 *
 * IT HEDGES THE WAY THE COLUMNS HEDGE. These counts are PAGE-SCOPED: when any
 * column has another page, every total wears a `+`, because a bare number
 * would claim a space-wide figure this screen never asked for. While a read is
 * in flight the strip says it is reading rather than printing a zero — "not
 * answered yet" and "none" are different facts and only one of them is good
 * news.
 *
 * IT IS NOT A CHART. Four counts, a live count and a dates count, in words and
 * numerals. A donut of six numbers would spend a fifth of the board's height
 * to say what six numerals say exactly, and would need a legend to say which
 * colour was which — the bars below already carry the colour, and they carry a
 * word with it.
 */
import type { BoardSummary } from './board-model';
import './board-timeline.css';

export interface BoardSummaryStripProps {
  summary: BoardSummary;
  /**
   * The WHOLE live sentence, count included — `list.liveCount.label(n)` is
   * registry DATA and it formats the number itself ("● 3 live"), so the strip
   * prints what it is given rather than reassembling it around a numeral it
   * would then have to duplicate. Same contract Home's `liveCountLabel` has.
   */
  liveLabel: string;
  /** Null when the selected kind can answer no live question at all. */
  liveNote: string | null;
}

const plus = (n: number, hedged: boolean): string => (hedged ? `${n}+` : `${n}`);

export function BoardSummaryStrip({ summary, liveLabel, liveNote }: BoardSummaryStripProps) {
  return (
    <div className="b2sum" data-testid="b2-summary" role="group" aria-label="Board summary">
      <span className="b2sum__total" data-testid="b2sum-total">
        <b>{summary.loading ? '…' : plus(summary.total, summary.hedged)}</b>
        {' shown'}
      </span>

      <span className="b2sum__sep" aria-hidden />

      {summary.lines.map((line) => (
        <span
          key={line.key}
          className="b2sum__stat"
          data-tone={line.tone}
          data-testid={`b2sum-cat-${line.key}`}
        >
          <b>{summary.loading ? '…' : line.count}</b>
          {` ${line.label}`}
        </span>
      ))}

      <span className="b2sum__sep" aria-hidden />

      {/* LIVE. Absent — not zero — for a kind that carries no liveness
          question at all, because "0 live" on a doc board is an answer to a
          question nobody can ask of a doc. */}
      {liveNote === null ? null : (
        <span className="b2sum__stat b2sum__stat--live" data-testid="b2sum-live" title={liveNote}>
          <b>{summary.loading ? '…' : liveLabel}</b>
        </span>
      )}

      {/* THE DATES CONFESSION, on the dashboard rather than only on a bar:
          how much of the timeline below is drawn from a default. */}
      <span
        className="b2sum__stat b2sum__stat--guess"
        data-testid="b2sum-undated"
        title="These have no start and no due date. The timeline draws them a default one-week bar, hatched, so a guess never reads as a fact."
      >
        <b>{summary.loading ? '…' : summary.undated}</b>
        {' with no dates'}
      </span>
      {summary.partiallyDated > 0 ? (
        <span
          className="b2sum__stat b2sum__stat--guess"
          data-testid="b2sum-partial"
          title="These state one endpoint only; the other end of the bar is a default week."
        >
          <b>{summary.partiallyDated}</b>
          {' half-dated'}
        </span>
      ) : null}
    </div>
  );
}
