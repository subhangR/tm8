import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';
import { claimsFor } from '../../src/facade/context.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext } from '../../src/http/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';

/**
 * CROSS-SPACE TOKEN MATRIX — one top-level describe per T-number, one `it` per
 * cell, every refusal followed by its paired positive.
 *
 * Credentials are REAL tokens: generateSecret() -> hashToken() -> the
 * production mint RPC -> formatToken(row.id, secret). Token strings are never
 * logged or stored.
 */

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
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;

async function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  return db.tx({ identityId, authKind: 'browser', requestId: `cross-space-${randomUUID()}` }, fn);
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

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      spaceA: randomUUID(),
      spaceB: randomUUID(),
      identityH: 'cross-space-h',
      identityH2: 'cross-space-h2',
      accountH: randomUUID(),
      accountH2: randomUUID(),
      memberHA: randomUUID(),
      memberHB: randomUUID(),
      memberH2A: randomUUID(),
      personaA: randomUUID(),
      workSessionA: randomUUID(),
      chatA: randomUUID(),
    };
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
       values ($1, $6, 'member', $1, 'space'),
              ($2, $7, 'member', $2, 'space'),
              ($3, $6, 'member', $3, 'space'),
              ($4, $6, 'team_member', $1, 'space'),
              ($5, $6, 'work_session', $4, 'space')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.personaA, ids.workSessionA, ids.spaceA, ids.spaceB],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'H'),
              ($2, $5, $6, 'owner', 'H'),
              ($3, $4, $7, 'member', 'H2')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.spaceA, ids.spaceB, ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Agent G', 'worker', 'persona')`,
      [ids.personaA, ids.memberHA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Cross-space session', 'running', 'none', now())`,
      [ids.workSessionA],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [ids.spaceA, ids.personaA, ids.workSessionA],
    );
    return ids;
  });
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
