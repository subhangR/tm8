/**
 * THE CROSS-SPACE TOKEN MATRIX (plan 01a0d9eb §4). One file, one `it` per
 * cell, one top-level `describe` per T-number so parallel lanes merge as a
 * union of blocks.
 *
 * THE RULE EVERY ROW OBEYS: a refusal is paired with a positive case — the
 * SAME credential against its OWN space — so a row cannot pass merely because
 * everything is refused.
 *
 * Fixture (§4, the part that exists on one server today): spaces A and B.
 * Human H is a member of both, H2 of A only. G is H's agent spawned in A — a
 * `kind = 'agent'` token on a work session in A — and GR is H's
 * `kind = 'agent_runtime'` token on a chat in A.
 *
 * Credentials are REAL: each is minted by the production RPC, presented as a
 * bearer string to the production identity resolver, and turned into claims
 * by the production `claimsFor` — so a row here fails if any hop between the
 * `auth_sessions` row and `SET LOCAL` drops the pin, not only if the SQL does.
 */
import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { loadConfig } from '../../src/http/config.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';
import type { RequestContext, SpaceSessionsMode } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken, parseToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string;
  spaceB: string;
  identityH: string;
  identityH2: string;
  accountH: string;
  accountH2: string;
  memberHA: string;
  memberHB: string;
  memberH2A: string;
  personaA: string;
  workSessionA: string;
  chatA: string;
  /** One readable document per space, created by H through the real RPC. */
  docA: string;
  docB: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;

/** Never used for a bearer: every credential in this file carries a token. */
const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'cross-space-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
  isNodeAdmin: false,
  isOwner: false,
};

// ---------------------------------------------------------------------------
// Credentials. The token string lives only in this process; the database sees
// its sha256, exactly as in production. Nothing here logs a token.
// ---------------------------------------------------------------------------

/** Run `fn` with bare claims — used only to SEED, never to assert. */
function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind = 'browser'): Promise<T> {
  return db.tx({ identityId, authKind, requestId: `cross-space-seed-${randomUUID()}` }, fn);
}

async function mintBrowser(accountId: string, identityId: string): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'cross-space browser',
    ]));
  return formatToken(row.id, secret);
}

async function mintAgent(): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(fixture.identityH, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      fixture.workSessionA, fixture.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'cross-space agent G',
    ]));
  return formatToken(row.id, secret);
}

async function mintAgentRuntime(): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(fixture.identityH, (q) =>
    q.rpc<{ id: string }>('issue_agent_runtime_session', [
      fixture.chatA, fixture.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'cross-space agent GR',
    ]));
  return formatToken(row.id, secret);
}

/**
 * The production path from a bearer string to `SET LOCAL`: identity resolver
 * (token hash → `auth_sessions` row) then `claimsFor`. `mode` is the
 * boot-time `TM8_SPACE_SESSIONS` value the server would have read.
 */
