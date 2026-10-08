/** Real HTTP, production bearer resolution + tm8_app RLS; no tokens are logged. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SpaceUnreadCountsSchema, type SpaceUnreadCounts } from '@tm8/contract';
import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import { registerW2InboxReadMarksHandlers } from '../../src/facade/handlers/w2/inbox-read-marks.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { applyGameMailboxCounts } from '../../../tm8-ui/src/data/game-mailboxes.js';
import { buildMapModel, type MapInput } from '../../../tm8-ui/src/story/game/map-model/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ hookTimeout: 180_000, testTimeout: 120_000 });
const space = randomUUID(), foreignSpace = randomUUID();
const root = randomUUID(), shipped = randomUUID(), restricted = randomUUID(), foreign = randomUUID();
const privateSession = randomUUID();
const human = () => ({ identityId: `mailbox-${randomUUID()}`, accountId: randomUUID(), memberId: randomUUID() });
const viewer = human(), other = human(), outsider = human();
let database: W1ScratchDatabase;
let db: Db;
let server: FacadeServer;
let base: string;
let viewerToken: string, otherToken: string, outsiderToken: string, pinnedToken: string;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async client => { await client.query('set local role tm8_graph_owner'); return fn(client); });
}

async function post(anchor: string, author: string, options: { visibility?: string; deleted?: boolean; spaceId?: string } = {}): Promise<void> {
  await asOwner(async client => {
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(`insert into public.entities(id,space_id,kind,created_by,visibility,deleted_at)
      values($1,$2,'message',$3,$4,case when $5 then now() else null end)`,
    [id, options.spaceId ?? space, author, options.visibility ?? 'space', options.deleted ?? false]);
    await client.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)',
      [id, anchor, author, 'Unread fixture']);
  });
}

async function mint(who: ReturnType<typeof human>): Promise<{ id: string; token: string }> {
  const secret = generateSecret();
  const row = await db.tx({ identityId: who.identityId, authKind: 'cli' }, q => q.rpc<{ id: string }>(
    'issue_auth_session', [who.accountId, hashToken(secret), 'cli', new Date(Date.now() + 3_600_000).toISOString(), null, 'mailbox-test'],
  ));
  return { id: row.id, token: formatToken(row.id, secret) };
}

async function unread(token: string, spaceId = space): Promise<SpaceUnreadCounts> {
  const response = await fetch(`${base}/v2/spaces/${spaceId}/unread-counts`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  const { data } = await response.json();
  return SpaceUnreadCountsSchema.parse(data);
}
async function markRead(token: string, anchorId: string): Promise<void> {
  const response = await fetch(`${base}/v2/read-marks/${anchorId}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientMutationId: `mailbox-read-${randomUUID()}` }),
  });
  expect(response.status).toBe(200);
}
const count = (snapshot: SpaceUnreadCounts, id: string) => snapshot.counts.find(row => row.anchorId === id)?.unread ?? 0;
const input: MapInput = { scope: { kind: 'space', id: space }, taskHierarchyComplete: true, edges: [], entities: [
  { id: root, kind: 'task', title: 'Root', spaceId: space, status: 'working', mailbox: { count: 3, basis: 'messages' } },
  { id: shipped, kind: 'task', title: 'Shipped child', spaceId: space, parentId: root, status: 'done', mailbox: { count: 4, basis: 'messages' } },
] };

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_unread');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  await asOwner(async client => {
    for (const who of [viewer, other, outsider]) {
      await client.query('insert into public.user_profiles(identity_id,display_name) values($1,$2)', [who.identityId, who.identityId]);
      await client.query('insert into public.accounts(id,identity_id,username) values($1,$2,$3)', [who.accountId, who.identityId, who.identityId]);
    }
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Mailbox A',$3),($2,'Mailbox B',$3)`,
      [space, foreignSpace, viewer.identityId]);
    const viewerForeign = randomUUID();
    for (const [who, spaceId, memberId] of [[viewer, space, viewer.memberId], [other, space, other.memberId], [viewer, foreignSpace, viewerForeign]] as const) {
      await client.query(`insert into public.entities(id,space_id,kind,created_by) values($1,$2,'member',$1)`, [memberId, spaceId]);
      await client.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'member',$3)`,
        [memberId, spaceId, who.identityId]);
    }
    for (const [id, spaceId, visibility, parent] of [[root, space, 'space', null], [shipped, space, 'space', root],
      [restricted, space, 'restricted', null], [foreign, foreignSpace, 'space', null]] as const) {
      await client.query(`insert into public.entities(id,space_id,kind,created_by,visibility,parent_id)
        values($1,$2,'task',$3,$4,$5)`, [id, spaceId, spaceId === space ? other.memberId : viewerForeign, visibility, parent]);
      await client.query(`insert into public.tasks(entity_id,title,work_status) values($1,'Mailbox task',$2)`, [id, id === shipped ? 'done' : 'working']);
    }
    await client.query(`insert into public.entities(id,space_id,kind,created_by,visibility)
      values($1,$2,'work_session',$3,'restricted')`, [privateSession, space, other.memberId]);
    await client.query(`insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'Restricted mailbox','running','none')`, [privateSession]);
  });
  for (let n = 0; n < 2; n++) await post(root, other.memberId);
  await post(root, viewer.memberId);
  for (let n = 0; n < 3; n++) await post(shipped, other.memberId);
  await post(shipped, viewer.memberId);
  await post(restricted, other.memberId);
  await post(privateSession, other.memberId);
  await post(root, other.memberId, { visibility: 'restricted' });
  await post(root, other.memberId, { deleted: true });
  const gate = await mint(viewer);
  viewerToken = gate.token;
  otherToken = (await mint(other)).token;
  outsiderToken = (await mint(outsider)).token;
  const secret = generateSecret();
  const pinned = await db.tx({ identityId: viewer.identityId, authKind: 'cli' }, q => q.rpc<{ id: string }>(
    'enter_space', [space, gate.id, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'pinned-mailbox-test'],
  ));
  pinnedToken = formatToken(pinned.id, secret);
  const owner = async () => ({ identityId: 'not-the-viewer', accountId: randomUUID(), username: 'nobody', isNodeAdmin: false, isOwner: false });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url };
  const registry = new HandlerRegistry();
  registerW2IdentitySpacesHandlers(registry, { db, config, owner });
  registerW2InboxReadMarksHandlers(registry, { db, config, owner });
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }), authRateLimiter: null });
  base = (await server.listen()).url;
});
afterAll(async () => { await server?.close(); await db?.end(); await database?.destroy(); });

describe('per-viewer root mailboxes through real HTTP', () => {
  it('counts other messages and shipped descendants, excludes own/private/deleted messages, and exposes no read cursors', async () => {
    const a = await unread(viewerToken), b = await unread(otherToken);
    expect(a.complete).toBe(true);
    expect(count(a, root)).toBe(2); expect(count(a, shipped)).toBe(3);
    expect(count(b, root)).toBe(1); expect(count(b, shipped)).toBe(1);
    expect(a.counts.map(row => row.anchorId)).not.toContain(restricted);
    expect(a.counts.map(row => row.anchorId)).not.toContain(privateSession);
    expect(a.counts.map(row => row.anchorId)).not.toContain(foreign);
    expect(JSON.stringify(a)).not.toMatch(/lastReadAt|memberId|identityId|authorId/);
    const map = buildMapModel(applyGameMailboxCounts(input, a, space), { type: 'taskland', scope: input.scope! });
    expect(map.places.find(place => place.entityId === root)?.mailbox).toMatchObject({ count: 5, basis: 'unread' });
  });

  it('applies one viewer read mark without changing another viewer, and counts new messages after it', async () => {
    await markRead(viewerToken, shipped);
    const a = await unread(viewerToken), b = await unread(otherToken);
    expect(count(a, shipped)).toBe(0); expect(count(a, root)).toBe(2);
    expect(count(b, shipped)).toBe(1); expect(count(b, root)).toBe(1);
    const map = buildMapModel(applyGameMailboxCounts(input, a, space), { type: 'taskland', scope: input.scope! });
    expect(map.places.find(place => place.entityId === root)?.mailbox).toMatchObject({ count: 2, basis: 'unread' });
    await post(shipped, other.memberId);
    expect(count(await unread(viewerToken), shipped)).toBe(1);
  });

  it('refuses nonmembers and foreign-space pinned sessions, with a positive same-token control', async () => {
    // The viewer belongs to B, but the A pin makes the exact RPC gate false.
    const gate = await db.tx({ identityId: viewer.identityId, authKind: 'cli' }, q =>
      q.query<{ allowed: boolean }>('select internal.is_space_member($1) as allowed', [foreignSpace]));
    const pinned = await db.tx({ identityId: viewer.identityId, authKind: 'cli', sessionSpaceId: space }, q =>
      q.query<{ allowed: boolean }>('select internal.is_space_member($1) as allowed', [foreignSpace]));
    expect(gate).toEqual([{ allowed: true }]);
    expect(pinned).toEqual([{ allowed: false }]);
    for (const [token, spaceId] of [[outsiderToken, space], [pinnedToken, foreignSpace]]) {
      const response = await fetch(`${base}/v2/spaces/${spaceId}/unread-counts`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain('"complete":true');
    }
    expect((await unread(pinnedToken)).complete).toBe(true);
    expect((await unread(viewerToken, foreignSpace)).counts).toEqual([]);
  });
});
