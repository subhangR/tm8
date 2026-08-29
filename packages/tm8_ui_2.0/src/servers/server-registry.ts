import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ServerConnectionSchema,
  TM8_CLIENT_HEADER,
  TM8_CLIENT_HEADER_VALUE,
  type ServerConnection,
} from '@tm8/contract';
import { authTokenFor, noteServerOrigin } from '../auth/pass-store';
import { ACTIVE_SERVER_KEY, LOCAL_SERVER_ID, routeBaseUrlFor } from './server-key';

export type ServerReachability = 'checking' | 'online' | 'offline';

export interface UiServer {
  id: string;
  name: string;
  label: string;
  baseUrl: string;
  routeBaseUrl: string;
  username: string | null;
  local: boolean;
  reachability: ServerReachability;
}

export interface AddServerInput {
  name: string;
  baseUrl: string;
  username?: string;
}

export const LOCAL_SERVER: UiServer = {
  id: LOCAL_SERVER_ID,
  name: LOCAL_SERVER_ID,
  label: 'local · this machine',
  baseUrl: '',
  routeBaseUrl: routeBaseUrlFor(LOCAL_SERVER_ID),
  username: null,
  local: true,
  reachability: 'checking',
};

function toUiServer(connection: ServerConnection): UiServer {
  // The auth pass store keys credentials by TARGET ORIGIN (the lead's
  // programme-wide ruling); this cache is how the gate resolves a connection
  // name to its origin synchronously, before any list fetch has run.
  noteServerOrigin(connection.name, connection.baseUrl);
  return {
    id: connection.name,
    name: connection.name,
    label: connection.username ? `${connection.name} · ${connection.username}` : connection.name,
    baseUrl: connection.baseUrl,
    routeBaseUrl: routeBaseUrlFor(connection.name),
    username: connection.username ?? null,
    local: false,
    reachability: 'checking',
  };
}

function readActiveServer(): string {
  try {
    return localStorage.getItem(ACTIVE_SERVER_KEY) || LOCAL_SERVER.id;
  } catch {
    return LOCAL_SERVER.id;
  }
}

function persistActiveServer(id: string): void {
  try {
    localStorage.setItem(ACTIVE_SERVER_KEY, id);
  } catch {
    // Selection remains live for this page even when browser storage is blocked.
  }
}

/**
 * This registry talks to the node directly rather than through
 * `src/data/real/http.ts`, so it needs its own S6 header — the gate does not
 * care which module the request came from. Merged here, once, so no caller has
 * to remember it. The LOCAL pass rides along when one exists: server
 * connections live on the local node, and a browser signed in there must act
 * as its account, not as the loopback owner.
 */
async function jsonData<T>(url: string, init?: RequestInit): Promise<T> {
  const localToken = authTokenFor(LOCAL_SERVER_ID);
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      ...(localToken ? { authorization: `Bearer ${localToken}` } : {}),
    },
  });
  const body = await response.json().catch(() => undefined) as
    | { data?: unknown; error?: { message?: string } }
    | undefined;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `tm8 returned HTTP ${response.status}`);
  }
  return body?.data as T;
}

async function isHealthy(server: UiServer): Promise<boolean> {
  try {
    const response = await fetch(`${server.routeBaseUrl}/health`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; server?: unknown };
    return body.ok === true && body.server === 'tm8-server';
  } catch {
    return false;
  }
}

export interface ServerRegistryState {
  servers: UiServer[];
  activeServer: UiServer;
  loading: boolean;
  error: string | null;
  selectServer(id: string): void;
  addServer(input: AddServerInput): Promise<UiServer>;
  refresh(): Promise<void>;
}

export function useServerRegistry(): ServerRegistryState {
  const [servers, setServers] = useState<UiServer[]>([LOCAL_SERVER]);
  const [activeId, setActiveId] = useState(readActiveServer);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async (items: UiServer[]) => {
    const verdicts = await Promise.all(items.map(async (server) => ({
      id: server.id,
      reachability: await isHealthy(server) ? 'online' as const : 'offline' as const,
    })));
    const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict.reachability]));
    setServers((current) => current.map((server) => ({
      ...server,
      reachability: byId.get(server.id) ?? server.reachability,
    })));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await jsonData<unknown>('/v2/server-connections');
      const parsed = ServerConnectionSchema.array().safeParse(raw);
      if (!parsed.success) throw new Error('local tm8 returned invalid Server connection data');
      const next = [LOCAL_SERVER, ...parsed.data.map(toUiServer)];
      setServers(next);
      if (!next.some((server) => server.id === activeId)) {
        setActiveId(LOCAL_SERVER.id);
        persistActiveServer(LOCAL_SERVER.id);
      }
      void probe(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setServers([LOCAL_SERVER]);
      void probe([LOCAL_SERVER]);
    } finally {
      setLoading(false);
    }
  }, [activeId, probe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Without this the list is fetched exactly once, at mount. A Server
   * registered afterwards — by the CLI, or from another tab — stays invisible
   * for the whole life of this tab, and nothing on screen suggests the list is
   * stale: the rail looks complete while it is simply old. Revalidating when
   * the tab regains focus keeps a long-lived workspace honest without polling
   * the node on a timer.
   */
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [refresh]);

  const selectServer = useCallback((id: string) => {
    setActiveId(id);
    persistActiveServer(id);
  }, []);

  const addServer = useCallback(async (input: AddServerInput): Promise<UiServer> => {
    const name = input.name.trim().toLowerCase();
    const baseUrl = new URL(input.baseUrl.trim()).origin;
    const connection = await jsonData<unknown>('/v2/server-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        baseUrl,
        ...(input.username?.trim() ? { username: input.username.trim() } : {}),
        clientMutationId: crypto.randomUUID(),
      }),
    });
    const parsed = ServerConnectionSchema.safeParse(connection);
    if (!parsed.success) throw new Error('local tm8 returned an invalid Server connection');
    const added = toUiServer(parsed.data);
    setServers((current) => [...current.filter((server) => server.id !== added.id), added]);
    setActiveId(added.id);
    persistActiveServer(added.id);
    void probe([added]);
    return added;
  }, [probe]);

  const activeServer = useMemo(
    () => servers.find((server) => server.id === activeId) ?? LOCAL_SERVER,
    [servers, activeId],
  );

  return { servers, activeServer, loading, error, selectServer, addServer, refresh };
}
