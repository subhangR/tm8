/**
 * Bridges B3 (migration 417): code and invite links (BRIDGE-ENTITY-DESIGN
 * §2.4, §4.6, D5, D58-D60). A code is minted by a human for their own
 * identity, redeemed once by /link from a connected conversation, and makes an
 * identity-scoped link; failed tries lock a sender out (D59); an invite pinned
 * to a participant links whoever redeems it (D60).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
let bridgeId: string;
const spaceId = randomUUID(), otherSpace = randomUUID();
const ownerMember = randomUUID(), plainMember = randomUUID();
const ownerIdentity = `b3-owner-${randomUUID()}`;
const plainIdentity = `b3-plain-${randomUUID()}`;
const joinerIdentity = `b3-joiner-${randomUUID()}`;
const ownerAccount = randomUUID();
const chat = randomUUID(), connection = randomUUID(), teammate = randomUUID();
const guest = '919000000001@s.whatsapp.net';
const invitee = '919000000002@s.whatsapp.net';

type Kind = 'browser' | 'cli' | 'agent';
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind: Kind = 'browser') =>
  db.tx({ identityId, authKind, requestId: randomUUID() }, fn);

interface Refusal { code?: string; message?: string; details?: Record<string, unknown> }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error('expected a refusal');
}

interface Code { code: string; provider: string; expiresAt: string }
interface Redeem { ok: boolean; reason?: string; already?: boolean; identityId?: string; link?: { id: string; method: string; trust: string } }
const begin = (identity: string, authKind: Kind = 'browser') =>
  as(identity, q => q.rpc<Code>('begin_bridge_link', ['whatsapp']), authKind);
const redeem = async (sender: string, code: string) =>
  (await scratch.query<{ r: Redeem }>('select internal.bridge_redeem_link_code($1,$2,$3) as r', [bridgeId, sender, code]))[0]!.r;
const resolve = async (sender: string) =>
  (await scratch.query<{ r: Record<string, unknown> }>('select internal.bridge_resolve_author($1,$2) as r', [bridgeId, sender]))[0]!.r;

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_b3');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Plain')`,
      [ownerIdentity, plainIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username) values ($1,$2,'b3-owner')`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges',$3),($2,'Other',$3)`,
      [spaceId, otherSpace, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$3,'member',$1),($2,$3,'member',$2)`,
      [ownerMember, plainMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$5,$3,'owner','Owner'),($2,$5,$4,'member','Plain')`, [ownerMember, plainMember, ownerIdentity, plainIdentity, spaceId]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra teammate','worker','persona')`, [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$6,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b3', gen_random_uuid(), $3, $4, $5)`,
      [chat, spaceId, ownerIdentity, ownerMember, `b3-${randomUUID()}`, teammate]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
  });
  const created = await as(ownerIdentity, q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, '120363000000000001@g.us', JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 3 }),
    chat, '{}', null, null, null, true, null, null, randomUUID(),
  ]));
  bridgeId = created.entity.id;
  await scratch.query(`insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at)
    values ($1,$2,'Guest',now(),now()),($1,$3,'Invitee',now(),now())`, [bridgeId, guest, invitee]);
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('bridges.links.begin (D58)', () => {
  it('mints a TM8- code of six characters for ten minutes, for a human only', async () => {
    const code = await begin(plainIdentity);
    expect(code.code).toMatch(/^TM8-[A-HJ-NP-Z2-9]{6}$/);
    const minutes = (Date.parse(code.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const e = await refusal(begin(plainIdentity, 'agent'));
    expect(e.code).toBe('forbidden');
  });

  it('a new code ends the earlier one: the list holds one pending code', async () => {
    const first = await begin(ownerIdentity);
    const second = await begin(ownerIdentity);
    const mine = await as(ownerIdentity, q => q.rpc<{ pending: Array<Record<string, unknown>> }>('my_bridge_links', []));
    expect(mine.pending).toHaveLength(1);
    expect(mine.pending[0]!['expiresAt']).toBe(second.expiresAt);
    expect(mine.pending[0]).not.toHaveProperty('code');
    expect(await redeem('919000000099@s.whatsapp.net', first.code)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('stores a salted digest, never the code: no column of any row holds the plain text (D58)', async () => {
    const minted = [await begin(plainIdentity), await begin(ownerIdentity)];
    const rows = await scratch.query<{ row: string }>(
      `select (to_jsonb(c) || jsonb_build_object('salt', encode(c.salt, 'escape'), 'digest', encode(c.digest, 'escape')))::text as row
         from public.bridge_link_codes c`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const { code } of minted) {
      const bare = code.slice(4);
      for (const { row } of rows) {
        expect(row).not.toContain(code);
        expect(row.toUpperCase()).not.toContain(bare);
      }
    }
    const cols = await scratch.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'bridge_link_codes'`);
    expect(cols.map(c => c.column_name)).not.toContain('code');
    const e = await refusal(as(plainIdentity, q => q.query('select digest from public.bridge_link_codes')));
    expect(e.code).toBe('forbidden');
  });

  it('codes are the identity\'s own: the app role reads none of another\'s', async () => {
    const rows = await as(plainIdentity, q => q.query<{ n: number }>(
      'select count(*)::int as n from public.bridge_link_codes where identity_id = $1', [ownerIdentity]));
    expect(rows[0]!.n).toBe(0);
  });
});

describe('/link redeem (§2.4 Code, D5)', () => {
  it('links the sender to the code\'s identity, identity-scoped; the sender is then authored as the member', async () => {
    expect(await resolve(guest)).toMatchObject({ kind: 'bridge', trust: 'guest' });
    const { code } = await begin(plainIdentity);
    const r = await redeem(guest, code.toLowerCase());
    expect(r).toMatchObject({ ok: true, already: false, identityId: plainIdentity, link: { method: 'code', trust: 'linked' } });
    expect(await resolve(guest)).toMatchObject({ kind: 'member', actorId: plainMember, trust: 'linked' });
    expect(await redeem(guest, code)).toMatchObject({ ok: false, reason: 'used' });
  });

  it('a second code of the same identity answers already; another identity\'s code is refused linked_elsewhere', async () => {
    const mine = await begin(plainIdentity);
    expect(await redeem(guest, mine.code)).toMatchObject({ ok: true, already: true });
    const theirs = await begin(ownerIdentity);
    expect(await redeem(guest, theirs.code)).toMatchObject({ ok: false, reason: 'linked_elsewhere', burned: true });
  });

  it('five failed tries in an hour lock the sender out, a valid code included (D59)', async () => {
    const sender = '919000000077@s.whatsapp.net';
    for (let i = 0; i < 5; i++) {
      expect(await redeem(sender, `TM8-ZZZZZ${i + 2}`)).toMatchObject({ ok: false, reason: 'bad_code' });
    }
    const { code } = await begin(ownerIdentity);
    // Locked out, and the code it named is burned: the group has read it.
    expect(await redeem(sender, code)).toMatchObject({ ok: false, reason: 'rate_limited', burned: true });
    expect(await redeem('919000000079@s.whatsapp.net', code)).toMatchObject({ ok: false, reason: 'used' });
    expect(await redeem('919000000078@s.whatsapp.net', 'not a code')).toMatchObject({ ok: false, reason: 'bad_code' });
  });

  it('is not callable by the app role', async () => {
    const e = await refusal(as(ownerIdentity, q => q.query(`select internal.bridge_redeem_link_code(gen_random_uuid(), 'x', 'TM8-AAAAAA')`)));
    expect(e.code).toBe('forbidden');
  });
});

describe('bridges.links.list and revoke (§4.6)', () => {
  it('lists the caller\'s own live links, masked; another member sees none of them', async () => {
    const mine = await as(plainIdentity, q => q.rpc<{ items: Array<{ externalId: string; masked: string; method: string }> }>('my_bridge_links', []));
    expect(mine.items).toEqual([expect.objectContaining({ externalId: guest, masked: '…0001', method: 'code' })]);
    const theirs = await as(ownerIdentity, q => q.rpc<{ items: unknown[] }>('my_bridge_links', []));
    expect(theirs.items).toEqual([]);
  });

  it('only the identity revokes its link (human only); the sender is a guest again; revoking twice is quiet', async () => {
    const { items } = await as(plainIdentity, q => q.rpc<{ items: Array<{ id: string }> }>('my_bridge_links', []));
    const linkId = items[0]!.id;
    expect((await refusal(as(ownerIdentity, q => q.rpc('revoke_bridge_link', [linkId])))).code).toBe('not_found');
    expect((await refusal(as(plainIdentity, q => q.rpc('revoke_bridge_link', [linkId]), 'agent'))).code).toBe('forbidden');
    const revoked = await as(plainIdentity, q => q.rpc<{ revokedAt: string | null }>('revoke_bridge_link', [linkId]));
    expect(revoked.revokedAt).not.toBeNull();
    expect(await resolve(guest)).toMatchObject({ kind: 'bridge', trust: 'guest' });
    await as(plainIdentity, q => q.rpc('revoke_bridge_link', [linkId]));
  });

  it('a space admin revokes an assertion scoped to their space', async () => {
    const [row] = await scratch.query<{ id: string }>(`insert into public.bridge_identity_links(provider, external_id, identity_id,
      method, space_id, verified_at) values ('whatsapp',$1,$2,'admin',$3,now()) returning id`, [guest, plainIdentity, spaceId]);
    const out = await as(ownerIdentity, q => q.rpc<{ trust: string; revokedAt: string | null }>('revoke_bridge_link', [row!.id]));
    expect(out).toMatchObject({ trust: 'asserted' });
    expect(out.revokedAt).not.toBeNull();
  });
});

describe('Invite to space (D60)', () => {
  const invite = (identity: string, maxUses = 1) =>
    as(identity, q => q.rpc<{ invite: { id: string; code: string } }>('create_invite',
      [spaceId, maxUses, null, null, randomUUID(), 'member']));

  it('an admin pins a participant to a one-use invite; a member cannot', async () => {
    const { invite: inv } = await invite(ownerIdentity);
    const pin = await as(ownerIdentity, q => q.rpc<{ inviteId: string; masked: string }>('pin_bridge_invite', [inv.id, bridgeId, invitee]));
    expect(pin).toMatchObject({ inviteId: inv.id, masked: '…0002' });
    // Pinning the same pair again (a replayed create) is quiet; another participant is refused.
    await as(ownerIdentity, q => q.rpc('pin_bridge_invite', [inv.id, bridgeId, invitee]));
    expect((await refusal(as(ownerIdentity, q => q.rpc('pin_bridge_invite', [inv.id, bridgeId, guest])))).code).toBe('invalid_input');
    expect((await refusal(as(plainIdentity, q => q.rpc('pin_bridge_invite', [inv.id, bridgeId, invitee])))).code).toBe('forbidden');
    const { invite: many } = await invite(ownerIdentity, 3);
    expect((await refusal(as(ownerIdentity, q => q.rpc('pin_bridge_invite', [many.id, bridgeId, invitee])))).code).toBe('invalid_input');
    const { invite: one } = await invite(ownerIdentity);
    expect((await refusal(as(ownerIdentity, q => q.rpc('pin_bridge_invite', [one.id, bridgeId, 'nobody'])))).code).toBe('not_found');
  });

  it('redeeming the pinned invite links the joiner, identity-scoped, method invite', async () => {
    const { invite: inv } = await invite(ownerIdentity);
    await as(ownerIdentity, q => q.rpc('pin_bridge_invite', [inv.id, bridgeId, invitee]));
    const joined = await as(joinerIdentity, q => q.rpc<{ memberId: string; joined: boolean }>('redeem_invite', [inv.code, randomUUID(), null]));
    expect(joined.joined).toBe(true);
    const [link] = await scratch.query<{ identity_id: string; method: string; space_id: string | null }>(
      `select identity_id, method, space_id from public.bridge_identity_links where external_id = $1 and revoked_at is null`, [invitee]);
    expect(link).toEqual({ identity_id: joinerIdentity, method: 'invite', space_id: null });
    expect(await resolve(invitee)).toMatchObject({ kind: 'member', actorId: joined.memberId, trust: 'linked' });
    const [pin] = await scratch.query<{ completed: boolean }>(
      'select completed_at is not null as completed from public.bridge_invite_pins where invite_id = $1', [inv.id]);
    expect(pin!.completed).toBe(true);
  });

  it('an unpinned invite links nobody; a participant already linked cannot be pinned', async () => {
    const before = await scratch.query('select 1 from public.bridge_identity_links where revoked_at is null');
    const { invite: inv } = await invite(ownerIdentity);
    await as(`b3-plainjoin-${randomUUID()}`, q => q.rpc('redeem_invite', [inv.code, randomUUID(), null]));
    expect(await scratch.query('select 1 from public.bridge_identity_links where revoked_at is null')).toHaveLength(before.length);
    const { invite: again } = await invite(ownerIdentity);
    const e = await refusal(as(ownerIdentity, q => q.rpc('pin_bridge_invite', [again.id, bridgeId, invitee])));
    expect(e.details?.['reason']).toBe('already_linked');
  });
});
