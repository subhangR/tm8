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
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { DbSubscriptionAuthorizer, createControlChannel } from '../../src/events/control.js';
import type { DurableEventLog } from '../../src/events/poll.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import { claimsFor } from '../../src/facade/context.js';
import { loadConfig } from '../../src/http/config.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';
import type { RequestContext, RequestIdentity, SpaceSessionsMode } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken, parseToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import type { EventSink } from '../../src/events/ws-connection.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerMembershipHandlers } from '../../src/membership/handlers.js';

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

/** The production identity resolver's answer for a bearer string. */
async function identityForToken(token: string, mode: SpaceSessionsMode = 'agents'): Promise<RequestIdentity> {
  const resolve = createSessionIdentityResolver({
    db,
    owner: async () => NOT_THE_OWNER,
    spaceSessions: mode,
  });
  return resolve(
    { authorization: `Bearer ${token}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true },
  );
}

/**
 * The production path from a bearer string to `SET LOCAL`: identity resolver
 * (token hash → `auth_sessions` row) then `claimsFor`. `mode` is the
 * boot-time `TM8_SPACE_SESSIONS` value the server would have read.
 */
async function claimsForToken(token: string, mode: SpaceSessionsMode = 'agents'): Promise<DbClaims> {
  const identity = await identityForToken(token, mode);
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

    // TM8_SPACE_SESSIONS=enforce adds the human gate (W3) and changes nothing
    // for an agent token: it behaves exactly as under `agents`.
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

  // A GATE browser session (space_id null — every session `issue_auth_session`
  // mints) is unpinned under every mode: it sees both spaces at the RLS layer.
  // Under `enforce` the HTTP gate refuses it everything but spaces.list/auth.*
  // (T8c); pinning a human is `auth.space.enter`'s job (T1–T8b).
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
   * S2 (W3-audit #852 F1, task 01a0db30): the 4-argument `mark_notification_read`
   * is SECURITY DEFINER and authorized its member arm by identity alone, so a
   * session pinned to A marked the same identity's B notification read. 246
   * adds the pin to both member-arm `exists`. A fresh notification per cell,
   * so a mark in one cell cannot satisfy another's read_at assertion.
   */
  async function freshNotification(spaceId: string, memberId: string): Promise<string> {
    const id = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.notifications(id, space_id, recipient_member_id, kind)
         values ($1, $2, $3, 'mention')`,
        [id, spaceId, memberId],
      );
    });
    return id;
  }
  const markRead = (q: Querier, id: string): Promise<unknown> =>
    q.query('select public.mark_notification_read($1, $2, null, $3)', [id, 'member', `s2-${randomUUID()}`]);
  const readAt = (id: string): Promise<unknown> =>
    database.query<{ read_at: unknown }>('select read_at from public.notifications where id = $1', [id])
      .then((rows) => rows[0]?.read_at ?? null);

  it('agent, persona-less (S2): marking B\'s notification read is refused P0002 and it stays unread', async () => {
    const token = await mintPersonalessAgent();
    const notification = await freshNotification(fixture.spaceB, fixture.memberHB);
    expect(await outcome(() => asToken(token, (q) => markRead(q, notification)))).toBe('P0002');
    expect(await readAt(notification)).toBeNull();
  });
  it('agent, persona-less (S2): positive — marking A\'s notification read succeeds', async () => {
    const token = await mintPersonalessAgent();
    const notification = await freshNotification(fixture.spaceA, fixture.memberHA);
    expect(await outcome(() => asToken(token, (q) => markRead(q, notification)))).toBe('ok');
    expect(await readAt(notification)).not.toBeNull();
  });
  it('agent, persona-less, off (S2): the pin is inert — B\'s notification is marked read', async () => {
    const token = await mintPersonalessAgent();
    const notification = await freshNotification(fixture.spaceB, fixture.memberHB);
    expect(await outcome(() => asToken(token, (q) => markRead(q, notification), 'off'))).toBe('ok');
    expect(await readAt(notification)).not.toBeNull();
  });

  /**
   * K7 REJECTED (owner decision 32): nobody reads a public space without
   * joining it. 233 closed spaces_select's public arm (218:291, the W0a gap
   * this cell used to document), so a public B is as invisible as a private one.
   */
  it('K7 rejected, agent: a PUBLIC B is not readable either (no public arm)', async () => {
    const token = await mintAgent();
    await database.query(`update public.spaces set visibility = 'public' where id = $1`, [fixture.spaceB]);
    try {
      expect(await asToken(token, (q) =>
        q.query('select id from public.spaces where id = $1', [fixture.spaceB]))).toEqual([]);
    } finally {
      await database.query(`update public.spaces set visibility = 'private' where id = $1`, [fixture.spaceB]);
    }
  });
  it('agent: positive — a PRIVATE B is refused and its own A is read (the member arm is pinned)', async () => {
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

describe('W10a (T35/T36/T44) agent G and private credentials in A — refused by launcher, not by space', () => {
  // G is H's agent in A, so its launcher is H. H2's PRIVATE credential in the
  // same space must stay unusable to G; H's own private one must not. Seeded
  // through the real writer; ownership is set as the graph owner, the state
  // W10b's create will produce. The ciphertext is a fake of the right shape.
  let privateOfH2: string;
  let privateOfH: string;
  const seedCredential = async (identityId: string, accountId: string): Promise<string> => {
    const id = randomUUID();
    await asIdentity(identityId, (q) => q.rpc('create_space_credential', [
      id, fixture.spaceA, 'anthropic', 'api_key', `w10a ${id.slice(0, 8)}`, 'Fk0x',
      Buffer.alloc(17, 7), Buffer.alloc(12, 3),
    ]));
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.space_credentials set owner_account_id = $2, is_default = false where id = $1`, [id, accountId]);
    });
    await asIdentity(identityId, (q) => q.rpc('set_space_credential_visibility', [id, 'private']));
    return id;
  };
  beforeAll(async () => {
    privateOfH2 = await seedCredential(fixture.identityH2, fixture.accountH2);
    privateOfH = await seedCredential(fixture.identityH, fixture.accountH);
  });
  // Revoke both through the real writer, so the rest of the file sees no live
  // credential owned by H or H2 in A: 239's members backstop (G6) refuses to
  // end a membership whose account still owns one, and the enter_space cells
  // below flip H2's status by hand.
  afterAll(async () => {
    await asIdentity(fixture.identityH2, (q) => q.rpc('delete_space_credential', [privateOfH2]));
    await asIdentity(fixture.identityH, (q) => q.rpc('delete_space_credential', [privateOfH]));
  });

  for (const [kind, mint] of AGENT_KINDS) {
    it(`${kind}: H2's private credential is not usable; H's own private one is (launcher = H)`, async () => {
      const token = await mint();
      expect(await asToken(token, (q) =>
        q.rpc<string[]>('usable_space_credential_ids', [[privateOfH2, privateOfH]]))).toEqual([privateOfH]);
    });
    it(`${kind}: set_space_credential_visibility is refused (human-only), even on H's own`, async () => {
      const token = await mint();
      expect(await outcome(() => asToken(token, (q) =>
        q.rpc('set_space_credential_visibility', [privateOfH, 'public'])))).toBe('42501');
    });
  }
  it('positive — H2 (browser) can use H2\'s own private credential', async () => {
    const token = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await asToken(token, (q) =>
      q.rpc<string[]>('usable_space_credential_ids', [[privateOfH2, privateOfH]]))).toEqual([privateOfH2]);
  });
  it('positive — H (browser) switches H\'s own credential; H2 (browser) cannot', async () => {
    const h = await mintBrowser(fixture.accountH, fixture.identityH);
    const h2 = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await outcome(() => asToken(h2, (q) =>
      q.rpc('set_space_credential_visibility', [privateOfH, 'public'])))).toBe('42501');
    expect(await outcome(() => asToken(h, (q) =>
      q.rpc('set_space_credential_visibility', [privateOfH, 'private'])))).toBe('ok');
  });
  it('T44: the generic delete refuses a credential entity even for H, owner of A and of the credential', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => asToken(token, (q) => q.rpc('delete_entity', [privateOfH])))).toBe('42501');
  });
  it('positive — the same H token deletes a doc in A through the same door', async () => {
    const doc = await asIdentity(fixture.identityH, async (q) =>
      (await q.rpc<{ id?: string; entity?: { id: string } }>('create_document', [fixture.spaceA, 'W10a scratch doc'])))
      .then((row) => (row.entity?.id ?? row.id)!);
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => asToken(token, (q) => q.rpc('delete_entity', [doc])))).toBe('ok');
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

  async function expire(token: string): Promise<void> {
    const sessionId = parseToken(token)?.sessionId;
    if (!sessionId) throw new Error('minted token did not parse');
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.auth_sessions
            set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
          where id = $1::uuid`,
        [sessionId],
      );
    });
  }

  /**
   * WAS A KNOWN GAP (review round 1, item 2), CLOSED BY 236. A LOCAL token that
   * no longer resolves (revoked, expired) has the same `tm8s_<uuid>.<secret>`
   * shape as a remote's pass. The relay now asks `auth_session_issued_here`
   * whether this node ever issued its session id, in any state; if it did, the
   * token is ours and never leaves. A DEAD one is refused 401 with or without a
   * cookie (program-lead ruling, R18: a presented invalid credential never
   * degrades — the DEAD-* cells). Paired positives: a real remote pass is still
   * forwarded, a live local token equal to the cookie proceeds.
   */
  it('DEAD-REVOKED-BESIDE-COOKIE: a revoked LOCAL token beside H\'s live cookie is refused 401, nothing reaches the remote', async () => {
    const cookieToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await revoke(dead);
    const { status, seen } = await relay({ ...cookie(cookieToken), ...bearer(dead) });
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('DEAD-EXPIRED-BESIDE-COOKIE: an expired LOCAL token beside H\'s live cookie is refused 401, nothing reaches the remote', async () => {
    const cookieToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await expire(dead);
    const { status, seen } = await relay({ ...cookie(cookieToken), ...bearer(dead) });
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('positive — H\'s live cookie with the SAME token as Authorization proceeds, and it stays on this node', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay({ ...cookie(token), ...bearer(token) });
    expect(status).toBe(200);
    // Booleans, not values: a failing assertion must never print a token.
    expect(seen !== undefined && 'authorization' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(token)).toBe(false);
  });

  /**
   * FOLLOW-ON CELL (for the owner), pinned as it stands: a LIVE local token
   * that is not the cookie is dropped and the cookie names the caller. The
   * ordinary path answers the same pair 401 `conflicting authentication
   * credentials` (identity-resolver.ts).
   */

  it('a LIVE LOCAL token that is not the cookie, beside H\'s cookie, is NOT forwarded', async () => {
    const cookieToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const other = await mintCli(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay({ ...cookie(cookieToken), ...bearer(other) });
    expect(status).toBe(200);
    expect(seen !== undefined && 'authorization' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(other)).toBe(false);
  });

  /**
   * DEAD-REVOKED-NO-COOKIE / DEAD-EXPIRED-NO-COOKIE — program-lead ruling (R18,
   * as for W10b): a presented credential that is invalid never downgrades to
   * the loopback auto-owner. Auto-owner ON, so a fall-through would be 200.
   * Paired positives: a LIVE local token, and no header at all (still the
   * auto-owner, the F1/W2 pin above).
   */
  it('DEAD-REVOKED-NO-COOKIE: auto-owner on, a revoked LOCAL token is refused 401, nothing reaches the remote', async () => {
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await revoke(dead);
    const { status, seen } = await relay(bearer(dead), ownerRelayServer);
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('DEAD-EXPIRED-NO-COOKIE: auto-owner on, an expired LOCAL token is refused 401, nothing reaches the remote', async () => {
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await expire(dead);
    const { status, seen } = await relay(bearer(dead), ownerRelayServer);
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('positive — auto-owner on, a LIVE LOCAL token reaches the connection and stays on this node', async () => {
    const live = await mintCli(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay(bearer(live), ownerRelayServer);
    expect(status).toBe(200);
    expect(seen !== undefined && 'authorization' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(live)).toBe(false);
  });

  it('positive — auto-owner on, no header at all is still the auto-owner', async () => {
    const { status, seen } = await relay({}, ownerRelayServer);
    expect(status).toBe(200);
    expect(seen !== undefined && 'authorization' in seen).toBe(false);
  });

  it('positive — auto-owner on, no cookie: a real remote pass IS forwarded', async () => {
    const remotePass = 'tm8s_00000000-0000-0000-0000-000000000000.remote-pass-not-local';
    const { status, seen } = await relay(bearer(remotePass), ownerRelayServer);
    expect(status).toBe(200);
    expect(seen?.authorization).toBe(`Bearer ${remotePass}`);
  });

  it('positive — a remote pass whose session id is not a uuid IS forwarded beside H\'s cookie', async () => {
    const cookieToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const remotePass = 'tm8s_not-a-uuid.remote-pass-not-local';
    const { status, seen } = await relay({ ...cookie(cookieToken), ...bearer(remotePass) });
    expect(status).toBe(200);
    expect(seen?.authorization).toBe(`Bearer ${remotePass}`);
  });

  it('an expired LOCAL token alone is refused 401 with auto-owner off, and nothing reaches the remote', async () => {
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await expire(dead);
    const { status, seen } = await relay(bearer(dead));
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
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
// W3 — HUMAN SESSIONS PINNED TO A SPACE (T1–T8c).
//
// H's gate session (space_id null, `issue_auth_session`) enters A through the
// production `enter_space` RPC, the same call `auth.space.enter` makes. The
// pinned token is then resolved by the production resolver like every other
// credential in this file. Human pins apply under `agents` AND `enforce`
// (`off` is the kill switch); rows run under `enforce` unless they say so.
// ---------------------------------------------------------------------------

/** H's (or H2's) session pinned to `spaceId`, entered from a fresh gate session. */
async function mintPinned(
  accountId: string,
  identityId: string,
  spaceId: string,
): Promise<string> {
  const gate = await mintBrowser(accountId, identityId);
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string; space_id: string }>('enter_space', [
      spaceId, parseToken(gate)!.sessionId, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'cross-space pinned',
    ]));
  expect(row.space_id).toBe(spaceId);
  return formatToken(row.id, secret);
}

/** Run `fn` with H's `accounts.is_node_admin` set to `value`, restored after. */
async function withNodeAdmin<T>(accountId: string, value: boolean, fn: () => Promise<T>): Promise<T> {
  const read = await database.query<{ is_node_admin: boolean }>(
    'select is_node_admin from public.accounts where id = $1', [accountId]);
  const before = read[0]!.is_node_admin;
  await database.query('update public.accounts set is_node_admin = $2 where id = $1', [accountId, value]);
  try {
    return await fn();
  } finally {
    await database.query('update public.accounts set is_node_admin = $2 where id = $1', [accountId, before]);
  }
}

describe('T1 H pinned to A reads B — not_found / empty (W3)', () => {
  for (const mode of ['agents', 'enforce'] as const) {
    it(`${mode}: the pin reaches SET LOCAL and B entities are invisible`, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect((await claimsForToken(token, mode)).sessionSpaceId).toBe(fixture.spaceA);
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceB), mode)).toEqual([]);
    });
    it(`${mode}: positive — A entities are visible with the same credential`, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect(await asToken(token, (q) => idsIn(q, fixture.spaceA), mode)).toContain(fixture.docA);
    });
  }
  it('B\'s doc is not_found by id', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await asToken(token, (q) =>
      q.query('select id from public.entities where id = $1', [fixture.docB]), 'enforce')).toEqual([]);
  });
  it('positive — A\'s doc is found by id', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await asToken(token, (q) =>
      q.query('select id from public.entities where id = $1', [fixture.docA]), 'enforce')).toHaveLength(1);
  });
  it('a SECURITY DEFINER read guarded by require_space_member refuses B', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) => q.rpc('get_space_menu', [fixture.spaceB]), 'enforce')))
      .toBe('42501');
  });
  it('positive — the same read answers for A', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) => q.rpc('get_space_menu', [fixture.spaceA]), 'enforce')))
      .toBe('ok');
  });
  it('off: the pin is inert — B is visible (kill switch, pre-W3 behaviour)', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect((await claimsForToken(token, 'off')).sessionSpaceId).toBeUndefined();
    expect(await asToken(token, (q) => idsIn(q, fixture.spaceB), 'off')).toContain(fixture.docB);
  });
});

describe('T2 H pinned to A writes B — 42501 (W3)', () => {
  it('update_document on B\'s doc is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => editDoc(token, fixture.docB, 'enforce'))).toBe('42501');
  });
  it('positive — update_document on A\'s doc succeeds', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => editDoc(token, fixture.docA, 'enforce'))).toBe('ok');
  });
  it('create_document in B is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('create_document', [fixture.spaceB, 'T2 pinned H in B']), 'enforce'))).toBe('42501');
  });
  it('positive — create_document in A succeeds', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('create_document', [fixture.spaceA, 'T2 pinned H in A']), 'enforce'))).toBe('ok');
  });
  it('provider_etag_record in B (no actor binding) is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => recordEtag(token, fixture.spaceB, 'enforce'))).toBe('42501');
  });
  it('positive — provider_etag_record in A succeeds', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => recordEtag(token, fixture.spaceA, 'enforce'))).toBe('ok');
  });
});

/**
 * The WS control channel (subscribe and resume) driven with the REAL
 * authorizer for `mode`, a recording sink, and a log that records every read.
 * A refused frame answers with a `control.refused` ack and never reads the log.
 */
function controlChannelFor(identity: RequestIdentity, mode: SpaceSessionsMode) {
  const sent: Array<Record<string, unknown>> = [];
  const logCalls: string[] = [];
  const registry = new SubscriptionRegistry();
  const sink = {
    id: `w3-${randomUUID()}`,
    identity,
    isOpen: true,
    send: (text: string) => { sent.push(JSON.parse(text) as Record<string, unknown>); },
    close: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  };
  registry.add(sink);
  const log: DurableEventLog = {
    since: (spaceId, sinceSeq) => {
      logCalls.push(spaceId);
      return Promise.resolve({ items: [], nextCursor: String(sinceSeq) });
    },
  };
  const channel = createControlChannel({
    registry,
    authorizer: new DbSubscriptionAuthorizer(db, async (id) =>
      claimsFor(NOT_THE_OWNER, { identity: id, requestId: `w3c-${randomUUID()}` } as unknown as RequestContext),
    { spaceSessions: mode }),
    log,
    claimsFor: async (id) =>
      claimsFor(NOT_THE_OWNER, { identity: id, requestId: `w3c-${randomUUID()}` } as unknown as RequestContext),
  });
  return {
    send: (frame: unknown) => channel.handle(sink, JSON.stringify(frame)),
    acks: () => sent.filter((m) => String(m['type']).startsWith('control.')),
    subscribed: () => registry.spacesFor(sink.id),
    logCalls,
  };
}

describe('T3 H pinned to A — events and WS subscribe on B refused (W3)', () => {
  const authorizer = () => new DbSubscriptionAuthorizer(db, async (identity) =>
    claimsFor(NOT_THE_OWNER, { identity, requestId: `t3-${randomUUID()}` } as unknown as RequestContext));
  const authorizerIn = (spaceSessions: SpaceSessionsMode) => new DbSubscriptionAuthorizer(db, async (identity) =>
    claimsFor(NOT_THE_OWNER, { identity, requestId: `t3-${randomUUID()}` } as unknown as RequestContext),
  { spaceSessions });

  it('WS subscribe to B is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const identity = await identityForToken(token, 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceB)).toBe(false);
  });
  it('positive — WS subscribe to A is admitted for the same credential', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const identity = await identityForToken(token, 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceA)).toBe(true);
  });
  it('WS subscribe to a PUBLIC B is refused too (K7 rejected: public is not readable)', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const identity = await identityForToken(token, 'enforce');
    await database.query(`update public.spaces set visibility = 'public' where id = $1`, [fixture.spaceB]);
    try {
      expect(await authorizer().canSubscribe(identity, fixture.spaceB)).toBe(false);
    } finally {
      await database.query(`update public.spaces set visibility = 'private' where id = $1`, [fixture.spaceB]);
    }
  });
  it('positive — H\'s gate session subscribes to B (a gate is not pinned)', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const identity = await identityForToken(token, 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceB)).toBe(true);
  });
  it('a gate session subscribes to nothing when the authorizer runs under enforce (W3 audit)', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const identity = await identityForToken(token, 'enforce');
    expect(await authorizerIn('enforce').canSubscribe(identity, fixture.spaceB)).toBe(false);
    expect(await authorizerIn('enforce').canSubscribe(identity, fixture.spaceA)).toBe(false);
  });
  it('positive — the same gate session subscribes to B when the authorizer runs under agents', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const identity = await identityForToken(token, 'agents');
    expect(await authorizerIn('agents').canSubscribe(identity, fixture.spaceB)).toBe(true);
  });
  it('W3 audit: under enforce a gate session\'s subscribe AND resume to a member space are refused, the log never read', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const c = controlChannelFor(await identityForToken(gate, 'enforce'), 'enforce');
    await c.send({ type: 'subscribe', spaceIds: [fixture.spaceA] });
    await c.send({ type: 'resume', spaceId: fixture.spaceA, since: 0 });
    expect(c.subscribed()).toEqual([]);
    expect(c.logCalls, 'the log must not be read before authorization decides').toEqual([]);
    expect(c.acks()).toEqual([
      { type: 'control.refused', frame: 'subscribe', spaceId: fixture.spaceA, reason: 'forbidden' },
      { type: 'control.refused', frame: 'resume', spaceId: fixture.spaceA, reason: 'forbidden' },
    ]);
  });
  it('W3 audit: positive — the agents twin admits the same gate session\'s subscribe and resume', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const c = controlChannelFor(await identityForToken(gate, 'agents'), 'agents');
    await c.send({ type: 'subscribe', spaceIds: [fixture.spaceA] });
    await c.send({ type: 'resume', spaceId: fixture.spaceA, since: 0 });
    expect(c.subscribed()).toEqual([fixture.spaceA]);
    expect(c.logCalls).toEqual([fixture.spaceA]);
    expect(c.acks().filter((a) => a['type'] === 'control.refused')).toEqual([]);
  });
  it('positive — a pinned session still subscribes to its own space under enforce', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const identity = await identityForToken(token, 'enforce');
    expect(await authorizerIn('enforce').canSubscribe(identity, fixture.spaceA)).toBe(true);
  });
  it('B\'s workspace_events are invisible (events.poll reads under the pin)', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await asToken(token, (q) => q.query(
      'select 1 from public.workspace_events where space_id = $1 limit 1', [fixture.spaceB]), 'enforce'))
      .toEqual([]);
    // The discriminating half: the same rows are visible to H's gate session.
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect((await asToken(gate, (q) => q.query(
      'select 1 from public.workspace_events where space_id = $1 limit 1', [fixture.spaceB]), 'enforce')).length)
      .toBeGreaterThan(0);
  });
  it('positive — A\'s workspace_events are visible', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect((await asToken(token, (q) => q.query(
      'select 1 from public.workspace_events where space_id = $1 limit 1', [fixture.spaceA]), 'enforce')).length)
      .toBeGreaterThan(0);
  });
});

describe('T5 H pinned to A — PTY attach to a B session refused (W3)', () => {
  const workSessionB = randomUUID();

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'work_session', $3, 'space')`,
        [workSessionB, fixture.spaceB, fixture.memberHB],
      );
      await client.query(
        `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
         values ($1, 'T5 B run', 'running', 'none', now())`,
        [workSessionB],
      );
    });
  });

  /** A single-use attach grant for `sessionId`, minted by `token`. Returns the grant's hash. */
  async function grant(token: string, sessionId: string, mode: SpaceSessionsMode = 'enforce'): Promise<string> {
    const hash = hashToken(generateSecret());
    await asToken(token, (q) => q.rpc('grant_stream_attach', [sessionId, 'view', hash, null, null]), mode);
    return hash;
  }

  it('grant_stream_attach on B\'s session is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => grant(token, workSessionB))).toBe('42501');
  });
  it('positive — grant + consume on A\'s session succeeds with the same credential', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const hash = await grant(token, fixture.workSessionA);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('consume_stream_attach', [fixture.workSessionA, 'view', hash]), 'enforce'))).toBe('ok');
  });
  it('consume_stream_attach refuses a B grant under an A pin (233), even one H\'s gate minted', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const hash = await grant(gate, workSessionB);
    const pinned = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(pinned, (q) =>
      q.rpc('consume_stream_attach', [workSessionB, 'view', hash]), 'enforce'))).toBe('42501');
    // Positive: the grant was live — the gate session consumes it.
    expect(await outcome(() => asToken(gate, (q) =>
      q.rpc('consume_stream_attach', [workSessionB, 'view', hash]), 'enforce'))).toBe('ok');
  });
});

