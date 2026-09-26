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

import {
  SPACE_LINK_VIA_HEADER,
  TM8_CLIENT_HEADER,
  TM8_CLIENT_HEADER_VALUE,
  spaceLinkRefusal,
} from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { loadConfig } from '../../src/http/config.js';
import { FixedWindowLimiter } from '../../src/http/fixed-window.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';
import type { RequestContext, SpaceSessionsMode } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken, parseToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import type { EventSink } from '../../src/events/ws-connection.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createSpaceLinkInvokeHandlers } from '../../src/facade/handlers/w2/space-link-invoke.js';
import { registerMembershipHandlers } from '../../src/membership/handlers.js';
import { DbSpaceLinkStore, SpaceLinkUnusable, type SpaceLink, type SpaceLinkStaleNotice } from '../../src/credentials/space-link-store.js';
import { loadOrCreateCredentialKey } from '../../src/credentials/credential-key.js';
import { openSecret } from '../../src/credentials/secret-box.js';

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

/**
 * T9, INLINE-MEMBERSHIP SURFACES (review round 1). These policies and
 * functions answer "is this identity a member?" themselves instead of calling
 * a pinned helper.
 *
 * - file_upload_slots_select / notifications_select: their `members`
 *   subquery runs under the caller's RLS, so members_select's pin (227's
 *   member_space_ids) already hides B. REGRESSION PINS, not new conjuncts:
 *   they go red if either policy ever reads `members` without RLS.
 * - inspect_owned_teammate_inbox: SECURITY DEFINER, reads `members` without
 *   RLS, so 227 adds the conjunct itself. The one DISCRIMINATING cell here.
 * - user_profiles, read_marks, work_session_view_preferences: no route
 *   reaches B through them (227's header).
 */
describe('T9 agent G (A) reads B through inline-membership surfaces — refused (W0a)', () => {
  const s = {
    slotA: randomUUID(), slotB: randomUUID(),
    notifA: randomUUID(), notifB: randomUUID(),
    personaB: randomUUID(), teammateNotifA: randomUUID(), teammateNotifB: randomUUID(),
  };

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const hex = (): string => randomUUID().replaceAll('-', '').repeat(2);
      for (const [slot, space, member] of [
        [s.slotA, fixture.spaceA, fixture.memberHA],
        [s.slotB, fixture.spaceB, fixture.memberHB],
      ] as const) {
        await client.query(
          `insert into public.file_upload_slots(
             id, space_id, created_by, actor_id, name, mime_type, size_bytes, max_size_bytes,
             checksum_sha256, request_hash, storage_path, expires_at)
           values ($1, $2, $3, $3, 'cross-space.txt', 'text/plain', 1, 10, $4, $5, $6,
                   now() + interval '1 hour')`,
          [slot, space, member, hex(), hex(), `spaces/${space}/${slot}`],
        );
      }
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'team_member', $3, 'space')`,
        [s.personaB, fixture.spaceB, fixture.memberHB],
      );
      await client.query(
        `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
         values ($1, $2, 'Cross-space GB', 'worker', 'persona')`,
        [s.personaB, fixture.memberHB],
      );
      await client.query(
        `insert into public.notifications(id, space_id, recipient_member_id, recipient_team_member_id, kind)
         values ($1, $5, $6, null, 'mention'),
                ($2, $7, $8, null, 'mention'),
                ($3, $5, $6, $9, 'mention'),
                ($4, $7, $8, $10, 'mention')`,
        [s.notifA, s.notifB, s.teammateNotifA, s.teammateNotifB,
         fixture.spaceA, fixture.memberHA, fixture.spaceB, fixture.memberHB,
         fixture.personaA, s.personaB],
      );
    });
  });

  const slotById = (q: Querier, id: string): Promise<unknown[]> =>
    q.query('select id from public.file_upload_slots where id = $1', [id]);

  // `files.uploadComplete` runs exactly this read under the caller's claims
  // before any pinned gate (files.ts): a visible B slot would be an existence
  // probe and drive a blob verify on B's storage path.
  for (const [kind, mint] of AGENT_KINDS) {
    it(`${kind}: B's upload slot is invisible by id`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) => slotById(q, s.slotB))).toEqual([]);
    });
    it(`${kind}: positive — A's upload slot is visible by id`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) => slotById(q, s.slotA))).toHaveLength(1);
    });
  }
  it('agent, off: the pin is inert — B\'s upload slot is visible', async () => {
    const token = await mintAgent();
    expect(await asToken(token, (q) => slotById(q, s.slotB), 'off')).toHaveLength(1);
  });

  /**
   * The persona-less agent session: `acting_as_team_member_id` is ON DELETE
   * SET NULL, so a hard-deleted persona leaves a live `kind = 'agent'` token
   * that binds no actor. `inbox.list` then takes the non-acting path: arm 1 of
   * notifications_select and `inspect_owned_teammate_inbox`. (`agent_runtime`
   * cannot get here: its shape check requires the persona.)
   */
  async function mintPersonalessAgent(): Promise<string> {
    const token = await mintAgent();
    await database.transaction(async (client) => {
      await client.query(
        'update public.auth_sessions set acting_as_team_member_id = null where id = $1',
        [parseToken(token)!.sessionId],
      );
    });
    return token;
  }
  const notificationById = (q: Querier, id: string): Promise<unknown[]> =>
    q.query('select id from public.notifications where id = $1', [id]);
  const ownedTeammateInbox = (q: Querier, teammate: string): Promise<string[]> =>
    q.query<{ id: string }>(
      'select id::text from public.inspect_owned_teammate_inbox($1, null, false, null, null, 50)',
      [teammate],
    ).then((rows) => rows.map((r) => r.id));

  it('agent, persona-less: binds no actor, still pinned to A', async () => {
    const claims = await claimsForToken(await mintPersonalessAgent());
    expect(claims.actorId).toBeUndefined();
    expect(claims.sessionSpaceId).toBe(fixture.spaceA);
  });
  it('agent, persona-less: B\'s inbox row is invisible by id', async () => {
    const token = await mintPersonalessAgent();
    expect(await asToken(token, (q) => notificationById(q, s.notifB))).toEqual([]);
  });
  it('agent, persona-less: positive — A\'s inbox row is visible by id', async () => {
    const token = await mintPersonalessAgent();
    expect(await asToken(token, (q) => notificationById(q, s.notifA))).toHaveLength(1);
  });
  it('agent, persona-less: B teammate\'s inbox is empty through inspect_owned_teammate_inbox', async () => {
    const token = await mintPersonalessAgent();
    expect(await asToken(token, (q) => ownedTeammateInbox(q, s.personaB))).toEqual([]);
  });
  it('agent, persona-less: positive — A teammate\'s inbox is listed', async () => {
    const token = await mintPersonalessAgent();
    expect(await asToken(token, (q) => ownedTeammateInbox(q, fixture.personaA))).toEqual([s.teammateNotifA]);
  });
  it('agent, persona-less, off: the pin is inert — B\'s inbox row and teammate inbox are visible', async () => {
    const token = await mintPersonalessAgent();
    expect(await asToken(token, (q) => notificationById(q, s.notifB), 'off')).toHaveLength(1);
    expect(await asToken(token, (q) => ownedTeammateInbox(q, s.personaB), 'off')).toEqual([s.teammateNotifB]);
  });

  /**
   * KNOWN GAP (W3, K7). spaces_select's public arm admits any authenticated
   * identity, so `spaces.list`/`spaces.get` return a PUBLIC B's row (name,
   * description, repo, share defaults) to an agent pinned to A. This cell
   * asserts today's behaviour; W3 flips it to `[]`.
   */
  it('KNOWN GAP (W3, K7) agent: a PUBLIC B is still readable through spaces_select\'s public arm', async () => {
    const token = await mintAgent();
    await database.query(`update public.spaces set visibility = 'public' where id = $1`, [fixture.spaceB]);
    try {
      expect(await asToken(token, (q) =>
        q.query('select id from public.spaces where id = $1', [fixture.spaceB]))).toHaveLength(1);
    } finally {
      await database.query(`update public.spaces set visibility = 'private' where id = $1`, [fixture.spaceB]);
    }
  });
  it('agent: positive for the gap — a PRIVATE B is refused (the member arm is pinned)', async () => {
    const token = await mintAgent();
    expect(await asToken(token, (q) =>
      q.query('select id from public.spaces where id = $1', [fixture.spaceB]))).toEqual([]);
    expect(await asToken(token, (q) =>
      q.query('select id from public.spaces where id = $1', [fixture.spaceA]))).toHaveLength(1);
  });
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

