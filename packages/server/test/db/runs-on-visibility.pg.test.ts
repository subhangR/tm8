/**
 * runs_on is listed only from its session (src/facade/services/w2/runs-on-visibility.ts).
 *
 * The binding "this session runs on that card" is space-visible from the
 * session. The credential side, the list of sessions that ran on a card, is
 * `credentials.space.usage` and gated there (270), so no read that lists edges
 * may rebuild it: every path is driven here as a second member, against a real
 * bound session, and must show the edge from the session and never from the
 * credential. The credential's detail carries one counted summary instead.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getOperation } from '@tm8/contract';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'rov-owner';
const A = 'rov-a';
const B = 'rov-b';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let registry: HandlerRegistry;
const ids: Record<string, string> = {};

type Client = import('pg').PoolClient;

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

/** Every read below is B's: a member of the space who neither launched the session nor owns the card. */
async function call<T>(opName: string, opts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown }): Promise<T> {
  const op = getOperation(opName);
  const result = await registry.get(opName)!({
    op, opName, params: opts.params ?? {}, query: new URLSearchParams(opts.query ?? {}), body: opts.body,
    requestId: `req_${randomUUID()}`, identity: { kind: 'auto-owner' }, headers: {}, method: op.method, path: op.path,
  } as never);
  return (result !== null && typeof result === 'object' && 'data' in result ? (result as { data: T }).data : result) as T;
}

interface EdgeLike { type: string; source: { id: string }; target: { id: string } }
const runsOn = (edges: readonly EdgeLike[]): EdgeLike[] => edges.filter((e) => e.type === 'runs_on');

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-rov-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('runs_on_visibility');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, A, B]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, $2, $2)`, [identity, identity === OWN]);
    }
    ids.S = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2)`, [ids.S, OWN]);
    for (const [key, identity, role] of [['OWN', OWN, 'owner'], ['A', A, 'member'], ['B', B, 'member']] as const) {
      const member = ids[key] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`,
        [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids.S, identity, role]);
    }
  });
  ids.credential = (await store.create(claims(A), {
    spaceId: ids.S, provider: 'anthropic', shape: 'api_key',
    label: 'Team Claude', secret: `sk-${randomUUID().replaceAll('-', '')}`,
  })).id;
  for (const key of ['session1', 'session2']) {
    ids[key] = await asOwner(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`,
        [id, ids.S, ids.A]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind) values ($1, 'run', 'spawning', 'agent')`, [id]);
      return id;
    });
    const launch = {
      tool: 'claude-code', credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: ids.credential }, effectiveCredentialSources: { anthropic: 'space' },
    };
    const bound = await db.rpc<{ credentialBinding: string }>(claims(A, 'agent'), 'record_session_manifest',
      [ids[key], JSON.stringify({ launch })]);
    expect(bound.credentialBinding).toBe('bound');
  }
  const owner = (): Promise<LoopbackOwner> => Promise.resolve({
    identityId: B, accountId: '00000000-0000-0000-0000-000000000000', username: B, isNodeAdmin: false, isOwner: false,
  });
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, { db, config: {} as never, owner });
  registerEventHandlers(registry, { db, config: {} as never, owner });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('the fixture: two sessions bound to one card, both readable by B', () => {
  it('has the two edges in the table', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*) n from public.edges where type = 'runs_on' and dst_id = $1`, [ids.credential]);
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe('entities.connections', () => {
  it('lists runs_on outgoing from the session', async () => {
    const page = await call<{ items: EdgeLike[] }>('entities.connections',
      { params: { id: ids.session1! }, query: { direction: 'outgoing' } });
    expect(runsOn(page.items).map((e) => e.target.id)).toEqual([ids.credential]);
  });

  it('never lists runs_on incoming to the credential, in any direction', async () => {
    for (const direction of ['incoming', 'both']) {
      const page = await call<{ items: EdgeLike[] }>('entities.connections',
        { params: { id: ids.credential! }, query: { direction } });
      expect(runsOn(page.items), direction).toEqual([]);
    }
    const typed = await call<{ items: EdgeLike[] }>('entities.connections',
      { params: { id: ids.credential! }, query: { direction: 'incoming', type: 'runs_on' } });
    expect(typed.items).toEqual([]);
  });
});

