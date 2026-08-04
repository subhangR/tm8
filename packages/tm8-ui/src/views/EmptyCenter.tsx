/**
 * EmptyCenter — what the workspace centre shows when nothing is open
 * (02-LAYOUT §2.2). Gate-blocking: it is part of the T0-1 master screen.
 *
 * The spec's own framing is the design rationale: *"The empty state doubles as
 * the live-session roster and teaches the grammar."* This is a deliberately
 * bounded triage view, not the full Sessions collection: attention first,
 * active terminals next, then only the most recent useful history.
 *
 * Two laws it renders under:
 *  - **Liveness is a VERDICT, never derived here** (D6/R-UI-5). Rows receive
 *    `livenessOf` and present it; the dot is SOLID because a liveness-derived
 *    mark may not animate (D31), and every status carries its WORD (C8/L10).
 *  - **No kind literal** (§15.2): rows arrive as `SessionRow`, already
 *    projected structurally by `toSessionRow`.
 */
import type { SessionLiveness } from '../data/seam';
import type { SessionRow } from '../terminal';
import { Avatar } from '../kit';

export interface EmptyCenterProps {
  /** The seam's live set — the same array the bar counts. */
  liveIds: readonly string[];
  /** Session rows, already projected and ordered by recent activity. */
  rows: readonly SessionRow[];
  /** THE verdict. Never computed in this component. */
  livenessOf: (id: string) => SessionLiveness;
  /** Sessions blocked on the viewer — dormant per R8, rendered when it fires. */
  attentionIds?: readonly string[];
  onFocusSession?(id: string): void;
}

/**
 * Verdict presentation remains separate from recorded lifecycle status. The
 * former decides whether a terminal is truly live; the latter places ended and
 * starting rows into their useful summary groups.
 */
type RosterTone = 'run' | 'wait' | 'idle' | 'block';

const VERDICT_WORD: Record<SessionLiveness, string> = {
  live: 'running',
  stale: 'stale — node restarted',
  'not-running': 'not running',
  unknown: 'unverified',
};

const VERDICT_TONE: Record<SessionLiveness, RosterTone> = {
  live: 'run',
  stale: 'wait',
  'not-running': 'idle',
  unknown: 'idle',
};

type RosterGroupId = 'attention' | 'running' | 'starting' | 'completed';

interface ImportantSession {
  row: SessionRow;
  verdict: SessionLiveness;
  attention: boolean;
}

interface RosterGroupConfig {
  id: RosterGroupId;
  label: string;
  /** Empty centre is a summary; the Sessions panel remains the full list. */
  limit: number;
}

const ROSTER_GROUPS: readonly RosterGroupConfig[] = [
  { id: 'attention', label: 'Needs attention', limit: 2 },
  { id: 'running', label: 'Running', limit: 3 },
  { id: 'starting', label: 'Starting', limit: 1 },
  { id: 'completed', label: 'Recently completed', limit: 2 },
];

function groupOf(session: ImportantSession): RosterGroupId | null {
  const { row, verdict, attention } = session;
  if (attention || verdict === 'stale' || (verdict === 'unknown' && row.recordedStatus === 'running')) {
    return 'attention';
  }
  if (verdict === 'live') return 'running';
  if (row.recordedStatus === 'spawning') return 'starting';
  if (row.recordedStatus === 'failed') return 'attention';
  if (row.recordedStatus === 'exited') return 'completed';

  // `idle` and records with no session status are collection history, not
  // actionable terminal activity. They remain available in Sessions.
  return null;
}

function presentationOf(session: ImportantSession): { word: string; tone: RosterTone } {
  const { row, verdict, attention } = session;
  if (attention) return { word: 'NEEDS YOU', tone: 'wait' };
  if (row.recordedStatus === 'failed') return { word: 'failed', tone: 'block' };
  if (verdict === 'live') return { word: 'running', tone: 'run' };
  if (verdict === 'stale') return { word: VERDICT_WORD.stale, tone: 'wait' };
  if (verdict === 'unknown') return { word: VERDICT_WORD.unknown, tone: 'idle' };
  if (row.recordedStatus === 'spawning') return { word: 'starting', tone: 'wait' };
  if (row.recordedStatus === 'exited') return { word: 'completed', tone: 'idle' };
  return { word: VERDICT_WORD[verdict], tone: VERDICT_TONE[verdict] };
}