describe('T6 H pinned to A — projects without a spaceId are only A\'s (W3)', () => {
  const projectA = randomUUID();
  const projectB = randomUUID();

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1, 'T6 A project', '/tmp/cross-space-t6-a', 'trusted'),
                ($2, 'T6 B project', '/tmp/cross-space-t6-b', 'trusted')`,
        [projectA, projectB],
      );
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($1, $3, $5), ($2, $4, $6)`,
        [fixture.spaceA, fixture.spaceB, projectA, projectB, fixture.memberHA, fixture.memberHB],
      );
    });
  });

  // A raw read of public.projects: RLS is the whole answer. Since 234 (W11)
  // projects_select admits only a gate admin — a node admin on an UNPINNED
  // session — so H is a NODE ADMIN here, the arm that used to make it node-wide.
  const projectsVisible = (token: string): Promise<string[]> =>
    asToken(token, (q) => q.query<{ id: string }>(
      'select id::text from public.projects where id = any($1::uuid[])', [[projectA, projectB]]), 'enforce')
      .then((rows) => rows.map((r) => r.id));

  // W11 (234 §5): public.projects is the gate's folder table, and a pinned
  // session is never a gate admin, so H pinned to A reads it as a member of A
  // does: no folder rows. A's project reaches it through the member-scoped
  // resolver (resolve_project_ref, membership carrying 227's inline pin).
  const projectsResolved = (token: string): Promise<string[]> =>
    asToken(token, async (q) => {
      const ids: string[] = [];
      for (const ref of [projectA, projectB]) {
        const rows = await q.query<{ folder_id: string }>(
          'select folder_id::text from public.resolve_project_ref($1::uuid)', [ref]);
        ids.push(...rows.map((r) => r.folder_id));
      }
      return ids;
    }, 'enforce');

  it('pinned node-admin H sees only A\'s project', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect(await projectsResolved(token)).toEqual([projectA]);
      // never the unpinned node-admin view: no gate folder rows at all
      expect(await projectsVisible(token)).toEqual([]);
    });
  });
  it('positive — H\'s gate session (node admin) sees both: the pin, not the account, narrowed it', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintBrowser(fixture.accountH, fixture.identityH);
      expect((await projectsVisible(token)).sort()).toEqual([projectA, projectB].sort());
    });
  });
});

