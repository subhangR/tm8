/**
 * S6 (credentials release 1, storage half) — `typesafe` as a SERVER-ONLY
 * space credential, against a REAL PostgreSQL with migration 271 applied,
 * running as `tm8_app` under each caller's claims.
 *
 *   · 271 widens exactly the checks that must hold typesafe (space_credentials
 *     provider/shape, member_defaults) and adds one that refuses it on
 *     session_space_credentials, even to the owner role writing directly;
 *   · gate 8, reader half: the spawn reader refuses a server-only provider,
 *     in SQL and in TS, with or without a pinned credential id;
 *   · `read_space_service_key`: EXECUTE is tm8_app's only, it runs under the
 *     caller's claims, reads my_default for HUMAN auth kinds only (an agent
 *     falls to the space default), answers null when the space holds none,
 *     and refuses a launchable provider, a link bearer and a non-member;
 *   · Ask Jev (`launch.suggest`) spends the space key first, and the release-1
 *     chain behind it — 203 member key, then the node key, then no_key —
 *     still works rung by rung.
 *
 * Every refusal has a control beside it that shows the assertion can pass.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { LaunchSuggestResult } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbServiceKeyStore } from '../../src/credentials/service-key-store.js';
import { DbSpaceCredentialStore, ServerOnlyCredentialRefusedError } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { createJevAdvisorResolver } from '../../src/jev/advisor.js';
import { registerJevHandlers } from '../../src/jev/handlers.js';
import type { JevAdvisorPort } from '../../src/jev/port.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'srvonly-owner';
const A = 'srvonly-a';
const B = 'srvonly-b';
const OUT = 'srvonly-out';

const NODE_KEY = 'ts_node_9876543210zyxwvuNODE';
const MEMBER_203_KEY = 'ts_member203_0123456789MEMB';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let serviceKeys: DbServiceKeyStore;
const ids: Record<string, string> = {};

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

let seq = 0;
const label = (stem: string): string => `${stem} ${String(++seq)}`;
const tsKey = (stem: string): string => `ts_${stem}_${randomUUID().replaceAll('-', '')}`;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-srvonly-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('server_only_credentials');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  serviceKeys = new DbServiceKeyStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, A, B, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2)`,
        [identity, identity === OWN],
      );
    }
    // S: holds typesafe keys. E: an empty space, for the rungs behind the space key.
    ids.S = await newId(c);
    ids.E = await newId(c);
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $4), ($2, 'E', $4), ($3, 'T', $5)`, [
      ids.S, ids.E, ids.T, OWN, OUT,
    ]);
    const memberships: Array<[string, string, string]> = [
      [ids.S, OWN, 'owner'], [ids.S, A, 'member'], [ids.S, B, 'member'],
      [ids.E, OWN, 'owner'], [ids.E, A, 'member'],
      [ids.T, OUT, 'owner'],
    ];
    for (const [space, identity, role] of memberships) {
      const member = await newId(c);
      ids[`member:${space}:${identity}`] = member;
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, space, identity, role],
      );
    }
    for (const space of [ids.S, ids.E]) {
      const task = ids[`task:${space}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'task', 0, $3)`, [
        task, space, ids[`member:${space}:${OWN}`],
      ]);
      await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix login', 'SSO lands on 404')`, [task]);
    }
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

// ---------------------------------------------------------------------------
// 271's checks
// ---------------------------------------------------------------------------

describe('271 widens only the checks that must hold typesafe', () => {
  it('a typesafe api_key is created, rekeyed and deleted; the secret never appears in a read (I5)', async () => {
    const secret = tsKey('crud');
    const made = await store.create(claims(A), { spaceId: ids.S!, provider: 'typesafe', shape: 'api_key', label: label('crud'), secret });
    expect(made).toMatchObject({ provider: 'typesafe', shape: 'api_key', keyHint: secret.slice(-4) });
    expect(JSON.stringify(made)).not.toContain(secret);
    const listed = await store.list(claims(A), ids.S!);
    expect(listed.some((c) => c.id === made.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(secret);

    const fresh = tsKey('rekeyed');
    const rekeyed = await store.rekey(claims(A), made.id, fresh);
    expect(rekeyed.keyHint).toBe(fresh.slice(-4));
    expect(JSON.stringify(rekeyed)).not.toContain(fresh);

    const revoked = await store.revoke(claims(A), made.id);
    expect(revoked.revoked).toBe(true);
    expect((await store.list(claims(A), ids.S!)).some((c) => c.id === made.id)).toBe(false);
  });

  it('typesafe takes an api_key only (control: github still takes a token)', async () => {
    await asOwner(async (c) => {
      const id = await newId(c);
      const insert = (provider: string, shape: string) => c.query(
        `insert into public.space_credentials(id, space_id, provider, shape, label, key_hint, secret_ciphertext, secret_nonce, created_by_account_id)
         select $1, $2, $3, $4, $5, 'abcd', '\\x00', '\\x00', a.id from public.accounts a where a.identity_id = $6`,
        [id, ids.S, provider, shape, label('shape'), A],
      );
      await c.query('savepoint s');
      await expect(insert('typesafe', 'token')).rejects.toThrow(/space_credentials_provider_shape_check/);
      await c.query('rollback to savepoint s');
      await expect(insert('nope', 'api_key')).rejects.toThrow(/space_credentials_provider_check/);
      await c.query('rollback to savepoint s');
    });
    const control = await store.create(claims(A), { spaceId: ids.S!, provider: 'github', shape: 'token', label: label('gh'), secret: tsKey('gh') });
    expect(control.shape).toBe('token');
  });

  it('the owner role writing session_space_credentials directly cannot record a typesafe row', async () => {
    const credential = await store.create(claims(A), { spaceId: ids.S!, provider: 'typesafe', shape: 'api_key', label: label('ssc'), secret: tsKey('ssc') });
    const anthropic = await store.create(claims(A), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: label('ssc-a'), secret: tsKey('ssc-a') });
    await asOwner(async (c) => {
      const session = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [
        session, ids.S, ids[`member:${ids.S}:${A}`],
      ]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind) values ($1, 'fixture', 'spawning', 'agent')`, [session]);
      const record = (provider: string, credentialId: string) => c.query(
        `insert into public.session_space_credentials(work_session_id, provider, space_credential_id, space_id) values ($1, $2, $3, $4)`,
        [session, provider, credentialId, ids.S],
      );
      await c.query('savepoint s');
      await expect(record('typesafe', credential.id)).rejects.toThrow(/session_space_credentials_not_server_only/);
      await c.query('rollback to savepoint s');
      // Control: the same writer, the same session, a launchable provider.
      await expect(record('anthropic', anthropic.id)).resolves.toBeDefined();
    });
    const [def] = await asOwner(async (c) => (await c.query<{ def: string; volatility: string }>(
      `select pg_get_constraintdef(k.oid) def,
              (select provolatile from pg_proc where oid = 'internal.is_server_only_credential_provider(text)'::regprocedure) volatility
         from pg_constraint k where conname = 'session_space_credentials_not_server_only'`,
    )).rows);
    expect(def?.def).toMatch(/is_server_only_credential_provider/);
    expect(def?.volatility).toBe('i');
  });
});

// ---------------------------------------------------------------------------
// Gate 8, reader half: the spawn reader refuses a server-only provider
// ---------------------------------------------------------------------------

describe('gate 8: a server-only key never reaches a launch', () => {
  it('SQL read_space_credential_for_spawn refuses typesafe, default and pinned (control: anthropic reads)', async () => {
    const typesafe = await store.create(claims(A), { spaceId: ids.S!, provider: 'typesafe', shape: 'api_key', label: label('g8'), secret: tsKey('g8'), spaceOwned: true });
    for (const pinned of [null, typesafe.id]) {
      await expect(db.rpc(claims(A), 'read_space_credential_for_spawn', [ids.S, 'typesafe', pinned]))
        .rejects.toMatchObject({ code: 'forbidden' });
      await expect(db.rpc(claims(A, 'agent'), 'read_space_credential_for_spawn', [ids.S, 'typesafe', pinned]))
        .rejects.toMatchObject({ code: 'forbidden' });
    }
    const secret = tsKey('g8-anthropic');
    const anthropic = await store.create(claims(A), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: label('g8a'), secret });
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', anthropic.id)).resolves.toMatchObject({ secret });
  });

  it('TS readForSpawn refuses a server-only provider before any SQL', async () => {
    const rpc = vi.spyOn(db, 'rpc');
    try {
      await expect(store.readForSpawn(claims(A), ids.S!, 'typesafe' as never, null))
        .rejects.toBeInstanceOf(ServerOnlyCredentialRefusedError);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      rpc.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// read_space_service_key
// ---------------------------------------------------------------------------

describe('read_space_service_key', () => {
  it('EXECUTE is tm8_app’s only — not public, not anon (control: tm8_app has it)', async () => {
    const rows = await asOwner(async (c) => (await c.query<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.read_space_service_key(uuid,text)', 'execute') can
         from (values ('tm8_app'), ('public')) r(role)
        where r.role = 'public' or exists (select 1 from pg_roles where rolname = r.role)`,
    )).rows);
    expect(rows.find((r) => r.role === 'tm8_app')?.can).toBe(true);
    const acl = await asOwner(async (c) => (await c.query<{ acl: string | null }>(
      `select proacl::text acl from pg_proc where oid = 'public.read_space_service_key(uuid,text)'::regprocedure`,
    )).rows[0]!.acl);
    // `=X/owner` is a grant to PUBLIC; revoked, no entry starts with '='.
    expect(acl).not.toBeNull();
    expect(acl!).not.toMatch(/[{,]=X/);
    expect(acl!).toMatch(/tm8_app=X/);
    const helperAcl = await asOwner(async (c) => (await c.query<{ acl: string | null }>(
      `select proacl::text acl from pg_proc where oid = 'internal.is_server_only_credential_provider(text)'::regprocedure`,
    )).rows[0]!.acl);
    expect(helperAcl ?? '').not.toMatch(/[{,]=X/);
  });

  it('runs under the caller’s claims: a non-member and a link bearer are refused (control: a member reads)', async () => {
    await expect(db.rpc(claims(OUT), 'read_space_service_key', [ids.S, 'typesafe'])).rejects.toThrow();
    await expect(db.rpc(claims(A, 'link'), 'read_space_service_key', [ids.S, 'typesafe'])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(store.readServiceKey(claims(A, 'link'), ids.S!, 'typesafe')).rejects.toThrow(/space link session/);
    await expect(db.rpc(claims(A), 'read_space_service_key', [ids.S, 'typesafe'])).resolves.toBeDefined();
  });

  it('refuses a launchable provider: a spawn key never leaves through this door', async () => {
    for (const provider of ['anthropic', 'openai', 'github']) {
      await expect(db.rpc(claims(A), 'read_space_service_key', [ids.S, provider])).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('null when the space holds no typesafe credential', async () => {
    expect(await store.readServiceKey(claims(A), ids.E!, 'typesafe')).toBeNull();
    expect(await store.readServiceKey(claims(A, 'agent'), ids.E!, 'typesafe')).toBeNull();
  });

  it('my_default for HUMAN auth kinds only; an agent falls to the space default', async () => {
    // A fresh space so the default and my_default are this test's own.
    const space = await asOwner(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'M', $2)`, [id, OWN]);
      for (const [identity, role] of [[OWN, 'owner'], [A, 'member'], [B, 'member']] as const) {
        const member = await newId(c);
        await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
        await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`, [member, id, identity, role]);
      }
      return id;
    });
    const spaceSecret = tsKey('space');
    const shared = await store.create(claims(OWN), { spaceId: space, provider: 'typesafe', shape: 'api_key', label: label('shared'), secret: spaceSecret, spaceOwned: true });
    expect(shared.isDefault).toBe(true);
    const mineSecret = tsKey('mine');
    const mine = await store.create(claims(A), { spaceId: space, provider: 'typesafe', shape: 'api_key', label: label('mine'), secret: mineSecret, visibility: 'private' });
    await store.setMyDefault(claims(A), mine.id);

    await expect(store.readServiceKey(claims(A, 'browser'), space, 'typesafe')).resolves.toMatchObject({ source: 'my_default', credentialId: mine.id, secret: mineSecret });
    await expect(store.readServiceKey(claims(A, 'cli'), space, 'typesafe')).resolves.toMatchObject({ source: 'my_default', secret: mineSecret });
    // The rule: an agent carrying A's identity does NOT read A's my_default.
    await expect(store.readServiceKey(claims(A, 'agent'), space, 'typesafe')).resolves.toMatchObject({ source: 'space_default', credentialId: shared.id, secret: spaceSecret });
    // A colleague with no my_default gets the space default, never A's key.
    const forB = await store.readServiceKey(claims(B), space, 'typesafe');
    expect(forB).toMatchObject({ source: 'space_default', secret: spaceSecret });
    expect(forB?.secret).not.toBe(mineSecret);

    // A revoked my_default falls to the space default; a revoked default to null.
    await store.revoke(claims(A), mine.id);
    await expect(store.readServiceKey(claims(A), space, 'typesafe')).resolves.toMatchObject({ source: 'space_default' });
    await store.revoke(claims(OWN), shared.id);
    expect(await store.readServiceKey(claims(A), space, 'typesafe')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ask Jev: the space key first, then the release-1 chain, then no_key
// ---------------------------------------------------------------------------

function recordingAdvisors() {
  const built: string[] = [];
  const advisorForKey = (apiKey: string): JevAdvisorPort => {
    built.push(apiKey);
    const call = { jevModel: 'jev-1.13.0', inputTokens: 10, outputTokens: 1, costUsd: 0, latencyMs: 1, outcome: 'ok' as const };
    return {
      async rank({ candidates }) { return { ok: true, ranked: candidates.map((c) => ({ id: c.id, score: 2 })), calls: [call] }; },
      async model() {
        return { ok: true, call, verdict: { tier: 'standard', model: 'claude-sonnet-5', agentTool: 'claude-code', effort: 'medium', need: 1, workKind: 'bugfix', reasons: [] } };
      },
    };
  };
  return { built, advisorForKey };
}

/** launch.suggest wired exactly as main.ts wires it, in `space`. */
function suggestAs(identity: string, space: string, opts: { nodeKey: string | null; authKind?: string }) {
  const advisors = recordingAdvisors();
  const registry = new HandlerRegistry();
  const deps = { db, config: {}, owner: async () => ({ identityId: identity, isNodeAdmin: false }) } as unknown as FacadeDeps;
  registerJevHandlers(registry, deps, {
    resolveAdvisor: createJevAdvisorResolver({
      readSpaceKey: async (c, spaceId) => (await store.readServiceKey(c, spaceId, 'typesafe'))?.secret ?? null,
      readMemberKey: (c) => serviceKeys.resolve(c, 'typesafe'),
      nodeKey: opts.nodeKey,
      advisorForKey: advisors.advisorForKey,
    }),
  });
  const handler = registry.get('launch.suggest')!;
  const run = () => handler({
    params: { spaceId: space }, query: new URLSearchParams(),
    body: { runId: randomUUID(), requestId: randomUUID(), subjectId: ids[`task:${space}`], groups: ['model'] },
    requestId: randomUUID(), identity: { kind: 'loopback', authKind: opts.authKind ?? 'browser' },
    headers: {}, method: 'POST', path: '/',
  } as unknown as RequestContext) as Promise<LaunchSuggestResult>;
  return { run, built: advisors.built };
}

