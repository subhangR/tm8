/** Independent resolver authorization cases. Credentials are created through
 * the real MCP credential store; no authorize callback is stubbed. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { loadMcpServer, resolveMcpSelections } from '../../src/mcp/definitions.js';
import { McpCredentialStore } from '../../src/mcp/credential-store.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 240000 });
let scratch: W1ScratchDatabase; let db: Db; let dataDir: string; let store: McpCredentialStore;
const space = randomUUID(); const otherSpace = randomUUID();
const ownerIdentity = `mcp-sec-owner-${randomUUID()}`; const readerIdentity = `mcp-sec-reader-${randomUUID()}`; const outsiderIdentity = `mcp-sec-out-${randomUUID()}`;
const ownerMember = randomUUID(); const readerMember = randomUUID(); const outsiderMember = randomUUID(); const ownerOtherMember = randomUUID();
const definition = (name: string, auth: Record<string, unknown> = { type: 'none' }) => ({ name, transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: auth.type === 'api_key' ? ['Authorization'] : [], auth, approved: true });
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>) => db.tx({ identityId, authKind: 'browser', requestId: randomUUID() }, fn);
async function server(identityId: string, spaceId: string, name: string, auth?: Record<string, unknown>) {
  return as(identityId, q => q.rpc<{ entity: { id: string; version: number } }>('create_mcp_server_entity', [spaceId, JSON.stringify(definition(name, auth)), null, randomUUID()]));
}
async function privateCredential(serverId: string): Promise<string> {
  const created = await store.create({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID(), sessionSpaceId: space }, {
    spaceId: space, serverId, label: `selection-${serverId}`, secret: { kind: 'api_key', value: 'selection-secret' },
  }) as { id: string };
  return created.id;
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_security_selection'); scratch.apply(migrationFiles()); db = createDb(scratch.url, { max: 4 }); dataDir = await mkdtemp(join(tmpdir(), 'mcp-security-selection-')); store = new McpCredentialStore(db, dataDir);
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,\'Owner\'),($2,\'Reader\'),($3,\'Out\')', [ownerIdentity, readerIdentity, outsiderIdentity]);
    await c.query('insert into public.accounts(identity_id,username,display_name) values($1,$1,\'Owner\')', [ownerIdentity]);
    await c.query('insert into public.accounts(identity_id,username,display_name) values($1,$1,\'Reader\'),($2,$2,\'Out\')', [readerIdentity, outsiderIdentity]);
    await c.query('insert into public.spaces(id,name,created_by_identity) values($1,\'MCP-S\',$3),($2,\'MCP-T\',$3)', [space, otherSpace, ownerIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$4,'member',$1),($2,$4,'member',$2),($3,$5,'member',$3),($6,$5,'member',$1)", [ownerMember, readerMember, outsiderMember, space, otherSpace, ownerOtherMember]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$4,$5,'owner','Owner'),($2,$4,$6,'member','Reader'),($3,$7,$8,'owner','Out'),($9,$7,$5,'owner','Owner')", [ownerMember, readerMember, outsiderMember, space, ownerIdentity, readerIdentity, otherSpace, outsiderIdentity, ownerOtherMember]);
  });
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

describe('MCP selection authorization', () => {
  it('rejects an explicit server ID from another space', async () => {
    const foreign = await server(ownerIdentity, otherSpace, 'foreign');
    await expect(as(readerIdentity, q => resolveMcpSelections(q, { spaceId: space, mcpSelections: [{ serverId: foreign.entity.id }] }))).rejects.toThrow(/another space|unavailable/i);
  });

  it('returns credential_unavailable when a credential ID is supplied for a connector with no credential', async () => {
    const first = await server(ownerIdentity, space, 'first', { type: 'api_key', headerName: 'Authorization' });
    const second = await server(ownerIdentity, space, 'second', { type: 'api_key', headerName: 'Authorization' });
    const cred = await privateCredential(second.entity.id);
    await expect(as(readerIdentity, q => resolveMcpSelections(q, { spaceId: space, mcpSelections: [{ serverId: first.entity.id, credentialId: cred }] }))).resolves.toMatchObject({ selections: [{ ready: false, reason: 'credential_unavailable' }] });
  });

  it('does not make a reader ready with the owner private credential', async () => {
    const connector = await server(ownerIdentity, space, 'private', { type: 'api_key', headerName: 'Authorization' });
    const cred = await privateCredential(connector.entity.id);
    await expect(store.read({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID(), sessionSpaceId: space }, { spaceId: space, serverId: connector.entity.id, credentialId: cred })).resolves.toMatchObject({ secret: { kind: 'api_key', value: 'selection-secret' } });
    await expect(store.read({ identityId: readerIdentity, authKind: 'browser', requestId: randomUUID(), sessionSpaceId: space }, { spaceId: space, serverId: connector.entity.id, credentialId: cred })).rejects.toThrow(/unavailable/i);
    const result = await as(readerIdentity, q => resolveMcpSelections(q, { spaceId: space, mcpSelections: [{ serverId: connector.entity.id, credentialId: cred }] }));
    expect(result.selections[0]).toMatchObject({ ready: false }); expect(result.selections[0]?.reason).toMatch(/credential_(unavailable|required)/);
  });

  it('keeps omitted defaults distinct from explicit [] for the same space', async () => {
    const connector = await server(ownerIdentity, space, 'equipped');
    const task = await as(ownerIdentity, q => q.rpc<{ entity: { id: string } }>('create_task', [space, 'selection task']));
    await as(ownerIdentity, q => q.rpc('write_edge', [task.entity.id, connector.entity.id, 'equips', '{}', null, randomUUID()]));
    const omitted = await as(readerIdentity, q => resolveMcpSelections(q, { spaceId: space, targetIds: [task.entity.id] }));
    const empty = await as(readerIdentity, q => resolveMcpSelections(q, { spaceId: space, targetIds: [task.entity.id], mcpSelections: [] }));
    expect(omitted.selections.map(s => s.server.id)).toEqual([connector.entity.id]); expect(empty.selections).toEqual([]);
  });
});
