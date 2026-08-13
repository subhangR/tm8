import { getOperation } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2AuthHandlers } from '../../src/facade/handlers/w2/auth.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { formatToken } from '../../src/identity/crypto.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';

const SESSION_ID = '00000000-0000-7000-8000-000000000611';
const TOKEN = formatToken(SESSION_ID, 'browser-pass-secret');
const EXPIRES_AT = '2026-09-09T00:00:00.000Z';

class AuthDb implements Db {
  constructor(private readonly kind: ResolvedAuthSession['kind']) {}

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(): Promise<R[]> => [],
      rpc: async <R>(name: string): Promise<R> => {
        if (name === 'touch_auth_session') return undefined as R;
        if (name !== 'resolve_auth_session') throw new Error(`unexpected rpc ${name}`);
        return {
          sessionId: SESSION_ID,
          accountId: '00000000-0000-7000-8000-000000000612',
          identityId: '00000000-0000-7000-8000-000000000613',
          username: 'subhang',
          displayName: 'Subhang',
          isNodeAdmin: false,
          isOwner: true,
          kind: this.kind,
          actingAsTeamMemberId: null,
          workSessionId: null,
          runtimeMemberId: null,
          runtimeThreadRootId: null,
          expiresAt: EXPIRES_AT,
          label: null,
        } as R;
      },
    });
  }

  async rpc<T>(): Promise<T> {
    throw new Error('unexpected direct rpc');
  }

  async query<R>(): Promise<R[]> {
    return [{ display_name: 'Subhang' }] as R[];
  }

  async end(): Promise<void> {}
}

function deps(kind: ResolvedAuthSession['kind']): FacadeDeps {
  return {
    db: new AuthDb(kind),
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024,
      databaseUrl: undefined,
    },
    owner: async () => ({
      identityId: 'owner',
      accountId: 'owner-account',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  };
}

function context(): RequestContext {
  const op = getOperation('auth.session.get');
  return {
    op,
    opName: op.name,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    requestId: 'req-cookie-refresh',
    identity: {
      kind: 'bearer',
      token: TOKEN,
      authKind: 'browser',
    },
    headers: { authorization: `Bearer ${TOKEN}` },
    method: op.method,
    path: op.path,
  };
}

async function sessionGet(kind: ResolvedAuthSession['kind']): Promise<unknown> {
  const registry = new HandlerRegistry();
  registerW2AuthHandlers(registry, deps(kind));
  return registry.get('auth.session.get')!(context());
}

describe('auth.session.get browser cookie refresh', () => {
  it('refreshes a verified browser pass into the HttpOnly WebSocket cookie', async () => {
    const result = await sessionGet('browser');
    expect(result).toMatchObject({
      kind: 'json',
      headers: {
        'cache-control': 'no-store',
        'set-cookie': expect.stringContaining(`__Host-tm8-session=${TOKEN}`),
      },
    });
  });

  it('does not turn CLI, agent, or agent_runtime passes into ambient browser cookies', async () => {
    for (const kind of ['cli', 'agent', 'agent_runtime'] as const) {
      const result = await sessionGet(kind);
      expect(result).not.toHaveProperty('headers.set-cookie');
    }
  });
});