/**
 * a3 — THE SIX CLAIMS, at the database. test/db/claims.test.ts proves the same
 * SET LOCAL contract but is gated on TM8_DATABASE_URL, which CI deliberately
 * does not set (ci.yml, test-server), so these cells carry it in CI: this file
 * runs on the w1-pg scratch database every shard can reach.
 *
 * A one-connection pool forces the second transaction onto the backend the
 * first used; with a wider pool the "no leak" cell could pass on a fresh one.
 */
describe('a3 six claims — bound from the agent token, never leaked across pooled transactions (W0a)', () => {
  const READ_CLAIMS = `select
      current_setting('tm8.identity_id', true)      as identity,
      current_setting('tm8.actor_id', true)         as actor,
      current_setting('tm8.node_admin', true)       as node_admin,
      current_setting('tm8.request_id', true)       as request,
      current_setting('tm8.auth_kind', true)        as auth_kind,
      current_setting('tm8.session_space_id', true) as pin`;
  type ClaimRow = Record<'identity' | 'actor' | 'node_admin' | 'request' | 'auth_kind' | 'pin', string | null>;
  const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v === '';

  it('agent: all six claims are bound inside the transaction (pin = A)', async () => {
    const claims = await claimsForToken(await mintAgent());
    const [row] = await db.tx(claims, (q) => q.query<ClaimRow>(READ_CLAIMS));
    expect(row).toEqual({
      identity: fixture.identityH,
      actor: fixture.personaA,
      node_admin: 'false',
      request: claims.requestId,
      auth_kind: 'agent',
      pin: fixture.spaceA,
    });
  });

  it('agent: the pin does not leak to the next transaction on the same backend', async () => {
    const shared = createDb(database.url, { max: 1 });
    try {
      const claims = await claimsForToken(await mintAgent());
      const [first] = await shared.tx(claims, (q) => q.query<ClaimRow>(READ_CLAIMS));
      expect(first!.pin).toBe(fixture.spaceA);
      const [second] = await shared.tx({}, (q) => q.query<ClaimRow>(READ_CLAIMS));
      for (const name of ['identity', 'actor', 'request', 'auth_kind', 'pin'] as const) {
        expect(blank(second![name]), name).toBe(true);
      }
      expect(second!.node_admin).not.toBe('true');
    } finally {
      await shared.end();
    }
  });

  it('agent: the pin does not leak after a rolled-back transaction', async () => {
    const shared = createDb(database.url, { max: 1 });
    try {
      const claims = await claimsForToken(await mintAgent());
      await expect(shared.tx(claims, async (q) => {
        await q.query('select 1');
        throw new Error('deliberate failure');
      })).rejects.toThrow('deliberate failure');
      const [after] = await shared.tx({}, (q) => q.query<ClaimRow>(READ_CLAIMS));
      expect(blank(after!.pin)).toBe(true);
      expect(blank(after!.identity)).toBe(true);
    } finally {
      await shared.end();
    }
  });

  it('browser (H): positive — five claims bound, the pin blank', async () => {
    const claims = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    const [row] = await db.tx(claims, (q) => q.query<ClaimRow>(READ_CLAIMS));
    expect(row!.identity).toBe(fixture.identityH);
    expect(row!.auth_kind).toBe('browser');
    expect(blank(row!.pin)).toBe(true);
  });
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

/**
 * B4 (doc 15, W0c; migration 226) — LINKING A PROJECT REQUIRES SEEING IT.
 *
 * `link_project_w2` checked only `require_space_admin`, so an admin of ANY
 * space could link a project that lives only in a space they are not in — by
 * id — and then spawn into its folder. It now also requires `projects_select`'s
 * rule (node admin, or member of a space the project is linked into), and an
 * invisible project answers P0002 exactly like a missing one.
 *
 * Credential: H2's real browser token, resolved by the production resolver
 * with the loopback owner arm OFF and a non-owner fallback, so the claims are
 * the token's and nothing else's. H2 owns space C (added here), is a member of
 * A, and is not in B. The refusal (B's project into C) is paired with the same
 * credential linking A's project — one H2 can see — into the same space C.
 */
describe('B4 link_project — caller must see the project', () => {
  /** Never consulted with disableAutoOwner; a non-owner so a slip cannot escalate. */
  const NOT_THE_OWNER: LoopbackOwner = {
    identityId: 'b4-not-the-owner', accountId: randomUUID(), username: 'b4-not-the-owner',
    isNodeAdmin: false, isOwner: false,
  };
  const spaceC = randomUUID();
  const memberH2C = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  let tokenH2: string;

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.spaces(id, name, created_by_identity) values ($1, 'Cross-space C', $2)`,
        [spaceC, fixture.identityH2],
      );
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'member', $1, 'space')`,
        [memberH2C, spaceC],
      );
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, 'owner', 'H2')`,
        [memberH2C, spaceC, fixture.identityH2],
      );
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1, 'B4 A project', '/tmp/cross-space-b4-a', 'trusted'),
                ($2, 'B4 B project', '/tmp/cross-space-b4-b', 'trusted')`,
        [projectA, projectB],
      );
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($1, $3, $5), ($2, $4, $6)`,
        [fixture.spaceA, fixture.spaceB, projectA, projectB, fixture.memberHA, fixture.memberHB],
      );
    });
    tokenH2 = await mintBrowser(fixture.accountH2, fixture.identityH2);
  });

  /**
   * 'ok', or the SQLSTATE the call raised. The Db layer translates pg errors
   * into CollabError and keeps the raw state in `details.sqlstate`.
   */
  async function outcome(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
      return 'ok';
    } catch (error) {
      const sqlstate = (error as { details?: { sqlstate?: unknown } }).details?.sqlstate;
      if (typeof sqlstate === 'string') return sqlstate;
      throw error;
    }
  }

  /** Resolve the token exactly as the server does, then run fn under its claims. */
  async function asToken<T>(token: string, fn: (q: Querier) => Promise<T>): Promise<T> {
    const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER });
    const identity = await resolve(
      { authorization: `Bearer ${token}` },
      { remoteAddress: '203.0.113.9', disableAutoOwner: true },
    );
    const ctx = { identity, requestId: `b4-${randomUUID()}` } as unknown as RequestContext;
    return db.tx(claimsFor(NOT_THE_OWNER, ctx), fn);
  }

  async function linked(spaceId: string, projectId: string): Promise<boolean> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const rows = await client.query(
        'select 1 from public.space_projects where space_id = $1 and project_id = $2',
        [spaceId, projectId],
      );
      return rows.rowCount === 1;
    });
  }

  it('refuses H2 (admin of C) linking a project that lives only in B into C (P0002)', async () => {
    expect(await outcome(() => asToken(tokenH2, (q) =>
      q.rpc('link_project_w2', [spaceC, projectB, null, `b4-refused-${randomUUID()}`])))).toBe('P0002');
    expect(await linked(spaceC, projectB)).toBe(false);
  });

  it('positive — the same H2 credential links a project it can see (linked into A) into C', async () => {
    expect(await outcome(() => asToken(tokenH2, (q) =>
      q.rpc('link_project_w2', [spaceC, projectA, null, `b4-visible-${randomUUID()}`])))).toBe('ok');
    expect(await linked(spaceC, projectA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T14 / T15 — G6, the member tombstone (migration 232, W1-server).
//
// Each block seeds its OWN principal, so no earlier row's H or H2 loses a
// membership or a session. The command runs through the PRODUCTION handler
// (`registerMembershipHandlers`), with the caller's context built from its
// real bearer by the production resolver, a real `SubscriptionRegistry`
// holding in-memory sockets, and a recording PTY port — so a row fails if the
// SQL, the after-commit step, or the wiring between them drops an effect.
// ---------------------------------------------------------------------------

interface RecordingSink extends EventSink {
  closedWith: { code: number | undefined; reason: string | undefined } | null;
}

function recordingSink(identityId: string): RecordingSink {
  const sink: RecordingSink = {
    id: `t14-conn-${randomUUID()}`,
    identity: { kind: 'bearer', identityId, authKind: 'browser' } as EventSink['identity'],
    closedWith: null,
    get isOpen() { return sink.closedWith === null; },
    send: () => undefined,
    close: (code?: number, reason?: string) => { sink.closedWith = { code, reason }; },
    onMessage: () => undefined,
    onClose: () => undefined,
  };
  return sink;
}

/** The membership handlers, wired to a real registry, sockets and a recording PTY port. */
function membershipHarness() {
  const sockets = new SubscriptionRegistry();
  const killed: string[] = [];
  const contained: string[] = [];
  const registry = new HandlerRegistry();
  const facade = { db, config: {}, owner: async () => NOT_THE_OWNER } as unknown as FacadeDeps;
  registerMembershipHandlers(registry, facade, {
    sockets,
    sessions: {
      killRecordedEnding: async (id) => { killed.push(id); return 'killed'; },
      containCredentialSession: async (id) => { contained.push(id); return { outcome: 'killed' }; },
    },
    log: () => undefined,
  });
  const run = async (
    token: string,
    opName: 'spaces.leave' | 'spaces.members.remove' | 'accounts.disable',
    params: Record<string, string>,
    body: unknown,
  ): Promise<Record<string, unknown>> => {
    const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
    const identity = await resolve(
      { authorization: `Bearer ${token}` },
      { remoteAddress: '203.0.113.9', disableAutoOwner: true },
    );
    const ctx = {
      op: { name: opName, method: 'POST', path: '/test', kind: 'command', status: 'v1' },
      opName, params, query: new URLSearchParams(), body,
      requestId: `t14-${randomUUID()}`, identity, headers: {}, method: 'POST', path: '/test',
    } as unknown as RequestContext;
    return (await registry.get(opName)!(ctx)) as Record<string, unknown>;
  };
  return { sockets, killed, contained, run };
}

describe.sequential('T14 spaces.leave — L leaves B; B refuses L, A still admits L', () => {
  const identityL = `t14-l-${randomUUID()}`;
  const accountL = randomUUID();
  const memberLA = randomUUID();
  const memberLB = randomUUID();
  const personaLB = randomUUID();
  const workSessionLB = randomUUID();
  let browserL: string;
  let agentLB: string;
  let harness: ReturnType<typeof membershipHarness>;
  let sinkB: RecordingSink;
  let sinkA: RecordingSink;
  let sinkH: RecordingSink;

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'L')`, [identityL]);
      await client.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 't14-l')`,
        [accountL, identityL]);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values
         ($1, $3, 'member', $1, 'space'),
         ($2, $4, 'member', $2, 'space'),
         ($5, $4, 'team_member', $2, 'space'),
         ($6, $4, 'work_session', $5, 'space')`,
        [memberLA, memberLB, fixture.spaceA, fixture.spaceB, personaLB, workSessionLB],
      );
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $3, $5, 'member', 'L'), ($2, $4, $5, 'member', 'L')`,
        [memberLA, memberLB, fixture.spaceA, fixture.spaceB, identityL],
      );
      await client.query(
        `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
         values ($1, $2, 'T14 persona', 'worker', 'persona')`,
        [personaLB, memberLB],
      );
      await client.query(
        `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
         values ($1, 'T14 run in B', 'running', 'none', now())`,
        [workSessionLB],
      );
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'participates_in', $2)`,
        [fixture.spaceB, personaLB, workSessionLB],
      );
    });
    browserL = await mintBrowser(accountL, identityL);
    const secret = generateSecret();
    const row = await asIdentity(identityL, (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      workSessionLB, personaLB, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'T14 agent in B',
    ]));
    agentLB = formatToken(row.id, secret);

    harness = membershipHarness();
    sinkB = recordingSink(identityL);
    sinkA = recordingSink(identityL);
    sinkH = recordingSink(fixture.identityH);
    for (const sink of [sinkB, sinkA, sinkH]) harness.sockets.add(sink);
    harness.sockets.subscribe(sinkB.id, fixture.spaceB);
    harness.sockets.subscribe(sinkA.id, fixture.spaceA);
    harness.sockets.subscribe(sinkH.id, fixture.spaceB);
  });

  it('before: L\'s browser reads and writes B, and L\'s agent token reads B', async () => {
    expect(await asToken(browserL, (q) => idsIn(q, fixture.spaceB))).toContain(fixture.docB);
    expect(await outcome(() => recordEtag(browserL, fixture.spaceB))).toBe('ok');
    expect(await asToken(agentLB, (q) => idsIn(q, fixture.spaceB))).toContain(fixture.docB);
  });

  it('L leaves B through spaces.leave; the member row is kept with status left', async () => {
    const result = await harness.run(browserL, 'spaces.leave', { spaceId: fixture.spaceB },
      { clientMutationId: `t14-${randomUUID()}` });
    expect(result).toMatchObject({ spaceId: fixture.spaceB, memberId: memberLB, status: 'left' });
    expect(result).not.toHaveProperty('identityId');
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ status: string }>(
        'select status from public.members where entity_id = $1', [memberLB])).rows;
    });
    expect(rows).toEqual([{ status: 'left' }]);
  });

  for (const mode of ['agents', 'enforce'] as const) {
    it(`[${mode}] refused: L's browser reads nothing in B`, async () => {
      expect(await asToken(browserL, (q) => idsIn(q, fixture.spaceB), mode)).toEqual([]);
    });

    it(`[${mode}] positive: the same browser credential still reads A`, async () => {
      expect(await asToken(browserL, (q) => idsIn(q, fixture.spaceA), mode)).toContain(fixture.docA);
    });

    it(`[${mode}] refused: L's browser writes nothing in B (42501)`, async () => {
      expect(await outcome(() => recordEtag(browserL, fixture.spaceB, mode))).toBe('42501');
      expect(await outcome(() => editDoc(browserL, fixture.docB, mode))).not.toBe('ok');
    });

    it(`[${mode}] positive: the same browser credential still writes A`, async () => {
      expect(await outcome(() => recordEtag(browserL, fixture.spaceA, mode))).toBe('ok');
    });

    it(`[${mode}] refused: L's agent token pinned to B no longer resolves`, async () => {
      expect(await outcome(() => asToken(agentLB, (q) => idsIn(q, fixture.spaceB), mode))).toBe('unauthenticated');
    });
  }

  it('the open socket on B closed with 1008 before the command returned; A\'s socket and H\'s stay open', () => {
    expect(sinkB.closedWith).toEqual({ code: 1008, reason: 'membership ended' });
    expect(sinkA.isOpen).toBe(true);
    expect(sinkH.isOpen).toBe(true);
  });

  it('L\'s agent session in B is recorded exited and its PTY was killed', async () => {
    expect(harness.killed).toEqual([workSessionLB]);
    const [ws] = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ status: string; ended_kind: string }>(
        'select status, ended_kind from public.work_sessions where entity_id = $1', [workSessionLB])).rows;
    });
    expect(ws).toEqual({ status: 'exited', ended_kind: 'stopped_by_operator' });
  });
});

