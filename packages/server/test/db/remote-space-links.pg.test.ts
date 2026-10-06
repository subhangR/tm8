/**
 * W9c — space links across servers (migration 301). The DB half, both sides
 * in one database (each side's rows are what that server would hold):
 *
 *   TARGET (space B): grant is human-only and member-only and stores only a
 *   pairing hash; claim is single use (burnt on EVERY outcome), bound to the
 *   granted home space, and mints a `link` session pinned to B and stamped
 *   via_link_id; the inbound row is hidden from B's own outgoing surfaces,
 *   never holds sealed bytes, answers only its own live session, and ends on
 *   the home's revoke and on B's admin revoke.
 *   HOME (space A): a remote link needs one of A's own server entities; its
 *   row holds the target-minted session sealed with no local auth session.
 *
 * Fixture: H owns A and B; H2 is a member of A only. Every refusal is paired
 * with a positive through the same RPC. No real secret: random bytes.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { DbSpaceLinkStore, pairingCodeHash } from '../../src/credentials/space-link-store.js';
import { resolveBearerIdentity } from '../../src/identity/pg-auth.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string; spaceB: string;
  identityH: string; identityH2: string;
  memberHA: string; memberHB: string; memberH2A: string;
}

interface InboundJson {
  id: string; homeSpaceId: string; homeSpaceName: string | null; targetSpaceId: string;
  remoteHome: { spaceId: string; label: string | null; serverId: string | null; baseUrl: string | null } | null;
  holders: Array<{ status: string; allowSpawn: boolean }>;
}

let database: W1ScratchDatabase;
let db: Db;
let f: Fixture;
let store: DbSpaceLinkStore;

const cmid = (): string => `w9c-${randomUUID()}`;
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const inMinutes = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

function claimsOf(identityId: string, opts: { authKind?: string; viaLinkId?: string; sessionSpaceId?: string } = {}): DbClaims {
  return {
    identityId,
    authKind: opts.authKind ?? 'browser',
    nodeAdmin: false,
    requestId: `w9c-${randomUUID()}`,
    ...(opts.viaLinkId ? { viaLinkId: opts.viaLinkId } : {}),
    ...(opts.sessionSpaceId ? { sessionSpaceId: opts.sessionSpaceId } : {}),
  };
}

function as<T>(identityId: string, fn: (q: Querier) => Promise<T>, opts: Parameters<typeof claimsOf>[1] = {}): Promise<T> {
  return db.tx(claimsOf(identityId, opts), fn);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

async function seed(): Promise<Fixture> {
  const fx: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(),
    identityH: `w9c-h-${randomUUID()}`, identityH2: `w9c-h2-${randomUUID()}`,
    memberHA: randomUUID(), memberHB: randomUUID(), memberH2A: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2')`,
      [fx.identityH, fx.identityH2]);
    await client.query(
      `insert into public.accounts(id, identity_id, username) values (gen_random_uuid(), $1, 'w9c-h'), (gen_random_uuid(), $2, 'w9c-h2')`,
      [fx.identityH, fx.identityH2]);
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Home A', $3), ($2, 'Target B', $3)`,
      [fx.spaceA, fx.spaceB, fx.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [fx.memberHA, fx.spaceA, fx.identityH, 'owner', 'H'],
      [fx.memberHB, fx.spaceB, fx.identityH, 'owner', 'H'],
      [fx.memberH2A, fx.spaceA, fx.identityH2, 'member', 'H2'],
    ];
    for (const [id, space, identity, role, name] of members) {
      await client.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
        [id, space]);
      await client.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [id, space, identity, role, name]);
    }
  });
  return fx;
}

/** A remote home space id (it lives on "another server": no row here). */
const remoteHome = randomUUID();

function grant(code: string, opts: { identityId?: string; authKind?: string; home?: string; expires?: string; allowSpawn?: boolean } = {}) {
  return as(opts.identityId ?? f.identityH, (q) => q.rpc<InboundJson>('grant_remote_space_link', [
    f.spaceB, opts.home ?? remoteHome, 's1 laptop', opts.allowSpawn ?? true, sha(code), opts.expires ?? inMinutes(10),
  ]), { authKind: opts.authKind ?? 'browser' });
}

