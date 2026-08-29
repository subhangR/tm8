/**
 * THE LIVE DOCK (prototype section C) — a slim strip directly above the
 * composer saying what is alive right now, and nothing else.
 *
 * IT PUTS NOTHING IN THE CONVERSATION. That is its entire premise: the
 * transcript stays words a person wrote and words an assistant wrote, and the
 * machine chatter lives in a strip that is always in the corner of the eye and
 * never in the way. Scroll back a week later and there is nothing to scroll
 * past. The cost is that the strip has NO HISTORY — which is exactly why the
 * approved direction is A+C, with the Crew Card carrying the permanent record.
 *
 * THREE STATES, AND THE ORDER MATTERS:
 *   nothing at all  → renders NOTHING. Not an empty strip, not a zero count.
 *                     A frame with no content is furniture a person has to
 *                     learn to ignore.
 *   nothing live    → ONE line. "All done — 2 helpers finished." It collapses
 *                     itself rather than waiting to be dismissed.
 *   something live  → one summary line + a pill, expandable to per-helper rows.
 *
 * The middle state is decided by `outstanding` in the vocabulary, never by
 * "no one is running": a stuck helper and a queued helper are both still the
 * crew's business, and a strip that called either of them done would be
 * hiding live work behind a finished-looking line.
 *
 * IT IS THE ONE ANNOUNCER. Design §7 says live regions announce ONLY "needs
 * you", and P4 says only that state may interrupt at all. The announcement
 * lives here rather than in the Crew Card because a transcript can hold
 * several cards and the dock is one per screen: N regions would speak one
 * event N times, which is precisely the noise P4 exists to prevent.
 *
 * PROPS ONLY, LIKE THE CARD. Fixture-driven until DESIGN 2 (task 01a028e1)
 * defines where live status text comes from.
 */
import { useState } from 'react';
import { Avatar, Pill } from '../../kit';
import { crewSummaryOf, type CrewRow, type CrewView } from './crew-model';
import { pillToneOf } from './status-vocabulary';
import './crew.css';

export interface LiveDockProps {
  crew: CrewView;
  /** Open the fuller view — the Crew Card in the transcript, the Fleet pane,
   *  whatever the host has. Absent renders no link rather than a dead one. */
  onOpenCrew?: (() => void) | undefined;
}

export function LiveDock({ crew, onOpenCrew }: LiveDockProps) {
  const [open, setOpen] = useState(false);
  const summary = crewSummaryOf(crew);

  /* NOTHING AT ALL. */
  if (summary.rows.length === 0) return null;

  /* NOTHING LIVE — self-cleaning, one line, no disclosure control. There is
     nothing left to disclose. */
  if (summary.allSettled) {
    return (
      <div className="tch-dock" data-testid="live-dock" data-state="settled">
        <div className="tch-dock__head">
          <Pill tone={pillToneOf('done')}>All done</Pill>
          <span className="tch-dock__text" data-testid="live-dock-alldone">
            {summary.allDoneLine}
          </span>
        </div>
      </div>
    );
  }

  const headlineText = [crew.headline, summary.elapsedShort]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');

  return (
    <div
      className="tch-dock"
      data-testid="live-dock"
      data-state="live"
      /* The one state allowed to be visually urgent, and only ever this one. */
      data-urgent={summary.needsYou > 0 ? 'true' : undefined}
    >
      <button
        type="button"
        className="tch-dock__head"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        data-testid="live-dock-toggle"
      >
        <Pill
          tone={pillToneOf(summary.headline.tone)}
          {...(summary.headline.tone === 'working' ? { dot: 'pulse' as const } : {})}
        >
          {summary.headline.text}
        </Pill>
        <span className="tch-dock__text" data-testid="live-dock-line">
          {headlineText ||
            /* No headline from the host and no measured elapsed: the summary
               line is still a true sentence about the crew, so the strip says
               that rather than sitting blank beside a pill. */
            summary.summaryLine}
        </span>
        <span className="tch-dock__caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {/* THE ONLY THING THIS SURFACE EVER SPEAKS. Empty at every other
          moment, so a working→finished transition is silent and a helper
          asking a question is not. */}
      <p className="tch-dock__announce" role="status" aria-live="polite" data-testid="live-dock-announce">
        {summary.needsYou > 0
          ? summary.rows
              .filter((row) => row.words.mayInterrupt)
              .map((row) => `${row.role} needs a word from you.`)
              .join(' ')
          : ''}
      </p>

      {open ? (
        <div className="tch-dock__body">
          <ul className="tch-dock__rows">
            {summary.rows.map((row) => (
              <LiveDockRow key={row.key} row={row} />
            ))}
          </ul>
          {onOpenCrew ? (
            <button type="button" className="tch-dock__open" onClick={onOpenCrew}>
              Open the full card
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LiveDockRow({ row }: { row: CrewRow }) {
  const words = row.words;
  return (
    <li className="tch-dock__row" data-testid="live-dock-row" data-tone={words.tone}>
      <Avatar
        actorId={row.role}
        provenance="agent"
        label={row.role}
        initials={row.monogram}
        size={20}
      />
      <span className="tch-dock__who">{row.role}</span>
      <span className="tch-dock__what">{words.label}</span>
      <Pill
        tone={pillToneOf(words.tone)}
        {...(words.tone === 'working' ? { dot: 'pulse' as const } : {})}
      >
        {words.pill}
      </Pill>
    </li>
  );
}
