/**
 * W7p — link provenance (migration 992). The DB half of: a session minted under
 * a space link carries `via_link_id`, never reads the linking human's own
 * credentials, and ends when the link does.
 *
 * Fixture, in space-links.pg.test.ts's style: spaces A (home) and B (target).
 * H owns A and B; H3 and H4 are members of A and B. PB is H's persona in B.
 * Every child is minted in its own work session, because an issuer retires the
 * work session's earlier tokens.
 *
 * Every refusal is paired with a positive. No token or ciphertext is printed.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { DbSpaceLinkStore, type SpaceLink } from '../../src/credentials/space-link-store.js';
import { DbGitHubCredentialStore } from '../../src/credentials/github-credential-store.js';
import { DbAgentCredentialHome } from '../../src/credentials/agent-credential-injection.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string; spaceB: string;
  identityH: string; identityH3: string; identityH4: string;
  accountH: string; accountH3: string; accountH4: string;
  memberHA: string; memberHB: string; memberH3A: string; memberH3B: string; memberH4A: string; memberH4B: string;
  personaB: string; personaA: string;
  antDefaultB: string; ghDefaultB: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;
let dataDir: string;
let store: DbSpaceLinkStore;

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'w7p-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
} as unknown as LoopbackOwner;

function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind = 'browser'): Promise<T> {
  return db.tx({ identityId, authKind, requestId: `w7p-${randomUUID()}` } as DbClaims, fn);
}

async function mintHuman(accountId: string, identityId: string, kind: 'browser' | 'cli' = 'browser'): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), kind,
      new Date(Date.now() + 3_600_000).toISOString(), null, `w7p ${kind}`,
    ]));
  return formatToken(row.id, secret);
}

async function claimsForToken(token: string, spaceSessions: 'agents' | 'off' = 'agents'): Promise<DbClaims> {
  const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions });
  const identity = await resolve(
    { authorization: `Bearer ${token}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true },
  );
  const ctx = { identity, requestId: `w7p-${randomUUID()}` } as unknown as RequestContext;
  return claimsFor(NOT_THE_OWNER, ctx);
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

/** A fresh live work session in `space`, with `persona` participating and related. */
async function workSession(space: string, persona: string, createdBy: string): Promise<string> {
  const id = randomUUID();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
      [id, space, createdBy]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'W7p run', 'running', 'none', now())`, [id]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2), ($1, $3, $2, 'relates_to', $2)`,
      [space, persona, id]);
  });
  return id;
}

interface Minted { token: string; id: string; workSessionId: string }

/** Mint an agent session under `claims` with `issuer`, in a fresh (or given) work session in B. */
async function mintChild(
  claims: DbClaims,
  opts: { issuer?: 'issue_agent_auth_session' | 'issue_work_session_agent_session'; workSessionId?: string; days?: number } = {},
): Promise<Minted> {
  const ws = opts.workSessionId ?? await workSession(fixture.spaceB, fixture.personaB, fixture.memberHB);
  const secret = generateSecret();
  const row = await db.rpc<{ id: string }>(claims, opts.issuer ?? 'issue_agent_auth_session', [
    ws, fixture.personaB, hashToken(secret),
    new Date(Date.now() + (opts.days ?? 1) * 86_400_000).toISOString(), 'w7p child',
  ]);
  return { token: formatToken(row.id, secret), id: row.id, workSessionId: ws };
}

async function sessionRow(id: string): Promise<{ via_link_id: string | null; parent_session_id: string | null; revoked: boolean; expires_at: Date; kind: string }> {
  const [row] = await database.query<{ via_link_id: string | null; parent_session_id: string | null; revoked: boolean; expires_at: Date; kind: string }>(
    `select via_link_id::text, parent_session_id::text, revoked_at is not null as revoked, expires_at, kind
       from public.auth_sessions where id = $1`, [id]);
  if (!row) throw new Error(`no auth session ${id}`);
  return row;
}