describe('T7/T8 pinned sessions never hold node-admin; gate sessions keep it (W3, K6)', () => {
  const adminProbe = (token: string) => asToken(token, async (q) => (await q.query<{ admin: boolean }>(
    'select internal.is_node_admin() as admin'))[0]!.admin, 'enforce');
  // internal.require_node_admin() is not granted to tm8_app; it is reached
  // through a node-admin RPC. A 100-year retention deletes nothing.
  const requireAdmin = (token: string) => outcome(() => asToken(token, (q) =>
    q.rpc('prune_auth_sessions', ['100 years']), 'enforce'));

  it('T8: pinned node-admin H — claims carry nodeAdmin=false and is_node_admin() is false', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect((await claimsForToken(token, 'enforce')).nodeAdmin).toBe(false);
      expect(await adminProbe(token)).toBe(false);
    });
  });
  it('T8: pinned node-admin H — prune_auth_sessions (require_node_admin reads accounts) refuses 42501', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect(await requireAdmin(token)).toBe('42501');
    });
  });
  it('T8: positive — H\'s gate session keeps node-admin (claims, is_node_admin, prune_auth_sessions)', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintBrowser(fixture.accountH, fixture.identityH);
      expect((await claimsForToken(token, 'enforce')).nodeAdmin).toBe(true);
      expect(await adminProbe(token)).toBe(true);
      expect(await requireAdmin(token)).toBe('ok');
    });
  });
  it('T8: pinned node-admin H cannot mint a session (issue_auth_session refuses a pinned caller)', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect(await outcome(() => asToken(token, (q) => q.rpc('issue_auth_session', [
        fixture.accountH, hashToken(generateSecret()), 'cli',
        new Date(Date.now() + 3_600_000).toISOString(), null, 'T8 pinned mint',
      ]), 'enforce'))).toBe('42501');
    });
  });
  it('T7: pinned H2 (not a node admin) is refused', async () => {
    const token = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await adminProbe(token)).toBe(false);
    expect(await requireAdmin(token)).toBe('42501');
  });
  it('T7: H2\'s gate session is refused too — the refusal is the account\'s, as before W3', async () => {
    const token = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await adminProbe(token)).toBe(false);
    expect(await requireAdmin(token)).toBe('42501');
  });
  it('T7: positive — pinned H2 still works in its own space A', async () => {
    const token = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await asToken(token, (q) => idsIn(q, fixture.spaceA), 'enforce')).toContain(fixture.docA);
  });
});

