/**
 * W6 — space links (migrations 250/251, plan 01a0d9eb §3 W6). The DB half:
 * the strict-gate caller pin, the sealed token rows (T19 AAD, a5 defaults,
 * a6 no ciphertext anywhere), the use path's kind allow-list, stale handling
 * with no retry, and W1's removal deleting the member's rows (T17). The
 * cross-space matrix cells (T16/T17/T19/T20/T20b/T28) live in
 * cross-space-token.pg.test.ts; this file pins the mechanism under them.
 *
 * Fixture, in cross-space-token's two-space style plus a third space:
 * spaces A (home), B and C (targets). H is an owner of A and B. H3 is a
 * member of A, B and C. H2 is a member of A only. G is H's agent in A.
 *
 * Every refusal is paired with a positive: the same credential on its own
 * row or space succeeds. No token or ciphertext is printed or logged.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthSessionViewSchema } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext, SpaceSessionsMode } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { DbSpaceLinkStore, SpaceLinkUnusable, type SpaceLink, type SpaceLinkStaleNotice } from '../../src/credentials/space-link-store.js';
import { loadOrCreateCredentialKey } from '../../src/credentials/credential-key.js';
import { bindingAad, openSecret, sealSecret } from '../../src/credentials/secret-box.js';
import { RESTRICTED_LIFECYCLE_KINDS, W2EntitiesCommandsTrackingService } from '../../src/facade/services/w2/entities-commands-tracking.js';
import type { ServerConfig } from '../../src/http/config.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { EXEMPT_KEYS, leaksSecret } from './secret-probe.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

// ---------------------------------------------------------------------------
// THE STRICT GATE'S FULL CALLER SET (lead ruling 2026-09-26 02:08Z/02:19Z).
// Measured on this branch: 28 credential management (21 + W10a's
// set_space_credential_visibility, 239 + W10b's six, 255) + 6 non-credential
// + 2 W4 session management (249) + 6 spaceLinks writes = 42. A caller not on
// this list fails; a listed caller
// that stops calling the gate fails. Changing this list is a review event.
// ---------------------------------------------------------------------------
const CREDENTIAL_MANAGEMENT = 'credential management: refuses link (E2)';
const CREDENTIAL_READ = 'credential read, on the gate (refuses link)';
const IDENTITY_WIDE = 'refused for link (identity-wide act)';
const AUTH_MINTING = 'refused for link (decision 31, auth minting)';
const PENDING = 'non-credential, refused pending follow-up 01a0db78-f1ab';
const SESSION_MANAGEMENT = 'session listing/revoke, human-only (W4, 249): refuses link';
const SPACE_LINKS = 'spaceLinks write, human-only by design (W6)';

const STRICT_GATE_CALLERS: Readonly<Record<string, string>> = {
  'claim_space_credential(uuid)': CREDENTIAL_MANAGEMENT, // W10b (255, #869)
  'clear_my_space_credential_default(uuid,text)': CREDENTIAL_MANAGEMENT, // W10b (255, #869)
  // W10b (255, #869) drops the 9-arg overload for this 12-arg one.
  'create_space_credential(uuid,uuid,text,text,text,text,bytea,bytea,text,text,boolean,boolean)': CREDENTIAL_MANAGEMENT,
  'delete_account_agent_credential(text)': CREDENTIAL_MANAGEMENT,
  'delete_account_git_credential(text)': CREDENTIAL_MANAGEMENT,
  'delete_account_service_key(text)': CREDENTIAL_MANAGEMENT,
  'delete_space_credential(uuid)': CREDENTIAL_MANAGEMENT,
  'finish_credential_session(uuid)': CREDENTIAL_MANAGEMENT,
  'finish_space_credential_login(uuid,boolean,text)': CREDENTIAL_MANAGEMENT,
  'member_space_credential_sessions(uuid,uuid)': CREDENTIAL_MANAGEMENT,
  'read_account_service_key(text)': CREDENTIAL_READ,
  'record_space_credential_probe(uuid,boolean)': CREDENTIAL_MANAGEMENT,
  'rekey_space_credential(uuid,text,bytea,bytea,text)': CREDENTIAL_MANAGEMENT,
  'rename_space_credential(uuid,text)': CREDENTIAL_MANAGEMENT,
  'set_account_agent_credential(text,text,text,text)': CREDENTIAL_MANAGEMENT,
  'set_account_git_credential(text,text,bytea,bytea)': CREDENTIAL_MANAGEMENT,
  'set_account_service_key(text,text,bytea,bytea)': CREDENTIAL_MANAGEMENT,
  'set_node_credential_policy(text,boolean)': CREDENTIAL_MANAGEMENT,
  'set_my_space_credential_default(uuid)': CREDENTIAL_MANAGEMENT, // W10b (255, #869)
  'set_space_credential_default(uuid)': CREDENTIAL_MANAGEMENT,
  'set_space_credential_default_consent(uuid,boolean)': CREDENTIAL_MANAGEMENT, // W10b (255, #869)
  'set_space_credential_policy(uuid,text,text[])': CREDENTIAL_MANAGEMENT,
  'set_space_credential_visibility(uuid,text)': CREDENTIAL_MANAGEMENT, // W10a (239, #863)
  'space_credential_foreign_launches(uuid,integer)': CREDENTIAL_READ, // W10b (255, #869)
  'space_credential_live_sessions(uuid)': CREDENTIAL_MANAGEMENT,
  'space_credential_usage(uuid,integer)': CREDENTIAL_READ, // W10b (255, #869)
  'start_credential_session(uuid,text,integer,integer)': CREDENTIAL_MANAGEMENT,
  'start_space_credential_login(uuid,text,text,uuid,integer,integer)': CREDENTIAL_MANAGEMENT,

  // 239 (W10a, #863) renamed the gated body to internal.disable_account_core;
  // public.disable_account wraps it and calls it first, so the gate still runs
  // before anything the wrapper does. The caller is the core.
  'internal.disable_account_core(uuid,text)': IDENTITY_WIDE,
  'issue_agent_runtime_session(uuid,uuid,text,timestamp with time zone,text)': AUTH_MINTING,
  'revoke_agent_runtime_session(uuid)': AUTH_MINTING,
  'leave_space(uuid,text)': PENDING,
  'remove_space_member(uuid,uuid,text)': PENDING,
  'start_chat(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,uuid[],uuid,text)': PENDING,

  // W4 (#857, 249:213/249:262), joined at the re-stack onto main: a link session
  // neither lists nor ends sessions, the same answer an agent gets.
  'list_auth_sessions(uuid)': SESSION_MANAGEMENT,
  'revoke_listed_auth_session(uuid)': SESSION_MANAGEMENT,

  'add_space_link(uuid,uuid,text,text)': SPACE_LINKS,
  'logout_space_link(uuid,text)': SPACE_LINKS,
  'remove_space_link(uuid,text)': SPACE_LINKS,
  'set_space_link_spawn(uuid,boolean,integer,text)': SPACE_LINKS,
  'space_link_seal_context(uuid)': SPACE_LINKS,
  'store_space_link_session(uuid,uuid,text,timestamp with time zone,bytea,bytea,text,text)': SPACE_LINKS,
};

/** Not gate callers: each admits an explicit kind allow-list and 42501s the rest. */
const EXPLICIT_KIND_ALLOW_LIST: Readonly<Record<string, string>> = {
  'open_space_link_token(uuid)': 'explicit kind allow-list, not a gate caller',
  'mark_space_link_stale(uuid,text)': 'explicit kind allow-list, not a gate caller',
};

/**
 * Every function that names the strict gate. Source match is case-insensitive
 * and quote-tolerant (`"internal"."REQUIRE_human_auth_kind"`), and it sees the
 * name inside an `execute format(...)` string too, because it matches the
 * name anywhere in the body. BEGIN ATOMIC bodies have no prosrc to match; they
 * are found through pg_depend on the gate's oid.
 */
