import { useState } from 'react';
import type { SessionLiveness } from '../data/seam';
import { Avatar } from '../kit';
// Imported through the barrel, not by deep path: the barrel carries the
// terminal stylesheet, so anything that renders this bar gets its styles.
import {
  AlwaysDark,
  presentSession,
  presentationStyle,
  type SessionPresentation,
  type SessionRow,
} from '../terminal';
import { RosterPopover } from './RosterPopover';

/**
 * THE LIVE-SESSION BAR (T0-5) — "a running agent is never invisible."
 *
 * A fixed 30px row at the top of the centre stage. It never scrolls away and
 * never collapses; T0-2 calls it the app's heartbeat line. Dark graphite in
 * both themes, because it belongs to the terminal family.
 *
 * WHERE N COMES FROM (B7, the kind-literal-free law). N is every live
 * work_session in the space, and it is read from the SEAM LIVENESS SNAPSHOT's
 * live set — which IS the set of live work_session ids by the C-1 definition
 * of that read. No shell code issues `query({ kinds: [...] })`; a kind literal
 * in this file is a §15.2 build failure. Rows arrive already projected
 * (`SessionRow`), so nothing here inspects an `EntityState`.
 *
 * THREE CLICK TARGETS, and only three: the name raises that session, the
 * count opens the roster, the attention chip jumps to the session that needs
 * you. Attention OUTRANKS focus — it shows even while you are deep inside
 * another terminal, because an agent blocked on a human is the more
 * actionable fact.
 */

export interface LiveSessionBarProps {
  /** `LivenessSnapshot.liveEntityIds` — the live set, verbatim. */
  liveIds: readonly string[];
  /** The session whose terminal is currently hosted, if any. */
  focusedId?: string | null;
  /** Row lookup — a domain-store selector projected to `SessionRow`. */
  resolve: (id: string) => SessionRow | undefined;
  /** THE verdict, from `seam.liveness.statusOf`. Never computed here. */
  livenessOf: (id: string) => SessionLiveness;
  /** Pool activity signal, per session. Gated on the verdict downstream. */
  activity?: Readonly<Record<string, boolean>>;
  /** Sessions blocked on the user. Dormant per R8; fixture-driven for now. */
  attentionIds?: readonly string[];
  /** Recently-ended sessions for the roster's third group. */
  recentlyExited?: readonly SessionRow[];
  onFocusSession?: (id: string) => void;
  onRunTask?: () => void;
}

export function LiveSessionBar({
  liveIds,
  focusedId,
  resolve,
  livenessOf,
  activity = {},
  attentionIds = [],
  recentlyExited = [],
  onFocusSession,
  onRunTask,
}: LiveSessionBarProps) {
  const [rosterOpen, setRosterOpen] = useState(false);

  const liveCount = liveIds.length;
  const focused = focusedId ? resolve(focusedId) : undefined;
  const attentionId = attentionIds.find((id) => id !== focusedId);
  const attention = attentionId ? resolve(attentionId) : undefined;

  const focusedPresentation: SessionPresentation | null = focused
    ? presentSession({
        liveness: livenessOf(focused.id),
        recordedStatus: focused.recordedStatus,
        streaming: activity[focused.id],
        needsAttention: attentionIds.includes(focused.id),
      })
    : null;

  return (
    <AlwaysDark>
      <div className="live-bar" data-testid="live-session-bar">
        <BarDot presentation={focusedPresentation} anySessions={liveCount > 0} />

        {focused && focusedPresentation ? (
          <>
            {focused.actor ? (
              <Avatar
                actorId={focused.actor.id}
                provenance={focused.actor.isAgent ? 'agent' : 'human'}
                label={focused.actor.displayName}
                size={20}
                src={focused.actor.avatar ?? null}
              />
            ) : null}
            <button
              type="button"
              className={
                presentationStyle(focusedPresentation).isLive
                  ? 'live-bar__name'
                  : 'live-bar__name live-bar__name--ended'
              }
              onClick={() => onFocusSession?.(focused.id)}
              title={`Raise ${focused.name}`}
            >
              {focused.name}
            </button>
            {/* An exited focused session keeps its name and gains recency —
                the panel does not silently empty when a session ends. */}
            {!presentationStyle(focusedPresentation).isLive && focused.meta ? (
              <span className="live-bar__recency">{focused.meta}</span>
            ) : null}
          </>
        ) : (
          <span className="live-bar__idle-text" data-testid="live-bar-idle">
            {liveCount > 0 ? 'no focused session' : 'no sessions running'}
          </span>
        )}

        {liveCount > 0 ? (
          <button
            type="button"
            className="live-bar__count"
            onClick={() => setRosterOpen((o) => !o)}
            aria-expanded={rosterOpen}
            aria-haspopup="menu"
            data-testid="live-bar-count"
          >
            {`— ${liveCount} live`}
          </button>
        ) : null}

        <span className="term-strip__spacer" />

        {attention ? (
          <button
            type="button"
            className="live-bar__attention"
            onClick={() => onFocusSession?.(attention.id)}
            data-testid="live-bar-attention"
          >
            <span className="term-dot term-dot--attention term-dot--pulse" aria-hidden />
            {attention.actor ? (
              <Avatar
                actorId={attention.actor.id}
                provenance={attention.actor.isAgent ? 'agent' : 'human'}
                label={attention.actor.displayName}
                size={20}
                src={attention.actor.avatar ?? null}
              />
            ) : null}
            {`${attention.name} needs you`}
          </button>
        ) : null}

        {liveCount > 0 ? (
          <button
            type="button"
            className="live-bar__roster-btn"
            onClick={() => setRosterOpen((o) => !o)}
            aria-expanded={rosterOpen}
            aria-haspopup="menu"
          >
            roster ▾
          </button>
        ) : (
          /* Zero live is a TEACHING state, not an empty one: the bar offers
             the gesture that creates the thing it is missing. */
          <button type="button" className="live-bar__run-btn" onClick={onRunTask}>
            run a task ▸
          </button>
        )}

        {rosterOpen ? (
          <RosterPopover
            liveIds={liveIds}
            attentionIds={attentionIds}
            recentlyExited={recentlyExited}
            resolve={resolve}
            livenessOf={livenessOf}
            activity={activity}
            onSelect={(id) => {
              setRosterOpen(false);
              onFocusSession?.(id);
            }}
            onDismiss={() => setRosterOpen(false)}
          />
        ) : null}
      </div>
    </AlwaysDark>
  );
}

/**
 * The bar's dot uses the same grammar as the strip and the roster, one size
 * up — learned once, read everywhere. The two no-session states are
 * distinguished: solid grey means "sessions exist, none focused"; hollow grey
 * means "nothing is running at all".
 */
function BarDot({
  presentation,
  anySessions,
}: {
  presentation: SessionPresentation | null;
  anySessions: boolean;
}) {
  if (!presentation) {
    return (
      <span
        className={
          anySessions
            ? // sessions exist, none focused: solid grey — something is there
              'live-bar__dot live-bar__dot--idle'
            : // nothing running at all: hollow grey — the absence is the state
              'live-bar__dot term-dot--ended'
        }
        aria-hidden
        data-testid="live-bar-dot"
      />
    );
  }
  const s = presentationStyle(presentation);
  const cls = [
    'live-bar__dot',
    s.dot === 'hollow'
      ? 'term-dot--ended'
      : s.tone === 'run'
        ? 'term-dot--live'
        : s.tone === 'wait'
          ? 'term-dot--attention'
          : 'term-dot--ended',
    s.pulse ? 'term-dot--pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <span className={cls} aria-hidden data-testid="live-bar-dot" />;
}
