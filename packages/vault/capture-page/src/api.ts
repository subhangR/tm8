import { TM8_CLIENT_HEADER, VAULT_OPERATIONS, VAULT_PAGE_CLIENT_LABEL, VAULT_SPACE_HEADER } from './contract.js';
import type { Operation } from './contract.js';
import { PageError, remoteError } from './errors.js';

/**
 * Same-origin calls authenticated by the HttpOnly tm8 session cookie alone. The
 * page never reads, holds or sends a bearer, so no script on this origin can
 * lift a credential from it; a missing or expired tm8 session answers 401,
 * shown as sign_in. The space is an identifier, sent so a member of several
 * spaces acts in the one the link names.
 */
export class VaultApi {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly spaceId: string | null,
    private readonly crypto: Crypto,
    private readonly signal: AbortSignal,
  ) {}

  command(): { clientMutationId: string } { return { clientMutationId: this.crypto.randomUUID() }; }

  async call<T>(name: Operation, pathParams: Record<string, string> = {}, body: Record<string, unknown> = {}): Promise<T> {
    try {
      const row = VAULT_OPERATIONS[name];
      const path = row.path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
        const value = pathParams[key];
        if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new PageError('invalid_link');
        return encodeURIComponent(value);
      });
      // X-TM8-Client on every call, as the SPA does: without it the server's CSRF
      // gate refuses each command that carries the tm8 cookie.
      const headers: Record<string, string> = { 'Content-Type': 'application/json', [TM8_CLIENT_HEADER]: VAULT_PAGE_CLIENT_LABEL };
      if (this.spaceId) headers[VAULT_SPACE_HEADER] = this.spaceId;
      const response = await this.fetch(path, {
        method: row.method, credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: this.signal, headers,
        ...(row.method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      let envelope: unknown;
      // A proxy's HTML error page still says which way it failed.
      try { envelope = await response.json(); }
      catch { throw remoteError(undefined, response.status); }
      if (!envelope || typeof envelope !== 'object') throw new PageError('failed');
      const result = envelope as { data?: T; error?: { details?: { reason?: unknown } } };
      if (!response.ok || result.error) throw remoteError(result.error?.details?.reason, response.status);
      if (!Object.hasOwn(result, 'data')) throw new PageError('failed');
      return result.data as T;
    } catch (error) { throw error instanceof PageError ? error : new PageError('failed'); }
  }
}