async function claimsForToken(token: string, mode: SpaceSessionsMode = 'agents'): Promise<DbClaims> {
  const resolve = createSessionIdentityResolver({
    db,
    owner: async () => NOT_THE_OWNER,
    spaceSessions: mode,
  });
  const identity = await resolve(
    { authorization: `Bearer ${token}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true },
  );
  const ctx = { identity, requestId: `cross-space-${randomUUID()}` } as unknown as RequestContext;
  return claimsFor(NOT_THE_OWNER, ctx);
}

async function asToken<T>(
  token: string,
  fn: (q: Querier) => Promise<T>,
  mode: SpaceSessionsMode = 'agents',
): Promise<T> {
  return db.tx(await claimsForToken(token, mode), fn);
}

/** The SQLSTATE a refused write raised, or `'ok'`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { code?: string; details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

const idsIn = (q: Querier, spaceId: string): Promise<string[]> =>
  q.query<{ id: string }>(
    'select id::text from public.entities where space_id = $1 and deleted_at is null',
    [spaceId],
  ).then((rows) => rows.map((r) => r.id));

/** The doc's current version, read as H (who can see both spaces). */
const versionOf = (docId: string): Promise<number> =>
  asIdentity(fixture.identityH, async (q) =>
    Number((await q.query<{ version: number }>(
      'select version from public.entities where id = $1', [docId]))[0]!.version));

/** `provider_etag_record` as `token` — a space write with no actor binding. */
function recordEtag(token: string, spaceId: string, mode: SpaceSessionsMode = 'agents'): Promise<unknown> {
  return asToken(token, (q) => q.rpc('provider_etag_record', [
    spaceId, `cross-space/${randomUUID()}`, `"etag-${randomUUID()}"`, false,
  ]), mode);
}

/** `update_document` as `token`, at the doc's current version. */
async function editDoc(token: string, docId: string, mode: SpaceSessionsMode = 'agents'): Promise<unknown> {
  const version = await versionOf(docId);
  return asToken(token, (q) => q.rpc('update_document', [
    docId, version, null, `edited ${randomUUID()}`, null, null, `cross-space-${randomUUID()}`,
  ]), mode);
}

// ---------------------------------------------------------------------------
// Two-space fixture.
// ---------------------------------------------------------------------------

async function seed(): Promise<Fixture> {
  const ids = {
    spaceA: randomUUID(),
    spaceB: randomUUID(),
    identityH: `cross-space-h-${randomUUID()}`,
    identityH2: `cross-space-h2-${randomUUID()}`,
    accountH: randomUUID(),
    accountH2: randomUUID(),
    memberHA: randomUUID(),
    memberHB: randomUUID(),
    memberH2A: randomUUID(),
    personaA: randomUUID(),
    workSessionA: randomUUID(),
    chatA: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2')`,
      [ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'cross-space-h'), ($3, $4, 'cross-space-h2')`,
      [ids.accountH, ids.identityH, ids.accountH2, ids.identityH2],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Cross-space A', $3), ($2, 'Cross-space B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identityH],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $5, 'member', $1, 'space'),
              ($2, $6, 'member', $2, 'space'),
              ($3, $5, 'member', $3, 'space'),
              ($4, $5, 'team_member', $1, 'space'),
              ($7, $5, 'work_session', $4, 'space'),
              ($8, $5, 'chat', $1, 'space')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.personaA, ids.spaceA, ids.spaceB,
       ids.workSessionA, ids.chatA],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'H'),
              ($2, $5, $6, 'owner', 'H'),
              ($3, $4, $7, 'member', 'H2')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.spaceA, ids.spaceB,
       ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Cross-space G', 'worker', 'persona')`,
      [ids.personaA, ids.memberHA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Cross-space G run', 'running', 'none', now())`,
      [ids.workSessionA],
    );
    await client.query(
      `insert into public.chats(
         entity_id, space_id, title, teammate_id, model, provider, agent_tool,
         chat_mode, workdir_mode, cwd, native_session_id,
         configured_by_identity_id, configured_by_member_id, client_mutation_id
       ) values ($1,$2,'Cross-space chat',$3,'claude-opus-5','anthropic','claude-code',
                 'ask','scratch','/tmp/tm8-cross-space', gen_random_uuid(), $4, $5, $6)`,
      [ids.chatA, ids.spaceA, ids.personaA, ids.identityH, ids.memberHA, `cross-space-${randomUUID()}`],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [ids.spaceA, ids.personaA, ids.workSessionA],
    );
  });
  const docIn = (spaceId: string, title: string): Promise<string> =>
    asIdentity(ids.identityH, async (q) =>
      (await q.rpc<{ id?: string; entity?: { id: string } }>('create_document', [spaceId, title]))
    ).then((row) => (row.entity?.id ?? row.id)!);
  return {
    ...ids,
    docA: await docIn(ids.spaceA, 'Cross-space doc in A'),
    docB: await docIn(ids.spaceB, 'Cross-space doc in B'),
  };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('cross_space_token');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

// ---------------------------------------------------------------------------
// Rows. One describe per T-number; one `it` per cell; refusal + positive.
// ---------------------------------------------------------------------------

const AGENT_KINDS = [
  ['agent', () => mintAgent()],
  ['agent_runtime', () => mintAgentRuntime()],
] as const;

describe('T9 agent G (A) reads B — refused (W0a)', () => {
  for (const [kind, mint] of AGENT_KINDS) {
    it(`${kind}: B entities are invisible`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceB))).toEqual([]);
    });
    it(`${kind}: positive — A entities are visible with the same credential`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceA))).toContain(fixture.docA);
    });

    it(`${kind}: B's doc is not_found by id`, async () => {
      const token = await mint();
      const rows = await asToken(token, (q) =>
        q.query('select id from public.entities where id = $1', [fixture.docB]));
      expect(rows).toEqual([]);
    });
    it(`${kind}: positive — A's doc is found by id`, async () => {
      const token = await mint();
      const rows = await asToken(token, (q) =>
        q.query('select id from public.entities where id = $1', [fixture.docA]));
      expect(rows).toHaveLength(1);
    });

    it(`${kind}: B's member rows are invisible`, async () => {
      const token = await mint();
      const rows = await asToken(token, (q) =>
        q.query('select entity_id from public.members where space_id = $1', [fixture.spaceB]));
      expect(rows).toEqual([]);
    });
    it(`${kind}: positive — A's member rows are visible`, async () => {
      const token = await mint();
      const rows = await asToken(token, (q) =>
        q.query('select entity_id from public.members where space_id = $1', [fixture.spaceA]));
      expect(rows.length).toBeGreaterThan(0);
    });

    it(`${kind}: a SECURITY DEFINER read guarded by require_space_member refuses B`, async () => {
      const token = await mint();
      expect(await outcome(() => asToken(token, (q) => q.rpc('get_space_menu', [fixture.spaceB]))))
        .toBe('42501');
    });
    it(`${kind}: positive — the same read answers for A`, async () => {
      const token = await mint();
      expect(await outcome(() => asToken(token, (q) => q.rpc('get_space_menu', [fixture.spaceA]))))
        .toBe('ok');
    });

    // TM8_SPACE_SESSIONS=off: the pin is INERT. No claim is bound, and every
    // helper answers exactly as before 227 — so B is visible again. This is
    // the pre-W0a leak, pinned as the documented behaviour of the kill switch.
    it(`${kind}: off — no pin is bound and B entities are visible (pre-227 behaviour)`, async () => {
      const token = await mint();
      expect((await claimsForToken(token, 'off')).sessionSpaceId).toBeUndefined();
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceB), 'off')).toContain(fixture.docB);
    });
    it(`${kind}: off — positive — A entities stay visible`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceA), 'off')).toContain(fixture.docA);
    });
    it(`${kind}: off — every helper answers as before for B`, async () => {
      const token = await mint();
      const row = await asToken(token, async (q) => (await q.query<{
        pin: string | null; spaces: string[]; member: boolean; admin: boolean; me: string | null;
      }>(
        `select nullif(current_setting('tm8.session_space_id', true), '') as pin,
                internal.member_space_ids()::text[] as spaces,
                internal.is_space_member($1) as member,
                internal.is_space_admin($1) as admin,
                internal.current_member_id($1)::text as me`,
        [fixture.spaceB],
      ))[0]!, 'off');
      expect(row.pin).toBeNull();
      expect([...row.spaces].sort()).toEqual([fixture.spaceA, fixture.spaceB].sort());
      expect(row).toMatchObject({ member: true, admin: true, me: fixture.memberHB });
    });

    // TM8_SPACE_SESSIONS=enforce is reserved for W3 (human sessions) and is a
    // no-op here: an agent token behaves exactly as under `agents`.
    it(`${kind}: enforce — B entities are invisible, as under agents`, async () => {
      const token = await mint();
      expect((await claimsForToken(token, 'enforce')).sessionSpaceId).toBe(fixture.spaceA);
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceB), 'enforce')).toEqual([]);
    });
    it(`${kind}: enforce — positive — A entities are visible`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceA), 'enforce')).toContain(fixture.docA);
    });
  }

  // `enforce` does not pin humans yet (W3). H's browser token sees both spaces
  // under every mode — the agents-only scope of W0a, pinned.
  for (const mode of ['off', 'agents', 'enforce'] as const) {
    it(`browser (H), ${mode}: unpinned — B entities are visible`, async () => {
      const token = await mintBrowser(fixture.accountH, fixture.identityH);
      expect((await claimsForToken(token, mode)).sessionSpaceId).toBeUndefined();
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceB), mode)).toContain(fixture.docB);
    });
  }
});

