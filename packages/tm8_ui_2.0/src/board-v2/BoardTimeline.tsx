/**
 * THE PROJECT TIMELINE — the board's second view (owner, 2026-08-31: "create
 * project timeline board it should be multicolor … you can give overall
 * timeline for each task a nice view").
 *
 * ONE ROW PER ENTITY, one bar per row, over a dated axis of whole days.
 * Grouped by the board's OWN columns, so the Timeline and the Columns view
 * answer the same question in two shapes rather than asking two questions —
 * see `timelineGroups` for why that is what makes 200 rows readable.
 *
 * IT COMPUTES NOTHING ABOUT DATES. Every day key, every column index, every
 * count arrives from `board-model.ts` (`spanOf`, `axisFor`, `barIn`,
 * `timelineGroups`), which is where the tests are. This file turns those into
 * grid coordinates and text.
 *
 * A DEFAULTED BAR IS NEVER DRAWN LIKE A STATED ONE. `span.inferred` reaches
 * the DOM as `data-inferred` and `data-stated`, it reaches the eye as a
 * hatched, dashed, low-contrast bar (`board-timeline.css`), and it reaches a
 * reader who sees neither through the bar's `title` and accessible name, which
 * carry `span.note` verbatim. All three are required: the stylesheet alone
 * would be a fact only sighted users hold, and this package's tests run with
 * `css: false`, so a claim about the pixels that is not ALSO a claim about the
 * DOM is a claim nothing here can check.
 *
 * EVERY CELL IS EXPLICITLY PLACED. Mixing auto-flow items with items that name
 * a `grid-column` is how a bar ends up on its neighbour's row; the row index
 * is therefore computed once, in `linesOf`, and both halves of a row carry it.
 *
 * WIDE CONTENT SCROLLS IN ITS OWN BOX. `.b2tl__scroll` owns the horizontal
 * overflow; the page body must never scroll sideways, and a dated axis is
 * exactly the case that makes it.
 */
import type { EntitySummary } from '@tm8/contract';
import type { BarGeometry, TimelineAxis, TimelineGroup, TimelineRow, TimelineTone } from './board-model';
import { barIn } from './board-model';
import './board-timeline.css';

/** Column width in px, published to CSS so grid and model agree on one number. */
const DAY_WIDTH = 26;

/** Grid row 1 is the dated axis; every group starts below it. */
const FIRST_BODY_ROW = 2;

type Line =
  | { kind: 'group'; gridRow: number; group: TimelineGroup }
  | { kind: 'empty'; gridRow: number; group: TimelineGroup }
  | { kind: 'row'; gridRow: number; tone: TimelineTone; item: TimelineRow };

/** Flatten groups to explicitly-numbered grid rows. Pure, and trivially so. */
export function linesOf(groups: readonly TimelineGroup[]): Line[] {
  const lines: Line[] = [];
  let gridRow = FIRST_BODY_ROW;
  for (const group of groups) {
    lines.push({ kind: 'group', gridRow, group });
    gridRow += 1;
    if (group.rows.length === 0) {
      lines.push({ kind: 'empty', gridRow, group });
      gridRow += 1;
      continue;
    }
    for (const item of group.rows) {
      lines.push({ kind: 'row', gridRow, tone: group.tone, item });
      gridRow += 1;
    }
  }
  return lines;
}

export interface BoardTimelineProps {
  axis: TimelineAxis;
  groups: readonly TimelineGroup[];
  /** The row the board considers focused, so both views highlight the same one. */
  focusedId: string | null;
  /** Rows the live axis says are running now — a real read, not a guess. */
  isRowLive: (row: EntitySummary) => boolean;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
  buttonRef: (id: string, node: HTMLButtonElement | null) => void;
  /** Said once, on the axis corner, when a column's read has not answered. */
  loading: boolean;
}

