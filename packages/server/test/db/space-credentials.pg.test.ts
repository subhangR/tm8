/**
 * SC-1 — space credentials against a REAL PostgreSQL with migration 206
 * applied, running as `tm8_app` under each caller's claims so RLS, the column
 * grant, the human-only gate and the row locks are all live.
 *
 * Cast, all in space S unless said otherwise:
 *   OWN  space owner (and node owner)       ADM  space admin
 *   A    member, creates most credentials   B    member, owns teammate TB
 *   OUT  member of space T only             A is ALSO a member of T.
 *
 * Every identity-sensitive case is member A launching B's teammate (C1): the
 * session entity is created by TB, the claims are A's, and the result must
 * follow A. Each refusal has a control beside it that shows it can pass.
 * Test names carry the acceptance criterion (t1-N) they evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'spc-owner';
const ADM = 'spc-admin';
const A = 'spc-a';
const B = 'spc-b';
const OUT = 'spc-out';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');

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
const key = (stem: string): string => `sk-${stem}-${randomUUID().replaceAll('-', '')}`;

/** A work session in `space`, created by `createdBy` (a member or teammate entity). */
async function session(
  space: string,
  createdBy: string,
  opts: { status?: string; kind?: 'agent' | 'credential' } = {},
): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, space, createdBy]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind, workdir_mode) values ($1, 'fixture', $2, $3, 'scratch')`, [
      id, opts.status ?? 'spawning', opts.kind ?? 'agent',
    ]);
    return id;
  });
}

async function setSessionStatus(sessionId: string, status: string): Promise<void> {
  // A fixture shortcut past R29's single-writer guard, which the transition
  // function itself passes by setting this claim.
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

function manifest(credentials: Record<string, string>, sources?: Record<string, string>): Record<string, unknown> {
  const credentialSources = sources ?? Object.fromEntries(Object.keys(credentials).map((p) => [p, 'space']));
  return { launch: { credentialSources, spaceCredentialIds: credentials } };
}

async function recordManifest(c: DbClaims, sessionId: string, m: Record<string, unknown>): Promise<unknown> {
  return db.rpc(c, 'record_session_manifest', [sessionId, JSON.stringify(m)]);
}

async function recorded(sessionId: string): Promise<Array<{ provider: string; space_credential_id: string; launcher_account_id: string | null }>> {
  return asOwner(async (c) => (await c.query(
    'select provider, space_credential_id, launcher_account_id from public.session_space_credentials where work_session_id = $1 order by provider',
    [sessionId],
  )).rows);
}

async function newApiKey(who: string, provider: 'anthropic' | 'openai' = 'anthropic', space = ids.S!) {
  const secret = key(who);
  const credential = await store.create(claims(who), { spaceId: space, provider, shape: 'api_key', label: label(`${who} key`), secret });
  return { credential, secret };
}

/** Wait until at least `atLeast` backends are blocked on a heavyweight lock. */
async function waitForLockWait(atLeast = 1): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await database.query<{ n: number }>(
      `select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.n ?? 0) >= atLeast) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no backend ever waited on a lock');
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-spacecred-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('space_credentials');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2) returning id::text`,
        [identity, identity === OWN],
      );
      accounts[identity] = rows[0]!.id;
    }
    ids.S = await newId(c);
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $3), ($2, 'T', $4)`, [ids.S, ids.T, OWN, OUT]);
    const memberships: Array<[string, string, string]> = [
      [ids.S, OWN, 'owner'], [ids.S, ADM, 'admin'], [ids.S, A, 'member'], [ids.S, B, 'member'],
      [ids.T, OUT, 'owner'], [ids.T, A, 'member'],
    ];
    for (const [space, identity, role] of memberships) {
      const member = ids[`member:${space === ids.S ? 'S' : 'T'}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, space, identity, role],
      );
    }
    // TB: a teammate entity OWNED by B. Sessions A launches for it are created
    // by TB — neither A nor B — so a launcher derived from the entity would
    // name the wrong person.
    ids.TB = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $3)`, [
      ids.TB, ids.S, ids['member:S:' + B],
    ]);
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

// ---------------------------------------------------------------------------

describe('206 schema', () => {
  it('t1-1: the chain applies and no other migration shares 206', () => {
    const files = migrationFiles();
    expect(files.filter((f) => f.startsWith('206_'))).toEqual(['206_space_credentials.sql']);
    const prefixes = files.map((f) => f.slice(0, 3));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('t1-2: a non-member selects zero rows; a member cannot select the secret columns (control: metadata is readable)', async () => {
    const { credential } = await newApiKey(A);
    const asMember = await db.query<{ id: string }>(claims(B), 'select id from public.space_credentials where id = $1', [credential.id]);
    expect(asMember).toHaveLength(1);
    expect(await db.query(claims(OUT), 'select id from public.space_credentials where id = $1', [credential.id])).toHaveLength(0);
    expect(await db.query(claims(OUT), 'select * from public.session_space_credentials')).toHaveLength(0);
    await expect(db.query(claims(A), 'select secret_ciphertext from public.space_credentials')).rejects.toThrow(/permission denied/);
    await expect(db.query(claims(A), 'select secret_nonce from public.space_credentials')).rejects.toThrow(/permission denied/);
    // And no direct write path at all.
    await expect(db.query(claims(A), `update public.space_credentials set label = 'x' where id = $1`, [credential.id]))
      .rejects.toThrow(/permission denied/);
  });

  it('t1-5: one active default per (space, provider), enforced by the index', async () => {
    const first = await newApiKey(A, 'openai');
    const second = await newApiKey(B, 'openai');
    expect(first.credential.isDefault).toBe(true);
    expect(second.credential.isDefault).toBe(false);
    await expect(asOwner((c) => c.query('update public.space_credentials set is_default = true where id = $1', [second.credential.id])))
      .rejects.toThrow(/space_credentials_one_default_per_provider/);
    // setDefault moves it (control: the index permits exactly one).
    await store.setDefault(claims(B), second.credential.id);
    const rows = await db.query<{ id: string }>(claims(A),
      `select id from public.space_credentials where space_id = $1 and provider = 'openai' and is_default`, [ids.S]);
    expect(rows.map((r) => r.id)).toEqual([second.credential.id]);
  });

  it('t1-5: (space, provider, label) is unique among live rows; a revoked tombstone frees its label', async () => {
    const name = label('dup');
    const made = await store.create(claims(A), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: name, secret: key('d1') });
    await expect(store.create(claims(B), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: name, secret: key('d2') }))
      .rejects.toThrow(/space_credentials_unique_label/);
    // Control: the same label under another provider is fine.
    await store.create(claims(B), { spaceId: ids.S!, provider: 'openai', shape: 'api_key', label: name, secret: key('d3') });
    await store.revoke(claims(A), made.id);
    await store.create(claims(B), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: name, secret: key('d4') });
  });

  it('t1-7: account delete nulls created_by_account_id and the credential survives, managed by admins', async () => {
    const leaver = 'spc-leaver';
    await asOwner(async (c) => {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [leaver]);
      await c.query(`insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1)`, [leaver]);
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)`, [member, ids.S, leaver]);
    });
    const { credential } = await newApiKey(leaver);
    expect(credential.createdByAccountId).not.toBeNull();
    await asOwner((c) => c.query('delete from public.accounts where identity_id = $1', [leaver]));
    const [row] = await db.query<{ created_by_account_id: string | null; status: string }>(claims(A),
      'select created_by_account_id, status from public.space_credentials where id = $1', [credential.id]);
    expect(row).toEqual({ created_by_account_id: null, status: 'active' });
    await expect(store.rename(claims(A), credential.id, label('orphan'))).rejects.toThrow(/creator or a space admin/);
    await expect(store.rename(claims(ADM), credential.id, label('orphan'))).resolves.toMatchObject({ id: credential.id });
  });

  it('t1-15: allowed_sources rejects empty, unknown and repeated values (control: a valid subset stores)', async () => {
    await expect(store.setSpacePolicy(claims(ADM), ids.S!, 'anthropic', [])).rejects.toThrow(/space_credential_policies_sources_check/);
    await expect(store.setSpacePolicy(claims(ADM), ids.S!, 'anthropic', ['bogus' as never])).rejects.toThrow(/sources_check/);
    await expect(store.setSpacePolicy(claims(ADM), ids.S!, 'anthropic', ['space', 'space'])).rejects.toThrow(/sources_check/);
    await expect(store.setSpacePolicy(claims(ADM), ids.S!, 'anthropic', ['space', null as never])).rejects.toThrow(/sources_check/);
    await store.setSpacePolicy(claims(ADM), ids.S!, 'github', ['space', 'member']);
    expect(await store.readSpacePolicy(agent(B), ids.S!)).toEqual({ github: ['space', 'member'] });
    await store.setSpacePolicy(claims(OWN), ids.S!, 'github', null);
    expect(await store.readSpacePolicy(claims(B), ids.S!)).toEqual({});
    // A member is not an admin; an outsider cannot even read.
    await expect(store.setSpacePolicy(claims(A), ids.S!, 'github', ['space'])).rejects.toThrow(/admin/);
    await expect(store.readSpacePolicy(claims(OUT), ids.S!)).rejects.toThrow();
  });

  it('node policy: only a node admin writes it; any identity reads it', async () => {
    await expect(store.setNodePolicy(claims(ADM), 'openai', false)).rejects.toThrow(/node admin required/);
    await store.setNodePolicy(claims(OWN), 'openai', false);
    expect(await store.readNodePolicy(agent(OUT))).toEqual({ openai: false });
    await store.setNodePolicy(claims(OWN), 'openai', null);
    expect(await store.readNodePolicy(claims(A))).toEqual({});
  });
});

describe('management rights (D1, D11) and the human-only gate (I2)', () => {
  it('t1-3: any member creates; the creator and admins/owners manage; another member is refused', async () => {
    const { credential } = await newApiKey(A);
    await expect(store.rename(claims(B), credential.id, label('b'))).rejects.toThrow(/creator or a space admin/);
    await expect(store.setDefault(claims(B), credential.id)).rejects.toThrow(/creator or a space admin/);
    await expect(store.recordProbe(claims(B), credential.id, true)).rejects.toThrow(/creator or a space admin/);
    await expect(store.revoke(claims(B), credential.id)).rejects.toThrow(/creator or a space admin/);
    await expect(store.rename(claims(A), credential.id, label('a'))).resolves.toMatchObject({ id: credential.id });
    await expect(store.rename(claims(ADM), credential.id, label('adm'))).resolves.toMatchObject({ id: credential.id });
    await expect(store.rename(claims(OWN), credential.id, label('own'))).resolves.toMatchObject({ id: credential.id });
    // A non-member cannot create and cannot even find it.
    await expect(store.create(claims(OUT), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: label('out'), secret: key('o') }))
      .rejects.toThrow();
    await expect(store.rename(claims(OUT), credential.id, label('out'))).rejects.toThrow(/not found/);
  });

  it('t1-4: every management RPC and policy writer refuses an agent auth_kind (control: the same call as browser passes)', async () => {
    const { credential } = await newApiKey(A);
    const login = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('login'), sessionCap: 100 });
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['create', () => store.create(agent(A), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: label('ag'), secret: key('ag') })],
      ['startLogin', () => store.startLogin(agent(A), { spaceId: ids.S!, provider: 'anthropic', label: label('ag'), sessionCap: 100 })],
      ['finishLogin', () => store.finishLogin(agent(A), login.workSessionId, true)],
      ['rekey', () => store.rekey(agent(A), credential.id, key('ag'))],
      ['rename', () => store.rename(agent(A), credential.id, label('ag'))],
      ['setDefault', () => store.setDefault(agent(A), credential.id)],
      ['recordProbe', () => store.recordProbe(agent(A), credential.id, true)],
      ['revoke', () => store.revoke(agent(A), credential.id)],
      ['liveSessions', () => store.liveSessions(agent(A), credential.id)],
      ['memberSessions', () => store.memberSessions(agent(A), ids.S!, accounts[A]!)],
      ['setSpacePolicy', () => store.setSpacePolicy(agent(OWN), ids.S!, 'openai', ['space'])],
      ['setNodePolicy', () => store.setNodePolicy(agent(OWN), 'openai', true)],
    ];
    for (const [name, call] of refusals) {
      await expect(call(), name).rejects.toThrow(/human-only/);
    }
    // Controls, as browser and as cli.
    await expect(store.rename(claims(A), credential.id, label('br'))).resolves.toBeTruthy();
    await expect(store.rename(claims(A, 'cli'), credential.id, label('cli'))).resolves.toBeTruthy();
    await expect(store.setNodePolicy(claims(OWN), 'openai', null)).resolves.toBeTruthy();
    // The rows really are unchanged by the refused calls.
    const [row] = await db.query<{ status: string }>(claims(A), 'select status from public.space_credentials where id = $1', [credential.id]);
    expect(row!.status).toBe('active');
  });
});

describe('the sealed store', () => {
  it('t1-9: round-trips, stores only ciphertext and a four-character hint', async () => {
    const { credential, secret } = await newApiKey(A);
    expect(credential.keyHint).toBe(secret.slice(-4));
    const [row] = await asOwner(async (c) => (await c.query<{ secret_ciphertext: Buffer }>(
      'select secret_ciphertext from public.space_credentials where id = $1', [credential.id])).rows);
    expect(Buffer.from(`x${secret}x`).includes(secret)).toBe(true); // control: the search can find it
    expect(row!.secret_ciphertext.includes(secret)).toBe(false);
    expect(row!.secret_ciphertext.includes(secret.slice(0, 12))).toBe(false);
    const opened = await store.readForSpawn(agent(B), ids.S!, 'anthropic', credential.id);
    expect(opened).toMatchObject({ kind: 'secret', secret, credentialId: credential.id });
  });

  it('t1-9: ciphertext moved to another row, or into another space, does not open (control: at home it does)', async () => {
    const source = await newApiKey(A);
    const sameSpace = await newApiKey(A);
    const otherSpace = await newApiKey(A, 'anthropic', ids.T!);
    const move = (to: string) => asOwner((c) => c.query(
      `update public.space_credentials t set secret_ciphertext = s.secret_ciphertext, secret_nonce = s.secret_nonce
         from public.space_credentials s where s.id = $1 and t.id = $2`, [source.credential.id, to]));
    await move(sameSpace.credential.id);
    await move(otherSpace.credential.id);
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', sameSpace.credential.id)).rejects.toThrow('stored space credential is unreadable');
    await expect(store.readForSpawn(claims(A), ids.T!, 'anthropic', otherSpace.credential.id)).rejects.toThrow('stored space credential is unreadable');
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', source.credential.id)).resolves.toMatchObject({ secret: source.secret });
  });

  it('t1-9: a space id given in uppercase seals as Postgres answers it, so the key still opens', async () => {
    const secret = `sk-ant-${randomUUID()}`;
    const credential = await store.create(claims(A), {
      spaceId: ids.S!.toUpperCase(), provider: 'anthropic', shape: 'api_key', label: label('upper'), secret,
    });
    expect(credential.spaceId).toBe(ids.S);
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', credential.id)).resolves.toMatchObject({ secret });
  });

  it('t1-9: a space id given unhyphenated or braced (forms Postgres accepts) seals as Postgres answers it', async () => {
    for (const spaceId of [ids.S!.replaceAll('-', ''), `{${ids.S!}}`, ids.S!.replaceAll('-', '').toUpperCase()]) {
      const secret = `sk-ant-${randomUUID()}`;
      const credential = await store.create(claims(A), {
        spaceId, provider: 'anthropic', shape: 'api_key', label: label('form'), secret,
      });
      expect(credential.spaceId, spaceId).toBe(ids.S);
      await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', credential.id), spaceId).resolves.toMatchObject({ secret });
    }
  });

  it('t1-13: rekey is creator-or-admin, and the next read gets the new key', async () => {
    const { credential } = await newApiKey(A, 'openai');
    await expect(store.rekey(claims(B), credential.id, key('b'))).rejects.toThrow(/creator or a space admin/);
    const fresh = key('adm');
    const rekeyed = await store.rekey(claims(ADM), credential.id, fresh);
    expect(rekeyed.keyHint).toBe(fresh.slice(-4));
    await expect(store.readForSpawn(claims(B), ids.S!, 'openai', credential.id)).resolves.toMatchObject({ secret: fresh });
    const mine = key('a');
    await store.rekey(claims(A), credential.id, mine);
    await expect(store.readForSpawn(claims(B), ids.S!, 'openai', credential.id)).resolves.toMatchObject({ secret: mine });
  });
});

describe('the spawn reader', () => {
  it('t1-6: refuses a non-member; hands the sealed bytes to a member, agent auth included', async () => {
    const { credential, secret } = await newApiKey(A);
    await expect(store.readForSpawn(claims(OUT), ids.S!, 'anthropic', credential.id)).rejects.toThrow();
    await expect(store.readForSpawn(agent(OUT), ids.S!, 'anthropic', credential.id)).rejects.toThrow();
    // The raw RPC answers sealed bytes, never plaintext.
    const raw = await db.rpc<Record<string, unknown>>(agent(B), 'read_space_credential_for_spawn', [ids.S, 'anthropic', credential.id]);
    expect(raw.secretCiphertext).toEqual(expect.any(String));
    expect(JSON.stringify(raw)).not.toContain(secret);
    await expect(store.readForSpawn(agent(B), ids.S!, 'anthropic', credential.id)).resolves.toMatchObject({ secret });
    const [used] = await db.query<{ last_used_at: Date | null }>(claims(A), 'select last_used_at from public.space_credentials where id = $1', [credential.id]);
    expect(used!.last_used_at).not.toBeNull();
  });

  it('t1-14: refuses a credential outside the LAUNCH space, and pending/revoked credentials', async () => {
    const inT = await newApiKey(A, 'anthropic', ids.T!);
    // A is a member of both spaces; launching in S with T's id is refused like a missing id.
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', inT.credential.id)).rejects.toThrow(/not found in this space/);
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', randomUUID())).rejects.toThrow(/not found in this space/);
    await expect(store.readForSpawn(claims(A), ids.T!, 'anthropic', inT.credential.id)).resolves.toMatchObject({ secret: inT.secret });
    // Provider mismatch is also "not found".
    await expect(store.readForSpawn(claims(A), ids.T!, 'openai', inT.credential.id)).rejects.toThrow(/not found in this space/);

    const revoked = await newApiKey(A);
    await store.revoke(claims(A), revoked.credential.id);
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', revoked.credential.id)).rejects.toThrow(/is revoked/);

    const pending = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'anthropic', label: label('pend'), sessionCap: 100 });
    expect(pending.credential.status).toBe('pending');
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', pending.credential.id)).rejects.toThrow(/is pending/);

    const stale = await newApiKey(A);
    await store.recordProbe(claims(A), stale.credential.id, false);
    await expect(store.readForSpawn(claims(A), ids.S!, 'anthropic', stale.credential.id)).rejects.toThrow(/is stale/);
  });

  it('with no pinned id it answers the space default, and says so when there is none', async () => {
    await expect(store.readForSpawn(claims(OUT), ids.T!, 'openai')).rejects.toThrow(/no default openai credential/);
    const [row] = await db.query<{ id: string }>(claims(A),
      `select id from public.space_credentials where space_id = $1 and provider = 'anthropic' and is_default and status = 'active'`, [ids.S]);
    await expect(store.readForSpawn(agent(B), ids.S!, 'anthropic')).resolves.toMatchObject({ credentialId: row!.id });
  });

  it('a login credential answers its home key, never bytes', async () => {
    const login = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('home'), sessionCap: 100 });
    await store.finishLogin(claims(A), login.workSessionId, true, 'team@example.com');
    const read = await store.readForSpawn(agent(B), ids.S!, 'openai', login.credential.id);
    expect(read).toEqual(expect.objectContaining({
      kind: 'login',
      home: { spaceId: ids.S, credentialId: login.credential.id, provider: 'openai' },
      displayLogin: 'team@example.com',
    }));
  });
});

describe('logins (083 split, M3, M4)', () => {
  it('t1-8: a space login and the same member’s own login for one provider coexist; two live logins on one space credential are refused', async () => {
    const own = await db.rpc<{ workSessionId: string }>(claims(B), 'start_credential_session', [ids.S, 'anthropic', 900, 100]);
    const space = await store.startLogin(claims(B), { spaceId: ids.S!, provider: 'anthropic', label: label('b-login'), sessionCap: 100 });
    expect(own.workSessionId).not.toBe(space.workSessionId);
    // Control for the member half: a second own login for the same provider is still one-live.
    await expect(db.rpc(claims(B), 'start_credential_session', [ids.S, 'anthropic', 900, 100])).rejects.toThrow(/one_live_per_account_provider/);

    await store.finishLogin(claims(B), space.workSessionId, true);
    await store.startLogin(claims(B), { spaceId: ids.S!, provider: 'anthropic', credentialId: space.credential.id, sessionCap: 100 });
    await expect(store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'anthropic', credentialId: space.credential.id, sessionCap: 100 }))
      .rejects.toMatchObject({ code: 'invariant_violation', message: expect.stringMatching(/a login onto this credential is open until/) });
  });

  it('t1-11: re-login is creator-or-admin; finish refuses a revoked credential', async () => {
    const first = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('relogin'), sessionCap: 100 });
    const done = await store.finishLogin(claims(A), first.workSessionId, true);
    expect(done.credential.status).toBe('active');

    await expect(store.startLogin(claims(B), { spaceId: ids.S!, provider: 'openai', credentialId: first.credential.id, sessionCap: 100 }))
      .rejects.toThrow(/creator or a space admin/);
    const byAdmin = await store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'openai', credentialId: first.credential.id, sessionCap: 100 });
    await store.finishLogin(claims(ADM), byAdmin.workSessionId, true);
    const byCreator = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', credentialId: first.credential.id, sessionCap: 100 });

    // Deleted while the login ran: finish must not bring it back.
    await store.revoke(claims(ADM), first.credential.id);
    await expect(store.finishLogin(claims(A), byCreator.workSessionId, true)).rejects.toThrow(/is revoked/);
    const [row] = await db.query<{ status: string }>(claims(A), 'select status from public.space_credentials where id = $1', [first.credential.id]);
    expect(row!.status).toBe('revoked');
    // And a revoked credential cannot be logged into again.
    await expect(store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', credentialId: first.credential.id, sessionCap: 100 }))
      .rejects.toThrow(/is revoked/);
  });

  it('the member finish (083 finish_credential_session) cannot close a space login (control: it closes the member’s own)', async () => {
    const space = await store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'openai', label: label('guard'), sessionCap: 100 });
    const viaMemberPath = await db.rpc<{ finished: boolean }>(claims(ADM), 'finish_credential_session', [space.workSessionId]);
    expect(viaMemberPath).toEqual({ workSessionId: space.workSessionId, finished: false });
    const [open] = await asOwner(async (c) => (await c.query<{ finished_at: Date | null }>(
      'select finished_at from public.credential_sessions where work_session_id = $1', [space.workSessionId])).rows);
    expect(open!.finished_at).toBeNull();
    // Control: the same member's own login IS closed by the member path.
    const own = await db.rpc<{ workSessionId: string }>(claims(ADM), 'start_credential_session', [ids.S, 'openai', 900, 100]);
    await expect(db.rpc(claims(ADM), 'finish_credential_session', [own.workSessionId])).resolves.toMatchObject({ finished: true });
    // And the space path still finishes the space login.
    await expect(store.finishLogin(claims(ADM), space.workSessionId, true)).resolves.toMatchObject({ connected: true });
  });

  it('the re-created member finish (083 finish_credential_session) is human-only (control: browser closes it)', async () => {
    const own = await db.rpc<{ workSessionId: string }>(claims(A), 'start_credential_session', [ids.S, 'github', 900, 100]);
    await expect(db.rpc(agent(A), 'finish_credential_session', [own.workSessionId])).rejects.toThrow(/human-only/);
    const [open] = await asOwner(async (c) => (await c.query<{ finished_at: Date | null }>(
      'select finished_at from public.credential_sessions where work_session_id = $1', [own.workSessionId])).rows);
    expect(open!.finished_at).toBeNull();
    await expect(db.rpc(claims(A), 'finish_credential_session', [own.workSessionId])).resolves.toMatchObject({ finished: true });
  });

  it('only the account that opened a space login can finish it', async () => {
    const login = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'anthropic', label: label('mine'), sessionCap: 100 });
    await expect(store.finishLogin(claims(ADM), login.workSessionId, true)).rejects.toThrow(/no space login terminal of yours/);
    await expect(store.finishLogin(claims(A), login.workSessionId, true)).resolves.toMatchObject({ connected: true });
  });

  it('delete leaves an open login terminal listed; an admin then stamps another member’s terminal on the revoked credential (decision (a))', async () => {
    const first = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('del-open'), sessionCap: 100 });
    await store.finishLogin(claims(A), first.workSessionId, true);
    const cred = first.credential.id;
    const terminal = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', credentialId: cred, sessionCap: 100 });
    await store.revoke(claims(ADM), cred);
    // MUST-FIX 1: the revoke did not stamp it — it is still found for step 2.
    const live = await store.liveSessions(claims(ADM), cred);
    expect(live.loginTerminals.map((x) => x.workSessionId)).toEqual([terminal.workSessionId]);

    // ok=true on a revoked credential is refused, even for the opener.
    await expect(store.finishLogin(claims(A), terminal.workSessionId, true)).rejects.toThrow(/is revoked/);
    // B is neither the opener, the creator nor an admin: answered as missing.
    await expect(store.finishLogin(claims(B), terminal.workSessionId, false)).rejects.toThrow(/no space login terminal of yours/);
    expect((await store.liveSessions(claims(ADM), cred)).loginTerminals).toHaveLength(1);

    // The admin closes A's terminal: finished_at only, nothing else moves.
    const before = await asOwner(async (c) => (await c.query('select * from public.space_credentials where id = $1', [cred])).rows[0]);
    const closed = await store.finishLogin(claims(ADM), terminal.workSessionId, false);
    expect(closed).toMatchObject({ finished: true, connected: false, credential: { id: cred, status: 'revoked' } });
    const after = await asOwner(async (c) => (await c.query('select * from public.space_credentials where id = $1', [cred])).rows[0]);
    expect(after).toEqual(before);
    expect((await store.liveSessions(claims(ADM), cred)).loginTerminals).toEqual([]);
  });

  it('decision (a): the credential’s creator may stamp an admin’s terminal on a revoked credential; not while it is live', async () => {
    const made = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('creator-close'), sessionCap: 100 });
    await store.finishLogin(claims(A), made.workSessionId, true);
    const terminal = await store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'openai', credentialId: made.credential.id, sessionCap: 100 });
    // Live credential: the exception does not apply, the creator cannot finish the admin's login.
    await expect(store.finishLogin(claims(A), terminal.workSessionId, false)).rejects.toThrow(/no space login terminal of yours/);
    await store.revoke(claims(A), made.credential.id);
    await expect(store.finishLogin(claims(A), terminal.workSessionId, false)).resolves.toMatchObject({ finished: true, connected: false });
  });

  it('MUST-FIX 2: repairing a stale default after another became default clears its flag (finish, probe, rekey)', async () => {
    const provider = 'github';
    const ghKey = (who: string) => `ghp_${randomUUID().replaceAll('-', '')}${who}`;
    const mk = (who: string, shape: 'token' = 'token') =>
      store.create(claims(who), { spaceId: ids.S!, provider, shape, label: label(`${who} gh`), secret: ghKey(who) });
    const defaults = async () => (await db.query<{ id: string }>(claims(A),
      `select id from public.space_credentials where space_id = $1 and provider = $2 and is_default and status = 'active'`, [ids.S, provider])).map((r) => r.id);

    // Probe path.
    const old = await mk(A);
    expect(old.isDefault).toBe(true);
    await store.recordProbe(claims(A), old.id, false);
    const replacement = await mk(A);
    expect(replacement.isDefault).toBe(true);
    const repaired = await store.recordProbe(claims(A), old.id, true);
    expect(repaired).toMatchObject({ status: 'active', isDefault: false });
    expect(await defaults()).toEqual([replacement.id]);

    // Rekey path.
    await store.recordProbe(claims(A), replacement.id, false);
    const third = await mk(A);
    expect(third.isDefault).toBe(true);
    const rekeyed = await store.rekey(claims(A), replacement.id, ghKey('re'));
    expect(rekeyed).toMatchObject({ status: 'active', isDefault: false });
    expect(await defaults()).toEqual([third.id]);
    // Control: a repaired default with no rival keeps its flag.
    await store.recordProbe(claims(A), third.id, false);
    await expect(store.recordProbe(claims(A), third.id, true)).resolves.toMatchObject({ isDefault: true });

    // Finish path (login shape). T has no openai credential at this point.
    const lp = 'openai';
    const login = await store.startLogin(claims(OUT), { spaceId: ids.T!, provider: lp, label: label('t-login'), sessionCap: 100 });
    const done = await store.finishLogin(claims(OUT), login.workSessionId, true);
    expect(done.credential.isDefault).toBe(true);
    await store.recordProbe(claims(OUT), login.credential.id, false);
    const rival = await store.create(claims(OUT), { spaceId: ids.T!, provider: lp, shape: 'api_key', label: label('t-key'), secret: key('t') });
    expect(rival.isDefault).toBe(true);
    const relogin = await store.startLogin(claims(OUT), { spaceId: ids.T!, provider: lp, credentialId: login.credential.id, sessionCap: 100 });
    const refinished = await store.finishLogin(claims(OUT), relogin.workSessionId, true);
    expect(refinished.credential).toMatchObject({ status: 'active', isDefault: false });
  });

  it('A1: a missing or blank label is invalid input, not a raw constraint', async () => {
    await expect(store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: null as never, sessionCap: 100 }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: '   ', sessionCap: 100 }))
      .rejects.toThrow(/label of 1 to 80 characters/);
    await expect(store.create(claims(A), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: ' ', secret: key('l') }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const { credential } = await newApiKey(A);
    await expect(store.rename(claims(A), credential.id, '')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('N1: past expires_at a manager closes an abandoned login; the credential is logged into again (control: not before)', async () => {
    const made = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('abandon'), sessionCap: 100 });
    await store.finishLogin(claims(A), made.workSessionId, true);
    const cred = made.credential.id;
    // ADM opens a re-login onto A's credential and never comes back.
    const abandoned = await store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'openai', credentialId: cred, sessionCap: 100 });
    // Before expiry: the creator cannot close it, and a re-login is refused by name, not by a raw 23505.
    await expect(store.finishLogin(claims(A), abandoned.workSessionId, false)).rejects.toThrow(/no space login terminal of yours/);
    await expect(store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', credentialId: cred, sessionCap: 100 }))
      .rejects.toMatchObject({ code: 'invariant_violation', details: expect.objectContaining({ reason: 'login_open' }) });

    await asOwner((c) => c.query(`update public.credential_sessions set expires_at = now() - interval '1 minute' where work_session_id = $1`, [abandoned.workSessionId]));
    // A plain member is neither creator nor admin; ok=true is never a manager's.
    await expect(store.finishLogin(claims(B), abandoned.workSessionId, false)).rejects.toThrow(/no space login terminal of yours/);
    await expect(store.finishLogin(claims(A), abandoned.workSessionId, true)).rejects.toThrow(/no space login terminal of yours/);
    const before = await asOwner(async (c) => (await c.query('select * from public.space_credentials where id = $1', [cred])).rows[0]);
    await expect(store.finishLogin(claims(A), abandoned.workSessionId, false)).resolves.toMatchObject({ finished: true, connected: false });
    const after = await asOwner(async (c) => (await c.query('select * from public.space_credentials where id = $1', [cred])).rows[0]);
    expect(after).toEqual(before);
    // B2: the late opener cannot now report a success onto the closed terminal.
    await expect(store.finishLogin(claims(ADM), abandoned.workSessionId, true)).rejects.toThrow(/already finished/);
    // Unwedged: a re-login opens and finishes.
    const again = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', credentialId: cred, sessionCap: 100 });
    await expect(store.finishLogin(claims(A), again.workSessionId, true)).resolves.toMatchObject({ connected: true });
  });

  it('N1: an abandoned PENDING login is closed by an admin past expiry, and the sweep then removes it', async () => {
    const pending = await store.startLogin(claims(B), { spaceId: ids.S!, provider: 'anthropic', label: label('pend-abandon'), sessionCap: 100 });
    await asOwner(async (c) => {
      await c.query(`update public.credential_sessions set expires_at = now() - interval '1 minute' where work_session_id = $1`, [pending.workSessionId]);
      await c.query(`update public.space_credentials set pending_expires_at = now() - interval '1 minute' where id = $1`, [pending.credential.id]);
    });
    await store.expirePending(agent(A));
    expect(await db.query(claims(A), 'select 1 from public.space_credentials where id = $1', [pending.credential.id])).toHaveLength(1);
    await expect(store.finishLogin(claims(A), pending.workSessionId, false)).rejects.toThrow(/no space login terminal of yours/);
    await expect(store.finishLogin(claims(ADM), pending.workSessionId, false)).resolves.toMatchObject({ finished: true, credential: { status: 'pending' } });
    // B2: the opener's late success cannot activate it.
    await expect(store.finishLogin(claims(B), pending.workSessionId, true)).rejects.toThrow(/already finished/);
    expect(await store.expirePending(agent(A))).toBeGreaterThanOrEqual(1);
    expect(await db.query(claims(A), 'select 1 from public.space_credentials where id = $1', [pending.credential.id])).toHaveLength(0);
  });

  it('B1: set_default on Y and a repair of the stale default X, queued on the slot together, both complete (no 40P01)', async () => {
    const provider = 'github';
    const gh = () => `ghp_${randomUUID().replaceAll('-', '')}`;
    // A fresh space so the (space, github) slot and its defaults are this test's alone.
    const space = await asOwner(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'B1', $2)`, [id, A]);
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`, [member, id, A]);
      return id;
    });
    const x = await store.create(claims(A), { spaceId: space, provider, shape: 'token', label: label('x'), secret: gh() });
    const y = await store.create(claims(A), { spaceId: space, provider, shape: 'token', label: label('y'), secret: gh() });
    expect([x.isDefault, y.isDefault]).toEqual([true, false]);
    await store.recordProbe(claims(A), x.id, false); // X: stale, still flagged default

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const holder = asOwner(async (c) => {
      await c.query(`select pg_advisory_xact_lock(hashtextextended($1::text || '|' || $2, 206))`, [space, provider]);
      held();
      await gate;
    });
    await holding;
    const setDefault = store.setDefault(claims(A), y.id).then(() => 'ok', (e: unknown) => e);
    await waitForLockWait(1);
    const repair = store.recordProbe(claims(A), x.id, true).then(() => 'ok', (e: unknown) => e);
    await waitForLockWait(2);
    release();
    await holder;
    expect([await setDefault, await repair]).toEqual(['ok', 'ok']);
    const rows = await db.query<{ id: string; is_default: boolean; status: string }>(claims(A),
      'select id, is_default, status from public.space_credentials where space_id = $1 order by created_at', [space]);
    expect(rows).toEqual([
      { id: x.id, is_default: false, status: 'active' },
      { id: y.id, is_default: true, status: 'active' },
    ]);
  });

  it('t1-13: pending is outside the default index, and expired pending rows are swept', async () => {
    const login = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'openai', label: label('expire'), sessionCap: 100 });
    expect(login.credential).toMatchObject({ status: 'pending', isDefault: false });
    // A pending row can never be the default (constraint), whatever the index says.
    await expect(asOwner((c) => c.query('update public.space_credentials set is_default = true where id = $1', [login.credential.id])))
      .rejects.toThrow(/space_credentials_default_check/);
    await expect(store.setDefault(claims(A), login.credential.id)).rejects.toThrow(/only an active credential/);

    // Not yet expired, with its terminal open: the sweep leaves it.
    await store.expirePending(claims(A));
    expect(await db.query(claims(A), 'select 1 from public.space_credentials where id = $1', [login.credential.id])).toHaveLength(1);

    // Expired, and its terminal's own deadline passed too — but the terminal
    // is still UNFINISHED (its PTY may outlive expires_at): still left.
    await asOwner(async (c) => {
      await c.query(`update public.space_credentials set pending_expires_at = now() - interval '1 minute' where id = $1`, [login.credential.id]);
      await c.query(`update public.credential_sessions set expires_at = now() - interval '1 minute' where work_session_id = $1`, [login.workSessionId]);
    });
    await store.expirePending(agent(A));
    expect(await db.query(claims(A), 'select 1 from public.space_credentials where id = $1', [login.credential.id])).toHaveLength(1);
    // A failed finish closes the terminal and leaves the row pending; now it goes.
    const failed = await store.finishLogin(claims(A), login.workSessionId, false);
    expect(failed).toMatchObject({ finished: true, connected: false, credential: { status: 'pending' } });
    expect(await store.expirePending(agent(A))).toBeGreaterThanOrEqual(1);
    expect(await db.query(claims(A), 'select 1 from public.space_credentials where id = $1', [login.credential.id])).toHaveLength(0);
  });
});

describe('the session record (D8, M7, M9) and containment (M6)', () => {
  it('C1/C2: A launching B’s teammate records the credential with A as launcher, via the manifest', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), s, manifest({ anthropic: credential.id }));
    expect(await recorded(s)).toEqual([{ provider: 'anthropic', space_credential_id: credential.id, launcher_account_id: accounts[A] }]);
  });

  it('a manifest whose sources and ids disagree is refused, and records nothing', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    await expect(recordManifest(agent(A), s, { launch: { credentialSources: { anthropic: 'space' } } })).rejects.toThrow(/without a credential id/);
    await expect(recordManifest(agent(A), s, manifest({ anthropic: credential.id }, { anthropic: 'member' }))).rejects.toThrow(/whose source is not space/);
    expect(await recorded(s)).toEqual([]);
    // Control: a manifest with no space source records nothing and succeeds.
    await recordManifest(agent(A), s, { launch: { credentialSources: { anthropic: 'member' } } });
    expect(await recorded(s)).toEqual([]);
  });

  it('t1-10: the writer refuses another space, a non-spawning session, a different credential, and an inactive one', async () => {
    const { credential } = await newApiKey(A);
    // A session in T, where A is a member — the credential is S's.
    const inT = await session(ids.T!, ids['member:T:' + A]!);
    await expect(recordManifest(agent(A), inT, manifest({ anthropic: credential.id }))).rejects.toThrow(/not in this session's space/);

    const running = await session(ids.S!, ids.TB!, { status: 'running' });
    await expect(recordManifest(agent(A), running, manifest({ anthropic: credential.id }))).rejects.toThrow(/only while a session is spawning/);

    const dup = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), dup, manifest({ anthropic: credential.id }));
    // A2: a retried identical write is a no-op (a timed-out write may have committed)…
    await recordManifest(agent(A), dup, manifest({ anthropic: credential.id }));
    expect(await recorded(dup)).toEqual([{ provider: 'anthropic', space_credential_id: credential.id, launcher_account_id: accounts[A] }]);
    // …while a DIFFERENT credential for the same provider is refused.
    const other = await newApiKey(A);
    await expect(recordManifest(agent(A), dup, manifest({ anthropic: other.credential.id })))
      .rejects.toThrow(/already records a different anthropic space credential/);
    expect((await recorded(dup))[0]!.space_credential_id).toBe(credential.id);

    const stale = await newApiKey(A);
    await store.recordProbe(claims(A), stale.credential.id, false);
    const s4 = await session(ids.S!, ids.TB!);
    await expect(recordManifest(agent(A), s4, manifest({ anthropic: stale.credential.id }))).rejects.toThrow(/is stale/);
    // Control: the same session records an active credential.
    await recordManifest(agent(A), s4, manifest({ anthropic: credential.id }));
    expect(await recorded(s4)).toHaveLength(1);
    expect(await recorded(inT)).toEqual([]);
    expect(await recorded(running)).toEqual([]);
  });

  // This does NOT guard the writer's FOR SHARE (206:1142): the inserted row's
  // composite foreign key takes KEY SHARE on the credential, which blocks
  // delete's FOR UPDATE on its own, so the test stays green with FOR SHARE
  // removed. The guard is the delete-first test below.
  it('t1-10: a delete waits for an in-flight record (held by the FK’s KEY SHARE), then finds its session', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let recordedInTx!: () => void;
    const inserted = new Promise<void>((r) => { recordedInTx = r; });
    const spawn = db.tx(agent(A), async (q) => {
      await q.rpc('record_session_manifest', [s, JSON.stringify(manifest({ anthropic: credential.id }))]);
      recordedInTx();
      await gate;
    });
    await inserted;
    let revokeDone = false;
    const revoke = store.revoke(claims(A), credential.id).then((r) => { revokeDone = true; return r; });
    await waitForLockWait();
    expect(revokeDone).toBe(false);
    release();
    await spawn;
    await expect(revoke).resolves.toMatchObject({ status: 'revoked', revoked: true });
    // The revoked credential's session is found for step 2.
    const live = await store.liveSessions(claims(A), credential.id);
    expect(live.sessions.map((x) => x.workSessionId)).toContain(s);
  });

  // The guard on the writer's FOR SHARE (206:1142): without it the insert's
  // active check reads its pre-wait snapshot and records onto the revoked row.
  it('t1-10: a record that waits behind a committed delete inserts nothing and is refused (guards the writer FOR SHARE)', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let lockedInTx!: () => void;
    const locked = new Promise<void>((r) => { lockedInTx = r; });
    const del = db.tx(claims(A), async (q) => {
      await q.rpc('delete_space_credential', [credential.id]);
      lockedInTx();
      await gate;
    });
    await locked;
    const spawn = recordManifest(agent(A), s, manifest({ anthropic: credential.id }));
    const settled = spawn.then(() => 'ok', (e: unknown) => e);
    await waitForLockWait();
    release();
    await del;
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toMatch(/is revoked/);
    expect(await recorded(s)).toEqual([]);
  });

  it('t1-12: containment finds OTHER members’ and AGENT-spawned sessions and login terminals', async () => {
    const login = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'anthropic', label: label('contain'), sessionCap: 100 });
    await store.finishLogin(claims(A), login.workSessionId, true);
    const cred = login.credential.id;
    const byB = await session(ids.S!, ids['member:S:' + B]!);
    await recordManifest(agent(B), byB, manifest({ anthropic: cred }));
    const byAforTB = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), byAforTB, manifest({ anthropic: cred }));
    const exited = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), exited, manifest({ anthropic: cred }));
    await setSessionStatus(exited, 'exited');
    await setSessionStatus(byB, 'running');
    const terminal = await store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'anthropic', credentialId: cred, sessionCap: 100 });

    // The creator sees B's session and the admin's terminal; the exited one is gone.
    const live = await store.liveSessions(claims(A), cred);
    expect(live.sessions.map((x) => x.workSessionId).sort()).toEqual([byB, byAforTB].sort());
    expect(live.sessions.find((x) => x.workSessionId === byB)!.launcherAccountId).toBe(accounts[B]);
    expect(live.sessions.find((x) => x.workSessionId === byAforTB)!.launcherAccountId).toBe(accounts[A]);
    expect(live.loginTerminals.map((x) => x.workSessionId)).toEqual([terminal.workSessionId]);
    // B, who can use it but not manage it, cannot enumerate it.
    await expect(store.liveSessions(claims(B), cred)).rejects.toThrow(/creator or a space admin/);

    // Member removal: an admin finds what A launched — including the session
    // for B's teammate — and nothing of B's.
    const ofA = await store.memberSessions(claims(ADM), ids.S!, accounts[A]!);
    expect(ofA.sessions.map((x) => x.workSessionId)).toContain(byAforTB);
    expect(ofA.sessions.map((x) => x.workSessionId)).not.toContain(byB);
    await expect(store.memberSessions(claims(A), ids.S!, accounts[A]!)).resolves.toBeTruthy();
    await expect(store.memberSessions(claims(B), ids.S!, accounts[A]!)).rejects.toThrow(/space admin required/);
    // C2: B owns teammate TB, yet A's launch of TB is A's, not B's.
    const ofB = await store.memberSessions(claims(B), ids.S!, accounts[B]!);
    expect(ofB.sessions.map((x) => x.workSessionId)).toContain(byB);
    expect(ofB.sessions.map((x) => x.workSessionId)).not.toContain(byAforTB);

    // MUST-FIX 5: a node admin asks across every space (account disable);
    // a space admin may not drop the space; the account itself may.
    const inT = await session(ids.T!, ids['member:T:' + A]!);
    const tKey = await newApiKey(A, 'openai', ids.T!);
    await recordManifest(agent(A), inT, manifest({ openai: tKey.credential.id }));
    const nodeAdmin = { ...claims(OUT), nodeAdmin: true } as DbClaims;
    const everywhere = await store.memberSessions(nodeAdmin, null, accounts[A]!);
    expect(everywhere.spaceId).toBeNull();
    expect(everywhere.sessions.map((x) => x.workSessionId)).toEqual(expect.arrayContaining([byAforTB, inT]));
    expect(everywhere.sessions.find((x) => x.workSessionId === inT)!.spaceId).toBe(ids.T);
    expect(everywhere.sessions.map((x) => x.workSessionId)).not.toContain(byB);
    await expect(store.memberSessions({ ...agent(OUT), nodeAdmin: true } as DbClaims, null, accounts[A]!)).rejects.toThrow(/human-only/);
    await expect(store.memberSessions(claims(ADM), null, accounts[A]!)).rejects.toThrow(/space admin required/);
    await expect(store.memberSessions(claims(A), null, accounts[A]!)).resolves.toMatchObject({ accountId: accounts[A] });
  });

  it('A3: a malformed spaceCredentialIds entry is invalid input, not a cast error', async () => {
    const s = await session(ids.S!, ids.TB!);
    await expect(recordManifest(agent(A), s, manifest({ anthropic: 'not-a-uuid' }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(recordManifest(agent(A), s, manifest({ anthropic: 'not-a-uuid' }))).rejects.toThrow(/is not a credential id/);
    expect(await recorded(s)).toEqual([]);
  });

  it('(d): 206 leaves record_session_manifest owned by the migration role, not tm8_graph_owner', async () => {
    const [row] = await database.query<{ owner: string; me: string }>(
      `select pg_get_userbyid(p.proowner) owner, current_user me from pg_proc p
        where p.oid = 'public.record_session_manifest(uuid, jsonb, text[], text, text, text)'::regprocedure`);
    expect(row!.owner).not.toBe('tm8_graph_owner');
    expect(row!.owner).toBe(row!.me);
    const [finish] = await database.query<{ owner: string }>(
      `select pg_get_userbyid(proowner) owner from pg_proc where oid = 'public.finish_credential_session(uuid)'::regprocedure`);
    expect(finish!.owner).toBe('tm8_graph_owner');
  });

  it('C3: resume re-points the launcher to the resumer, and refuses once a credential is no longer active', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), s, manifest({ anthropic: credential.id }));
    await setSessionStatus(s, 'idle');
    const repointed = await store.repointSession(agent(B), s);
    expect(repointed).toMatchObject({ launcherAccountId: accounts[B], credentials: [{ provider: 'anthropic', spaceCredentialId: credential.id }] });
    expect((await recorded(s))[0]!.launcher_account_id).toBe(accounts[B]);
    await expect(store.repointSession(claims(OUT), s)).rejects.toThrow();

    await store.revoke(claims(A), credential.id);
    await expect(store.repointSession(agent(A), s)).rejects.toThrow(/no longer active/);
    expect((await recorded(s))[0]!.launcher_account_id).toBe(accounts[B]);
  });

  // The two repoint lock tests (206:1195-1203, repoint's FOR SHARE). Each gate
  // is released and each held transaction settled in `finally`: if a wait
  // never happens, waitForLockWait throws, and a gate left shut would hold its
  // transaction open and hang the suite instead of failing this test.
  it('C3: a repoint waiting behind an uncommitted delete refuses once the delete commits', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), s, manifest({ anthropic: credential.id }));
    await setSessionStatus(s, 'idle');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let lockedInTx!: () => void;
    const locked = new Promise<void>((r) => { lockedInTx = r; });
    const del = db.tx(claims(A), async (q) => {
      await q.rpc('delete_space_credential', [credential.id]);
      lockedInTx();
      await gate;
    });
    try {
      await locked;
      const settled = store.repointSession(agent(B), s).then(() => 'ok', (e: unknown) => e);
      await waitForLockWait();
      release();
      await del;
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toMatch(/no longer active/);
      expect((await recorded(s))[0]!.launcher_account_id).toBe(accounts[A]);
    } finally {
      release();
      await del.catch(() => undefined);
    }
  });

  it('C3: a delete waits for an in-flight repoint (guards repoint’s FOR SHARE)', async () => {
    const { credential } = await newApiKey(A);
    const s = await session(ids.S!, ids.TB!);
    await recordManifest(agent(A), s, manifest({ anthropic: credential.id }));
    await setSessionStatus(s, 'idle');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let repointedInTx!: () => void;
    const repointed = new Promise<void>((r) => { repointedInTx = r; });
    const tx = db.tx(agent(B), async (q) => {
      await q.rpc('repoint_session_space_credentials', [s]);
      repointedInTx();
      await gate;
    });
    let revoke: Promise<unknown> | undefined;
    try {
      await repointed;
      let revokeDone = false;
      revoke = store.revoke(claims(A), credential.id).then((r) => { revokeDone = true; return r; });
      await waitForLockWait();
      expect(revokeDone).toBe(false);
      release();
      await tx;
      await expect(revoke).resolves.toMatchObject({ revoked: true });
      // The repoint committed first, so the revoked credential's session names B.
      expect((await recorded(s))[0]!.launcher_account_id).toBe(accounts[B]);
    } finally {
      release();
      await tx.catch(() => undefined);
      await revoke?.catch(() => undefined);
    }
  });
});
