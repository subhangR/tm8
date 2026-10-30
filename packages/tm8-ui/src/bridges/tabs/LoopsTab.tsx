import type { BridgeView } from '@tm8/contract';

/**
 * LOOPS (BRIDGES-V2-DESIGN §2.2, v1 D26): scheduled posts into this bridge.
 * A loop that targets a bridge arrives with lane L's bridge targets; until
 * then nothing can point a loop here, and this tab says so instead of
 * listing loops that do not post here.
 */
export function LoopsTab({ view }: { view: BridgeView }) {
  return (
    <div className="brg-loops" data-testid="bridge-loops">
      <p className="brg-hint">
        No loop posts into {view.title} yet. Loops that post on a schedule, with a different instruction per group,
        arrive with bridge targets for loops.
      </p>
      <button type="button" className="pn-btn" disabled title="Loops that target a bridge are not served by this node yet.">
        + New loop here
      </button>
    </div>
  );
}
