/**
 * Bridges B1b-8 (413 §5): delivery of inbound messages to workers, with B1b-3's
 * audience, answerer and origin doors (399).
 *
 * ac1 / §7.3 item 10 (wake): an un-directed message wakes no worker; an
 * `@handle` message is delivered to that worker as a `tm8.incoming-message`
 * whose `<origin kind="bridge">` says directed="true" and carries unread.
 * ac2 / D30: the directed delivery adds the bridge origin to the session, so
 * its next doc carries `authored_from -> bridge`; a redelivery adds nothing.
 *
 * The inbound frame goes through the runtime's own door under a minted
 * bridge_runtime session; delivery runs the server's real
 * createBridgeSessionDelivery and dispatch loop, with a capturing delivery port
 * in place of the PTY (the same seam message-dispatch tests use).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createBridgeSessionDelivery } from '../../src/bridges/runtime/deliver.js';
import type { MessageDeliveryPort } from '../../src/facade/services/w2/message-dispatch.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const has399 = migrationFiles().some((f) => f.startsWith('399_bridge_access_provenance'));
if (!has399) console.warn('[bridge-delivery] SKIPPING: 399 (B1b-3, #1429) is not on this branch; the audience doors are its.');

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), chat = randomUUID(), worker = randomUUID();
const ownerIdentity = `b1b8-${randomUUID()}`, ownerAccount = randomUUID(), connection = randomUUID();
const GROUP = '120363888@g.us';
let bridge = '';
let runtimeSession = '';
let handle = '';
let seq = 0;

const runtime = (): DbClaims => ({ identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID() });
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});
const inbound = (body: string) => {
  seq += 1;
  return db.rpc<{ status: string; messageId: string; routed: boolean }>(runtime(), 'bridge_runtime_inbound', [JSON.stringify({
    connectionId: connection, conversationId: GROUP, externalMessageId: `3EB0DLV${seq}`,
    sender: { externalId: '919800000002@s.whatsapp.net', altId: null, name: 'Rahul', fromMe: false },
    body, kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_200_000 + seq,
  }), false]);
};

/** A delivery port that records what would have been written to each terminal. */
function capturingPort(): { port: MessageDeliveryPort; sent: { session: string; content: string }[] } {
  const sent: { session: string; content: string }[] = [];
  const port: MessageDeliveryPort = {
    async reserve(intent) {
      sent.push({ session: intent.targetWorkSessionId, content: intent.content });
      return { deliveryId: randomUUID() };
    },
    adapter: { dispatch: async () => undefined, reject: async () => undefined },
    principalFor: () => ({}),
  };
  return { port, sent };
}

describe.skipIf(!has399)('directed delivery to workers (413 §5 with 399)', () => {
  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('bridges_b1b8_dlv');
    scratch.apply(migrationFiles());
    db = createDb(scratch.url, { max: 4 });
    await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
      await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'b1b8',true)`, [ownerAccount, ownerIdentity]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'B1b-8',$2)`, [spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
        [ownerMember, spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
        [teammate, ownerMember]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b8', gen_random_uuid(), $4, $5, $6)`,
        [chat, spaceId, teammate, ownerIdentity, ownerMember, `b1b8-${randomUUID()}`]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
        [worker, spaceId, teammate]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Deploy fixer','running','none',now())`, [worker]);
      await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9494','linked')`,
        [connection, ownerAccount]);
    });
    const created = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
      q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, GROUP,
        JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 4 }), chat,
        JSON.stringify({ trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'anyone', voice: 'named', style: null }),
        teammate, null, null, true, null, null, randomUUID()]));
    bridge = created.entity.id;
    runtimeSession = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'b1b8')).sessionId;
    handle = (await owner<{ h: string }>('select internal.bridge_assign_handle($1, $2, null) as h', [spaceId, worker]))[0]!.h;
  });

  afterAll(async () => { await db?.end(); await scratch?.destroy(); });

  it('an un-directed message wakes no worker; @handle delivers with origin directed="true" and an unread count (ac1)', async () => {
    const { port, sent } = capturingPort();
    const deliver = createBridgeSessionDelivery({ db, delivery: port });
    const chatter = await inbound('morning all');
    await inbound('coffee?');
    await deliver(chatter.messageId);
    expect(sent.filter((s) => s.session === worker)).toEqual([]);

    const directed = await inbound(`@${handle} can you check the deploy?`);
    const dispositions = await deliver(directed.messageId);
    expect(dispositions).toEqual([expect.objectContaining({ targetWorkSessionId: worker, status: 'accepted' })]);
    const mine = sent.filter((s) => s.session === worker);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.content).toContain('type="tm8.session-input"');
    expect(mine[0]!.content).toMatch(new RegExp(`<origin kind="bridge" bridge_id="${bridge}" provider="whatsapp" conversation="Infra"`));
    expect(mine[0]!.content).toContain('participant="Rahul" trust="guest"');
    expect(mine[0]!.content).toMatch(/directed="true" unread="[1-9]\d*"/);
    expect(mine[0]!.content).toContain(`can you check the deploy?`);
  });

  it('the directed delivery adds the bridge origin (D30): the next doc carries it; a redelivery adds none (ac2)', async () => {
    const { port, sent } = capturingPort();
    const deliver = createBridgeSessionDelivery({ db, delivery: port });
    const directed = await inbound(`@${handle} write it up`);
    await deliver(directed.messageId);
    await deliver(directed.messageId);   // redelivery: nothing more
    expect(sent.filter((s) => s.session === worker)).toHaveLength(1);
    const origins = await owner<{ n: number }>(`select count(*)::int as n from public.session_bridge_origins where holder_id = $1`, [worker]);
    const before = origins[0]!.n;
    expect(before).toBeGreaterThanOrEqual(1);
    const doc = randomUUID();
    await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`select set_config('tm8.work_session_id', $1, true)`, [worker]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'doc',$3,'space')`, [doc, spaceId, teammate]);
    });
    const edges = await owner<{ props: { bridgeId: string; origins: { providerMessageId: string }[] } }>(
      `select props from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [doc, bridge]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.props.bridgeId).toBe(bridge);
    expect(edges[0]!.props.origins.map((o) => o.providerMessageId)).toContain(`3EB0DLV${seq}`);
    await deliver(directed.messageId);
    const after = await owner<{ n: number }>(`select count(*)::int as n from public.session_bridge_origins where holder_id = $1`, [worker]);
    expect(after[0]!.n).toBe(before);
  });
});
