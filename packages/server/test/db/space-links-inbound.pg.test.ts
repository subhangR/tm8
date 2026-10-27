/**
 * 278 — space links, the TARGET side (lane L2; owner decisions D2 and D7).
 *
 * D2 (b): an admin of the target space B sees every link into B, reads the
 * audit of the calls made through each (scoped to B), and revokes or restores
 * a link. D7 (a): owning both spaces is never an authority on its own — the
 * admin check holds the session pin, and a revoked link refuses its owners'
 * sign-in too.
 *
 * Fixture (space-links.pg.test.ts's shape): spaces A (home), B and C. H owns
 * A and B. H3 is a member of A and B and owns C. H2 is a member of A only.
 * G is H's agent, pinned to A.
 *
 * Every refusal is paired with a positive.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SpaceLinkInboundAuditEntry, SpaceLinkInboundView } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { DbSpaceLinkStore, type SpaceLink } from '../../src/credentials/space-link-store.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string; spaceB: string; spaceC: string;
  identityH: string; identityH2: string; identityH3: string;
  accountH: string; accountH2: string; accountH3: string;
  memberHA: string; memberHB: string; memberH2A: string;
  memberH3A: string; memberH3B: string; memberH3C: string;
  personaA: string; workSessionA: string;
}

let database: W1ScratchDatabase;
let db: Db;
let f: Fixture;
let store: DbSpaceLinkStore;

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'space-links-inbound-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
} as unknown as LoopbackOwner;

function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind: string | null): Promise<T> {
  return db.tx({ identityId, ...(authKind === null ? {} : { authKind }), requestId: `inbound-${randomUUID()}` } as DbClaims, fn);
}

async function claimsForToken(token: string): Promise<DbClaims> {
  const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
  const identity = await resolve({ authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true });
  return claimsFor(NOT_THE_OWNER, { identity, requestId: `inbound-${randomUUID()}` } as unknown as RequestContext);
}

async function browserClaims(accountId: string, identityId: string): Promise<DbClaims> {
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'inbound browser',
    ]), 'browser');
  return claimsForToken(formatToken(row.id, secret));
}

/** G: H's agent, its session pinned to A by its work session. */
async function agentClaims(): Promise<DbClaims> {
  const secret = generateSecret();
  const row = await asIdentity(f.identityH, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      f.workSessionA, f.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'inbound agent G',
    ]), 'browser');
  return claimsForToken(formatToken(row.id, secret));
}

const h = () => browserClaims(f.accountH, f.identityH);
const h3 = () => browserClaims(f.accountH3, f.identityH3);

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
  const x: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(), spaceC: randomUUID(),
    identityH: `inbound-h-${randomUUID()}`,
    identityH2: `inbound-h2-${randomUUID()}`,
    identityH3: `inbound-h3-${randomUUID()}`,
    accountH: randomUUID(), accountH2: randomUUID(), accountH3: randomUUID(),
    memberHA: randomUUID(), memberHB: randomUUID(), memberH2A: randomUUID(),
    memberH3A: randomUUID(), memberH3B: randomUUID(), memberH3C: randomUUID(),
    personaA: randomUUID(), workSessionA: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2'), ($3, 'H3')`,
      [x.identityH, x.identityH2, x.identityH3]);
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'inbound-h'), ($3, $4, 'inbound-h2'), ($5, $6, 'inbound-h3')`,
      [x.accountH, x.identityH, x.accountH2, x.identityH2, x.accountH3, x.identityH3]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Inbound A', $4), ($2, 'Inbound B', $4), ($3, 'Inbound C', $4)`,
      [x.spaceA, x.spaceB, x.spaceC, x.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [x.memberHA, x.spaceA, x.identityH, 'owner', 'H in A'],
      [x.memberHB, x.spaceB, x.identityH, 'owner', 'H in B'],
      [x.memberH2A, x.spaceA, x.identityH2, 'member', 'H2'],
      [x.memberH3A, x.spaceA, x.identityH3, 'member', 'H3 in A'],
      [x.memberH3B, x.spaceB, x.identityH3, 'member', 'H3 in B'],
      [x.memberH3C, x.spaceC, x.identityH3, 'owner', 'H3 in C'],
    ];
    for (const [id, space, identity, role, name] of members) {
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
        [id, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [id, space, identity, role, name]);
    }
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'work_session', $1, 'space')`,
      [x.personaA, x.workSessionA, x.spaceA, x.memberHA]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Inbound G', 'worker', 'persona')`,
      [x.personaA, x.memberHA]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Inbound G run', 'running', 'none', now())`,
      [x.workSessionA]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [x.spaceA, x.personaA, x.workSessionA]);
  });
  return x;
}