describe.sequential('T15 accounts.disable — every session of the account is refused', () => {
  const identityN = `t15-admin-${randomUUID()}`;
  const accountN = randomUUID();
  const identityX = `t15-x-${randomUUID()}`;
  const accountX = randomUUID();
  const memberXA = randomUUID();
  let adminToken: string;
  let browserX: string;
  let secondBrowserX: string;
  let harness: ReturnType<typeof membershipHarness>;
  let sinkX: RecordingSink;

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name) values ($1, 'N'), ($2, 'X')`,
        [identityN, identityX]);
      await client.query(
        `insert into public.accounts(id, identity_id, username, is_node_admin)
         values ($1, $2, 't15-admin', true), ($3, $4, 't15-x', false)`,
        [accountN, identityN, accountX, identityX]);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'member', $1, 'space')`, [memberXA, fixture.spaceA]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, 'member', 'X')`, [memberXA, fixture.spaceA, identityX]);
    });
    adminToken = await mintBrowser(accountN, identityN);
    browserX = await mintBrowser(accountX, identityX);
    secondBrowserX = await mintBrowser(accountX, identityX);
    harness = membershipHarness();
    sinkX = recordingSink(identityX);
    harness.sockets.add(sinkX);
    harness.sockets.subscribe(sinkX.id, fixture.spaceA);
  });

  it('before: both of X\'s sessions read A', async () => {
    for (const token of [browserX, secondBrowserX]) {
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceA))).toContain(fixture.docA);
    }
  });

  it('refused: X cannot disable the admin (42501) — the command is node-admin-only', async () => {
    expect(await outcome(() => harness.run(browserX, 'accounts.disable', { accountId: accountN },
      { clientMutationId: `t15-${randomUUID()}` }))).toBe('42501');
  });

  it('the admin disables X', async () => {
    const result = await harness.run(adminToken, 'accounts.disable', { accountId: accountX },
      { clientMutationId: `t15-${randomUUID()}` });
    expect(result).toMatchObject({ accountId: accountX, status: 'disabled', revokedSessionCount: 2 });
    expect(result).not.toHaveProperty('identityId');
  });

  it('refused: every one of X\'s sessions is refused by the resolver', async () => {
    for (const token of [browserX, secondBrowserX]) {
      expect(await outcome(() => asToken(token, (q) => idsIn(q, fixture.spaceA)))).toBe('unauthenticated');
    }
  });

  it('positive: the admin\'s own session still resolves after the disable', async () => {
    expect(await outcome(() => asToken(adminToken, (q) => idsIn(q, fixture.spaceA)))).toBe('ok');
  });

  it('X\'s open socket closed with 1008', () => {
    expect(sinkX.closedWith).toEqual({ code: 1008, reason: 'account disabled' });
  });

  it('the membership row is untouched: the graph keeps who acted', async () => {
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ status: string }>(
        'select status from public.members where entity_id = $1', [memberXA])).rows;
    });
    expect(rows).toEqual([{ status: 'active' }]);
  });
});

// ---------------------------------------------------------------------------
// W6 — space links (migrations 243/244). H holds a `link` session from A for
// B: kind `link`, pinned to B, sealed in H's own space_link_tokens row. The
// mechanism is pinned in space-links.pg.test.ts; these are the matrix cells.
// ---------------------------------------------------------------------------

/** A second-identity member of A and B (T17 needs someone other than H). */
async function seedMemberOfAB(label: string): Promise<{ identity: string; account: string; memberA: string; memberB: string }> {
  const ids = {
    identity: `cross-space-${label}-${randomUUID()}`,
    account: randomUUID(), memberA: randomUUID(), memberB: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $2)`, [ids.identity, label]);
    await client.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, $3)`,
      [ids.account, ids.identity, `cross-space-${label}-${ids.account.slice(0, 8)}`]);
    for (const [member, space] of [[ids.memberA, fixture.spaceA], [ids.memberB, fixture.spaceB]] as const) {
      await client.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [member, space]);
      await client.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $4)`,
        [member, space, ids.identity, label]);
    }
  });
  return ids;
}

