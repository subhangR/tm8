import type { EntitySuggestion, LaunchSuggestGroup } from '@tm8/contract';

import { SOURCE_WORDS } from './format';
import { JevCostLine } from './JevCostLine';
import { JevGroupStatus } from './JevGroupStatus';
import type { JevGroupState, JevTickKind } from './useJevSuggestions';

/**
 * ONE CHECKLIST for memories AND skills, on LaunchSheet and in the Run popup's
 * Review drawer alike — so the two surfaces cannot drift in what a tick means.
 *
 * The ticks ARE THE EXACT SET (Q1, default exact): what is ticked is what the
 * session carries, replacing the teammate's own set. The header says so, every
 * row shows its level and every source it came from, and the 33rd memory is
 * refused with the reason rather than accepted and then rejected by the node.
 */
export function JevChecklist({ kind, state, ticked, refusal, onToggle, onRetry }: {
  kind: JevTickKind;
  state: JevGroupState<EntitySuggestion>;
  ticked: readonly string[];
  /** The last refused tick, if it was in this list. */
  refusal: { id: string; reason: string } | null;
  onToggle(id: string): void;
  onRetry(group: LaunchSuggestGroup): void;
}) {
  const group: LaunchSuggestGroup = kind === 'memory' ? 'memories' : 'skills';
  const noun = kind === 'memory' ? 'Memories' : 'Skills';
  if (state.status !== 'ok') {
    return (
      <div className="jev-list" data-testid={`jev-checklist-${kind}`}>
        <JevGroupStatus group={group} state={state} onRetry={onRetry} />
      </div>
    );
  }
  const { items, considered, total } = state.value;
  const tickedHere = items.filter((item) => ticked.includes(item.entityId)).length;
  return (
    <div className="jev-list" data-testid={`jev-checklist-${kind}`} role="group" aria-label={`${noun} for this session`}>
      <div className="jev-list__head">
        <span className="jev-mark" data-testid={`jev-${kind}-count`}>
          ✦ {tickedHere} of {items.length} ticked · exact set
        </span>
        {considered < total ? (
          <span className="jev-list__considered" data-testid={`jev-${kind}-considered`}>
            {considered} of {total} considered
          </span>
        ) : null}
        <JevCostLine cost={state.cost} />
      </div>
      {refusal ? <p className="jev-list__refusal" role="alert" data-testid={`jev-${kind}-refusal`}>{refusal.reason}</p> : null}
      {items.length === 0 ? <p className="jev-status">✦ Jev ranked nothing here.</p> : null}
      <ul className="jev-list__rows">
        {items.map((item) => {
          const on = ticked.includes(item.entityId);
          return (
            <li key={item.entityId}>
              <label className={`jev-row ${on ? 'jev-row--on' : ''}`} data-testid={`jev-row-${item.entityId}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(item.entityId)}
                  aria-describedby={refusal?.id === item.entityId ? `jev-${kind}-refusal` : undefined}
                />
                <span className="jev-row__title" title={item.title}>{item.title}</span>
                <span className="jev-row__meta">
                  <span className={`jev-level jev-level--${item.level}`}>{item.level}</span>
                  <span className="jev-row__sources">{item.sources.map((s) => SOURCE_WORDS[s]).join(' · ')}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
