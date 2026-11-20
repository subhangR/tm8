/**
 * Read-only port of pass-store.ts: authTokenFor(LOCAL_SERVER_ID). The page
 * always calls its own origin, independently of the SPA's active connection.
 * No storage writes, account mutations, or cross-server fallback.
 */
export function tm8Authorization(): string | null {
  try {
    const raw = window.localStorage.getItem('tm8ui.auth.passes.v1');
    const all: unknown = raw ? JSON.parse(raw) : null;
    if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
    const pass = (all as Record<string, unknown>)[window.location.origin];
    if (!pass || typeof pass !== 'object') return null;
    const { token, account } = pass as { token?: unknown; account?: { handle?: unknown } };
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token) || !account || typeof account.handle !== 'string') return null;
    return `Bearer ${token}`;
  } catch { return null; }
}