const GATE_CALLERS_SQL = `
  with gate as (select 'internal.require_human_auth_kind()'::regprocedure::oid as oid)
  select p.oid::regprocedure::text as signature
    from pg_proc p, gate
   where p.oid <> gate.oid
     and (p.prosrc ~* '"?require_human_auth_kind"?'
          or exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_proc'::regclass and d.refobjid = gate.oid))
   order by p.oid::regprocedure::text collate "C"`; // byte order, the same order as the JS .sort() it is compared with

// ---------------------------------------------------------------------------
// Fixture and credentials.
// ---------------------------------------------------------------------------
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
let fixture: Fixture;
let dataDir: string;
let store: DbSpaceLinkStore;
const staleNotices: SpaceLinkStaleNotice[] = [];

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'space-links-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
} as unknown as LoopbackOwner;

function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind: string | null = 'browser'): Promise<T> {
  return db.tx({ identityId, ...(authKind === null ? {} : { authKind }), requestId: `space-links-${randomUUID()}` } as DbClaims, fn);
}

async function mintBrowser(accountId: string, identityId: string): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'space-links browser',
    ]));
  return formatToken(row.id, secret);
}

async function mintAgent(): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(fixture.identityH, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      fixture.workSessionA, fixture.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'space-links agent G',
    ]));
  return formatToken(row.id, secret);
}

async function claimsForToken(token: string, mode: SpaceSessionsMode = 'agents'): Promise<DbClaims> {
  const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: mode });
  const identity = await resolve(
    { authorization: `Bearer ${token}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true },
  );
  const ctx = { identity, requestId: `space-links-${randomUUID()}` } as unknown as RequestContext;
  return claimsFor(NOT_THE_OWNER, ctx);
}

async function asToken<T>(token: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  return db.tx(await claimsForToken(token), fn);
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

/** Read the sealed columns as the table owner — tm8_app cannot. */
async function sealedRow(linkId: string, memberId: string): Promise<{ id: string; ciphertext: Buffer | null; nonce: Buffer | null; status: string; auth_session_id: string | null }> {
  const [row] = await database.query<{ id: string; ciphertext: Buffer | null; nonce: Buffer | null; status: string; auth_session_id: string | null }>(
    `select id::text, ciphertext, nonce, status, auth_session_id::text
       from public.space_link_tokens where link_id = $1 and member_id = $2`,
    [linkId, memberId]);
  if (!row) throw new Error('no token row');
  return row;
}

async function seed(): Promise<Fixture> {
  const f: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(), spaceC: randomUUID(),
    identityH: `space-links-h-${randomUUID()}`,
    identityH2: `space-links-h2-${randomUUID()}`,
    identityH3: `space-links-h3-${randomUUID()}`,
    accountH: randomUUID(), accountH2: randomUUID(), accountH3: randomUUID(),
    memberHA: randomUUID(), memberHB: randomUUID(), memberH2A: randomUUID(),
    memberH3A: randomUUID(), memberH3B: randomUUID(), memberH3C: randomUUID(),
    personaA: randomUUID(), workSessionA: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2'), ($3, 'H3')`,
      [f.identityH, f.identityH2, f.identityH3]);
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'space-links-h'), ($3, $4, 'space-links-h2'), ($5, $6, 'space-links-h3')`,
      [f.accountH, f.identityH, f.accountH2, f.identityH2, f.accountH3, f.identityH3]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Links A', $4), ($2, 'Links B', $4), ($3, 'Links C', $4)`,
      [f.spaceA, f.spaceB, f.spaceC, f.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [f.memberHA, f.spaceA, f.identityH, 'owner', 'H'],
      [f.memberHB, f.spaceB, f.identityH, 'owner', 'H'],
      [f.memberH2A, f.spaceA, f.identityH2, 'member', 'H2'],
      [f.memberH3A, f.spaceA, f.identityH3, 'member', 'H3'],
      [f.memberH3B, f.spaceB, f.identityH3, 'member', 'H3'],
      [f.memberH3C, f.spaceC, f.identityH3, 'owner', 'H3'],
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
      [f.personaA, f.workSessionA, f.spaceA, f.memberHA]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Links G', 'worker', 'persona')`,
      [f.personaA, f.memberHA]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Links G run', 'running', 'none', now())`,
      [f.workSessionA]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [f.spaceA, f.personaA, f.workSessionA]);
  });
  return f;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_links');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  fixture = await seed();
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-space-links-'));
  store = new DbSpaceLinkStore({ db, dataDir, onStale: (n) => { staleNotices.push(n); } });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

const hClaims = async (): Promise<DbClaims> => claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
const h3Claims = async (): Promise<DbClaims> => claimsForToken(await mintBrowser(fixture.accountH3, fixture.identityH3));

/** H's link A → B, logged in; returns the link and H's link token's claims. */
async function linkAB(): Promise<SpaceLink> {
  const claims = await hClaims();
  const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
  return store.login(claims, link.id);
}

// ---------------------------------------------------------------------------

describe('W6 pin — the STRICT gate\'s full caller set (lead ruling 02:08Z; follow-up 01a0db78-f1ab)', () => {
  it('internal.require_human_auth_kind() is unchanged: browser and cli only, fail-closed', async () => {
    const [row] = await database.query<{ src: string }>(
      `select prosrc as src from pg_proc where oid = 'internal.require_human_auth_kind()'::regprocedure`);
    expect(row!.src).toMatch(/kind is null or kind not in \('browser', 'cli'\)/);
  });

  it('every caller is on the labelled list, and every listed function still calls it', async () => {
    const found = (await database.query<{ signature: string }>(GATE_CALLERS_SQL)).map((r) => r.signature);
    expect(found).toEqual(Object.keys(STRICT_GATE_CALLERS).sort());
  });

  it('the list is 28 credential management + 6 non-credential + 2 session management + 6 spaceLinks writes', () => {
    const labels = Object.values(STRICT_GATE_CALLERS);
    expect(labels.filter((l) => l === CREDENTIAL_MANAGEMENT || l === CREDENTIAL_READ)).toHaveLength(28);
    expect(labels.filter((l) => l === IDENTITY_WIDE || l === AUTH_MINTING || l === PENDING)).toHaveLength(6);
    expect(labels.filter((l) => l === SESSION_MANAGEMENT)).toHaveLength(2);
    expect(labels.filter((l) => l === SPACE_LINKS)).toHaveLength(6);
    expect(labels).toHaveLength(42);
  });

  it('the matcher sees a quoted, mixed-case call and an execute format(...) that names the gate', async () => {
    await database.transaction(async (client) => {
      await client.query(`create function pg_temp.w6_quoted() returns void language plpgsql as
        $$ begin perform "internal"."REQUIRE_HUMAN_AUTH_KIND"(); end $$`);
      await client.query(`create function pg_temp.w6_dynamic() returns void language plpgsql as
        $$ begin execute format('select %s()', 'internal.require_human_auth_kind'); end $$`);
      const rows = await client.query<{ signature: string }>(GATE_CALLERS_SQL);
      const names = rows.rows.map((r) => r.signature);
      expect(names.some((n) => n.includes('w6_quoted'))).toBe(true);
      expect(names.some((n) => n.includes('w6_dynamic'))).toBe(true);
      await client.query('rollback');
      await client.query('begin');
    });
  });

  it('the matcher sees a BEGIN ATOMIC caller through pg_depend', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`create function internal.w6_atomic() returns void language sql
        begin atomic select internal.require_human_auth_kind(); end`);
      const rows = await client.query<{ signature: string }>(GATE_CALLERS_SQL);
      expect(rows.rows.map((r) => r.signature)).toContain('internal.w6_atomic()');
      await client.query('rollback');
      await client.query('begin');
    });
  });

  it('open_space_link_token and mark_space_link_stale: explicit kind allow-list, not gate callers', async () => {
    const found = new Set((await database.query<{ signature: string }>(GATE_CALLERS_SQL)).map((r) => r.signature));
    for (const signature of Object.keys(EXPLICIT_KIND_ALLOW_LIST)) {
      expect(found.has(signature)).toBe(false);
      const [row] = await database.query<{ src: string }>(
        `select prosrc as src from pg_proc where oid = $1::regprocedure`, [`public.${signature}`]);
      expect(row!.src).toContain(`not in ('browser', 'cli', 'agent')`);
    }
  });
});

