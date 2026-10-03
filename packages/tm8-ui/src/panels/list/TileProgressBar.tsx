import type { TileProgress } from '../../domain/types';

/**
 * A ROW'S PROGRESS, AT ITS RIGHT EDGE — a short bar and an `n/m` figure in
 * the badge slot, so a list of stories reads as how far along each one is
 * without opening any of them (user request on the story list, 2026-10-03:
 * "a small linear progress bar to the right of the tile").
 *
 * The bar is stacked, not a single fill: done, then in progress, then
 * blocked, over the track. Same disjoint bands the story page's rail draws,
 * so the tile and the page cannot tell two stories about one row.
 *
 * Nothing to count draws NOTHING — `work === 0` is "no work yet", not 0%.
 */
export function TileProgressBar({ progress }: { progress: TileProgress }) {
  const { done, work } = progress;
  if (work <= 0) return null;
  const share = (n: number | undefined): number => Math.max(0, Math.min(100, (100 * (n ?? 0)) / work));
  const donePct = share(done);
  const activePct = Math.min(share(progress.inProgress), 100 - donePct);
  const blockedPct = Math.min(share(progress.blocked), 100 - donePct - activePct);
  const noun = progress.noun ?? 'items';
  const parts = [`${done} of ${work} ${noun} done`];
  if (progress.inProgress) parts.push(`${progress.inProgress} in progress`);
  if (progress.blocked) parts.push(`${progress.blocked} blocked`);
  const label = parts.join(' · ');
  return (
    <span
      className={done >= work ? 'lp__progress lp__progress--done' : 'lp__progress'}
      role="img"
      aria-label={label}
      title={label}
      data-testid="tile-progress"
    >
      <span className="lp__progress-track" aria-hidden>
        <span className="lp__progress-seg lp__progress-seg--done" style={{ width: `${donePct}%` }} />
        {activePct > 0 ? (
          <span className="lp__progress-seg lp__progress-seg--active" style={{ width: `${activePct}%` }} />
        ) : null}
        {blockedPct > 0 ? (
          <span className="lp__progress-seg lp__progress-seg--blocked" style={{ width: `${blockedPct}%` }} />
        ) : null}
      </span>
      <span className="lp__progress-figure" aria-hidden>
        {done}/{work}
      </span>
    </span>
  );
}
