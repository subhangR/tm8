/**
 * THE CREW CARD (prototype section A) — the permanent record of who was put
 * on a piece of work, dropped into the transcript once and edited in place.
 *
 * WHY A CARD AND NOT MESSAGES. Twenty status messages is how a conversation
 * stops being readable; one card that updates is how the same information
 * costs one line of scroll. Scroll back a week later and the card is still
 * there saying who did what — which is the half of the design the Live Dock
 * cannot provide, and the reason A and C were approved together rather than
 * either alone.
 *
 * A LEAF, PROPS ONLY. No store, no seam, no reader, no clock. Every fact
 * arrives as a `CrewView` and every verb leaves as a callback, so the card
 * can be mounted by the transcript, by a harness or by a test without
 * learning which. It is fixture-driven today because the signal that would
 * fill a `CrewView` from real sessions is DESIGN 2's (task 01a028e1); this
 * component is finished either way, and wiring it is a later, smaller diff.
 *
 * THE THREE RULES IT ENFORCES:
 *  · NO IDS, NO STATUS TOKENS. Every word on screen comes from
 *    `status-vocabulary` or from a host-written role/sentence. `key` is never
 *    rendered, and `no-machine-words.test.tsx` proves it against fixtures
 *    whose keys are real uuids.
 *  · ONLY "needs you" IS URGENT (P4). It is the sole state that tints a row
 *    and raises the footer's action. Everything else changes quietly in
 *    place. The card DELIBERATELY DOES NOT ANNOUNCE: a transcript can hold
 *    several cards, and N live regions would announce one event N times. The
 *    Live Dock is the single announcer — see `LiveDock.tsx`.
 *  · A DEAD END ALWAYS OFFERS A NEXT MOVE. A stuck row carries its sentence
 *    and its one button; a host that supplied no sentence gets told so on the
 *    row rather than having the row quietly look fine.
 */
import { useState } from 'react';
import { Avatar, Pill } from '../../kit';
import {
  collapseCrewRows,
  crewSummaryOf,
  CREW_VISIBLE_ROWS,
  type CrewRow,
  type CrewView,
} from './crew-model';
import { pillToneOf } from './status-vocabulary';
import './crew.css';

export interface CrewCardProps {
  crew: CrewView;
  /**
   * Answer the helper that is asking. Absent is a real state — a host with
   * nowhere to send the reply disables the control with a reason rather than
   * dropping it, so the affordance never silently disappears.
   */
  onRespond?: (() => void) | undefined;
  /** Take the one action a stuck helper offers. Same absent-is-disabled rule. */
  onHelperAction?: ((helper: { key: string; role: string }) => void) | undefined;
}

/** The count phrase in the card's own voice, quoted from the prototype. */
function teammatesPhrase(count: number): string {
  return count === 1 ? '1 teammate is on this' : `${count} teammates are on this`;
}

const NO_HANDLER_REASON = 'This view cannot act yet — it is showing example data.';