/** One audit row, written as the table owner (the invoke path writes it in production). */
async function auditRow(linkId: string, memberId: string, targetSpaceId: string, op: string): Promise<void> {
  await database.query(
    `insert into public.cross_space_audit(link_id, link_ref, home_space_id, target_space_id, member_id,
                                          work_session_id, op, result)
     values ($1::uuid, $1::text, $2, $3, $4, $5, $6, 'ok')`,
    [linkId, f.spaceA, targetSpaceId, memberId, f.workSessionA, op]);
}

let linkAB: SpaceLink;
let linkAC: SpaceLink;

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_links_inbound');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  f = await seed();
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-space-links-inbound-'));
  store = new DbSpaceLinkStore({ db, dataDir });
  // A → B: H and H3 both hold a row; H signs in. A → C: H3's, signed in.
  const hc = await h();
  linkAB = await store.add(hc, { spaceId: f.spaceA, targetSpaceId: f.spaceB });
  linkAB = await store.login(hc, linkAB.id);
  const h3c = await h3();
  await store.add(h3c, { spaceId: f.spaceA, targetSpaceId: f.spaceB });
  linkAC = await store.add(h3c, { spaceId: f.spaceA, targetSpaceId: f.spaceC });
  linkAC = await store.login(h3c, linkAC.id);
  await auditRow(linkAB.id, f.memberHA, f.spaceB, 'entities.create');
  await auditRow(linkAB.id, f.memberH3A, f.spaceB, 'messages.post');
  await auditRow(linkAC.id, f.memberH3A, f.spaceC, 'entities.update');
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe('278 spaceLinks.inbound.list — B admins see every link into B', () => {
  it('positive — H (owner of B) sees A → B, its holders named by their B member rows', async () => {
    const views = await store.listInbound(await h(), f.spaceB);
    expect(views.map((v) => v.id)).toEqual([linkAB.id]);
    const view = views[0] as SpaceLinkInboundView;
    expect(view.homeSpaceId).toBe(f.spaceA);
    expect(view.homeSpaceName).toBe('Inbound A');
    expect(view.revokedAt).toBeNull();
    expect(view.lastCallAt).not.toBeNull();
    expect(view.holders.map((x) => [x.targetMemberId, x.displayName, x.status])).toEqual([
      [f.memberHB, 'H in B', 'signed_in'],
      [f.memberH3B, 'H3 in B', 'signed_out'],
    ]);
    // No home-side member id leaks.
    expect(JSON.stringify(view)).not.toContain(f.memberHA);
    expect(JSON.stringify(view)).not.toContain(f.memberH3A);
  });

  it('a link into C is not B\'s: H3 (owner of C) sees only A → C', async () => {
    const views = await store.listInbound(await h3(), f.spaceC);
    expect(views.map((v) => v.id)).toEqual([linkAC.id]);
  });

  it('a non-admin member of B (H3) is refused 42501; a non-member (H2) too', async () => {
    expect(await outcome(async () => store.listInbound(await h3(), f.spaceB))).toBe('42501');
    expect(await outcome(async () => store.listInbound(await browserClaims(f.accountH2, f.identityH2), f.spaceB))).toBe('42501');
  });

  it('D7 — G, H\'s agent pinned to A, is refused on B although H owns both; paired positive: G is pinned, H is not', async () => {
    const g = await agentClaims();
    expect(await outcome(() => store.listInbound(g, f.spaceB))).toBe('42501');
    expect(await outcome(() => store.listInboundAudit(g, f.spaceB))).toBe('42501');
    expect(await outcome(async () => store.listInbound(await h(), f.spaceB))).toBe('ok');
  });
});

describe('278 spaceLinks.inbound.audit — scoped to B', () => {
  it('positive — B\'s admin reads the calls into B only, newest first, callers named in B', async () => {
    const rows = await store.listInboundAudit(await h(), f.spaceB);
    expect(rows.map((r) => r.op)).toEqual(['messages.post', 'entities.create']);
    expect(rows.every((r) => r.targetSpaceId === f.spaceB && r.linkId === linkAB.id)).toBe(true);
    expect(rows.map((r) => r.targetMemberId)).toEqual([f.memberH3B, f.memberHB]);
    // The home-side work session and member ids are not returned.
    const text = JSON.stringify(rows);
    expect(text).not.toContain(f.workSessionA);
    expect(text).not.toContain(f.memberHA);
    expect(Object.keys(rows[0] as SpaceLinkInboundAuditEntry)).not.toContain('workSessionId');
  });

  it('naming another space\'s link from B returns nothing; C\'s admin sees C\'s row', async () => {
    expect(await store.listInboundAudit(await h(), f.spaceB, { linkId: linkAC.id })).toEqual([]);
    const rows = await store.listInboundAudit(await h3(), f.spaceC, { linkId: linkAC.id });
    expect(rows.map((r) => r.op)).toEqual(['entities.update']);
  });

  it('a row whose target is not B is not B\'s even on a link into B', async () => {
    await auditRow(linkAB.id, f.memberHA, f.spaceC, 'forged.target');
    const rows = await store.listInboundAudit(await h(), f.spaceB);
    expect(rows.map((r) => r.op)).not.toContain('forged.target');
  });

  it('limit and before page it', async () => {
    const [first] = await store.listInboundAudit(await h(), f.spaceB, { limit: 1 });
    expect(first?.op).toBe('messages.post');
    const rest = await store.listInboundAudit(await h(), f.spaceB, { before: first!.createdAt });
    expect(rest.map((r) => r.op)).not.toContain('messages.post');
  });

  it('a non-admin member of B (H3) is refused 42501', async () => {
    expect(await outcome(async () => store.listInboundAudit(await h3(), f.spaceB))).toBe('42501');
  });
});

