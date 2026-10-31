/**
 * Bridges B1b-5, migration 422 (option B): internal.bridge_runtime_connect,
 * which the hub's `connect` calls for bridges.connections.begin, admits the
 * connection's human owner under their own claims, or the bridges worker, and
 * nobody else.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { bridgesWorkerClaims } from '../../src/bridges/outbox.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID(), ownerMember = randomUUID(), otherMember = randomUUID();
const ownerIdentity = `rc-owner-${randomUUID()}`, otherIdentity = `rc-other-${randomUUID()}`, adminIdentity = `rc-admin-${randomUUID()}`;
const ownerAccount = randomUUID(), otherAccount = randomUUID(), adminAccount = randomUUID();
const connection = randomUUID();

const claims = (identityId: string, authKind: 'browser' | 'cli' | 'agent'): DbClaims => ({ identityId, authKind, requestId: randomUUID() });
const connect = (c: DbClaims, runtimeId = 'wa-rc') =>
  db.tx(c, q => q.rpc<{ connectionId: string; allowlist: { connectionId: string } }>('internal.bridge_runtime_connect', [connection, runtimeId]));
async function refusal(p: Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> }> {
  try { await p; } catch (err) { return err as { code?: string; details?: Record<string, unknown> }; }
  throw new Error('expected a refusal');
}
const runtimeOf = async () => (await scratch.query<{ runtime_id: string | null }>(
  'select runtime_id from public.bridge_connections where id = $1', [connection]))[0]!.runtime_id;

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridge_rt_connect');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Other'),($3,'Admin')`,
      [ownerIdentity, otherIdentity, adminIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values
      ($1,$2,'rc-owner',false),($3,$4,'rc-other',false),($5,$6,'rc-admin',true)`,
      [ownerAccount, ownerIdentity, otherAccount, otherIdentity, adminAccount, adminIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'RC',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$3,'member',$1),($2,$3,'member',$2)`,
      [ownerMember, otherMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$3,$4,'owner','Owner'),($2,$3,$5,'admin','Other')`, [ownerMember, otherMember, spaceId, ownerIdentity, otherIdentity]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9494','connecting')`,
      [connection, ownerAccount]);
  });
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('internal.bridge_runtime_connect (422)', () => {
  it('admits the connection\'s owner on their own human session, and binds the runtime', async () => {
    for (const kind of ['browser', 'cli'] as const) {
      const r = await connect(claims(ownerIdentity, kind), `wa-${kind}`);
      expect(r).toMatchObject({ connectionId: connection, allowlist: { connectionId: connection } });
      expect(await runtimeOf()).toBe(`wa-${kind}`);
    }
  });

  it('refuses another member (a space admin), a node admin who is not the owner, and the owner\'s agent token', async () => {
    for (const c of [claims(otherIdentity, 'cli'), claims(adminIdentity, 'browser'), claims(ownerIdentity, 'agent')]) {
      const e = await refusal(connect(c, 'wa-intruder'));
      expect([e.code, e.details?.['reason']]).toEqual(['forbidden', 'not_connection_owner']);
    }
    expect(await runtimeOf()).toBe('wa-cli');
  });

  it('still admits the bridges worker (hello, the pump)', async () => {
    const r = await connect(bridgesWorkerClaims(), 'wa-worker');
    expect(r.connectionId).toBe(connection);
    expect(await runtimeOf()).toBe('wa-worker');
  });
});
