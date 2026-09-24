/**
 * SC-8 — SHARING A PERSONAL CREDENTIAL TO A SPACE, against a REAL PostgreSQL
 * with migration 210 (addendum 01a0d38e v4). Every write goes through the real
 * RPC under the caller's claims; the personal GitHub token is stored by the
 * real DbGitHubCredentialStore (093's seal), so a share read at spawn opens
 * 093's own bytes.
 *
 * Cast: OWN (space owner of S and T, node admin when it says so), A the sharer
 * (member of S and T), B a member of S, C a member of S who shares nothing.
 * X is a member of no space. Test names carry the criterion (sc8-N) or the
 * advisor note (T1, MF1, …) they evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CredentialsSpaceListViewSchema, CredentialsSharesViewSchema } from '@tm8/contract';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbGitHubCredentialStore } from '../../src/credentials/github-credential-store.js';
import { DbSpaceCredentialPort } from '../../src/credentials/space-credential-port.js';
import {
  accountDisableContainment,
  SpaceCredentialMemberContainment,
} from '../../src/credentials/space-credential-containment.js';
import {
  DbSpaceCredentialStore,
  SHARE_TOKEN_KIND_MESSAGE,
  ShareRefusal,
  type SpaceCredentialProvider,
} from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { IdentityServiceImpl, type IdentityRepository } from '../../src/identity/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'sc8-owner';
const A = 'sc8-a';
const B = 'sc8-b';
const C = 'sc8-c';
const X = 'sc8-x';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let github: DbGitHubCredentialStore;
let port: DbSpaceCredentialPort;
let catalog: SpaceCredentialCatalogService;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};
const live: string[] = [];

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');
const nodeAdmin = (): DbClaims => ({ ...claims(OWN), nodeAdmin: true }) as DbClaims;

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

const fineGrained = (): string => `github_pat_${randomUUID().replaceAll('-', '')}_${randomUUID().replaceAll('-', '')}`;
const classic = (): string => `ghp_${randomUUID().replaceAll('-', '').slice(0, 36)}`;

async function connectToken(identity: string, token = fineGrained()): Promise<string> {
  await github.store(claims(identity), { login: identity, token });
  return token;
}

async function disconnectToken(identity: string): Promise<void> {
  await github.delete(claims(identity));
}

async function row(credentialId: string) {
  return asOwner(async (c) => (await c.query<{
    status: string; share_kind: string | null; shared_by_account_id: string | null;
    is_default: boolean; secret_ciphertext: Buffer | null; key_hint: string | null;
  }>(
    `select status, share_kind, shared_by_account_id::text, is_default, secret_ciphertext, key_hint
       from public.space_credentials where id = $1`, [credentialId])).rows[0]!);
}

async function session(space: 'S' | 'T' = 'S'): Promise<string> {
  const id = await asOwner(async (c) => {
    const sessionId = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`,
      [sessionId, ids[space], ids[`member:${space}:${OWN}`]]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind) values ($1, 'fixture', 'spawning', 'agent')`, [sessionId]);
    return sessionId;
  });
  live.push(id);
  return id;
}

async function setSessionStatus(sessionId: string, status: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

async function launchOn(who: DbClaims, sessionId: string, spaceCredentialIds: Partial<Record<SpaceCredentialProvider, string>>): Promise<void> {
  const credentialSources = Object.fromEntries(Object.keys(spaceCredentialIds).map((p) => [p, 'space']));
  await db.rpc(who, 'record_session_manifest', [sessionId, JSON.stringify({
    launch: { credentialSources, spaceCredentialIds, effectiveCredentialSources: credentialSources },
  })]);
  await setSessionStatus(sessionId, 'running');
}

function fakeTerminals() {
  const asked: string[] = [];
  return {
    asked,
    async containCredentialSession(sessionId: string) {
      asked.push(sessionId);
      return { outcome: 'killed' as const, recorded: true };
    },
  };
}

async function share(identity: string, space: 'S' | 'T' = 'S', label = `share ${randomUUID()}`) {
  return store.sharePersonalToken(claims(identity), { spaceId: ids[space]!, label });
}

async function sqlstate(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { details?: { sqlstate?: string } }).details?.sqlstate ?? (error as { code?: string }).code;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc8-shares-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('space_credential_shares');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  github = new DbGitHubCredentialStore({ db, dataDir });
  port = new DbSpaceCredentialPort({ db, store, dataDir });
  catalog = new SpaceCredentialCatalogService({
    db,
    store,
    probe: { probe: async () => ({ ok: true }) } as never,
    terminals: { terminate: () => 'killed', hasLiveTerminal: () => false } as never,
    agentSessions: { containCredentialSession: async () => ({ outcome: 'killed', recorded: true }) },
    env: {},
  });
  await asOwner(async (c) => {
    for (const identity of [OWN, A, B, C, X]) {
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
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $3), ($2, 'T', $3)`, [ids.S, ids.T, OWN]);
    const memberships: Array<['S' | 'T', string, string]> = [
      ['S', OWN, 'owner'], ['S', A, 'member'], ['S', B, 'member'], ['S', C, 'member'],
      ['T', OWN, 'owner'], ['T', A, 'member'],
    ];
    for (const [space, identity, role] of memberships) {
      const member = ids[`member:${space}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids[space]]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids[space], identity, role],
      );
    }
  });
}, 300_000);

afterEach(async () => {
  for (const id of live.splice(0)) await setSessionStatus(id, 'exited');
  for (const identity of [A, B, C]) {
    await db.rpc(nodeAdmin(), 'set_account_disabled', [accounts[identity], false]);
    await disconnectToken(identity).catch(() => undefined);
    await db.rpc(claims(identity), 'delete_account_agent_credential', ['anthropic']).catch(() => undefined);
  }
  // Every share left live by a test is revoked, so the next one starts clean.
  for (const identity of [A, B, C]) await store.revokeMemberShares(claims(identity), null, accounts[identity]!);
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('sc8-2 — only the human owner shares, only into a space they belong to (I2)', () => {
  it('a member shares a fine-grained token by reference: no secret on the row, never the default, named by its sharer', async () => {
    await connectToken(A);
    const shared = await share(A, 'S', 'A’s GitHub');
    expect(shared).toMatchObject({
      provider: 'github', shape: 'token', shareKind: 'personal_token', isDefault: false, keyHint: null,
      status: 'active', sharedBy: { accountId: accounts[A], displayName: A },
    });
    const stored = await row(shared.id);
    expect(stored).toMatchObject({ share_kind: 'personal_token', shared_by_account_id: accounts[A], is_default: false, key_hint: null });
    expect(stored.secret_ciphertext).toBeNull();

    const view = await catalog.list(claims(B), ids.S!);
    expect(CredentialsSpaceListViewSchema.safeParse(view).success).toBe(true);
    expect(view.credentials.find((c) => c.id === shared.id)).toMatchObject({ shareKind: 'personal_token', sharedBy: { displayName: A } });

    const mine = await catalog.shares(claims(A));
    expect(CredentialsSharesViewSchema.safeParse(mine).success).toBe(true);
    expect(mine.shares.map((s) => [s.id, s.spaceName])).toEqual([[shared.id, 'S']]);
    expect(mine.github).toMatchObject({ connected: true, tokenKind: 'fine_grained', shareable: true });
  });

  it('agent claims are refused at the RPC and at the facade', async () => {
    await connectToken(A);
    expect(await sqlstate(db.rpc(agent(A), 'share_personal_token', [ids.S, 'by agent']))).toBe('42501');
    await expect(catalog.share(agent(A), ids.S!, { provider: 'github', label: 'by agent' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(catalog.shares(agent(A))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await sqlstate(db.rpc(agent(A), 'revoke_member_shares', [null, accounts[A], null]))).toBe('42501');
  });

  it('a non-member cannot share into the space', async () => {
    await connectToken(X);
    expect(await sqlstate(share(X, 'S'))).toBe('42501');
  });

  it('refuses a classic token (T1), a missing token, and a second live share in the same space', async () => {
    await expect(share(A)).rejects.toMatchObject({ name: 'ShareRefusal', reason: 'not_connected' });
    await connectToken(A, classic());
    const refused = await share(A).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ShareRefusal);
    expect((refused as ShareRefusal).reason).toBe('token_kind');
    await expect(catalog.share(claims(A), ids.S!, { provider: 'github', label: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'token_kind' } });
    expect((await store.listMyShares(claims(A))).filter((s) => s.status !== 'revoked')).toEqual([]);

    await connectToken(A);
    await share(A);
    await expect(share(A)).rejects.toMatchObject({ details: { sqlstate: '23505', reason: 'already_shared' } });
    // Another space is another share.
    await expect(share(A, 'T')).resolves.toMatchObject({ spaceId: ids.T });
  });
});

describe('D11/D12 as amended — never the default; the sharer edits, an admin only removes', () => {
  it('a share cannot be made the default, and auto resolution never lands on it', async () => {
    await connectToken(A);
    const shared = await share(A);
    expect(await sqlstate(asOwner((c) => c.query('update public.space_credentials set is_default = true where id = $1', [shared.id])))).toBe('23514');
    await expect(store.setDefault(claims(A), shared.id)).rejects.toBeTruthy();
    // No space-owned github credential exists, so auto has no default to read.
    await expect(port.read(claims(B), ids.S!, 'github', null)).resolves.toMatchObject({ ok: false, reason: 'no_default' });
  });

  it('a non-sharer member and the space admin cannot rename it; the sharer can; the admin can remove it', async () => {
    await connectToken(A);
    const shared = await share(A);
    expect(await sqlstate(store.rename(claims(B), shared.id, 'mine now'))).toBe('42501');
    expect(await sqlstate(store.rename(claims(OWN), shared.id, 'admin rename'))).toBe('42501');
    await expect(store.rename(claims(A), shared.id, 'renamed by A')).resolves.toMatchObject({ label: 'renamed by A' });
    expect(await sqlstate(store.revoke(claims(B), shared.id))).toBe('42501');
    await expect(store.revoke(claims(OWN), shared.id)).resolves.toMatchObject({ status: 'revoked', revoked: true });
  });
});

describe('sc8-3 — the launch names a space credential id, and an explicit share fails closed (I1, I3)', () => {
  it('B launches on A’s share by id: the spawn opens A’s own token, and a rotation follows by reference', async () => {
    const token = await connectToken(A);
    const shared = await share(A);
    const read = await store.readForSpawn(claims(B), ids.S!, 'github', shared.id);
    expect(read).toMatchObject({ kind: 'secret', credentialId: shared.id, secret: token });

    const rotated = await connectToken(A);
    await expect(store.readForSpawn(claims(B), ids.S!, 'github', shared.id)).resolves.toMatchObject({ secret: rotated });
  });

  it('T1 at spawn: A rotates to a classic token after sharing — the spawn fails closed with no token bytes', async () => {
    await connectToken(A);
    const shared = await share(A);
    const bad = await connectToken(A, classic());
    const error = await store.readForSpawn(claims(B), ids.S!, 'github', shared.id).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(SHARE_TOKEN_KIND_MESSAGE);
    expect(JSON.stringify(error)).not.toContain(bad);
    expect(String((error as Error).stack)).not.toContain(bad);
    await expect(port.read(claims(B), ids.S!, 'github', shared.id)).resolves.toEqual({ ok: false, reason: 'share_token_kind' });
  });

  it('A disconnects GitHub: the share is revoked and the explicit launch fails closed', async () => {
    await connectToken(A);
    const shared = await share(A);
    await disconnectToken(A);
    expect((await row(shared.id)).status).toBe('revoked');
    await expect(port.read(claims(B), ids.S!, 'github', shared.id)).resolves.toMatchObject({ ok: false });
    await expect(store.readForSpawn(claims(B), ids.S!, 'github', shared.id)).rejects.toBeTruthy();
  });

  it('the share read from another space is refused', async () => {
    await connectToken(A);
    const inT = await share(A, 'T');
    await expect(port.read(claims(A), ids.S!, 'github', inT.id)).resolves.toMatchObject({ ok: false });
  });
});

describe('sc8-4 — no secret in the read models (I5), status from the row (I6)', () => {
  it('no list or share view carries the token', async () => {
    const token = await connectToken(A);
    const shared = await share(A);
    const surfaces = [
      await catalog.list(claims(B), ids.S!),
      await catalog.shares(claims(A)),
      await store.listMyShares(claims(A)),
      shared,
    ];
    for (const surface of surfaces) expect(JSON.stringify(surface)).not.toContain(token);
    await disconnectToken(A);
    // I6: the list reads the row, so a revoked share leaves it at once.
    expect((await row(shared.id)).status).toBe('revoked');
    expect((await catalog.list(claims(B), ids.S!)).credentials.map((c) => c.id)).not.toContain(shared.id);
  });
});

describe('sc8-5 — lifecycle: each revokes, and only sessions on that share are killed', () => {
  it('the owner leaving a space (members row deleted) revokes that space’s share only', async () => {
    await connectToken(A);
    const inS = await share(A, 'S');
    const inT = await share(A, 'T');
    await asOwner((c) => c.query('delete from public.members where entity_id = $1', [ids[`member:T:${A}`]]));
    try {
      expect((await row(inT.id)).status).toBe('revoked');
      expect((await row(inS.id)).status).toBe('active');
    } finally {
      await asOwner((c) => c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)`,
        [ids[`member:T:${A}`], ids.T, A],
      ));
    }
  });

  it('disable revokes every share, and re-enabling does not bring them back', async () => {
    await connectToken(A);
    const inS = await share(A, 'S');
    const inT = await share(A, 'T');
    await db.rpc(nodeAdmin(), 'set_account_disabled', [accounts[A], true]);
    await db.rpc(nodeAdmin(), 'set_account_disabled', [accounts[A], false]);
    expect((await row(inS.id)).status).toBe('revoked');
    expect((await row(inT.id)).status).toBe('revoked');
  });

  it('MF1: deleting the sharer’s account succeeds and leaves the share revoked with no sharer', async () => {
    const doomed = `sc8-doomed-${randomUUID().slice(0, 8)}`;
    await asOwner(async (c) => {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [doomed]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1) returning id::text`, [doomed]);
      accounts[doomed] = rows[0]!.id;
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)`,
        [member, ids.S, doomed]);
    });
    await connectToken(doomed);
    const shared = await share(doomed);
    await asOwner((c) => c.query('delete from public.accounts where id = $1', [accounts[doomed]]));
    expect(await row(shared.id)).toMatchObject({ status: 'revoked', shared_by_account_id: null });
  });

  it('revoke_member_shares: a member cannot revoke another member’s shares; the account itself and a space admin can', async () => {
    await connectToken(A);
    await share(A);
    expect(await sqlstate(store.revokeMemberShares(claims(B), ids.S!, accounts[A]!))).toBe('42501');
    expect(await sqlstate(store.revokeMemberShares(claims(B), null, accounts[A]!))).toBe('42501');
    const byAdmin = await store.revokeMemberShares(claims(OWN), ids.S!, accounts[A]!);
    expect(byAdmin.revokedCredentialIds).toHaveLength(1);
    await share(A, 'S', 'again');
    const bySelf = await store.revokeMemberShares(claims(A), null, accounts[A]!);
    expect(bySelf.revokedCredentialIds).toHaveLength(1);
  });

  it('killSharesOf kills B’s session on A’s share, and not B’s session on a space-owned key', async () => {
    await connectToken(A);
    const shared = await share(A);
    const spaceKey = await store.create(claims(OWN), {
      spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: `k ${randomUUID()}`,
      secret: `sk-ant-api03-${randomUUID().replaceAll('-', '')}`,
    });
    const onShare = await session('S');
    await launchOn(claims(B), onShare, { github: shared.id });
    const onSpace = await session('S');
    await launchOn(claims(B), onSpace, { anthropic: spaceKey.id });

    const terminals = fakeTerminals();
    const containment = new SpaceCredentialMemberContainment({ store, agentSessions: terminals });
    const result = await containment.killSharesOf(claims(A), accounts[A]!, null);
    expect(result.revokedCredentialIds).toEqual([shared.id]);
    expect(terminals.asked).toEqual([onShare]);
    expect(result.terminatedSessionIds).toEqual([onShare]);
    await store.revoke(claims(OWN), spaceKey.id);
  });

  it('a session that ended is not asked; a retry after the trigger revoked still finds the live one', async () => {
    await connectToken(A);
    const shared = await share(A);
    const liveOne = await session('S');
    await launchOn(claims(B), liveOne, { github: shared.id });
    const ended = await session('S');
    await launchOn(claims(B), ended, { github: shared.id });
    await setSessionStatus(ended, 'exited');
    // The disconnect trigger revokes first; the TS kill runs after and still finds it.
    await disconnectToken(A);
    const terminals = fakeTerminals();
    const result = await new SpaceCredentialMemberContainment({ store, agentSessions: terminals })
      .killSharesOf(claims(A), accounts[A]!, null, 'github');
    expect(result.revokedCredentialIds).toEqual([]);
    expect(terminals.asked).toEqual([liveOne]);
  });

  it('disabling A through IdentityService kills B’s session on A’s share (i), not a session B resumed off A’s space key (ii)', async () => {
    await connectToken(A);
    const shared = await share(A);
    const spaceKey = await store.create(claims(OWN), {
      spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: `k ${randomUUID()}`,
      secret: `sk-ant-api03-${randomUUID().replaceAll('-', '')}`,
    });
    const onShare = await session('S');
    await launchOn(claims(B), onShare, { github: shared.id });
    const resumed = await session('S');
    await launchOn(claims(A), resumed, { anthropic: spaceKey.id });
    await setSessionStatus(resumed, 'idle');
    await store.repointSession(claims(B), resumed);
    await setSessionStatus(resumed, 'running');

    const terminals = fakeTerminals();
    const containment = accountDisableContainment(
      new SpaceCredentialMemberContainment({ store, agentSessions: terminals }),
      nodeAdmin,
    );
    const repository = {
      async setAccountDisabled(accountId: string, disabled: boolean) {
        await db.rpc(nodeAdmin(), 'set_account_disabled', [accountId, disabled]);
        return { id: accountId, status: disabled ? 'disabled' : 'active' };
      },
      async revokeAccountSessions() {
        return 0;
      },
    } as unknown as IdentityRepository;
    await new IdentityServiceImpl({ repository, spaceCredentialContainment: containment }).disableAccount(accounts[A]!);

    expect(terminals.asked).toContain(onShare);
    expect(terminals.asked).not.toContain(resumed);
    expect((await row(shared.id)).status).toBe('revoked');
    await store.revoke(claims(OWN), spaceKey.id);
  });

  // The advisor's PR note: these paths do not exist yet, and whichever lands
  // first must kill before the SQL row goes (the triggers only revoke).
  it.todo('a future member-removal op calls killSharesOf(claims, account, space) before deleting the members row');
  it.todo('a future account-delete op calls killSharesOf(claims, account, null) before deleting the account');
});
