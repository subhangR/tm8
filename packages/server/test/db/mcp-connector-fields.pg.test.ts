/**
 * Migration 340: the §5.1 connector fields, and the two things changing the
 * security fingerprint could have broken.
 *
 * The first test is a REHEARSAL, not a fixture: it applies the sequence up to
 * 336, creates a connector and seals a connection the old way, and only then
 * applies 340 and 341. That is the only way to prove the two claims that matter
 * to anyone already running tm8:
 *
 *   - the connection is still `ready` afterwards (the fingerprint re-stamp), and
 *   - its ciphertext still opens (`key_id` NULL keeps the pre-341 unkeyed AAD).
 *
 * A fixture that applied every migration first would pass while both were broken.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mcpServerKey, mcpGateOpen, McpServerDefinitionSchema } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { McpCredentialStore } from '../../src/mcp/credential-store.js';
import { loadOrCreateCredentialKey } from '../../src/credentials/credential-key.js';
import { sealSecret } from '../../src/credentials/secret-box.js';
import { loadMcpServer } from '../../src/mcp/definitions.js';

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase; let db: Db; let dir: string; let store: McpCredentialStore;
const spaceId = randomUUID(), adminMember = randomUUID(), plainMember = randomUUID();
const adminIdentity = 'mcp-fields-admin-' + randomUUID(), plainIdentity = 'mcp-fields-member-' + randomUUID();
let legacyServer: string; let legacyCredential: string;
// A second connector, so the gate change in the first test cannot invalidate
// the row the rotation test needs to still be openable.
let rotatableServer: string; let rotatableCredential: string;
const LEGACY_SECRET = 'legacy-canary-secret';

const base = (name: string) => ({ name, transport: 'http', url: 'https://example.test/mcp',
  envKeys: [], headerKeys: ['Authorization'], auth: { type: 'api_key', headerName: 'Authorization' }, approved: true });
const auth = (identityId = adminIdentity): DbClaims => ({ identityId, authKind: 'browser', sessionSpaceId: spaceId, requestId: randomUUID() });
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>) => db.tx(auth(identityId), fn);
const create = (definition: Record<string, unknown>) =>
  as(adminIdentity, q => q.rpc<{ entity: { id: string; version: number } }>('create_mcp_server_entity', [spaceId, JSON.stringify(definition), null, randomUUID()]));

/** Every migration strictly before the two this task adds. */
function filesBefore340(): string[] {
  return migrationFiles().filter(file => Number(file.slice(0, 3)) < 340);
}
function files340Onwards(): string[] {
  return migrationFiles().filter(file => Number(file.slice(0, 3)) >= 340);
}

/**
 * Seal and insert a connection EXACTLY as a pre-341 server did: the unkeyed
 * `<space>|<credential>|mcp` AAD and the ten-argument `create_mcp_credential`.
 * Deliberately not through McpCredentialStore — that now passes fourteen
 * arguments and binds the key id, which is the very thing under test.
 */
async function sealLegacyCredential(serverId: string, label: string, value: string): Promise<string> {
  const credentialId = randomUUID();
  const sealed = sealSecret(await loadOrCreateCredentialKey(dir), JSON.stringify({ kind: 'api_key', value }),
    { spaceId, credentialId, provider: 'mcp' });
  const [revision] = await scratch.query<{ r: number }>('select mcp_security_revision as r from public.mcp_servers where entity_id=$1', [serverId]);
  await as(adminIdentity, q => q.rpc('create_mcp_credential', [credentialId, spaceId, serverId, label,
    sealed.ciphertext, sealed.nonce, 'api_key', null, false, Number(revision!.r)]));
  return credentialId;
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_connector_fields');
  scratch.apply(filesBefore340());
  db = createDb(scratch.url, { max: 4 });
  dir = await mkdtemp(join(tmpdir(), 'mcp-fields-'));
  store = new McpCredentialStore(db, dir);
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const identity of [adminIdentity, plainIdentity]) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', [identity]);
    }
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP fields',$2)", [spaceId, adminIdentity]);
    for (const [id, identity, role] of [[adminMember, adminIdentity, 'owner'], [plainMember, plainIdentity, 'member']] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [id, spaceId]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)', [id, spaceId, identity, role]);
    }
  });

  // --- the pre-340 world: a connector and two connections sealed the old way.
  legacyServer = (await create(base('legacy'))).entity.id;
  legacyCredential = await sealLegacyCredential(legacyServer, 'Legacy key', LEGACY_SECRET);
  rotatableServer = (await create(base('rotatable'))).entity.id;
  rotatableCredential = await sealLegacyCredential(rotatableServer, 'Rotate me', 'first-secret');
  // Sanity: it opened before the migration. If this breaks, the rehearsal below
  // proves nothing, so fail loudly here rather than pass a hollow test.
  const opened = await store.read(auth(), { spaceId, serverId: legacyServer, credentialId: legacyCredential });
  if (JSON.stringify(opened.secret) !== JSON.stringify({ kind: 'api_key', value: LEGACY_SECRET })) {
    throw new Error('pre-340 fixture did not seal a readable legacy credential');
  }

  // --- and now 340 and 341 land under those rows' feet.
  scratch.apply(files340Onwards());
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); if (dir) await rm(dir, { recursive: true, force: true }); });

