/**
 * Score rows — humans and agents on one ladder, ranked by ledger sum.
 *
 * The bar is proportional to the leader's score, and the actor is drawn by the
 * kit `Avatar` (round for humans, rounded-square for agents), so provenance
 * reads at a glance without a kind branch anywhere.
 */
import { Avatar } from '../../kit';
import type { EntityId, LeaderboardRow } from '../../types/contract';

export interface ScoreRowsProps {
  rows: LeaderboardRow[];
  /** Open an actor's profile. */
  onOpen: (id: EntityId) => void;
  /** Actor id celebrating a fresh award — flashes for a beat. */
  celebrating?: EntityId | null;
}

export function ScoreRows({ rows, onOpen, celebrating }: ScoreRowsProps) {
  const top = rows.reduce((max, r) => Math.max(max, r.score), 0);

  return (
    <ol className="cv2-ld__rows">
      {rows.map((row) => {
        const pct = top > 0 ? Math.round((row.score / top) * 100) : 0;
        return (
          <li
            key={row.actor.id}
            className="cv2-ld__row"
            data-rank={row.rank}
            data-celebrating={row.actor.id === celebrating || undefined}
          >
            <button
              type="button"
              className="cv2-ld__rowbtn"
              onClick={() => onOpen(row.actor.id)}
              title={`Open ${row.actor.displayName}`}
            >
              <span className="t-mono cv2-ld__rank">{row.rank}</span>
              <Avatar actor={row.actor} size={24} />
              <span className="cv2-ld__name">{row.actor.displayName}</span>
              <span className="t-mono cv2-ld__tag">{row.actor.isAgent ? 'agent' : 'human'}</span>
              <span className="cv2-ld__bar" aria-hidden="true">
                <span className="cv2-ld__barfill" style={{ width: `${pct}%` }} />
              </span>
              <span className="t-mono cv2-ld__pts">{row.score} pts</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
