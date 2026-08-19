/**
 * The boot gate stays cheap.
 *
 * `spaces.list` is the FIRST request of workspace boot and it gates every other
 * read: nothing paints until it answers. It used to answer in 4 553 ms of
 * Postgres time for a 379-byte response, because `SPACE_COLUMNS` counted unread
 * inline — a correlated subquery over `public.messages` evaluated once per
 * space the viewer belongs to. `spaces.settings` shares those columns and paid
 * 1 842 ms for the same reason. Prod, 2026-08-19, `set role tm8_app`, inside a
 * rolled-back transaction, before/after back-to-back in one session:
 *
 *                          spaces.list          spaces.settings
 *   with unread_total      4 553 ms             1 842 ms
 *                          125 388 buffers       79 671 buffers
 *   without                    0.5 ms                0.4 ms
 *                               30 buffers            22 buffers
 *
 * The buffer counts are the load-bearing evidence; the box is shared and 4-core
 * so the millisecond figures are noisy. 205 059 shared hits to 52 is not noise.
 *
 * The cost is NOT the count's shape, so this file does not pin a shape. Under
 * the RLS policy on `public.messages` (two SECURITY DEFINER
 * `internal.entity_readable()` calls per row, uninlineable) a bare
 * `select count(*) from public.messages` is already ~930 ms on prod-sized data
 * — so every phrasing of the count is expensive, and rephrasing it was never
 * going to get it under the boot gate's budget.
 *
 * So the invariant worth defending is not "count it faster" — it is that the
 * boot gate DOES NOT READ `public.messages` AT ALL. That is what these tests
 * assert, at the level of the SQL the handler actually issues, because that is
 * the property a well-meaning future change ("just fold unread back in, it's
 * one join") would break while every behavioural test stayed green.
 *
 * A timing assertion would be the obvious alternative and would be worse: it
 * needs a prod-sized database to fail on, and it goes flaky on a shared box.
 * The SQL is the durable statement of intent.
 */
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { spacesGet, spacesList, SPACE_COLUMNS } from '../../src/facade/handlers/spaces.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE_ID = '00000000-0000-7000-8000-000000000001';
const CHANNEL_ID = '00000000-0000-7000-8000-000000000003';

/** Every table a select touches, as the query text names them. */
function tablesRead(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+(public\.\w+)/gi)].map((m) => m[1]!.toLowerCase());
}

class RecordingDb implements Db {
  readonly sql: string[] = [];
  readonly rpcs: string[] = [];

  constructor(private readonly rows: (sql: string) => unknown[] = () => []) {}

  private readonly querier: Querier = {
    query: async <R>(sql: string): Promise<R[]> => {
      this.sql.push(sql);
      return this.rows(sql) as R[];
    },
    rpc: async <T>(fn: string): Promise<T> => {
      this.rpcs.push(fn);
      return [] as unknown as T;
    },
  };

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> { return fn(this.querier); }
  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> { return this.querier.query<R>(sql); }
  async rpc<T>(_claims: DbClaims, fn: string): Promise<T> { return this.querier.rpc<T>(fn); }
  async end(): Promise<void> {}
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined },
    owner: async () => ({
      identityId: 'identity-owner',
      accountId: '00000000-0000-7000-8000-000000000099',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  };
}

function context(opName: string, params: Record<string, string> = {}): RequestContext {
  return {
    op: { name: opName, method: 'GET', path: '/test', kind: 'read', status: 'v1' },
    opName,
    params,
    query: new URLSearchParams(),
    body: undefined,
    requestId: 'req-boot-cost',
    identity: { kind: 'auto-owner', identityId: 'identity-owner' },
    headers: {},
    method: 'GET',
    path: '/test',
  } as RequestContext;
}

const SPACE_ROW = {
  id: SPACE_ID,
  name: 'Tharak',
  description: '',
  github_repo: null,
  created_at: '2026-08-09T17:33:50.899Z',
  member_count: '1',
};