describe('W6 the kind allow-list on the use path (coordinator 02:11Z)', () => {
  let link: SpaceLink;
  beforeAll(async () => { link = await linkAB(); });

  it('positive — H (browser) opens H\'s own row', async () => {
    const claims = await hClaims();
    expect(await outcome(() => db.rpc(claims, 'open_space_link_token', [link.id]))).toBe('ok');
  });

  it('positive — G (H\'s agent) opens H\'s own row', async () => {
    const token = await mintAgent();
    expect(await outcome(() => asToken(token, (q) => q.rpc('open_space_link_token', [link.id])))).toBe('ok');
  });

  it('G on a link where only ANOTHER member (H3) has a row is refused', async () => {
    const h3 = await h3Claims();
    const other = await store.add(h3, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceC });
    await store.login(h3, other.id);
    const token = await mintAgent();
    expect(await outcome(() => asToken(token, (q) => q.rpc('open_space_link_token', [other.id])))).toBe('P0002');
    expect(await outcome(() => asToken(token, (q) => q.rpc('mark_space_link_stale', [other.id, 'unreachable'])))).toBe('P0002');
    // Paired positive: H3 opens that row.
    expect(await outcome(() => db.rpc(h3, 'open_space_link_token', [other.id]))).toBe('ok');
  });

  for (const kind of ['link', 'agent_runtime', 'w6_unlisted', '', null] as const) {
    it(`kind ${JSON.stringify(kind)} is refused 42501 on open and on mark-stale`, async () => {
      expect(await outcome(() => asIdentity(fixture.identityH, (q) =>
        q.rpc('open_space_link_token', [link.id]), kind))).toBe('42501');
      expect(await outcome(() => asIdentity(fixture.identityH, (q) =>
        q.rpc('mark_space_link_stale', [link.id, 'unreachable']), kind))).toBe('42501');
    });
  }

  it('a real link session is refused 42501 on open', async () => {
    const use = await store.use(await hClaims(), link.id);
    expect(await outcome(() => asToken(use.token, (q) => q.rpc('open_space_link_token', [link.id])))).toBe('42501');
  });
});

describe('W6 a5 — defaults, the link session, no target-consent setting', () => {
  it('a new row has allow_spawn = true and spawn_budget = 3, signed_out until login', async () => {
    const claims = await hClaims();
    const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceC.replace(/.$/, '0') }).catch(() => null);
    expect(link).toBeNull(); // not a member of a made-up target: refused without probing
    const [row] = await database.query<{ allow_spawn: boolean; spawn_budget: number }>(
      `select column_default is not null as d, (select column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'space_link_tokens' and column_name = 'spawn_budget') as spawn_budget,
         (select column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'space_link_tokens' and column_name = 'allow_spawn') as allow_spawn
         from information_schema.columns where table_schema = 'public' and table_name = 'space_link_tokens' limit 1`);
    expect(String(row!.spawn_budget)).toBe('3');
    expect(String(row!.allow_spawn)).toBe('true');
    const h3 = await h3Claims();
    const added = await store.add(h3, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    expect(added.mine).toMatchObject({ status: 'signed_out', allowSpawn: true, spawnBudget: 3 });
  });

  it('login stores a `link` session pinned to the target, 90 days, and list shows no secret', async () => {
    const link = await linkAB();
    expect(link.mine?.status).toBe('signed_in');
    const [session] = await database.query<{ kind: string; space_id: string; days: number }>(
      `select kind, space_id::text, extract(epoch from expires_at - created_at) / 86400 as days
         from public.auth_sessions where id = $1`, [link.mine!.sessionId]);
    expect(session).toMatchObject({ kind: 'link', space_id: fixture.spaceB });
    expect(Number(session!.days)).toBeGreaterThan(89.9);
    expect(Number(session!.days)).toBeLessThanOrEqual(90.01);
    const listed = JSON.stringify(await store.list(await hClaims(), fixture.spaceA));
    expect(leaksSecret(listed)).toBe(false);
  });

  it('the secret probe catches every sealed key name, affixed or bare, and planted tokens (positives)', () => {
    const key = (k: string) => leaksSecret(JSON.stringify({ id: 'x', [k]: 'AAAA' }));
    // bare names and the affixed names the old substring check caught
    for (const k of ['ciphertext', 'nonce', 'aad', 'AAD', 'sealed',
      'secret_ciphertext', 'ciphertext_b64', 'sealed_nonce', 'value_aad',
      // real affixed names on this tree (secret-probe.ts lists file:line)
      'key_ciphertext', 'key_nonce', 'token_ciphertext', 'token_nonce', 'secret_nonce',
      'secretCiphertext', 'secretNonce', 'keyCiphertext', 'keyNonce', 'tokenCiphertext', 'tokenNonce']) {
      expect(key(k), k).toBe(true);
    }
    expect(leaksSecret('{"nonce" : "b"}')).toBe(true);
    expect(leaksSecret(JSON.stringify({ outer: { inner_ciphertext: 'x' } }))).toBe(true);
    expect(leaksSecret(JSON.stringify({ note: 'tm8s_abc.secret' }))).toBe(true);
    expect(leaksSecret(JSON.stringify({ note: 'tm8c_abc.secret' }))).toBe(true);
    expect(leaksSecret(JSON.stringify({ note: 'tm8g_abc' }))).toBe(true);
  });

  it('the secret probe ignores UUID values and non-secret keys (negatives); exemptions are exact-name only', () => {
    // the #885 flake: the hex run "aad" in a VALUE
    expect(leaksSecret(JSON.stringify({ memberId: 'aad52e5a-0c1d-4e6f-9aad-1234567890ab', status: 'signed_in' }))).toBe(false);
    // a word in a value is not a key
    expect(leaksSecret(JSON.stringify({ note: 'rotate the ciphertext and nonce' }))).toBe(false);
    // "announce" does not contain "nonce" — no exemption needed
    expect(leaksSecret(JSON.stringify({ announceUrl: 'u', announced: true }))).toBe(false);
    // the shipped exemption set is empty: no real list key needs one
    expect(EXEMPT_KEYS.size).toBe(0);
    // the mechanism: an exempted EXACT name passes; any near-miss of it still trips
    const exempt = new Set(['hasCiphertext']);
    expect(leaksSecret(JSON.stringify({ hasCiphertext: false }), exempt)).toBe(false);
    expect(leaksSecret(JSON.stringify({ hasCiphertext: false }))).toBe(true);
    for (const near of ['hasciphertext', 'HasCiphertext', 'hasCiphertexts', 'has_ciphertext', 'hasCiphertext_b64']) {
      expect(leaksSecret(JSON.stringify({ [near]: false }), exempt), near).toBe(true);
    }
  });

  it('no allow_stored_sessions exists anywhere (decision 33)', async () => {
    const [row] = await database.query<{ n: number }>(
      `select (select count(*) from information_schema.columns where column_name ilike '%allow_stored_session%')
            + (select count(*) from pg_proc where prosrc ilike '%allow_stored_session%' or proname ilike '%allow_stored_session%') as n`);
    expect(Number(row!.n)).toBe(0);
  });

  it('spaceLinks.setSpawn changes the caller\'s own switch and budget', async () => {
    const link = await linkAB();
    const claims = await hClaims();
    const set = await store.setSpawn(claims, { linkId: link.id, allowSpawn: false, spawnBudget: 1 });
    expect(set.mine).toMatchObject({ allowSpawn: false, spawnBudget: 1 });
    const back = await store.setSpawn(claims, { linkId: link.id, allowSpawn: true, spawnBudget: 3 });
    expect(back.mine).toMatchObject({ allowSpawn: true, spawnBudget: 3 });
  });
});

