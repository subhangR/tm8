import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { McpCatalog, McpPort } from './port';
const Context = createContext<{ port: McpPort | null; revision: number; refresh(): void }>({ port: null, revision: 0, refresh() {} });
export const useMcpPort = () => useContext(Context).port;
export function McpProvider({ port, children }: { port: McpPort | null; children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  const value = useMemo(() => ({ port, revision, refresh }), [port, revision, refresh]);
  useEffect(() => { window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useMcpCatalog(targetId?: string, teamMemberId?: string) {
  const { port, revision, refresh } = useContext(Context);
  const scope = JSON.stringify([targetId, teamMemberId]);
  const [state, setState] = useState<{ port: McpPort | null; scope: string; revision: number; catalog?: McpCatalog; error?: string; loading: boolean }>({ port, scope, revision, loading: !!port });
  useEffect(() => {
    let active = true;
    setState(previous => ({ ...(previous.port === port && previous.scope === scope ? previous : {}), port, scope, revision, loading: !!port, error: undefined }));
    if (port) void port.catalog(targetId, teamMemberId).then(
      catalog => { if (active) setState({ port, scope, revision, catalog, loading: false }); },
      () => { if (active) setState({ port, scope, revision, error: 'Connectors could not be loaded. Try again.', loading: false }); },
    );
    return () => { active = false; };
  }, [port, targetId, teamMemberId, scope, revision]);
  const current = state.port === port && state.scope === scope ? { ...state, loading: state.loading || state.revision !== revision } : { loading: !!port, catalog: undefined, error: undefined };
  return { ...current, port, refresh };
}
