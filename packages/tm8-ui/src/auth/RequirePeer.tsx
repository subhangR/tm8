/**
 * The inline Peer gate (doc 20 §5.5).
 *
 * Some acts only make sense when someone other than the owner can sign in —
 * minting an invite is the one on main. On a Personal node that act would
 * succeed and lead nowhere, so in its place this renders one line and the
 * switch. Under decision 34 the node is always claimed by the time anyone is
 * signed in, so there is no password step here: Personal → Peer is a
 * TIGHTENING, which any owner session may make (`node.mode.set`).
 *
 * Outside the gate (no auth actions, a specimen board) and on any mode but
 * Personal, it renders its children untouched. The add-a-server trigger the
 * design also names has no live act yet (`CONNECT_ENDPOINT`), so it is not
 * wrapped.
 */
import type { ReactNode } from 'react';
import { useAuthActions } from './gate-context';
import { failureCopy } from './failures';
import { MODE, REQUIRE_PEER } from './specimen';

export function RequirePeer({ children }: { children: ReactNode }) {
  const actions = useAuthActions();
  const claim = actions?.nodeClaim;
  if (!actions || !claim?.claimed || claim.mode !== 'personal') return <>{children}</>;

  const pinned = claim.modeSource === 'env';
  const owner = actions.account?.isOwner === true;
  return (
    <span className="auth-require-peer" data-testid="require-peer">
      <span>{REQUIRE_PEER.line}</span>{' '}
      {pinned ? (
        <span>{MODE.pinned}</span>
      ) : owner ? (
        <button
          type="button"
          className="set-chip"
          data-testid="require-peer-switch"
          disabled={actions.busy}
          onClick={() => void actions.chooseMode('peer')}
        >
          {REQUIRE_PEER.action}
        </button>
      ) : (
        <span>{REQUIRE_PEER.notOwner}</span>
      )}
      {actions.failure ? <span role="alert"> {failureCopy(actions.failure).lead}</span> : null}
    </span>
  );
}
