/**
 * The node's mode, in the account menu (doc 20 §5.4).
 *
 * WHY THE ACCOUNT MENU AND NOT SPACE SETTINGS. The settings shell is about ONE
 * space; the mode is a fact about the NODE — who a loopback caller is — and the
 * account menu is where the gate's own verbs (sign out, the claim status) already
 * live. The row reads the gate's claim answer and calls the gate's `chooseMode`.
 *
 * WHO SEES WHAT, mirroring what `node.mode.set` admits so no button promises an
 * act the server must refuse:
 *   · only the owner sees the row at all, and only on a claimed node;
 *   · a node pinned by `TM8_NODE_MODE` shows the mode and the pin, no buttons;
 *   · TIGHTENING (personal → peer → server) is offered to the owner however they
 *     are signed in; LOOSENING only to the owner's password session, and only
 *     after the warning — the auto-owner never widens who is trusted.
 */
import { useState } from 'react';
import type { NodeModeView } from '@tm8/contract';
import { useAuthActions } from './gate-context';
import { failureCopy } from './failures';
import { MODE } from './specimen';

const ORDER: readonly NodeModeView[] = ['personal', 'peer', 'server'];
const rank = (m: NodeModeView) => ORDER.indexOf(m);

export function NodeModeRow() {
  const actions = useAuthActions();
  const [confirm, setConfirm] = useState<NodeModeView | null>(null);
  const [restart, setRestart] = useState(false);
  const claim = actions?.nodeClaim;
  if (!actions || !claim?.claimed || !actions.account?.isOwner) return null;

  const current = claim.mode;
  const pinned = claim.modeSource === 'env';
  const mayLoosen = actions.signedInWith === 'pass';

  const choose = async (mode: NodeModeView) => {
    setConfirm(null);
    const result = await actions.chooseMode(mode);
    if (result) setRestart(result.restartRequired);
  };

  return (
    <div className="auth-menu__row auth-menu__row--stacked" data-testid="account-menu-node-mode">
      <span className="auth-menu__signout">
        <span className="auth-menu__glyph" aria-hidden>
          ⌂
        </span>
        This node
        <span className="auth-spacer" />
        <span className="auth-toggle" role="group" aria-label="node mode">
          {ORDER.map((mode) => {
            const loosening = rank(mode) < rank(current);
            const offered = !pinned && mode !== current && (!loosening || mayLoosen);
            return (
              <button
                key={mode}
                type="button"
                className={`auth-toggle__opt${current === mode ? ' auth-toggle__opt--on' : ''}`}
                aria-pressed={current === mode}
                disabled={!offered}
                onClick={() => (loosening ? setConfirm(mode) : void choose(mode))}
              >
                {mode}
              </button>
            );
          })}
        </span>
      </span>
      {pinned ? <span className="auth-menu__signout-note">{MODE.pinned}</span> : null}
      {confirm ? (
        <span className="auth-menu__signout-note auth-menu__note--warn" data-testid="node-mode-loosen-warning">
          {MODE.loosenWarning}{' '}
          <button type="button" className="auth-btn auth-btn--ghost auth-btn--sm" onClick={() => void choose(confirm)}>
            Switch to {confirm}
          </button>
        </span>
      ) : null}
      {restart ? <span className="auth-menu__signout-note">{MODE.restartTitle}.</span> : null}
      {actions.failure ? (
        <span className="auth-menu__signout-note auth-menu__note--warn">{failureCopy(actions.failure).lead}</span>
      ) : null}
    </div>
  );
}