it('a connection sealed before 340/341 stays ready and still decrypts, and a gate change then invalidates it', async () => {
  const binding = { spaceId, serverId: legacyServer, credentialId: legacyCredential };
  // 340 redefines internal.mcp_security_fingerprint_json (firstParty, gates).
  // Without its re-stamp this would now read `credential_definition_changed`
  // for every connection on the node, edited or not.
  const readiness = await as(adminIdentity, q => q.rpc<{ ready: boolean; reason: string }>('mcp_credential_readiness', [legacyServer, legacyCredential]));
  expect(readiness).toEqual({ ready: true, reason: 'ready' });
  // key_id stays NULL, so the opener must choose the LEGACY unkeyed AAD. No
  // re-encrypt, no data migration, no fallback-and-retry.
  const after = await scratch.query<{ key_id: string | null }>('select key_id from public.space_credentials where id=$1', [legacyCredential]);
  expect(after[0]!.key_id).toBeNull();
  const opened = await store.read(auth(), binding);
  expect(opened.secret).toEqual({ kind: 'api_key', value: LEGACY_SECRET });
  expect(opened.keyId).toBeNull();

  // A gate change IS a security change: the revision bumps and consent lapses.
  const current = await as(adminIdentity, q => loadMcpServer(q, legacyServer));
  await as(adminIdentity, q => q.rpc('update_mcp_server_entity', [legacyServer, current.version,
    JSON.stringify({ ...base('legacy'), gates: { gmailSend: false } }), null, randomUUID()]));
  const invalidated = await as(adminIdentity, q => q.rpc<{ ready: boolean; reason: string }>('mcp_credential_readiness', [legacyServer, legacyCredential]));
  expect(invalidated).toEqual({ ready: false, reason: 'credential_definition_changed' });
  await expect(store.read(auth(), binding)).rejects.toThrow();
});

it('a rotation upgrades a legacy row to the active key id in one statement', async () => {
  const binding = { spaceId, serverId: rotatableServer, credentialId: rotatableCredential };
  expect((await store.read(auth(), binding)).keyId).toBeNull();
  await store.rotate(auth(), binding, 'second-secret');
  const row = await scratch.query<{ key_id: string | null }>('select key_id from public.space_credentials where id=$1', [rotatableCredential]);
  expect(row[0]!.key_id).toBe('local:v1');
  // Sealed under the KEYED AAD now, and the row says so: both halves moved
  // together, which is why rekey_mcp_credential exists at all.
  const reopened = await store.read(auth(), binding);
  expect(reopened.secret).toEqual({ kind: 'api_key', value: 'second-secret' });
  expect(reopened.keyId).toBe('local:v1');
  // A key id the row does not actually carry must not open it: the AAD binds it.
  await scratch.query(`update public.space_credentials set key_id=null where id=$1`, [rotatableCredential]);
  await expect(store.read(auth(), binding)).rejects.toThrow();
  await scratch.query(`update public.space_credentials set key_id='local:v1' where id=$1`, [rotatableCredential]);
  expect((await store.read(auth(), binding)).secret).toEqual({ kind: 'api_key', value: 'second-secret' });
});