function claim(code: string, opts: { home?: string } = {}) {
  return db.rpc<{ ok: boolean; reason?: string; linkId?: string; sessionId?: string; targetSpaceId?: string }>({}, 'claim_remote_space_link', [
    sha(code), opts.home ?? remoteHome, 'node-s1', 'https://s1.example', randomUUID(), sha(`secret-${randomUUID()}`), inMinutes(60 * 24),
  ]);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('remote_space_links');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  f = await seed();
  store = new DbSpaceLinkStore({ db, dataDir: await mkdtemp(join(tmpdir(), 'w9c-key-')) });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe('TARGET: grant', () => {
  it('human member of B only; hash and expiry are checked; POSITIVE: the inbound view names the remote home', async () => {
    expect(await outcome(() => grant('code-agent-0000000', { authKind: 'agent' }))).toBe('42501');
    expect(await outcome(() => grant('code-link-00000000', { authKind: 'link' }))).toBe('42501');
    expect(await outcome(() => grant('code-h2-0000000000', { identityId: f.identityH2 }))).toBe('42501');
    expect(await outcome(() => grant('code-late-00000000', { expires: inMinutes(31) }))).toBe('22023');
    expect(await outcome(() => grant('code-self-00000000', { home: f.spaceB }))).toBe('22023');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('grant_remote_space_link', [
      f.spaceB, remoteHome, null, false, 'not-a-hash', inMinutes(5)])))).toBe('22023');

    const view = await grant('code-positive-0001');
    expect(view).toMatchObject({
      homeSpaceId: remoteHome, homeSpaceName: 's1 laptop', targetSpaceId: f.spaceB,
      remoteHome: { spaceId: remoteHome, label: 's1 laptop', serverId: null, baseUrl: null },
    });
    expect(view.holders).toEqual([expect.objectContaining({ status: 'signed_out', allowSpawn: true })]);
    // Only the hash is stored.
    const [row] = await database.query<{ pairing_hash: string; ciphertext: Buffer | null; remote_inbound: boolean }>(
      'select pairing_hash, ciphertext, remote_inbound from public.space_link_tokens where link_id = $1', [view.id]);
    expect(row).toEqual({ pairing_hash: sha('code-positive-0001'), ciphertext: null, remote_inbound: true });
  });
});

