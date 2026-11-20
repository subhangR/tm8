import { VAULT_OPERATIONS } from './contract.js';
import type { Operation } from './contract.js';
import { PageError, remoteError } from './errors.js';

export class VaultApi {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly authorization: () => string | null,
    private readonly crypto: Crypto,
    private readonly signal: AbortSignal,
  ) {}

  command(): { clientMutationId: string } { return { clientMutationId: this.crypto.randomUUID() }; }

  async call<T>(name: Operation, pathParams: Record<string, string> = {}, body: Record<string, unknown> = {}): Promise<T> {
    try {
      const auth = this.authorization();
      if (!auth) throw new PageError('sign_in');
      const row = VAULT_OPERATIONS[name];
      const path = row.path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
        const value = pathParams[key];
        if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new PageError('invalid_link');
        return encodeURIComponent(value);
      });
      const response = await this.fetch(path, {
        method: row.method, credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: this.signal,
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        ...(row.method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      const envelope: unknown = await response.json();
      if (!envelope || typeof envelope !== 'object') throw new PageError('failed');
      const result = envelope as { data?: T; error?: { details?: { reason?: unknown } } };
      if (!response.ok || result.error) throw remoteError(result.error?.details?.reason, response.status);
      if (!Object.hasOwn(result, 'data')) throw new PageError('failed');
      return result.data as T;
    } catch (error) { throw error instanceof PageError ? error : new PageError('failed'); }
  }
}
