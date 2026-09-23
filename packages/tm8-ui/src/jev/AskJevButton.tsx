import type { JevOverallState } from './useJevSuggestions';

/**
 * ✦ Ask Jev — beside Dispatch and Launch on both surfaces.
 *
 * Asking never withholds Launch (design §3.3): a launch while Jev is still
 * answering goes out with today's defaults. So this button only guards
 * ITSELF against a double press, and says "Asking…" while it waits.
 *
 * Refused WITH A REASON when the surface has no Jev port, never hidden — a
 * missing button would claim this node has no Jev at all.
 */
export function AskJevButton({ state, askRefusal, onAsk, className }: {
  state: JevOverallState;
  askRefusal: string | null;
  onAsk(): void;
  className?: string;
}) {
  const asking = state === 'asking';
  return (
    <button
      type="button"
      className={`jev-ask ${className ?? ''}`}
      data-testid="jev-ask"
      aria-disabled={askRefusal || asking ? true : undefined}
      aria-busy={asking || undefined}
      title={askRefusal ?? 'Ask Jev for a model, a teammate and the memories and skills this work needs. Nothing changes until you apply or tick it.'}
      onClick={(event) => {
        event.stopPropagation();
        if (askRefusal || asking) return;
        onAsk();
      }}
    >
      {asking ? 'Asking…' : '✦ Ask Jev'}
    </button>
  );
}