async function seed(): Promise<Fixture> {
  const f: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(),
    identityH: `w7p-h-${randomUUID()}`, identityH3: `w7p-h3-${randomUUID()}`, identityH4: `w7p-h4-${randomUUID()}`,
    accountH: randomUUID(), accountH3: randomUUID(), accountH4: randomUUID(),
    memberHA: randomUUID(), memberHB: randomUUID(), memberH3A: randomUUID(), memberH3B: randomUUID(),
    memberH4A: randomUUID(), memberH4B: randomUUID(),
    personaB: randomUUID(), personaA: randomUUID(),
    antDefaultB: randomUUID(), ghDefaultB: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H3'), ($3, 'H4')`,
      [f.identityH, f.identityH3, f.identityH4]);
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'w7p-h'), ($3, $4, 'w7p-h3'), ($5, $6, 'w7p-h4')`,
      [f.accountH, f.identityH, f.accountH3, f.identityH3, f.accountH4, f.identityH4]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'W7p A', $3), ($2, 'W7p B', $3)`,
      [f.spaceA, f.spaceB, f.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [f.memberHA, f.spaceA, f.identityH, 'owner', 'H'],
      [f.memberHB, f.spaceB, f.identityH, 'owner', 'H'],
      [f.memberH3A, f.spaceA, f.identityH3, 'member', 'H3'],
      [f.memberH3B, f.spaceB, f.identityH3, 'member', 'H3'],
      [f.memberH4A, f.spaceA, f.identityH4, 'member', 'H4'],
      [f.memberH4B, f.spaceB, f.identityH4, 'member', 'H4'],
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
       values ($1, $2, 'team_member', $3, 'space'), ($4, $5, 'team_member', $6, 'space')`,
      [f.personaB, f.spaceB, f.memberHB, f.personaA, f.spaceA, f.memberHA]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'W7p PB', 'worker', 'persona'), ($3, $4, 'W7p PA', 'worker', 'persona')`,
      [f.personaB, f.memberHB, f.personaA, f.memberHA]);
    await client.query(
      `insert into public.space_credentials(id, space_id, provider, shape, label, is_default, key_hint, secret_ciphertext, secret_nonce)
       values ($1, $3, 'anthropic', 'api_key', 'B anthropic', true, 'abcd', decode(repeat('00', 17), 'hex'), decode(repeat('00', 12), 'hex')),
              ($2, $3, 'github', 'token', 'B github', true, 'abcd', decode(repeat('00', 17), 'hex'), decode(repeat('00', 12), 'hex'))`,
      [f.antDefaultB, f.ghDefaultB, f.spaceB]);
    // H's own model login (083) — what a link-bound caller must never see.
    await client.query(
      `insert into public.account_agent_credentials(account_id, provider, status, login) values ($1, 'anthropic', 'active', 'h@example.test')`,
      [f.accountH]);
  });
  return f;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_link_provenance');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  fixture = await seed();
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-w7p-'));
  store = new DbSpaceLinkStore({ db, dataDir });
  // H's own GitHub login (093) — what a link-bound caller must never read.
  await new DbGitHubCredentialStore({ db, dataDir }).store(
    { identityId: fixture.identityH, authKind: 'browser', nodeAdmin: false },
    { login: 'w7p-h', token: `gho_${'W'.repeat(36)}` });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

const humanClaims = async (who: 'H' | 'H3' | 'H4' = 'H', kind: 'browser' | 'cli' = 'browser'): Promise<DbClaims> => {
  const [account, identity] = who === 'H'
    ? [fixture.accountH, fixture.identityH]
    : who === 'H3' ? [fixture.accountH3, fixture.identityH3] : [fixture.accountH4, fixture.identityH4];
  return claimsForToken(await mintHuman(account, identity, kind));
};

interface Linked { link: SpaceLink; human: DbClaims; linkToken: string; linkClaims: DbClaims; linkSessionId: string }

/** `who`'s link A → B, logged in, and its stored link session's claims. */
async function linked(who: 'H' | 'H3' | 'H4' = 'H'): Promise<Linked> {
  const human = await humanClaims(who);
  const added = await store.add(human, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
  const link = await store.login(human, added.id);
  const use = await store.use(human, link.id);
  return { link, human, linkToken: use.token, linkClaims: await claimsForToken(use.token), linkSessionId: use.session.sessionId };
}

const readGit = (claims: DbClaims) => db.rpc(claims, 'read_account_git_credential', ['github']);
const read206 = (claims: DbClaims, id: string | null = null, provider = 'anthropic') =>
  db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, provider, id]);
const modelRows = (claims: DbClaims) =>
  db.query<{ provider: string }>(claims, `select provider from public.account_agent_credentials where status = 'active'`);

