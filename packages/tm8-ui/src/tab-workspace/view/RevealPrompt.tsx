/**
 * The blocking interaction prompt: the scope reveal choice (Spec A §7) and
 * the unsaved-changes confirmation (§6). Renders `state.pending`; answers go
 * through `interactions.resolve`. Workstream D (reveal) / C (unsaved).
 */
import { getKindAdapter } from '../adapters/registry';
import type { InteractionChoice } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';

export function RevealPrompt() {
  const { dispatch } = useWorkspace();
  const pending = useWorkspaceState((s) => s.pending);
  if (!pending) return null;
  const plural = pending.targetKind ? getKindAdapter(pending.targetKind).nounPlural : '';
  const label: Record<InteractionChoice, string> = {
    addType: `Add ${plural} and open`,
    useMixed: 'Use Mixed and open',
    cancel: 'Cancel',
    discard: 'Discard draft',
    keep: 'Keep editing',
  };
  return (
    <div className="tws-prompt" role="dialog" aria-modal="false" data-testid="tws-prompt" data-reason={pending.reason}>
      {pending.reason === 'unsaved_changes' ? <p>Discard draft?</p> : null}
      {pending.choices.map((choice) => (
        <button
          key={choice}
          type="button"
          className="tws-quiet-btn"
          onClick={() =>
            dispatch({
              command: 'workspace.interactions.resolve',
              args: { interactionId: pending.id, choice },
              source: 'click',
            })
          }
        >
          {label[choice]}
        </button>
      ))}
    </div>
  );
}
