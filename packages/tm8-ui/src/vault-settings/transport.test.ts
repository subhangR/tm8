/**
 * The cookie-only vault transport (./transport.ts): the request it builds from
 * the catalog row, what it refuses before any request, and the refusal shape
 * `vaultError` reads.
 */
import { describe, expect, it } from 'vitest';
import { VAULT_OPERATIONS, type VaultStatus } from '@tm8/contract';

import { createVaultPort, vaultError } from '../vault';
import { createVaultTransport, type VaultFetch } from './transport';

const SPACE = '0b3c2f0e-3d7c-4a4e-9a51-1f7a1c1c1c1c';
const ITEM = '6f1d2c3b-4a59-4e8f-9d7c-1b2a3c4d5e6f';

interface Sent { url: string; init: RequestInit }

function fake(answer: () => Response | Promise<Response>): { fetch: VaultFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return answer();
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const ok = (data: unknown) => () => json(200, { data, requestId: 'req-1' });

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the call did not refuse');
}

const status: VaultStatus = {
  mode: 'pre_review', reviewGate: 'open', testSecretsOnly: true, broker: 'ok', audit: 'ok',
  kms: { kind: 'local-dev', productionGrade: false },
  features: { capture: true, fill: true, callApi: true, spend: false, import: false, grants: true },
  viewer: { passkeys: 1, recoveryCodesRemaining: 10, vaultSession: null },
};