// ---------------------------------------------------------------------------

describe('W7p the link session and its children carry via_link', () => {
  let L: Linked;
  beforeAll(async () => { L = await linked(); });

  it('the link session is stamped with its link, and the resolver forwards it as a claim', async () => {
    expect((await sessionRow(L.linkSessionId)).via_link_id).toBe(L.link.id);
    expect(L.linkClaims).toMatchObject({ authKind: 'link', viaLinkId: L.link.id, sessionSpaceId: fixture.spaceB });
  });

  it('a child minted under the link (226 agent issuer) has via_link_id and the link session as parent', async () => {
    const child = await mintChild(L.linkClaims);
    expect(await sessionRow(child.id)).toMatchObject({
      kind: 'agent', via_link_id: L.link.id, parent_session_id: L.linkSessionId, revoked: false,
    });
    expect(await claimsForToken(child.token)).toMatchObject({ authKind: 'agent', viaLinkId: L.link.id });
  });

  it('the work-session issuer stamps the same', async () => {
    const child = await mintChild(L.linkClaims, { issuer: 'issue_work_session_agent_session' });
    expect(await sessionRow(child.id)).toMatchObject({ via_link_id: L.link.id, parent_session_id: L.linkSessionId });
  });

  it('a grandchild inherits via_link, parented flat on the link session', async () => {
    const child = await mintChild(L.linkClaims);
    const grand = await mintChild(await claimsForToken(child.token));
    expect(await sessionRow(grand.id)).toMatchObject({ via_link_id: L.link.id, parent_session_id: L.linkSessionId });
  });

  it('a resume re-mint by the non-link human keeps the link (the work session ran under it)', async () => {
    const child = await mintChild(L.linkClaims);
    const resumed = await mintChild(L.human, { workSessionId: child.workSessionId });
    expect(await sessionRow(resumed.id)).toMatchObject({ via_link_id: L.link.id, parent_session_id: L.linkSessionId });
    expect((await sessionRow(child.id)).revoked).toBe(true);
  });

  it('the spawn port reads that stamp: the non-link resumer\'s launch is link-bound, an ordinary one is not', async () => {
    // SpawnService asks this AFTER the mint, so its TS credential policy
    // follows the SQL stamp rather than the resumer's own claims.
    const graph = new DbGraphPort(db);
    const child = await mintChild(L.linkClaims);
    const resumed = await mintChild(L.human, { workSessionId: child.workSessionId });
    expect(L.human.viaLinkId ?? null).toBeNull();
    expect(await graph.isLinkBound(L.human, resumed.token)).toBe(true);
    const ordinary = await mintChild(L.human);
    expect(await graph.isLinkBound(L.human, ordinary.token)).toBe(false);
    expect(await graph.isLinkBound(L.linkClaims, ordinary.token)).toBe(true);
  });

  it('a child never outlives its link session (expiry capped)', async () => {
    const child = await mintChild(L.linkClaims, { days: 400 });
    const [c, p] = [await sessionRow(child.id), await sessionRow(L.linkSessionId)];
    expect(c.expires_at.getTime()).toBe(p.expires_at.getTime());
  });

  it('control — the same human\'s ordinary child has no via_link', async () => {
    const child = await mintChild(L.human);
    expect(await sessionRow(child.id)).toMatchObject({ via_link_id: null, parent_session_id: null });
  });

  it('via_link_id is only ever on a link or agent session (CHECK)', async () => {
    const [row] = await database.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auth_sessions_via_link_kind'`);
    expect(row!.def).toContain('via_link_id IS NULL');
  });
});

