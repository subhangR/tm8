/**
 * THE ENTITY TRAY, after the ledger panel (S4, design 01a023e1) — a TABS
 * STRIP and nothing else: the Chat tab that is the way back from a stage
 * (Cockpit ruling 2026-08-18, standing), and the Graph stage tab.
 *
 * WHAT LEFT, AND WHERE IT WENT:
 *  · The entity chips are gone from this row. The thread's entities live in
 *    the LEDGER PANEL below (`LedgerPanel`), projected from the same fold the
 *    transcript lines render — a tree with a scope picker, not a chip strip.
 *    The chips' CSS left with them (css-coverage holds both directions).
 *  · The FLEET TAB is absorbed (ruling 11): a sessions-scoped ledger panel IS
 *    the fleet, so a tab that opened the same list twice is redundant. The
 *    `?stage=fleet` address keeps working for links already in the wild; only
 *    the tab is gone. Graph stays a stage — a canvas is not a tree.
 *
 * The honesty rule is unchanged and now gates the whole strip: absent
 * handlers ⇒ nothing renders, never a dead control. `MobileShell` wires no
 * handlers, so the phone draws nothing here — the 01a01c91 revert holds with
 * no device special-case.
 */
import type { CockpitStage } from '../routes/types';

export function EntityTray({
  onStage,
  activeStage = null,
  activeEntityId = null,
  onShowChat,
  chatBusy = false,
}: {
  /** Swap to a non-entity stage, or back to the chat with `null`. Absent ⇒
   *  no stage tab — never a dead control. */
  onStage?: ((next: CockpitStage | null) => void) | undefined;
  /** Which stage is up, so its tab draws active and the Chat tab does not. */
  activeStage?: CockpitStage | null | undefined;
  /** The entity currently occupying the stage — the Chat tab then reads
   *  inactive and is the way back. */
  activeEntityId?: string | null | undefined;
  /** The way back (Cockpit ruling 2026-08-18): a Chat tab, always first.
   *  Absent ⇒ this host has no stage to come back from, no tab drawn. */
  onShowChat?: (() => void) | undefined;
  /** The thread is streaming/thinking while something else holds the stage —
   *  the Chat tab pulses so an answer never lands unseen. */
  chatBusy?: boolean;
}) {
  const stageActive = activeEntityId != null || activeStage != null;
  if (!onShowChat && !onStage) return null;

  return (
    <nav className="tch-tray" aria-label="Chat stages" data-testid="chat-entity-tray">
      <div className="tch-tray__tabs">
        {onShowChat ? (
          <button
            type="button"
            className="tch-tray__chat"
            data-active={!stageActive || undefined}
            aria-current={!stageActive || undefined}
            onClick={onShowChat}
          >
            <span aria-hidden>⌂</span> Chat
            {stageActive && chatBusy ? (
              <span className="tch-tray__pulse" role="status" aria-label="The agent is still working in this thread" />
            ) : null}
          </button>
        ) : null}
      </div>
      {onStage ? (
        <div className="tch-tray__stages">
          <button
            type="button"
            /* ONE VISUAL FAMILY (visual lane's handoff note): the stage tab IS
               the Chat tab's anatomy — same pill, same active treatment, same
               focus ring — with a marker class for nothing but the tests. */
            className="tch-tray__chat tch-tray__stage"
            data-active={activeStage === 'graph' || undefined}
            aria-current={activeStage === 'graph' || undefined}
            title="The entities this conversation named, and the relations they actually hold"
            onClick={() => onStage(activeStage === 'graph' ? null : 'graph')}
          >
            <span aria-hidden>◈</span> Graph
          </button>
        </div>
      ) : null}
    </nav>
  );
}