it('SQL and the contract admit the §5.1 fields and refuse malformed ones', async () => {
  const full = { ...base('catalogfull'), catalogId: 'google.gmail', serverKey: 'gmail_team', defaultOn: true,
    allowExternalClients: true, firstParty: true, gates: { gmailSend: false, gmailRead: true } };
  expect(McpServerDefinitionSchema.parse(full)).toMatchObject({ catalogId: 'google.gmail', serverKey: 'gmail_team', gates: { gmailSend: false } });
  const stored = await create(full);
  expect((await as(plainIdentity, q => loadMcpServer(q, stored.entity.id))).definition).toMatchObject(
    { catalogId: 'google.gmail', serverKey: 'gmail_team', defaultOn: true, allowExternalClients: true, firstParty: true });

  for (const patch of [
    { catalogId: 'Google.Gmail' },          // upper case
    { catalogId: '.leading' },
    { serverKey: 'Gmail' },                 // upper case
    { serverKey: '2fa' },                   // leading digit
    { serverKey: 'gmail-team' },            // hyphen is not a tool-name character
    { serverKey: 'tm8' },                   // reserved
    { defaultOn: 'yes' },
    { firstParty: 1 },
    { gates: { 'bad name': false } },
    { gates: { gmailSend: 'false' } },
    { gates: [] },
    { unknownField: true },
  ] as Record<string, unknown>[]) {
    await expect(create({ ...base('reject-' + randomUUID().slice(0, 8)), ...patch })).rejects.toBeTruthy();
    expect(() => McpServerDefinitionSchema.parse({ ...base('reject'), ...patch })).toThrow();
  }
});

it('the effective server key is unique within the space, explicit or derived', async () => {
  await create({ ...base('keyholder'), serverKey: 'held' });
  // Another explicit key, same value.
  await expect(create({ ...base('keyholder2'), serverKey: 'held' })).rejects.toBeTruthy();
  // A DERIVED key colliding with an explicit one: `held` normalises to `held`.
  await expect(create(base('held'))).rejects.toBeTruthy();
  // Two names that normalise alike collide too: `my-tool` and `my_tool`.
  await create(base('my-tool'));
  await expect(create(base('my_tool'))).rejects.toBeTruthy();
  // And a free key is still free.
  await expect(create({ ...base('keyholder3'), serverKey: 'unheld' })).resolves.toBeTruthy();
});

it('mcpServerKey mirrors internal.mcp_effective_server_key', async () => {
  const cases = ['gmail', 'My-Tool', 'linear_team', '2fa_thing', 'a__b', '_leading', 'Trailing_'];
  for (const name of cases) {
    const [row] = await scratch.query<{ key: string }>('select internal.mcp_effective_server_key(jsonb_build_object($1::text, $2::text)) as key', ['name', name]);
    expect(mcpServerKey({ name })).toBe(row!.key);
  }
  // An explicit key always wins, in both languages.
  const [explicit] = await scratch.query<{ key: string }>(`select internal.mcp_effective_server_key('{"name":"Gmail","serverKey":"inbox"}'::jsonb) as key`);
  expect(mcpServerKey({ name: 'Gmail', serverKey: 'inbox' })).toBe(explicit!.key);
  // An absent gate is open; an explicit false is shut.
  expect(mcpGateOpen({ gates: { gmailSend: false } }, 'gmailSend')).toBe(false);
  expect(mcpGateOpen({ gates: { gmailSend: false } }, 'gmailRead')).toBe(true);
  expect(mcpGateOpen({}, 'anything')).toBe(true);
});

it('the fingerprint covers firstParty and gates, and ignores the presentation fields', async () => {
  const fingerprint = async (definition: Record<string, unknown>) =>
    (await scratch.query<{ f: string }>('select internal.mcp_security_fingerprint_json($1::jsonb) as f', [JSON.stringify(definition)]))[0]!.f;
  const plain = await fingerprint(base('fp'));
  // §5.1: these two are consent-bearing.
  expect(await fingerprint({ ...base('fp'), firstParty: true })).not.toBe(plain);
  expect(await fingerprint({ ...base('fp'), gates: { gmailSend: false } })).not.toBe(plain);
  // These four are not: renaming a tool prefix must not revoke a connection.
  for (const patch of [{ catalogId: 'figma' }, { serverKey: 'figma' }, { defaultOn: true }, { allowExternalClients: true }]) {
    expect(await fingerprint({ ...base('fp'), ...patch })).toBe(plain);
  }
});