let linkStore: DbSpaceLinkStore;
let linkDataDir: string;
let hLink: SpaceLink;
/** H's stored link session for B, as the use path returns it. Never printed. */
let hLinkToken: string;

async function linkLoginAs(accountId: string, identityId: string): Promise<{ link: SpaceLink; token: string }> {
  const claims = await claimsForToken(await mintBrowser(accountId, identityId));
  const added = await linkStore.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
  const link = await linkStore.login(claims, added.id);
  return { link, token: (await linkStore.use(claims, link.id)).token };
}

/** Idempotent: every W6 block calls it, so a `-t` filter on one block still sets up. */
async function ensureHLink(): Promise<void> {
  if (hLinkToken) return;
  linkDataDir = await mkdtemp(join(tmpdir(), 'tm8-cross-space-links-'));
  linkStore = new DbSpaceLinkStore({ db, dataDir: linkDataDir });
  ({ link: hLink, token: hLinkToken } = await linkLoginAs(fixture.accountH, fixture.identityH));
}

describe.sequential('W6 space links — H\'s link session A → B', () => {
  beforeAll(ensureHLink);

  it('the stored session is kind link, pinned to B', async () => {
    const claims = await claimsForToken(hLinkToken);
    expect(claims).toMatchObject({ identityId: fixture.identityH, authKind: 'link', sessionSpaceId: fixture.spaceB });
  });
});

describe.sequential('T16 L_B after B revokes it: G invokes B → 401 → signed_out, no retry', () => {
  beforeAll(ensureHLink);

  it('positive — before the revoke, G (H\'s agent) uses the link and resolves in B as kind link', async () => {
    const g = await claimsForToken(await mintAgent());
    const use = await linkStore.use(g, hLink.id, { workSessionId: fixture.workSessionA });
    expect(use.targetSpaceId).toBe(fixture.spaceB);
    expect(await claimsForToken(use.token)).toMatchObject({ authKind: 'link', sessionSpaceId: fixture.spaceB });
  });

  it('B revokes the link session; G\'s next use is signed_out, forgets the bytes, notifies G\'s session once, and never retries', async () => {
    const notices: SpaceLinkStaleNotice[] = [];
    const store = new DbSpaceLinkStore({ db, dataDir: linkDataDir, onStale: (n) => { notices.push(n); } });
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    // The revoke on this base: revoke_auth_session as the session's owner. W4's
    // Sessions page (238, auth.sessions.revoke by a B admin) reaches the same row.
    await db.rpc(h, 'revoke_auth_session', [hLink.mine!.sessionId]);
    await expect(claimsForToken(hLinkToken)).rejects.toBeTruthy();

    const g = await claimsForToken(await mintAgent());
    await expect(store.use(g, hLink.id, { workSessionId: fixture.workSessionA }))
      .rejects.toMatchObject({ status: 'signed_out' });
    expect(notices).toEqual([{ linkId: hLink.id, status: 'signed_out', callerWorkSessionId: fixture.workSessionA }]);
    const [row] = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ status: string; ciphertext: Buffer | null; auth_session_id: string | null }>(
        'select status, ciphertext, auth_session_id from public.space_link_tokens where link_id = $1 and member_id = $2',
        [hLink.id, fixture.memberHA])).rows;
    });
    expect(row).toEqual({ status: 'signed_out', ciphertext: null, auth_session_id: null });

    // No retry: refused in SQL before any resolve, and no second notice.
    await expect(store.use(g, hLink.id, { workSessionId: fixture.workSessionA })).rejects.toBeInstanceOf(SpaceLinkUnusable);
    expect(notices).toHaveLength(1);
    // G cannot sign it back in (human-only) — the paired positive is H's relogin.
    await expect(store.login(g, hLink.id, { relogin: true })).rejects.toBeTruthy();
    hLink = await store.login(h, hLink.id, { relogin: true });
    hLinkToken = (await store.use(g, hLink.id)).token;
    expect(await claimsForToken(hLinkToken)).toMatchObject({ authKind: 'link', sessionSpaceId: fixture.spaceB });
  });
});