describe('T8b a non-member of public space P — read refused, write refused (W3, K7 rejected)', () => {
  const spaceP = randomUUID();
  let docP: string;

  beforeAll(async () => {
    const memberP = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.spaces(id, name, created_by_identity, visibility)
         values ($1, 'Cross-space P (public)', $2, 'public')`,
        [spaceP, fixture.identityH2],
      );
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'member', $1, 'space')`,
        [memberP, spaceP],
      );
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, 'owner', 'H2')`,
        [memberP, spaceP, fixture.identityH2],
      );
    });
    docP = await asIdentity(fixture.identityH2, async (q) =>
      (await q.rpc<{ id?: string; entity?: { id: string } }>('create_document', [spaceP, 'Public doc in P']))
    ).then((row) => (row.entity?.id ?? row.id)!);
  });

  /** `update_document` on P's doc; the version is read by the test harness, not by H (not a member of P). */
  async function editP(token: string): Promise<unknown> {
    const [row] = await database.query<{ version: number }>(
      'select version from public.entities where id = $1', [docP]);
    return asToken(token, (q) => q.rpc('update_document', [
      docP, Number(row!.version), null, `edited ${randomUUID()}`, null, null, `cross-space-${randomUUID()}`,
    ]), 'enforce');
  }

  it('the K7 toggle is gone (decision 32: not a toggle)', async () => {
    expect(await database.query(
      `select 1 from pg_proc where proname = 'pinned_session_reads_public_spaces'`)).toEqual([]);
  });
  it('read refused — P\'s space row is invisible to H pinned to A (not a member of P)', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await asToken(token, (q) =>
      q.query('select id from public.spaces where id = $1', [spaceP]), 'enforce')).toEqual([]);
  });
  it('read refused — and to H\'s unpinned gate session too (no public arm in any mode)', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    for (const mode of ['agents', 'enforce'] as const) {
      expect(await asToken(gate, (q) =>
        q.query('select id from public.spaces where id = $1', [spaceP]), mode)).toEqual([]);
    }
  });
  it('positive — H2 pinned to P (its member) reads P and P\'s doc', async () => {
    const token = await mintPinned(fixture.accountH2, fixture.identityH2, spaceP);
    expect(await asToken(token, (q) =>
      q.query('select id from public.spaces where id = $1', [spaceP]), 'enforce')).toHaveLength(1);
    expect(await asToken(token, (q) => idsIn(q, spaceP), 'enforce')).toContain(docP);
  });
  it('write no — create_document in P is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('create_document', [spaceP, 'T8b pinned H in P']), 'enforce'))).toBe('42501');
  });
  it('write no — update_document on P\'s doc is refused', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => editP(token))).toBe('42501');
  });
  it('write no — join_public_space(P) is refused while pinned to A', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('join_public_space', [spaceP, null]), 'enforce'))).toBe('42501');
    const members = await database.query(
      'select 1 from public.members where space_id = $1 and identity_id = $2', [spaceP, fixture.identityH]);
    expect(members).toEqual([]);
  });
  it('positive — the same pinned credential writes its own space A', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => asToken(token, (q) =>
      q.rpc('create_document', [fixture.spaceA, 'T8b pinned H in A']), 'enforce'))).toBe('ok');
  });
  it('positive — H2 pinned to P (its member) writes P', async () => {
    const token = await mintPinned(fixture.accountH2, fixture.identityH2, spaceP);
    expect(await outcome(() => editP(token))).toBe('ok');
  });
  // Last in the block: it makes H a member of P. Joining BY ID stays open
  // (decision 32 keeps join_public_space; discovery is an open question).
  it('positive — H\'s gate session joins P by id, then reads it as a member', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    try {
      expect(await outcome(() => asToken(gate, (q) =>
        q.rpc('join_public_space', [spaceP, null]), 'agents'))).toBe('ok');
      expect(await asToken(gate, (q) =>
        q.query('select id from public.spaces where id = $1', [spaceP]), 'agents')).toHaveLength(1);
    } finally {
      await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query('delete from public.members where space_id = $1 and identity_id = $2',
          [spaceP, fixture.identityH]);
      });
    }
  });
});

describe('enter_space — who may pin a session to which space (W3)', () => {
  const enter = (
    claimsIdentity: string,
    spaceId: string,
    parent: string | null,
    opts: { authKind?: string; expiresAt?: Date } = {},
  ) => outcome(() => asIdentity(claimsIdentity, (q) => q.rpc('enter_space', [
    spaceId, parent, hashToken(generateSecret()),
    (opts.expiresAt ?? new Date(Date.now() + 3_600_000)).toISOString(), 'enter_space cell',
  ]), opts.authKind));

  it('a non-member is refused (H2 into B)', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await enter(fixture.identityH2, fixture.spaceB, parseToken(gate)!.sessionId)).toBe('42501');
  });
  it('positive — the same H2 gate enters A', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await enter(fixture.identityH2, fixture.spaceA, parseToken(gate)!.sessionId)).toBe('ok');
  });
  it('enter_space: a member who LEFT or was removed cannot pin (232 tombstone, 248)', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    const sessionId = parseToken(gate)!.sessionId;
    for (const status of ['left', 'removed']) {
      await database.query(
        `update public.members set status = $3, left_at = now() where space_id = $1 and identity_id = $2`,
        [fixture.spaceA, fixture.identityH2, status]);
      try {
        expect(await enter(fixture.identityH2, fixture.spaceA, sessionId)).toBe('42501');
      } finally {
        await database.query(
          `update public.members set status = 'active', left_at = null where space_id = $1 and identity_id = $2`,
          [fixture.spaceA, fixture.identityH2]);
      }
    }
    // The positive: reactivated, the same gate enters A again.
    expect(await enter(fixture.identityH2, fixture.spaceA, sessionId)).toBe('ok');
  });
  it('a parent session that belongs to another account is refused', async () => {
    const gateH = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await enter(fixture.identityH2, fixture.spaceA, parseToken(gateH)!.sessionId)).toBe('42501');
  });
  it('a pinned parent is refused (a pinned session cannot enter again)', async () => {
    const pinned = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await enter(fixture.identityH, fixture.spaceB, parseToken(pinned)!.sessionId)).toBe('42501');
  });
  it('a pinned CALLER is refused', async () => {
    const pinned = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => asToken(pinned, (q) => q.rpc('enter_space', [
      fixture.spaceB, parseToken(gate)!.sessionId, hashToken(generateSecret()),
      new Date(Date.now() + 3_600_000).toISOString(), 'pinned caller',
    ]), 'enforce'))).toBe('42501');
  });
  it('an agent-kind caller is refused', async () => {
    expect(await enter(fixture.identityH, fixture.spaceA, null, { authKind: 'agent' })).toBe('42501');
  });
  it('a revoked parent is refused', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    await database.query('update public.auth_sessions set revoked_at = now() where id = $1',
      [parseToken(gate)!.sessionId]);
    expect(await enter(fixture.identityH, fixture.spaceA, parseToken(gate)!.sessionId)).toBe('42501');
  });
  it('the child inherits the parent\'s kind and never outlives it', async () => {
    const secret = generateSecret();
    const parentRow = await asIdentity(fixture.identityH, (q) => q.rpc<{ id: string; expires_at: string }>(
      'issue_auth_session', [fixture.accountH, hashToken(secret), 'cli',
        new Date(Date.now() + 600_000).toISOString(), null, 'short cli parent']));
    const child = await asIdentity(fixture.identityH, (q) => q.rpc<{ kind: string; expires_at: string; space_id: string }>(
      'enter_space', [fixture.spaceA, parentRow.id, hashToken(generateSecret()),
        new Date(Date.now() + 86_400_000).toISOString(), 'long child']), 'cli');
    expect(child.kind).toBe('cli');
    expect(child.space_id).toBe(fixture.spaceA);
    expect(new Date(child.expires_at).getTime()).toBeLessThanOrEqual(new Date(parentRow.expires_at).getTime());
    expect(child).not.toHaveProperty('token_hash');
  }, 120_000);
});

describe('claim-free resolvers — returned keys pinned (W3)', () => {
  // These three run before any claim is bound (007:105-130, 142). A key added
  // to one is a field every pre-auth caller can read, so each key set is pinned
  // EXACTLY; widening one is a reviewed change to this list.
  const keys = (row: Record<string, unknown> | null | undefined): string[] =>
    Object.keys(row ?? {}).sort();

  it('resolve_auth_session: a gate row and a pinned row carry the same keys, spaceId included', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const pinned = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const resolve = async (token: string) => (await database.query<{ r: Record<string, unknown> }>(
      'select public.resolve_auth_session($1) as r', [hashToken(parseToken(token)!.secret)]))[0]!.r;
    const gateRow = await resolve(gate);
    const pinnedRow = await resolve(pinned);
    expect(keys(pinnedRow)).toEqual(keys(gateRow));
    expect(keys(gateRow)).toEqual(RESOLVE_AUTH_SESSION_KEYS);
    expect(pinnedRow.spaceId).toBe(fixture.spaceA);
    expect(gateRow.spaceId ?? null).toBeNull();
  });
  it('resolve_account_credential: key set', async () => {
    const row = (await database.query<{ r: Record<string, unknown> }>(
      'select public.resolve_account_credential($1) as r', ['cross-space-h']))[0]!.r;
    expect(keys(row)).toEqual(RESOLVE_ACCOUNT_CREDENTIAL_KEYS);
  });
  it('resolve_node_owner: key set, and no secret', async () => {
    const [before] = await database.query<{ is_owner: boolean }>(
      'select is_owner from public.accounts where id = $1', [fixture.accountH]);
    await database.query('update public.accounts set is_owner = true where id = $1', [fixture.accountH]);
    try {
      const row = (await database.query<{ r: Record<string, unknown> }>(
        'select public.resolve_node_owner() as r'))[0]!.r;
      expect(keys(row)).toEqual(RESOLVE_NODE_OWNER_KEYS);
      expect(keys(row)).not.toContain('passwordHash');
    } finally {
      await database.query('update public.accounts set is_owner = $2 where id = $1',
        [fixture.accountH, before!.is_owner]);
    }
  });
});

// MEASURED against the migrated scratch database (233). `spaceId` is 226's.
const RESOLVE_AUTH_SESSION_KEYS = [
  'accountId', 'actingAsTeamMemberId', 'displayName', 'expiresAt', 'identityId', 'isNodeAdmin',
  'isOwner', 'kind', 'label', 'runtimeChatId', 'runtimeMemberId', 'runtimeThreadRootId',
  'sessionId', 'spaceId', 'username', 'workSessionId',
];
const RESOLVE_ACCOUNT_CREDENTIAL_KEYS = [
  'accountId', 'disabledAt', 'identityId', 'isNodeAdmin', 'isOwner', 'passwordAlgorithm',
  'passwordHash', 'status', 'username',
];
const RESOLVE_NODE_OWNER_KEYS = ['accountId', 'identityId', 'isNodeAdmin', 'isOwner', 'status', 'username'];

/**
 * W3 over HTTP: the enforce gate (T8c), `auth.space.enter`'s wire shape, and the
 * pinned token through the real server (T1, T6, T8). Two servers over the same
 * database — `enforce` and `agents` — so every enforce refusal has its `agents`
 * twin (a5: human behaviour unchanged there). Auto-owner is OFF on both: every
 * call carries a bearer.
 */
describe('T8c / T6 / T8 over HTTP — the enforce gate and auth.space.enter (W3)', () => {
  let enforceServer: BootstrappedServer;
  let agentsServer: BootstrappedServer;
  const projectA = randomUUID();
  const projectB = randomUUID();
  let adminBefore: Array<{ id: string; is_node_admin: boolean; is_owner: boolean }> = [];

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      // `bootstrap` needs an owner: H owns and administers the node for this
      // block (T26's arrangement), restored in afterAll.
      adminBefore = (await client.query<{ id: string; is_node_admin: boolean; is_owner: boolean }>(
        'select id::text, is_node_admin, is_owner from public.accounts where id = any($1::uuid[])',
        [[fixture.accountH, fixture.accountH2]],
      )).rows;
      await client.query(
        `update public.accounts set is_node_admin = (id = $1::uuid), is_owner = (id = $1::uuid)
          where id = any($2::uuid[])`,
        [fixture.accountH, [fixture.accountH, fixture.accountH2]],
      );
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1, 'W3 HTTP A project', '/tmp/cross-space-w3-a', 'trusted'),
                ($2, 'W3 HTTP B project', '/tmp/cross-space-w3-b', 'trusted')`,
        [projectA, projectB],
      );
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($1, $3, $5), ($2, $4, $6)`,
        [fixture.spaceA, fixture.spaceB, projectA, projectB, fixture.memberHA, fixture.memberHB],
      );
    });
    const start = async (mode: SpaceSessionsMode): Promise<BootstrappedServer> => {
      const configured = loadConfig({
        ...process.env,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: '4610',
        TM8_NODE_MODE: 'single',
        TM8_DATABASE_URL: database.url,
        TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-w3-')),
        TM8_DISABLE_AUTO_OWNER: '1',
        TM8_SPACE_SESSIONS: mode,
      });
      return bootstrap({ config: { ...configured, port: 0 } });
    };
    enforceServer = await start('enforce');
    agentsServer = await start('agents');
  }, 180_000);

  afterAll(async () => {
    for (const server of [enforceServer, agentsServer]) {
      await server?.server.close();
      await server?.db?.end();
    }
    for (const row of adminBefore) {
      await database.query(
        'update public.accounts set is_node_admin = $2, is_owner = $3 where id = $1::uuid',
        [row.id, row.is_node_admin, row.is_owner],
      );
    }
  }, 180_000);

  async function call(
    server: BootstrappedServer,
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const response = await fetch(new URL(path, server.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    // Success bodies are the `{ data, requestId }` envelope; `json` is `data`.
    const parsed = text ? JSON.parse(text) : null;
    return { status: response.status, json: parsed && 'data' in parsed ? parsed.data : parsed };
  }

  const enterOverHttp = (server: BootstrappedServer, gate: string, spaceId: string) =>
    call(server, gate, 'POST', '/v2/auth/space/enter', { spaceId });

  it('T8c enforce: a gate session is refused a space read (entities.get on A)', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect((await call(enforceServer, gate, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(403);
  });
  it('T8c enforce: a gate session is refused projects.list and a space write', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect((await call(enforceServer, gate, 'GET', '/v2/projects')).status).toBe(403);
    expect((await call(enforceServer, gate, 'GET', `/v2/spaces/${fixture.spaceA}/events`)).status).toBe(403);
  });
  it('T8c enforce: positive — the same gate session lists spaces and reads its own session', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const spaces = await call(enforceServer, gate, 'GET', '/v2/spaces');
    expect(spaces.status).toBe(200);
    expect(JSON.stringify(spaces.json)).toContain(fixture.spaceA);
    const session = await call(enforceServer, gate, 'GET', '/v2/auth/session');
    expect(session.status).toBe(200);
    // auth.session.get is {authKind, account, session}: the pin is session.spaceId.
    expect(session.json.session).not.toBeNull();
    expect(session.json.session.spaceId ?? null).toBeNull();
    // The discriminating half: the pinned child of the same gate reports A.
    const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
    const pinnedSession = await call(enforceServer, pinned, 'GET', '/v2/auth/session');
    expect(pinnedSession.status).toBe(200);
    expect(pinnedSession.json.session.spaceId).toBe(fixture.spaceA);
  });
  it('spaces.list does not list an unjoined public space (K7 rejected), in either mode', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    await database.query(`update public.spaces set visibility = 'public' where id = $1`, [fixture.spaceB]);
    try {
      for (const server of [enforceServer, agentsServer]) {
        const spaces = await call(server, gate, 'GET', '/v2/spaces');
        expect(spaces.status).toBe(200);
        expect(JSON.stringify(spaces.json)).toContain(fixture.spaceA);
        expect(JSON.stringify(spaces.json)).not.toContain(fixture.spaceB);
      }
    } finally {
      await database.query(`update public.spaces set visibility = 'private' where id = $1`, [fixture.spaceB]);
    }
  });
  it('a5 agents: the same gate session reads A exactly as before W3', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect((await call(agentsServer, gate, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(200);
    expect((await call(agentsServer, gate, 'GET', `/v2/entities/${fixture.docB}`)).status).toBe(200);
  });

  it('auth.space.enter: returns {token, spaceId, session} with session.spaceId set, and the token is pinned', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const entered = await enterOverHttp(enforceServer, gate, fixture.spaceA);
    expect(entered.status).toBe(200);
    expect(Object.keys(entered.json).sort()).toEqual(['session', 'spaceId', 'token']);
    expect(entered.json.spaceId).toBe(fixture.spaceA);
    expect(entered.json.session.spaceId).toBe(fixture.spaceA);
    expect(entered.json.session.kind).toBe('browser');
    expect(entered.json.token).not.toBe(gate);
    // T1 over HTTP, paired: A readable, B not_found, with the entered token.
    expect((await call(enforceServer, entered.json.token, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(200);
    expect((await call(enforceServer, entered.json.token, 'GET', `/v2/entities/${fixture.docB}`)).status).toBe(404);
  });
  it('auth.space.enter: a non-member is refused (H2 into B)', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect((await enterOverHttp(enforceServer, gate, fixture.spaceB)).status).toBe(403);
  });
  it('auth.space.enter: positive — the same H2 gate enters A', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect((await enterOverHttp(enforceServer, gate, fixture.spaceA)).status).toBe(200);
  });
  it('auth.space.enter: a pinned session cannot enter another space', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
    expect((await enterOverHttp(enforceServer, pinned, fixture.spaceB)).status).toBe(403);
  });
  it('auth.space.enter: an agent token is refused', async () => {
    const agent = await mintAgent();
    expect((await enterOverHttp(enforceServer, agent, fixture.spaceA)).status).toBe(403);
  });

  it('T6: GET /v2/projects (no spaceId) with a pinned node-admin token returns only A\'s project', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const gate = await mintBrowser(fixture.accountH, fixture.identityH);
      const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
      const listed = await call(enforceServer, pinned, 'GET', '/v2/projects');
      expect(listed.status).toBe(200);
      const ids = (listed.json as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toContain(projectA);
      expect(ids).not.toContain(projectB);
    });
  });
  it('T6: positive — the node-admin gate session under agents lists node-wide (both)', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const gate = await mintBrowser(fixture.accountH, fixture.identityH);
      const listed = await call(agentsServer, gate, 'GET', '/v2/projects');
      expect(listed.status).toBe(200);
      const ids = (listed.json as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([projectA, projectB]));
    });
  });

  /**
   * THE ENFORCE-BLOCKER WALK (lead ruling B). A brand-new user under enforce,
   * with nothing but a gate session, must reach a first space: every op it
   * needed is on the gate list (identity.get, spaces.list, spaces.create,
   * spaces.invites.redeem, and auth.* for login / invite resolve / enter).
   */
  async function newUserGate(): Promise<string> {
    const admin = await mintBrowser(fixture.accountH, fixture.identityH);
    const username = `w3new${randomUUID().slice(0, 8)}`;
    const password = `pw-${randomUUID()}`;
    const signedUp = await call(enforceServer, admin, 'POST', '/v2/auth/signup', { username, password });
    expect(signedUp.status, JSON.stringify(signedUp.json)).toBeLessThan(300);
    const response = await fetch(new URL('/v2/auth/login', enforceServer.url), {
      method: 'POST',
      headers: { [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, kind: 'cli' }),
    });
    expect(response.status).toBe(200);
    const parsed = await response.json() as { data: { token: string; session: { spaceId?: string | null } } };
    expect(parsed.data.session.spaceId ?? null).toBeNull();
    return parsed.data.token;
  }

  it('enforce-blocker walk (create): sign up, identity.get, spaces.list, spaces.create, auth.space.enter', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const gate = await newUserGate();
      expect((await call(enforceServer, gate, 'GET', '/v2/identity')).status).toBe(200);
      const before = await call(enforceServer, gate, 'GET', '/v2/spaces');
      expect(before.status).toBe(200);
      expect(before.json).toEqual([]);
      const created = await call(enforceServer, gate, 'POST', '/v2/spaces',
        { name: 'W3 first space', clientMutationId: `w3-${randomUUID()}` });
      expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);
      const spaceId = created.json.space.id as string;
      // Still a gate: the new space is listed but not usable until entered.
      expect(JSON.stringify((await call(enforceServer, gate, 'GET', '/v2/spaces')).json)).toContain(spaceId);
      expect((await call(enforceServer, gate, 'GET', `/v2/spaces/${spaceId}`)).status).toBe(403);
      const entered = await enterOverHttp(enforceServer, gate, spaceId);
      expect(entered.status).toBe(200);
      expect((await call(enforceServer, entered.json.token, 'GET', `/v2/spaces/${spaceId}`)).status).toBe(200);
    });
  });
  it('enforce-blocker walk (invite): sign up, auth.invite.resolve, spaces.invites.redeem, auth.space.enter', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const hGate = await mintBrowser(fixture.accountH, fixture.identityH);
      const hPinned = (await enterOverHttp(enforceServer, hGate, fixture.spaceA)).json.token as string;
      const invite = await call(enforceServer, hPinned, 'POST', `/v2/spaces/${fixture.spaceA}/invites`,
        { clientMutationId: `w3-${randomUUID()}` });
      expect(invite.status, JSON.stringify(invite.json)).toBe(201);
      const code = invite.json.code as string;
      const gate = await newUserGate();
      expect((await call(enforceServer, gate, 'POST', '/v2/auth/invite/resolve', { code })).status).toBe(200);
      const redeemed = await call(enforceServer, gate, 'POST', '/v2/invites/redeem',
        { code, clientMutationId: `w3-${randomUUID()}` });
      expect(redeemed.status, JSON.stringify(redeemed.json)).toBeLessThan(300);
      expect(redeemed.json.spaceId).toBe(fixture.spaceA);
      const entered = await enterOverHttp(enforceServer, gate, fixture.spaceA);
      expect(entered.status).toBe(200);
      expect((await call(enforceServer, entered.json.token, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(200);
      expect((await call(enforceServer, entered.json.token, 'GET', `/v2/entities/${fixture.docB}`)).status).toBe(404);
    });
  });
  it('gate list, paired: identity.get is allowed pinned too; the other invite ops stay refused to a gate', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
    expect((await call(enforceServer, pinned, 'GET', '/v2/identity')).status).toBe(200);
    expect((await call(enforceServer, gate, 'POST', `/v2/spaces/${fixture.spaceA}/invites`,
      { clientMutationId: `w3-${randomUUID()}` })).status).toBe(403);
  });
  it('gate list, paired: spaces.create from a session pinned to A is refused before it writes', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
    const name = `W3 pinned create ${randomUUID()}`;
    const created = await call(enforceServer, pinned, 'POST', '/v2/spaces',
      { name, clientMutationId: `w3-${randomUUID()}` });
    expect(created.status).toBe(403);
    expect(await database.query('select 1 from public.spaces where name = $1', [name])).toEqual([]);
  });
  it('gate list, paired: a session pinned to A redeems an invite into B (not pin-checked) and still cannot read B', async () => {
    const hGate = await mintBrowser(fixture.accountH, fixture.identityH);
    const hInB = (await enterOverHttp(enforceServer, hGate, fixture.spaceB)).json.token as string;
    const invite = await call(enforceServer, hInB, 'POST', `/v2/spaces/${fixture.spaceB}/invites`,
      { clientMutationId: `w3-${randomUUID()}` });
    expect(invite.status).toBe(201);
    const h2Gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    const h2PinnedA = (await enterOverHttp(enforceServer, h2Gate, fixture.spaceA)).json.token as string;
    try {
      const redeemed = await call(enforceServer, h2PinnedA, 'POST', '/v2/invites/redeem',
        { code: invite.json.code, clientMutationId: `w3-${randomUUID()}` });
      // Accepted by the lead: redeem_invite is not pin-checked (an invite is
      // explicit authority). The membership lands; the pin still holds.
      expect(redeemed.status).toBe(200);
      expect((await call(enforceServer, h2PinnedA, 'GET', `/v2/entities/${fixture.docB}`)).status).toBe(404);
    } finally {
      await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `delete from public.entities where id in (
             select entity_id from public.members where space_id = $1 and identity_id = $2)`,
          [fixture.spaceB, fixture.identityH2]);
      });
    }
  });

  it('T8: a pinned node-admin token is refused node.credentials.status', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const gate = await mintBrowser(fixture.accountH, fixture.identityH);
      const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
      expect((await call(enforceServer, pinned, 'GET', '/v2/node/credentials')).status).toBe(403);
    });
  });
  it('T8: positive — the same account\'s gate session keeps it under enforce (node admin is gate admin)', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const gate = await mintBrowser(fixture.accountH, fixture.identityH);
      expect((await call(enforceServer, gate, 'GET', '/v2/node/credentials')).status).toBe(200);
    });
  });

  it('W3 audit: positive — after auth.space.enter the pinned session subscribes to that space under enforce', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
    const c = controlChannelFor(await identityForToken(pinned, 'enforce'), 'enforce');
    await c.send({ type: 'subscribe', spaceIds: [fixture.spaceA, fixture.spaceB] });
    expect(c.subscribed()).toEqual([fixture.spaceA]);
    expect(c.acks()).toEqual([
      { type: 'control.refused', frame: 'subscribe', spaceId: fixture.spaceB, reason: 'forbidden' },
    ]);
  });
  // PTY is grant-bound: the attach grant comes from execution.streams.attach,
  // a catalog op the gate refuses (the consume side is T5, 233).
  it('W3 audit: a gate session cannot mint a PTY attach grant under enforce', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const res = await call(enforceServer, gate, 'POST',
      `/v2/entities/${fixture.workSessionA}/commands/streams-attach`, { mode: 'view' });
    expect(res.status).toBe(403);
  });
  it('W3 audit: positive — a pinned session\'s streams-attach is not gate-refused under enforce', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const pinned = (await enterOverHttp(enforceServer, gate, fixture.spaceA)).json.token as string;
    const res = await call(enforceServer, pinned, 'POST',
      `/v2/entities/${fixture.workSessionA}/commands/streams-attach`, { mode: 'view' });
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// W3-AUDIT (task 01a0d9fd-737c, plan 01a0d9eb §3 W3 "Audit, as tests").
//
// One block per path the plan lists as able to bypass membership. Every row
// runs under `enforce` with H pinned to A unless it says otherwise. A path
// found OPEN is NOT fixed here: its cell asserts today's behaviour and is
// named `KNOWN GAP (W3-audit Fn)`, so the fix flips it and the matrix records
// who owns it. Rows #848 already carries are referenced, not duplicated:
//   - spaces.list / public spaces (218:291, a5): `T8b …`, `K7 rejected, agent …`,
//     `spaces.list does not list an unjoined public space …`
//   - claim-free resolver key sets (a4): `claim-free resolvers — returned keys pinned`
//   - six-claim immutability (a4): `a3 six claims — …`
//   - PTY attach (/p PTY): `T5 …`; projects without a spaceId: `T6 …`
// ---------------------------------------------------------------------------

describe('W3-audit node-admin policies (002, K6) — every is_node_admin() arm is pinned out', () => {
  // The live catalog, not a migration grep: a new policy with a node-admin
  // arm fails the first cell until it is reviewed here and added.
  const NODE_ADMIN_POLICIES = [
    'artifact_bundle_revisions.artifact_bundle_revisions_select',
    'artifact_preview_sessions.artifact_preview_sessions_select',
    'projects.projects_select',
    'server_connections.server_connections_node_admin_select',
  ];
  const connection = `w3-audit-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await database.query(
      `insert into public.server_connections(name, base_url) values ($1, 'https://w3-audit.invalid')`,
      [connection],
    );
  });
  afterAll(async () => {
    await database.query('delete from public.server_connections where name = $1', [connection]);
  });

  it('the node-admin policy set is exactly the reviewed four', async () => {
    const rows = await database.query<{ policy: string }>(
      `select tablename || '.' || policyname as policy from pg_policies
        where schemaname = 'public'
          and coalesce(qual, '') || coalesce(with_check, '') ~ 'is_node_admin'
        order by 1`);
    expect(rows.map((r) => r.policy)).toEqual(NODE_ADMIN_POLICIES);
  });
  it('server_connections (044): a pinned node-admin H sees no connection', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect(await asToken(token, (q) => q.query(
        'select name from public.server_connections where name = $1', [connection]), 'enforce')).toEqual([]);
    });
  });
  it('server_connections: positive — H\'s gate session (node admin) sees it', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const gate = await mintBrowser(fixture.accountH, fixture.identityH);
      expect(await asToken(gate, (q) => q.query(
        'select name from public.server_connections where name = $1', [connection]), 'enforce'))
        .toEqual([{ name: connection }]);
    });
  });
});

