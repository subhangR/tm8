import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { McpCatalog, McpPort } from './port';
const Context = createContext<McpPort | null>(null);
export const useMcpPort = () => useContext(Context);
export function McpProvider({ port, children }: { port: McpPort | null; children: ReactNode }) {
  return <Context.Provider value={port}>{children}</Context.Provider>;
}
export function useMcpCatalog(targetId?: string, teamMemberId?: string) {
  const port = useMcpPort();
  const scope = JSON.stringify([targetId, teamMemberId]);
  const [state, setState] = useState<{ port: McpPort | null; scope: string; catalog?: McpCatalog; error?: string; loading: boolean }>({ port, scope, loading: !!port });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setState(previous => ({ ...(previous.port === port && previous.scope === scope ? previous : {}), port, scope, loading: !!port, error: undefined }));
    if (port) void port.catalog(targetId, teamMemberId).then(
      catalog => { if (active) setState({ port, scope, catalog, loading: false }); },
      () => { if (active) setState({ port, scope, error: 'Connectors could not be loaded. Try again.', loading: false }); },
    );
    return () => { active = false; };
  }, [port, targetId, teamMemberId, scope, revision]);
  useEffect(() => {
    const refresh = () => setRevision(n => n + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const current = state.port === port && state.scope === scope ? state : { loading: !!port, catalog: undefined, error: undefined };
  return { ...current, port, refresh: () => setRevision(n => n + 1) };
}