describe('entities.get', () => {
  it('the credential carries ONE counted runs_on group pointing at the usage read, with no edges', async () => {
    const detail = await call<{ connections: { incoming: Array<{ type: string; edges: unknown[]; summary?: unknown }> } }>(
      'entities.get', { params: { id: ids.credential! } });
    const groups = detail.connections.incoming.filter((g) => g.type === 'runs_on');
    expect(groups).toEqual([{
      type: 'runs_on', direction: 'incoming', label: 'runs_on (incoming)', edges: [],
      summary: { count: 2, operation: 'credentials.space.usage' },
    }]);
  });

  it('the session lists its own runs_on edge', async () => {
    const detail = await call<{ connections: { outgoing: Array<{ type: string; edges: EdgeLike[] }> } }>(
      'entities.get', { params: { id: ids.session1! } });
    const group = detail.connections.outgoing.find((g) => g.type === 'runs_on');
    expect(group?.edges.map((e) => e.target.id)).toEqual([ids.credential]);
  });
});

describe('edges.list', () => {
  it('lists runs_on only from an outgoing read anchored on the session', async () => {
    const own = await call<{ items: EdgeLike[] }>('edges.list',
      { query: { source: ids.session1!, direction: 'outgoing', type: 'runs_on' } });
    expect(own.items.map((e) => e.target.id)).toEqual([ids.credential]);
    const incoming = await call<{ items: EdgeLike[] }>('edges.list',
      { query: { source: ids.credential!, direction: 'incoming', type: 'runs_on' } });
    expect(incoming.items).toEqual([]);
    const unanchored = await call<{ items: EdgeLike[] }>('edges.list', { query: { type: 'runs_on' } });
    expect(unanchored.items).toEqual([]);
  });
});

describe('graph.query', () => {
  it('draws runs_on from a session in focus, and none around the credential', async () => {
    const fromSession = await call<{ edges: Array<{ type: string; sourceId?: string; srcId?: string }> }>('graph.query',
      { body: { spaceId: ids.S, focusId: ids.session1, hops: 1 } });
    expect(fromSession.edges.filter((e) => e.type === 'runs_on')).toHaveLength(1);
    const fromCredential = await call<{ edges: Array<{ type: string }> }>('graph.query',
      { body: { spaceId: ids.S, focusId: ids.credential, hops: 2 } });
    expect(fromCredential.edges.filter((e) => e.type === 'runs_on')).toEqual([]);
    const unfocused = await call<{ edges: Array<{ type: string }> }>('graph.query', { body: { spaceId: ids.S } });
    expect(unfocused.edges.filter((e) => e.type === 'runs_on')).toEqual([]);
  });
});

describe('collections.query filters.edge', () => {
  it('finds a session\'s credential, never a credential\'s sessions', async () => {
    const sessions = await call<{ page: { items: Array<{ id: string }> } }>('collections.query',
      { body: { spaceId: ids.S, filters: { edge: { type: 'runs_on', direction: 'outgoing', entityId: ids.credential } } } });
    expect(sessions.page.items).toEqual([]);
    const cards = await call<{ page: { items: Array<{ id: string }> } }>('collections.query',
      { body: { spaceId: ids.S, filters: { edge: { type: 'runs_on', direction: 'incoming', entityId: ids.session1 } } } });
    expect(cards.page.items.map((i) => i.id)).toEqual([ids.credential]);
  });
});

describe('entities.context', () => {
  it('v2 connections: the session shows its card; the credential shows no session', async () => {
    const session = await call<{ connections?: Array<{ type: string; dir: string; other: { id: string } }> }>('entities.context',
      { params: { id: ids.session1! }, query: { schema: 'v2', sections: 'connections' } });
    expect(session.connections?.filter((c) => c.type === 'runs_on').map((c) => c.other.id)).toEqual([ids.credential]);
    const credential = await call<{ connections?: Array<{ type: string }> }>('entities.context',
      { params: { id: ids.credential! }, query: { schema: 'v2', sections: 'connections' } });
    expect((credential.connections ?? []).filter((c) => c.type === 'runs_on')).toEqual([]);
  });

  it('v1 edges: the credential shows no runs_on', async () => {
    const credential = await call<{ edges?: Array<{ type: string }> }>('entities.context', { params: { id: ids.credential! } });
    expect(JSON.stringify(credential)).not.toContain('"runs_on"');
  });
});

describe('events', () => {
  it('events.poll carries no runs_on edge event, though the log holds them', async () => {
    // The capture trigger logs every edge write; the mapper drops runs_on
    // before projection (not as a reported skip: their author is the session,
    // which is not an actor, so projecting them would only log an error).
    const logged = await database.query<{ n: string }>(
      `select count(*) n from public.workspace_events
        where event_type in ('edge.upsert', 'edge.deleted') and payload->>'type' = 'runs_on'`);
    expect(Number(logged[0]!.n)).toBe(2);
    const page = await call<{ items: Array<{ type: string; edge?: { type: string } }> }>('events.poll',
      { params: { spaceId: ids.S! }, query: { since: '0', limit: '500' } });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.filter((e) => e.edge?.type === 'runs_on')).toEqual([]);
  });
});