describe('spaces.list is off the messages table', () => {
  it('never names public.messages or public.read_marks in the columns it selects', () => {
    expect(tablesRead(SPACE_COLUMNS)).toEqual(['public.members']);
    expect(SPACE_COLUMNS).not.toContain('unread');
  });

  it('issues exactly one query, over spaces and members only', async () => {
    const db = new RecordingDb(() => [SPACE_ROW]);
    await spacesList(deps(db))(context('spaces.list'));

    expect(db.sql).toHaveLength(1);
    expect(db.rpcs).toEqual([]);
    // `spaces` from the FROM clause, `members` from the memberCount subquery —
    // measured at 0.7 ms, which is why it stayed while unread went.
    expect(new Set(tablesRead(db.sql[0]!))).toEqual(new Set(['public.spaces', 'public.members']));
  });

  it('reports unread as null rather than zero, on the list and on a single space', async () => {
    const db = new RecordingDb(() => [SPACE_ROW]);
    const [listed] = await spacesList(deps(db))(context('spaces.list')) as Array<{ unreadTotal: unknown }>;
    const fetched = await spacesGet(deps(db))(context('spaces.get', { spaceId: SPACE_ID })) as { unreadTotal: unknown };

    // The distinction this defends: `0` and `null` render the same to a reader
    // of the JSON but mean opposite things — "caught up" versus "not counted".
    // Only the second is true here, so only the second may be sent.
    expect(listed!.unreadTotal).toBeNull();
    expect(fetched.unreadTotal).toBeNull();
    expect(listed!.unreadTotal).not.toBe(0);
  });
});

describe('spaces.settings is off the messages table too', () => {
  /**
   * `spaces.settings` shares `SPACE_COLUMNS` and is ALSO a boot read — it was
   * measured at 3 233 ms inside boot's parallel stage, and it was paying the
   * same per-space unread subquery as the list. Same invariant, second door.
   */
  it('reads no messages while assembling the space summary', async () => {
    const db = new RecordingDb((sql) => {
      if (sql.includes('from public.members membership')) {
        return [{ entity_id: '00000000-0000-7000-8000-000000000002', role: 'owner' }];
      }
      if (sql.includes('from public.spaces s')) {
        return [{ ...SPACE_ROW, default_channel_id: CHANNEL_ID, default_interaction_profile_id: null, settings_revision: 1 }];
      }
      if (sql.includes('from public.space_menu_configs')) {
        return [{ schema_version: 1, revision: 1, payload: { sections: [] } }];
      }
      return [];
    });
    const registry = new HandlerRegistry();
    registerW2IdentitySpacesHandlers(registry, deps(db));

    await registry.get('spaces.settings')!(context('spaces.settings', { spaceId: SPACE_ID })).catch(() => undefined);

    const spaceSelect = db.sql.find((sql) => sql.includes('from public.spaces s'));
    expect(spaceSelect).toBeDefined();
    expect(tablesRead(spaceSelect!)).not.toContain('public.messages');
    expect(tablesRead(spaceSelect!)).not.toContain('public.read_marks');
  });
});

describe('the measured unread total still has a home', () => {
  /**
   * Taking the count off the cheap read only holds up if the expensive-but-real
   * one still exists. `spaces.navigation` resolves it from
   * `public.unread_counts`, per space, off the boot path — this asserts that
   * route is intact, so "unread moved" cannot quietly become "unread went".
   */
  it('spaces.navigation still calls public.unread_counts', async () => {
    const db = new RecordingDb((sql) =>
      sql.includes('from public.members where space_id')
        ? [{ entity_id: '00000000-0000-7000-8000-000000000002' }]
        : []);
    const registry = new HandlerRegistry();
    registerW2IdentitySpacesHandlers(registry, deps(db));

    const navigation = await registry.get('spaces.navigation')!(
      context('spaces.navigation', { spaceId: SPACE_ID }),
    ) as { unreadTotal: number };

    expect(db.rpcs).toContain('unread_counts');
    // A number, not null: this read DID count.
    expect(navigation.unreadTotal).toBe(0);
  });
});
