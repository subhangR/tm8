/**
 * Bridges B0a (migration 395): the kind, the doors and the rules §7.3 holds
 * B0a to — item 1's refused generic create lives in the service test; here:
 * item 13 at the API level (target_has_bridge on create and retarget, owner
 * only), D20's already-connected refusal, the handle uniqueness rules (D23),
 * listen's ceiling, the edge guards and author resolution.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID(), otherSpace = randomUUID();
const ownerMember = randomUUID(), adminMember = randomUUID(), plainMember = randomUUID();
const ownerIdentity = `bridge-owner-${randomUUID()}`;
const adminIdentity = `bridge-admin-${randomUUID()}`;
const plainIdentity = `bridge-plain-${randomUUID()}`;
const ownerAccount = randomUUID(), adminAccount = randomUUID();
const teammate = randomUUID();
const chatA = randomUUID(), chatB = randomUUID(), chatC = randomUUID();
const channel = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID();
const connection = randomUUID(), adminConnection = randomUUID();
const outsiderMember = randomUUID(), outsiderIdentity = `bridge-outsider-${randomUUID()}`, sessionOther = randomUUID();

type Kind = 'browser' | 'cli' | 'agent';
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind: Kind = 'browser', workSessionId?: string) =>
  db.tx({ identityId, authKind, requestId: randomUUID(), ...(workSessionId ? { workSessionId } : {}) }, fn);

interface Result { entity: { id: string; version: number } }
const conversation = (title = 'Infra') => JSON.stringify({ kind: 'group', title, memberCount: 7 });

function create(identity: string, conn: string, externalId: string, target: string, authKind: Kind = 'browser') {
  return as(identity, q => q.rpc<Result>('create_bridge', [
    spaceId, conn, externalId, conversation(), target, '{}', teammate, 'Infra on-call', null, true, null,
    null, randomUUID(),
  ]), authKind);
}

interface Refusal { code?: string; message?: string; details?: Record<string, unknown> }
/** Through the db layer a refusal is a CollabError: the taxonomy code, plus details.sqlstate and details.reason. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error('expected a refusal');
}
const reasonOf = (e: Refusal) => e.details?.['reason'];

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_b0a');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Admin'),($3,'Plain')`,
      [ownerIdentity, adminIdentity, plainIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username) values ($1,$2,'bridge-owner'),($3,$4,'bridge-admin')`,
      [ownerAccount, ownerIdentity, adminAccount, adminIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges',$3),($2,'Other',$3)`,
      [spaceId, otherSpace, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values
      ($1,$4,'member',$1),($2,$4,'member',$2),($3,$4,'member',$3)`, [ownerMember, adminMember, plainMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$7,$4,'owner','Owner'),($2,$7,$5,'admin','Admin'),($3,$7,$6,'member','Plain')`,
      [ownerMember, adminMember, plainMember, ownerIdentity, adminIdentity, plainIdentity, spaceId]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values
      ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra teammate','worker','persona')`, [teammate, ownerMember]);
    for (const [id, title] of [[chatA, 'Infra main'], [chatB, 'Gaming main'], [chatC, 'Spare']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b0a', gen_random_uuid(), $5, $6, $7)`,
        [id, spaceId, title, teammate, ownerIdentity, ownerMember, `b0a-${randomUUID()}`]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'channel',$3)`, [channel, spaceId, ownerMember]);
    await c.query(`insert into public.channels(entity_id, space_id, name, topic) values ($1,$2,'deploys','')`, [channel, spaceId]);
    for (const id of [sessionA, sessionB]) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
        [id, spaceId, ownerMember]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
        values ($1,'Worker','running','none',now())`, [id]);
    }
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Outsider')`, [outsiderIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [outsiderMember, otherSpace]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Outsider')`,
      [outsiderMember, otherSpace, outsiderIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
      [sessionOther, otherSpace, outsiderMember]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
      values ($1,'Other worker','running','none',now())`, [sessionOther]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked'),($3,'whatsapp',$4,'+91 …1999','linked')`,
      [connection, ownerAccount, adminConnection, adminAccount]);
  });
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('the kind (§3.1)', () => {
  it('registers bridge as a core kind with explicit capabilities', async () => {
    const [row] = await scratch.query<{ capabilities: Record<string, boolean> }>(
      `select capabilities from public.entity_kinds where kind = 'bridge' and space_id is null`);
    expect(row!.capabilities).toMatchObject({ discussable: true, hierarchical: false, spawnable: false, workflowed: false });
  });

  it('accepts a bridge_runtime auth session shape and refuses one with a persona or a space pin', async () => {
    const [ok] = await scratch.query<{ ok: boolean }>(
      `select pg_get_constraintdef(oid) like '%bridge_runtime%' as ok from pg_constraint where conname = 'auth_sessions_kind_check'`);
    expect(ok!.ok).toBe(true);
    const [shape] = await scratch.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auth_sessions_bridge_runtime_shape'`);
    expect(shape!.def).toMatch(/space_id IS NULL/);
  });
});

describe('bridges.create (§3.4, D20, D25, D28)', () => {
  let infra: Result;

  it('creates a bridge for the connection owner, with defaults, the bridged_to edge and the view', async () => {
    infra = await create(ownerIdentity, connection, '120363@g.us', chatA);
    const [view] = await as(ownerIdentity, q => q.query<{ v: Record<string, any> }>('select internal.bridge_view($1) as v', [infra.entity.id]));
    expect(view!.v).toMatchObject({
      provider: 'whatsapp', status: 'live', teammateId: teammate, purpose: 'Infra on-call', workerPosting: true,
      target: { kind: 'chat', id: chatA, title: 'Infra main' },
      conversation: { externalId: '120363@g.us', kind: 'group', title: 'Infra', memberCount: 7 },
      policy: { trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'linked', voice: 'named', style: null },
      workers: { wake: 'directed' }, retentionDays: null,
    });
    const edges = await scratch.query<{ dst_id: string }>(`select dst_id from public.edges where src_id = $1 and type = 'bridged_to'`, [infra.entity.id]);
    expect(edges.map(e => e.dst_id)).toEqual([chatA]);
  });

  it('hydrates the bridge through internal.entity_content, with no secret on it', async () => {
    // Any later migration that REPLACES entity_content from an older body drops
    // the bridge arm silently and this becomes '{}' (caught on B0b's 408).
    const [row] = await scratch.query<{ c: Record<string, unknown> }>('select internal.entity_content($1) as c', [infra.entity.id]);
    expect(row!.c).toMatchObject({
      provider: 'whatsapp', connection_id: connection, external_conversation_id: '120363@g.us',
      target_kind: 'chat', target_id: chatA, purpose: 'Infra on-call',
    });
    expect(Object.keys(row!.c).filter((k) => /secret|token|sealed|password|auth/i.test(k))).toEqual([]);
  });

  it('bridge_view answers nothing to a reader outside the bridge\'s space', async () => {
    const [row] = await as(outsiderIdentity, q => q.query<{ v: unknown }>('select internal.bridge_view($1) as v', [infra.entity.id]));
    expect(row!.v).toBeNull();
  });

  it('refuses a space admin who does not own the number (D28)', async () => {
    const e = await refusal(create(adminIdentity, connection, 'other@g.us', chatC));
    expect(e.code).toBe('forbidden');
    expect(reasonOf(e)).toBe('not_connection_owner');
  });

  it('refuses a member who is not an admin, and an agent', async () => {
    expect((await refusal(create(plainIdentity, connection, 'plain@g.us', chatC))).code).toBe('forbidden');
    expect((await refusal(create(ownerIdentity, connection, 'agent@g.us', chatC, 'agent'))).code).toBe('forbidden');
  });

  it('refuses a target chat that already has a bridge: target_has_bridge (D25)', async () => {
    const e = await refusal(create(ownerIdentity, connection, 'gaming@g.us', chatA));
    expect(e.code).toBe('conflict');
    expect(reasonOf(e)).toBe('target_has_bridge');
  });

  it('refuses the same group from another member\'s number: already connected by <name> (D20)', async () => {
    const e = await refusal(create(adminIdentity, adminConnection, '120363@g.us', chatC));
    expect(e.code).toBe('conflict');
    expect(reasonOf(e)).toBe('already_connected');
    expect(e.message).toMatch(/already connected by Owner/);
  });

  it('refuses a target that is not a chat, session or channel', async () => {
    const e = await refusal(create(ownerIdentity, connection, 'x@g.us', teammate));
    expect(e.code).toBe('invalid_input');
  });

  it('refuses an invalid policy at definition time', async () => {
    const e = await refusal(as(ownerIdentity, q => q.rpc('create_bridge', [
      spaceId, connection, 'bad@g.us', conversation(), chatC, JSON.stringify({ trigger: 'always' }), null, null, null, true, null, null, randomUUID(),
    ])));
    expect(e.code).toBe('invalid_input');
  });

  it('gives a channel target the mirror defaults', async () => {
    const r = await create(ownerIdentity, connection, 'deploys@g.us', channel);
    const [view] = await as(ownerIdentity, q => q.query<{ v: Record<string, any> }>('select internal.bridge_view($1) as v', [r.entity.id]));
    expect(view!.v.policy).toMatchObject({ trigger: 'none', outbound: 'all' });
  });

  describe('retarget, update, pause, resume, remove', () => {
    const version = async (id: string) =>
      (await scratch.query<{ version: number }>('select version from public.entities where id = $1', [id]))[0]!.version;

    it('retarget refuses a chat that already has a bridge, and moves the edge to a free one', async () => {
      const gaming = await create(ownerIdentity, connection, 'gaming@g.us', chatB);
      const v = await version(gaming.entity.id);
      const e = await refusal(as(ownerIdentity, q => q.rpc('retarget_bridge', [gaming.entity.id, v, chatA, null, randomUUID()])));
      expect(e.code).toBe('conflict');
      expect(reasonOf(e)).toBe('target_has_bridge');
      await as(ownerIdentity, async q => q.rpc('retarget_bridge', [gaming.entity.id, await version(gaming.entity.id), chatC, null, randomUUID()]));
      const edges = await scratch.query<{ dst_id: string }>(`select dst_id from public.edges where src_id = $1 and type = 'bridged_to'`, [gaming.entity.id]);
      expect(edges.map(x => x.dst_id)).toEqual([chatC]);
    });

    it('update merges the policy and refuses unknown fields', async () => {
      const id = infra.entity.id;
      await as(adminIdentity, async q => q.rpc('update_bridge', [id, await version(id),
        JSON.stringify({ policy: { style: 'short and readable' }, workerPosting: false, quietHours: { start: '22:00', end: '08:00' } }), null, randomUUID()]));
      const [row] = await scratch.query<{ policy: Record<string, unknown>; worker_posting: boolean }>(
        'select policy, worker_posting from public.bridges where entity_id = $1', [id]);
      expect(row!.policy).toMatchObject({ trigger: 'mention', style: 'short and readable' });
      expect(row!.worker_posting).toBe(false);
      expect((await refusal(as(adminIdentity, async q => q.rpc('update_bridge', [id, await version(id), '{"secret":1}', null, randomUUID()])))).code).toBe('invalid_input');
    });

    it('pause and resume flip the derived status; remove leaves a tombstone and frees the group', async () => {
      const id = infra.entity.id;
      await as(adminIdentity, async q => q.rpc('pause_bridge', [id, await version(id), null, randomUUID()]));
      const status = async () => (await as(ownerIdentity, q => q.query<{ s: string }>(`select internal.bridge_view($1)->>'status' as s`, [id])))[0]!.s;
      expect(await status()).toBe('paused');
      await as(adminIdentity, async q => q.rpc('resume_bridge', [id, await version(id), null, randomUUID()]));
      expect(await status()).toBe('live');
      // remove is human-only
      expect((await refusal(as(adminIdentity, async q => q.rpc('remove_bridge', [id, await version(id), null, randomUUID()]), 'agent'))).code).toBe('forbidden');
      await as(adminIdentity, async q => q.rpc('remove_bridge', [id, await version(id), null, randomUUID()]));
      expect(await status()).toBe('ended');
      const e = await refusal(as(adminIdentity, async q => q.rpc('pause_bridge', [id, await version(id), null, randomUUID()])));
      expect(reasonOf(e)).toBe('bridge_ended');
      // the group and the chat are free again (D20/D25 hold over live bridges)
      const again = await create(ownerIdentity, connection, '120363@g.us', chatA);
      expect(again.entity.id).not.toBe(id);
    });

    it('the generic delete door never reaches a bridge', async () => {
      const [b] = await scratch.query<{ id: string }>(`select entity_id as id from public.bridges where ended_at is null limit 1`);
      expect((await refusal(as(ownerIdentity, q => q.rpc('delete_entity', [b!.id, null, randomUUID()])))).code).toBe('forbidden');
    });
  });
});

describe('handles (D23)', () => {
  const claim = (session: string, title: string | null = null, space = spaceId) =>
    as(ownerIdentity, q => q.rpc<{ handle: string; entityId: string }>('claim_bridge_handle', [space, title]), 'agent', session);

  it('a session gets one adjective-animal handle per space, idempotently', async () => {
    const first = await claim(sessionA, 'deploy watcher');
    expect(first.handle).toMatch(/^[a-z]+-[a-z]+(-[0-9]+)?$/);
    const second = await claim(sessionA);
    expect(second.handle).toBe(first.handle);
    const other = await claim(sessionB);
    expect(other.handle).not.toBe(first.handle);
  });

  it('a handle is unique per space and a session has only one', async () => {
    const [a] = await scratch.query<{ handle: string }>('select handle from public.bridge_handles where entity_id = $1', [sessionA]);
    const dupHandle = await refusal(scratch.query(
      `insert into public.bridge_handles(space_id, handle, entity_id, kind) values ($1,$2,$3,'work_session')`, [spaceId, a!.handle, sessionB]));
    expect(dupHandle.code).toBe('23505');
    const dupEntity = await refusal(scratch.query(
      `insert into public.bridge_handles(space_id, handle, entity_id, kind) values ($1,'other-name',$2,'work_session')`, [spaceId, sessionA]));
    expect(dupEntity.code).toBe('23505');
  });

  it('uniqueness is per space: another space may hold the same name, and a claim names only a session of that space', async () => {
    const [a] = await scratch.query<{ handle: string }>('select handle from public.bridge_handles where entity_id = $1', [sessionA]);
    await scratch.query(`insert into public.bridge_handles(space_id, handle, entity_id, kind) values ($1,$2,$3,'work_session')`,
      [otherSpace, a!.handle, sessionOther]);
    const e = await refusal(as(outsiderIdentity, q => q.rpc('claim_bridge_handle', [otherSpace, null]), 'agent', sessionA));
    expect(reasonOf(e)).toBe('not_a_session');
    const mine = await as(outsiderIdentity, q => q.rpc<{ handle: string; entityId: string }>('claim_bridge_handle', [otherSpace, null]), 'agent', sessionOther);
    expect(mine).toMatchObject({ handle: a!.handle, entityId: sessionOther });
  });

  it('refuses a caller that is not a session in the space', async () => {
    const e = await refusal(as(ownerIdentity, q => q.rpc('claim_bridge_handle', [spaceId, null])));
    expect(reasonOf(e)).toBe('not_a_session');
  });

  it('refuses a title longer than four words', async () => {
    expect((await refusal(claim(sessionB, 'one two three four five'))).code).toBe('invalid_input');
  });
});

describe('listen (§2.7)', () => {
  it('sets a session\'s own wake level, never above the bridge ceiling', async () => {
    const [b] = await scratch.query<{ id: string }>(`select entity_id as id from public.bridges where ended_at is null and target_kind = 'chat' limit 1`);
    const listen = (wake: string) => as(ownerIdentity, q => q.rpc<{ wake: string }>('set_bridge_listen', [b!.id, wake]), 'agent', sessionA);
    expect((await listen('directed')).wake).toBe('directed');
    const e = await refusal(listen('all'));
    expect(reasonOf(e)).toBe('above_bridge_ceiling');
  });

  it('lowering the bridge ceiling lowers the workers above it', async () => {
    const [b] = await scratch.query<{ id: string }>(`select entity_id as id from public.bridges where ended_at is null and target_kind = 'chat' limit 1`);
    const version = async () => (await scratch.query<{ version: number }>('select version from public.entities where id = $1', [b!.id]))[0]!.version;
    const update = async (workerWake: string) =>
      as(ownerIdentity, async q => q.rpc('update_bridge', [b!.id, await version(), JSON.stringify({ workerWake }), null, randomUUID()]));
    await update('all');
    await as(ownerIdentity, q => q.rpc('set_bridge_listen', [b!.id, 'all']), 'agent', sessionA);
    await update('thread');
    const [c] = await scratch.query<{ wake: string }>('select wake from public.bridge_read_cursors where bridge_id = $1 and session_id = $2', [b!.id, sessionA]);
    expect(c!.wake).toBe('thread');
  });
});

describe('edges (§3.3)', () => {
  it('bridged_to is written only by the bridge doors', async () => {
    const [b] = await scratch.query<{ id: string }>(`select entity_id as id from public.bridges where ended_at is null limit 1`);
    const insert = await refusal(as(ownerIdentity, q => q.rpc('write_edge', [b!.id, chatC, 'bridged_to', '{}', null, randomUUID()])));
    expect(insert.code).toBe('forbidden');
    const [edge] = await scratch.query<{ id: string }>(`select id from public.edges where src_id = $1 and type = 'bridged_to'`, [b!.id]);
    const del = await refusal(as(ownerIdentity, q => q.rpc('delete_edge', [edge!.id, null, randomUUID()])));
    expect(del.code).toBe('forbidden');
  });

  it('authored_from takes a bridge destination, but no client can write it', async () => {
    const [t] = await scratch.query<{ dst_kinds: string[] }>(`select dst_kinds from public.edge_types where type = 'authored_from'`);
    expect(t!.dst_kinds).toContain('bridge');
    const [b] = await scratch.query<{ id: string }>(`select entity_id as id from public.bridges where ended_at is null limit 1`);
    const e = await refusal(as(ownerIdentity, q => q.rpc('write_edge', [chatC, b!.id, 'authored_from', JSON.stringify({ bridgeId: b!.id }), null, randomUUID()])));
    expect(e.code).toBe('forbidden');
  });
});

describe('internal.bridge_resolve_author (§2.4)', () => {
  it('a guest by default; an admin assertion makes the active member the author, asserted', async () => {
    const [b] = await scratch.query<{ id: string }>(`select entity_id as id from public.bridges where ended_at is null and target_kind = 'chat' limit 1`);
    const resolve = async (sender: string) =>
      (await scratch.query<{ r: Record<string, unknown> }>('select internal.bridge_resolve_author($1,$2) as r', [b!.id, sender]))[0]!.r;
    expect(await resolve('919999@s.whatsapp.net')).toMatchObject({ kind: 'bridge', actorId: b!.id, trust: 'guest' });
    await scratch.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, verified_at)
      values ('whatsapp','919999@s.whatsapp.net',$1,'admin',$2,now())`, [plainIdentity, spaceId]);
    expect(await resolve('919999@s.whatsapp.net')).toMatchObject({ kind: 'member', actorId: plainMember, trust: 'asserted' });
    await scratch.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp','918888@s.whatsapp.net',$1,'code',now())`, [adminIdentity]);
    expect(await resolve('918888@s.whatsapp.net')).toMatchObject({ kind: 'member', actorId: adminMember, trust: 'linked' });
  });

  it('is not callable by the app role', async () => {
    const e = await refusal(as(ownerIdentity, q => q.query(`select internal.bridge_resolve_author(gen_random_uuid(), 'x')`)));
    expect(e.code).toBe('forbidden');
  });
});
