/**
 * Sharing a PRIVATE space credential with one member of the same space
 * (migration 992, task 01a10201), against a REAL PostgreSQL with every
 * migration applied, running as `tm8_app` under each caller's claims.
 *
 * Cast: spaces S and T. OWN owns S (and is node admin), ADM is an admin of S,
 * A (the credential owner), B (the grantee) and C are members of S, OUT is a
 * member of T only, BT is a member of both. Every secret is a fake canary.
 *
 * Names carry the acceptance cell of task 01a10201 (a1 share, a2 launch,
 * a3 revoke, a4 space-bound + nothing existing breaks).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialStore, type SpaceCredential } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'share-owner';
const ADM = 'share-admin';
const A = 'share-a';
const B = 'share-b';
const C = 'share-c';
const OUT = 'share-outsider';
const BT = 'share-both';

const CANARY = 'ShareFakeCanary5e19';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};

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

async function create(who: string, visibility: 'public' | 'private' = 'private', space = 'S'): Promise<string> {
  const view = await store.create(claims(who), {
    spaceId: ids[space]!, provider: 'anthropic', shape: 'api_key', label: label(`${who} key`),
    secret: secretFor(who), visibility,
  });
  return view.id;
}

async function session(createdBy: string, space = 'S'): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids[space], createdBy]);
    await c.query(
      `insert into public.work_sessions(entity_id, title, status, session_kind, agent_tool) values ($1, 'fixture', 'spawning', 'agent', 'claude-code')`,
      [id],
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

function record(who: DbClaims, sessionId: string, credentialId: string): Promise<unknown> {
  return db.rpc(who, 'record_session_manifest', [
    sessionId,
    JSON.stringify({
      launch: {
        credentialSources: { anthropic: 'space' },
        spaceCredentialIds: { anthropic: credentialId },
        effectiveCredentialSources: { anthropic: 'space' },
        spaceCredentialPicks: { anthropic: 'pinned' },
      },
    }),
  ]);
}

/** A running session `who` launched on `cred` in S. */
async function launched(who: string, cred: string): Promise<string> {
  const s = await session(ids[`member:S:${who}`]!);
  await record(claims(who), s, cred);
  await setStatus(s, 'running');
  return s;
}

const share = (who: DbClaims, cred: string, grantee: string) =>
  db.rpc<{ shared: boolean; granteeAccountId: string; spaceId: string }>(who, 'share_space_credential', [cred, grantee]);
const unshare = (who: DbClaims, cred: string, grantee: string) =>
  db.rpc<{ unshared: boolean; killSessions: Array<{ workSessionId: string }> }>(who, 'unshare_space_credential', [cred, grantee]);
const shares = (who: DbClaims, cred: string) =>
  db.rpc<Array<{ granteeAccountId: string }>>(who, 'list_space_credential_shares', [cred]);
const card = async (who: string, cred: string) =>
  (await store.list(claims(who), ids.S!)).find((c) => c.id === cred) as SpaceCredential & { sharedWithMe: boolean };