describe('W6 RLS and grants — the row\'s member only, no ciphertext column for tm8_app', () => {
  it('tm8_app cannot select ciphertext or nonce (42501)', async () => {
    expect(await outcome(() => asIdentity(fixture.identityH, (q) =>
      q.query('select ciphertext from public.space_link_tokens')))).toBe('42501');
    expect(await outcome(() => asIdentity(fixture.identityH, (q) =>
      q.query('select nonce from public.space_link_tokens')))).toBe('42501');
  });

  it('positive — the metadata columns are readable, and only the caller\'s own rows', async () => {
    await linkAB();
    const h3 = await h3Claims();
    await store.add(h3, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    const mine = await asIdentity(fixture.identityH, (q) =>
      q.query<{ member_id: string }>('select member_id::text from public.space_link_tokens'));
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((r) => r.member_id))).toEqual(new Set([fixture.memberHA]));
  });

  it('a node admin sees no other member\'s row (no node-admin bypass)', async () => {
    const rows = await db.tx({ identityId: fixture.identityH2, authKind: 'browser', nodeAdmin: true, requestId: `space-links-${randomUUID()}` } as DbClaims,
      (q) => q.query('select id from public.space_link_tokens'));
    expect(rows).toHaveLength(0);
  });

  it('tm8_app has no insert, update or delete on the table', async () => {
    const [row] = await database.query<{ n: number }>(
      `select count(*) as n from information_schema.role_table_grants
        where table_name = 'space_link_tokens' and grantee = 'tm8_app' and privilege_type <> 'SELECT'`);
    expect(Number(row!.n)).toBe(0);
  });
});

describe('W6 a1 / T19 — AAD home|link|member|target', () => {
  it('the stored ciphertext opens under its own row\'s binding (positive)', async () => {
    const link = await linkAB();
    const row = await sealedRow(link.id, fixture.memberHA);
    const key = await loadOrCreateCredentialKey(dataDir);
    const token = openSecret(key, { ciphertext: row.ciphertext!, nonce: row.nonce! },
      { homeSpaceId: fixture.spaceA, linkId: link.id, memberId: fixture.memberHA, targetSpaceId: fixture.spaceB });
    expect(token.startsWith('tm8s_')).toBe(true);
  });

  it('copied to another member\'s row, another link or another target, it does not open', async () => {
    const link = await linkAB();
    const row = await sealedRow(link.id, fixture.memberHA);
    const key = await loadOrCreateCredentialKey(dataDir);
    const sealed = { ciphertext: row.ciphertext!, nonce: row.nonce! };
    const base = { homeSpaceId: fixture.spaceA, linkId: link.id, memberId: fixture.memberHA, targetSpaceId: fixture.spaceB };
    expect(() => openSecret(key, sealed, { ...base, memberId: fixture.memberH3A })).toThrow();
    expect(() => openSecret(key, sealed, { ...base, linkId: randomUUID() })).toThrow();
    expect(() => openSecret(key, sealed, { ...base, targetSpaceId: fixture.spaceC })).toThrow();
    expect(() => openSecret(key, sealed, { ...base, homeSpaceId: fixture.spaceC })).toThrow();
    // The space-credential form cannot open it either.
    expect(() => openSecret(key, sealed, { spaceId: fixture.spaceA, credentialId: link.id, provider: 'anthropic' })).toThrow();
  });

  it('the use path refuses a ciphertext pasted into another member\'s row (unreadable), and H3\'s own still opens', async () => {
    const link = await linkAB();
    const h3 = await h3Claims();
    await store.add(h3, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    await store.login(h3, link.id);
    const h3Row = await sealedRow(link.id, fixture.memberH3A);
    const hRow = await sealedRow(link.id, fixture.memberHA);
    expect((await store.use(h3, link.id)).session.identityId).toBe(fixture.identityH3);
    await database.query(
      `update public.space_link_tokens set ciphertext = $1, nonce = $2 where id = $3`,
      [hRow.ciphertext, hRow.nonce, h3Row.id]);
    await expect(store.use(h3, link.id)).rejects.toMatchObject({ status: 'unreadable' });
    // Restore H3 with a fresh login (relogin in place).
    await store.login(h3, link.id, { relogin: true });
    expect((await store.use(h3, link.id)).session.identityId).toBe(fixture.identityH3);
  });

  it('the aad column is held to the row by a CHECK', async () => {
    const link = await linkAB();
    expect(await outcome(() => database.query(
      `update public.space_link_tokens set aad = 'x' where link_id = $1 and member_id = $2`,
      [link.id, fixture.memberHA]))).toBe('23514');
  });
});

describe('W6 a6 — no ciphertext or token in entity_versions, the command ledger or any list', () => {
  it('after add + login + relogin with client mutation ids, nothing carries the sealed bytes or the token', async () => {
    const claims = await hClaims();
    const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB, clientMutationId: `w6-a6-add-${randomUUID()}` });
    await store.login(claims, link.id, { clientMutationId: `w6-a6-login-${randomUUID()}` });
    await store.login(claims, link.id, { relogin: true, clientMutationId: `w6-a6-relogin-${randomUUID()}` });
    const row = await sealedRow(link.id, fixture.memberHA);
    const use = await store.use(claims, link.id);
    const needles = [
      row.ciphertext!.toString('base64'),
      row.ciphertext!.toString('hex'),
      use.token,
      use.token.split('.')[1]!,
    ];
    const [hits] = await database.query<{ n: number }>(
      `select (select count(*) from public.entity_versions v, unnest($1::text[]) k where position(k in v.snapshot::text) > 0)
            + (select count(*) from public.command_ledger c, unnest($1::text[]) k where position(k in coalesce(c.result::text, '')) > 0)
            + (select count(*) from public.activity_log a, unnest($1::text[]) k where position(k in a::text) > 0) as n`,
      [needles]).catch(async () => database.query<{ n: number }>(
      `select (select count(*) from public.entity_versions v, unnest($1::text[]) k where position(k in v.snapshot::text) > 0)
            + (select count(*) from public.command_ledger c, unnest($1::text[]) k where position(k in coalesce(c.result::text, '')) > 0) as n`,
      [needles]));
    expect(Number(hits!.n)).toBe(0);
    const listed = JSON.stringify(await store.list(claims, fixture.spaceA));
    for (const needle of needles) expect(listed.includes(needle)).toBe(false);
    // The ledger DID record the three commands (so the search above had rows to search).
    const [ledger] = await database.query<{ n: number }>(
      `select count(*) as n from public.command_ledger where operation in ('spaceLinks.add', 'spaceLinks.login', 'spaceLinks.relogin') and client_mutation_id like 'w6-a6-%'`);
    expect(Number(ledger!.n)).toBe(3);
  });
});

