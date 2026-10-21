import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { DbMcpOAuthPendingStore, type McpOAuthPendingRow } from '../../src/mcp/oauth.js';

// Migration 342 (§5.4, G1): the pending OAuth table and its two RPCs, against a
// real migrated database. The OAuth wire flow itself is covered by the
// independent fixtures; this file holds the database's half of the rules.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let scratch: W1ScratchDatabase, db: Db, store: DbMcpOAuthPendingStore;
const space = randomUUID(), otherSpace = randomUUID(), owner = randomUUID(), plain = randomUUID();
const ownerIdentity = 'oauth-owner-' + randomUUID(), plainIdentity = 'oauth-member-' + randomUUID(), strangerIdentity = 'oauth-stranger-' + randomUUID();
const ownerClaims: DbClaims = { identityId: ownerIdentity, authKind: 'browser', sessionSpaceId: space };
const plainClaims: DbClaims = { identityId: plainIdentity, authKind: 'browser', sessionSpaceId: space };
const strangerClaims: DbClaims = { identityId: strangerIdentity, authKind: 'browser', sessionSpaceId: otherSpace };
let server = '';

function row(overrides: Partial<McpOAuthPendingRow> = {}): McpOAuthPendingRow {
  return {
    stateHash: createHash('sha256').update(randomBytes(32)).digest(), spaceId: space, serverId: server, definitionVersion: 1,
    scope: 'member', keyId: 'local:v1', ciphertext: randomBytes(64), nonce: randomBytes(12), label: 'Fixture',
    expiresAt: new Date(Date.now() + 600_000), ...overrides,
  };
}
const count = async () => Number((await scratch.query<{ n: string }>('select count(*) as n from internal.mcp_oauth_pending'))[0]!.n);

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_oauth_pending'); scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 }); store = new DbMcpOAuthPendingStore(db);
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.accounts(id,identity_id,username) values($1,$2,'oauth-owner'),($3,$4,'oauth-member'),($5,$6,'oauth-stranger')",
      [randomUUID(), ownerIdentity, randomUUID(), plainIdentity, randomUUID(), strangerIdentity]);
    await c.query("insert into public.user_profiles(identity_id,display_name) values($1,'Owner'),($2,'Member'),($3,'Stranger')", [ownerIdentity, plainIdentity, strangerIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'OAuth',$2),($3,'Other',$4)", [space, ownerIdentity, otherSpace, strangerIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$3,'member',$1),($2,$3,'member',$1)", [owner, plain, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$3,$4,'owner','Owner'),($2,$3,$5,'member','Member')", [owner, plain, space, ownerIdentity, plainIdentity]);
  });
  const definition = { name: 'oauthfixture', transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: [], auth: { type: 'oauth2', clientId: 'fixture' }, approved: true };
  server = (await db.rpc<{ entity: { id: string } }>(ownerClaims, 'create_mcp_server_entity', [space, JSON.stringify(definition), null, randomUUID()])).entity.id;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('internal.mcp_oauth_pending (342)', () => {
  it('stamps the caller identity and stores only what the server sealed', async () => {
    const pending = row({ returnTo: '/#/s/x/chat' });
    const expires = await store.insert(plainClaims, pending);
    expect(Date.parse(expires)).toBeGreaterThan(Date.now() + 590_000);
    const [stored] = await scratch.query<{ identity_id: string; state_hash: Buffer; scope_kind: string; return_to: string }>(
      'select identity_id, state_hash, scope_kind, return_to from internal.mcp_oauth_pending where state_hash = $1', [pending.stateHash]);
    expect(stored).toMatchObject({ identity_id: plainIdentity, scope_kind: 'member', return_to: '/#/s/x/chat' });
    await store.take(plainClaims, pending.stateHash);
  });
  it('is not readable by the app role directly', async () => {
    await expect(db.query(plainClaims, 'select * from internal.mcp_oauth_pending', [])).rejects.toThrow();
  });
  it('is single use, and another identity neither gets nor burns the row', async () => {
    const pending = row(); await store.insert(plainClaims, pending);
    expect(await store.take(ownerClaims, pending.stateHash)).toBeNull();
    expect(await store.take(strangerClaims, pending.stateHash)).toBeNull();
    const taken = await store.take(plainClaims, pending.stateHash);
    expect(taken).toMatchObject({ identityId: plainIdentity, spaceId: space, serverId: server, definitionVersion: 1, scope: 'member', keyId: 'local:v1', label: 'Fixture', returnTo: null });
    expect(Buffer.from(taken!.ciphertext, 'base64').equals(pending.ciphertext)).toBe(true);
    expect(await store.take(plainClaims, pending.stateHash)).toBeNull();
  });
  it('two concurrent takes consume the row exactly once', async () => {
    const pending = row(); await store.insert(plainClaims, pending);
    const results = await Promise.all([store.take(plainClaims, pending.stateHash), store.take(plainClaims, pending.stateHash)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('caps the TTL at ten minutes and consumes an expired row without returning it', async () => {
    const long = row({ expiresAt: new Date(Date.now() + 86_400_000) });
    expect(Date.parse(await store.insert(plainClaims, long))).toBeLessThanOrEqual(Date.now() + 600_000 + 5_000);
    await store.take(plainClaims, long.stateHash);
    const expired = row(); await store.insert(plainClaims, expired);
    await scratch.query("update internal.mcp_oauth_pending set expires_at = now() - interval '1 second' where state_hash = $1", [expired.stateHash]);
    expect(await store.take(plainClaims, expired.stateHash)).toBeNull();
    expect((await scratch.query('select 1 from internal.mcp_oauth_pending where state_hash = $1', [expired.stateHash]))).toHaveLength(0);
  });
  it('a Space scope needs a Space admin before anyone reaches a consent screen', async () => {
    await expect(store.insert(plainClaims, row({ scope: 'space' }))).rejects.toMatchObject({ code: 'forbidden' });
    const admin = row({ scope: 'space' });
    await store.insert(ownerClaims, admin);
    expect(await store.take(ownerClaims, admin.stateHash)).toMatchObject({ scope: 'space' });
    await expect(store.insert(plainClaims, row({ scope: 'team' as never }))).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('refuses non-members, agent and link callers, foreign connectors and malformed rows', async () => {
    await expect(store.insert(strangerClaims, row())).rejects.toMatchObject({ code: 'forbidden' });
    for (const authKind of ['agent', 'agent_runtime', 'link'] as const) {
      await expect(store.insert({ ...plainClaims, authKind }, row())).rejects.toThrow();
      await expect(store.take({ ...plainClaims, authKind }, row().stateHash)).rejects.toThrow();
    }
    await expect(store.insert(plainClaims, row({ serverId: randomUUID() }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.insert(plainClaims, row({ stateHash: randomBytes(16) }))).rejects.toThrow();
    await expect(store.insert(plainClaims, row({ nonce: randomBytes(8) }))).rejects.toThrow();
    await expect(store.insert(plainClaims, row({ keyId: 'aws-kms:v1' }))).rejects.toThrow();
    // Browsers strip tab/CR/LF, so '/\t/evil.test' would navigate to '//evil.test'.
    for (const returnTo of ['//evil.test', 'https://evil.test', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', '/\r/evil.test', '/x\u007f']) {
      await expect(store.insert(plainClaims, row({ returnTo }))).rejects.toThrow();
    }
    expect(await count()).toBe(0);
  });
  it('caps live sign-ins at 20 per identity, so one member cannot exhaust the node', async () => {
    await scratch.query('delete from internal.mcp_oauth_pending');
    const mine: McpOAuthPendingRow[] = [];
    for (let i = 0; i < 20; i++) { const pending = row(); mine.push(pending); await store.insert(plainClaims, pending); }
    await expect(store.insert(plainClaims, row())).rejects.toMatchObject({ code: 'limit_exceeded', message: 'Too many pending MCP connections' });
    // Another member is unaffected, and an expired row of mine stops counting.
    const theirs = row(); await store.insert(ownerClaims, theirs);
    await scratch.query("update internal.mcp_oauth_pending set expires_at = now() - interval '1 second' where state_hash = $1", [mine[0]!.stateHash]);
    await store.insert(plainClaims, row());
    await scratch.query('delete from internal.mcp_oauth_pending');
  });
  it('keeps the node-wide cap of 1,000 live sign-ins and sweeps expired rows first', async () => {
    await scratch.query('delete from internal.mcp_oauth_pending');
    await scratch.query(`insert into internal.mcp_oauth_pending (state_hash, identity_id, space_id, server_id, scope_kind, key_id, secret_ciphertext, secret_nonce, label, expires_at)
      select sha256(convert_to(g::text || $3, 'UTF8')), $1, $2, $4, 'member', 'local:v1', '\\x00', decode('000000000000000000000000', 'hex'), 'x',
             case when g <= 10 then now() - interval '1 minute' else now() + interval '5 minutes' end
      from generate_series(1, 1009) g`, [ownerIdentity, space, randomUUID(), server]);
    // 999 live + 10 expired: the sweep makes room for exactly one.
    await store.insert(plainClaims, row());
    expect(await count()).toBe(1000);
    await expect(store.insert(plainClaims, row())).rejects.toMatchObject({ code: 'limit_exceeded', message: 'Too many pending MCP connections' });
    await scratch.query('delete from internal.mcp_oauth_pending');
  });
});
