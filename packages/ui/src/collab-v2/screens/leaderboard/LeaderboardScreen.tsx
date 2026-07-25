/**
 * Leaderboard screen (L5) — the ledger, read plainly.
 *
 * Scores (humans and agents on one ladder), the recent awards feed, and
 * per-task award breakdowns, all from `getLeaderboard` / `getAwards`. When a
 * completion award lands while you are watching, the recipient's row and its
 * feed item light up for a beat — tasteful, not casino: no confetti, no sound,
 * paper and ink and one brass flash.
 */
import { useMemo } from 'react';
import type { ShellViewProps } from '../../shell';
import { AwardBreakdowns, AwardsFeed } from './AwardsFeed';
import { ScoreRows } from './ScoreRows';
import {
  breakdownsByTask, useAwards, useCompletionMoment, useLedgerNonce, useScores,
} from './useLeaderboard';

export function LeaderboardScreen({ facade, spaceId, onOpenEntity }: ShellViewProps) {
  const nonce = useLedgerNonce(facade, spaceId);
  const scores = useScores(facade, spaceId, nonce);
  const awards = useAwards(facade, spaceId, nonce);

  const rows = useMemo(() => scores.value?.items ?? [], [scores.value]);
  const events = useMemo(() => awards.value?.items ?? [], [awards.value]);
  const breakdowns = useMemo(() => breakdownsByTask(events), [events]);
  const moment = useCompletionMoment(events, { ready: awards.value != null });

  const error = scores.error ?? awards.error;
  const loading = scores.loading || awards.loading;

  return (
    <div className="cv2-ld" data-testid="leaderboard-screen">
      <header className="cv2-ld__head">
        <span className="cv2-ld__glyph" aria-hidden="true">🏆</span>
        <span className="t-title">Leaderboard</span>
        <span className="t-secondary">
          points from completions and grants · humans and agents alike
        </span>
      </header>

      <div className="cv2-ld__body">
        {error && <div className="cv2-board__banner" role="alert">{error.message}</div>}
        {loading && rows.length === 0 && (
          <div className="cv2-collection__loading" role="status">loading…</div>
        )}

        {moment && (
          <div className="cv2-ld__moment" role="status" data-testid="completion-moment">
            <span className="cv2-ld__momentglyph" aria-hidden="true">◈</span>
            <span>
              <strong>{moment.recipient.displayName}</strong> was awarded{' '}
              <strong>{moment.amount} points</strong>
              {moment.ref ? ` for ${moment.ref.title}` : ''}.
            </span>
          </div>
        )}

        <section className="cv2-ld__section" aria-label="Scores">
          <span className="cv2-eyebrow">Scores</span>
          {rows.length === 0 && !loading
            ? <p className="cv2-empty-line">No scores yet — the ledger opens with the first award.</p>
            : (
              <ScoreRows
                rows={rows}
                onOpen={onOpenEntity}
                celebrating={moment?.recipient.id ?? null}
              />
            )}
        </section>

        <section className="cv2-ld__section" aria-label="Recent awards">
          <span className="cv2-eyebrow">Recent awards</span>
          <AwardsFeed awards={events} celebratingId={moment?.id ?? null} />
        </section>

        <section className="cv2-ld__section" aria-label="Per-task breakdowns">
          <span className="cv2-eyebrow">Per-task breakdowns</span>
          <AwardBreakdowns breakdowns={breakdowns} />
        </section>
      </div>
    </div>
  );
}
