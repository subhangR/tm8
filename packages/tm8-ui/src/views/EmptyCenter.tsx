/**
 * EmptyCenter — what the workspace centre shows when nothing is open
 * (02-LAYOUT §2.2). Gate-blocking: it is part of the T0-1 master screen.
 *
 * The spec's own framing is the design rationale: *"The empty state doubles as
 * the live-session roster and teaches the grammar."* So this is not a
 * placeholder or an illustration — it is the roster, plus the three keys that
 * make the rest of the screen operable. An empty centre that said "nothing
 * selected" would teach nothing and waste the one moment the viewer is looking
 * for what to do next.
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

export interface EmptyCenterProps {
  /** The seam's live set — the same array the bar counts. */
  liveIds: readonly string[];
  /** Roster rows, already projected. Ordered live-first by the caller. */
  rows: readonly SessionRow[];
  /** THE verdict. Never computed in this component. */
  livenessOf: (id: string) => SessionLiveness;
  /** Sessions blocked on the viewer — dormant per R8, rendered when it fires. */
  attentionIds?: readonly string[];
  onFocusSession?(id: string): void;
}

/**
 * The word for a verdict. Deliberately terse and deliberately NOT a second
 * authority: these are the same four states the registry names, and the row
 * additionally prints the record's own status when the seam says a session is
 * not live, so "exited" and "failed" stay distinguishable from each other.
 */
const VERDICT_WORD: Record<SessionLiveness, string> = {
  live: 'running',
  stale: 'stale — node restarted',
  'not-running': 'not running',
  unknown: 'unverified',
};

const VERDICT_TONE: Record<SessionLiveness, string> = {
  live: 'run',
  stale: 'wait',
  'not-running': 'idle',
  unknown: 'idle',
};

export function EmptyCenter(props: EmptyCenterProps) {
  const { rows, livenessOf, liveIds } = props;

  return (
    <div className="shell-empty" data-testid="empty-center">
      <div className="shell-empty__inner">
        <div className="shell-empty__eyebrow kit-eyebrow">
          Live sessions{liveIds.length > 0 ? ` · ${liveIds.length}` : ''}
        </div>

        {rows.length === 0 ? (
          // Honest empty, not a lie of precision: no sessions is a fact, and
          // it reads differently from "we could not tell you".
          <div className="shell-empty__none">No sessions on this node yet.</div>
        ) : (
          <ul className="shell-empty__roster">
            {rows.map((row) => {
              const verdict = livenessOf(row.id);
              const attention = props.attentionIds?.includes(row.id) ?? false;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="shell-empty__row"
                    onClick={() => props.onFocusSession?.(row.id)}
                  >
                    {/* Solid, never pulsing: this dot presents a LIVENESS
                        verdict, and only a pool activity signal attributed to
                        one identified session may animate (D31). */}
                    <span
                      className={`shell-empty__dot shell-empty__dot--${VERDICT_TONE[verdict]}`}
                      aria-hidden="true"
                    />
                    <span className="shell-empty__name">{row.name}</span>
                    <span className={`shell-empty__word shell-empty__word--${VERDICT_TONE[verdict]}`}>
                      {attention ? 'NEEDS YOU' : VERDICT_WORD[verdict]}
                    </span>
                    {row.meta && <span className="shell-empty__meta">{row.meta}</span>}
                    {/* When the seam says not-live, the RECORD's own status is
                        the only thing distinguishing exited from failed from
                        spawning — so it rides along rather than being flattened
                        into one grey word. */}
                    {verdict !== 'live' && row.recordedStatus && (
                      <span className="shell-empty__record">record: {row.recordedStatus}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
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
