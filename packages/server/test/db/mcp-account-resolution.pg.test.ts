/**
 * Migration 341: Space-scoped connections (G2), key ids and status (G12, §5.2),
 * and §3's account resolution with §7.3's skipping (G15).
 *
 * The resolution tests are deliberately table-ish and paranoid in one direction:
 * every "resolves" case is paired with a "and NOT for the other member" case.
 * The whole point of adding a fallback is that it must not widen who can reach
 * a connection, and a fallback test that only checks the happy path would pass
 * while doing exactly that.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { McpCredentialView } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { McpCredentialStore } from '../../src/mcp/credential-store.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { localKeyProvider, LOCAL_KEY_ID } from '../../src/credentials/key-provider.js';
import { resolveMcpSelections, loadMcpServer } from '../../src/mcp/definitions.js';

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase; let db: Db; let dir: string;
let store: McpCredentialStore; let shares: DbSpaceCredentialStore;
const spaceId = randomUUID();
const adminMember = randomUUID(), aliceMember = randomUUID(), bobMember = randomUUID();
const adminIdentity = 'mcp-res-admin-' + randomUUID();
const aliceIdentity = 'mcp-res-alice-' + randomUUID();
const bobIdentity = 'mcp-res-bob-' + randomUUID();

interface Resolved { credentialId?: string; scope?: string; source?: string; accountLabel?: string|null; unusable?: { credentialId: string; reason: string } }

const keyed = (name: string) => ({ name, transport: 'http', url: 'https://example.test/mcp',
  envKeys: [], headerKeys: ['Authorization'], auth: { type: 'api_key', headerName: 'Authorization' }, approved: true });
const open = (name: string) => ({ name, transport: 'http', url: 'https://example.test/open',
  envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true });
const auth = (identityId: string): DbClaims => ({ identityId, authKind: 'browser', sessionSpaceId: spaceId, requestId: randomUUID() });
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>) => db.tx(auth(identityId), fn);
const connector = async (definition: Record<string, unknown>) =>
  (await as(adminIdentity, q => q.rpc<{ entity: { id: string } }>('create_mcp_server_entity', [spaceId, JSON.stringify(definition), null, randomUUID()]))).entity.id;
const resolve = (identity: string, serverId: string, rootMemberId?: string) =>
  as(identity, q => q.rpc<Resolved | null>('resolve_mcp_account', [serverId, rootMemberId ?? null]));
const list = (identity: string, serverId: string) => as(identity, q => q.rpc<McpCredentialView[]>('list_mcp_credentials', [serverId, null]));
const connect = (identity: string, serverId: string, options: { label: string; value?: string; scope?: 'member'|'space'; accountLabel?: string }) =>
  as(identity, async () => store.create(auth(identity), { spaceId, serverId, label: options.label,
    secret: { kind: 'api_key', value: options.value ?? 'secret-' + randomUUID() },
    ...(options.scope ? { scope: options.scope } : {}), ...(options.accountLabel ? { accountLabel: options.accountLabel } : {}) }) as Promise<{ id: string }>);

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_account_resolution');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  dir = await mkdtemp(join(tmpdir(), 'mcp-resolution-'));
  store = new McpCredentialStore(db, dir);
  shares = new DbSpaceCredentialStore({ db, dataDir: dir });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const identity of [adminIdentity, aliceIdentity, bobIdentity]) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', [identity]);
    }
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP resolution',$2)", [spaceId, adminIdentity]);
    for (const [id, identity, role] of [[adminMember, adminIdentity, 'owner'], [aliceMember, aliceIdentity, 'member'], [bobMember, bobIdentity, 'member']] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [id, spaceId]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)', [id, spaceId, identity, role]);
    }
  });
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); if (dir) await rm(dir, { recursive: true, force: true }); });

// --- §5.2 scope -------------------------------------------------------------

it('only an admin creates a Space connection; it has no member owner and any member can use it', async () => {
  const server = await connector(keyed('spacescope'));
  // §5.2: a Space connection outlives its creator and any admin can rotate it.
  await expect(connect(aliceIdentity, server, { label: 'Sneaky team key', scope: 'space' })).rejects.toBeTruthy();
  const created = await connect(adminIdentity, server, { label: 'Team key', scope: 'space', value: 'team-secret' });

  const [row] = await scratch.query<{ owner_account_id: string|null; visibility: string; space_owned_chosen: boolean; key_id: string }>(
    'select owner_account_id,visibility,space_owned_chosen,key_id from public.space_credentials where id=$1', [created.id]);
  expect(row!.owner_account_id).toBeNull();
  expect(row!.visibility).toBe('public');
  // It was CHOSEN space-owned, so claim_space_credential can never take it over.
  expect(row!.space_owned_chosen).toBe(true);
  expect(row!.key_id).toBe(LOCAL_KEY_ID);

  const view = (await list(bobIdentity, server))[0]!;
  expect(view).toMatchObject({ scope: 'space', visibility: 'space', ownerId: null, usable: true, reason: 'ready' });
  // Bob is an ordinary member: he may USE it and must not be able to manage it.
  expect(view.manageable).toBe(false);
  expect((await list(adminIdentity, server))[0]!.manageable).toBe(true);
  // And it really opens for a member who is not its creator.
  expect((await store.read(auth(bobIdentity), { spaceId, serverId: server, credentialId: created.id })).secret)
    .toEqual({ kind: 'api_key', value: 'team-secret' });
  await expect(store.rotate(auth(bobIdentity), { spaceId, serverId: server, credentialId: created.id }, 'bob-secret')).rejects.toThrow();
  await store.rotate(auth(adminIdentity), { spaceId, serverId: server, credentialId: created.id }, 'rotated-team-secret');
  expect((await store.read(auth(aliceIdentity), { spaceId, serverId: server, credentialId: created.id })).secret)
    .toEqual({ kind: 'api_key', value: 'rotated-team-secret' });
});

it('a personal connection stays private to its owner', async () => {
  const server = await connector(keyed('personalscope'));
  const created = await connect(aliceIdentity, server, { label: 'Alice key', value: 'alice-secret' });
  expect((await list(aliceIdentity, server))[0]).toMatchObject({ scope: 'member', visibility: 'private', usable: true, manageable: true });
  expect((await list(bobIdentity, server))[0]).toMatchObject({ usable: false, manageable: false, reason: 'access_denied' });
  await expect(store.read(auth(bobIdentity), { spaceId, serverId: server, credentialId: created.id })).rejects.toThrow();
});

// --- §5.2 status, key id, labels -------------------------------------------

it('needs_reconnect carries its reason, stops the row being usable, and clears on rotation', async () => {
  const server = await connector(keyed('statusflow'));
  const created = await connect(aliceIdentity, server, { label: 'Expiring key', value: 'status-secret' });
  const binding = { spaceId, serverId: server, credentialId: created.id };
  await as(aliceIdentity, q => q.rpc('set_mcp_credential_status', [spaceId, server, created.id, 'needs_reconnect', 'invalid_grant']));

  expect((await list(aliceIdentity, server))[0]).toMatchObject(
    { status: 'needs_reconnect', statusReason: 'invalid_grant', usable: false, reason: 'needs_reconnect' });
  expect(await as(aliceIdentity, q => q.rpc('mcp_credential_readiness', [server, created.id])))
    .toEqual({ ready: false, reason: 'needs_reconnect' });
  // read_mcp_credential already refuses any status <> 'active', so marking the
  // row is all it takes to stop it being used.
  await expect(store.read(auth(aliceIdentity), binding)).rejects.toThrow();

  await as(aliceIdentity, q => q.rpc('set_mcp_credential_status', [spaceId, server, created.id, 'active', null]));
  expect((await list(aliceIdentity, server))[0]).toMatchObject({ status: 'active', statusReason: null, reason: 'ready' });
  // A rotation also clears the reason, which is the reconnect path for a key.
  await as(aliceIdentity, q => q.rpc('set_mcp_credential_status', [spaceId, server, created.id, 'needs_reconnect', 'scope_reduced']));
  await store.rotate(auth(aliceIdentity), binding, 'rotated-status-secret');
  expect((await list(aliceIdentity, server))[0]).toMatchObject({ status: 'active', statusReason: null });
  for (const bad of ['revoked', 'pending', 'nonsense']) {
    await expect(as(aliceIdentity, q => q.rpc('set_mcp_credential_status', [spaceId, server, created.id, bad, null]))).rejects.toBeTruthy();
  }
});

it('the key id is bound into the AAD, and an unknown one is refused before any crypto', async () => {
  const server = await connector(keyed('keybinding'));
  const created = await connect(aliceIdentity, server, { label: 'Keyed', value: 'keyed-secret' });
  const binding = { spaceId, serverId: server, credentialId: created.id };
  expect((await store.read(auth(aliceIdentity), binding)).keyId).toBe(LOCAL_KEY_ID);
  // Dropping the key id leaves the ciphertext sealed under the KEYED AAD while
  // the row claims the legacy form: the tag check must fail, not fall back.
  await scratch.query('update public.space_credentials set key_id=null where id=$1', [created.id]);
  await expect(store.read(auth(aliceIdentity), binding)).rejects.toThrow();
  await scratch.query(`update public.space_credentials set key_id='local:v1' where id=$1`, [created.id]);
  expect((await store.read(auth(aliceIdentity), binding)).secret).toEqual({ kind: 'api_key', value: 'keyed-secret' });
  // The column refuses an id the provider does not know, as the second line.
  await expect(scratch.query(`update public.space_credentials set key_id='aws-kms:alias/tm8' where id=$1`, [created.id])).rejects.toBeTruthy();
  await expect(localKeyProvider(dir).keyFor('aws-kms:alias/tm8')).rejects.toThrow(/unknown credential key id/);
  await expect(localKeyProvider(dir).keyFor(null)).resolves.toBeInstanceOf(Buffer);
});

it('one connection per connector, owner and provider account label', async () => {
  const server = await connector(keyed('labels'));
  await connect(aliceIdentity, server, { label: 'Alice work', accountLabel: 'alice@example.test' });
  // The same provider account twice for the same member is the duplicate §5.2 forbids.
  await expect(connect(aliceIdentity, server, { label: 'Alice work again', accountLabel: 'Alice@Example.test' })).rejects.toBeTruthy();
  // A second, different provider account is fine...
  await expect(connect(aliceIdentity, server, { label: 'Alice personal', accountLabel: 'alice@home.test' })).resolves.toBeTruthy();
  // ...as is the same provider account for a DIFFERENT member.
  await expect(connect(bobIdentity, server, { label: 'Bob work', accountLabel: 'alice@example.test' })).resolves.toBeTruthy();
  // And unlabelled keys are not constrained: a member may hold two raw keys.
  const plain = await connector(keyed('labelsplain'));
  await expect(connect(aliceIdentity, plain, { label: 'Key one' })).resolves.toBeTruthy();
  await expect(connect(aliceIdentity, plain, { label: 'Key two' })).resolves.toBeTruthy();
});

it('the proxy stamp records last use without being able to read the secret', async () => {
  const server = await connector(keyed('touch'));
  const created = await connect(aliceIdentity, server, { label: 'Touched' });
  expect((await list(aliceIdentity, server))[0]!.lastUsedAt).toBeNull();
  await store.touch(auth(aliceIdentity), { spaceId, serverId: server, credentialId: created.id });
  expect((await list(aliceIdentity, server))[0]!.lastUsedAt).toBeTruthy();
  // It is the same access check as a read: a non-owner cannot even stamp it.
  await expect(store.touch(auth(bobIdentity), { spaceId, serverId: server, credentialId: created.id })).rejects.toThrow();
});

// --- §3 resolution order ----------------------------------------------------

it('resolves nothing when the connector has no connection at all', async () => {
  const server = await connector(keyed('empty'));
  expect(await resolve(aliceIdentity, server)).toBeNull();
});

it('resolves the root personal connection, and only for its owner', async () => {
  const server = await connector(keyed('tier1'));
  const mine = await connect(aliceIdentity, server, { label: 'Alice tier1', accountLabel: 'alice@tier1.test' });
  expect(await resolve(aliceIdentity, server)).toMatchObject(
    { credentialId: mine.id, scope: 'member', source: 'personal', accountLabel: 'alice@tier1.test' });
  // Bob owns nothing here and the row is private: he must get nothing.
  expect(await resolve(bobIdentity, server)).toBeNull();
});

it('falls through to the Space connection, prefers a true Space-owned row, and reports the root broken one', async () => {
  const server = await connector(keyed('tier2'));
  const team = await connect(adminIdentity, server, { label: 'Team tier2', scope: 'space' });
  // Nobody owns it, so every member resolves it the same way.
  for (const identity of [aliceIdentity, bobIdentity, adminIdentity]) {
    expect(await resolve(identity, server)).toMatchObject({ credentialId: team.id, scope: 'space', source: 'space_shared' });
  }
  // Alice's own connection now wins: a pinned-free selection still prefers hers.
  const hers = await connect(aliceIdentity, server, { label: 'Alice tier2' });
  expect(await resolve(aliceIdentity, server)).toMatchObject({ credentialId: hers.id, source: 'personal' });
  expect(await resolve(bobIdentity, server)).toMatchObject({ credentialId: team.id, source: 'space_shared' });

  // Hers breaks. She falls back to the Space's, and the answer still names her
  // broken row so the UI can show the reconnect warning (§10.0).
  await as(aliceIdentity, q => q.rpc('set_mcp_credential_status', [spaceId, server, hers.id, 'needs_reconnect', 'invalid_grant']));
  expect(await resolve(aliceIdentity, server)).toMatchObject({ credentialId: team.id, source: 'space_shared',
    unusable: { credentialId: hers.id, reason: 'needs_reconnect' } });
});

it('a legacy member-owned public row serves the Space tier, but only behind a true Space-owned one', async () => {
  const server = await connector(keyed('legacyshare'));
  // Today's "shared with Space": member-owned, visibility public (G2). Nothing
  // converts it automatically (§5.2), so it must keep resolving.
  const legacy = await connect(aliceIdentity, server, { label: 'Alice shared' });
  await shares.setVisibility(auth(aliceIdentity), legacy.id, 'public');
  expect(await resolve(bobIdentity, server)).toMatchObject({ credentialId: legacy.id, source: 'space_shared', scope: 'member' });
  // A genuine Space connection outranks it.
  const team = await connect(adminIdentity, server, { label: 'Team shared', scope: 'space' });
  expect(await resolve(bobIdentity, server)).toMatchObject({ credentialId: team.id, source: 'space_shared', scope: 'space' });
  // Alice still prefers her own, which is tier 1 even though it is public.
  expect(await resolve(aliceIdentity, server)).toMatchObject({ credentialId: legacy.id, source: 'personal' });
});

it('a connection merely shared with the root never auto-resolves; it needs an explicit pin', async () => {
  const server = await connector(keyed('selectedshare'));
  const shared = await connect(aliceIdentity, server, { label: 'Alice selected', value: 'selected-secret' });
  await shares.share(auth(aliceIdentity), shared.id, bobMember);
  // Bob CAN open it — that is what the share means — but resolution must not
  // reach for it on his behalf (advisor ruling, §3).
  expect((await store.read(auth(bobIdentity), { spaceId, serverId: server, credentialId: shared.id })).secret)
    .toEqual({ kind: 'api_key', value: 'selected-secret' });
  expect(await resolve(bobIdentity, server)).toBeNull();
  // Pinned, it resolves for him.
  const pinned = await as(bobIdentity, q => resolveMcpSelections(q, { spaceId, mcpSelections: [{ serverId: server, credentialId: shared.id }] }));
  expect(pinned.selections[0]).toMatchObject({ ready: true, credentialId: shared.id, credentialSource: 'pinned' });
});

it('the root member parameter must be the claims in force, and must be a member of the space', async () => {
  const server = await connector(keyed('rootparam'));
  const mine = await connect(aliceIdentity, server, { label: 'Alice root' });
  // The real path: bind/authorize run resolution under the root's own claims.
  expect(await resolve(aliceIdentity, server, aliceMember)).toMatchObject({ credentialId: mine.id, source: 'personal' });
  // Naming someone else while running as Alice is refused, loudly. This is what
  // keeps the parameter from becoming a way to borrow another member's account.
  await expect(resolve(aliceIdentity, server, bobMember)).rejects.toThrow(/root member/);
  await expect(resolve(bobIdentity, server, aliceMember)).rejects.toThrow(/root member/);
  // A member id from no space at all is not found rather than silently ignored.
  await expect(resolve(aliceIdentity, server, randomUUID())).rejects.toThrow(/root member/);
});

// --- §7.3 defaults ----------------------------------------------------------

it('defaultOn joins the default set and an equips attachment of the same name beats it', async () => {
  const defaulted = await connector({ ...open('defaulted'), defaultOn: true });
  const task = (await as(adminIdentity, q => q.rpc<{ entity: { id: string } }>('create_task', [spaceId, 'Default task']))).entity.id;
  const bare = await as(aliceIdentity, q => resolveMcpSelections(q, { spaceId, targetIds: [task] }));
  expect(bare.selections.map(s => s.server.id)).toEqual([defaulted]);
  expect(bare.selections[0]).toMatchObject({ ready: true, fromDefault: true });
  // An explicit [] still means all off, defaults included.
  expect((await as(aliceIdentity, q => resolveMcpSelections(q, { spaceId, targetIds: [task], mcpSelections: [] }))).selections).toEqual([]);
  // A disabled or unapproved connector is not a default.
  const current = await as(adminIdentity, q => loadMcpServer(q, defaulted));
  await as(adminIdentity, q => q.rpc('update_mcp_server_entity', [defaulted, current.version,
    JSON.stringify({ ...open('defaulted'), defaultOn: true, enabled: false }), null, randomUUID()]));
  expect((await as(aliceIdentity, q => resolveMcpSelections(q, { spaceId, targetIds: [task] }))).selections).toEqual([]);
});

it('a default that is not ready is skipped with a reason; an explicit one still fails (G15)', async () => {
  const server = await connector({ ...keyed('skippable'), defaultOn: true });
  // Nobody has connected it, so for Bob the default cannot resolve an account.
  const skipped = await as(bobIdentity, q => resolveMcpSelections(q, { spaceId }));
  expect(skipped.selections.map(s => s.server.id)).not.toContain(server);
  expect(skipped.skipped).toEqual(expect.arrayContaining([{ serverId: server, name: 'skippable', reason: 'credential_required' }]));
  // The launch is still READY: that is the whole of G15.
  expect(skipped.ready).toBe(true);

  // Asking for it BY NAME is a different question, and still an error.
  const explicit = await as(bobIdentity, q => resolveMcpSelections(q, { spaceId, mcpSelections: [{ serverId: server }] }));
  expect(explicit.ready).toBe(false);
  expect(explicit.selections[0]).toMatchObject({ reason: 'credential_required' });
  expect(explicit.skipped).toBeUndefined();

  // Once Bob connects it, the same default resolves his account by itself —
  // what `McpPicker` had to work around by sending a trimmed list.
  const his = await connect(bobIdentity, server, { label: 'Bob skippable' });
  const ready = await as(bobIdentity, q => resolveMcpSelections(q, { spaceId }));
  expect(ready.selections.find(s => s.server.id === server)).toMatchObject(
    { ready: true, credentialId: his.id, credentialSource: 'personal', fromDefault: true });
  expect(ready.skipped?.some(s => s.serverId === server)).not.toBe(true);
});

it('pinnedOnly refuses to infer an account, so a live session cannot be re-pointed', async () => {
  const server = await connector(keyed('pinnedonly'));
  const mine = await connect(aliceIdentity, server, { label: 'Alice pinnedonly' });
  // This is the shape `authorize` uses on every proxy call.
  const live = await as(aliceIdentity, q => resolveMcpSelections(q, { spaceId, mcpSelections: [{ serverId: server }] }, { pinnedOnly: true }));
  expect(live.ready).toBe(false);
  expect(live.selections[0]).toMatchObject({ reason: 'credential_required' });
  expect(live.selections[0]?.credentialId).toBeUndefined();
  // Without the flag the same input resolves, which is the bind-time behaviour.
  const atBind = await as(aliceIdentity, q => resolveMcpSelections(q, { spaceId, mcpSelections: [{ serverId: server }] }));
  expect(atBind.selections[0]).toMatchObject({ ready: true, credentialId: mine.id });
});