describe('vault transport', () => {
  it('sends a read as a same-origin GET with no Authorization, the client and space headers, and no body', async () => {
    const { fetch, sent } = fake(ok({ hello: 1 }));
    const transport = createVaultTransport({ spaceId: SPACE, fetch });
    expect(transport.spaceId).toBe(SPACE);
    await expect(transport.call('vault.status')).resolves.toEqual({ hello: 1 });
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent;
    expect(url).toBe('/v2/vault/status');
    expect(init).toEqual({
      method: 'GET',
      headers: { accept: 'application/json', 'x-tm8-client': 'tm8-ui', 'x-tm8-vault-space': SPACE },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });

  it('sends every command as JSON, an empty body as {}, and never a query', async () => {
    const { fetch, sent } = fake(ok({ ended: true }));
    const transport = createVaultTransport({ spaceId: SPACE, fetch });
    await transport.call('vault.session.end');
    await transport.call('vault.items.update', { params: { itemId: ITEM }, body: { clientMutationId: 'vault-1', name: 'x' } });
    expect(sent.map(({ url, init }) => [url, init.method, init.body, (init.headers as Record<string, string>)['content-type']])).toEqual([
      ['/v2/vault/session/end', 'POST', '{}', 'application/json'],
      [`/v2/vault/items/${ITEM}`, 'PATCH', '{"clientMutationId":"vault-1","name":"x"}', 'application/json'],
    ]);
    for (const { init } of sent) expect(Object.keys(init.headers as object).map((name) => name.toLowerCase())).not.toContain('authorization');
  });

  it('fills each path parameter encoded, and puts scalar reads in the query', async () => {
    const { fetch, sent } = fake(ok([]));
    const transport = createVaultTransport({ spaceId: SPACE, fetch });
    await transport.call('vault.items.activity', { params: { itemId: 'a/b?c' }, query: { days: 7 } });
    await transport.call('vault.items.list', { query: { cursor: 'x y', limit: 20, skip: undefined, none: null, flag: false } });
    expect(sent.map(({ url }) => url)).toEqual([
      '/v2/vault/items/a%2Fb%3Fc/activity?days=7',
      '/v2/vault/items?cursor=x+y&limit=20&flag=false',
    ]);
  });

  it('refuses before any request: an unknown operation, a missing, empty or extra parameter, a nested query value, a query on a command, a body on a read', async () => {
    const { fetch, sent } = fake(ok({}));
    const transport = createVaultTransport({ spaceId: SPACE, fetch });
    const attempts: Array<Promise<unknown>> = [
      transport.call('vault.nope' as never),
      transport.call('vault.items.get'),
      transport.call('vault.items.get', { params: { itemId: '' } }),
      transport.call('vault.items.get', { params: { itemId: ITEM, other: 'x' } }),
      transport.call('vault.status', { params: { itemId: ITEM } }),
      transport.call('vault.items.list', { query: { cursor: { nested: true } } }),
      transport.call('vault.items.list', { query: { ids: ['a', 'b'] } }),
      transport.call('vault.items.list', { query: { limit: Number.NaN } }),
      transport.call('vault.session.end', { query: { token: 'x' } }),
      transport.call('vault.status', { body: {} }),
    ];
    for (const attempt of attempts) expect(await refusalOf(attempt)).toEqual({ error: { code: 'invalid_input' } });
    expect(sent).toHaveLength(0);
  });

  it('builds every catalog path it is given parameters for', async () => {
    const { fetch, sent } = fake(ok({}));
    const transport = createVaultTransport({ spaceId: null, fetch });
    for (const row of VAULT_OPERATIONS) {
      const names = [...row.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);
      const params = Object.fromEntries(names.map((name) => [name, ITEM]));
      await transport.call(row.name, { params });
    }
    expect(sent.map(({ url, init }) => `${init.method} ${url}`)).toEqual(
      VAULT_OPERATIONS.map((row) => `${row.method} ${row.path.replace(/:[A-Za-z]+/g, ITEM)}`),
    );
    // No space chosen: the relay picks the caller's only space, or refuses.
    for (const { init } of sent) expect(Object.keys(init.headers as object)).not.toContain('x-tm8-vault-space');
  });

  it('keeps only the status, the code and the reason of a refusal, and maps 401 to unauthorized', async () => {
    const message = ['vault:', 'server', 'detail', crypto.randomUUID()].join(' ');
    const cases: Array<[Response, unknown, string]> = [
      [json(401, { error: { code: 'unauthenticated', message, requestId: 'r' } }), { status: 401, error: { code: 'unauthorized' } }, 'unauthorized'],
      [json(503, { error: { code: 'upstream_unavailable', message, details: { reason: 'vault_disabled' }, retryable: true } }),
        { status: 503, error: { code: 'upstream_unavailable', details: { reason: 'vault_disabled' } } }, 'vault_disabled'],
      [json(403, { error: { code: 'forbidden', message, details: { reason: 'space_forbidden' } } }),
        { status: 403, error: { code: 'forbidden', details: { reason: 'space_forbidden' } } }, 'forbidden'],
      [json(409, { error: { code: 'conflict', message, details: { reason: 'operation_in_progress' } } }),
        { status: 409, error: { code: 'conflict', details: { reason: 'operation_in_progress' } } }, 'operation_in_progress'],
      [new Response('<html>bad gateway</html>', { status: 502 }), { status: 502, error: {} }, 'request_failed'],
      [json(404, { error: { code: 'not_found', message } }), { status: 404, error: { code: 'not_found' } }, 'not_found'],
    ];
    for (const [response, expected, uiCode] of cases) {
      const transport = createVaultTransport({ spaceId: SPACE, fetch: fake(() => response).fetch });
      const thrown = await refusalOf(transport.call('vault.status'));
      expect(thrown).toEqual(expected);
      expect(JSON.stringify(thrown).includes(message)).toBe(false);
      expect(vaultError(thrown).code).toBe(uiCode);
    }
    expect(vaultError({ status: 503, error: { code: 'upstream_unavailable', details: { reason: 'vault_disabled' } } }).message)
      .toBe('The vault is switched off.');
  });

  it('answers a lost request as request_failed and an answer without data as invalid_response', async () => {
    const lost = createVaultTransport({ spaceId: SPACE, fetch: async () => { throw new TypeError('network'); } });
    expect(await refusalOf(lost.call('vault.status'))).toEqual({ error: { code: 'request_failed' } });
    const html = createVaultTransport({ spaceId: SPACE, fetch: fake(() => new Response('<html></html>', { status: 200 })).fetch });
    expect(await refusalOf(html.call('vault.status'))).toEqual({ status: 200, error: { code: 'invalid_response' } });
    const bare = createVaultTransport({ spaceId: SPACE, fetch: fake(() => json(200, { status })).fetch });
    expect(vaultError(await refusalOf(bare.call('vault.status'))).code).toBe('invalid_response');
  });

  it('carries a port: status reads through the relay envelope, and a bad answer is the port\'s invalid_response', async () => {
    const good = createVaultPort(createVaultTransport({ spaceId: SPACE, fetch: fake(ok(status)).fetch }));
    await expect(good.status()).resolves.toEqual(status);
    const wrong = createVaultPort(createVaultTransport({ spaceId: SPACE, fetch: fake(ok({ mode: 'nope' })).fetch }));
    expect(vaultError(await refusalOf(wrong.status())).code).toBe('invalid_response');
    // The port refuses a space id that is not a lowercase UUID before any call.
    expect(() => createVaultPort(createVaultTransport({ spaceId: SPACE.toUpperCase(), fetch: fake(ok(status)).fetch })))
      .toThrow();
  });
});
