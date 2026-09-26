/**
 * W10b — the human-only credential writers (migration 998), against a REAL
 * PostgreSQL with every migration applied, running as `tm8_app` under each
 * caller's claims. The service is the real `SpaceCredentialCatalogService`
 * over the real `DbSpaceCredentialStore`; only the vendor probe and the PTY
 * host are fakes.
 *
 * Names carry the acceptance cell (a1-a5, T37/T40) and the threat-review item
 * they evidence (N8, N12, N13). Every refusal is paired with a positive on the
 * same credential, so no row can pass merely because everything is refused.
 *
 * Cast: spaces S and T. OWN owns S (and is node admin), ADM is an admin of S,
 * A and B are members of S, OUT is a member of T only. TB is a teammate owned
 * by B. Every secret is an obviously fake canary.
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
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { runSpaceCredentialSweepTick } from '../../src/scheduler/jobs/space-credential-sweep.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'w10b-owner';
const ADM = 'w10b-admin';
const A = 'w10b-a';
const B = 'w10b-b';
const OUT = 'w10b-outsider';

const CANARY = 'W10bFakeCanary7d41';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let service: SpaceCredentialCatalogService;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};
/** Each kill, with the credential's visibility/status as the kill saw it (D7). */
const contained: Array<{ id: string; cause: string; seen: { visibility: string; status: string } | null }> = [];
/** The credential whose row the fake PTY host reads at kill time. */
let watching: string | null = null;

const claims = (identityId: string, authKind = 'browser', nodeAdmin = false): DbClaims =>
  ({ identityId, nodeAdmin, requestId: randomUUID(), authKind }) as DbClaims;
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
const secretFor = (stem: string): string => `sk-${CANARY}-${stem}-${randomUUID().replaceAll('-', '')}`;