describe('T10 agent G (A) writes B — 42501 (W0a)', () => {
  for (const [kind, mint] of AGENT_KINDS) {
    // Not discriminating on its own: the persona actor fails can_act_as in B
    // with or without the pin. Kept as the plan's cell; the A1 cell below is
    // the one that goes red without 227.
    it(`${kind}: create_document in B is refused`, async () => {
      const token = await mint();
      expect(await outcome(() => asToken(token, (q) =>
        q.rpc('create_document', [fixture.spaceB, `T10 ${kind} in B`])))).toBe('42501');
    });
    it(`${kind}: positive — create_document in A succeeds`, async () => {
      const token = await mint();
      expect(await outcome(() => asToken(token, (q) =>
        q.rpc('create_document', [fixture.spaceA, `T10 ${kind} in A`])))).toBe('ok');
    });

    // A write to an EXISTING entity. (The plan names `mark_read` for the A1
    // cell; it has since moved to entity_readable + a member-only actor check,
    // so an agent actor is refused it in every space and it cannot carry a
    // positive. The A1 cell is provider_etag_record, below.)
    it(`${kind}: update_document on B's doc is refused`, async () => {
      const token = await mint();
      expect(await outcome(() => editDoc(token, fixture.docB))).toBe('42501');
    });
    it(`${kind}: positive — update_document on A's doc succeeds`, async () => {
      const token = await mint();
      expect(await outcome(() => editDoc(token, fixture.docA))).toBe('ok');
    });

    // THE A1 WRITE LEAK: a write guarded by `require_space_member` ALONE —
    // no actor binding — so before the pin an agent carrying H's identity
    // could write it in any of H's spaces. This is the discriminating cell:
    // under `off` the same call succeeds in B (below), so the refusal here is
    // the pin and nothing else. (update_document above also refuses B under
    // `off`, via the persona actor's can_act_as, so it cannot show that.)
    it(`${kind}: provider_etag_record in B is refused`, async () => {
      const token = await mint();
      expect(await outcome(() => recordEtag(token, fixture.spaceB))).toBe('42501');
    });
    it(`${kind}: positive — provider_etag_record in A succeeds`, async () => {
      const token = await mint();
      expect(await outcome(() => recordEtag(token, fixture.spaceA))).toBe('ok');
    });

    // off: the pin is inert, so the pre-227 write leak is back — by design of
    // the kill switch, and pinned here so that stays a deliberate choice.
    it(`${kind}: off — provider_etag_record in B succeeds (pin inert)`, async () => {
      const token = await mint();
      expect(await outcome(() => recordEtag(token, fixture.spaceB, 'off'))).toBe('ok');
    });
    it(`${kind}: off — positive — provider_etag_record in A succeeds`, async () => {
      const token = await mint();
      expect(await outcome(() => recordEtag(token, fixture.spaceA, 'off'))).toBe('ok');
    });

    it(`${kind}: enforce — provider_etag_record in B is refused, as under agents`, async () => {
      const token = await mint();
      expect(await outcome(() => recordEtag(token, fixture.spaceB, 'enforce'))).toBe('42501');
    });
    it(`${kind}: enforce — positive — provider_etag_record in A succeeds`, async () => {
      const token = await mint();
      expect(await outcome(() => recordEtag(token, fixture.spaceA, 'enforce'))).toBe('ok');
    });
  }
});

