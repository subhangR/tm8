import { AuthGate } from './auth';
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
 * WHAT THE GATE IS, because the distinction is load-bearing: this node exposes
 * `identity.get` and NO auth operation (no signup, login or logout over HTTP).
 * So the account is LOCAL to this browser and every frame that takes a
 * credential says so on screen. See `src/auth/HANDOVER-Auth.md` §GATE UPGRADE.
 *
 * `resolveIdentity` is deliberately NOT passed here: the seam is constructed
 * inside `useGateData`, one layer down, and building a second one at this level
 * purely to read identity would open a duplicate connection to the node. The
 * gate treats identity as absent and says so rather than inventing it; wiring
 * it properly means lifting the seam above this component, which is a shell
 * change and not mine to make.
 */
export function App() {
  return (
    <AuthGate>
      <ConnectedGateApp />
    </AuthGate>
  );
}

function ConnectedGateApp() {
  const registry = useServerRegistry();
  return (
    <GateApp
      key={registry.activeServer.id}
      activeServer={registry.activeServer}
      servers={registry.servers}
      onSelectServer={registry.selectServer}
      onAddServer={registry.addServer}
    />
  );
}
