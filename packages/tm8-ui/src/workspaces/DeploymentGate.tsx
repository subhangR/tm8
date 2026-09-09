import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { DeploymentCapabilities } from '@tm8/contract';
import { hydrateCookieSession, subscribeToSession } from '../auth/session';
import { clearServerPass, readServerPass } from '../auth/pass-store';
import { LOCAL_SERVER_ID } from '../servers/server-key';
import { workspaceApi } from './api';
import './workspace.css';

interface Capabilities extends DeploymentCapabilities { controlOrigin: string | null; workspaceIsolation: boolean; githubLogin: boolean }
const DeploymentContext = createContext<Capabilities | null>(null);
export const useDeployment = () => useContext(DeploymentContext);
let handoff: Promise<unknown> | undefined;
function redeemHandoff(): Promise<unknown> | undefined {
  if (handoff) return handoff;
  if (location.pathname !== '/auth/handoff') return undefined;
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  history.replaceState(null, '', '/');
  if (!code) return Promise.reject(new Error('The sign-in handoff is missing or expired. Sign in again.'));
  clearServerPass(LOCAL_SERVER_ID);
  handoff = workspaceApi('/v2/auth/handoff', { code });
  return handoff;
}
export function DeploymentGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ capabilities: Capabilities; signedIn: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const exchange = redeemHandoff();
        const capabilities = await workspaceApi<Capabilities>('/v2/deployment/capabilities');
        if (exchange) await exchange;
        const signedIn = await hydrateCookieSession();
        if (alive) setState({ capabilities, signedIn });
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : 'Unable to reach tm8'); }
    }
    void load(); return () => { alive = false; };
  }, []);
  useEffect(() => subscribeToSession(() => setState(current => current ? { ...current, signedIn: !!readServerPass(LOCAL_SERVER_ID) } : null)), []);
  if (error) return <main className="workspace-login"><h1>tm8</h1><p role="alert">{error}</p><button onClick={() => location.reload()}>Retry</button></main>;
  if (!state) return <main className="workspace-login" role="status">Connecting to tm8…</main>;
  if (state.capabilities.distributedSystemFlag && !state.signedIn) return <main className="workspace-login"><h1>Sign in or sign up</h1><p>Use your GitHub account. New accounts need an invitation.</p><a href={state.capabilities.controlOrigin ?? '/'}>Continue with GitHub</a></main>;
  return <DeploymentContext.Provider value={state.capabilities}>{children}</DeploymentContext.Provider>;
}
