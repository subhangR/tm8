import type { ModelSuggestion } from '@tm8/contract';

import { JevCostLine } from './JevCostLine';
import { JevGroupStatus } from './JevGroupStatus';
import { JevModelHint } from './JevModelHint';
import { JevRunBar } from './JevRunBar';
import type { JevGroupState, JevSuggestions } from './useJevSuggestions';

function tally(state: JevGroupState<{ items: readonly { entityId: string }[] }>, ticked: readonly string[]): string {
  if (state.status === 'ok') {
    const n = state.value.items.filter((item) => ticked.includes(item.entityId)).length;
    return `${String(n)}/${String(state.value.items.length)}`;
  }
  if (state.status === 'asking') return '…';
  if (state.status === 'skipped') return '0/0';
  return '—';
}

/**
 * The Run popup's compact Jev line (design §3.2): the top teammate, the model
 * with Apply, "Memories 5/14 · Skills 3/9 [Review]", and the run's cost. The
 * same hook and the same components as LaunchSheet, arranged for a card that
 * has no room for sections.
 */
export function JevStrip({ jev, roster, selectedTeammateId, onSelectTeammate, model, reviewOpen, onReview }: {
  jev: JevSuggestions;
  roster: readonly { id: string; name: string }[];
  selectedTeammateId: string | null;
  onSelectTeammate(id: string): void;
  model: { label: string; refusal: string | null; applied: boolean; onApply(s: ModelSuggestion): void };
  reviewOpen: boolean;
  onReview(): void;
}) {
  if (jev.state === 'idle') return null;
  if (jev.state === 'unavailable') {
    return (
      <div className="jev-strip" data-testid="jev-strip" onClick={(event) => event.stopPropagation()}>
        <span className="jev-mark">✦ Jev</span>
        <JevRunBar jev={jev} inline />
      </div>
    );
  }
  const teammates = jev.groups.teammates;
  const top = teammates.status === 'ok'
    ? [...teammates.value.items].sort((a, b) => b.score - a.score)[0]
    : undefined;
  const topOnRoster = top ? roster.find((t) => t.id === top.entityId) : undefined;
  return (
    <div className="jev-strip" data-testid="jev-strip" onClick={(event) => event.stopPropagation()}>
      <span className="jev-mark">✦ Jev</span>
      <span className="jev-strip__item" data-testid="jev-strip-teammate">
        Teammate:
        {teammates.status !== 'ok' ? (
          <JevGroupStatus group="teammates" state={teammates} onRetry={jev.retry} />
        ) : teammates.value.noFit || !top ? (
          <span data-testid="jev-nofit">Nobody fits well</span>
        ) : (
          <button
            type="button"
            className="jev-rank"
            data-testid={`jev-rank-${top.entityId}`}
            aria-pressed={top.entityId === selectedTeammateId}
            aria-disabled={topOnRoster ? undefined : true}
            title={topOnRoster ? `Launch as ${top.title}` : `${top.title} is not on this roster, so it can’t be picked here.`}
            onClick={() => { if (topOnRoster) onSelectTeammate(top.entityId); }}
          >
            <span className="jev-rank__name">{topOnRoster?.name ?? top.title}</span>
            <span className={`jev-level jev-level--${top.level}`}>{top.level}</span>
          </button>
        )}
      </span>
      <span className="jev-strip__item">
        Model:
        <JevModelHint
          compact
          state={jev.groups.model}
          label={model.label}
          refusal={model.refusal}
          applied={model.applied}
          onApply={model.onApply}
          onRetry={jev.retry}
        />
      </span>
      <span className="jev-strip__item" data-testid="jev-strip-counts">
        Memories {tally(jev.groups.memories, jev.ticked.memory)} · Skills {tally(jev.groups.skills, jev.ticked.skill)}
        <button
          type="button"
          className="jev-link"
          data-testid="jev-review"
          aria-expanded={reviewOpen}
          onClick={onReview}
        >
          Review
        </button>
      </span>
      {jev.run && jev.run.calls > 0 ? <JevCostLine run={jev.run} /> : null}
      <JevRunBar jev={jev} inline />
    </div>
  );
}