describe('T11 agent G manages credentials in A — refused (regression pin)', () => {
  // The refusal here is by KIND (require_human_auth_kind, 082), not by space,
  // so the paired positive is H's own browser credential on the same space.
  for (const [kind, mint] of AGENT_KINDS) {
    it(`${kind}: set_space_credential_policy in A is refused`, async () => {
      const token = await mint();
      expect(await outcome(() => asToken(token, (q) =>
        q.rpc('set_space_credential_policy', [fixture.spaceA, 'anthropic', null])))).toBe('42501');
    });
  }
  it('positive — H (browser) sets the same policy in A', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('set_space_credential_policy', [fixture.spaceA, 'anthropic', null])))).toBe('ok');
  });
});

describe('T29 member_space_ids() policies stay once per statement under a pinned token (W0a)', () => {
  // 218's reason for existing, re-asked with the pin bound: the pin is inlined
  // into member_space_ids() (A10), so the policy must still resolve membership
  // as ONE InitPlan per statement and never fall back to a per-row helper.
  const planFor = (token: string, sql: string): Promise<string> =>
    asToken(token, async (q) =>
      (await q.query<{ 'QUERY PLAN': string }>(`explain (analyze, costs off, verbose, timing off, summary off) ${sql}`))
        .map((r) => r['QUERY PLAN']).join('\n'));

  const onceOnly = (plan: string): void => {
    expect(plan).toMatch(/InitPlan/);
    expect(plan).toContain('member_space_ids()');
    expect(plan).not.toMatch(/is_space_member|entity_readable/);
    // The InitPlan node ran once for the whole statement.
    const initPlanLoops = [...plan.matchAll(/InitPlan[^\n]*\n[^\n]*loops=(\d+)/g)].map((m) => m[1]);
    for (const loops of initPlanLoops) expect(loops).toBe('1');
  };

  for (const [kind, mint] of AGENT_KINDS) {
    for (const [table, sql] of [
      ['members', 'select count(*) from public.members'],
      ['entities', 'select count(*) from public.entities'],
    ] as const) {
      it(`${kind}: ${table}_select resolves the pinned membership as one InitPlan`, async () => {
        onceOnly(await planFor(await mint(), sql));
      });
    }
    it(`${kind}: positive — the pinned array is exactly A, and the same statement returns A's rows`, async () => {
      const token = await mint();
      const [row] = await asToken(token, (q) => q.query<{ spaces: string[]; n: string }>(
        `select internal.member_space_ids()::text[] as spaces,
                (select count(*) from public.members where space_id = $1) as n`,
        [fixture.spaceA],
      ));
      expect(row!.spaces).toEqual([fixture.spaceA]);
      expect(Number(row!.n)).toBeGreaterThan(0);
    });
  }
  it('positive — an unpinned browser token keeps the same plan shape over both spaces', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    onceOnly(await planFor(token, 'select count(*) from public.members'));
    const [row] = await asToken(token, (q) =>
      q.query<{ spaces: string[] }>('select internal.member_space_ids()::text[] as spaces'));
    expect([...row!.spaces].sort()).toEqual([fixture.spaceA, fixture.spaceB].sort());
  });
});