export function EmptyCenter(props: EmptyCenterProps) {
  const { rows, livenessOf, liveIds } = props;
  const attentionIds = new Set(props.attentionIds ?? []);
  const grouped = new Map<RosterGroupId, ImportantSession[]>();

  for (const row of rows) {
    const session: ImportantSession = {
      row,
      verdict: livenessOf(row.id),
      attention: attentionIds.has(row.id),
    };
    const group = groupOf(session);
    if (!group) continue;
    const groupRows = grouped.get(group);
    if (groupRows) groupRows.push(session);
    else grouped.set(group, [session]);
  }

  const visibleGroups = ROSTER_GROUPS
    .map((config) => ({ config, sessions: grouped.get(config.id) ?? [] }))
    .filter(({ sessions }) => sessions.length > 0);

  return (
    <div className="shell-empty" data-testid="empty-center">
      <div className="shell-empty__inner">
        <div className="shell-empty__eyebrow kit-eyebrow">
          Terminal activity{liveIds.length > 0 ? ` · ${liveIds.length} live` : ''}
        </div>

        {visibleGroups.length === 0 ? (
          <div className="shell-empty__none">No active or recent terminals.</div>
        ) : (
          <div className="shell-empty__groups">
            {visibleGroups.map(({ config, sessions }) => {
              const visible = sessions.slice(0, config.limit);
              const hiddenCount = sessions.length - visible.length;
              return (
                <section
                  className="shell-empty__group"
                  key={config.id}
                  aria-labelledby={`empty-session-group-${config.id}`}
                  data-testid={`empty-session-group-${config.id}`}
                >
                  <h2
                    className="shell-empty__group-title"
                    id={`empty-session-group-${config.id}`}
                    aria-label={`${config.label}, ${sessions.length}`}
                  >
                    <span>{config.label}</span>
                    <span className="shell-empty__group-count">{sessions.length}</span>
                  </h2>
                  <ul className="shell-empty__roster">
                    {visible.map((session) => {
                      const { row, verdict } = session;
                      const presentation = presentationOf(session);
                      const meta = row.meta ?? row.provider;
                      return (
                        <li key={row.id}>
                          <button
                            type="button"
                            className="shell-empty__row"
                            onClick={() => props.onFocusSession?.(row.id)}
                            aria-label={[row.name, presentation.word, meta].filter(Boolean).join(', ')}
                          >
                            {/* Solid, never pulsing: this dot presents a liveness
                                verdict, never terminal byte activity (D31). */}
                            <span
                              className={`shell-empty__dot shell-empty__dot--${presentation.tone}`}
                              aria-hidden="true"
                            />
                            {row.actor ? (
                              <Avatar
                                actorId={row.actor.id}
                                provenance={row.actor.isAgent ? 'agent' : 'human'}
                                label={row.actor.displayName}
                                size={20}
                                src={row.actor.avatar ?? null}
                              />
                            ) : null}
                            <span className="shell-empty__name">{row.name}</span>
                            <span className={`shell-empty__word shell-empty__word--${presentation.tone}`}>
                              {presentation.word}
                            </span>
                            {meta && <span className="shell-empty__meta">{meta}</span>}
                            {/* Preserve the two-source truth only where it adds
                                information: a running record whose liveness is
                                stale or unverified. */}
                            {(verdict === 'stale' || verdict === 'unknown') && row.recordedStatus && (
                              <span className="shell-empty__record">record: {row.recordedStatus}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {hiddenCount > 0 ? (
                    <div className="shell-empty__more">
                      +{hiddenCount} more in Sessions
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}

        {/* The grammar lesson — 02-LAYOUT §2.2 verbatim in intent. These are
            the bindings the C6 contract guarantees everywhere (§7), so the hint
            stays true wherever the viewer goes next. */}
        <p className="shell-empty__hint">Click any task or session to open it here.</p>
        <p className="shell-empty__keys">
          <kbd className="kit-kbd">Esc</kbd> closes ·<kbd className="kit-kbd">p</kbd> pins ·
          <kbd className="kit-kbd">/</kbd> opens the palette
        </p>
      </div>
    </div>
  );
}