/** The SQLSTATE and reason a refused call raised, or `'ok'`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; details?: { sqlstate?: string; reason?: string }; cause?: { code?: string } };
    const code = e.details?.sqlstate ?? e.cause?.code ?? e.code;
    return e.details?.reason ? `${String(code)}:${e.details.reason}` : String(code);
  }
}

async function row(id: string) {
  return asOwner(async (c) => (await c.query<{
    status: string; visibility: string; is_default: boolean; may_be_space_default: boolean; owner: string | null;
  }>(
    `select status, visibility, is_default, may_be_space_default, owner_account_id::text owner
       from public.space_credentials where id = $1`, [id])).rows[0]!);
}

async function session(createdBy: string, status = 'spawning'): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids.S, createdBy]);
    await c.query(
      `insert into public.work_sessions(entity_id, title, status, session_kind, agent_tool) values ($1, 'fixture', $2, 'agent', 'claude-code')`,
      [id, status],
    );
    return id;
  });
}

async function setStatus(sessionId: string, status: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

function record(
  who: DbClaims,
  sessionId: string,
  credentialId: string,
  pick?: 'pinned' | 'my_default' | 'space_default',
  provider = 'anthropic',
): Promise<unknown> {
  return db.rpc(who, 'record_session_manifest', [
    sessionId,
    JSON.stringify({
      launch: {
        credentialSources: { [provider]: 'space' },
        spaceCredentialIds: { [provider]: credentialId },
        ...(pick ? { spaceCredentialPicks: { [provider]: pick } } : {}),
      },
    }),
  ]);
}

type Ownership = { visibility: 'public' | 'private'; mayBeSpaceDefault?: boolean } | { spaceOwned: true } | Record<string, never>;

/** A credential `who` creates through the real door (E1: visibility | spaceOwned | neither = legacy). */
async function create(who: string, how: Ownership = { visibility: 'public' }, space = 'S') {
  const view = await service.create(claims(who), ids[space]!, {
    provider: 'anthropic', shape: 'api_key', label: label(`${who} key`), secret: secretFor(who), ...how,
  });
  return view.id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-w10b-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('credential_ops');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  service = new SpaceCredentialCatalogService({
    db,
    store,
    probe: async () => ({ ok: true, displayLogin: null }),
    terminals: { terminate: () => 'killed', hasLiveTerminal: () => false },
    agentSessions: {
      containCredentialSession: async (id, cause) => {
        // D7: the kill must see the row already switched (row first, then kill).
        const seen = watching ? await row(watching) : null;
        contained.push({ id, cause, seen: seen && { visibility: seen.visibility, status: seen.status } });
        return { outcome: 'killed', recorded: true };
      },
    },
    removeLoginHome: async () => undefined,
    env: {},
  });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, $2, $3) returning id::text`,
        [identity, identity === OWN, identity === OWN],
      );
      accounts[identity] = rows[0]!.id;
    }
    ids.S = await newId(c);
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2), ($3, 'T', $4)`, [ids.S, OWN, ids.T, OUT]);
    for (const [space, identity, role] of [
      ['S', OWN, 'owner'], ['S', ADM, 'admin'], ['S', A, 'member'], ['S', B, 'member'], ['T', OUT, 'owner'],
    ] as const) {
      const member = ids[`member:${space}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids[space]]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids[space], identity, role],
      );
    }
    ids.TB = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $3)`, [
      ids.TB, ids.S, ids[`member:S:${B}`],
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

describe('a1 / T37 — credential writers are human-only; the member matrix', () => {
  it('an agent cannot create, even with its launcher\'s claims; the same launcher, human, can', async () => {
    const input = { spaceId: ids.S!, provider: 'anthropic' as const, shape: 'api_key' as const, label: label('agent'), secret: secretFor('agent') };
    expect(await outcome(() => store.create(agent(A), { ...input, visibility: 'public' }))).toMatch(/^42501/);
    expect(await outcome(() => store.create(agent(A), { ...input, spaceOwned: true }))).toMatch(/^42501/);
    // The service refuses before the probe (the key never leaves the node).
    expect(await outcome(() => service.create(agent(A), ids.S!, { ...input, visibility: 'private' }))).not.toBe('ok');
    expect(await outcome(() => store.create(claims(A), { ...input, visibility: 'public' }))).toBe('ok');
  });

  it('an agent cannot make public, rekey, rename or revoke — the owner\'s own agent included; the owner can', async () => {
    const cred = await create(A, { visibility: 'private' });
    expect(await outcome(() => store.setVisibility(agent(A), cred, 'public'))).toMatch(/^42501/);
    expect(await outcome(() => store.rekey(agent(A), cred, secretFor('re')))).toMatch(/^42501/);
    expect(await outcome(() => store.rename(agent(A), cred, 'agent rename'))).toMatch(/^42501/);
    expect(await outcome(() => store.revoke(agent(A), cred))).toMatch(/^42501/);
    expect(await outcome(() => store.setSpaceDefaultConsent(agent(A), cred, false))).toMatch(/^42501/);
    expect(await outcome(() => store.setMyDefault(agent(A), cred))).toMatch(/^42501/);
    expect((await row(cred)).status).toBe('active');
    expect(await outcome(() => store.setVisibility(claims(A), cred, 'public'))).toBe('ok');
    expect(await outcome(() => store.rekey(claims(A), cred, secretFor('re')))).toBe('ok');
    expect(await outcome(() => store.rename(claims(A), cred, 'human rename'))).toBe('ok');
    expect(await outcome(() => store.revoke(claims(A), cred))).toBe('ok');
  });

  it('create: every human member (member, admin, owner); a non-member is refused; E1 decides the owner', async () => {
    for (const who of [A, ADM, OWN]) {
      const id = await create(who, { visibility: 'private' });
      expect(await row(id)).toMatchObject({ owner: accounts[who], visibility: 'private' });
    }
    const spaceOwned = await create(A, { spaceOwned: true });
    expect(await row(spaceOwned)).toMatchObject({ owner: null, visibility: 'public' });
    expect(await outcome(() => create(OUT, { visibility: 'public' }))).not.toBe('ok');
    expect(await outcome(() => create(OUT, { visibility: 'public' }, 'T'))).toBe('ok');
    // Both fields at once is refused; consent on a private one is refused.
    expect(await outcome(() => store.create(claims(A), {
      spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: label('both'), secret: secretFor('both'),
      visibility: 'public', spaceOwned: true,
    }))).toBe('22023');
    expect(await outcome(() => store.create(claims(A), {
      spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: label('c'), secret: secretFor('c'),
      visibility: 'private', mayBeSpaceDefault: true,
    }))).toBe('22023');
  });

  it('N12 / T12: an OWNED credential is the owner\'s alone — admin and space owner refused on rekey, rename, visibility; admin may revoke', async () => {
    const cred = await create(A, { visibility: 'private' });
    for (const who of [ADM, OWN, B]) {
      expect(await outcome(() => store.rekey(claims(who), cred, secretFor('adm'))), `${who} rekey`).toBe('42501');
      expect(await outcome(() => store.rename(claims(who), cred, 'hijack')), `${who} rename`).toBe('42501');
      expect(await outcome(() => store.setVisibility(claims(who), cred, 'public')), `${who} visibility`).toBe('42501');
    }
    // B, a plain member, cannot revoke it either (not found: private rows are the owner's).
    expect(await outcome(() => store.revoke(claims(B), cred))).not.toBe('ok');
    expect(await outcome(() => store.rename(claims(A), cred, 'mine'))).toBe('ok');
    expect(await outcome(() => store.revoke(claims(ADM), cred))).toBe('ok');
    expect((await row(cred)).status).toBe('revoked');
  });

  it('N12 / T12: a SPACE-OWNED credential is still managed by its creator or an admin (D11); another member is refused', async () => {
    const cred = await create(A, { spaceOwned: true });
    expect(await outcome(() => store.rename(claims(B), cred, 'b'))).toBe('42501');
    expect(await outcome(() => store.rekey(claims(B), cred, secretFor('b')))).toBe('42501');
    expect(await outcome(() => store.rename(claims(ADM), cred, 'admin'))).toBe('ok');
    expect(await outcome(() => store.rekey(claims(ADM), cred, secretFor('adm')))).toBe('ok');
    expect(await outcome(() => store.rename(claims(A), cred, 'creator'))).toBe('ok');
    expect(await outcome(() => store.revoke(claims(B), cred))).toBe('42501');
    expect(await outcome(() => store.revoke(claims(A), cred))).toBe('ok');
  });

  it('claim: only the creator of a legacy (unchosen) space-owned row; never a chosen space-owned one', async () => {
    const legacy = await create(A, {});
    const chosen = await create(A, { spaceOwned: true });
    expect(await outcome(() => store.claim(claims(B), legacy))).toBe('42501');
    expect(await outcome(() => store.claim(claims(ADM), legacy))).toBe('42501');
    expect(await outcome(() => store.claim(agent(A), legacy))).toMatch(/^42501/);
    expect(await outcome(() => store.claim(claims(A), chosen))).toBe('23514:space_owned');
    expect(await outcome(() => store.claim(claims(A), legacy))).toBe('ok');
    expect(await row(legacy)).toMatchObject({ owner: accounts[A] });
    expect(await outcome(() => store.claim(claims(A), legacy))).toBe('23514:owned');
  });
});

describe('a2 / T40 — the space default: opted-in public or space-owned only; private clears atomically', () => {
  it('an owned credential needs public + the owner\'s consent; then the owner or an admin sets it, a member cannot', async () => {
    const cred = await create(B, { visibility: 'public' });
    expect(await outcome(() => store.setDefault(claims(ADM), cred))).toBe('23514:not_eligible');
    expect(await outcome(() => store.setDefault(claims(B), cred))).toBe('23514:not_eligible');
    // Consent is the owner's alone.
    expect(await outcome(() => store.setSpaceDefaultConsent(claims(ADM), cred, true))).toBe('42501');
    expect(await outcome(() => store.setSpaceDefaultConsent(claims(B), cred, true))).toBe('ok');
    expect(await outcome(() => store.setDefault(claims(A), cred))).toBe('42501');
    expect(await outcome(() => store.setDefault(claims(ADM), cred))).toBe('ok');
    expect(await outcome(() => store.setDefault(claims(B), cred))).toBe('ok');
    expect((await row(cred)).is_default).toBe(true);
    // Withdrawing consent clears the default in the same statement.
    await store.setSpaceDefaultConsent(claims(B), cred, false);
    expect(await row(cred)).toMatchObject({ is_default: false, may_be_space_default: false });
  });

  it('a private credential cannot take consent; a space-owned one needs none', async () => {
    const priv = await create(B, { visibility: 'private' });
    expect(await outcome(() => store.setSpaceDefaultConsent(claims(B), priv, true))).toBe('23514:not_eligible');
    expect(await outcome(() => store.setDefault(claims(ADM), priv))).toBe('23514:not_eligible');
    const shared = await create(A, { spaceOwned: true });
    expect(await outcome(() => store.setSpaceDefaultConsent(claims(A), shared, true))).toBe('22023');
    expect(await outcome(() => store.setDefault(claims(B), shared))).toBe('42501');
    expect(await outcome(() => store.setDefault(claims(ADM), shared))).toBe('ok');
  });

  it('switch to private clears is_default and may_be_space_default in the same statement', async () => {
    const cred = await create(B, { visibility: 'public', mayBeSpaceDefault: true });
    await store.setDefault(claims(B), cred);
    expect(await row(cred)).toMatchObject({ is_default: true, may_be_space_default: true });
    const switched = await store.setVisibility(claims(B), cred, 'private');
    expect(switched).toMatchObject({ isDefault: false, mayBeSpaceDefault: false, visibility: 'private' });
    expect(await row(cred)).toMatchObject({ is_default: false, may_be_space_default: false, visibility: 'private' });
  });
});

describe('a3 / T43 — my default (the first auto rung)', () => {
  it('is set from the caller\'s own credential only, read under agent claims, and cleared by its owner', async () => {
    const mine = await create(A, { visibility: 'private' });
    const theirs = await create(B, { visibility: 'public' });
    const shared = await create(A, { spaceOwned: true });
    expect(await outcome(() => store.setMyDefault(claims(A), theirs))).toBe('42501');
    expect(await outcome(() => store.setMyDefault(claims(A), shared))).toBe('42501');
    expect(await store.setMyDefault(claims(A), mine)).toMatchObject({ credentialId: mine });
    // The auto rung reads it under the launcher's agent claims; B sees none of A's.
    expect(await store.myDefaultId(agent(A), ids.S!, 'anthropic')).toBe(mine);
    expect(await store.myDefaultId(claims(B), ids.S!, 'anthropic')).toBeNull();
    expect(await store.clearMyDefault(claims(A), ids.S!, 'anthropic')).toMatchObject({ cleared: true });
    expect(await store.myDefaultId(claims(A), ids.S!, 'anthropic')).toBeNull();
  });

  it('a revoked default is not found, and revoke deletes the member_defaults row', async () => {
    const mine = await create(A, { visibility: 'private' });
    await store.setMyDefault(claims(A), mine);
    await store.revoke(claims(A), mine);
    expect(await store.myDefaultId(claims(A), ids.S!, 'anthropic')).toBeNull();
    const left = await asOwner(async (c) => (await c.query('select 1 from public.member_defaults where credential_id = $1', [mine])).rowCount);
    expect(left).toBe(0);
  });
});

describe('a5 — audit columns on every launch; usage for the owner (admins: public / space-owned only)', () => {
  it('the recorder stamps source, credential, owner and launcher from the manifest', async () => {
    const cred = await create(A, { visibility: 'public' });
    const picks = ['pinned', 'my_default', 'space_default'] as const;
    const sessions: string[] = [];
    for (const pick of picks) {
      const s = await session(ids[`member:S:${B}`]!);
      await record(pick === 'my_default' ? claims(A) : claims(B), s, cred, pick);
      sessions.push(s);
    }
    const unstamped = await session(ids[`member:S:${B}`]!);
    await record(claims(B), unstamped, cred);
    const rows = await asOwner(async (c) => (await c.query<{ ws: string; source: string | null; cred: string; owner: string; launcher: string }>(
      `select work_session_id::text ws, source, space_credential_id::text cred, owner_account_id::text owner, launcher_account_id::text launcher
         from public.session_space_credentials where work_session_id = any($1::uuid[])`, [[...sessions, unstamped]])).rows);
    const by = new Map(rows.map((r) => [r.ws, r]));
    picks.forEach((pick, i) => {
      expect(by.get(sessions[i]!), pick).toMatchObject({ source: pick, cred, owner: accounts[A] });
    });
    expect(by.get(sessions[0]!)!.launcher).toBe(accounts[B]);
    expect(by.get(unstamped)!.source).toBeNull();
  });

  it('usage: the owner sees a private one, an admin does not; an admin sees public and space-owned ones; a member sees none', async () => {
    const priv = await create(A, { visibility: 'private' });
    const pub = await create(A, { visibility: 'public' });
    const shared = await create(A, { spaceOwned: true });
    const s = await session(ids[`member:S:${B}`]!);
    await record(claims(B), s, pub, 'pinned');
    expect(await outcome(() => store.usage(claims(ADM), priv))).not.toBe('ok');
    expect(await outcome(() => store.usage(claims(A), priv))).toBe('ok');
    expect(await outcome(() => store.usage(claims(B), pub))).toBe('42501');
    expect(await outcome(() => store.usage(agent(A), pub))).toMatch(/^42501/);
    const seen = await store.usage(claims(ADM), pub);
    expect(seen.sessions).toEqual([expect.objectContaining({
      workSessionId: s, source: 'pinned', credentialId: pub, ownerAccountId: accounts[A], launcherAccountId: accounts[B],
    })]);
    expect(await outcome(() => store.usage(claims(ADM), shared))).toBe('ok');
  });
});

describe('a4 / D7 — switch to private: row first, then kill; a session B resumed counts as B\'s', () => {
  it('each kill sees the credential already private, and only non-owner sessions die', async () => {
    const cred = await create(A, { visibility: 'public' });
    const byB = await session(ids[`member:S:${B}`]!);
    await record(claims(B), byB, cred);
    await setStatus(byB, 'running');
    // A launched this one, then B resumed it: the repoint makes B its launcher.
    const resumed = await session(ids[`member:S:${A}`]!);
    await record(claims(A), resumed, cred);
    await setStatus(resumed, 'idle');
    await store.repointSession(claims(B), resumed, ['anthropic']);
    const byA = await session(ids[`member:S:${A}`]!);
    await record(claims(A), byA, cred);
    await setStatus(byA, 'running');

    contained.length = 0;
    watching = cred;
    try {
      const result = await service.setVisibility(claims(A), cred, 'private');
      expect(new Set(result.terminatedAgentSessionIds)).toEqual(new Set([byB, resumed]));
    } finally {
      watching = null;
    }
    expect(contained.map((c) => c.id).sort()).toEqual([byB, resumed].sort());
    for (const kill of contained) {
      expect(kill).toMatchObject({ cause: 'space_credential_made_private', seen: { visibility: 'private', status: 'active' } });
    }
  });

  it('revoke: row first (revoked), then kill — whoever launched it', async () => {
    const cred = await create(A, { visibility: 'private' });
    const byA = await session(ids[`member:S:${A}`]!);
    await record(claims(A), byA, cred);
    await setStatus(byA, 'running');
    contained.length = 0;
    watching = cred;
    try {
      const result = await service.delete(claims(ADM), cred);
      expect(result.terminatedAgentSessionIds).toEqual([byA]);
    } finally {
      watching = null;
    }
    expect(contained).toEqual([{ id: byA, cause: 'space_credential_deleted', seen: { visibility: 'private', status: 'revoked' } }]);
  });
});

describe('N13 — repoint takes the providers the resume resolved', () => {
  it('drops the rows of a provider the resume no longer runs on, keeps and re-points the rest', async () => {
    const cred = await create(A, { visibility: 'public' });
    const s = await session(ids[`member:S:${A}`]!);
    await record(claims(A), s, cred);
    const kept = await store.repointSession(claims(B), s, ['anthropic']);
    expect(kept).toMatchObject({ launcherAccountId: accounts[B], credentials: [{ provider: 'anthropic', spaceCredentialId: cred }] });
    const dropped = await store.repointSession(claims(B), s, ['openai']);
    expect(dropped.credentials).toEqual([]);
    const left = await asOwner(async (c) => (await c.query('select 1 from public.session_space_credentials where work_session_id = $1', [s])).rowCount);
    expect(left).toBe(0);
  });
});

describe('R8 / N8 — the sweep finds and kills live sessions on a revoked or wrongly-private credential', () => {
  it('the reader: revoked (any launcher) and private-by-non-owner; not the owner\'s, not ended ones; node admin only', async () => {
    const revoked = await create(A, { visibility: 'public' });
    const priv = await create(A, { visibility: 'public' });
    const onRevoked = await session(ids[`member:S:${A}`]!);
    await record(claims(A), onRevoked, revoked);
    await setStatus(onRevoked, 'running');
    const nonOwner = await session(ids[`member:S:${B}`]!);
    await record(claims(B), nonOwner, priv);
    await setStatus(nonOwner, 'running');
    const ownerOwn = await session(ids[`member:S:${A}`]!);
    await record(claims(A), ownerOwn, priv);
    await setStatus(ownerOwn, 'running');
    const ended = await session(ids[`member:S:${B}`]!);
    await record(claims(B), ended, priv);
    await setStatus(ended, 'running');
    await setStatus(ended, 'exited');
    // The switches as they would land if the inline kill were missed: rows only.
    await store.revoke(claims(A), revoked);
    await store.setVisibility(claims(A), priv, 'private');

    expect(await outcome(() => store.unusableSessions(claims(ADM)))).toBe('42501');
    const mine = new Set([onRevoked, nonOwner, ownerOwn, ended]);
    const found = (await store.unusableSessions(claims(OWN, 'browser', true))).filter((r) => mine.has(r.workSessionId));
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ workSessionId: onRevoked, credentialId: revoked, reason: 'revoked' }),
      expect.objectContaining({ workSessionId: nonOwner, credentialId: priv, reason: 'private' }),
    ]));
    expect(found).toHaveLength(2);

    // The job's tick kills exactly those two, with the matching causes.
    const kills: Array<{ id: string; cause: string }> = [];
    const outcomeOfTick = await runSpaceCredentialSweepTick({
      store: { unusableSessions: async (c, limit) => (await store.unusableSessions(c, limit)).filter((r) => mine.has(r.workSessionId)) },
      agentSessions: { containCredentialSession: async (id, cause) => { kills.push({ id, cause }); return { outcome: 'killed', recorded: true }; } },
      claims: async () => claims(OWN, 'browser', true),
    });
    expect(outcomeOfTick).toMatchObject({ affected: 2, detail: { found: 2, contained: 2, failed: 0 } });
    expect(kills).toEqual(expect.arrayContaining([
      { id: onRevoked, cause: 'space_credential_deleted' },
      { id: nonOwner, cause: 'space_credential_made_private' },
    ]));
  });

  it('account disable revokes first: the disabled owner\'s credential reads revoked in the same statement, and the sweep then finds its sessions', async () => {
    const identity = `w10b-disable-${randomUUID()}`;
    const acct = await asOwner(async (c) => {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1) returning id::text`, [identity]);
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)`, [member, ids.S, identity]);
      return rows[0]!.id;
    });
    const cred = await create(identity, { visibility: 'public' });
    const byB = await session(ids[`member:S:${B}`]!);
    await record(claims(B), byB, cred);
    await setStatus(byB, 'running');
    // In ONE transaction: disable, then read — the credential is already revoked.
    const seen = await asOwner(async (c) => {
      await c.query(`update public.accounts set status = 'disabled', disabled_at = now() where id = $1`, [acct]);
      return (await c.query<{ status: string; secret: boolean }>(
        'select status, secret_ciphertext is not null secret from public.space_credentials where id = $1', [cred])).rows[0]!;
    });
    expect(seen).toEqual({ status: 'revoked', secret: false });
    const found = await store.unusableSessions(claims(OWN, 'browser', true));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ workSessionId: byB, reason: 'revoked' })]));
  });
});

