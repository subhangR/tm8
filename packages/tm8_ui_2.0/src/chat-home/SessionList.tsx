/**
 * THE SESSION LIST — Home's "what is happening right now" column.
 *
 * Renders `ChatSessionRow`, a contract that has existed since 2026-08-15 and
 * has had NO renderer since the tab-era rows were retired. The type outlived
 * the thing that drew it, so this is assembly against a settled contract rather
 * than a new design — which is why it does not invent a row shape.
 *
 * IT RE-DERIVES NOTHING. The contract's own docblock is emphatic: `statusWord`
 * and `tone` are composed BY THE HOST from the liveness verdict, because
 * `execution.liveness` is the only authority for "live" and a stored `running`
 * with no live process is stale. This module renders the words it is given.
 *
 * AND THE TRAP THE CONTRACT NAMES, which is the one to get right: **`idle` is a
 * LEGAL LIVE STATE.** An idle session is running, just quiet. So `live` is read
 * from the boolean the host composed and NEVER inferred from the status word —
 * `statusWord !== 'idle'` would paint a running session as dead, which is the
 * same class of lie as claiming a space is empty while the read is in flight.
 */
import type { ReactNode } from 'react';

import type { HomeRegion } from './home-dashboard';
import type { ChatSessionRow } from './types';

export interface SessionListProps {
  /** Three states, structurally. `rows` does not exist until `loaded`. */
  region: HomeRegion<ChatSessionRow>;
  /** The sentence for pending/failed, from `homeRegionNote`. */
  note: string | null;
  /**
   * SELECTION IS A VERB, NOT A MOUNT. The row reports which session was chosen
   * and the surface that owns the layout mounts the terminal with it. Keeping
   * the terminal's single mount point in the layout stops this list growing a
   * second responsibility, and stops two places disagreeing about which session
   * is open.
   */
  onSelectSession?: ((sessionId: string) => void) | undefined;
  /** The id currently shown elsewhere, so the row can mark itself. */
  selectedSessionId?: string | null;
  /**
   * CAPACITY — `used`, NOT `free`. Read this before wiring it.
   *
   * The target draws `13/30`, which is USED/TOTAL. The type the rest of this
   * package passes around is FREE-based:
   *
   *     domain/launch.ts:335   interface LaunchCapacity { slotsFree; slotsTotal }
   *     domain/launch.ts:457   `${c.slotsFree} of ${c.slotsTotal} session slots free`
   *
   * So handing `LaunchCapacity` straight to this footer renders **17/30 where
   * the design says 13/30** — a plausible number, inverted, and nothing on
   * screen says so. The host converts, and `GateApp.tsx:1422` already shows the
   * one line that does it:
   *
   *     used: capacity.slotsTotal - capacity.slotsFree
   *
   * `limit` IS NULLABLE FOR A REAL CASE, not out of caution. `launch.ts` treats
   * `slotsTotal >= EFFECTIVELY_UNLIMITED_SLOTS` (100_000) as "no session limit"
   * and drops the denominator itself. A node with no cap must render the count
   * alone — a ceiling of 100000 is not a ceiling, it is noise, and inventing a
   * 30 would be a number that looks measured and is not.
   */
  capacity?: { used: number; limit: number | null } | undefined;
  /** Rendered above the rows — the search box and the status tabs, both owned elsewhere. */
  children?: ReactNode;
}

export function SessionList({
  region,
  note,
  onSelectSession,
  selectedSessionId,
  capacity,
  children,
}: SessionListProps) {
  return (
    <div className="tch-sessions">
      {children}
      {/* THREE STATES, AND THE EMPTY SENTENCE IS REACHABLE FROM EXACTLY ONE.
          `region.items` does not exist outside the loaded arm, so "No sessions"
          cannot be rendered from a length while a read is in flight — the type
          forbids it rather than a comment asking. */}
      {region.status !== 'loaded' ? (
        <p className="tch-sessions__note" role="status">
          {note}
        </p>
      ) : region.items.length === 0 ? (
        <p className="tch-sessions__note">No sessions in this space.</p>
      ) : (
        <ul className="tch-sessions__rows">
          {region.items.map((row) => (
            <SessionRow
              key={row.id}
              row={row}
              selected={row.id === selectedSessionId}
              onSelect={onSelectSession}
            />
          ))}
        </ul>
      )}
      {capacity ? <SessionSlots capacity={capacity} /> : null}
    </div>
  );
}

/**
 * The `13/30` footer. Renders the denominator ONLY when a limit is known —
 * see `SessionListProps.capacity`.
 */
function SessionSlots({ capacity }: { capacity: { used: number; limit: number | null } }) {
  const { used, limit } = capacity;
  const ratio = limit !== null && limit > 0 ? Math.min(1, used / limit) : null;
  return (
    <div className="tch-slots">
      <span className="tch-slots__label">Session slots</span>
      <span className="tch-slots__count">{limit === null ? `${used}` : `${used}/${limit}`}</span>
      {ratio === null ? null : (
        <div
          className="tch-slots__bar"
          role="progressbar"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit ?? undefined}
        >
          <div className="tch-slots__fill" style={{ inlineSize: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export interface SessionRowProps {
  row: ChatSessionRow;
  selected: boolean;
  onSelect?: ((sessionId: string) => void) | undefined;
}

export function SessionRow({ row, selected, onSelect }: SessionRowProps) {
  return (
    <li
      className={`tch-srow${row.live ? ' tch-srow--live' : ''}${selected ? ' tch-srow--on' : ''}`}
    >
      <button
        type="button"
        className="tch-srow__main"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect ? () => onSelect(row.id) : undefined}
        disabled={!onSelect}
      >
        <span className="tch-srow__title">{row.title}</span>
        {row.detail ? (
          <span className="tch-srow__detail">
            {row.detail}
            {/* THE DOT IS THE LIVE VERDICT, not the status word. See the file
                docblock: an `idle` session is live and keeps its dot. */}
            {row.live ? <span className="tch-srow__dot" aria-hidden /> : null}
          </span>
        ) : null}
        <span className="tch-srow__status">{row.statusWord}</span>
        {row.viewOnly ? <span className="tch-srow__viewonly">view only</span> : null}
      </button>
      {/* SIBLING OF THE BUTTON, NEVER INSIDE IT. `badges` carries real anchors
          for the PR chips and an <a> cannot nest in a <button>. The contract
          says so and it is a real HTML constraint, not a style choice. */}
      {row.badges ? <div className="tch-srow__badges">{row.badges}</div> : null}
    </li>
  );
}