describe('W6 stale — a 401 turns the link signed_out, no retry, attention for the member', () => {
  it('a revoked link session: use marks signed_out, forgets the bytes, raises attention, tells the caller once', async () => {
    const link = await linkAB();
    const claims = await hClaims();
    // B revokes the stored session (the W4 Sessions page path on this base: revoke_auth_session as its owner).
    await db.rpc(claims, 'revoke_auth_session', [link.mine!.sessionId]);
    staleNotices.length = 0;
    await expect(store.use(claims, link.id, { workSessionId: fixture.workSessionA }))
      .rejects.toMatchObject({ status: 'signed_out' });
    const row = await sealedRow(link.id, fixture.memberHA);
    expect(row).toMatchObject({ status: 'signed_out', ciphertext: null, nonce: null, auth_session_id: null });
    const [attention] = await database.query<{ n: number; by: string }>(
      `select count(*) as n, max(requested_by::text) as by from public.attention_requests where entity_id = $1 and status = 'open'`, [link.id]);
    expect(Number(attention!.n)).toBe(1);
    expect(attention!.by).toBe(fixture.memberHA);
    expect(staleNotices).toEqual([{ linkId: link.id, status: 'signed_out', callerWorkSessionId: fixture.workSessionA }]);
    // No retry: the next use is refused in SQL and does not resolve or notify again.
    await expect(store.use(claims, link.id)).rejects.toBeInstanceOf(SpaceLinkUnusable);
    expect(staleNotices).toHaveLength(1);
    // Paired positive: relogin brings it back.
    await store.login(claims, link.id, { relogin: true });
    expect((await store.use(claims, link.id)).targetSpaceId).toBe(fixture.spaceB);
  });

  it('relogin revokes the previous session in place', async () => {
    const link = await linkAB();
    const claims = await hClaims();
    const before = link.mine!.sessionId!;
    const after = (await store.login(claims, link.id, { relogin: true })).mine!.sessionId!;
    expect(after).not.toBe(before);
    const rows = await database.query<{ id: string; revoked: boolean }>(
      `select id::text, revoked_at is not null as revoked from public.auth_sessions where id = any($1::uuid[])`, [[before, after]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.revoked]))).toEqual({ [before]: true, [after]: false });
  });

  it('logout revokes the session and forgets the bytes', async () => {
    const link = await linkAB();
    const claims = await hClaims();
    const session = link.mine!.sessionId!;
    const out = await store.logout(claims, link.id);
    expect(out.mine).toMatchObject({ status: 'signed_out', sessionId: null });
    const [row] = await database.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from public.auth_sessions where id = $1`, [session]);
    expect(row!.revoked).toBe(true);
    expect((await sealedRow(link.id, fixture.memberHA)).ciphertext).toBeNull();
    await store.login(claims, link.id);
  });
});

describe('W6 human-only management (strict gate)', () => {
  it('G (agent) is refused 42501 on add / login / logout / remove / setSpawn; list is admitted', async () => {
    const link = await linkAB();
    const token = await mintAgent();
    const g = await claimsForToken(token);
    expect(await outcome(() => store.add(g, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB }))).toBe('42501');
    expect(await outcome(() => store.login(g, link.id))).toBe('42501');
    expect(await outcome(() => store.logout(g, link.id))).toBe('42501');
    expect(await outcome(() => store.remove(g, link.id))).toBe('42501');
    expect(await outcome(() => store.setSpawn(g, { linkId: link.id, allowSpawn: false }))).toBe('42501');
    expect(await outcome(() => store.list(g, fixture.spaceA))).toBe('ok');
  });

  it('positive — H (browser) does each of them', async () => {
    const claims = await hClaims();
    const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    expect(await outcome(() => store.login(claims, link.id, { relogin: true }))).toBe('ok');
    expect(await outcome(() => store.setSpawn(claims, { linkId: link.id, allowSpawn: true }))).toBe('ok');
    expect(await outcome(() => store.logout(claims, link.id))).toBe('ok');
    expect(await outcome(() => store.login(claims, link.id))).toBe('ok');
  });
});

describe('W6 T17 — leaving or being removed ends the member\'s rows', () => {
  it('H3 removed from the HOME space: H3\'s rows are deleted and their sessions revoked; H\'s stay', async () => {
    const link = await linkAB();
    const h3 = await h3Claims();
    await store.add(h3, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    const h3Link = await store.login(h3, link.id);
    const h3Session = h3Link.mine!.sessionId!;
    const claims = await hClaims();
    await db.rpc(claims, 'remove_space_member', [fixture.spaceA, fixture.memberH3A, null]);
    const [rows] = await database.query<{ n: number }>(
      `select count(*) as n from public.space_link_tokens where member_id = $1`, [fixture.memberH3A]);
    expect(Number(rows!.n)).toBe(0);
    const [session] = await database.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from public.auth_sessions where id = $1`, [h3Session]);
    expect(session!.revoked).toBe(true);
    // Paired positive: H's own row on the same link is untouched and usable.
    expect((await store.use(claims, link.id)).session.identityId).toBe(fixture.identityH);
  });

  it('H leaves the TARGET: H\'s row turns left, bytes forgotten, session revoked, attention raised', async () => {
    // A fresh target D where H is a member, so leaving it does not disturb B.
    const spaceD = randomUUID();
    const memberHD = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Links D', $2)`, [spaceD, fixture.identityH]);
      await client.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [memberHD, spaceD]);
      await client.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', 'H')`, [memberHD, spaceD, fixture.identityH]);
    });
    const claims = await hClaims();
    const added = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: spaceD });
    const link = await store.login(claims, added.id);
    await db.rpc(claims, 'leave_space', [spaceD, null]);
    const row = await sealedRow(link.id, fixture.memberHA);
    // auth_session_id cleared too: the first cut of the trigger left it set (caught by T17 in cross-space-token).
    expect(row).toMatchObject({ status: 'left', ciphertext: null, nonce: null, auth_session_id: null });
    const [session] = await database.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from public.auth_sessions where id = $1`, [link.mine!.sessionId]);
    expect(session!.revoked).toBe(true);
    const [attention] = await database.query<{ n: number }>(
      `select count(*) as n from public.attention_requests where entity_id = $1 and status = 'open'`, [link.id]);
    expect(Number(attention!.n)).toBe(1);
    await expect(store.use(claims, link.id)).rejects.toMatchObject({ status: 'left' });
    // Paired positive: H's link to B is still usable.
    const ab = await linkAB();
    expect((await store.use(claims, ab.id)).targetSpaceId).toBe(fixture.spaceB);
  });
});

// Keeps sealSecret referenced for readers checking what a1 exercises.
void sealSecret;

async function resolveToken(token: string): Promise<{ authKind?: string; sessionSpaceId?: string; sessionId?: string }> {
  const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
  return resolve({ authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true }) as never;
}

describe('W6 kind `link` — the resolver, the session view, revoke', () => {
  it('a stored link token resolves as authKind `link`, pinned to the target space', async () => {
    const link = await linkAB();
    const use = await store.use(await hClaims(), link.id);
    const identity = await resolveToken(use.token);
    expect(identity).toMatchObject({ authKind: 'link', sessionSpaceId: fixture.spaceB, sessionId: link.mine!.sessionId });
  });

  it('positive — the session view accepts kind `link`; an unknown kind is refused', () => {
    const view = { sessionId: randomUUID(), actingAsTeamMemberId: null, label: 'Space link from Links A', expiresAt: new Date().toISOString() };
    expect(AuthSessionViewSchema.safeParse({ ...view, kind: 'link' }).success).toBe(true);
    expect(AuthSessionViewSchema.safeParse({ ...view, kind: 'linked' }).success).toBe(false);
  });

  it('the row shape forbids a persona, work session or runtime on a link session (23514); positive without', async () => {
    const link = await linkAB();
    expect(await outcome(() => database.query(
      `update public.auth_sessions set work_session_id = $2 where id = $1`, [link.mine!.sessionId, fixture.workSessionA]))).toBe('23514');
    const [row] = await database.query<{ kind: string; ws: string | null }>(
      `select kind, work_session_id::text as ws from public.auth_sessions where id = $1`, [link.mine!.sessionId]);
    expect(row).toEqual({ kind: 'link', ws: null });
  });
});

// SECURITY CHOICE (PR #864): a link session is inserted with no parent session
// (251's login insert), so revoking the browser session that performed the
// login does not end it. Only logout / relogin / remove / leaving / W1 removal
// (the five P7 paths) and a direct revoke end it.
describe('W6 no cascade — a link session outlives the browser session that minted it', () => {
  it('revoking the minting browser session leaves the link session live and usable', async () => {
    const browserToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const claims = await claimsForToken(browserToken);
    const link = await store.login(claims, (await linkAB()).id, { relogin: true });
    const browserSessionId = (await resolveToken(browserToken)).sessionId!;
    await db.rpc(claims, 'revoke_auth_session', [browserSessionId]);
    await expect(resolveToken(browserToken)).rejects.toBeTruthy();
    const use = await store.use(await hClaims(), link.id);
    expect((await resolveToken(use.token)).authKind).toBe('link');
    const [row] = await database.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from public.auth_sessions where id = $1`, [link.mine!.sessionId]);
    expect(row!.revoked).toBe(false);
  });

  it('positive — revoking the link session itself ends it: the resolver refuses it and use turns the link signed_out', async () => {
    const link = await linkAB();
    const claims = await hClaims();
    const use = await store.use(claims, link.id);
    await db.rpc(claims, 'revoke_auth_session', [link.mine!.sessionId]);
    await expect(resolveToken(use.token)).rejects.toBeTruthy();
    await expect(store.use(claims, link.id)).rejects.toMatchObject({ status: 'signed_out' });
    await store.login(claims, link.id, { relogin: true });
  });
});