const swept = async (mine: string[]) =>
  (await store.unusableSessions(claims(OWN, 'browser', true))).filter((r) => mine.includes(r.workSessionId));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-share-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('credential_shares');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B, C, OUT, BT]) {
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
      ['S', OWN, 'owner'], ['S', ADM, 'admin'], ['S', A, 'member'], ['S', B, 'member'], ['S', C, 'member'],
      ['S', BT, 'member'], ['T', OUT, 'owner'], ['T', BT, 'member'], ['T', B, 'member'],
    ] as const) {
      const member = ids[`member:${space}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids[space]]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids[space], identity, role],
      );
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

describe('a1 — the owner shares a private credential with one member of its space', () => {
  it('only the owner, only as a human, only to an active member of S other than themself', async () => {
    const cred = await create(A);
    // Not the owner: a member, an admin, the space owner.
    for (const who of [B, C, ADM, OWN]) {
      expect(await outcome(() => share(claims(who), cred, accounts[C]!)), who).toMatch(/^42501/);
    }
    // The owner's own agent is refused (human-only writer).
    expect(await outcome(() => share(agent(A), cred, accounts[B]!))).toMatch(/^42501/);
    // A non-member of S (OUT is only in T) is refused, and so is the owner.
    expect(await outcome(() => share(claims(A), cred, accounts[OUT]!))).toBe('42501:not_member');
    expect(await outcome(() => share(claims(A), cred, randomUUID()))).toBe('42501:not_member');
    expect(await outcome(() => share(claims(A), cred, accounts[A]!))).toBe('22023:self');
    // An outsider cannot even see it.
    expect(await outcome(() => share(claims(OUT), cred, accounts[B]!))).toBe('P0002');

    const first = await share(claims(A), cred, accounts[B]!);
    expect(first).toMatchObject({ shared: true, granteeAccountId: accounts[B], spaceId: ids.S });
    // Idempotent.
    expect(await share(claims(A), cred, accounts[B]!)).toMatchObject({ shared: false, granteeAccountId: accounts[B] });
  });

  it('a public or a revoked credential is not shared (public already is every member\'s)', async () => {
    const pub = await create(A, 'public');
    expect(await outcome(() => share(claims(A), pub, accounts[B]!))).toBe('23514:public');
    const gone = await create(A);
    await store.revoke(claims(A), gone);
    expect(await outcome(() => share(claims(A), gone, accounts[B]!))).toBe('23514:revoked');
  });

  it('the list: the owner and an admin see every grantee; the grantee sees itself; another member sees nothing', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    await share(claims(A), cred, accounts[BT]!);
    expect((await shares(claims(A), cred)).map((s) => s.granteeAccountId).sort()).toEqual([accounts[B], accounts[BT]].sort());
    expect(await shares(claims(ADM), cred)).toHaveLength(2);
    expect((await shares(claims(B), cred)).map((s) => s.granteeAccountId)).toEqual([accounts[B]]);
    expect(await shares(claims(C), cred)).toEqual([]);
    expect(await outcome(() => shares(claims(OUT), cred))).toBe('P0002');
  });
});

describe('a1 — the grantee may be named by member entity id (members expose no account id)', () => {
  it('share and unshare resolve a member id in S; a member id from T is not a member of S', async () => {
    const cred = await create(A);
    const out = await share(claims(A), cred, ids[`member:S:${B}`]!);
    expect(out).toMatchObject({ shared: true, granteeAccountId: accounts[B] });
    const listed = await shares(claims(A), cred);
    expect(listed).toEqual([expect.objectContaining({
      granteeAccountId: accounts[B], granteeMemberId: ids[`member:S:${B}`], granteeDisplayName: B,
    })]);
    // OUT's member id lives in T: it does not resolve in S.
    expect(await outcome(() => share(claims(A), cred, ids[`member:T:${OUT}`]!))).toBe('42501:not_member');
    expect((await unshare(claims(A), cred, ids[`member:S:${B}`]!)).unshared).toBe(true);
    expect(await shares(claims(A), cred)).toEqual([]);
  });
});

describe('a2 — the grantee launches on it; the secret never reaches the grantee', () => {
  it('pinned launch: the grantee and its agents read and record it; another member is refused', async () => {
    const cred = await create(A);
    expect(await outcome(() => store.readForSpawn(claims(B), ids.S!, 'anthropic', cred))).toBe('42501:not_usable');
    await share(claims(A), cred, accounts[B]!);

    const human = await store.readForSpawn(claims(B), ids.S!, 'anthropic', cred);
    expect(human).toMatchObject({ kind: 'secret', credentialId: cred, spaceId: ids.S });
    // Children inherit: an agent under B's claims reads it too.
    expect(await outcome(() => store.readForSpawn(agent(B), ids.S!, 'anthropic', cred))).toBe('ok');
    expect(await db.rpc<string[]>(claims(B), 'usable_space_credential_ids', [[cred]])).toEqual([cred]);
    const s = await session(ids[`member:S:${B}`]!);
    expect(await outcome(() => record(claims(B), s, cred))).toBe('ok');

    // C was not shared it: refused at the reader and the recorder.
    expect(await outcome(() => store.readForSpawn(claims(C), ids.S!, 'anthropic', cred))).toBe('42501:not_usable');
    const sc = await session(ids[`member:S:${C}`]!);
    expect(await outcome(() => record(claims(C), sc, cred))).toBe('42501:not_usable');
  });

  it('the card: sharedWithMe for the grantee only; hint and vendor login stay masked for everyone but the owner', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    const forB = await card(B, cred);
    expect(forB).toMatchObject({ sharedWithMe: true, keyHint: null, displayLogin: null, visibility: 'private' });
    expect(JSON.stringify(forB)).not.toContain(CANARY);
    expect(await card(C, cred)).toMatchObject({ sharedWithMe: false, keyHint: null });
    expect((await card(A, cred)).keyHint).not.toBeNull();
    // Nothing a grantee can list or read carries the secret.
    expect(JSON.stringify(await store.list(claims(B), ids.S!))).not.toContain(CANARY);
    expect(JSON.stringify(await store.read(claims(B), cred))).not.toContain(CANARY);
  });

  it('the ladder: the grantee may make it their my_default, and the auto rung finds it', async () => {
    const cred = await create(A);
    expect(await outcome(() => store.setMyDefault(claims(B), cred))).toBe('42501');
    await share(claims(A), cred, accounts[B]!);
    expect(await outcome(() => store.setMyDefault(claims(B), cred))).toBe('ok');
    expect(await store.myDefaultId(agent(B), ids.S!, 'anthropic')).toBe(cred);
    await store.clearMyDefault(claims(B), ids.S!, 'anthropic');
  });

  it('the grantee cannot manage it: rename, rekey, visibility, re-share are the owner\'s', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    expect(await outcome(() => store.rename(claims(B), cred, 'mine now'))).toBe('42501');
    expect(await outcome(() => store.rekey(claims(B), cred, secretFor('b')))).toBe('42501');
    expect(await outcome(() => store.setVisibility(claims(B), cred, 'public'))).toBe('42501');
    expect(await outcome(() => share(claims(B), cred, accounts[C]!))).toMatch(/^42501/);
  });
});

describe('a3 — withdrawing the share stops new launches and lists the grantee\'s live sessions', () => {
  it('owner unshare: killSessions names the grantee\'s live sessions only; reader, recorder and my_default refuse after', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    await store.setMyDefault(claims(B), cred);
    const ownerRun = await launched(A, cred);
    const granteeRun = await launched(B, cred);
    const granteeEnded = await launched(B, cred);
    await setStatus(granteeEnded, 'exited');
    expect(await swept([ownerRun, granteeRun])).toEqual([]);

    // C (no right) cannot withdraw it.
    expect(await outcome(() => unshare(claims(C), cred, accounts[B]!))).toBe('42501');
    const out = await unshare(claims(A), cred, accounts[B]!);
    expect(out.unshared).toBe(true);
    expect(out.killSessions.map((k) => k.workSessionId)).toEqual([granteeRun]);

    expect(await outcome(() => store.readForSpawn(claims(B), ids.S!, 'anthropic', cred))).toBe('42501:not_usable');
    const next = await session(ids[`member:S:${B}`]!);
    expect(await outcome(() => record(claims(B), next, cred))).toBe('42501:not_usable');
    expect(await store.myDefaultId(claims(B), ids.S!, 'anthropic')).toBeNull();
    // The R8 sweep is the backstop for a missed inline kill.
    expect(await swept([ownerRun, granteeRun])).toEqual([
      expect.objectContaining({ workSessionId: granteeRun, credentialId: cred, reason: 'private' }),
    ]);
    // The owner's own session is untouched.
    expect(await store.readForSpawn(claims(A), ids.S!, 'anthropic', cred)).toMatchObject({ credentialId: cred });
    // Idempotent.
    expect((await unshare(claims(A), cred, accounts[B]!)).unshared).toBe(false);
    await setStatus(granteeRun, 'exited');
  });

  it('a space admin may withdraw a share (revoke is wider), and a resumed grantee session is refused after', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    const run = await launched(B, cred);
    expect((await unshare(claims(ADM), cred, accounts[B]!)).killSessions.map((k) => k.workSessionId)).toEqual([run]);
    await setStatus(run, 'exited');
    await db.rpc(claims(B), 'execution_resume', [run, 100_000]);
    expect(await outcome(() => store.repointSession(claims(B), run, ['anthropic']))).toBe('42501:not_usable');
  });

  it('a grantee who leaves the space loses the share; re-joining does not bring it back', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[BT]!);
    const run = await launched(BT, cred);
    await asOwner(async (c) => {
      await c.query(`update public.members set status = 'left', left_at = now() where entity_id = $1`, [ids[`member:S:${BT}`]]);
    });
    expect(await shares(claims(A), cred)).toEqual([]);
    expect(await swept([run])).toEqual([expect.objectContaining({ workSessionId: run, reason: 'private' })]);
    await asOwner(async (c) => {
      await c.query(`update public.members set status = 'active', left_at = null where entity_id = $1`, [ids[`member:S:${BT}`]]);
    });
    expect(await outcome(() => store.readForSpawn(claims(BT), ids.S!, 'anthropic', cred))).toBe('42501:not_usable');
    await setStatus(run, 'exited');
  });

  it('owner revokes the credential: every grantee session is swept as revoked', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    const run = await launched(B, cred);
    await store.revoke(claims(A), cred);
    expect(await swept([run])).toEqual([expect.objectContaining({ workSessionId: run, reason: 'revoked' })]);
    expect(await outcome(() => store.readForSpawn(claims(B), ids.S!, 'anthropic', cred))).toBe('23514:revoked');
    await setStatus(run, 'exited');
  });
});

describe('a4 — bound to its space; nothing existing changes', () => {
  it('a share in S never lets the grantee launch it from T, and there is no node fallback', async () => {
    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    // B is a member of T too: pinning S's credential from T is not found there.
    expect(await outcome(() => store.readForSpawn(claims(B), ids.T!, 'anthropic', cred))).toBe('P0002:not_found');
    // A T session cannot record S's credential.
    const t = await session(ids[`member:T:${B}`]!, 'T');
    expect(await outcome(() => record(claims(B), t, cred))).toBe('42501');
    // T's ladder is unchanged: no default there, no fallback to S's share.
    expect(await outcome(() => store.readForSpawn(claims(B), ids.T!, 'anthropic', null))).toBe('P0002:no_default');
    // A share row cannot point across spaces (composite FK).
    expect(await outcome(() => asOwner((c) => c.query(
      `insert into public.space_credential_shares(credential_id, space_id, grantee_account_id) values ($1, $2, $3)`,
      [cred, ids.T, accounts[OUT]],
    )))).toBe('23503');
  });

  it('going private keeps a grantee\'s sessions and kills only unshared launchers\' (public -> private)', async () => {
    const cred = await create(A, 'public');
    const granteeRun = await launched(B, cred);
    const otherRun = await launched(C, cred);
    // Sharing needs private; the owner shares right after the switch.
    const switched = await store.setVisibility(claims(A), cred, 'private');
    expect(switched.killSessions.map((k) => k.workSessionId).sort()).toEqual([granteeRun, otherRun].sort());
    await share(claims(A), cred, accounts[B]!);
    expect(await swept([granteeRun, otherRun])).toEqual([expect.objectContaining({ workSessionId: otherRun })]);
    // A later public -> private round trip leaves the grantee's session alone.
    await store.setVisibility(claims(A), cred, 'public');
    const again = await store.setVisibility(claims(A), cred, 'private');
    expect(again.killSessions.map((k) => k.workSessionId)).toEqual([otherRun]);
    for (const s of [granteeRun, otherRun]) await setStatus(s, 'exited');
  });

  it('existing credentials of other members and spaces are untouched by a share and an unshare', async () => {
    const othersPublic = await create(C, 'public');
    const othersPrivate = await create(C);
    const inT = await create(OUT, 'private', 'T');
    const before = await asOwner(async (c) => (await c.query(
      `select id, status, visibility, is_default, owner_account_id, updated_at from public.space_credentials where id = any($1) order by id`,
      [[othersPublic, othersPrivate, inT]],
    )).rows);
    const cRun = await launched(C, othersPublic);

    const cred = await create(A);
    await share(claims(A), cred, accounts[B]!);
    await unshare(claims(A), cred, accounts[B]!);

    const after = await asOwner(async (c) => (await c.query(
      `select id, status, visibility, is_default, owner_account_id, updated_at from public.space_credentials where id = any($1) order by id`,
      [[othersPublic, othersPrivate, inT]],
    )).rows);
    expect(after).toEqual(before);
    expect(await swept([cRun])).toEqual([]);
    // Pre-existing rules hold: B still uses the public one, not C's private one.
    expect(await outcome(() => store.readForSpawn(claims(B), ids.S!, 'anthropic', othersPublic))).toBe('ok');
    expect(await outcome(() => store.readForSpawn(claims(B), ids.S!, 'anthropic', othersPrivate))).toBe('42501:not_usable');
    expect(await outcome(() => store.readForSpawn(claims(OUT), ids.T!, 'anthropic', inT))).toBe('ok');
    await setStatus(cRun, 'exited');
  });
});