describe('W3-audit owner fallback (facade/context.ts claimsFor) — KNOWN GAP (W3-audit F3, owner W2)', () => {
  // The loopback auto-owner has no session row, so neither the resolver nor
  // the enforce gate pins it (space-gate.ts "Deliberately NOT gated"). W2's
  // path-derived claim is what pins it; until then the owner is unpinned.
  const H_AS_OWNER = (): LoopbackOwner => ({
    identityId: fixture.identityH,
    accountId: fixture.accountH,
    username: 'cross-space-h',
    isNodeAdmin: true,
    isOwner: true,
  });
  const ownerTx = <T>(sessionSpaceId: string | undefined, fn: (q: Querier) => Promise<T>): Promise<T> => {
    const identity = {
      kind: 'auto-owner', authKind: 'browser', ...(sessionSpaceId ? { sessionSpaceId } : {}),
    } as unknown as RequestIdentity;
    return db.tx(claimsFor(H_AS_OWNER(), { identity, requestId: `w3-audit-${randomUUID()}` } as unknown as RequestContext), fn);
  };

  it('KNOWN GAP (W3-audit F3): the auto-owner reads B under enforce — unpinned, node admin (W2 closes it)', async () => {
    expect(await ownerTx(undefined, (q) => idsIn(q, fixture.spaceB))).toContain(fixture.docB);
    const claims = claimsFor(H_AS_OWNER(), {
      identity: { kind: 'auto-owner', authKind: 'browser' }, requestId: 'w3-audit',
    } as unknown as RequestContext);
    expect(claims.nodeAdmin).toBe(true);
    expect(claims.sessionSpaceId).toBeUndefined();
  });
  it('the fallback never sheds a pin: an auto-owner carrying a space claim reads only that space', async () => {
    expect(await ownerTx(fixture.spaceA, (q) => idsIn(q, fixture.spaceB))).toEqual([]);
    const claims = claimsFor(H_AS_OWNER(), {
      identity: { kind: 'auto-owner', authKind: 'browser', sessionSpaceId: fixture.spaceA }, requestId: 'w3-audit',
    } as unknown as RequestContext);
    expect(claims.nodeAdmin).toBe(false);
  });
  it('positive — the same pinned auto-owner reads A', async () => {
    expect(await ownerTx(fixture.spaceA, (q) => idsIn(q, fixture.spaceA))).toContain(fixture.docA);
  });
});

