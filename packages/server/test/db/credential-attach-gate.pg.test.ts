/**
 * W10c — the owner-only view/drive gate for sessions that record a PRIVATE
 * space credential (doc 13 §3h, T38; migration 257), against a REAL PostgreSQL
 * with every migration applied, running as `tm8_app` under each caller's claims.
 *
 * Names carry the matrix cell and the brief's N-test they evidence. Every
 * refusal is paired with a positive — the owner on the same session, and the
 * same caller on a PUBLIC-credential session — so no row passes merely because
 * everything is refused, and the public rows pin 202's behaviour as unchanged.
 *
 * Cast: space S. OWN owns S (node admin too), ADM is an admin of S, A and B are
 * members. TA is a real teammate (team_members row) whose persona A owns, so
 * B may act as TA under 075 — the strongest non-owner in the matrix: before
 * 257, B held TA's session's owner right. A OWNS every credential here.
 * Every secret and label is an obviously fake canary.
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
import { createPtyCredentialRecheck, issuePtyGrantToken } from '../../src/pty/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'w10c-owner';
const ADM = 'w10c-admin';
const A = 'w10c-a';
const B = 'w10c-b';

const CANARY = 'W10cFakeCanary7d41';
const PRIVATE_ATTACH = 'this session runs on a private credential; only its owner may attach';
const PRIVATE_WIDEN = 'this session runs on a private credential; only its owner may widen its sharing';

const MIGRATION = migrationFiles().find((f) => /_credential_attach_gate\.sql$/.test(f));

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let service: SpaceCredentialCatalogService;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: identityId === OWN, requestId: randomUUID(), authKind }) as DbClaims;
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

/** `'ok'`, or the SQLSTATE and message a refused call raised. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: { sqlstate?: string }; cause?: { code?: string; message?: string } };
    const code = e.details?.sqlstate ?? e.cause?.code ?? e.code;
    return `${String(code)}: ${e.cause?.message ?? e.message ?? ''}`;
  }
}

async function session(createdBy: string): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids.S, createdBy]);
    await c.query(
      `insert into public.work_sessions(entity_id, title, status, session_kind, agent_tool) values ($1, 'fixture', 'spawning', 'agent', 'claude-code')`,
      [id],
    );
    return id;
  });
}

function record(who: DbClaims, sessionId: string, credentialId: string): Promise<unknown> {
  return db.rpc(who, 'record_session_manifest', [
    sessionId,
    JSON.stringify({ launch: { credentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: credentialId } } }),
  ]);
}

/** A credential A OWNS, at `visibility`, created through the real door. */
async function ownedByA(visibility: 'public' | 'private'): Promise<string> {
  const view = await service.create(claims(A), ids.S!, {
    provider: 'anthropic', shape: 'api_key', label: `w10c key ${String(++seq)}`,
    secret: `sk-${CANARY}-${randomUUID().replaceAll('-', '')}`,
  });
  await asOwner((c) => c.query(
    'update public.space_credentials set owner_account_id = $2, is_default = false where id = $1', [view.id, accounts[A]]));
  if (visibility === 'private') await store.setVisibility(claims(A), view.id, 'private');
  return view.id;
}

/** A session TA (A's agent) launched on credential `credentialId`. */
async function taSession(credentialId: string): Promise<string> {
  const id = await session(ids.TA!);
  await record(agent(A), id, credentialId);
  return id;
}

function grant(who: string, sessionId: string, mode: 'view' | 'drive', tokenHash = issuePtyGrantToken().tokenHash) {
  return db.rpc(claims(who), 'public.grant_stream_attach', [sessionId, mode, tokenHash, '30 seconds', null]);
}

function share(who: string, sessionId: string, dials: { share?: 'none' | 'space'; drive?: 'owner' | 'space' }) {
  return db.rpc(claims(who), 'set_work_session_sharing', [sessionId, null, dials.share ?? null, dials.drive ?? null, null, null]);
}

