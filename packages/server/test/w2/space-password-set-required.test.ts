/**
 * `spaces.spacePassword.setRequired` — the two things the handler owns (W5,
 * review 5327376587); every other guard is SQL (995, space-logins.pg.test.ts).
 *
 *   #1  turning it ON needs TM8_SPACE_SESSIONS=enforce. Below enforce an
 *       unpinned gate session still reaches the space, so the password would
 *       guard nothing. Refused before any SQL; turning it off always works.
 *   #4  turning it on ends the space's pinned human sessions (SQL returns
 *       their ids) and the handler closes exactly those sockets.
 */
import { describe, expect, it } from 'vitest';

import { CollabError, type OperationName } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2AuthHandlers } from '../../src/facade/handlers/w2/auth.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { EventSink } from '../../src/events/ws-connection.js';
import type { RequestContext, SpaceSessionsMode } from '../../src/http/types.js';

const IDENTITY = 'id_5c1f8c43-6a2b-4d0e-9f41-2b7de0c5a001';
const SPACE_ID = '00000000-0000-7000-8000-0000000000e5';
const PINNED = '00000000-0000-7000-8000-00000000a001';
const ELSEWHERE = '00000000-0000-7000-8000-00000000a002';

class RecordingDb implements Db {
  readonly calls: Array<{ fn: string; args: readonly unknown[] }> = [];

  constructor(private readonly answer: unknown) {}

  private querier(): Querier {
    return {
      query: async <R>(): Promise<R[]> => [],
      rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
        this.calls.push({ fn, args });
        return this.answer as T;
      },
    };
  }

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier());
  }

  async query<R>(): Promise<R[]> {
    return [];
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.querier().rpc<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function sink(sessionId: string): EventSink & { closedWith?: string } {
  const s = {
    id: `conn-${sessionId}`,
    identity: { kind: 'bearer', identityId: IDENTITY, sessionId } as RequestContext['identity'],
    isOpen: true,
    closedWith: undefined as string | undefined,
    send() {},
    close(_code?: number, reason?: string) {
      s.closedWith = reason;
      s.isOpen = false;
    },
    onMessage() {},
    onClose() {},
  };
  return s as EventSink & { closedWith?: string };
}

async function setRequired(
  db: RecordingDb,
  spaceSessions: SpaceSessionsMode | undefined,
  body: { required: boolean; password?: string },
  sinks: EventSink[] = [],
) {
  const deps = {
    db,
    config: {
      host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined,
      ...(spaceSessions ? { spaceSessions } : {}),
    } as FacadeDeps['config'],
    owner: async () => ({ identityId: 'not-the-caller', isNodeAdmin: false }),
  } as unknown as FacadeDeps;
  const registry = new HandlerRegistry();
  registerW2AuthHandlers(registry, deps, { sockets: { sinks: () => sinks } });
  const opName = 'spaces.spacePassword.setRequired' as OperationName;
  const handler = registry.get(opName)!;
  return handler({
    op: { name: opName, method: 'PUT', path: '/v2/spaces/:spaceId/space-password', kind: 'command', status: 'v2' },
    opName,
    params: { spaceId: SPACE_ID },
    query: new URLSearchParams(),
    body,
    requestId: 'req-w5-set-required',
    identity: { kind: 'bearer', identityId: IDENTITY, authKind: 'browser', sessionSpaceId: SPACE_ID },
    headers: {},
    method: 'PUT',
    path: `/v2/spaces/${SPACE_ID}/space-password`,
  } as unknown as RequestContext);
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof CollabError) return `${err.code}:${String(err.details?.reason ?? '')}:${String(err.details?.spaceSessions ?? '')}`;
    throw err;
  }
}

describe('spaces.spacePassword.setRequired — node mode (#1)', () => {
  it.each([['agents' as const], ['off' as const], [undefined]])(
    'TM8_SPACE_SESSIONS=%s: turning it on is refused (409) before any SQL; positive: turning it off reaches SQL',
    async (mode) => {
      const db = new RecordingDb({ spaceId: SPACE_ID, requireSpacePassword: false, revokedSessionIds: [] });
      expect(await refusal(() => setRequired(db, mode, { required: true, password: 'long-enough' })))
        .toBe(`conflict:space_password_requires_enforce:${mode ?? 'agents'}`);
      expect(db.calls).toEqual([]);
      expect(await refusal(() => setRequired(db, mode, { required: false }))).toBe('ok');
      expect(db.calls.map((c) => c.fn)).toEqual(['set_space_require_credential']);
    },
  );

  it('enforce: turning it on reaches SQL', async () => {
    const db = new RecordingDb({ spaceId: SPACE_ID, requireSpacePassword: true, revokedSessionIds: [] });
    expect(await refusal(() => setRequired(db, 'enforce', { required: true, password: 'long-enough' }))).toBe('ok');
    expect(db.calls.map((c) => c.fn)).toEqual(['set_space_require_credential']);
  });
});

describe('spaces.spacePassword.setRequired — sockets (#4)', () => {
  it('closes the sockets of the sessions SQL revoked, and only those', async () => {
    const db = new RecordingDb({ spaceId: SPACE_ID, requireSpacePassword: true, revokedSessionIds: [PINNED] });
    const pinned = sink(PINNED);
    const elsewhere = sink(ELSEWHERE);
    await setRequired(db, 'enforce', { required: true }, [pinned, elsewhere]);
    expect(pinned.closedWith).toBe('session revoked');
    expect(elsewhere.closedWith).toBeUndefined();
  });
});