describe('Ask Jev resolves my_default → space_default → [R1: 203 member key → node key] → no_key', () => {
  let spaceSecret = '';
  let mineSecret = '';

  beforeAll(async () => {
    spaceSecret = tsKey('jev-space');
    await store.create(claims(OWN), { spaceId: ids.S!, provider: 'typesafe', shape: 'api_key', label: label('jev-space'), secret: spaceSecret, spaceOwned: true })
      .then(async (made) => { if (!made.isDefault) await store.setDefault(claims(OWN), made.id); });
    mineSecret = tsKey('jev-mine');
    const mine = await store.create(claims(A), { spaceId: ids.S!, provider: 'typesafe', shape: 'api_key', label: label('jev-mine'), secret: mineSecret, visibility: 'private' });
    await store.setMyDefault(claims(A), mine.id);
    // A 203 key for A, which the space key must outrank and E must still reach.
    await serviceKeys.put(claims(A), 'typesafe', MEMBER_203_KEY);
  });

  it('rung 1a: a human’s my_default wins over the space default, the 203 key and the node key', async () => {
    const asA = suggestAs(A, ids.S!, { nodeKey: NODE_KEY });
    expect((await asA.run()).groups.model?.status).toBe('ok');
    expect(asA.built).toEqual([mineSecret]);
  });

  it('rung 1b: the space default — for a member with no my_default, and for an agent', async () => {
    const asB = suggestAs(B, ids.S!, { nodeKey: NODE_KEY });
    expect((await asB.run()).groups.model?.status).toBe('ok');
    expect(asB.built).toEqual([spaceSecret]);
    const asAgent = suggestAs(A, ids.S!, { nodeKey: NODE_KEY, authKind: 'agent' });
    expect((await asAgent.run()).groups.model?.status).toBe('ok');
    expect(asAgent.built).toEqual([spaceSecret]);
  });

  it('rung 2 (R1): a space with no typesafe credential falls to the caller’s 203 key', async () => {
    const asA = suggestAs(A, ids.E!, { nodeKey: NODE_KEY });
    expect((await asA.run()).groups.model?.status).toBe('ok');
    expect(asA.built).toEqual([MEMBER_203_KEY]);
  });

  it('rung 3 (R1): no space key and no 203 key falls to the node key', async () => {
    const asOwnerInE = suggestAs(OWN, ids.E!, { nodeKey: NODE_KEY });
    expect((await asOwnerInE.run()).groups.model?.status).toBe('ok');
    expect(asOwnerInE.built).toEqual([NODE_KEY]);
  });

  it('no_key: no space key, no 203 key, no node key', async () => {
    const none = suggestAs(OWN, ids.E!, { nodeKey: null });
    const result = await none.run();
    expect(result.groups.model).toMatchObject({ status: 'failed', reason: 'no_key' });
    expect(none.built).toEqual([]);
  });
});