// W4 (#857, 249) joined at the re-stack onto main. auth.sessions.list/revoke are
// human-only (249:221, 249:274): a link session neither lists nor ends
// sessions. The member's browser sees the link row (kind and origin `link`,
// no token) and can end it; that is the "direct revoke" the no-cascade choice
// above relies on.
describe('W6 × W4 — session listing and revoke meet a link session', () => {
  it('a link session is REFUSED list_auth_sessions and revoke_listed_auth_session (42501)', async () => {
    const link = await linkAB();
    const use = await store.use(await hClaims(), link.id);
    expect(await outcome(() => asToken(use.token, (q) => q.rpc('list_auth_sessions', [null])))).toBe('42501');
    expect(await outcome(() => asToken(use.token, (q) => q.rpc('list_auth_sessions', [fixture.spaceB])))).toBe('42501');
    expect(await outcome(() => asToken(use.token, (q) =>
      q.rpc('revoke_listed_auth_session', [link.mine!.sessionId])))).toBe('42501');
    // The refused revoke ended nothing: the link still resolves.
    expect((await resolveToken(use.token)).authKind).toBe('link');
  });

  it('positive — the member\'s browser lists the link session (kind/origin `link`, no secret) and revoking it ends the link', async () => {
    const link = await linkAB();
    const linkSessionId = link.mine!.sessionId;
    const browserToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const listed = await asToken(browserToken, (q) => q.rpc<unknown>('list_auth_sessions', [null]));
    const rows = listed as Array<{ sessionId: string; kind: string; origin: string; spaceId: string | null }>;
    expect(rows.find((r) => r.sessionId === linkSessionId)).toMatchObject({ kind: 'link', origin: 'link', spaceId: fixture.spaceB });
    expect(leaksSecret(JSON.stringify(listed))).toBe(false);
    expect(JSON.stringify(listed)).not.toContain('token_hash');

    const ended = await asToken(browserToken, (q) =>
      q.rpc<{ revoked: boolean; revokedSessionIds: string[] }>('revoke_listed_auth_session', [linkSessionId]));
    expect(ended).toMatchObject({ revoked: true, revokedSessionIds: [linkSessionId] });
    const claims = await hClaims();
    await expect(store.use(claims, link.id)).rejects.toMatchObject({ status: 'signed_out' });
    await store.login(claims, link.id, { relogin: true });
  });

  // Q3 (lead default-accept): with no cascade from browser logout, B's admins
  // still end a link session from B's Sessions page (249:238 lists a space's
  // pinned sessions for its admin; 249:287 lets that admin revoke one).
  it('positive — B\'s admin (H3, not the holder) lists H\'s A → B link session and revokes it; a non-member of B cannot', async () => {
    const link = await linkAB();
    const hSession = link.mine!.sessionId!;
    const setH3RoleInB = (role: string) => database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.members set role = $2 where entity_id = $1', [fixture.memberH3B, role]);
    });
    await setH3RoleInB('admin');
    try {
      const adminToken = await mintBrowser(fixture.accountH3, fixture.identityH3);
      const h2Token = await mintBrowser(fixture.accountH2, fixture.identityH2);
      // Refused: H2 is not a member of B, so B's sessions are not H2's to list or end.
      expect(await outcome(() => asToken(h2Token, (q) => q.rpc('list_auth_sessions', [fixture.spaceB])))).toBe('42501');
      expect(await outcome(() => asToken(h2Token, (q) => q.rpc('revoke_listed_auth_session', [hSession])))).toBe('P0002');
      expect((await store.use(await hClaims(), link.id)).token).toEqual(expect.any(String));

      const listed = await asToken(adminToken, (q) => q.rpc<unknown>('list_auth_sessions', [fixture.spaceB]));
      const rows = listed as Array<{ sessionId: string; kind: string; spaceId: string | null }>;
      expect(rows.find((r) => r.sessionId === hSession)).toMatchObject({ kind: 'link', spaceId: fixture.spaceB });
      expect(leaksSecret(JSON.stringify(listed))).toBe(false);
      const ended = await asToken(adminToken, (q) =>
        q.rpc<{ revoked: boolean; revokedSessionIds: string[] }>('revoke_listed_auth_session', [hSession]));
      expect(ended).toMatchObject({ revoked: true, revokedSessionIds: [hSession] });
      const claims = await hClaims();
      await expect(store.use(claims, link.id)).rejects.toMatchObject({ status: 'signed_out' });
      await store.login(claims, link.id, { relogin: true });
    } finally {
      await setH3RoleInB('member');
    }
  });
});