describe('runSpaceCredentialSweepTick — isolation and dedupe', () => {
  it('kills a session once (revoked outranks private), keeps going past a failed kill, and skips an empty batch', async () => {
    const kills: Array<{ id: string; cause: string }> = [];
    const tick = await runSpaceCredentialSweepTick({
      store: {
        unusableSessions: async () => [
          { workSessionId: 's1', provider: 'anthropic', credentialId: 'c1', status: 'running', reason: 'private' },
          { workSessionId: 's1', provider: 'openai', credentialId: 'c2', status: 'running', reason: 'revoked' },
          { workSessionId: 's2', provider: 'anthropic', credentialId: 'c1', status: 'spawning', reason: 'private' },
          { workSessionId: 's3', provider: 'anthropic', credentialId: 'c1', status: 'idle', reason: 'private' },
        ],
      },
      agentSessions: {
        containCredentialSession: async (id, cause) => {
          kills.push({ id, cause });
          if (id === 's2') throw new Error('pty host down');
          return { outcome: 'killed', recorded: true };
        },
      },
      claims: async () => claims(OWN, 'browser', true),
    });
    expect(kills).toEqual([
      { id: 's1', cause: 'space_credential_deleted' },
      { id: 's2', cause: 'space_credential_made_private' },
      { id: 's3', cause: 'space_credential_made_private' },
    ]);
    expect(tick).toMatchObject({ affected: 2, detail: { found: 3, contained: 2, failed: 1 } });
    const empty = await runSpaceCredentialSweepTick({
      store: { unusableSessions: async () => [] },
      agentSessions: { containCredentialSession: async () => { throw new Error('never'); } },
      claims: async () => claims(OWN, 'browser', true),
    });
    expect(empty).toMatchObject({ skipped: true });
  });
});