export function CrewCard({ crew, onRespond, onHelperAction }: CrewCardProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = crewSummaryOf(crew);

  /* An empty crew is not a card with nothing in it — it is no card. The
     transcript must not carry an empty frame for work that never started. */
  if (summary.rows.length === 0) return null;

  const collapse = collapseCrewRows(summary.rows, expanded);
  const collapsible = summary.rows.length > CREW_VISIBLE_ROWS;
  const subline = [crew.headline, summary.startedLabel, crew.estimate]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');

  return (
    <section
      className="tch-crew"
      data-testid="crew-card"
      /* The only visual urgency in the component, and it is spent here. */
      data-urgent={summary.needsYou > 0 ? 'true' : undefined}
      aria-label={teammatesPhrase(summary.rows.length)}
    >
      <header className="tch-crew__top">
        <div className="tch-crew__lead-col">
          <div className="tch-crew__lead">{teammatesPhrase(summary.rows.length)}</div>
          {subline ? <div className="tch-crew__sub">{subline}</div> : null}
        </div>
        {/* Faces, not ids. `actorId` is the ROLE on purpose: it is the kit's
            deterministic colour key, and feeding it a session id would put
            that id in the DOM for a colour we can get from a word. */}
        <div className="tch-crew__stack" aria-hidden>
          {collapse.shown.slice(0, 4).map((row) => (
            <Avatar
              key={row.key}
              actorId={row.role}
              provenance="agent"
              label={row.role}
              initials={row.monogram}
              size={22}
            />
          ))}
        </div>
      </header>

      <ul className="tch-crew__rows">
        {collapse.shown.map((row) => (
          <CrewCardRow key={row.key} row={row} onHelperAction={onHelperAction} />
        ))}
      </ul>

      {collapse.hiddenCount > 0 ? (
        <button
          type="button"
          className="tch-crew__more"
          onClick={() => setExpanded(true)}
          data-testid="crew-card-more"
        >
          {/* SAYING WHAT IS HIDDEN is the point. "+4 more" over a helper that
              needs an answer is how a card starts lying by omission. */}
          {`Show ${collapse.hiddenCount} more · ${collapse.hiddenSummary ?? ''}`}
        </button>
      ) : collapsible ? (
        <button
          type="button"
          className="tch-crew__more"
          onClick={() => setExpanded(false)}
          data-testid="crew-card-fewer"
        >
          Show fewer
        </button>
      ) : null}

      <footer className="tch-crew__foot">
        <span className="tch-crew__summary" data-testid="crew-card-summary">
          {summary.summaryLine}
        </span>
        {summary.needsYou > 0 ? (
          <button
            type="button"
            className="tch-crew__answer"
            onClick={onRespond}
            disabled={!onRespond}
            title={onRespond ? undefined : NO_HANDLER_REASON}
          >
            {/* The asking helper's own words when it has them (design §7:
                the affordance resolves the question in place), and a plain
                verb when it does not. */}
            {summary.rows.find((row) => row.words.mayInterrupt)?.action?.label ?? 'Answer'}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

function CrewCardRow({
  row,
  onHelperAction,
}: {
  row: CrewRow;
  onHelperAction?: ((helper: { key: string; role: string }) => void) | undefined;
}) {
  const words = row.words;
  return (
    <li className="tch-crew__row" data-testid="crew-card-row" data-tone={words.tone}>
      <Avatar
        actorId={row.role}
        provenance="agent"
        label={row.role}
        initials={row.monogram}
        size={22}
      />
      <div className="tch-crew__body">
        <div className="tch-crew__who">{row.role}</div>
        {/* ONE plain-English line. For a running helper this is the live
            activity sentence when the host has one, and the state's own
            sentence when it does not — the substitution happens in the
            vocabulary, never here. */}
        <div className="tch-crew__what">{words.label}</div>

        {row.track !== 'none' ? (
          <div
            className="tch-crew__track"
            data-track={row.track}
            role="progressbar"
            aria-label={`${row.role} progress`}
            {...(row.progress !== null
              ? { 'aria-valuenow': Math.round(row.progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }
              : {})}
          >
            <span
              className="tch-crew__track-fill"
              style={{ width: `${Math.round((row.progress ?? 0) * 100)}%` }}
            />
          </div>
        ) : null}

        {/* P5 — EVERY DEAD END CARRIES A NEXT MOVE. The cause is already in
            the sentence above (the vocabulary joins it, and admits when it is
            missing), so all that is owed here is the one button. It renders
            even when the host supplied no action: a generic affordance is a
            way out, and nothing at all is not. */}
        {words.tone === 'stuck' ? (
          <div className="tch-crew__recovery">
            <button
              type="button"
              className="tch-crew__recovery-action"
              onClick={onHelperAction ? () => onHelperAction({ key: row.key, role: row.role }) : undefined}
              disabled={!onHelperAction}
              title={onHelperAction ? undefined : NO_HANDLER_REASON}
            >
              {row.action?.label ?? 'Look into it'}
            </button>
          </div>
        ) : null}
      </div>
      <Pill
        tone={pillToneOf(words.tone)}
        {...(words.tone === 'working' ? { dot: 'pulse' as const } : {})}
      >
        {words.pill}
      </Pill>
    </li>
  );
}