describe('W7p 093 — the linking human\'s git login is refused, never null', () => {
  let L: Linked;
  beforeAll(async () => { L = await linked(); });

  it('the link session: 42501', async () => {
    expect(await outcome(() => readGit(L.linkClaims))).toBe('42501');
  });

  it('a link child: 42501', async () => {
    const child = await mintChild(L.linkClaims);
    expect(await outcome(async () => readGit(await claimsForToken(child.token)))).toBe('42501');
  });

  it('a grandchild: 42501', async () => {
    const child = await mintChild(L.linkClaims);
    const grand = await mintChild(await claimsForToken(child.token));
    expect(await outcome(async () => readGit(await claimsForToken(grand.token)))).toBe('42501');
  });

  it('positives — H\'s cli session, and H\'s ordinary agent child, read the login', async () => {
    expect(await readGit(await humanClaims('H', 'cli'))).toMatchObject({ login: 'w7p-h' });
    const control = await mintChild(L.human);
    expect(await readGit(await claimsForToken(control.token))).toMatchObject({ login: 'w7p-h' });
  });

  it('DbGitHubCredentialStore.resolve surfaces the 42501 — it does not answer "no login"', async () => {
    const git = new DbGitHubCredentialStore({ db, dataDir });
    const child = await mintChild(L.linkClaims);
    expect(await outcome(async () => git.resolve(await claimsForToken(child.token)))).toBe('42501');
    // Paired positive.
    expect(await git.resolve(L.human)).toMatchObject({ login: 'w7p-h' });
  });
});

describe('W7p 083 — the linking human\'s model login is not offered', () => {
  let L: Linked;
  beforeAll(async () => { L = await linked(); });

  it('a link child sees no model credential row; H does', async () => {
    const child = await claimsForToken((await mintChild(L.linkClaims)).token);
    expect(await modelRows(child)).toEqual([]);
    expect(await modelRows(L.linkClaims)).toEqual([]);
    expect(await modelRows(L.human)).toEqual([{ provider: 'anthropic' }]);
  });

  it('DbAgentCredentialHome answers null for a link child, and resolves H', async () => {
    const home = new DbAgentCredentialHome({ db, dataDir });
    const child = await claimsForToken((await mintChild(L.linkClaims)).token);
    expect(await home.resolve(child, { agentTool: 'claude-code', model: 'opus' })).toBeNull();
    expect(await home.resolve(L.human, { agentTool: 'claude-code', model: 'opus' })).not.toBeNull();
  });
});

describe('W7p 206 — a link-bound caller gets the target default only, while its own row allows it', () => {
  let L: Linked;
  beforeAll(async () => { L = await linked(); });

  it('default, own row signed in with spawning allowed: admitted (link session and child)', async () => {
    expect(await read206(L.linkClaims)).toMatchObject({ credentialId: fixture.antDefaultB });
    const child = await claimsForToken((await mintChild(L.linkClaims)).token);
    expect(await read206(child, null, 'github')).toMatchObject({ credentialId: fixture.ghDefaultB });
  });

  it('a pinned id — even the default\'s own id — is 42501; the non-link human may pin it', async () => {
    expect(await outcome(() => read206(L.linkClaims, fixture.antDefaultB))).toBe('42501');
    expect(await read206(L.human, fixture.antDefaultB)).toMatchObject({ credentialId: fixture.antDefaultB });
  });

  it('spawning switched off on the row: 42501; switched back on: admitted', async () => {
    await store.setSpawn(L.human, { linkId: L.link.id, allowSpawn: false });
    try {
      expect(await outcome(() => read206(L.linkClaims))).toBe('42501');
    } finally {
      await store.setSpawn(L.human, { linkId: L.link.id, allowSpawn: true });
    }
    expect(await outcome(() => read206(L.linkClaims))).toBe('ok');
  });

  it('no own row: H3 claiming H\'s link is 42501; H with the same crafted claims is admitted', async () => {
    const crafted = (identityId: string) =>
      ({ identityId, authKind: 'agent', viaLinkId: L.link.id, sessionSpaceId: fixture.spaceB, requestId: `w7p-${randomUUID()}` }) as DbClaims;
    expect(await outcome(() => read206(crafted(fixture.identityH3)))).toBe('42501');
    expect(await outcome(() => read206(crafted(fixture.identityH)))).toBe('ok');
  });
});

