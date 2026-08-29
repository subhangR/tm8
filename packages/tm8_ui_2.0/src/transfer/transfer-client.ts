/**
 * Multi-server plumbing for the transfer feature.
 *
 * The app's data seam serves exactly ONE server — the active one — and that
 * is a design invariant, not a gap ("there is no cross-server aggregation
 * anywhere in this app", SpaceSwitcher). A transfer is the one flow that must
 * hold a client for TWO servers at once, so it builds its own catalog-bound
 * clients here, the same way `auth/session.ts` builds one per call: cheap,
 * capture-free, token read per request from the per-server pass store.
 *
 * Requests to a named server ride the local node's same-origin relay
 * (`routeBaseUrlFor`), which forwards `authorization` and strips cookies —
 * the viewer's pass for THAT server is the only credential that crosses.
 */
import type { AuthLoginResult, ServerConnection, SpaceSummary } from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import { createHttpClient, type HttpClient } from '../data/real/http';
import { LOCAL_SERVER_ID, readActiveServerId, routeBaseUrlFor } from '../servers/server-key';
import {
  noteKnownAccount,
  noteServerOrigin,
  readServerPass,
  writeServerPass,
  type ServerPass,
} from '../auth/pass-store';

export interface TransferServer {
  id: string;
  label: string;
  local: boolean;
}

export function clientFor(serverId: string): HttpClient {
  return createHttpClient({
    baseUrl: routeBaseUrlFor(serverId),
    fetch: (url, init) => globalThis.fetch(url, init),
    getAuthToken: () => readServerPass(serverId)?.token ?? null,
  });
}

/** The label provenance and dialog copy use for the server we are on NOW. */
export function activeServerLabel(): string {
  const id = readActiveServerId();
  if (id !== LOCAL_SERVER_ID) return id;
  try {
    return globalThis.location?.origin || 'local';
  } catch {
    return 'local';
  }
}

/**
 * The connection registry lives on the LOCAL node whichever server the viewer
 * is looking at, so the directory is always read through the local client.
 * Cached briefly: the panel asks on every mount, and five panels in a stack
 * should not cost five registry reads.
 */
let directoryCache: { at: number; servers: TransferServer[] } | null = null;
const DIRECTORY_TTL_MS = 30_000;

export async function listTransferServers(force = false): Promise<TransferServer[]> {
  if (!force && directoryCache !== null && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) {
    return directoryCache.servers;
  }
  const connections = await clientFor(LOCAL_SERVER_ID).call<ServerConnection[]>('serverConnections.list');
  const named = (Array.isArray(connections) ? connections : []).map((connection) => {
    // The pass store keys credentials by target ORIGIN; teach it each
    // connection's origin exactly as the server rail's registry does.
    noteServerOrigin(connection.name, connection.baseUrl);
    return {
      id: connection.name,
      label: connection.username ? `${connection.name} · ${connection.username}` : connection.name,
      local: false,
    };
  });
  const servers: TransferServer[] = [
    { id: LOCAL_SERVER_ID, label: 'local · this machine', local: true },
    ...named,
  ];
  directoryCache = { at: Date.now(), servers };
  return servers;
}

/** Test seam: the cache is module state, and tests must not inherit it. */
export function resetTransferDirectoryCache(): void {
  directoryCache = null;
}

export type DestinationProbe =
  | { state: 'ready'; spaces: SpaceSummary[]; signedInAs: string | null }
  | { state: 'needs-signin' }
  | { state: 'unreachable'; message: string };

/**
 * Can the viewer act on `serverId`, and where could a copy land? One read
 * answers both. `unauthenticated` is a NORMAL state here — it means the
 * sign-in step must run — and only a transport failure is rendered as one.
 */
export async function probeDestination(serverId: string): Promise<DestinationProbe> {
  try {
    const spaces = await clientFor(serverId).call<SpaceSummary[]>('spaces.list');
    return {
      state: 'ready',
      spaces: Array.isArray(spaces) ? spaces : [],
      signedInAs: readServerPass(serverId)?.account.handle ?? null,
    };
  } catch (cause) {
    if (cause instanceof CollabError && (cause.code === 'unauthenticated' || cause.code === 'forbidden')) {
      return { state: 'needs-signin' };
    }
    return { state: 'unreachable', message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * `auth.login` against an arbitrary server, bare on purpose — a login stands
 * on the credential alone, never on a stored pass a reset may have revoked
 * (the same lockout `auth/session.ts` documents). On success the pass lands
 * in the per-server store, so every later `clientFor(serverId)` call carries
 * it without re-plumbing.
 */
export async function signInToServer(
  serverId: string,
  username: string,
  password: string,
): Promise<{ ok: true; handle: string } | { ok: false; message: string }> {
  const bare = createHttpClient({
    baseUrl: routeBaseUrlFor(serverId),
    fetch: (url, init) => globalThis.fetch(url, init),
    getAuthToken: () => null,
  });
  let login: AuthLoginResult;
  try {
    login = await bare.call<AuthLoginResult>('auth.login', {
      body: { username: username.trim(), password, kind: 'browser' },
    });
  } catch (cause) {
    if (cause instanceof CollabError && cause.code === 'unauthenticated') {
      return { ok: false, message: 'wrong username or password for this server' };
    }
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  const pass: ServerPass = {
    token: login.token,
    account: {
      handle: login.account.username,
      displayName: login.account.displayName ?? login.account.username,
      accountId: login.account.accountId,
      identityId: login.account.identityId,
      isOwner: login.account.isOwner,
      isNodeAdmin: login.account.isNodeAdmin,
    },
    sessionId: login.session.sessionId,
    expiresAt: login.session.expiresAt,
    signedInAt: new Date().toISOString(),
  };
  if (!writeServerPass(serverId, pass)) {
    return { ok: false, message: 'this browser blocked credential storage; the sign-in cannot be kept' };
  }
  noteKnownAccount(serverId, {
    handle: pass.account.handle,
    displayName: pass.account.displayName,
    lastSignedInAt: pass.signedInAt,
  });
  return { ok: true, handle: pass.account.handle };
}