describe('TARGET: claim', () => {
  it('unknown code, wrong home (burns it), expired; POSITIVE: one link session pinned to B, stamped, recorded; then single use', async () => {
    expect(await claim('never-granted-000000')).toEqual({ ok: false, reason: 'pairing_invalid' });

    await grant('code-wrong-home-001');
    expect(await claim('code-wrong-home-001', { home: randomUUID() })).toEqual({ ok: false, reason: 'home_mismatch' });
    // Burnt by the failed attempt: the right home cannot use it now.
    expect(await claim('code-wrong-home-001')).toEqual({ ok: false, reason: 'pairing_invalid' });

    await grant('code-expired-000001');
    await database.query(`update public.space_link_tokens set pairing_expires_at = now() - interval '1 second'
      where pairing_hash = $1`, [sha('code-expired-000001')]);
    expect(await claim('code-expired-000001')).toEqual({ ok: false, reason: 'pairing_expired' });

    const view = await grant('code-good-00000001');
    const claimed = await claim('code-good-00000001');
    expect(claimed).toMatchObject({ ok: true, linkId: view.id, targetSpaceId: f.spaceB });
    const [session] = await database.query<{ kind: string; space_id: string; via_link_id: string; revoked_at: string | null }>(
      'select kind, space_id::text, via_link_id::text, revoked_at from public.auth_sessions where id = $1', [claimed.sessionId]);
    expect(session).toEqual({ kind: 'link', space_id: f.spaceB, via_link_id: view.id, revoked_at: null });
    const [row] = await database.query<Record<string, unknown>>(
      `select status, auth_session_id::text, ciphertext, pairing_hash from public.space_link_tokens where link_id = $1`, [view.id]);
    expect(row).toEqual({ status: 'signed_in', auth_session_id: claimed.sessionId, ciphertext: null, pairing_hash: null });
    const [link] = await database.query<Record<string, unknown>>(
      'select remote_home_server_id, remote_home_base_url from public.space_links where entity_id = $1', [view.id]);
    expect(link).toEqual({ remote_home_server_id: 'node-s1', remote_home_base_url: 'https://s1.example' });
    expect(await claim('code-good-00000001')).toEqual({ ok: false, reason: 'pairing_invalid' });
  });

  it('through the store: the claimed token resolves as a link session of the member, pinned to B', async () => {
    const granted = await store.grantInbound(claimsOf(f.identityH), { spaceId: f.spaceB, homeSpaceId: remoteHome, allowSpawn: false });
    expect(granted.pairingCode).toMatch(/^tm8pair_[A-Za-z0-9_-]{32}$/);
    expect(pairingCodeHash(granted.pairingCode)).toHaveLength(64);
    const claimed = await store.claimInbound({
      pairingCode: granted.pairingCode, homeSpaceId: remoteHome, homeServerId: 'node-s1', homeBaseUrl: null,
    });
    if (!claimed.ok) throw new Error(`claim refused: ${claimed.reason}`);
    const session = await resolveBearerIdentity(db, claimed.token);
    expect(session).toMatchObject({ kind: 'link', identityId: f.identityH, spaceId: f.spaceB, viaLinkId: granted.link.id });
  });
});

describe('TARGET: the inbound row', () => {
  it('is hidden from B\'s own outgoing list and invoke, never takes sealed bytes, and answers only its own live session', async () => {
    const view = await grant('code-hidden-000001');
    const claimed = await claim('code-hidden-000001');
    expect(claimed.ok).toBe(true);

    const outgoing = await as(f.identityH, (q) => q.rpc<Array<{ id: string }>>('list_space_links', [f.spaceB]));
    expect(outgoing.map((l) => l.id)).not.toContain(view.id);
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('resolve_space_link_invoke', [f.spaceB, view.id]), { authKind: 'agent' })))
      .toBe('P0002');
    // No bytes on an inbound row: neither a raw write nor 251's local login.
    expect(await outcome(() => database.query(
      'update public.space_link_tokens set ciphertext = $2, nonce = $3 where link_id = $1', [view.id, randomBytes(48), randomBytes(12)])))
      .toBe('42501');
    expect(await outcome(() => store.login(claimsOf(f.identityH), view.id))).toBe('42501');

    const link = { authKind: 'link', viaLinkId: view.id, sessionSpaceId: f.spaceB };
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('remote_space_link_inbound_row', [claimed.sessionId]), { authKind: 'agent' })))
      .toBe('42501');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('remote_space_link_inbound_row', [randomUUID()]), link))).toBe('P0002');
    const row = await as(f.identityH, (q) => q.rpc<Record<string, unknown>>('remote_space_link_inbound_row', [claimed.sessionId]), link);
    expect(row).toMatchObject({ linkId: view.id, targetSpaceId: f.spaceB, allowSpawn: true, remoteHomeSpaceId: remoteHome });

    // The home's logout: the session ends, the row signs out, the lookup refuses.
    expect(await as(f.identityH, (q) => q.rpc('revoke_remote_space_link_session', [claimed.sessionId]), link)).toBe(true);
    const [after] = await database.query<{ status: string; revoked: boolean }>(
      `select t.status, s.revoked_at is not null as revoked from public.space_link_tokens t
         join public.auth_sessions s on s.id = $2 where t.link_id = $1`, [view.id, claimed.sessionId]);
    expect(after).toEqual({ status: 'signed_out', revoked: true });
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('remote_space_link_inbound_row', [claimed.sessionId]), link))).toBe('P0002');
  });

  it("B's admin revoke ends the session and refuses grant and claim until restored; POSITIVE after restore", async () => {
    const view = await grant('code-admin-0000001');
    const claimed = await claim('code-admin-0000001');
    expect(claimed.ok).toBe(true);
    const revoked = await as(f.identityH, (q) => q.rpc<InboundJson & { revokedAt: string | null }>(
      'revoke_inbound_space_link', [f.spaceB, view.id, cmid()]));
    expect(revoked.revokedAt).not.toBeNull();
    const [session] = await database.query<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from public.auth_sessions where id = $1', [claimed.sessionId]);
    expect(session).toEqual({ revoked: true });
    expect(await outcome(() => grant('code-admin-0000002'))).toBe('42501');

    await as(f.identityH, (q) => q.rpc('restore_inbound_space_link', [f.spaceB, view.id, cmid()]));
    await grant('code-admin-0000003');
    expect(await claim('code-admin-0000003')).toMatchObject({ ok: true, linkId: view.id });
  });
});

