/**
 * 408 — deleting a connector revokes its connections, in the same transaction.
 *
 * The live failure: after deleting test-mcp, its credential stayed `active`
 * and kept its label, so connecting "subhang" to a re-added test-mcp hit
 * `space_credentials_unique_label`. This pins both halves: the row is revoked
 * (secret dropped) and the label is free again; another connector's
 * connection is untouched.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { McpCredentialStore } from '../../src/mcp/credential-store.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase; let db: Db; let dir: string; let store: McpCredentialStore;
const space = randomUUID(), server = randomUUID(), other = randomUUID(), replacement = randomUUID(), member = randomUUID();
const auth: DbClaims = { identityId: 'mcp-del-owner', authKind: 'browser', sessionSpaceId: space };

async function addServer(id: string, name: string) {
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query("select set_config('tm8.identity_id','mcp-del-owner',true),set_config('tm8.auth_kind','browser',true)");
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'mcp_server',0,$3)", [id, space, member]);
    await c.query('insert into public.mcp_servers(entity_id,space_id,title,definition) values($1,$2,$3,$4)', [id, space, name, JSON.stringify({
      name, transport: 'http', url: 'http://127.0.0.1:8787/mcp', envKeys: [], headerKeys: ['Authorization'],
      auth: { type: 'api_key', headerName: 'Authorization' }, approved: true, allowPrivateNetwork: true,
    })]);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('mcp_server_delete_revokes'); database.apply(migrationFiles()); db = createDb(database.url);
  dir = await mkdtemp(join(tmpdir(), 'mcp-del-')); store = new McpCredentialStore(db, dir);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', ['mcp-del-owner']);
    await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', ['mcp-del-owner']);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP delete fixture','mcp-del-owner')", [space]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,'mcp-del-owner','owner','mcp-del-owner')", [member, space]);
  });
  await addServer(server, 'test-mcp'); await addServer(other, 'other-mcp');
});
afterAll(async () => { await db?.end(); await database?.destroy(); if (dir) await rm(dir, { recursive: true, force: true }); });

it('revokes the deleted connector’s connections, frees their label, and leaves other connectors alone', async () => {
  const doomed = await store.create(auth, { spaceId: space, serverId: server, label: 'subhang', secret: { kind: 'api_key', value: 'doomed-canary' } }) as { id: string };
  const kept = await store.create(auth, { spaceId: space, serverId: other, label: 'kept', secret: { kind: 'api_key', value: 'kept-canary' } }) as { id: string };

  await db.rpc(auth, 'delete_entity', [server, null, randomUUID()]);

  const rows = await database.query<{ id: string; status: string; is_default: boolean; secret_ciphertext: unknown }>(
    'select id,status,is_default,secret_ciphertext from public.space_credentials where id = any($1::uuid[]) order by label', [[doomed.id, kept.id]]);
  const byId = new Map(rows.map(row => [row.id, row]));
  expect(byId.get(doomed.id)).toMatchObject({ status: 'revoked', is_default: false, secret_ciphertext: null });
  expect(byId.get(kept.id)?.status).toBe('active');

  // The label is free again: the same person connects to a re-added connector.
  await addServer(replacement, 'test-mcp-2');
  await expect(store.create(auth, { spaceId: space, serverId: replacement, label: 'subhang', secret: { kind: 'api_key', value: 'again' } })).resolves.toBeTruthy();
});
