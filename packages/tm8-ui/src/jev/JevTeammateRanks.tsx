import type { LaunchSuggestGroup, TeammateSuggestion } from '@tm8/contract';

import { JevCostLine } from './JevCostLine';
import { JevGroupStatus } from './JevGroupStatus';
import type { JevGroupState } from './useJevSuggestions';

/**
 * Jev's top three teammates, each with its level, as buttons: a click SELECTS
 * that teammate through the host's own picker, exactly as a click in the
 * roster would. "Nobody fits well" when Jev found no fit — the three are still
 * listed, ranked, because a weak fit is still information.
 */
export function JevTeammateRanks({ state, selectedId, roster, onSelect, onRetry }: {
  state: JevGroupState<TeammateSuggestion>;
  selectedId: string | null;
  /** The teammates this surface can launch as. A suggestion outside it is refused with the reason. */
  roster: readonly { id: string; name: string }[];
  onSelect(id: string): void;
  onRetry(group: LaunchSuggestGroup): void;
}) {
  if (state.status !== 'ok') return <JevGroupStatus group="teammates" state={state} onRetry={onRetry} />;
  const top = [...state.value.items].sort((a, b) => b.score - a.score).slice(0, 3);
  return (
    <div className="jev-ranks" data-testid="jev-teammate-ranks">
      <span className="jev-mark">✦ Jev:</span>
      {state.value.noFit ? <span className="jev-ranks__nofit" data-testid="jev-nofit">Nobody fits well</span> : null}
      <ol className="jev-ranks__list">
        {top.map((item, index) => {
          const onRoster = roster.find((t) => t.id === item.entityId);
          const on = item.entityId === selectedId;
          return (
            <li key={item.entityId}>
              <button
                type="button"
                className="jev-rank"
                data-testid={`jev-rank-${item.entityId}`}
                aria-pressed={on}
                aria-disabled={onRoster ? undefined : true}
                title={onRoster ? `Launch as ${item.title}` : `${item.title} is not on this surface’s roster, so it can’t be picked here.`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (onRoster) onSelect(item.entityId);
                }}
              >
                <span className="jev-rank__n">{index + 1}</span>
                <span className="jev-rank__name">{onRoster?.name ?? item.title}</span>
                <span className={`jev-level jev-level--${item.level}`}>{item.level}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <JevCostLine cost={state.cost} />
    </div>
  );
}