describe('278 spaceLinks.inbound.revoke / restore — B admin, human-only, D7', () => {
  it('refusals — agent G (pinned to A), a link session, an agent kind, a non-admin, a link into another space', async () => {
    expect(await outcome(async () => store.revokeInbound(await agentClaims(), f.spaceB, linkAB.id))).toBe('42501');
    for (const kind of ['link', 'agent', null] as const) {
      expect(await outcome(() => asIdentity(f.identityH, (q) =>
        q.rpc('revoke_inbound_space_link', [f.spaceB, linkAB.id, null]), kind))).toBe('42501');
    }
    expect(await outcome(async () => store.revokeInbound(await h3(), f.spaceB, linkAB.id))).toBe('42501');
    expect(await outcome(async () => store.revokeInbound(await h(), f.spaceB, linkAC.id))).toBe('P0002');
    const [row] = await database.query<{ target_revoked_at: string | null }>(
      `select target_revoked_at from public.space_links where entity_id = $1`, [linkAB.id]);
    expect(row?.target_revoked_at).toBeNull();
  });

  it('revoke signs every row out, ends the stored sessions, and the home side sees why', async () => {
    const [before] = await database.query<{ auth_session_id: string }>(
      `select auth_session_id::text from public.space_link_tokens where link_id = $1 and member_id = $2`,
      [linkAB.id, f.memberHA]);
    expect(before?.auth_session_id).toBeTruthy();

    const view = await store.revokeInbound(await h(), f.spaceB, linkAB.id);
    expect(view.revokedAt).not.toBeNull();
    expect(view.revokedByMemberId).toBe(f.memberHB);
    expect(view.holders.every((x) => x.status === 'signed_out')).toBe(true);

    const tokens = await database.query<{ ciphertext: Buffer | null; auth_session_id: string | null }>(
      `select ciphertext, auth_session_id::text from public.space_link_tokens where link_id = $1`, [linkAB.id]);
    expect(tokens.every((t) => t.ciphertext === null && t.auth_session_id === null)).toBe(true);
    const [session] = await database.query<{ revoked_at: string | null }>(
      `select revoked_at from public.auth_sessions where id = $1`, [before!.auth_session_id]);
    expect(session?.revoked_at).not.toBeNull();

    const home = (await store.list(await h(), f.spaceA)).find((l) => l.id === linkAB.id);
    expect(home?.targetRevokedAt).not.toBeNull();
    const [attention] = await database.query<{ n: number }>(
      `select count(*)::int as n from public.attention_requests where entity_id = $1 and status = 'open'`, [linkAB.id]);
    expect(attention?.n).toBe(1);
    // The other link is untouched.
    expect((await store.listInbound(await h3(), f.spaceC))[0]?.revokedAt).toBeNull();
  });

  it('D7 — a revoked link refuses sign-in to H, who owns both spaces; remove and re-add does not lift it', async () => {
    const hc = await h();
    expect(await outcome(() => store.login(hc, linkAB.id))).toBe('42501');
    expect(await outcome(() => store.login(hc, linkAB.id, { relogin: true }))).toBe('42501');
    await store.remove(hc, linkAB.id);
    const again = await store.add(hc, { spaceId: f.spaceA, targetSpaceId: f.spaceB });
    expect(again.id).toBe(linkAB.id);
    expect(again.targetRevokedAt).not.toBeNull();
    expect(await outcome(() => store.login(hc, linkAB.id))).toBe('42501');
  });

  it('revoke is idempotent on the revocation time', async () => {
    const first = (await store.listInbound(await h(), f.spaceB))[0]!.revokedAt;
    const again = await store.revokeInbound(await h(), f.spaceB, linkAB.id);
    expect(again.revokedAt).toBe(first);
  });

  it('restore — non-admin refused; B\'s admin lifts it and members sign in again for themselves', async () => {
    expect(await outcome(async () => store.restoreInbound(await h3(), f.spaceB, linkAB.id))).toBe('42501');
    const view = await store.restoreInbound(await h(), f.spaceB, linkAB.id);
    expect(view.revokedAt).toBeNull();
    expect(view.holders.some((x) => x.status === 'signed_in')).toBe(false);
    const signed = await store.login(await h(), linkAB.id);
    expect(signed.mine?.status).toBe('signed_in');
    expect(signed.targetRevokedAt).toBeNull();
  });
});