describe('W3-audit wallet rows (083 / 093 / 203) — account-scoped, not space-scoped', () => {
  // credential_sessions, account_git_credentials and account_service_keys are
  // the ACCOUNT's rows (policy account_id = current_account_id()). A pin does
  // not narrow them, by design: they are no space's. What must hold is that
  // no other account reaches them. (The wallet is dropped in plan v3; W10's
  // credential entities replace it.)
  const gitCredential = randomUUID();

  beforeAll(async () => {
    await database.query(
      `insert into public.account_git_credentials(id, account_id, provider, login, token_ciphertext, token_nonce)
       values ($1, $2, 'github', 'w3-audit', decode(repeat('00', 17), 'hex'), decode(repeat('00', 12), 'hex'))`,
      [gitCredential, fixture.accountH],
    );
  });
  afterAll(async () => {
    await database.query('delete from public.account_git_credentials where id = $1', [gitCredential]);
  });

  const visible = (token: string) => asToken(token, (q) => q.query<{ id: string }>(
    'select id::text from public.account_git_credentials where id = $1', [gitCredential]), 'enforce');

  it('H2 pinned to A (another account, same space) cannot read H\'s wallet row', async () => {
    expect(await visible(await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA))).toEqual([]);
  });
  it('positive — H pinned to A reads its own wallet row (account, not space)', async () => {
    expect(await visible(await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA)))
      .toEqual([{ id: gitCredential }]);
  });
  it('the three wallet policies are account-only (no membership arm to pin)', async () => {
    const rows = await database.query<{ tablename: string; qual: string }>(
      `select tablename, qual from pg_policies
        where tablename in ('account_git_credentials', 'account_service_keys', 'credential_sessions')
        order by 1`);
    expect(rows.map((r) => [r.tablename, r.qual.replace(/\s+/g, ' ')])).toEqual([
      ['account_git_credentials', '(account_id = internal.current_account_id())'],
      ['account_service_keys', '(account_id = internal.current_account_id())'],
      ['credential_sessions', '(account_id = internal.current_account_id())'],
    ]);
  });
});

describe('W3-audit WS admission (control.ts canSubscribe) under enforce', () => {
  // Built as main.ts builds it: the boot-time mode reaches the authorizer.
  const authorizer = () => new DbSubscriptionAuthorizer(db, async (identity) =>
    claimsFor(NOT_THE_OWNER, { identity, requestId: `w3-audit-${randomUUID()}` } as unknown as RequestContext),
  { spaceSessions: 'enforce' });

  it('closed (W3-audit F2, #848 S1): a GATE session is refused its own member space\'s event stream under enforce', async () => {
    // Was OPEN at #848 3b0a25eb (canSubscribe never consulted the gate). #848
    // 13880032 refuses it in canSubscribe; its own cells are T3's "a gate
    // session subscribes to nothing when the authorizer runs under enforce"
    // and the subscribe-AND-resume cell. This row asserts the audit path.
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const identity = await identityForToken(gate, 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceA)).toBe(false);
  });
  it('a pinned session is refused a space other than its pin', async () => {
    const identity = await identityForToken(
      await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA), 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceB)).toBe(false);
  });
  it('positive — the same pinned session is admitted to its own space', async () => {
    const identity = await identityForToken(
      await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA), 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceA)).toBe(true);
  });
  it('H2 (not a member of B) is refused B even from a gate session', async () => {
    const identity = await identityForToken(await mintBrowser(fixture.accountH2, fixture.identityH2), 'enforce');
    expect(await authorizer().canSubscribe(identity, fixture.spaceB)).toBe(false);
  });
});

describe('W3-audit Fable\'s cross-space project read (176 start_chat project mode)', () => {
  // start_chat is SECURITY DEFINER and resolves the project through
  // space_projects for p_space_id (176:691-700). The space itself is guarded by
  // require_space_member (pinned, 227) before the lookup runs.
  const projectA = randomUUID();
  const projectB = randomUUID();

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1, 'audit A project', '/tmp/w3-audit-a', 'trusted'),
                ($2, 'audit B project', '/tmp/w3-audit-b', 'trusted')`,
        [projectA, projectB]);
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($1, $3, $5), ($2, $4, $6)`,
        [fixture.spaceA, fixture.spaceB, projectA, projectB, fixture.memberHA, fixture.memberHB]);
    });
  });

  const startChat = (token: string, spaceId: string, projectId: string) =>
    asToken(token, (q) => q.rpc('start_chat', [
      randomUUID(), spaceId, fixture.personaA, 'claude-opus-5', 'anthropic', 'claude-code',
      'ask', 'project', projectId, randomUUID(), null, 'w3-audit', 'hello', null, null,
      `w3-audit-${randomUUID()}`,
    ]), 'enforce');

  it('a chat in B on B\'s project is refused to H pinned to A', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => startChat(token, fixture.spaceB, projectB))).toBe('42501');
  });
  it('a chat in A naming B\'s project is refused (the project is resolved through A\'s link only)', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => startChat(token, fixture.spaceA, projectB))).toBe('P0002');
  });
  it('positive — a chat in A on A\'s project starts', async () => {
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => startChat(token, fixture.spaceA, projectA))).toBe('ok');
  });
});

describe('W3-audit T31 (W3 half) — B\'s project and everything read through it (DB)', () => {
  // projects.get / branches / blame / file-history / files / contention all
  // start from `PROJECT_SELECT where id = $1` under the caller's claims
  // (projects-associations.ts projectRowFor, contention.ts), so the project row
  // IS their authorization. The HTTP twin is in the W3-audit HTTP block.
  const projectB = randomUUID();
  const projectOfA = randomUUID();

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1, 'T31 B project', '/tmp/w3-audit-t31-b', 'trusted'),
                ($2, 'T31 A project', '/tmp/w3-audit-t31-a', 'trusted')`,
        [projectB, projectOfA]);
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($2, $3, $5), ($1, $4, $6)`,
        [fixture.spaceA, fixture.spaceB, projectB, projectOfA, fixture.memberHB, fixture.memberHA]);
    });
  });

  const seen = (token: string, id: string) => asToken(token, (q) => q.query(
    'select id from public.projects where id = $1', [id]), 'enforce');

  it('B\'s project row is not_found to H pinned to A, even as node admin', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      expect(await seen(await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA), projectB)).toEqual([]);
    });
  });
  // 234 (W11): public.projects is the folder grant, readable only by a gate
  // admin on an unpinned session (projects_select); the space's project is the
  // `project` entity.
  it('positive — H\'s unpinned gate-admin session sees it', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      expect((await seen(await mintBrowser(fixture.accountH, fixture.identityH), projectB)).length).toBe(1);
    });
  });
  it('A\'s own folder is not readable pinned to A, even as node admin (234: folders are the gate\'s; one space per folder)', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      expect(await seen(await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA), projectOfA)).toEqual([]);
    });
  });
});

describe('W3-audit teammate-session hole (075 + grant_stream_attach 187/202) — closed by W10c', () => {
  // Credentials doc 01a0da24 §3h. can_act_as (075) lets every active member act
  // as a teammate, and grant_stream_attach treats "may act as the creator" plus
  // sharing_set_at null as the owner right, so any member of A can view AND
  // drive an unconfigured agent session in A. Nothing stamps sharing_set_at at
  // launch. Recorded, NOT fixed here: closed by W10c (private-credential
  // owner-only attach gate). W3 neither closes nor widens it — the pin keeps it
  // inside the session's own space.
  const grant = (token: string, sessionId: string, mode: 'view' | 'drive') =>
    asToken(token, (q) => q.rpc('grant_stream_attach', [
      sessionId, mode, hashToken(generateSecret()), null, null]), 'enforce');

  it('CURRENT BEHAVIOUR (closed by W10c): H2 — a plain member of A — may DRIVE H\'s agent session in A', async () => {
    const token = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await outcome(() => grant(token, fixture.workSessionA, 'drive'))).toBe('ok');
  });
  it('W3 does not widen it: H2\'s gate session gets exactly the same answer as pinned', async () => {
    const gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await outcome(() => grant(gate, fixture.workSessionA, 'drive'))).toBe('ok');
  });
  it('the hole stops at the space: H pinned to A cannot view its own agent sessions\' peers in B', async () => {
    const workSessionB = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
        [workSessionB, fixture.spaceB, fixture.memberHB]);
      await client.query(
        `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
         values ($1, 'audit B run', 'running', 'none', now())`, [workSessionB]);
    });
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => grant(token, workSessionB, 'view'))).toBe('42501');
    // Positive: H's gate session (a member of B) holds the owner right there.
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await outcome(() => grant(gate, workSessionB, 'view'))).toBe('ok');
  });
});

describe('W3-audit identity_id() readers that skip the pin — KNOWN GAPs found by the F7 gate review', () => {
  // tools/ci/identity-id-allowlist.txt tags every live identity_id() reader;
  // these are the OPEN ones a pinned caller reaches today.
  const notificationIn = async (spaceId: string, memberId: string): Promise<string> => {
    const rows = await database.query<{ id: string }>(
      `insert into public.notifications(space_id, recipient_member_id, kind, payload)
       values ($1, $2, 'mention', '{}'::jsonb) returning id::text`, [spaceId, memberId]);
    return rows[0]!.id;
  };
  const readAt = async (id: string) => (await database.query<{ read_at: Date | null }>(
    'select read_at from public.notifications where id = $1', [id]))[0]!.read_at;
  const markRead = (token: string, id: string) => asToken(token, (q) => q.rpc(
    'mark_notification_read', [id, 'member', null, `w3-audit-${randomUUID()}`]), 'enforce');

  it('pinned H cannot SEE B\'s notification (notifications_select is pinned)', async () => {
    const nB = await notificationIn(fixture.spaceB, fixture.memberHB);
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await asToken(token, (q) => q.query(
      'select id from public.notifications where id = $1', [nB]), 'enforce')).toEqual([]);
  });
  it('F1 CLOSED (246): …and mark_notification_read (4-arg) refuses it pinned to A — not found, read_at stays null', async () => {
    const nB = await notificationIn(fixture.spaceB, fixture.memberHB);
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => markRead(token, nB))).toBe('P0002');
    expect(await readAt(nB)).toBeNull();
  });
  it('positive — the same pinned credential marks A\'s notification read', async () => {
    const nA = await notificationIn(fixture.spaceA, fixture.memberHA);
    const token = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => markRead(token, nA))).toBe('ok');
    expect(await readAt(nA)).not.toBeNull();
  });
  it('H2 (no member row in B) cannot mark B\'s notification — the gap is same-identity only', async () => {
    const nB = await notificationIn(fixture.spaceB, fixture.memberHB);
    const token = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await outcome(() => markRead(token, nB))).not.toBe('ok');
    expect(await readAt(nB)).toBeNull();
  });
});