async function allowed(who: string, sessionId: string): Promise<boolean> {
  const rows = await db.query<{ allowed: boolean }>(
    claims(who), 'select public.session_stream_credential_allowed($1::uuid) as allowed', [sessionId]);
  return rows[0]!.allowed;
}

async function dials(sessionId: string) {
  return asOwner(async (c) => (await c.query<{ share_mode: string; drive_mode: string }>(
    'select share_mode, drive_mode from public.work_sessions where entity_id = $1', [sessionId])).rows[0]!);
}

beforeAll(async () => {
  expect(MIGRATION, 'the W10c migration is in the migration list').toBeDefined();
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-w10c-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('credential_attach_gate');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir, logger: { warn: () => undefined } });
  service = new SpaceCredentialCatalogService({
    db,
    store,
    probe: async () => ({ ok: true, displayLogin: null }),
    terminals: { terminate: () => 'killed', hasLiveTerminal: () => false },
    agentSessions: { containCredentialSession: async () => ({ outcome: 'killed', recorded: true }) },
    removeLoginHome: async () => undefined,
    env: {},
  });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, $2, $3) returning id::text`,
        [identity, identity === OWN, identity === OWN],
      );
      accounts[identity] = rows[0]!.id;
    }
    ids.S = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2)`, [ids.S, OWN]);
    // 187's narrowest defaults, so every widening below is a real one. The
    // "dials do not open it" row then sets them wide explicitly.
    await c.query(`update public.spaces set session_share_default = 'none', session_drive_default = 'owner' where id = $1`, [ids.S]);
    for (const [identity, role] of [[OWN, 'owner'], [ADM, 'admin'], [A, 'member'], [B, 'member']] as const) {
      const member = ids[`member:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids.S, identity, role],
      );
    }
    ids.TA = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'team_member', 0, $3)`, [
      ids.TA, ids.S, ids[`member:${A}`],
    ]);
    await c.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role) values ($1, $2, 'W10c agent', 'engineer')`,
      [ids.TA, ids[`member:${A}`]],
    );
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

// ---------------------------------------------------------------------------

describe('T38 / a1 — view and drive on a private-credential session are the owner\'s alone', () => {
  it('refuses member-who-may-act-as, admin and space owner on both modes; the credential owner attaches to both', async () => {
    const priv = await ownedByA('private');
    const s = await taSession(priv);
    for (const who of [B, ADM, OWN]) {
      for (const mode of ['view', 'drive'] as const) {
        expect(await outcome(() => grant(who, s, mode)), `${who} ${mode}`).toBe(`42501: ${PRIVATE_ATTACH}`);
      }
    }
    expect(await outcome(() => grant(A, s, 'view'))).toBe('ok');
    expect(await outcome(() => grant(A, s, 'drive'))).toBe('ok');
  });

  it('the dials do not open it: after the owner shares view and drive with the space, non-owners are still refused', async () => {
    const s = await taSession(await ownedByA('private'));
    expect(await outcome(() => share(A, s, { share: 'space', drive: 'space' }))).toBe('ok');
    expect(await dials(s)).toEqual({ share_mode: 'space', drive_mode: 'space' });
    for (const who of [B, ADM]) {
      expect(await outcome(() => grant(who, s, 'view'))).toBe(`42501: ${PRIVATE_ATTACH}`);
      expect(await outcome(() => grant(who, s, 'drive'))).toBe(`42501: ${PRIVATE_ATTACH}`);
    }
    expect(await outcome(() => grant(A, s, 'drive'))).toBe('ok');
  });

  it('PAIRED POSITIVE, public credential — unchanged 202 behaviour: act-as B views and drives while unconfigured; admin views and drives once shared', async () => {
    const s = await taSession(await ownedByA('public'));
    expect(await outcome(() => grant(B, s, 'view'))).toBe('ok');
    expect(await outcome(() => grant(B, s, 'drive'))).toBe('ok');
    expect(await outcome(() => share(A, s, { share: 'space', drive: 'space' }))).toBe('ok');
    expect(await outcome(() => grant(ADM, s, 'view'))).toBe('ok');
    expect(await outcome(() => grant(ADM, s, 'drive'))).toBe('ok');
  });

  it('R16 — the refusal names no credential, hint, login or owner', async () => {
    const priv = await ownedByA('private');
    const s = await taSession(priv);
    const said = await outcome(() => grant(B, s, 'view'));
    for (const needle of [priv, CANARY, A, accounts[A]!, 'sk-']) expect(said).not.toContain(needle);
  });
});

describe('T38 / a1 — set_work_session_sharing: only the credential owner may widen', () => {
  it('refuses a widening by act-as, admin and space owner; the credential owner widens', async () => {
    const s = await taSession(await ownedByA('private'));
    for (const who of [B, ADM, OWN]) {
      expect(await outcome(() => share(who, s, { share: 'space' })), `${who} share`).toBe(`42501: ${PRIVATE_WIDEN}`);
      expect(await outcome(() => share(who, s, { drive: 'space' })), `${who} drive`).toBe(`42501: ${PRIVATE_WIDEN}`);
    }
    expect(await dials(s)).toEqual({ share_mode: 'none', drive_mode: 'owner' });
    expect(await outcome(() => share(A, s, { share: 'space', drive: 'space' }))).toBe('ok');
    expect(await dials(s)).toEqual({ share_mode: 'space', drive_mode: 'space' });
  });

  it('refuses a widening by the session CREATOR who is not the credential owner; narrowing stays open to the creator and the admin', async () => {
    // B launched on A's credential while it was public; A then made it private.
    const cred = await ownedByA('public');
    const s = await session(ids[`member:${B}`]!);
    expect(await outcome(() => record(claims(B), s, cred))).toBe('ok');
    await store.setVisibility(claims(A), cred, 'private');
    expect(await outcome(() => share(B, s, { share: 'space' }))).toBe(`42501: ${PRIVATE_WIDEN}`);
    expect(await outcome(() => grant(B, s, 'view'))).toBe(`42501: ${PRIVATE_ATTACH}`);
    // The owner widens; creator and admin may still narrow.
    expect(await outcome(() => share(A, s, { share: 'space', drive: 'space' }))).toBe('ok');
    expect(await outcome(() => share(B, s, { drive: 'owner' }))).toBe('ok');
    expect(await outcome(() => share(ADM, s, { share: 'none' }))).toBe('ok');
    expect(await dials(s)).toEqual({ share_mode: 'none', drive_mode: 'owner' });
  });

  it('the first write on an unconfigured teammate session does not materialise 075\'s "space" for a private credential', async () => {
    const s = await taSession(await ownedByA('private'));
    expect(await outcome(() => share(A, s, { drive: 'owner' }))).toBe('ok');
    expect(await dials(s)).toEqual({ share_mode: 'none', drive_mode: 'owner' });
  });

  it('PAIRED POSITIVE, public credential — act-as B and the admin widen as before; 075\'s first write still materialises "space"', async () => {
    const s1 = await taSession(await ownedByA('public'));
    expect(await outcome(() => share(B, s1, { drive: 'owner' }))).toBe('ok');
    expect(await dials(s1)).toEqual({ share_mode: 'space', drive_mode: 'owner' });
    const s2 = await taSession(await ownedByA('public'));
    expect(await outcome(() => share(ADM, s2, { share: 'space', drive: 'space' }))).toBe('ok');
  });
});

describe('a2 — a child session spawned by the owner\'s agent inherits the credential and is owner-only', () => {
  it('a child recorded under A\'s agent with the inherited pin refuses B and admits A; B\'s agent cannot inherit it', async () => {
    // manifest.ts resolveCredentialSources: inherited key > inherited scalar,
    // so a child of TA's session carries the same spaceCredentialIds pin and
    // record_session_manifest writes the same session_space_credentials row.
    const priv = await ownedByA('private');
    await taSession(priv);
    const child = await session(ids.TA!);
    expect(await outcome(() => record(agent(A), child, priv))).toBe('ok');
    expect(await outcome(() => grant(B, child, 'view'))).toBe(`42501: ${PRIVATE_ATTACH}`);
    expect(await outcome(() => grant(B, child, 'drive'))).toBe(`42501: ${PRIVATE_ATTACH}`);
    expect(await outcome(() => grant(A, child, 'drive'))).toBe('ok');
    expect(await allowed(B, child)).toBe(false);
    expect(await allowed(A, child)).toBe(true);
    // A child B's agent spawns cannot carry A's private pin at all (W10a's gate).
    const bChild = await session(ids.TA!);
    expect(await outcome(() => record(agent(B), bChild, priv))).toMatch(/^42501/);
  });
});

describe('N2 — the read paths (execution.journal, execution.transcript, PTY recheck) ask session_stream_credential_allowed', () => {
  it('private: false for act-as, admin and space owner, true for the owner', async () => {
    const s = await taSession(await ownedByA('private'));
    expect(await allowed(B, s)).toBe(false);
    expect(await allowed(ADM, s)).toBe(false);
    expect(await allowed(OWN, s)).toBe(false);
    expect(await allowed(A, s)).toBe(true);
  });

  it('PAIRED POSITIVE: public credential and no credential at all are true for everyone', async () => {
    const pub = await taSession(await ownedByA('public'));
    const none = await session(ids.TA!);
    for (const who of [A, B, ADM]) {
      expect(await allowed(who, pub)).toBe(true);
      expect(await allowed(who, none)).toBe(true);
    }
  });

  it('L1 member gate: a caller outside the space, or pinned to another space, gets false on EVERY session (no deny-only bit)', async () => {
    const pub = await taSession(await ownedByA('public'));
    const priv = await taSession(await ownedByA('private'));
    const none = await session(ids.TA!);
    const outsider = 'w10c-outsider';
    for (const s of [pub, priv, none]) {
      expect(await allowed(outsider, s)).toBe(false);
      expect(await createPtyCredentialRecheck(db)(s, outsider)).toBe(false);
      // A (the owner, a member) pinned to another space is outside it too.
      const [row] = await db.query<{ ok: boolean }>(
        { identityId: A, sessionSpaceId: '00000000-0000-4000-8000-000000000001' },
        'select public.session_stream_credential_allowed($1::uuid) as ok', [s]);
      expect(row!.ok).toBe(false);
    }
    // An unknown session uuid answers false, not an error.
    expect(await allowed(A, '00000000-0000-4000-8000-000000000002')).toBe(false);
  });

  it('a disabled owner account admits nobody', async () => {
    const s = await taSession(await ownedByA('private'));
    await asOwner((c) => c.query(`update public.accounts set status = 'disabled', disabled_at = now() where id = $1`, [accounts[A]]));
    try {
      expect(await allowed(A, s)).toBe(false);
      expect(await outcome(() => grant(A, s, 'view'))).toBe(`42501: ${PRIVATE_ATTACH}`);
    } finally {
      await asOwner((c) => c.query(`update public.accounts set status = 'active', disabled_at = null where id = $1`, [accounts[A]]));
    }
  });
});

describe('N9 / R9 — switching to private closes what was already granted or open', () => {
  it('a grant minted while public cannot be consumed after the switch; the owner\'s can', async () => {
    const cred = await ownedByA('public');
    const s = await taSession(cred);
    const bToken = issuePtyGrantToken();
    const aToken = issuePtyGrantToken();
    expect(await outcome(() => grant(B, s, 'drive', bToken.tokenHash))).toBe('ok');
    expect(await outcome(() => grant(A, s, 'drive', aToken.tokenHash))).toBe('ok');
    await store.setVisibility(claims(A), cred, 'private');
    // With the browser claim and with none (the CLI path) — one refusal either way.
    expect(await outcome(() => db.rpc({ identityId: B }, 'public.consume_stream_attach', [s, 'drive', bToken.tokenHash])))
      .toBe('42501: stream attach refused');
    expect(await outcome(() => db.rpc({}, 'public.consume_stream_attach', [s, 'drive', bToken.tokenHash])))
      .toBe('42501: stream attach refused');
    expect(await outcome(() => db.rpc({}, 'public.consume_stream_attach', [s, 'drive', aToken.tokenHash]))).toBe('ok');
  });

  it('PAIRED POSITIVE: a grant on a credential that stays public still consumes', async () => {
    const s = await taSession(await ownedByA('public'));
    const token = issuePtyGrantToken();
    expect(await outcome(() => grant(B, s, 'view', token.tokenHash))).toBe('ok');
    expect(await outcome(() => db.rpc({ identityId: B }, 'public.consume_stream_attach', [s, 'view', token.tokenHash]))).toBe('ok');
  });

  it('the open-socket recheck the PTY server runs answers per socket subject, live', async () => {
    const cred = await ownedByA('public');
    const s = await taSession(cred);
    const recheck = createPtyCredentialRecheck(db);
    expect(await recheck(s, B)).toBe(true);
    await store.setVisibility(claims(A), cred, 'private');
    expect(await recheck(s, B)).toBe(false);
    expect(await recheck(s, A)).toBe(true);
    await store.setVisibility(claims(A), cred, 'public');
    expect(await recheck(s, B)).toBe(true);
  });
});

describe('257 — consume_stream_attach keeps 233\'s session-space pin AND adds the private-credential rule', () => {
  const pinned = (sessionSpaceId: string, identityId?: string): DbClaims => ({ identityId, sessionSpaceId });

  it('a PUBLIC credential with the pin set to another space is refused; the right pin consumes', async () => {
    const other = await asOwner(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S-other', $2)`, [id, OWN]);
      return id;
    });
    const s = await taSession(await ownedByA('public'));
    const token = issuePtyGrantToken();
    expect(await outcome(() => grant(B, s, 'view', token.tokenHash))).toBe('ok');
    expect(await outcome(() => db.rpc(pinned(other, B), 'public.consume_stream_attach', [s, 'view', token.tokenHash])))
      .toBe('42501: stream attach refused');
    expect(await outcome(() => db.rpc(pinned(other), 'public.consume_stream_attach', [s, 'view', token.tokenHash])))
      .toBe('42501: stream attach refused');
    // PAIRED POSITIVE: a fresh grant of the same kind consumes under the RIGHT
    // pin, so neither single use nor expiry explains the refusal above.
    const fresh = issuePtyGrantToken();
    expect(await outcome(() => grant(B, s, 'view', fresh.tokenHash))).toBe('ok');
    expect(await outcome(() => db.rpc(pinned(ids.S!, B), 'public.consume_stream_attach', [s, 'view', fresh.tokenHash])))
      .toBe('ok');
  });

  it('a PRIVATE credential with a non-owner subject and the RIGHT pin is refused; the owner with the right pin consumes', async () => {
    const cred = await ownedByA('public');
    const s = await taSession(cred);
    const bToken = issuePtyGrantToken();
    const aToken = issuePtyGrantToken();
    expect(await outcome(() => grant(B, s, 'drive', bToken.tokenHash))).toBe('ok');
    expect(await outcome(() => grant(A, s, 'drive', aToken.tokenHash))).toBe('ok');
    // Both grants were minted while the credential was PUBLIC (as N9), so only
    // consume_stream_attach's own predicate can refuse B's after the switch.
    await store.setVisibility(claims(A), cred, 'private');
    expect(await outcome(() => db.rpc(pinned(ids.S!, B), 'public.consume_stream_attach', [s, 'drive', bToken.tokenHash])))
      .toBe('42501: stream attach refused');
    expect(await outcome(() => db.rpc(pinned(ids.S!), 'public.consume_stream_attach', [s, 'drive', bToken.tokenHash])))
      .toBe('42501: stream attach refused');
    expect(await outcome(() => db.rpc(pinned(ids.S!, A), 'public.consume_stream_attach', [s, 'drive', aToken.tokenHash])))
      .toBe('ok');
  });
});
