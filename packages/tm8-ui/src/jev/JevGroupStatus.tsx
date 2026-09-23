import type { LaunchSuggestGroup } from '@tm8/contract';

import { FAILURE_WORDS, SKIP_WORDS } from './format';
import { JevCostLine } from './JevCostLine';
import type { JevGroupState } from './useJevSuggestions';

/**
 * A group that has not answered with suggestions: asking, failed (with its own
 * Retry), or skipped. One group's trouble is drawn in that group's section and
 * nowhere else — design rule 3, "one group failing never affects another".
 */
export function JevGroupStatus({ group, state, onRetry }: {
  group: LaunchSuggestGroup;
  state: JevGroupState<unknown>;
  onRetry(group: LaunchSuggestGroup): void;
}) {
  if (state.status === 'asking') {
    return (
      <p className="jev-status jev-status--asking" role="status" data-testid={`jev-${group}-status`} data-status="asking">
        <span className="jev-spin" aria-hidden="true" />
        ✦ Asking Jev…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className="jev-status jev-status--failed" role="status" data-testid={`jev-${group}-status`} data-status="failed">
        <span>✦ {FAILURE_WORDS[state.reason]}</span>
        {state.cost.calls > 0 ? <JevCostLine cost={state.cost} /> : null}
        {state.reason === 'no_key' ? null : (
          <button type="button" className="jev-link" data-testid={`jev-${group}-retry`} onClick={() => onRetry(group)}>
            Retry
          </button>
        )}
      </p>
    );
  }
  if (state.status === 'skipped') {
    return (
      <p className="jev-status" role="status" data-testid={`jev-${group}-status`} data-status="skipped">
        ✦ Skipped — {SKIP_WORDS[state.reason]}
      </p>
    );
  }
  return null;
}