describe('W3-audit over HTTP under enforce — T31 project routes, T4 files.download, inbox.markRead', () => {
  let server: BootstrappedServer;
  const projectA = randomUUID();
  const projectB = randomUUID();
  const fileA = randomUUID();
  const fileB = randomUUID();
  const checksum = 'ab'.repeat(32);
  let adminBefore: Array<{ id: string; is_node_admin: boolean; is_owner: boolean }> = [];
  const dirs: Record<'a' | 'b', string> = { a: '', b: '' };

  // A real repository per project, so a B refusal is the authorization and
  // not a missing working dir, and the A positive runs the same git code.
  const repo = async (label: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), `tm8-w3-audit-${label}-`));
    const git = (...args: string[]) => {
      const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`git ${args[0]}: ${run.stderr}`);
    };
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'README.md'), `w3 audit ${label}\n`);
    git('add', 'README.md');
    git('-c', 'user.name=w3-audit', '-c', 'user.email=w3-audit@invalid', 'commit', '-q', '-m', 'seed');
    return dir;
  };

  beforeAll(async () => {
    const [dirA, dirB] = [dirs.a, dirs.b] = [await repo('a'), await repo('b')];
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      adminBefore = (await client.query<{ id: string; is_node_admin: boolean; is_owner: boolean }>(
        'select id::text, is_node_admin, is_owner from public.accounts where id = any($1::uuid[])',
        [[fixture.accountH, fixture.accountH2]],
      )).rows;
      await client.query(
        `update public.accounts set is_node_admin = (id = $1::uuid), is_owner = (id = $1::uuid)
          where id = any($2::uuid[])`,
        [fixture.accountH, [fixture.accountH, fixture.accountH2]],
      );
      await client.query(
        `insert into public.projects(id, name, working_dir, trust)
         values ($1, 'W3-audit HTTP A', $3, 'trusted'), ($2, 'W3-audit HTTP B', $4, 'trusted')`,
        [projectA, projectB, dirA, dirB],
      );
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($1, $3, $5), ($2, $4, $6)`,
        [fixture.spaceA, fixture.spaceB, projectA, projectB, fixture.memberHA, fixture.memberHB],
      );
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $3, 'file', $5, 'space'), ($2, $4, 'file', $6, 'space')`,
        [fileA, fileB, fixture.spaceA, fixture.spaceB, fixture.memberHA, fixture.memberHB],
      );
      await client.query(
        `insert into public.files(entity_id, name, mime_type, size_bytes, storage_path, checksum_sha256)
         values ($1, 'a.txt', 'text/plain', 1, 'spaces/' || $3::text || '/w3-audit-a.txt', $5),
                ($2, 'b.txt', 'text/plain', 1, 'spaces/' || $4::text || '/w3-audit-b.txt', $5)`,
        [fileA, fileB, fixture.spaceA, fixture.spaceB, checksum],
      );
    });
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_NODE_MODE: 'single',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-w3-audit-')),
      TM8_DISABLE_AUTO_OWNER: '1',
      TM8_SPACE_SESSIONS: 'enforce',
    });
    server = await bootstrap({ config: { ...configured, port: 0 } });
  }, 180_000);

  afterAll(async () => {
    await server?.server.close();
    await server?.db?.end();
    for (const row of adminBefore) {
      await database.query(
        'update public.accounts set is_node_admin = $2, is_owner = $3 where id = $1::uuid',
        [row.id, row.is_node_admin, row.is_owner],
      );
    }
  }, 180_000);

  async function send(
    token: string,
    method: 'GET' | 'PUT',
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<number> {
    const response = await fetch(new URL(path, server.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await response.arrayBuffer();
    return response.status;
  }
  const pinnedH = () => mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);

  // Every read keyed on a project id alone (T31). The file-scoped reads take
  // a path; `files` and `files/archive` list the root.
  // files/content wants an absolute path inside the project's own dir.
  const PROJECT_READS: Array<[string, (dir: string) => string]> = [
    ['', () => ''], ['/contention', () => ''], ['/branches', () => ''],
    ['/files', () => ''], ['/files/archive', () => ''],
    ['/file-history', () => '?path=README.md'], ['/blame', () => '?path=README.md'],
    ['/files/content', (dir) => `?path=${encodeURIComponent(join(dir, 'README.md'))}`],
  ];

  for (const [read, query] of PROJECT_READS) {
    it(`T31 GET /v2/projects/:B${read} is 404 to H pinned to A (node admin on its gate session)`, async () => {
      expect(await send(await pinnedH(), 'GET', `/v2/projects/${projectB}${read}${query(dirs.b)}`)).toBe(404);
    });
    it(`T31 positive — GET /v2/projects/:A${read} answers 200 to the same pin`, async () => {
      expect(await send(await pinnedH(), 'GET', `/v2/projects/${projectA}${read}${query(dirs.a)}`)).toBe(200);
    });
  }

  it('T4 /p file: files.download of B\'s file is 404 to H pinned to A', async () => {
    expect(await send(await pinnedH(), 'GET', `/v2/files/${fileB}/download`,
      { 'if-none-match': `"sha256-${checksum}"` })).toBe(404);
  });
  it('T4 positive — the same pin revalidates A\'s file (304 on its checksum ETag, no blob read)', async () => {
    expect(await send(await pinnedH(), 'GET', `/v2/files/${fileA}/download`,
      { 'if-none-match': `"sha256-${checksum}"` })).toBe(304);
  });

  const notificationIn = async (spaceId: string, memberId: string): Promise<string> =>
    (await database.query<{ id: string }>(
      `insert into public.notifications(space_id, recipient_member_id, kind, payload)
       values ($1, $2, 'mention', '{}'::jsonb) returning id::text`, [spaceId, memberId]))[0]!.id;
  const readAt = async (id: string) => (await database.query<{ read_at: Date | null }>(
    'select read_at from public.notifications where id = $1', [id]))[0]!.read_at;

  it('F1 CLOSED (246) over HTTP: PUT /v2/inbox/:B/read from H pinned to A answers 404 and leaves B\'s row unread', async () => {
    const nB = await notificationIn(fixture.spaceB, fixture.memberHB);
    const status = await send(await pinnedH(), 'PUT', `/v2/inbox/${nB}/read`, {},
      { clientMutationId: `w3-audit-${randomUUID()}` });
    expect({ status, marked: (await readAt(nB)) !== null }).toEqual({ status: 404, marked: false });
  });
  it('inbox.markRead positive — PUT /v2/inbox/:A/read from the same pin marks it', async () => {
    const nA = await notificationIn(fixture.spaceA, fixture.memberHA);
    expect(await send(await pinnedH(), 'PUT', `/v2/inbox/${nA}/read`, {},
      { clientMutationId: `w3-audit-${randomUUID()}` })).toBe(200);
    expect(await readAt(nA)).not.toBeNull();
  });
});

describe('W3-audit ledger replay before the space guard (046 ledger_replay) — executed per function', () => {
  // command_ledger is keyed (client_mutation_id, identity, operation): no space
  // and no pin. A function that replays BEFORE its space guard hands a result
  // recorded in A to the same identity pinned to B. require_replay_subject
  // only checks the request addresses the same resource, not that the caller
  // may still reach it. Each function gets: record pinned to A; replay pinned
  // to B with the same cmid (the cell); the same call pinned to B with a FRESH
  // cmid (the guard, which is what the replay skips); replay pinned to A (the
  // positive).
  const pinnedTo = (spaceId: string) => mintPinned(fixture.accountH, fixture.identityH, spaceId);
  // `marker` is the A resource the recorded body names.
  type Case = { name: string; fresh: string; marker: (cmid: string) => string;
    call: (token: string, cmid: string) => Promise<unknown> };
  const cases: Case[] = [];
  const add = (name: string, fresh: string, marker: Case['marker'], call: Case['call']) =>
    cases.push({ name, call, fresh, marker });

  const streamHash = hashToken(generateSecret());
  add('grant_stream_attach', '42501', () => fixture.workSessionA, (token, cmid) => asToken(token, (q) => q.rpc('grant_stream_attach', [
    fixture.workSessionA, 'view', streamHash, null, cmid]), 'enforce'));

  // One chat per cmid: a replay must address the chat it recorded.
  const chats = new Map<string, [string, string]>();
  const chatFor = (cmid: string) => chats.get(cmid) ?? chats.set(cmid, [randomUUID(), randomUUID()]).get(cmid)!;
  add('start_chat', '42501', (cmid) => chatFor(cmid)[0], (token, cmid) => asToken(token, (q) => q.rpc('start_chat', [
    chatFor(cmid)[0], fixture.spaceA, fixture.personaA, 'claude-opus-5', 'anthropic', 'claude-code',
    'ask', 'scratch', null, chatFor(cmid)[1], '/tmp/w3-audit-replay', 'w3-audit replay', 'hello', null, null, cmid,
  ]), 'enforce'));

  add('set_member_role', '42501', () => fixture.spaceA, (token, cmid) => asToken(token, (q) => q.rpc('set_member_role', [
    fixture.spaceA, fixture.memberH2A, 'member', null, cmid]), 'enforce'));

  for (const { name, call, fresh, marker } of cases) {
    it(`KNOWN GAP (W3-audit F4): ${name} replays A's recorded result to H pinned to B`, async () => {
      const cmid = `w3-audit-replay-${name}-${randomUUID()}`;
      expect(await outcome(async () => call(await pinnedTo(fixture.spaceA), cmid))).toBe('ok');
      // Expected after the fix: 42501, the same as the fresh call below.
      const replayed = await call(await pinnedTo(fixture.spaceB), cmid);
      // The body a B-pinned session receives is A's: it names the A resource.
      expect(JSON.stringify(replayed)).toContain(marker(cmid));
    });
    it(`${name}: the guard the replay skips — pinned to B with a fresh cmid is refused`, async () => {
      expect(await outcome(async () => call(await pinnedTo(fixture.spaceB), `w3-audit-fresh-${randomUUID()}`)))
        .toBe(fresh);
    });
    it(`${name}: positive — the replay pinned to A returns`, async () => {
      const cmid = `w3-audit-replay-${name}-${randomUUID()}`;
      expect(await outcome(async () => call(await pinnedTo(fixture.spaceA), cmid))).toBe('ok');
      expect(await outcome(async () => call(await pinnedTo(fixture.spaceA), cmid))).toBe('ok');
    });
  }

  it('KNOWN GAP (W3-audit F4): w2_withdraw_handoff returns a recorded A withdrawal to H pinned to B (ledger row seeded)', async () => {
    // A real handoff needs the dispatcher; the replay branch reads only the
    // ledger, so the row it would have recorded is seeded as graph owner.
    const cmid = `w3-audit-withdraw-${randomUUID()}`;
    const handoffId = `w3-audit-${randomUUID()}`;
    await database.query(
      `insert into public.command_ledger(client_mutation_id, identity_id, operation, result)
       values ($1, $2, 'handoffs.withdraw', jsonb_build_object('handoff', jsonb_build_object(
         'id', $3::text, 'source_space_id', $4::text)))`,
      [cmid, fixture.identityH, handoffId, fixture.spaceA]);
    const withdraw = async (spaceId: string, id: string) => asToken(await pinnedTo(spaceId),
      (q) => q.rpc<{ handoff?: { source_space_id?: string } }>('w2_withdraw_handoff', [handoffId, 1, null, null, id]),
      'enforce');
    expect((await withdraw(fixture.spaceB, cmid)).handoff?.source_space_id).toBe(fixture.spaceA);
    // The guard path: a fresh cmid reaches the handoff lookup and finds none.
    expect(await outcome(() => withdraw(fixture.spaceB, `w3-audit-fresh-${randomUUID()}`))).not.toBe('ok');
  });

  const trackingRows = async (spaceId: string) => (await database.query<{ n: number }>(
    'select count(*)::int n from public.tracking_refresh_requests where space_id = $1', [spaceId]))[0]!.n;
  const refreshAll = (token: string, cmid = `w3-audit-${randomUUID()}`) =>
    asToken(token, (q) => q.rpc('queue_tracking_refresh', [[], null, cmid]), 'enforce');

  it('queue_tracking_refresh (no ids) pinned to A is refused outright and queues nothing in B', async () => {
    // Its members loop (raw members, no pin) reaches B, where resolve_actor
    // refuses under the A pin, so the whole call fails: CLOSED for the leak,
    // but a pinned session cannot "refresh all" at all (a W3 functional gap).
    const before = await trackingRows(fixture.spaceB);
    expect(await outcome(async () => refreshAll(await pinnedTo(fixture.spaceA)))).toBe('42501');
    expect(await trackingRows(fixture.spaceB)).toBe(before);
  });
  it('queue_tracking_refresh positive — H\'s gate session (unpinned) queues A and B', async () => {
    const [a, b] = [await trackingRows(fixture.spaceA), await trackingRows(fixture.spaceB)];
    await refreshAll(await mintBrowser(fixture.accountH, fixture.identityH));
    expect([await trackingRows(fixture.spaceA), await trackingRows(fixture.spaceB)]).toEqual([a + 1, b + 1]);
  });
  it('KNOWN GAP (W3-audit F4): queue_tracking_refresh replays a gate-recorded A+B result to H pinned to B', async () => {
    const cmid = `w3-audit-replay-tracking-${randomUUID()}`;
    await refreshAll(await mintBrowser(fixture.accountH, fixture.identityH), cmid);
    expect(await outcome(async () => refreshAll(await pinnedTo(fixture.spaceB), cmid))).toBe('ok');
    expect(await outcome(async () => refreshAll(await pinnedTo(fixture.spaceB)))).toBe('42501');
  });
});

/**
 * W3-client (task 01a0d9fd): the walk the UI and CLI make, over the real
 * server. H (a member of A and B) holds one gate session and switches A → B
 * without logging out. Every rule the clients rely on is a cell here, each
 * refusal paired with its positive:
 *   - `auth.space.enter` accepts gate Authorization next to an older pinned
 *     cookie and replaces the cookie (the browser's mint path);
 *   - any other op refuses gate Authorization next to a pinned cookie, and
 *     serves the same header alone (why clients omit cookies under enforce);
 *   - both pins stay live after the switch, each confined to its own space;
 *   - the enforce refusal names `auth.space.enter` (the clients' detector);
 *   - a pin revoked with its own token dies, and its gate lives on.
 * `agents` twin: the pre-W3 walk (gate header plus gate cookie) is served.
 */