export function BoardTimeline({
  axis,
  groups,
  focusedId,
  isRowLive,
  onOpen,
  onFocus,
  buttonRef,
  loading,
}: BoardTimelineProps) {
  const dayCount = axis.days.length;
  const lines = linesOf(groups);
  const drawn = groups.reduce((n, group) => n + group.rows.length, 0);
  const beyond = axis.truncated.before + axis.truncated.after;
  /* THE LAST GRID LINE, COUNTED — not `-1`.
     Every body row here is an IMPLICIT grid row (`grid-auto-rows`), and
     `grid-row: 1 / -1` resolves `-1` against the EXPLICIT grid, which declares
     no rows at all: it would collapse to `1 / 1` and the today rule would
     cover the axis header and nothing else. The columns can use `-1` — those
     ARE explicit — but the rows must be counted. */
  const lastRowLine = (lines.length > 0 ? lines[lines.length - 1]!.gridRow : 1) + 1;

  return (
    <div className="b2tl" data-testid="b2-timeline">
      {/* WHAT THE WINDOW DOES NOT SHOW, said before anyone scrolls looking. */}
      {beyond > 0 ? (
        <p className="b2tl__edge" data-testid="b2tl-truncated">
          {`${beyond} of ${drawn} reach past this ${dayCount}-day window — open one to see its real dates.`}
        </p>
      ) : null}

      <div
        className="b2tl__scroll"
        data-testid="b2tl-scroll"
        role="region"
        aria-label="Project timeline"
        tabIndex={0}
      >
        <div
          className="b2tl__grid"
          style={{
            ['--b2tl-days' as string]: String(Math.max(1, dayCount)),
            ['--b2tl-col' as string]: `${DAY_WIDTH}px`,
          }}
        >
          {/* ---- row 1: the dated axis ----------------------------------- */}
          <div className="b2tl__corner" style={{ gridRow: 1, gridColumn: 1 }}>
            {loading ? 'reading…' : `${drawn} shown`}
          </div>
          {axis.days.map((day, index) => (
            <div
              key={day.key}
              className="b2tl__day"
              style={{ gridRow: 1, gridColumn: index + 2 }}
              data-today={day.isToday || undefined}
              data-weekstart={day.isWeekStart || undefined}
              data-weekend={day.isWeekend || undefined}
              {...(day.isToday ? { 'data-testid': 'b2tl-today' } : {})}
              title={day.key}
            >
              {day.monthLabel ? <span className="b2tl__month">{day.monthLabel}</span> : null}
              <span className="b2tl__daynum">{day.dayOfMonth}</span>
            </div>
          ))}

          {/* TODAY as a rule down every row rather than a mark on the header:
              a marker you have to look up to find is one you measure against
              from memory. */}
          {axis.todayIndex >= 0 ? (
            <div
              className="b2tl__todayrule"
              style={{ gridRow: `1 / ${lastRowLine}`, gridColumn: axis.todayIndex + 2 }}
              data-testid="b2tl-todayrule"
              aria-hidden
            />
          ) : null}

          {/* ---- the body ------------------------------------------------ */}
          {lines.map((line) => {
            if (line.kind === 'group') {
              return (
                <div
                  key={`g:${line.group.key}`}
                  className="b2tl__group"
                  style={{ gridRow: line.gridRow, gridColumn: '1 / -1' }}
                  data-tone={line.group.tone}
                  data-testid="b2tl-group"
                  data-group={line.group.key}
                >
                  <span className="b2tl__group-label">{line.group.label}</span>
                  <span className="b2tl__group-count">
                    {line.group.hasMore ? `${line.group.rows.length}+` : line.group.rows.length}
                  </span>
                </div>
              );
            }
            if (line.kind === 'empty') {
              // An empty group is a real answer here for the same reason an
              // empty column is one in the other view.
              return (
                <div
                  key={`e:${line.group.key}`}
                  className="b2tl__empty"
                  style={{ gridRow: line.gridRow, gridColumn: '1 / -1' }}
                >
                  {`nothing in ${line.group.label}`}
                </div>
              );
            }
            return (
              <TimelineRowView
                key={line.item.row.id}
                item={line.item}
                tone={line.tone}
                axis={axis}
                gridRow={line.gridRow}
                focused={line.item.row.id === focusedId}
                live={isRowLive(line.item.row)}
                onOpen={onOpen}
                onFocus={onFocus}
                buttonRef={buttonRef}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TimelineRowView({
  item,
  tone,
  axis,
  gridRow,
  focused,
  live,
  onOpen,
  onFocus,
  buttonRef,
}: {
  item: TimelineRow;
  tone: TimelineTone;
  axis: TimelineAxis;
  gridRow: number;
  focused: boolean;
  live: boolean;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
  buttonRef: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const { row, span, word } = item;
  const bar: BarGeometry | null = barIn(span, axis);

  /* THE SENTENCE, once, for BOTH the tooltip and the accessible name.
     `span.note` is the model's own words, used verbatim — a paraphrase here
     would be a second copy of the claim, free to drift from the tested one. */
  const dates = span.startDay === span.endDay ? span.startDay : `${span.startDay} → ${span.endDay}`;
  const sentence = [`${row.title} · ${word} · ${dates}`, span.note].filter(Boolean).join(' — ');

  return (
    <>
      <div
        className="b2tl__label"
        style={{ gridRow, gridColumn: 1 }}
        data-testid="b2tl-row"
        data-entity={row.id}
        data-focused={focused || undefined}
      >
        <button
          ref={(node) => buttonRef(row.id, node)}
          type="button"
          className="b2tl__title"
          data-b2-card-trigger=""
          data-entity={row.id}
          tabIndex={focused ? 0 : -1}
          onFocus={() => onFocus(row.id)}
          onClick={() => onOpen(row.id)}
        >
          {row.title}
        </button>
        {live ? (
          <span
            className="b2tl__live"
            data-testid="b2tl-live"
            title="A session the node can currently see is running on this."
          >
            live
          </span>
        ) : null}
      </div>

      {bar === null ? (
        /* Wholly outside the window. NOT pinned to column 1 as though it were
           today — a bar in the wrong place is worse than no bar, so the row
           keeps its label and states the absence in words. */
        <div
          className="b2tl__outside"
          style={{ gridRow, gridColumn: '2 / -1' }}
          data-testid="b2tl-outside"
        >
          {`${dates} — outside this window`}
        </div>
      ) : (
        <div
          className="b2tl__bar"
          style={{ gridRow, gridColumn: `${bar.startIndex + 2} / span ${bar.dayCount}` }}
          data-testid="b2tl-bar"
          data-entity={row.id}
          data-tone={tone}
          /* THE FACTS THE PIXELS BRANCH ON, in the DOM so a `css: false` test
             can read them without a stylesheet. */
          data-inferred={span.inferred || undefined}
          data-stated={span.stated}
          data-contradictory={span.contradictory || undefined}
          data-clipped-start={bar.clippedStart || undefined}
          data-clipped-end={bar.clippedEnd || undefined}
          title={sentence}
          aria-label={sentence}
        >
          {/* COLOUR REINFORCES THE WORD AND NEVER REPLACES IT: the category
              word rides the bar, and the defaulted-week marker rides beside
              it in text, not only in a dash pattern. */}
          <span className="b2tl__word">{word}</span>
          {span.inferred ? (
            <span className="b2tl__guess" data-testid="b2tl-guess">
              {span.stated === 'none' ? 'default week' : 'part-guessed'}
            </span>
          ) : null}
          {span.contradictory ? (
            <span className="b2tl__guess" data-testid="b2tl-contradiction">
              dates disagree
            </span>
          ) : null}
        </div>
      )}
    </>
  );
}