/**
 * T26 — THE NAMED-SERVER RELAY (G1).
 *
 * `/v2/server-connections/:name/proxy/*` used to dispatch before any identity
 * was resolved and to look the target up as the NODE OWNER — so a request with
 * no session, or an agent's token, drove every registered remote. The relay now
 * resolves the caller first, admits browser/cli sessions only, and reads the
 * target under the CALLER's claims (044: node admins only until links exist).
 *
 * HTTP, not SQL: the refusal lives in the transport, so the cells go through
 * the production composition root (`bootstrap`) on this file's database, with
 * the auto-owner arm OFF — on loopback it would otherwise answer every
 * no-credential request as the owner and the 401 cell could not be reached.
 * The upstream is a real listener that records what arrives, because acceptance
 * a3 is a claim about the far end, not about a header helper.
 *
 * Every refusal is paired with a positive: the kind refusals with H's own
 * browser session (the refusal is by kind, not by space — T11's pairing), the
 * claims refusal (H2) with H on the same connection.
 */
describe('T26 relay — dispatch after resolveIdentity, human session required', () => {
  let relayServer: BootstrappedServer;
  /** Same database, auto-owner arm ON — only the cells that document it use this. */
  let ownerRelayServer: BootstrappedServer;
  let upstream: Server;
  let arrived: IncomingHttpHeaders[] = [];
  let adminBefore: Array<{ id: string; is_node_admin: boolean; is_owner: boolean }> = [];
  const CONNECTION = 't26-remote';

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      arrived.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (typeof address === 'string' || address === null) throw new Error('no upstream port');

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      // H owns and administers the node, H2 does not: the claims cell needs
      // exactly that split, and `bootstrap` needs an owner. It is also the
      // regression: the relay used to read the target AS THE OWNER, so H2
      // reached it on H's claims. Restored in afterAll so no later block
      // inherits it.
      const before = await client.query<{ id: string; is_node_admin: boolean; is_owner: boolean }>(
        'select id::text, is_node_admin, is_owner from public.accounts where id = any($1::uuid[])',
        [[fixture.accountH, fixture.accountH2]],
      );
      adminBefore = before.rows;
      await client.query(
        `update public.accounts set is_node_admin = (id = $1::uuid), is_owner = (id = $1::uuid)
          where id = any($2::uuid[])`,
        [fixture.accountH, [fixture.accountH, fixture.accountH2]],
      );
      await client.query(
        'insert into public.server_connections(name, base_url) values ($1, $2)',
        [CONNECTION, `http://127.0.0.1:${address.port}`],
      );
    });

    const start = async (disableAutoOwner: '1' | '0'): Promise<BootstrappedServer> => {
      const configured = loadConfig({
        ...process.env,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: '4610',
        TM8_NODE_MODE: 'single',
        TM8_DATABASE_URL: database.url,
        TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-t26-')),
        TM8_DISABLE_AUTO_OWNER: disableAutoOwner,
      });
      return bootstrap({ config: { ...configured, port: 0 } });
    };
    relayServer = await start('1');
    ownerRelayServer = await start('0');
  }, 180_000);

  afterAll(async () => {
    for (const server of [relayServer, ownerRelayServer]) {
      await server?.server.close();
      await server?.db?.end();
    }
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('delete from public.server_connections where name = $1', [CONNECTION]);
      for (const row of adminBefore) {
        await client.query(
          'update public.accounts set is_node_admin = $2, is_owner = $3 where id = $1::uuid',
          [row.id, row.is_node_admin, row.is_owner],
        );
      }
    });
  }, 180_000);

  async function relay(
    headers: Record<string, string>,
    server: BootstrappedServer = relayServer,
  ): Promise<{ status: number; seen: IncomingHttpHeaders | undefined }> {
    arrived = [];
    const response = await fetch(new URL(`/v2/server-connections/${CONNECTION}/proxy/health`, server.url), {
      headers: { [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE, ...headers },
    });
    await response.arrayBuffer();
    return { status: response.status, seen: arrived[0] };
  }

  async function mintCli(accountId: string, identityId: string): Promise<string> {
    const secret = generateSecret();
    const row = await asIdentity(identityId, (q) =>
      q.rpc<{ id: string }>('issue_auth_session', [
        accountId, hashToken(secret), 'cli',
        new Date(Date.now() + 3_600_000).toISOString(), null, 'T26 cli',
      ]));
    return formatToken(row.id, secret);
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const cookie = (token: string) => ({ cookie: `${TM8_SESSION_COOKIE}=${token}` });

  it('no session is refused 401 and nothing reaches the remote', async () => {
    const { status, seen } = await relay({});
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('positive — H (browser cookie) reaches the connection', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay(cookie(token));
    expect(status).toBe(200);
    expect(seen).toBeDefined();
  });

  it('agent token is refused 403 and nothing reaches the remote', async () => {
    const token = await mintAgent();
    const { status, seen } = await relay(bearer(token));
    expect(status).toBe(403);
    expect(seen).toBeUndefined();
  });

  it('agent token as a cookie is refused 403 too', async () => {
    const token = await mintAgent();
    const { status, seen } = await relay(cookie(token));
    expect(status).toBe(403);
    expect(seen).toBeUndefined();
  });

  it('positive — H (cli token) reaches the connection, and its token stays on this node', async () => {
    const token = await mintCli(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay(bearer(token));
    expect(status).toBe(200);
    // Booleans, not values: a failing assertion must never print a token.
    expect(seen !== undefined && 'authorization' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(token)).toBe(false);
  });

  it('H2 (browser, not a node admin) is refused: the target is read under H2\'s claims', async () => {
    const token = await mintBrowser(fixture.accountH2, fixture.identityH2);
    const { status, seen } = await relay(cookie(token));
    expect(status).toBe(404);
    expect(seen).toBeUndefined();
  });

  it('positive — H (browser) on the same connection forwards only the remote pass it presented', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const remotePass = 'tm8s_00000000-0000-0000-0000-000000000000.remote-pass-not-local';
    const { status, seen } = await relay({ ...cookie(token), ...bearer(remotePass) });
    expect(status).toBe(200);
    expect(seen?.authorization).toBe(`Bearer ${remotePass}`);
    expect(seen !== undefined && 'cookie' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(token)).toBe(false);
  });
  async function revoke(token: string): Promise<void> {
    const sessionId = parseToken(token)?.sessionId;
    if (!sessionId) throw new Error('minted token did not parse');
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.auth_sessions set revoked_at = now() where id = $1::uuid', [sessionId]);
    });
  }

  it('auto-owner off: an Authorization unknown here, no cookie, is refused 401 and nothing reaches the remote', async () => {
    const unknown = 'tm8s_00000000-0000-0000-0000-000000000000.not-a-session-here';
    const { status, seen } = await relay(bearer(unknown));
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  /**
   * F1 / W2 PIN — TODAY'S BEHAVIOUR, WHICH W2 CHANGES. Loopback peer, single
   * mode, auto-owner arm on, no token, no X-Forwarded-For: the NODE-WIDE
   * loopback auto-owner rule (security.ts `autoOwnerResolver`) makes the
   * request the node owner on every route, and the relay admits the owner like
   * any other human. This is plan finding F1, and the fix is phase-1a task W2
   * (01a0d9fd-6957-7da5-a590-9655ebbf2ace: launch cookie,
   * TM8_AUTO_OWNER_COOKIE=required), not the relay. W2 flips this expectation
   * to 401; until then nothing may change it silently in either direction.
   */
  it('F1/W2 pin: loopback, single mode, no token, no X-Forwarded-For — relay admits as owner TODAY', async () => {
    const { status, seen } = await relay({}, ownerRelayServer);
    expect(status).toBe(200);
    expect(seen).toBeDefined();
  });

  /**
   * DOCUMENTS A KNOWN GAP (review round 1, item 2). A LOCAL token that no
   * longer resolves (revoked, expired) is indistinguishable here from a
   * remote's pass: both are `tm8s_<uuid>.<secret>`, and `tm8_app` cannot read
   * `auth_sessions` to ask "was this session id ever ours?" — that needs a new
   * security-definer RPC, i.e. a migration, which this PR does not add. So
   * next to a live cookie such a token is FORWARDED. It is dead on this node,
   * so the remote cannot replay it here; the disclosure is of a spent secret.
   * When the RPC lands, flip this cell to `false`.
   */
  it('KNOWN GAP: a revoked LOCAL token beside H\'s cookie is forwarded as if it were a remote pass', async () => {
    const cookieToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await revoke(dead);
    const { status, seen } = await relay({ ...cookie(cookieToken), ...bearer(dead) });
    expect(status).toBe(200);
    expect(seen?.authorization === `Bearer ${dead}`).toBe(true);
    expect(JSON.stringify(seen).includes(cookieToken)).toBe(false);
  });

  it('a revoked LOCAL token alone is refused 401 with auto-owner off, and nothing reaches the remote', async () => {
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await revoke(dead);
    const { status, seen } = await relay(bearer(dead));
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('positive — the same cli credential, before revocation, reaches the connection', async () => {
    const live = await mintCli(fixture.accountH, fixture.identityH);
    const { status } = await relay(bearer(live));
    expect(status).toBe(200);
  });
});
