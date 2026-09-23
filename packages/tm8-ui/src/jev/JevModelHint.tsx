import type { LaunchSuggestGroup, ModelSuggestion } from '@tm8/contract';

import { JevCostLine } from './JevCostLine';
import { JevGroupStatus } from './JevGroupStatus';
import type { JevGroupState } from './useJevSuggestions';

/**
 * "✦ Jev: Claude Sonnet 5 · high · standard [Apply]", with Jev's reasons in a
 * disclosure. Apply sets the model, the tool and the effort TOGETHER through
 * the host's own setters; when the host says it cannot (`refusal`), Apply is
 * refused with that reason in words, never silently greyed.
 */
export function JevModelHint({ state, label, refusal, applied, onApply, onRetry, compact }: {
  state: JevGroupState<ModelSuggestion>;
  /** The catalog's words for the suggested model. */
  label: string;
  refusal: string | null;
  /** The surface already shows exactly this model, tool and effort. */
  applied: boolean;
  onApply(suggestion: ModelSuggestion): void;
  onRetry(group: LaunchSuggestGroup): void;
  compact?: boolean;
}) {
  if (state.status !== 'ok') return <JevGroupStatus group="model" state={state} onRetry={onRetry} />;
  const s = state.value;
  const blocked = Boolean(refusal) || applied;
  return (
    <div className="jev-hint" data-testid="jev-model-hint">
      <span className="jev-hint__line">
        <span className="jev-mark">✦ Jev:</span>{' '}
        <span className="jev-hint__value">{label} · {s.effort} · {s.tier}</span>
        <button
          type="button"
          className="jev-apply"
          data-testid="jev-model-apply"
          aria-disabled={blocked || undefined}
          title={refusal ?? (applied ? 'Already set to this model, tool and effort.' : `Set the model to ${label}, the tool to ${s.agentTool} and the effort to ${s.effort}.`)}
          onClick={(event) => {
            event.stopPropagation();
            if (blocked) return;
            onApply(s);
          }}
        >
          {applied ? 'Applied ✓' : 'Apply'}
        </button>
        {compact ? null : <JevCostLine cost={state.cost} />}
      </span>
      {refusal ? <span className="jev-hint__refusal" data-testid="jev-model-refusal">{refusal}</span> : null}
      {compact || s.reasons.length === 0 ? null : (
        <details className="jev-why">
          <summary>why</summary>
          <ul>{s.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