describe('HOME: a link to a space on another server', () => {
  it('needs one of A\'s own servers; human only; POSITIVE: sealed session, no local auth session, opened by an agent', async () => {
    const server = await as(f.identityH, (q) => q.rpc<{ id: string }>('add_server', [f.spaceA, 's2', 'https://s2.example', null, cmid()]));
    const targetOnS2 = randomUUID();

    expect(await outcome(() => as(f.identityH, (q) => q.rpc('add_remote_space_link', [f.spaceA, randomUUID(), targetOnS2, null, cmid()]))))
      .toBe('P0002');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('add_remote_space_link', [f.spaceA, server.id, targetOnS2, null, cmid()]),
      { authKind: 'agent' }))).toBe('42501');
    const link = await as(f.identityH, (q) => q.rpc<{ id: string; targetServerId: string; mine: { status: string } }>(
      'add_remote_space_link', [f.spaceA, server.id, targetOnS2, 's2b', cmid()]));
    expect(link).toMatchObject({ targetServerId: server.id, mine: { status: 'signed_out' } });

    const context = await as(f.identityH, (q) => q.rpc<Record<string, unknown>>('remote_space_link_context', [link.id]));
    expect(context).toMatchObject({ linkId: link.id, targetServerId: server.id, baseUrl: 'https://s2.example', targetSpaceId: targetOnS2 });

    const remoteSession = randomUUID();
    const signedIn = await store.storeRemoteSession(claimsOf(f.identityH), link.id, {
      token: `tm8s_${remoteSession}.${randomBytes(32).toString('base64url')}`, remoteSessionId: remoteSession, expiresAt: inMinutes(60),
    });
    expect(signedIn.mine?.status).toBe('signed_in');
    const [row] = await database.query<Record<string, unknown>>(
      'select auth_session_id, remote_session_id::text, ciphertext is not null as sealed from public.space_link_tokens where link_id = $1',
      [link.id]);
    expect(row).toEqual({ auth_session_id: null, remote_session_id: remoteSession, sealed: true });

    // The agent's view: invoke resolves it as remote, and the forwarder can open it.
    const resolved = await as(f.identityH, (q) => q.rpc<{ targetServerId: string }>('resolve_space_link_invoke', [f.spaceA, 's2b']),
      { authKind: 'agent' });
    expect(resolved.targetServerId).toBe(server.id);
    expect(await store.openRemote(claimsOf(f.identityH, { authKind: 'agent' }), link.id)).toMatch(/^tm8s_/);

    // A local link (B on this server) takes no remote session.
    const local = await as(f.identityH, (q) => q.rpc<{ id: string }>('add_space_link', [f.spaceA, f.spaceB, null, cmid()]));
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('store_remote_space_link_session', [
      local.id, randomUUID(), inMinutes(60), randomBytes(48), randomBytes(12), 'spaceLinks.login', cmid()])))).toBe('22023');
  });
});
