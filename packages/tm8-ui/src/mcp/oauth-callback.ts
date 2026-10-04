import { readActiveServerId } from '../servers/server-key';
const PREFIX = 'tm8:mcp:oauth:';
export interface McpCallback {
  input: { state: string; code?: string; issuer?: string; error?: string };
  serverId: string; spaceId: string; valid: boolean;
}
/** Retain public correlation metadata only; provider tokens and codes are never persisted. */
export function rememberMcpOAuth(authorizationUrl: string, spaceId: string, storage: Storage = sessionStorage) {
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (!state) throw new Error('Authorization did not return state.');
  storage.setItem(PREFIX + state, JSON.stringify({ serverId: readActiveServerId(), spaceId, expiresAt: Date.now() + 10 * 60_000 }));
}
/** Capture once before auth boot; remove authorization parameters from browser history immediately. */
export function captureMcpCallback(location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location, history: Pick<History, 'replaceState'> = window.history, storage?: Storage): McpCallback | null {
  if (location.pathname !== '/mcp/oauth/callback') return null;
  const query = new URLSearchParams(location.search);
  const state = query.get('state') ?? '';
  history.replaceState(null, '', '/mcp/oauth/callback');
  let binding: {serverId?: string; spaceId?: string; expiresAt?: number} = {};
  try { const stash = storage ?? window.sessionStorage; const raw = stash.getItem(PREFIX + state); stash.removeItem(PREFIX + state); if (raw) binding = JSON.parse(raw); } catch { /* Fail closed without echoing callback data. */ }
  return { input: { state, ...(query.get('code') ? {code:query.get('code')!} : {}), ...(query.get('iss') ? {issuer:query.get('iss')!} : {}), ...(query.get('error') ? {error:query.get('error')!} : {}) }, serverId:typeof binding.serverId === 'string' ? binding.serverId : '', spaceId:typeof binding.spaceId === 'string' ? binding.spaceId : '', valid: !!state && typeof binding.serverId === 'string' && !!binding.serverId && typeof binding.spaceId === 'string' && !!binding.spaceId && (binding.expiresAt??0)>Date.now() };
}