// identity_id() gate (tools/ci/identity-id-gate.sh): add_space_link and
// space_link_json read the caller's TARGET membership through is_space_member,
// so the 227 session pin holds. Design: a link is created and signed in from an
// UNPINNED human session (the gate browser session issue_auth_session mints, or
// cli) — the only session that is a member of both sides at once, and the same
// rule store_space_link_session already applied to login. A session pinned to
// either space reaches only that space: pinned to the home it can list the
// home's links but not name, add or sign in to the target; pinned to the target
// it cannot create, read or act on the home's links. H is still an active member
// of A and B at this point in the file (H3 was removed from A above).
describe('W6 pin — link creation needs an unpinned human session; a pinned one reaches only its own space', () => {
  it('positive — unpinned: H adds A → B, signs in, and list names the target', async () => {
    const unpinned = await hClaims();
    const added = await store.add(unpinned, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    expect(added.targetSpaceName).toEqual(expect.any(String));
    const signedIn = await store.login(unpinned, added.id, { relogin: added.mine?.status !== 'signed_out' });
    expect(signedIn.mine).toMatchObject({ status: 'signed_in' });
    const listed = (await store.list(unpinned, fixture.spaceA)).find((l) => l.id === added.id);
    expect(listed!.targetSpaceName).toBe(added.targetSpaceName);
  });

  it('pinned to the home A: add A → B is refused as not found, login is refused, list works without the target name', async () => {
    const link = await store.add(await hClaims(), { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    const pinnedA: DbClaims = { ...(await hClaims()), sessionSpaceId: fixture.spaceA };
    expect(await outcome(() => store.add(pinnedA, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB }))).toBe('P0002');
    expect(await outcome(() => store.login(pinnedA, link.id, { relogin: true }))).toBe('42501');
    const listed = (await store.list(pinnedA, fixture.spaceA)).find((l) => l.id === link.id);
    expect(listed).toBeDefined();
    expect(listed!.targetSpaceName).toBeNull();
  });

  it('pinned to the target B: cannot create, read or act on A\'s links', async () => {
    const link = await store.add(await hClaims(), { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    const pinnedB: DbClaims = { ...(await hClaims()), sessionSpaceId: fixture.spaceB };
    const refusals = {
      add: await outcome(() => store.add(pinnedB, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB })),
      list: await outcome(() => store.list(pinnedB, fixture.spaceA)),
      login: await outcome(() => store.login(pinnedB, link.id, { relogin: true })),
      logout: await outcome(() => db.rpc(pinnedB, 'logout_space_link', [link.id])),
      setSpawn: await outcome(() => db.rpc(pinnedB, 'set_space_link_spawn', [link.id, false, 1])),
      remove: await outcome(() => db.rpc(pinnedB, 'remove_space_link', [link.id])),
      open: await outcome(() => db.rpc(pinnedB, 'open_space_link_token', [link.id])),
    };
    expect(refusals).toEqual({
      add: '42501', list: '42501', login: 'P0002', logout: 'P0002', setSpawn: 'P0002', remove: 'P0002', open: 'P0002',
    });
    // Paired positive: the link is untouched and the unpinned session still reads it.
    const after = (await store.list(await hClaims(), fixture.spaceA)).find((l) => l.id === link.id);
    expect(after).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Review D1: a link's lifecycle is command-owned. The generic doors refuse it
// in BOTH layers — the facade (RESTRICTED_LIFECYCLE_KINDS, `forbidden`, before
// SQL) and SQL (251 §10b trigger, 42501, whatever the caller) — and a deleted
// link is dead to every link op. Paired positive: spaceLinks.remove works.
// ---------------------------------------------------------------------------

describe('W6 D1 — the generic entity doors refuse a space_link; spaceLinks.* still work', () => {
  const facade = () => new W2EntitiesCommandsTrackingService({
    db, config: {} as ServerConfig, owner: async () => NOT_THE_OWNER,
  });
  async function facadeCtx(params: Record<string, string>, body: unknown): Promise<RequestContext> {
    const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const identity = await resolve({ authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true });
    return {
      identity, requestId: `space-links-${randomUUID()}`, params, query: new URLSearchParams(), body,
      headers: {}, method: 'POST', path: '/test',
    } as unknown as RequestContext;
  }
  const versionOf = async (id: string) =>
    (await database.query<{ version: number }>('select version from public.entities where id = $1', [id]))[0]!.version;
  /** Soft-delete or undelete as the superuser, past every trigger: the state the doors must never reach. */
  async function forceDeletedAt(id: string, deleted: boolean): Promise<void> {
    await database.query(`set session_replication_role = replica;
      update public.entities set deleted_at = ${deleted ? 'now()' : 'null'} where id = '${id}';
      set session_replication_role = origin;`);
  }

  let linkId: string;
  beforeAll(async () => {
    const claims = await hClaims();
    const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    linkId = link.id;
    if (link.mine?.status !== 'signed_in') await store.login(claims, link.id);
  });

  it('facade: entities.delete / move / restore / patch / create of a space_link are forbidden before SQL', async () => {
    const s = facade();
    expect(await outcome(async () => s.deleteEntity(await facadeCtx({ id: linkId }, {})))).toBe('forbidden');
    expect(await outcome(async () => s.moveEntity(await facadeCtx({ id: linkId },
      { parentId: null, position: 424242.5, expectedVersion: await versionOf(linkId) })))).toBe('forbidden');
    expect(await outcome(async () => s.restoreEntity(await facadeCtx({ id: linkId }, {})))).toBe('forbidden');
    expect(await outcome(async () => s.patchEntity(await facadeCtx({ id: linkId },
      { title: 'renamed', expectedVersion: await versionOf(linkId) })))).toBe('forbidden');
    expect(await outcome(async () => s.createEntity(await facadeCtx({},
      { spaceId: fixture.spaceA, kind: 'space_link', title: 'forged', clientMutationId: randomUUID() })))).toBe('forbidden');
    expect(await versionOf(linkId)).toBeGreaterThan(0);
  });

  it('RPC: delete_entity / move_entity = 42501; the patch and create doors refuse the kind', async () => {
    const claims = await hClaims();
    expect({
      delete: await outcome(() => db.rpc(claims, 'delete_entity', [linkId, null, null])),
      // A real move (a new position); a no-op move changes no lifecycle column.
      move: await outcome(async () => db.rpc(claims, 'move_entity',
        [linkId, null, 424242.5, await versionOf(linkId), null, null])),
      patch: await outcome(async () => db.rpc(claims, 'update_custom_entity',
        [linkId, await versionOf(linkId), 'renamed', null, null, null])),
      create: await outcome(() => db.rpc(claims, 'create_custom_entity',
        [fixture.spaceA, 'space_link', 'forged', null, '{}', null, null, null])),
    }).toEqual({ delete: '42501', move: '42501', patch: '22023', create: '22023' });
    const [row] = await database.query<{ deleted_at: string | null }>('select deleted_at from public.entities where id = $1', [linkId]);
    expect(row!.deleted_at).toBeNull();
  });

  it('RPC: restore_entity of a (forced) deleted link = 42501, and a deleted link is dead to every link op', async () => {
    const claims = await hClaims();
    await forceDeletedAt(linkId, true);
    try {
      expect(await outcome(() => db.rpc(claims, 'restore_entity', [linkId, null, null]))).toBe('42501');
      expect(await outcome(() => db.rpc(claims, 'open_space_link_token', [linkId]))).toBe('P0002');
      expect(await outcome(() => store.use(claims, linkId))).toBe('P0002');
      expect(await outcome(() => store.logout(claims, linkId))).toBe('P0002');
      expect(await outcome(() => store.login(claims, linkId))).toBe('P0002');
    } finally {
      await forceDeletedAt(linkId, false);
    }
    // Paired positive: undeleted, the same link opens again.
    expect((await store.use(claims, linkId)).linkId).toBe(linkId);
  });

  it('positive — spaceLinks.remove still ends the member\'s link (P7 path 3)', async () => {
    const claims = await hClaims();
    const removed = await store.remove(claims, linkId);
    expect(removed.id).toBe(linkId);
    expect(await outcome(() => store.use(claims, linkId))).toBe('P0002');
  });
});

describe('W6 D2 — a database failure while resolving a link session is NOT signed_out', () => {
  it('a rejecting claim-free resolve propagates its error and leaves the link signed_in; a dead token still marks it', async () => {
    const claims = await hClaims();
    const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    const live = link.mine?.status === 'signed_in' ? link : await store.login(claims, link.id);
    const poolTimeout = new Error('timeout exceeded when trying to connect');
    // resolveBearerIdentity's read is the one claim-free tx; every other call passes through.
    const flaky: Db = {
      tx: ((c: DbClaims, fn: (q: Querier) => Promise<unknown>) =>
        Object.keys(c).length === 0 ? Promise.reject(poolTimeout) : db.tx(c, fn)) as Db['tx'],
      rpc: db.rpc.bind(db),
      query: db.query.bind(db),
      end: async () => {},
    };
    const flakyStore = new DbSpaceLinkStore({ db: flaky, dataDir, onStale: (n) => { staleNotices.push(n); } });
    const before = staleNotices.length;
    await expect(flakyStore.use(claims, live.id)).rejects.toBe(poolTimeout);
    expect((await store.list(claims, fixture.spaceA)).find((l) => l.id === live.id)?.mine?.status).toBe('signed_in');
    expect(staleNotices.length).toBe(before);
    // Paired positive: the real store still resolves it.
    expect((await store.use(claims, live.id)).linkId).toBe(live.id);

    // And a DEAD token (its session revoked) still marks the link signed_out.
    const sessionId = (await store.list(claims, fixture.spaceA)).find((l) => l.id === live.id)!.mine!.sessionId!;
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.auth_sessions set revoked_at = now() where id = $1', [sessionId]);
    });
    await expect(store.use(claims, live.id)).rejects.toMatchObject({ status: 'signed_out' });
    expect(staleNotices.slice(before)).toEqual([expect.objectContaining({ linkId: live.id, status: 'signed_out' })]);
    expect((await store.list(claims, fixture.spaceA)).find((l) => l.id === live.id)?.mine?.status).toBe('signed_out');
    await store.login(claims, live.id, { relogin: true });
  });
});

describe('W6 (b) — the AAD domain separation holds: no sealed provider carries "|"', () => {
  it('every table with a sealed column pins its provider to a closed, "|"-free list', async () => {
    const sealed = await database.query<{ table_name: string; has_provider: boolean }>(`
      select c.table_name,
             exists (select 1 from information_schema.columns p
                      where p.table_schema = 'public' and p.table_name = c.table_name and p.column_name = 'provider') as has_provider
        from information_schema.columns c
       where c.table_schema = 'public' and c.column_name like '%ciphertext' and c.data_type = 'bytea'
       group by c.table_name order by c.table_name`);
    expect(sealed.map((t) => t.table_name)).toContain('space_link_tokens');
    for (const t of sealed.filter((x) => x.has_provider)) {
      const checks = await database.query<{ def: string }>(`
        select pg_get_constraintdef(k.oid) as def from pg_constraint k
         where k.conrelid = ('public.' || $1)::regclass and k.contype = 'c'
           and pg_get_constraintdef(k.oid) ~ '\\mprovider\\M'`, [t.table_name]);
      const literals = checks.flatMap((c) => [...c.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!));
      expect(literals.length, `${t.table_name} has no closed provider list`).toBeGreaterThan(0);
      for (const lit of literals) expect(lit, `${t.table_name} provider ${lit}`).not.toContain('|');
    }
    // The link table has no provider: its AAD is four uuids.
    expect(sealed.find((t) => t.table_name === 'space_link_tokens')!.has_provider).toBe(false);
  });

  it('bindingAad refuses a provider with "|"; a plain provider binds', () => {
    expect(() => bindingAad({ accountId: randomUUID(), provider: 'a|b' })).toThrow(/must not contain/);
    expect(() => bindingAad({ spaceId: randomUUID(), credentialId: randomUUID(), provider: 'x|y' })).toThrow(/must not contain/);
    expect(bindingAad({ accountId: 'acc', provider: 'github' })).toBe('acc|github');
  });
});

describe('W6 × W10a — entity_content carries BOTH shared-object arms (250 is built on 239)', () => {
  it('a credential resolves through the credential arm and a space link through the space_link arm', async () => {
    const claims = await hClaims();
    const credentialId = randomUUID();
    const label = `both-arms ${credentialId.slice(0, 8)}`;
    await db.rpc(claims, 'create_space_credential', [
      credentialId, fixture.spaceA, 'anthropic', 'api_key', label, 'Fk9x',
      Buffer.alloc(17, 1), Buffer.alloc(12, 2),
    ]);
    let [existing] = await database.query<{ entity_id: string }>(
      'select entity_id from public.space_links where home_space_id = $1 and target_space_id = $2',
      [fixture.spaceA, fixture.spaceB]);
    if (!existing) {
      const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
      existing = { entity_id: link.id };
    }
    const content = async (id: string) =>
      (await database.query<{ c: Record<string, unknown> }>('select internal.entity_content($1) c', [id]))[0]!.c;
    // Each arm names its own row; the `else` arm would answer '{}' for either.
    expect(await content(credentialId)).toMatchObject({ title: label, provider: 'anthropic', shape: 'api_key' });
    expect(await content(existing.entity_id)).toMatchObject({
      home_space_id: fixture.spaceA, target_space_id: fixture.spaceB,
    });
  });
});

describe('W6 × W10a — both lifecycle guards fire: 239 owns credential, 251 owns space_link', () => {
  // Two guards, one refusal text. 239's delete_entity kind list refuses a
  // credential ('entity lifecycle is command-owned for kind credential');
  // 251 §10b's trigger refuses a space_link with the same words. So the RPC
  // arms tell them apart by the PL/pgSQL frames in pg's `where`, which
  // db.rpc's translateDbError drops: they run on a raw client that binds
  // the same claims db.tx does (client.ts BIND_CLAIMS_SQL).
  type RawPgError = { code?: string; message?: string; where?: string };
  async function rawDelete(claims: DbClaims, id: string): Promise<RawPgError | 'ok'> {
    try {
      await database.transaction(async (client) => {
        await client.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', $2, true),
          set_config('tm8.node_admin', 'false', true), set_config('tm8.request_id', $3, true),
          set_config('tm8.auth_kind', $4, true), set_config('tm8.session_space_id', $5, true),
          set_config('role', 'tm8_app', true)`,
        [claims.identityId ?? '', claims.actorId ?? '', randomUUID(), claims.authKind ?? '', claims.sessionSpaceId ?? '']);
        await client.query('select public.delete_entity($1, null, null)', [id]);
      });
      return 'ok';
    } catch (err) {
      const e = err as RawPgError;
      return { code: e.code, message: e.message, where: e.where };
    }
  }
  const facade = () => new W2EntitiesCommandsTrackingService({
    db, config: {} as ServerConfig, owner: async () => NOT_THE_OWNER,
  });
  async function facadeDelete(id: string): Promise<string> {
    const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const identity = await resolve({ authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true });
    const ctx = {
      identity, requestId: `space-links-${randomUUID()}`, params: { id }, query: new URLSearchParams(), body: {},
      headers: {}, method: 'POST', path: '/test',
    } as unknown as RequestContext;
    // `forbidden` is the TS gate (no sqlstate); '42501' would mean it fell through to SQL.
    return outcome(() => facade().deleteEntity(ctx));
  }
  const deletedAt = async (id: string) =>
    (await database.query<{ deleted_at: string | null }>('select deleted_at from public.entities where id = $1', [id]))[0]!.deleted_at;

  let credentialId: string;
  let linkId: string;
  beforeAll(async () => {
    const claims = await hClaims();
    credentialId = randomUUID();
    await db.rpc(claims, 'create_space_credential', [
      credentialId, fixture.spaceA, 'anthropic', 'api_key', `both-guards ${credentialId.slice(0, 8)}`, 'Fk9x',
      Buffer.alloc(17, 1), Buffer.alloc(12, 2),
    ]);
    const [existing] = await database.query<{ entity_id: string }>(
      `select sl.entity_id from public.space_links sl join public.entities e on e.id = sl.entity_id
        where sl.home_space_id = $1 and sl.target_space_id = $2 and e.deleted_at is null`,
      [fixture.spaceA, fixture.spaceB]);
    linkId = existing?.entity_id ?? (await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB })).id;
  });

  it('arm 1 — a credential: 239 refuses the generic delete (RPC and facade); 251\'s trigger is not in the frames', async () => {
    const rpc = await rawDelete(await hClaims(), credentialId);
    expect(rpc).toMatchObject({ code: '42501', message: 'entity lifecycle is command-owned for kind credential' });
    expect((rpc as RawPgError).where ?? '').not.toContain('refuse_generic_link_lifecycle');
    expect(await facadeDelete(credentialId)).toBe('forbidden');
    expect(await deletedAt(credentialId)).toBeNull();
  });

  it('arm 2 — a space_link: 251\'s trigger refuses it inside delete_entity\'s UPDATE (both frames); the facade is forbidden', async () => {
    const rpc = await rawDelete(await hClaims(), linkId);
    expect(rpc).toMatchObject({ code: '42501', message: 'entity lifecycle is command-owned for kind space_link' });
    expect((rpc as RawPgError).where ?? '').toContain('refuse_generic_link_lifecycle');
    expect((rpc as RawPgError).where ?? '').toContain('delete_entity');
    expect(await facadeDelete(linkId)).toBe('forbidden');
    expect(await deletedAt(linkId)).toBeNull();
  });

  it('arm 3 — the merged TS gate names both kinds', () => {
    expect(RESTRICTED_LIFECYCLE_KINDS.has('credential')).toBe(true);
    expect(RESTRICTED_LIFECYCLE_KINDS.has('space_link')).toBe(true);
  });
});
