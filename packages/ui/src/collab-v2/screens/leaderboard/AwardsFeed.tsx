/**
 * Recent awards + per-task breakdowns.
 *
 * A point event is rendered as a sentence whose nouns are live entity chips:
 * the recipient, and the task the award came from. Both are `ChipById`, so
 * they hover to Z2 and click into a panel like every other chip in the app.
 */
import { ChipById } from '../../entity';
import { Avatar, Timestamp } from '../../kit';
import type { PointEventView } from '../../types/contract';
import type { AwardBreakdown } from './useLeaderboard';

export interface AwardsFeedProps {
  awards: PointEventView[];
  /** Award id currently celebrating — flashes for a beat. */
  celebratingId?: string | null;
}

export function AwardsFeed({ awards, celebratingId }: AwardsFeedProps) {
  if (awards.length === 0) {
    return <p className="cv2-empty-line">No awards yet — complete a task to open the ledger.</p>;
  }
  return (
    <ol className="cv2-ld__feed">
      {awards.map((award) => (
        <li
          key={award.id}
          className="cv2-ld__award"
          data-celebrating={award.id === celebratingId || undefined}
        >
          <span className="cv2-ld__awardglyph" aria-hidden="true">◈</span>
          <span className="t-mono cv2-ld__amount">+{award.amount}</span>
          <Avatar actor={award.recipient} size={18} />
          <ChipById entityId={award.recipient.id} />
          {award.ref && (
            <>
              <span className="cv2-ld__awardfor">for</span>
              <ChipById entityId={award.ref.id} />
            </>
          )}
          <span className="cv2-ld__awardspace" />
          <Timestamp className="t-mono cv2-ld__when" at={award.createdAt} />
        </li>
      ))}
    </ol>
  );
}

export interface AwardBreakdownsProps { breakdowns: AwardBreakdown[] }

/** Per-task rollups: what a completion paid out, and to whom. */
export function AwardBreakdowns({ breakdowns }: AwardBreakdownsProps) {
  if (breakdowns.length === 0) {
    return <p className="cv2-empty-line">No completions have paid out yet.</p>;
  }
  return (
    <div className="cv2-ld__breakdowns">
      {breakdowns.map((b) => (
        <details key={b.taskId} className="cv2-ld__breakdown" data-task={b.taskId}>
          <summary className="cv2-ld__breakdownhead">
            <ChipById entityId={b.taskId} />
            <span className="cv2-ld__awardspace" />
            <span className="t-mono cv2-ld__amount">{b.total} pts</span>
            <span className="t-mono cv2-ld__when">
              {b.awards.length} recipient{b.awards.length === 1 ? '' : 's'}
            </span>
          </summary>
          <ul className="cv2-ld__breakdownlist">
            {b.awards.map((award) => (
              <li key={award.id} className="cv2-ld__breakdownrow">
                <Avatar actor={award.recipient} size={18} />
                <span className="cv2-ld__name">{award.recipient.displayName}</span>
                <span className="cv2-ld__awardspace" />
                <span className="t-mono cv2-ld__amount">+{award.amount}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
