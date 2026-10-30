/**
 * Labels (408; BRIDGE-ENTITY-DESIGN §3.8) over authenticated HTTP, against a
 * scratch database with every migration applied.
 *
 * `labels.list|create|update|archive`; `labels` on `entities.create` and
 * `entities.patch` under expectedVersion; the summary's `labels`; and the
 * `labels` (all of) / `labelsAny` (any of) collection filters.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LabelViewSchema } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2EntitiesCommandsTrackingHandlers } from '../../src/facade/handlers/w2/entities-commands-tracking.js';
import { registerW2CollectionsGraphUndoHandlers } from '../../src/facade/handlers/w2/graph-undo.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerLabelHandlers } from '../../src/labels/handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), authSession = randomUUID();
const otherSpace = randomUUID(), otherMember = randomUUID();
const identityId = 'labels-http-owner', secret = generateSecret(), token = formatToken(authSession, secret);
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });

beforeAll(async () => {
  database = await createW1ScratchDatabase('labels_ops');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1),($2,$2)', [identityId, 'labels-http-other']);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identityId]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Labels fixture',$2),($3,'Elsewhere',$4)",
      [space, identityId, otherSpace, 'labels-http-other']);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1),($3,$4,'member',0,$3)",
      [member, space, otherMember, otherSpace]);
    await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name)
                   values($1,$2,$3,'owner',$3),($4,$5,$6,'owner',$6)`,
      [member, space, identityId, otherMember, otherSpace, 'labels-http-other']);
    await c.query("insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values($1,$2,'cli',$3,$4,now()+interval '1 hour')",
      [authSession, account, space, hashToken(secret)]);
  });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  const deps = { db, config, owner };
  registerLabelHandlers(registry, deps);
  registerW2EntitiesCommandsTrackingHandlers(registry, deps);
  registerW2CollectionsGraphUndoHandlers(registry, deps);
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function request(method: string, path: string, body?: Record<string, unknown>, withMutation = true) {
  const payload = body === undefined ? undefined : withMutation ? { clientMutationId: randomUUID(), ...body } : body;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, json: await response.json() };
}
const ok = (result: { status: number; json: any }) => {
  expect([200, 201], JSON.stringify(result.json)).toContain(result.status);
  return result.json.data;
};
const refused = (result: { status: number; json: any }, status: number, code: string) => {
  expect(result.status, JSON.stringify(result.json)).toBe(status);
  expect(result.json.error.code).toBe(code);
  return result.json.error;
};
const list = async (archived = false) =>
  ok(await request('GET', `/v2/spaces/${space}/labels${archived ? '?includeArchived=true' : ''}`)).items as Array<{ id: string; name: string; version: number; archivedAt: string | null }>;
const bugId = async () => (await list()).find(l => l.name === 'bug')!.id;
const getEntity = async (id: string) => ok(await request('GET', `/v2/entities/${id}`));
const createTask = async (title: string, labels?: string[]) =>
  ok(await request('POST', '/v2/entities', { spaceId: space, kind: 'task', title, ...(labels ? { labels } : {}) })).entity as { id: string; version: number };
const query = async (filters: Record<string, unknown>) =>
  (ok(await request('POST', '/v2/collections/query', { spaceId: space, kinds: ['task'], filters }, false)).page.items as Array<{ id: string }>).map(i => i.id).sort();

describe('labels.*', () => {
  it('lists bug, seeded in the space', async () => {
    const labels = await list();
    expect(labels.map(l => l.name)).toContain('bug');
    for (const label of labels) LabelViewSchema.parse(label);
  });

  it('creates, updates and archives; names stay unique case-insensitively', async () => {
    const created = LabelViewSchema.parse(ok(await request('POST', `/v2/spaces/${space}/labels`,
      { name: 'Flaky', colour: 'ABCDEF', description: 'Fails sometimes' })));
    expect(created).toMatchObject({ name: 'Flaky', colour: '#abcdef', archivedAt: null, spaceId: space });
    refused(await request('POST', `/v2/spaces/${space}/labels`, { name: 'flaky' }), 409, 'invariant_violation');

    const renamed = ok(await request('PATCH', `/v2/labels/${created.id}`, { expectedVersion: created.version, name: 'Flaky test' }));
    expect(renamed).toMatchObject({ name: 'Flaky test', version: created.version + 1 });
    refused(await request('PATCH', `/v2/labels/${created.id}`, { expectedVersion: created.version, name: 'x' }), 409, 'version_conflict');

    const archived = ok(await request('POST', `/v2/labels/${created.id}/archive`, { expectedVersion: renamed.version }));
    expect(archived.archivedAt).not.toBeNull();
    expect((await list(true)).map(l => l.name)).toContain('Flaky test');
    expect((await list()).map(l => l.name)).not.toContain('Flaky test');
    // A label is archived, never deleted.
    refused(await request('DELETE', `/v2/entities/${created.id}`, {}), 409, 'invariant_violation');
    // archived=false restores it.
    const restored = ok(await request('PATCH', `/v2/labels/${created.id}`, { expectedVersion: archived.version, archived: false }));
    expect(restored.archivedAt).toBeNull();
  });

  it('refuses a non-member space', async () => {
    refused(await request('GET', `/v2/spaces/${otherSpace}/labels`), 403, 'forbidden');
  });
});

describe('labels on entities', () => {
  it('creates a task labelled bug in the same call, at version 1', async () => {
    const bug = await bugId();
    const task = await createTask('Login is broken', [bug]);
    const read = await getEntity(task.id);
    expect(read).toMatchObject({ version: 1, labels: [bug] });
  });

  it('adds and removes under expectedVersion, alone or beside a title', async () => {
    const bug = await bugId();
    const flaky = ok(await request('POST', `/v2/spaces/${space}/labels`, { name: 'intermittent' })).id as string;
    const task = await createTask('Sometimes red');
    expect((await getEntity(task.id)).labels).toBeUndefined();

    ok(await request('PATCH', `/v2/entities/${task.id}`, { expectedVersion: task.version, labels: { add: [bug, flaky] } }));
    let read = await getEntity(task.id);
    expect(read).toMatchObject({ version: task.version + 1, labels: [bug, flaky] });
    refused(await request('PATCH', `/v2/entities/${task.id}`, { expectedVersion: task.version, labels: { remove: [bug] } }), 409, 'version_conflict');

    const before = read.version;
    ok(await request('PATCH', `/v2/entities/${task.id}`, { expectedVersion: before, title: 'Sometimes red (CI)', labels: { remove: [flaky] } }));
    read = await getEntity(task.id);
    // One patch, one version: the labels half does not move it again (408 D4).
    expect(read).toMatchObject({ title: 'Sometimes red (CI)', labels: [bug], version: before + 1 });
  });

  it('refuses a label from another space', async () => {
    const foreign = (await database.query<{ id: string }>(
      `select entity_id::text id from public.labels where space_id = $1`, [otherSpace]))[0]!.id;
    const task = await createTask('Foreign label');
    const error = refused(await request('PATCH', `/v2/entities/${task.id}`, { expectedVersion: task.version, labels: { add: [foreign] } }), 400, 'invalid_input');
    expect(error.message).toMatch(/not a label in this space/);
  });

  it('filters a query by labels (all of) and labelsAny (any of)', async () => {
    const bug = await bugId();
    const flaky = (ok(await request('POST', `/v2/spaces/${space}/labels`, { name: 'p1' }))).id as string;
    const both = await createTask('Both', [bug, flaky]);
    const onlyBug = await createTask('Only bug', [bug]);
    const onlyFlaky = await createTask('Only p1', [flaky]);
    await createTask('Neither');

    expect(await query({ labels: [bug, flaky] })).toEqual([both.id]);
    expect(await query({ labelsAny: [flaky] })).toEqual([both.id, onlyFlaky.id].sort());
    const bugs = await query({ labels: [bug] });
    expect(bugs).toEqual(expect.arrayContaining([both.id, onlyBug.id]));
    expect(bugs).not.toContain(onlyFlaky.id);
  });
});