describe.sequential('T19 link token copied to another row does not open (a1, AAD home|link|member|target)', () => {
  beforeAll(ensureHLink);
  const sealedOf = async (memberId: string) => {
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ ciphertext: Buffer; nonce: Buffer }>(
        'select ciphertext, nonce from public.space_link_tokens where link_id = $1 and member_id = $2',
        [hLink.id, memberId])).rows;
    });
    return rows[0]!;
  };
  const bindingFor = (memberId: string, overrides: Partial<{ homeSpaceId: string; linkId: string; targetSpaceId: string }> = {}) => ({
    homeSpaceId: fixture.spaceA, linkId: hLink.id, memberId, targetSpaceId: fixture.spaceB, ...overrides,
  });

  it('positive — H\'s sealed session opens under H\'s own row binding', async () => {
    const key = await loadOrCreateCredentialKey(linkDataDir);
    expect(openSecret(key, await sealedOf(fixture.memberHA), bindingFor(fixture.memberHA)).startsWith('tm8s_')).toBe(true);
  });

  it('refused — the same bytes under another member\'s binding (H2)', async () => {
    const key = await loadOrCreateCredentialKey(linkDataDir);
    const sealed = await sealedOf(fixture.memberHA);
    expect(() => openSecret(key, sealed, bindingFor(fixture.memberH2A))).toThrow();
  });

  it('refused — the same bytes under another link or another target', async () => {
    const key = await loadOrCreateCredentialKey(linkDataDir);
    const sealed = await sealedOf(fixture.memberHA);
    expect(() => openSecret(key, sealed, bindingFor(fixture.memberHA, { linkId: randomUUID() }))).toThrow();
    expect(() => openSecret(key, sealed, bindingFor(fixture.memberHA, { targetSpaceId: fixture.spaceA }))).toThrow();
  });
});

describe.sequential('T20 link session for B reads or writes A — refused', () => {
  beforeAll(ensureHLink);
  it('refused — A\'s doc is invisible to H\'s link session', async () => {
    const ids = await asToken(hLinkToken, (q) => idsIn(q, fixture.spaceA));
    expect(ids).not.toContain(fixture.docA);
  });

  it('refused — editing A\'s doc with H\'s link session', async () => {
    expect(await outcome(() => editDoc(hLinkToken, fixture.docA))).not.toBe('ok');
    expect(await outcome(() => recordEtag(hLinkToken, fixture.spaceA))).toBe('42501');
  });

  it('positive — the same link session reads and edits B\'s doc', async () => {
    expect(await asToken(hLinkToken, (q) => idsIn(q, fixture.spaceB))).toContain(fixture.docB);
    expect(await outcome(() => editDoc(hLinkToken, fixture.docB))).toBe('ok');
  });
});

describe.sequential('T20b link session in B — credential management refused, the rest as the member', () => {
  beforeAll(ensureHLink);
  // E2: credential MANAGEMENT refuses `link` through the strict gate
  // (internal.require_human_auth_kind, unchanged). Decision 31 / T22: invites,
  // roles and delete are forwarded as the member.
  it('refused — set_space_credential_policy in B (strict gate, 42501)', async () => {
    expect(await outcome(() => asToken(hLinkToken, (q) =>
      q.rpc('set_space_credential_policy', [fixture.spaceB, 'anthropic', null])))).toBe('42501');
  });

  it('positive — H (browser) sets the same policy in B', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('set_space_credential_policy', [fixture.spaceB, 'anthropic', null])))).toBe('ok');
  });

  it('refused — spaceLinks management (add) with the link session', async () => {
    expect(await outcome(async () => linkStore.add(await claimsForToken(hLinkToken),
      { spaceId: fixture.spaceB, targetSpaceId: fixture.spaceA }))).toBe('42501');
  });

  it('admitted — spaceLinks.list in B with the link session', async () => {
    expect(await outcome(async () => linkStore.list(await claimsForToken(hLinkToken), fixture.spaceB))).toBe('ok');
  });

  it('refused — spaceLinks.list for A with the B-pinned link session (fails closed)', async () => {
    expect(await outcome(async () => linkStore.list(await claimsForToken(hLinkToken), fixture.spaceA))).not.toBe('ok');
  });

  it('admitted as the member — create_invite in B', async () => {
    expect(await outcome(() => asToken(hLinkToken, (q) =>
      q.rpc('create_invite', [fixture.spaceB, 1, null, null, `w6-t20b-invite-${randomUUID()}`])))).toBe('ok');
  });

  it('admitted as the member — set_member_role in B', async () => {
    const other = await seedMemberOfAB('t20b-role');
    expect(await outcome(() => asToken(hLinkToken, (q) =>
      q.rpc('set_member_role', [fixture.spaceB, other.memberB, 'admin', null, `w6-t20b-role-${randomUUID()}`])))).toBe('ok');
  });

  it('admitted as the member — delete_entity in B', async () => {
    const doc = await asIdentity(fixture.identityH, async (q) =>
      (await q.rpc<{ id?: string; entity?: { id: string } }>('create_document', [fixture.spaceB, 'W6 delete me'])))
      .then((row) => (row.entity?.id ?? row.id)!);
    expect(await outcome(() => asToken(hLinkToken, (q) =>
      q.rpc('delete_entity', [doc, null, `w6-t20b-delete-${randomUUID()}`])))).toBe('ok');
  });

  it('KNOWN GAP 01a0db78-f1ab: start_chat in B is REFUSED for a link session (strict gate)', async () => {
    expect(await outcome(() => asToken(hLinkToken, (q) => q.rpc('start_chat', [
      randomUUID(), fixture.spaceB, fixture.personaA, 'claude-opus-5', 'anthropic', 'claude-code',
      'ask', 'scratch', null, randomUUID(), '/tmp/tm8-cross-space', 'W6 gap', 'hello', [], null,
      `w6-gap-${randomUUID()}`,
    ])))).toBe('42501');
  });

  it('positive for the gap — H (browser) with the same arguments gets past the gate', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => asToken(token, (q) => q.rpc('start_chat', [
      randomUUID(), fixture.spaceB, fixture.personaA, 'claude-opus-5', 'anthropic', 'claude-code',
      'ask', 'scratch', null, randomUUID(), '/tmp/tm8-cross-space', 'W6 gap', 'hello', [], null,
      `w6-gap-${randomUUID()}`,
    ])))).not.toBe('42501');
  });
});

describe.sequential('T28 link visibility — every home member sees the link, only the holder sees a token row', () => {
  beforeAll(ensureHLink);
  it('H2 (A only) sees the link in A, with no target name (P8) and no row of their own', async () => {
    const h2 = await claimsForToken(await mintBrowser(fixture.accountH2, fixture.identityH2));
    const listed = await linkStore.list(h2, fixture.spaceA);
    const seen = listed.find((l) => l.id === hLink.id);
    expect(seen).toMatchObject({ targetSpaceId: fixture.spaceB, targetSpaceName: null, mine: null });
    expect(JSON.stringify(listed)).not.toMatch(/ciphertext|nonce|tm8s_/i);
  });

  it('H2 cannot read H\'s token row', async () => {
    const rows = await asIdentity(fixture.identityH2, (q) =>
      q.query('select id from public.space_link_tokens where link_id = $1', [hLink.id]));
    expect(rows).toHaveLength(0);
  });

  it('positive — H sees the target\'s name and H\'s own row', async () => {
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    const seen = (await linkStore.list(h, fixture.spaceA)).find((l) => l.id === hLink.id);
    expect(seen).toMatchObject({ targetSpaceName: 'Cross-space B', mine: { memberId: fixture.memberHA, status: 'signed_in' } });
  });

  it('the A link is not listed in B', async () => {
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    expect((await linkStore.list(h, fixture.spaceB)).map((l) => l.id)).not.toContain(hLink.id);
  });
});

