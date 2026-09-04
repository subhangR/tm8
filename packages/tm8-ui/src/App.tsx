import { useState } from 'react';
import { AuthGate } from './auth';
import { JoinBanner, capturePendingJoin } from './join';
import { GateApp } from './views/GateApp';
import { useServerRegistry } from './servers';

/**
 * THE GATE (R5): the complete T0-1 master screen, interactive on fixtures, in
 * both themes. The A0 kit gallery moves behind a dev route at fan-out.
 *
 * AUTH IS MANDATORY AND WRAPS EVERYTHING (T3, user-ordered 2026-07-29).
 * `AuthGate` renders the T3 flow until a session exists and `GateApp` only
 * after — children are not rendered at all while signed out, so the app's
 * effects, reads and sockets never run for someone who is not in.
 *
 * WHAT THE GATE IS, because the distinction is load-bearing: server-backed
 * (Identity v2 Stage 1). It performs `auth.signup` / `auth.login` /
 * `auth.logout` against the ACTIVE server and verifies the stored `tm8s_…`
 * pass with `auth.session.get` on reload. The pass is stored per server; the
 * seam below attaches it to every request via `getAuthToken`.
 *
 * `resolveIdentity` is deliberately NOT passed here: the seam is constructed
 * inside `useGateData`, one layer down, and building a second one at this level
 * purely to read identity would open a duplicate connection to the node. The
 * gate treats identity as absent and says so rather than inventing it; wiring
 * it properly means lifting the seam above this component, which is a shell
 * change and not mine to make.
 */
export function App() {
  /**
   * THE JOIN LINK IS CAPTURED HERE, above the gate, and once.
   *
   * `capturePendingJoin` strips the code out of the URL as it parks it (a code
   * is a credential and should not sit in the address bar), so a second read
   * of `location` would find nothing — the lazy initialiser makes "once"
   * literal rather than once-per-first-render.
   *
   * It must be above `AuthGate` because the gate renders its flow INSTEAD of
   * children while signed out, and an invite's recipient usually is: anything
   * holding the code below this line is unmounted at exactly the moment the
   * code matters. Parking is what lets the sign-in ceremony happen in between
   * and still come back here.
   *
   * The gate is told only THAT a code is held, never what it is — see
   * `JoinBanner` for why the banner reads nothing.
   */
  const [pendingJoin] = useState<string | null>(() => capturePendingJoin());

  return (
    <AuthGate signedOutBanner={<JoinBanner pending={pendingJoin !== null} />}>
      <ConnectedGateApp pendingJoin={pendingJoin} />
    </AuthGate>
  );
}

function ConnectedGateApp({ pendingJoin }: { pendingJoin: string | null }) {
  const registry = useServerRegistry();
  return (
    <GateApp
      key={registry.activeServer.id}
      activeServer={registry.activeServer}
      servers={registry.servers}
      onSelectServer={registry.selectServer}
      onAddServer={registry.addServer}
      // Handed DOWN rather than re-read: `GateApp` is keyed on the active
      // server and remounts when it changes, and by then the URL no longer
      // holds the code.
      pendingJoin={pendingJoin}
    />
  );
}
