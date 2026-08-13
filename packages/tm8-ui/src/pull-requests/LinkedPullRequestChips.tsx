import { Pill } from '../kit';
import { chipsForPullRequest, type LinkedPullRequestFacts } from './linked-pull-requests';
import './linked-pull-request-chips.css';

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
      {pullRequests.map((pullRequest) => (
        <span
          className="pr-chips__request"
          data-testid="linked-pr"
          data-pr-id={pullRequest.id}
          data-pr-number={pullRequest.number}
          key={pullRequest.id}
          title={`${pullRequest.repository} #${pullRequest.number} · ${pullRequest.title}`}
        >
          {pullRequest.url ? (
            <a
              className="pr-chips__ref"
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open pull request ${pullRequest.repository} number ${pullRequest.number}`}
            >
              {`PR #${pullRequest.number}`}
            </a>
          ) : (
            <span className="pr-chips__ref">{`PR #${pullRequest.number}`}</span>
          )}
          {chipsForPullRequest(pullRequest).map((chip) => (
            <span
              className="pr-chips__state"
              data-testid="pr-state-chip"
              data-pr-state={chip.state}
              key={chip.state}
            >
              <Pill tone={chip.tone} title={`${pullRequest.repository} #${pullRequest.number}: ${chip.label}`}>
                {chip.label}
              </Pill>
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}
