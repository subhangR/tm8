/**
 * `identity.get` advertises the node's `TM8_SPACE_SESSIONS` mode (task
 * 01a0db30-564e), so a client knows whether a space pin is required before
 * its first request instead of discovering it from a 403. One cell per mode,
 * plus the unset config, which reads as the loader's default `agents`.
 */
import { describe, expect, it } from 'vitest';

import type { IdentityGetResult, OperationName } from '@tm8/contract';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext, SpaceSessionsMode } from '../../src/http/types.js';

const CURRENT_IDENTITY = {
  identityId: 'id_5c1f8c43-6a2b-4d0e-9f41-2b7de0c5a001',
  accountId: '00000000-0000-7000-8000-0000000000a1',
  username: 'amber',
  displayName: 'Amber',
  avatar: null,
  email: null,
  globalId: null,
  isNodeAdmin: false,
  isOwner: false,
  status: 'active',
  actingAs: null,
  memberships: [],
};

class IdentityDb implements Db {
  readonly calls: string[] = [];

  private querier(): Querier {
    return {
      query: async <R>(): Promise<R[]> => [],
      rpc: async <T>(fn: string): Promise<T> => {
        this.calls.push(fn);
        return CURRENT_IDENTITY as T;
      },
    };
  }

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier());
  }

  async query<R>(): Promise<R[]> {
    return [];
  }

  async rpc<T>(_claims: DbClaims, fn: string): Promise<T> {
    return this.querier().rpc<T>(fn);
  }

  async end(): Promise<void> {}
}

async function identityGet(spaceSessions: SpaceSessionsMode | undefined) {
  const db = new IdentityDb();
  const deps = {
    db,
    config: {
      host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined,
      ...(spaceSessions ? { spaceSessions } : {}),
    } as FacadeDeps['config'],
    owner: async () => ({ identityId: 'not-the-caller', isNodeAdmin: false }),
  } as unknown as FacadeDeps;
  const registry = new HandlerRegistry();
  registerW2IdentitySpacesHandlers(registry, deps);
  const opName = 'identity.get' as OperationName;
  const result = await registry.get(opName)!({
    op: { name: opName, method: 'GET', path: '/v2/identity', kind: 'read', status: 'v1' },
    opName,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    requestId: 'req-identity-get-space-sessions',
    identity: { kind: 'bearer', identityId: CURRENT_IDENTITY.identityId, authKind: 'browser' },
    headers: {},
    method: 'GET',
    path: '/v2/identity',
  } as unknown as RequestContext);
  return { result: result as IdentityGetResult, db };
}

describe('identity.get carries the node\'s space-sessions mode', () => {
  it.each(['off', 'agents', 'enforce'] as const)(
    'TM8_SPACE_SESSIONS=%s: advertised as spaceSessions, next to the unchanged identity',
    async (mode) => {
      const { result, db } = await identityGet(mode);
      expect(result).toEqual({ ...CURRENT_IDENTITY, spaceSessions: mode });
      expect(db.calls).toEqual(['current_identity']);
    },
  );

  it('unset: the loader\'s default, agents', async () => {
    const { result } = await identityGet(undefined);
    expect(result.spaceSessions).toBe('agents');
  });
});
