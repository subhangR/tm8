/**
 * Bridges (migration 429): a message typed on the linked number itself is its
 * owner's. The owner proved control of the number by pairing the device, so
 * when no identity link matches, a sender whose ids are the connection's own
 * (bridge_connections.self_ids) resolves to the connection owner's active
 * member in the bridge's space, trust 'linked', and is routed on a bridge whose
 * whoMayTrigger is 'linked'. Before 429 it was a guest and never routed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID(), linkedMember = randomUUID();
const ownerIdentity = `own-owner-${randomUUID()}`, linkedIdentity = `own-linked-${randomUUID()}`;
const ownerAccount = randomUUID();
const teammate = randomUUID();
const session = randomUUID();
const connection = randomUUID();
const OPS = '120363201@g.us';
const OWN = '919000009494@s.whatsapp.net', OWN_LID = '69106644611197@lid';
const PRIYA = '15550001111@s.whatsapp.net', RAHUL = '919876543210@s.whatsapp.net';

let ops = '';
let runtimeSession = '';

const human = <T>(fn: (q: Querier) => Promise<T>) =>
  db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, fn);
const runtime = (): DbClaims => ({
  identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID(),
});
const door = <T>(fn: string, ...args: unknown[]) => db.rpc<T>(runtime(), fn, args);
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});

let seq = 0;
function frame(sender: { externalId: string; altId: string | null; name: string; fromMe: boolean }, body = '@tm8 yo') {
  seq += 1;
  return {
    connectionId: connection, conversationId: OPS, externalMessageId: `3EB2${seq.toString().padStart(6, '0')}`,
    sender, body, kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_000 + seq,
  };
}
interface Inbound { status: string; messageId: string; routed: boolean }
const inbound = (f: Record<string, unknown>) => door<Inbound>('bridge_runtime_inbound', JSON.stringify(f), false);
interface Author { kind: string; actorId: string; trust: string; identityId?: string; ownNumber?: boolean }
const resolve = (sender: string) =>
  owner<{ a: Author }>('select internal.bridge_resolve_author($1, $2) as a', [ops, sender]).then(r => r[0]!.a);

const me = { externalId: OWN, altId: OWN_LID, name: 'Subhang', fromMe: true };

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_own_number');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Linked')`, [ownerIdentity, linkedIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'own-owner', true)`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges own number',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$3,'member',$1),($2,$3,'member',$2)`,
      [ownerMember, linkedMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$5,$3,'owner','Owner'),($2,$5,$4,'member','Priya')`, [ownerMember, linkedMember, ownerIdentity, linkedIdentity, spaceId]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Ops Bot','worker','persona')`, [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
      [session, spaceId, ownerMember]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Ops','running','none',now())`, [session]);
    // The number is linked: the runtime has reported its own ids (398 bridge_runtime_state).
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, self_ids)
      values ($1,'whatsapp',$2,'+91 …9494','linked',$3)`, [connection, ownerAccount, [OWN, OWN_LID]]);
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp',$1,$2,'code',now())`, [PRIYA, linkedIdentity]);
  });
  await human(q => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
  // Group default: trigger mention, whoMayTrigger linked.
  ops = (await human(q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, OPS, JSON.stringify({ kind: 'group', title: 'Ops', memberCount: 5 }),
    session, '{}', teammate, null, null, true, null, null, randomUUID(),
  ]))).entity.id;
  expect((await owner<{ w: string }>(`select policy ->> 'whoMayTrigger' as w from public.bridges where entity_id = $1`, [ops]))[0]!.w)
    .toBe('linked');

  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  runtimeSession = (await db.rpc<{ id: string }>({ identityId: ownerIdentity, nodeAdmin: true, requestId: randomUUID() },
    'issue_bridge_runtime_session', [hash, new Date(Date.now() + 86_400_000).toISOString(), 'whatsapp-runtime'])).id;
  await door('bridge_runtime_hello', JSON.stringify({ provider: 'whatsapp', version: 1, runtimeId: 'wa-own', capabilities: {} }));
  await owner(`update public.bridge_connections set runtime_id = 'wa-own', status = 'linked' where id = $1`, [connection]);
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('the linked number itself speaks for its owner', () => {
  it("the owner's @tm8 typed on the linked phone is the owner's and is routed on a 'linked' bridge", async () => {
    const r = await inbound(frame(me));
    expect(r).toMatchObject({ status: 'stored', routed: true });
    const [m] = await owner<{ author_id: string }>('select author_id from public.messages where entity_id = $1', [r.messageId]);
    expect(m!.author_id).toBe(ownerMember);
  });

  it('either of the number\'s own ids is enough (the phone id or the lid)', async () => {
    expect(await resolve(OWN)).toMatchObject({ kind: 'member', actorId: ownerMember, trust: 'linked', ownNumber: true });
    expect(await resolve(OWN_LID)).toMatchObject({ kind: 'member', actorId: ownerMember, trust: 'linked', ownNumber: true });
  });

  it('a verified identity link still resolves as before', async () => {
    const a = await resolve(PRIYA);
    expect(a).toMatchObject({ kind: 'member', actorId: linkedMember, trust: 'linked' });
    expect(a.ownNumber).toBeUndefined();
  });

  it('anyone else in the group stays a guest and is not routed', async () => {
    expect(await resolve(RAHUL)).toMatchObject({ kind: 'bridge', trust: 'guest' });
    const r = await inbound(frame({ externalId: RAHUL, altId: null, name: 'Rahul', fromMe: false }));
    expect(r).toMatchObject({ status: 'stored', routed: false });
  });

});