describe('T8c client walk — switch A → B without logout, cookie rules (W3-client)', () => {
  let enforceServer: BootstrappedServer;
  let agentsServer: BootstrappedServer;
  let adminBefore: Array<{ id: string; is_node_admin: boolean; is_owner: boolean }> = [];

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      adminBefore = (await client.query<{ id: string; is_node_admin: boolean; is_owner: boolean }>(
        'select id::text, is_node_admin, is_owner from public.accounts where id = any($1::uuid[])',
        [[fixture.accountH, fixture.accountH2]],
      )).rows;
      await client.query(
        `update public.accounts set is_node_admin = (id = $1::uuid), is_owner = (id = $1::uuid)
          where id = any($2::uuid[])`,
        [fixture.accountH, [fixture.accountH, fixture.accountH2]],
      );
    });
    const start = async (mode: SpaceSessionsMode): Promise<BootstrappedServer> => {
      const configured = loadConfig({
        ...process.env,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: '4610',
        TM8_NODE_MODE: 'single',
        TM8_DATABASE_URL: database.url,
        TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-w3c-')),
        TM8_DISABLE_AUTO_OWNER: '1',
        TM8_SPACE_SESSIONS: mode,
      });
      return bootstrap({ config: { ...configured, port: 0 } });
    };
    enforceServer = await start('enforce');
    agentsServer = await start('agents');
  }, 180_000);

  afterAll(async () => {
    for (const server of [enforceServer, agentsServer]) {
      await server?.server.close();
      await server?.db?.end();
    }
    for (const row of adminBefore) {
      await database.query(
        'update public.accounts set is_node_admin = $2, is_owner = $3 where id = $1::uuid',
        [row.id, row.is_node_admin, row.is_owner],
      );
    }
  }, 180_000);

  interface Sent { status: number; json: any; setCookie: string | null }

  /** One request as a client sends it: optional bearer, optional cookie. */
  async function send(
    server: BootstrappedServer,
    creds: { bearer?: string; cookie?: string },
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Sent> {
    const response = await fetch(new URL(path, server.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        ...(creds.bearer ? { authorization: `Bearer ${creds.bearer}` } : {}),
        ...(creds.cookie ? { cookie: `${TM8_SESSION_COOKIE}=${creds.cookie}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    return {
      status: response.status,
      json: parsed && 'data' in parsed ? parsed.data : parsed,
      setCookie: response.headers.get('set-cookie'),
    };
  }

  const cookieValue = (setCookie: string | null): string | null =>
    setCookie?.match(new RegExp(`${TM8_SESSION_COOKIE}=([^;]*)`))?.[1] ?? null;

  /** The browser walk: gate pass in the jar, enter A, then enter B. */
  async function switchAB(): Promise<{ gate: string; pinA: string; pinB: string }> {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const intoA = await send(enforceServer, { bearer: gate, cookie: gate }, 'POST', '/v2/auth/space/enter',
      { spaceId: fixture.spaceA });
    expect(intoA.status, JSON.stringify(intoA.json)).toBe(200);
    const pinA = intoA.json.token as string;
    expect(cookieValue(intoA.setCookie)).toBe(pinA);
    // The jar now holds pinA; the switch presents the gate next to it.
    const intoB = await send(enforceServer, { bearer: gate, cookie: pinA }, 'POST', '/v2/auth/space/enter',
      { spaceId: fixture.spaceB });
    expect(intoB.status, JSON.stringify(intoB.json)).toBe(200);
    const pinB = intoB.json.token as string;
    expect(cookieValue(intoB.setCookie)).toBe(pinB);
    return { gate, pinA, pinB };
  }

  it('switch: enter B with the gate next to A\'s pinned cookie is accepted and replaces the cookie', async () => {
    const { pinA, pinB } = await switchAB();
    expect(pinB).not.toBe(pinA);
  });
  it('switch, paired: a PINNED Authorization cannot enter, cookie or not', async () => {
    const { pinA } = await switchAB();
    expect((await send(enforceServer, { bearer: pinA }, 'POST', '/v2/auth/space/enter',
      { spaceId: fixture.spaceB })).status).toBe(403);
  });

  it('A\'s pin reads B → not_found after the switch; positive — B\'s pin reads B', async () => {
    const { pinA, pinB } = await switchAB();
    expect((await send(enforceServer, { bearer: pinA }, 'GET', `/v2/entities/${fixture.docB}`)).status).toBe(404);
    expect((await send(enforceServer, { bearer: pinB }, 'GET', `/v2/entities/${fixture.docB}`)).status).toBe(200);
  });
  it('B\'s pin reads A → not_found; positive — A\'s pin still reads A (no logout on switch)', async () => {
    const { pinA, pinB } = await switchAB();
    expect((await send(enforceServer, { bearer: pinB }, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(404);
    expect((await send(enforceServer, { bearer: pinA }, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(200);
  });

  it('cookie rule: gate Authorization next to a pinned cookie is refused on spaces.list', async () => {
    const { gate, pinB } = await switchAB();
    const refused = await send(enforceServer, { bearer: gate, cookie: pinB }, 'GET', '/v2/spaces');
    expect(refused.status).toBe(401);
  });
  it('cookie rule: positive — the same gate Authorization with cookies omitted lists spaces', async () => {
    const { gate } = await switchAB();
    const listed = await send(enforceServer, { bearer: gate }, 'GET', '/v2/spaces');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).toContain(fixture.spaceB);
  });
  it('cookie rule: a pinned Authorization next to a different pinned cookie is refused; alone it is served', async () => {
    const { pinA, pinB } = await switchAB();
    expect((await send(enforceServer, { bearer: pinA, cookie: pinB }, 'GET', `/v2/entities/${fixture.docA}`)).status)
      .toBe(401);
    expect((await send(enforceServer, { bearer: pinA }, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(200);
  });

  it('detector: the enforce refusal of a gate read is 403 forbidden naming auth.space.enter', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    const refused = await send(enforceServer, { bearer: gate }, 'GET', `/v2/entities/${fixture.docA}`);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('forbidden');
    expect(refused.json.error.message).toContain('auth.space.enter');
  });
  it('detector, paired: a not_found from a pin does NOT name auth.space.enter (no mint loop)', async () => {
    const { pinA } = await switchAB();
    const missing = await send(enforceServer, { bearer: pinA }, 'GET', `/v2/entities/${fixture.docB}`);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.json)).not.toContain('auth.space.enter');
  });

  it('revoke: auth.logout with the pin alone kills the pin; positive — the gate lives on and re-enters', async () => {
    const { gate, pinA } = await switchAB();
    expect((await send(enforceServer, { bearer: pinA }, 'POST', '/v2/auth/logout', {})).status).toBe(200);
    expect((await send(enforceServer, { bearer: pinA }, 'GET', `/v2/entities/${fixture.docA}`)).status).toBe(401);
    expect((await send(enforceServer, { bearer: gate }, 'GET', '/v2/spaces')).status).toBe(200);
    const again = await send(enforceServer, { bearer: gate }, 'POST', '/v2/auth/space/enter', { spaceId: fixture.spaceA });
    expect(again.status).toBe(200);
    expect((await send(enforceServer, { bearer: again.json.token }, 'GET', `/v2/entities/${fixture.docA}`)).status)
      .toBe(200);
  });

  it('agents (a4): the pre-W3 walk — gate header plus gate cookie — reads A and B, nothing entered', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect((await send(agentsServer, { bearer: gate, cookie: gate }, 'GET', `/v2/entities/${fixture.docA}`)).status)
      .toBe(200);
    expect((await send(agentsServer, { bearer: gate, cookie: gate }, 'GET', `/v2/entities/${fixture.docB}`)).status)
      .toBe(200);
  });
  it('agents, paired: the same gate walk under enforce is refused (the client must enter)', async () => {
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect((await send(enforceServer, { bearer: gate, cookie: gate }, 'GET', `/v2/entities/${fixture.docA}`)).status)
      .toBe(403);
  });
});

// ---------------------------------------------------------------------------
// W4 — auth.sessions.list / auth.sessions.revoke across the boundary (249).
//
// The full a1–a3 matrix lives in auth-sessions-list-revoke.pg.test.ts; these
// rows are the cross-space cells: which credential sees and revokes sessions
// pinned to which space. Refusal + positive per cell, as everywhere above.
// ---------------------------------------------------------------------------

describe('W4 — session listing and revoke across spaces', () => {
  const listAs = (token: string, spaceId: string | null) =>
    asToken(token, (q) => q.rpc<unknown[]>('list_auth_sessions', [spaceId]), 'enforce');
  const revokeAs = (token: string, sessionId: string) =>
    asToken(token, (q) => q.rpc<{ revoked: boolean }>('revoke_listed_auth_session', [sessionId]), 'enforce');
  const sessionIdOf = (token: string): string => parseToken(token)!.sessionId;
  const listed = async (token: string, spaceId: string | null): Promise<string[]> =>
    ((await listAs(token, spaceId)) as Array<{ sessionId: string }>).map((r) => r.sessionId);

  it('W4-1: H pinned to A cannot list B\'s sessions (42501)', async () => {
    const pinnedA = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await outcome(() => listAs(pinnedA, fixture.spaceB))).toBe('42501');
  });
  it('W4-1: positive — H pinned to B lists B', async () => {
    const pinnedB = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceB);
    expect(await outcome(() => listAs(pinnedB, fixture.spaceB))).toBe('ok');
  });

  it('W4-2: H2 (member, not admin, of A) cannot list A\'s sessions (42501)', async () => {
    const h2 = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await outcome(() => listAs(h2, fixture.spaceA))).toBe('42501');
  });
  it('W4-2: positive — H (owner of A) lists A and sees H2\'s A-pinned session', async () => {
    const h2 = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    const h = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await listed(h, fixture.spaceA)).toContain(sessionIdOf(h2));
  });

  it('W4-3: H2 cannot revoke H\'s A-pinned session (P0002)', async () => {
    const h = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    const h2 = await mintBrowser(fixture.accountH2, fixture.identityH2);
    expect(await outcome(() => revokeAs(h2, sessionIdOf(h)))).toBe('P0002');
  });
  it('W4-3: positive — H pinned to A revokes H2\'s A-pinned session', async () => {
    const h2 = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    const h = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect((await revokeAs(h, sessionIdOf(h2))).revoked).toBe(true);
  });

  it('W4-4: an agent token (pinned to A by construction) cannot list A or revoke (42501)', async () => {
    const agent = await mintAgent();
    const target = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await outcome(() => listAs(agent, fixture.spaceA))).toBe('42501');
    expect(await outcome(() => revokeAs(agent, sessionIdOf(target)))).toBe('42501');
  });
  it('W4-4: positive — the launching human revokes that agent session from A', async () => {
    const agent = await mintAgent();
    const h = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect((await revokeAs(h, sessionIdOf(agent))).revoked).toBe(true);
  });

  it('W4-5: a node admin PINNED to A cannot revoke H2\'s gate session (K6: no node admin under a pin)', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const h2Gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
      const pinned = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
      expect(await outcome(() => revokeAs(pinned, sessionIdOf(h2Gate)))).toBe('P0002');
    });
  });
  it('W4-5: positive — the same node admin\'s GATE session revokes it', async () => {
    await withNodeAdmin(fixture.accountH, true, async () => {
      const h2Gate = await mintBrowser(fixture.accountH2, fixture.identityH2);
      const gate = await mintBrowser(fixture.accountH, fixture.identityH);
      expect((await revokeAs(gate, sessionIdOf(h2Gate))).revoked).toBe(true);
    });
  });

  // W4-P1 (train-1 security audit) reversed the earlier person-scoped decision:
  // under a pin the OWN list and revoke stay inside the pinned space. H pinned
  // to A neither sees nor revokes H's own B-pinned session; H's unpinned gate
  // session still can (the Sessions page from the gate kills a stolen session).
  it('W4-6: refusal — H pinned to A neither lists nor revokes its OWN B-pinned session', async () => {
    const inB = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceB);
    const inA = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceA);
    expect(await listed(inA, null)).not.toContain(sessionIdOf(inB));
    expect(await outcome(() => revokeAs(inA, sessionIdOf(inB)))).toBe('P0002');
  });
  it('W4-6: positive — H\'s unpinned gate session lists and revokes the B-pinned one', async () => {
    const inB = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceB);
    const gate = await mintBrowser(fixture.accountH, fixture.identityH);
    expect(await listed(gate, null)).toContain(sessionIdOf(inB));
    expect((await revokeAs(gate, sessionIdOf(inB))).revoked).toBe(true);
  });
  it('W4-6: refusal — H2 pinned to A never sees H\'s B-pinned session in its own list', async () => {
    const inB = await mintPinned(fixture.accountH, fixture.identityH, fixture.spaceB);
    const h2 = await mintPinned(fixture.accountH2, fixture.identityH2, fixture.spaceA);
    expect(await listed(h2, null)).not.toContain(sessionIdOf(inB));
  });
});
