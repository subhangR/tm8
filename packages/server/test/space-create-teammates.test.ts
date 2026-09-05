/**
 * `spaces.create` seeds the default teammate roster.
 *
 * The roster used to arrive only from the boot pass, which enumerates spaces
 * that already exist — so a space created while the node was up had nothing to
 * launch until the next restart. These assertions pin the three facts that
 * makes true: the roster is created, it is gated on the same switch the boot
 * pass is, and a refused persona insert does not cost the caller the space.
 */
import { describe, expect, it } from 'vitest';
import { LAUNCH_MODEL_CATALOG, getOperation, type OperationName } from '@tm8/contract';
import { spacesCreate } from '../src/facade/handlers/spaces.js';
import { DISPATCHER_SEED_NAME, DREAMER_SEED_NAME } from '../src/bootstrap/default-teammates.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';
import type { ServerConfig } from '../src/http/config.js';
import type { RequestContext } from '../src/http/types.js';

const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL_ID = '55555555-5555-4555-8555-555555555555';

const OWNER = {
  identityId: 'identity-owner',
  accountId: '11111111-1111-4111-8111-111111111111',
  username: 'owner',
  isNodeAdmin: true,
  isOwner: true,
};

const SPACE_ROW = {
  id: SPACE_ID,
  name: 'lvlvup',
  description: '',
  github_repo: null,
  created_at: new Date('2026-08-06T04:00:00.000Z'),
  member_count: '1',
  // No `unread_total`: 161 took it off `SPACE_COLUMNS`, so the select this row
  // stands in for no longer returns the column and `SpaceRow` no longer has the
  // field. Left in place it would be a fixture claiming a shape the handler
  // cannot produce.
};

class FakeDb implements Db {
  calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  failTeammates = false;

  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> {
    // No loop yet, and no Dreamer row to attach one to — this fake never
    // reflects its own inserts back, so the loop seeder correctly declines
    // rather than minting a loop that names nobody.
    if (sql.includes('join public.loops')) return [] as R[];
    if (sql.includes('join public.team_members')) return [] as R[];
    if (sql.includes('from public.spaces s')) return [SPACE_ROW] as R[];
    throw new Error(`unexpected query: ${sql}`);
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ fn, args });
    if (fn === 'create_space') {
      return {
        space: { id: SPACE_ID },
        memberId: MEMBER_ID,
        defaultChannelId: CHANNEL_ID,
      } as T;
    }
    if (fn === 'public.create_team_member' && this.failTeammates) {
      throw new Error('only a member may own a team_member persona');
    }
    return {} as T;
  }

  tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    return run({
      query: <R>(sql: string) => this.query<R>(claims, sql),
      rpc: <T2>(fn: string, args: readonly unknown[] = []) => this.rpc<T2>(claims, fn, args),
    });
  }

  async end(): Promise<void> {}
}

function request(): RequestContext {
  const opName = 'spaces.create' as OperationName;
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: {},
    query: new URLSearchParams(),
    body: { name: 'lvlvup' },
    requestId: 'request-spaces-create',
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function handler(db: Db, launchBootstrap: boolean | undefined) {
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    uiDir: undefined,
    maxBodyBytes: 1024 * 1024,
    databaseUrl: undefined,
    ...(launchBootstrap === undefined ? {} : { launchBootstrap }),
  };
  return spacesCreate({ db, config, owner: async () => OWNER });
}

const seedNames = (db: FakeDb): string[] =>
  db.calls.filter(({ fn }) => fn === 'public.create_team_member').map(({ args }) => String(args[1]));

describe('spaces.create default teammates', () => {
  it('seeds the launch catalog roster into the space it just created', async () => {
    const db = new FakeDb();
    const result = await handler(db, true)(request());

    // The launch-catalog roster, then the Dispatcher (D8). It is seeded here
    // and nowhere else: teammate creation is owner-governed, so an agent that
    // needs a dispatcher can never bring one into being at runtime.
    expect(seedNames(db)).toEqual([
      ...LAUNCH_MODEL_CATALOG.map((entry) => entry.seedName),
      DREAMER_SEED_NAME,
      DISPATCHER_SEED_NAME,
    ]);
    expect(db.calls).toContainEqual({
      fn: 'public.create_team_member',
      args: expect.arrayContaining(['GPT 6 Astra Teammate', 'gpt-6-astra', 'codex']),
    });
    for (const { args } of db.calls.filter(({ fn }) => fn === 'public.create_team_member')) {
      expect(args[0]).toBe(SPACE_ID);
    }
    expect(result).toMatchObject({ status: 201, data: { memberId: MEMBER_ID } });
  });

  it('leaves the space bare on a node that does not bootstrap launch resources', async () => {
    const db = new FakeDb();
    await handler(db, undefined)(request());

    expect(seedNames(db)).toEqual([]);
  });

  it('still returns the space when a persona insert is refused', async () => {
    const db = new FakeDb();
    db.failTeammates = true;

    const result = await handler(db, true)(request());

    expect(result).toMatchObject({ status: 201, data: { space: { id: SPACE_ID } } });
  });
});