// D2: every predicate of 206's link admission, one cell each, each with its
// paired positive on the same caller first. The admission is an EXISTS over
// the caller's own row; a predicate a cell does not reach is a mutant that
// survives (the review's M1 `status = 'signed_in'` and M2 `target_space_id`).
describe('W7p 206 — each predicate of the link admission refuses on its own', () => {
  it("row not signed_in: stale 'unreachable' keeps the link session live, and that session is refused", async () => {
    const L = await linked();
    expect(await outcome(() => read206(L.linkClaims))).toBe('ok');
    await db.rpc(L.human, 'mark_space_link_stale', [L.link.id, 'unreachable']);
    expect((await sessionRow(L.linkSessionId)).revoked).toBe(false);
    expect(await outcome(() => read206(L.linkClaims))).toBe('42501');
  });

  it('wrong launch space: unpinned claims (TM8_SPACE_SESSIONS=off) launching into A, where H is a member, are refused', async () => {
    const L = await linked();
    const unpinned = await claimsForToken(L.linkToken, 'off');
    expect(unpinned.sessionSpaceId).toBeUndefined();
    expect(unpinned.viaLinkId).toBe(L.link.id);
    // A has its own default, so only the target predicate stands between
    // this caller and A's key.
    const antDefaultA = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.space_credentials(id, space_id, provider, shape, label, is_default, key_hint, secret_ciphertext, secret_nonce)
         values ($1, $2, 'anthropic', 'api_key', 'A anthropic', true, 'abcd', decode(repeat('00', 17), 'hex'), decode(repeat('00', 12), 'hex'))`,
        [antDefaultA, fixture.spaceA]);
    });
    try {
      // Paired positive: the same unpinned claims into the link's target.
      expect(await read206(unpinned)).toMatchObject({ credentialId: fixture.antDefaultB });
      // Control: H's own session reads A's default — the refusal is the link's.
      expect(await db.rpc(L.human, 'read_space_credential_for_spawn', [fixture.spaceA, 'anthropic', null]))
        .toMatchObject({ credentialId: antDefaultA });
      expect(await outcome(() => db.rpc(unpinned, 'read_space_credential_for_spawn', [fixture.spaceA, 'anthropic', null])))
        .toBe('42501');
    } finally {
      await database.query(`delete from public.space_credentials where id = $1`, [antDefaultA]);
    }
  });

  it("the linking member no longer active (m.status <> 'active'): refused; active again: admitted", async () => {
    const L = await linked('H3');
    expect(await outcome(() => read206(L.linkClaims))).toBe('ok');
    const setStatus = (status: 'left' | 'active') => database.query(
      `update public.members set status = $2, left_at = case when $2 = 'active' then null else now() end
        where entity_id = (select t.member_id from public.space_link_tokens t
                             join public.members m on m.entity_id = t.member_id
                            where t.link_id = $1 and m.identity_id = $3)`,
      [L.link.id, status, fixture.identityH3]);
    await setStatus('left');
    try {
      expect(await outcome(() => read206(L.linkClaims))).toBe('42501');
    } finally {
      await setStatus('active');
    }
    expect(await outcome(() => read206(L.linkClaims))).toBe('ok');
  });

  it('the link entity soft-deleted (e.deleted_at not null): refused; restored: admitted', async () => {
    const L = await linked();
    expect(await outcome(() => read206(L.linkClaims))).toBe('ok');
    await database.query(`update public.entities set deleted_at = now() where id = $1`, [L.link.id]);
    try {
      expect(await outcome(() => read206(L.linkClaims))).toBe('42501');
    } finally {
      await database.query(`update public.entities set deleted_at = null where id = $1`, [L.link.id]);
    }
    expect(await outcome(() => read206(L.linkClaims))).toBe('ok');
  });
});

// Lead ruling Q-a (A): allow_spawn = false gates EVERY new mint under the
// link — a child's spawn and a resume alike — through 992's live_link_session.
// Nothing already running is ended by it; revoke is what ends sessions. Every
// `linked()` is the same A -> B link entity, so each cell switches it back on.
describe('W7p setSpawn(false) — no new mint under the link; running sessions unaffected', () => {
  const underLink = async (link: string) => Number((await database.query<{ n: string }>(
    `select count(*) as n from public.auth_sessions where via_link_id = $1`, [link]))[0]!.n);

  async function withSpawnOff<T>(L: Linked, run: () => Promise<T>): Promise<T> {
    await store.setSpawn(L.human, { linkId: L.link.id, allowSpawn: false });
    try {
      return await run();
    } finally {
      await store.setSpawn(L.human, { linkId: L.link.id, allowSpawn: true });
    }
  }

  it("(1) a running via_link child's spawn is refused on the mint alone — no 206 read (node model, no git)", async () => {
    const L = await linked();
    const child = await claimsForToken((await mintChild(L.linkClaims)).token);
    // Paired positive: the same child mints a grandchild while spawning is on.
    expect(await outcome(() => mintChild(child))).toBe('ok');
    await withSpawnOff(L, async () => {
      const before = await underLink(L.link.id);
      expect(await outcome(() => mintChild(child))).toBe('42501');
      expect(await underLink(L.link.id)).toBe(before);
    });
  });

  it('(2) a resume of a stopped via_link session is refused while spawning is off', async () => {
    const L = await linked();
    const child = await mintChild(L.linkClaims);
    await database.query(`update public.auth_sessions set revoked_at = now() where id = $1`, [child.id]);
    await withSpawnOff(L, async () => {
      const before = await underLink(L.link.id);
      expect(await outcome(() => mintChild(L.human, { workSessionId: child.workSessionId }))).toBe('42501');
      expect(await underLink(L.link.id)).toBe(before);
    });
  });

  it('(3) a running via_link session is unaffected: its token still resolves and its calls still work', async () => {
    const L = await linked();
    const minted = await mintChild(L.linkClaims);
    await withSpawnOff(L, async () => {
      expect((await sessionRow(minted.id)).revoked).toBe(false);
      expect((await sessionRow(L.linkSessionId)).revoked).toBe(false);
      const child = await claimsForToken(minted.token);
      expect(child.viaLinkId).toBe(L.link.id);
      const rows = await db.query<{ id: string }>(child, `select id::text from public.entities where id = $1`, [minted.workSessionId]);
      expect(rows.map((r) => r.id)).toEqual([minted.workSessionId]);
    });
  });

  it('(4) after setSpawn(true), the same resume succeeds and keeps the link', async () => {
    const L = await linked();
    const child = await mintChild(L.linkClaims);
    await database.query(`update public.auth_sessions set revoked_at = now() where id = $1`, [child.id]);
    await withSpawnOff(L, async () => {
      expect(await outcome(() => mintChild(L.human, { workSessionId: child.workSessionId }))).toBe('42501');
    });
    const resumed = await mintChild(L.human, { workSessionId: child.workSessionId });
    expect((await sessionRow(resumed.id)).via_link_id).toBe(L.link.id);
  });
});

describe('W7p open_space_link_token and mark_space_link_stale — no chaining', () => {
  it('a link child cannot open a link (42501); an ordinary agent child of H opens H\'s row', async () => {
    const L = await linked();
    const child = await claimsForToken((await mintChild(L.linkClaims)).token);
    expect(await outcome(() => db.rpc(child, 'open_space_link_token', [L.link.id]))).toBe('42501');
    // Paired positive: G, H's agent in the HOME space, on the same link.
    const ws = await workSession(fixture.spaceA, fixture.personaA, fixture.memberHA);
    const secret = generateSecret();
    const row = await db.rpc<{ id: string }>(L.human, 'issue_agent_auth_session', [
      ws, fixture.personaA, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'w7p G',
    ]);
    const g = await claimsForToken(formatToken(row.id, secret));
    expect(await outcome(() => db.rpc(g, 'open_space_link_token', [L.link.id]))).toBe('ok');
  });

  it('a link child cannot mark a link stale (42501, row untouched); H\'s ordinary agent child can', async () => {
    const L = await linked();
    const child = await claimsForToken((await mintChild(L.linkClaims)).token);
    for (const status of ['signed_out', 'unreachable']) {
      expect(await outcome(() => db.rpc(child, 'mark_space_link_stale', [L.link.id, status]))).toBe('42501');
    }
    expect((await sessionRow(L.linkSessionId)).revoked).toBe(false);
    const ws = await workSession(fixture.spaceA, fixture.personaA, fixture.memberHA);
    const secret = generateSecret();
    const row = await db.rpc<{ id: string }>(L.human, 'issue_agent_auth_session', [
      ws, fixture.personaA, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'w7p G stale',
    ]);
    const g = await claimsForToken(formatToken(row.id, secret));
    expect(await outcome(() => db.rpc(g, 'mark_space_link_stale', [L.link.id, 'unreachable']))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// End paths: each ends the link's descendants. Every cell mints a child and a
// grandchild, checks them live first (the paired positive), ends the link one
// way, and checks both are revoked and a fresh mint under the link refuses.
// ---------------------------------------------------------------------------

async function family(L: Linked): Promise<string[]> {
  const child = await mintChild(L.linkClaims);
  const grand = await mintChild(await claimsForToken(child.token));
  for (const id of [child.id, grand.id]) expect((await sessionRow(id)).revoked).toBe(false);
  return [child.id, grand.id];
}

async function expectEnded(ids: readonly string[]): Promise<void> {
  for (const id of ids) expect((await sessionRow(id)).revoked, id).toBe(true);
}

describe('W7p end paths — every way a link ends, ends its descendants', () => {
  it('logout', async () => {
    const L = await linked();
    const ids = await family(L);
    await store.logout(L.human, L.link.id);
    await expectEnded(ids);
  });

  it('remove', async () => {
    const L = await linked();
    const ids = await family(L);
    await store.remove(L.human, L.link.id);
    await expectEnded(ids);
  });

  it('relogin (the previous link session is revoked in place)', async () => {
    const L = await linked();
    const ids = await family(L);
    await store.login(L.human, L.link.id, { relogin: true });
    await expectEnded(ids);
    // Paired positive: the new link session mints again.
    const again = await linked();
    expect(await outcome(() => mintChild(again.linkClaims))).toBe('ok');
  });

  it('stale signed_out', async () => {
    const L = await linked();
    const ids = await family(L);
    await db.rpc(L.human, 'mark_space_link_stale', [L.link.id, 'signed_out']);
    await expectEnded(ids);
  });

  it('stale unreachable — the link session stays live, its descendants end (992\'s trigger)', async () => {
    const L = await linked();
    const ids = await family(L);
    await db.rpc(L.human, 'mark_space_link_stale', [L.link.id, 'unreachable']);
    expect((await sessionRow(L.linkSessionId)).revoked).toBe(false);
    await expectEnded(ids);
    // And nothing new mints under a row that is not signed in.
    expect(await outcome(() => mintChild(L.linkClaims))).toBe('42501');
  });

  it('membership end — H4 removed from the HOME space', async () => {
    const L = await linked('H4');
    const ids = await family(L);
    const h = await humanClaims('H');
    await db.rpc(h, 'remove_space_member', [fixture.spaceA, fixture.memberH4A, null]);
    await expectEnded(ids);
  });

  it('expiry — an expired link session mints nothing, not even a resume (children were capped at its expiry above)', async () => {
    const L = await linked();
    const [child] = await family(L);
    await database.query(`update public.auth_sessions set expires_at = now() - interval '1 second' where id = $1`, [L.linkSessionId]);
    const ws = await sessionWs(child!);
    expect(await outcome(() => mintChild(L.human, { workSessionId: ws }))).toBe('42501');
    expect(await outcome(() => mintChild(L.linkClaims))).not.toBe('ok');
  });

  it('hard delete of the link entity removes the link session and every descendant', async () => {
    const L = await linked();
    const ids = await family(L);
    await database.query(`delete from public.entities where id = $1`, [L.link.id]);
    const [row] = await database.query<{ n: number }>(
      `select count(*) as n from public.auth_sessions where id = any($1::uuid[]) and revoked_at is null`,
      [[L.linkSessionId, ...ids]]);
    expect(Number(row!.n)).toBe(0);
  });

  it('membership end — H3 removed from the TARGET space: the link session and every descendant end', async () => {
    const L = await linked('H3');
    const ids = await family(L);
    expect((await sessionRow(L.linkSessionId)).revoked).toBe(false);
    const h = await humanClaims('H');
    await db.rpc(h, 'remove_space_member', [fixture.spaceB, fixture.memberH3B, null]);
    // Two independent paths end it: 251's target trigger revokes the link
    // session (249's cascade then ends its via_link children), and 232's
    // end_membership revokes every session pinned to B for H3's account. Only
    // switching off both lets anything survive.
    await expectEnded([L.linkSessionId, ...ids]);
  });

  it('a resume after the link ended is refused, not silently unlinked', async () => {
    const L = await linked();
    const child = await mintChild(L.linkClaims);
    await store.logout(L.human, L.link.id);
    expect(await outcome(() => mintChild(L.human, { workSessionId: child.workSessionId }))).toBe('42501');
  });
});

async function sessionWs(id: string): Promise<string> {
  const [row] = await database.query<{ ws: string }>(`select work_session_id::text as ws from public.auth_sessions where id = $1`, [id]);
  return row!.ws;
}