describe.sequential('T17 leave / remove ends a member\'s link sessions', () => {
  beforeAll(ensureHLink);
  it('X removed from A (home): X\'s link session no longer resolves, X\'s rows are gone', async () => {
    const x = await seedMemberOfAB('t17-x');
    const { token } = await linkLoginAs(x.account, x.identity);
    expect(await outcome(() => asToken(token, (q) => idsIn(q, fixture.spaceB)))).toBe('ok');
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    await db.rpc(h, 'remove_space_member', [fixture.spaceA, x.memberA, `w6-t17-remove-${randomUUID()}`]);
    expect(await outcome(() => asToken(token, (q) => idsIn(q, fixture.spaceB)))).toBe('unauthenticated');
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query('select id from public.space_link_tokens where member_id = $1', [x.memberA])).rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('Y leaves B (target): Y\'s row turns left and the link session no longer resolves', async () => {
    const y = await seedMemberOfAB('t17-y');
    const { link, token } = await linkLoginAs(y.account, y.identity);
    const yClaims = await claimsForToken(await mintBrowser(y.account, y.identity));
    await db.rpc(yClaims, 'leave_space', [fixture.spaceB, `w6-t17-leave-${randomUUID()}`]);
    expect(await outcome(() => asToken(token, (q) => idsIn(q, fixture.spaceB)))).toBe('unauthenticated');
    const mine = (await linkStore.list(yClaims, fixture.spaceA)).find((l) => l.id === link.id)?.mine;
    expect(mine).toMatchObject({ status: 'left', sessionId: null });
  });

  it('positive — H\'s link session on the same link still resolves in B', async () => {
    expect(await outcome(() => asToken(hLinkToken, (q) => idsIn(q, fixture.spaceB)))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// W7 spaceLinks.invoke (990). Over HTTP on a bootstrapped node whose data dir
// is the link store's, so the node key that sealed H's row opens it. The
// caller is G, H's agent in A. Every refusal is paired with a positive.
//
// Strict gate (internal.require_human_auth_kind): no W7 cell reaches it. The
// refused set is refused on the home server before anything is unsealed, and
// every forwarded op here (entities.create/get/patch/delete, invites, member
// role, spaceLinks.list) is a member op. W6 T20b pins the gate itself.
// ---------------------------------------------------------------------------

interface InvokeResponse {
  status: number;
  body: { data?: { result: unknown; auditId: string; linkId: string; targetSpaceId: string }; error?: { code: string; message: string; details?: Record<string, unknown> } };
}

describe.sequential('W7 spaceLinks.invoke — G runs one op in B as H, audited in A', () => {
  let node: BootstrappedServer;
  let ownerBefore: Array<{ id: string; is_node_admin: boolean; is_owner: boolean }> = [];
  let gToken: string;
  const logged: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    await ensureHLink();
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      const original = console[method].bind(console);
      spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        original(...args);
      }));
    }
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      ownerBefore = (await client.query<{ id: string; is_node_admin: boolean; is_owner: boolean }>(
        'select id::text, is_node_admin, is_owner from public.accounts where id = any($1::uuid[])',
        [[fixture.accountH, fixture.accountH2]])).rows;
      await client.query(
        'update public.accounts set is_node_admin = (id = $1::uuid), is_owner = (id = $1::uuid) where id = any($2::uuid[])',
        [fixture.accountH, [fixture.accountH, fixture.accountH2]]);
    });
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_NODE_MODE: 'single',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: linkDataDir,
      TM8_DISABLE_AUTO_OWNER: '1',
    });
    node = await bootstrap({ config: { ...configured, port: 0 } });
    gToken = await mintAgent();
  }, 180_000);

  afterAll(async () => {
    await node?.server.close();
    await node?.db?.end();
    for (const spy of spies) spy.mockRestore();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      for (const row of ownerBefore) {
        await client.query('update public.accounts set is_node_admin = $2, is_owner = $3 where id = $1::uuid',
          [row.id, row.is_node_admin, row.is_owner]);
      }
    });
  }, 180_000);

  async function call(method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<InvokeResponse> {
    const response = await fetch(new URL(path, node.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as InvokeResponse['body'] };
  }

  const invoke = (
    token: string,
    input: { op: string; params?: Record<string, string>; query?: Record<string, string>; input?: unknown },
    { ref = hLink.id, headers = {} }: { ref?: string; headers?: Record<string, string> } = {},
  ): Promise<InvokeResponse> =>
    call('POST', `/v2/spaces/${fixture.spaceA}/space-links/${ref}/invoke`, token, input, headers);

  const refusalOf = (res: InvokeResponse): unknown => res.body.error?.details?.['refusal'];
  const cmid = (label: string): string => `w7-${label}-${randomUUID()}`;

  /** The audit rows in A, read as the graph owner (the table has no tm8_app grant). */
  const auditRows = (where: string, args: unknown[]): Promise<Array<Record<string, unknown>>> =>
    database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query(`select * from public.cross_space_audit where ${where} order by created_at`, args)).rows;
    });
  const auditById = async (id: string): Promise<Record<string, unknown>> => (await auditRows('id = $1', [id]))[0]!;
  /** The newest audit row for `op` by H's member in A. */
  const lastAudit = async (op: string): Promise<Record<string, unknown>> =>
    (await auditRows('member_id = $1 and op = $2', [fixture.memberHA, op])).at(-1)!;

  async function createInB(title: string): Promise<string> {
    const res = await invoke(gToken, {
      op: 'entities.create',
      input: { spaceId: fixture.spaceB, kind: 'doc', title, clientMutationId: cmid('create') },
    });
    expect(res.status).toBe(200);
    const result = res.body.data!.result as { id?: string; entity?: { id: string } };
    return (result.entity?.id ?? result.id)!;
  }

  // ---- a1 / T21 -----------------------------------------------------------

  it('T21 — G creates a document in B through the link; B records H\'s B member as the actor; one ok audit row in A', async () => {
    const res = await invoke(gToken, {
      op: 'entities.create',
      input: { spaceId: fixture.spaceB, kind: 'doc', title: 'W7 T21', clientMutationId: cmid('t21') },
    });
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    const result = res.body.data!.result as { id?: string; entity?: { id: string } };
    const created = (result.entity?.id ?? result.id)!;
    expect(res.body.data).toMatchObject({ linkId: hLink.id, targetSpaceId: fixture.spaceB });
    const [row] = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ space_id: string; created_by: string }>(
        'select space_id::text, created_by::text from public.entities where id = $1', [created])).rows;
    });
    expect(row).toEqual({ space_id: fixture.spaceB, created_by: fixture.memberHB });
    expect(await auditById(res.body.data!.auditId)).toMatchObject({
      link_id: hLink.id, home_space_id: fixture.spaceA, target_space_id: fixture.spaceB,
      member_id: fixture.memberHA, team_member_id: fixture.personaA, work_session_id: fixture.workSessionA,
      op: 'entities.create', result: 'ok', reason: null, remote_id: created, via_chain: [],
    });
  });

  it('T21 — the forwarded session is kind link pinned to B: G cannot reach A\'s doc through it', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docA } });
    expect(res.status).toBe(404);
    expect((await lastAudit('entities.get')).result).toBe('error');
  });

  it('T21 positive — the same op on B\'s doc through the link returns it', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data!.result)).toContain(fixture.docB);
  });

  // ---- a2 / T22: refused on the home server before forwarding -------------

  it.each([
    ['credentials.status', {}, 'credential_management'],
    ['credentials.delete', { params: { provider: 'anthropic' }, input: { clientMutationId: 'x' } }, 'credential_management'],
    ['credentials.space.list', { params: { spaceId: 'B' } }, 'credential_management'],
    ['credentials.space.policy.set', { params: { spaceId: 'B', provider: 'anthropic' }, input: { clientMutationId: 'x' } }, 'credential_management'],
    ['node.credentials.status', {}, 'credential_management'],
    ['node.credentials.policy.set', { params: { provider: 'anthropic' }, input: { clientMutationId: 'x' } }, 'credential_management'],
    ['spaceLinks.add', { params: { spaceId: 'B' }, input: { targetSpaceId: 'A', clientMutationId: 'x' } }, 'link_management'],
    ['spaceLinks.setSpawn', { params: { linkId: 'L' }, input: { allowSpawn: true, clientMutationId: 'x' } }, 'link_management'],
    ['spaceLinks.invoke', { params: { spaceId: 'B', link: 'L' }, input: { op: 'entities.get' } }, 'link_management'],
    ['auth.session.get', {}, 'session_minting'],
    ['auth.logout', { input: { clientMutationId: 'x' } }, 'session_minting'],
  ] as const)('T22 refused — %s (%s)', async (op, shape, reason) => {
    const res = await invoke(gToken, { op, ...(shape as object) });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden', details: { reason: 'space_link_refused', refusal: reason } });
    expect(await lastAudit(op)).toMatchObject({ result: 'refused', reason, link_id: null, target_space_id: null });
  });

  it('T22 refused — a future credentials.* op is caught by the prefix, not a list', () => {
    expect(spaceLinkRefusal('credentials.future.rotate', 'command', {}, true)).toBe('credential_management');
    expect(spaceLinkRefusal('node.credentials.future', 'read', {}, true)).toBe('credential_management');
    expect(spaceLinkRefusal('auth.future.mint', 'read', {}, true)).toBe('session_minting');
  });

  it('T22 positive — spaceLinks reads are not writes: spaceLinks.list in B passes as the member', async () => {
    expect(spaceLinkRefusal('spaceLinks.list', 'read', {}, true)).toBeNull();
    const res = await invoke(gToken, { op: 'spaceLinks.list', params: { spaceId: fixture.spaceB } });
    expect(res.status).toBe(200);
  });

  it('T22 positive — spaces.invites.create in B passes as the member', async () => {
    const res = await invoke(gToken, {
      op: 'spaces.invites.create', params: { spaceId: fixture.spaceB },
      input: { maxUses: 1, clientMutationId: cmid('invite') },
    });
    expect(res.status).toBe(200);
    expect((await lastAudit('spaces.invites.create')).result).toBe('ok');
  });

  it('T22 positive — spaces.members.updateRole in B passes as the member', async () => {
    const other = await seedMemberOfAB('w7-role');
    const res = await invoke(gToken, {
      op: 'spaces.members.updateRole', params: { spaceId: fixture.spaceB, memberId: other.memberB },
      input: { role: 'admin', clientMutationId: cmid('role') },
    });
    expect(res.status).toBe(200);
  });

  it('T22 positive — entities.delete in B passes as the member', async () => {
    const doc = await createInB('W7 delete me');
    const res = await invoke(gToken, {
      op: 'entities.delete', params: { id: doc }, input: { clientMutationId: cmid('delete') },
    });
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
  });

  // ---- canonical op id (coordinator addition 1) ---------------------------

  it('canonical — an unknown op is refused, audited as (unknown)', async () => {
    const res = await invoke(gToken, { op: 'nothing.here' });
    expect(res.status).toBe(403);
    expect(refusalOf(res)).toBe('unknown_op');
    expect((await auditRows('member_id = $1 and op = $2', [fixture.memberHA, '(unknown)'])).length).toBeGreaterThan(0);
  });

  it('canonical — a case variant (Credentials.status) is refused, never folded to a pass', async () => {
    const res = await invoke(gToken, { op: 'Credentials.status' });
    expect(res.status).toBe(403);
    expect(refusalOf(res)).toBe('unknown_op');
  });

  it('canonical — a name that only CONTAINS credentials is not credential management (the prefix is anchored)', async () => {
    // No catalog op contains "credentials" outside the refused prefixes, so
    // the pure rule is the cell: an anchored prefix does not over-refuse.
    expect(spaceLinkRefusal('spaces.credentialsSummary', 'read', {}, true)).toBeNull();
    expect(spaceLinkRefusal('entities.get', 'read', { title: 'credentials.status' }, true)).toBeNull();
    // Over the wire the same made-up name is still unknown, not credential management.
    expect(refusalOf(await invoke(gToken, { op: 'spaces.credentialsSummary' }))).toBe('unknown_op');
  });

  it('canonical positive — the exact catalog spelling of a member op passes', async () => {
    expect((await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } })).status).toBe(200);
  });

  // ---- a3 / T18 ------------------------------------------------------------

  it('T18 — H2\'s agent in A cannot use H\'s link (no row of H2\'s): not_found, nothing forwarded', async () => {
    const h2 = await seedAgentFor(fixture.identityH2, fixture.memberH2A);
    const before = (await auditRows('member_id = $1', [fixture.memberHA])).length;
    for (const ref of [hLink.id, hLink.mine?.alias ?? hLink.id]) {
      const res = await invoke(h2, { op: 'entities.get', params: { id: fixture.docB } }, { ref });
      expect(res.status).toBe(404);
      expect(res.body.error?.message).toContain('tm8 link add');
    }
    expect((await auditRows('member_id = $1', [fixture.memberHA])).length).toBe(before);
    expect(await auditRows('member_id = $1 and op = $2', [fixture.memberH2A, 'entities.get']))
      .toEqual(expect.arrayContaining([expect.objectContaining({ result: 'refused', reason: 'not_linked', link_id: null })]));
  });

  it('T18 positive — H\'s own agent G on the same link reads B', async () => {
    expect((await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } })).status).toBe(200);
  });

  // ---- a4 / T24 ------------------------------------------------------------

  it('T24 — a chain already containing A (the home) is refused', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } },
      { headers: { [SPACE_LINK_VIA_HEADER]: fixture.spaceA } });
    expect(refusalOf(res)).toBe('via_loop');
  });

  it('T24 — a chain already containing B (the target) is refused', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } },
      { headers: { [SPACE_LINK_VIA_HEADER]: fixture.spaceB } });
    expect(refusalOf(res)).toBe('via_loop');
    expect((await lastAudit('entities.get')).via_chain).toEqual([fixture.spaceB]);
  });

  it('T24 — more than 2 hops is refused', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } },
      { headers: { [SPACE_LINK_VIA_HEADER]: `${randomUUID()},${randomUUID()}` } });
    expect(refusalOf(res)).toBe('via_hops');
  });

  it('T24 — a malformed chain is refused', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } },
      { headers: { [SPACE_LINK_VIA_HEADER]: 'not-a-space' } });
    expect(refusalOf(res)).toBe('via_hops');
  });

  it('T24 positive — one prior hop through a third space passes (2 hops)', async () => {
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } },
      { headers: { [SPACE_LINK_VIA_HEADER]: randomUUID() } });
    expect(res.status).toBe(200);
  });

  // ---- a5 / T23 ------------------------------------------------------------

  const spawnInput = (extra: Record<string, unknown> = {}) => ({
    op: 'execution.spawn',
    input: { spaceId: fixture.spaceB, clientMutationId: cmid('spawn'), ...extra },
  });

  it('T23 positive — a new link defaults to allow_spawn; a default spawn passes the link guard', async () => {
    // The guard admits it; the spawn itself then answers on its own terms
    // (this input names no teammate) — nothing is launched on this box.
    const res = await invoke(gToken, spawnInput());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'invalid_input' });
    expect(res.body.error?.details?.['reason']).not.toBe('space_link_refused');
    // Past the guard, the spawn's own schema answered, and that is audited too.
    expect(await lastAudit('execution.spawn')).toMatchObject({ result: 'error', reason: 'invalid_input', link_id: hLink.id });
  });

  it('T23 — explicit credentialSources is refused (F9)', async () => {
    const res = await invoke(gToken, spawnInput({ credentialSources: { anthropic: 'personal' } }));
    expect(refusalOf(res)).toBe('spawn_explicit_credentials');
  });

  it('T23 / K11 — an explicit space credential id is refused', async () => {
    const res = await invoke(gToken, spawnInput({ spaceCredentialIds: [randomUUID()] }));
    expect(refusalOf(res)).toBe('spawn_explicit_credentials');
  });

  it('T23 — allow_spawn off is refused; positive — a non-spawn op on the same link still passes', async () => {
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    await linkStore.setSpawn(h, { linkId: hLink.id, allowSpawn: false });
    try {
      expect(refusalOf(await invoke(gToken, spawnInput()))).toBe('spawn_switch_off');
      expect((await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } })).status).toBe(200);
    } finally {
      await linkStore.setSpawn(h, { linkId: hLink.id, allowSpawn: true });
    }
  });

  // ---- a8 / T28: read B, write A ------------------------------------------

  it('T28 — an injected agent reading B then writing into A is allowed, and the read is audited in A', async () => {
    const read = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } });
    expect(read.status).toBe(200);
    expect(await auditById(read.body.data!.auditId)).toMatchObject({
      op: 'entities.get', result: 'ok', remote_id: fixture.docB, home_space_id: fixture.spaceA,
      work_session_id: fixture.workSessionA,
    });
    // The write into A is G's own, on G's own A-pinned session (decision 31: allowed).
    expect(await outcome(() => editDoc(gToken, fixture.docA))).toBe('ok');
  });

  // ---- spaceLinks.audit visibility ------------------------------------------

  it('audit — H (home owner) reads the link\'s rows; H2 (member) sees only their own (none on this link)', async () => {
    const h = await mintBrowser(fixture.accountH, fixture.identityH);
    const mine = await call('GET', `/v2/space-links/${hLink.id}/audit?limit=200`, h);
    expect(mine.status).toBe(200);
    expect((mine.body.data as unknown as unknown[]).length).toBeGreaterThan(0);
    const h2 = await mintBrowser(fixture.accountH2, fixture.identityH2);
    const theirs = await call('GET', `/v2/space-links/${hLink.id}/audit`, h2);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data).toEqual([]);
  });

  it('audit — a non-member of A gets not_found; the audit table is not readable by tm8_app', async () => {
    const outsider = await seedOutsider();
    expect((await call('GET', `/v2/space-links/${hLink.id}/audit`, outsider)).status).toBe(404);
    expect(await outcome(() => asIdentity(fixture.identityH, (q) => q.query('select 1 from public.cross_space_audit'))))
      .toBe('42501');
  });

  // ---- rate bucket (per token row) -----------------------------------------

  it('rate — the per-row bucket refuses past its limit; positive — the first call in the window passes', async () => {
    const registry = new HandlerRegistry();
    registry.register('entities.get', () => ({ id: fixture.docB }));
    const facade = { db, config: {}, owner: async () => NOT_THE_OWNER } as unknown as FacadeDeps;
    const { invoke: handler } = createSpaceLinkInvokeHandlers(registry, facade, linkStore,
      async (ctx) => claimsFor(NOT_THE_OWNER, ctx),
      { limiter: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) });
    const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
    const identity = await resolve({ authorization: `Bearer ${gToken}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true });
    const ctx = () => ({
      params: { spaceId: fixture.spaceA, link: hLink.id }, query: new URLSearchParams(), headers: {},
      body: { op: 'entities.get', params: { id: fixture.docB } }, identity, requestId: `w7-rate-${randomUUID()}`,
    }) as unknown as RequestContext;
    await expect(handler(ctx())).resolves.toMatchObject({ op: 'entities.get' });
    await expect(handler(ctx())).rejects.toMatchObject({ code: 'rate_limited' });
  });

  // ---- a6: a revoked link session fails at resolveBearerIdentity (F6) ------

  it('a6 — B revokes the link session: invoke answers 401 space_link_signed_out, audited, nothing forwarded', async () => {
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    await db.rpc(h, 'revoke_auth_session', [hLink.mine!.sessionId]);
    const res = await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } });
    expect(res.status).toBe(401);
    expect(res.body.error?.details).toMatchObject({ reason: 'space_link_signed_out' });
    expect(await lastAudit('entities.get')).toMatchObject({ result: 'error', reason: 'link_signed_out' });
    // No retry: the next call is refused in SQL (row signed_out) without a resolve.
    expect((await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } })).status).not.toBe(200);
  });

  it('a6 positive — after H signs the link in again, the same call passes', async () => {
    const h = await claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
    hLink = await linkStore.login(h, hLink.id, { relogin: true });
    hLinkToken = (await linkStore.use(h, hLink.id)).token;
    expect((await invoke(gToken, { op: 'entities.get', params: { id: fixture.docB } })).status).toBe(200);
  });

  // ---- a7: no token in entity_versions, the ledger, the audit or logs -------

  it('a7 — no link token (whole or secret half) is in entity_versions, command_ledger, cross_space_audit or the logs', async () => {
    const secrets = [hLinkToken, parseToken(hLinkToken)!.secret];
    const hits = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const counts: Record<string, number> = {};
      for (const table of ['entity_versions', 'command_ledger', 'cross_space_audit']) {
        const { rows } = await client.query<{ n: string }>(
          `select count(*)::text as n from public.${table} t where strpos(t::text, $1) > 0 or strpos(t::text, $2) > 0`,
          secrets);
        counts[table] = Number(rows[0]!.n);
      }
      return counts;
    });
    expect(hits).toEqual({ entity_versions: 0, command_ledger: 0, cross_space_audit: 0 });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((line) => secrets.some((s) => line.includes(s)))).toEqual([]);
  });

  it('a7 positive — the scan is live: the invoke path did write ledger rows for the forwarded commands', async () => {
    const [{ n }] = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ n: string }>(
        `select count(*)::text as n from public.command_ledger where client_mutation_id like 'w7-%'`)).rows;
    }) as Array<{ n: string }>;
    expect(Number(n)).toBeGreaterThan(0);
  });
});

/** An agent session for `identityId`'s own persona and work session in A. */
async function seedAgentFor(identityId: string, memberId: string): Promise<string> {
  const persona = randomUUID();
  const workSession = randomUUID();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'work_session', $1, 'space')`,
      [persona, workSession, fixture.spaceA, memberId]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'W7 agent', 'worker', 'persona')`, [persona, memberId]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'W7 run', 'running', 'none', now())`, [workSession]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`, [fixture.spaceA, persona, workSession]);
  });
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      workSession, persona, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'W7 agent',
    ]));
  return formatToken(row.id, secret);
}

/** A browser session for an account that is a member of neither space. */
async function seedOutsider(): Promise<string> {
  const identity = `cross-space-outsider-${randomUUID()}`;
  const account = randomUUID();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'O')`, [identity]);
    await client.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, $3)`,
      [account, identity, `cross-space-o-${account.slice(0, 8)}`]);
  });
  return mintBrowser(account, identity);
}
