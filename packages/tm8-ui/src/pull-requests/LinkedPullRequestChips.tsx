import { chipsForPullRequest, type LinkedPullRequestFacts, type PullRequestLifecycle } from './linked-pull-requests';
import './linked-pull-request-chips.css';

/**
 * THE CHIP IS AN ICON NOW (user ruling, 2026-08-13): GitHub's own visual
 * vocabulary — the pull-request octicon coloured by lifecycle (open green,
 * merged purple, closed red, draft grey) beside `#number`, and `CI` coloured
 * green/red when the observer holds a claim. The words "open"/"merged" said
 * what the colour already says; the full sentence lives in the tooltip.
 *
 * The state testids (`pr-state-chip`, `data-pr-state`) are PRESERVED on the
 * icon and the CI mark — every suite that pins the chip vocabulary keeps
 * reading the same facts from the same attributes.
 */

/** Octicon `git-pull-request` (16×16) — open, draft and closed wear this. */
const PR_ICON_PATH =
  'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 ' +
  '2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 ' +
  '0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 ' +
  '0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75' +
  '.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 ' +
  '0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z';

/** Octicon `git-merge` (16×16) — the merged state's own shape, like GitHub. */
const MERGE_ICON_PATH =
  'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 ' +
  '5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 ' +
  '1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 ' +
  '1 0 0-1.5.75.75 0 0 0 0 1.5ZM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Z';

function iconPathFor(lifecycle: PullRequestLifecycle): string {
  return lifecycle === 'merged' ? MERGE_ICON_PATH : PR_ICON_PATH;
}

export function LinkedPullRequestChips({
  pullRequests,
  placement,
}: {
  pullRequests: readonly LinkedPullRequestFacts[];
  placement: 'tile' | 'detail';
}) {
  if (pullRequests.length === 0) return null;

  return (
    <div
      className={`pr-chips pr-chips--${placement}`}
      data-testid="linked-pr-chips"
      data-placement={placement}
      aria-label="Linked pull requests"
    >
      {pullRequests.map((pullRequest) => {
        // The helper stays the single chip vocabulary; the tooltip carries the
        // words the icons replaced (lifecycle, conflict, CI verdict).
        const spoken = chipsForPullRequest(pullRequest).map((c) => c.label).join(' · ');
        // An INHERITED chip is a weaker claim than an authored one and must
        // read as one. A session inherits every PR of every task it worked on,
        // and 155 tasks have more than one session — so without this the tile
        // says "this session's PR" about a sibling's work. The provenance
        // sentence goes in the tooltip because the visual difference alone
        // cannot say WHY, and a reader who cares can hover.
        const provenance =
          pullRequest.attribution === 'authored' ? 'authored by this session'
          : pullRequest.attribution === 'inherited' ? 'via a task this session worked on — not necessarily its own work'
          : null;
        const tooltip = [
          `${pullRequest.repository} #${pullRequest.number} · ${pullRequest.title}`,
          spoken,
          provenance,
        ].filter(Boolean).join(' · ');
        const ci =
          pullRequest.ciStatus === 'passing' ? 'ci-green'
          : pullRequest.ciStatus === 'failing' ? 'ci-red'
          : null;
        const mark = (
          <>
            <svg
              className={`pr-chips__icon pr-chips__icon--${pullRequest.lifecycle}`}
              data-testid="pr-state-chip"
              data-pr-state={pullRequest.lifecycle}
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-label={`pull request ${pullRequest.lifecycle}`}
              role="img"
            >
              <path fillRule="evenodd" d={iconPathFor(pullRequest.lifecycle)} />
            </svg>
            <span className="pr-chips__number">#{pullRequest.number}</span>
          </>
        );
        return (
          <span
            className={`pr-chips__request pr-chips__request--${pullRequest.attribution}`}
            data-testid="linked-pr"
            data-pr-id={pullRequest.id}
            data-pr-number={pullRequest.number}
            data-pr-attribution={pullRequest.attribution}
            key={pullRequest.id}
            title={tooltip}
          >
            {pullRequest.url ? (
              <a
                className="pr-chips__ref"
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open pull request ${pullRequest.repository} number ${pullRequest.number}`}
              >
                {mark}
              </a>
            ) : (
              <span className="pr-chips__ref">{mark}</span>
            )}
            {ci !== null ? (
              <span
                className={`pr-chips__ci pr-chips__ci--${ci}`}
                data-testid="pr-state-chip"
                data-pr-state={ci}
                title={`${pullRequest.repository} #${pullRequest.number}: checks ${pullRequest.ciStatus}`}
              >
                CI
              </span>
            ) : null}
            {pullRequest.mergeState === 'conflicted' ? (
              <span
                className="pr-chips__conflict"
                data-testid="pr-state-chip"
                data-pr-state="conflict"
                title={`${pullRequest.repository} #${pullRequest.number}: merge conflict`}
                aria-label="merge conflict"
              >
                !
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
