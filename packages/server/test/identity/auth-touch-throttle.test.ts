import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { formatToken } from '../../src/identity/crypto.js';
import { AUTH_TOUCH_INTERVAL_MS, resolveBearerIdentity, touchDue } from '../../src/identity/pg-auth.js';

const SESSION_ID = '00000000-0000-7000-8000-000000000711';

class CountingDb implements Db {
  readonly calls: string[] = [];

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(): Promise<R[]> => [],
      rpc: async <R>(name: string): Promise<R> => {
        this.calls.push(name);
        if (name === 'touch_auth_session') return undefined as R;
        return {
          sessionId: SESSION_ID,
          accountId: '00000000-0000-7000-8000-000000000712',
          identityId: '00000000-0000-7000-8000-000000000713',
          username: 'u',
          displayName: 'U',
          isNodeAdmin: false,
          isOwner: true,
          kind: 'browser',
          actingAsTeamMemberId: null,
          workSessionId: null,
          runtimeMemberId: null,
          runtimeThreadRootId: null,
          expiresAt: '2099-01-01T00:00:00.000Z',
          label: null,
        } as R;
      },
    });
  }

  async rpc<T>(): Promise<T> {
    throw new Error('unexpected direct rpc');
  }

  async query<R>(): Promise<R[]> {
    return [];
  }

  async end(): Promise<void> {}
}

describe('auth session touch throttle', () => {
  it('stamps a session at most once per interval', () => {
    const id = 'throttle-unit-a';
    expect(touchDue(id, 1_000)).toBe(true);
    expect(touchDue(id, 1_000 + AUTH_TOUCH_INTERVAL_MS - 1)).toBe(false);
    expect(touchDue(id, 1_000 + AUTH_TOUCH_INTERVAL_MS)).toBe(true);
    expect(touchDue('throttle-unit-b', 1_000)).toBe(true);
  });

  it('resolves every request but writes last_used_at only on the first of a burst', async () => {
    const db = new CountingDb();
    const token = formatToken(SESSION_ID, 'burst-secret');
    await Promise.all(Array.from({ length: 24 }, () => resolveBearerIdentity(db, token)));
    expect(db.calls.filter((c) => c === 'resolve_auth_session')).toHaveLength(24);
    expect(db.calls.filter((c) => c === 'touch_auth_session')).toHaveLength(1);
  });
});
