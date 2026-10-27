/** Share-to uses the real handler, sealed stores and PG gates; only the vendor is fake. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SpaceCredentialView } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { DbGitHubCredentialStore } from '../../src/credentials/github-credential-store.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { registerCredentialHandlers } from '../../src/facade/handlers/w2/credentials.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });
const A = 'add-mine-owner';
const B = 'add-mine-peer';
const OUT = 'add-mine-outsider';
const TOKEN = 'github-pat-add-mine-fake-canary';
const spaceId = randomUUID();
const claims = (identityId = A): DbClaims => ({ identityId, nodeAdmin: false, authKind: 'browser', requestId: randomUUID() });
let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let github: DbGitHubCredentialStore;
let space: DbSpaceCredentialStore;
let existingId: string;
const accounts: Record<string, string> = {};
const probe = vi.fn(async () => ({ ok: true as const, displayLogin: 'fake-github-user' }));
let registry: HandlerRegistry;

async function add(provider: string, identityId = A, authKind = 'browser', extra: object = {}) {
  const ctx = {
    opName: 'credentials.space.addMine', params: { spaceId },
    body: { provider, label: `Added ${randomUUID()}`, ...extra },
    query: new URLSearchParams(), headers: {}, requestId: randomUUID(), method: 'POST', path: '/test',
    identity: { kind: 'bearer', identityId, authKind },
  } as RequestContext;
  return registry.get('credentials.space.addMine')!(ctx) as Promise<SpaceCredentialView>;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-add-mine-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('add_mine');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    for (const who of [A, B, OUT]) {
      await c.query('insert into public.user_profiles(identity_id, display_name) values ($1, $1)', [who]);
      const account = await c.query<{ id: string }>('insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1) returning id', [who]);
      accounts[who] = account.rows[0]!.id;
    }
    await c.query("insert into public.spaces(id, name, created_by_identity) values ($1, 'Add mine', $2)", [spaceId, A]);
    for (const who of [A, B]) {
      const memberId = randomUUID();
      await c.query("insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)", [memberId, spaceId]);
      await c.query("insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)", [memberId, spaceId, who]);
    }
  });
  github = new DbGitHubCredentialStore({ db, dataDir });
  space = new DbSpaceCredentialStore({ db, dataDir });
  await github.store(claims(), { login: 'fake-github-user', token: TOKEN });
  await github.store(claims(OUT), { login: 'outsider', token: 'outsider-fake-token' });
  const existing = await space.create(claims(), { spaceId, provider: 'github', shape: 'token', label: 'Existing', secret: 'existing-space-token', visibility: 'public', mayBeSpaceDefault: true });
  existingId = existing.id;
  await space.setDefault(claims(), existingId);
  await space.setMyDefault(claims(), existingId);
  registry = new HandlerRegistry();
  registerCredentialHandlers(registry, {
    db, config: { host: '127.0.0.1', port: 0, maxBodyBytes: 1024 },
    owner: async () => ({ identityId: A, accountId: accounts[A], username: A, isNodeAdmin: false, isOwner: false }),
  } as FacadeDeps, {
    dataDir, launcher: { terminate: () => 'killed', hasLiveTerminal: () => false } as never,
    agentSessions: { containCredentialSession: vi.fn() } as never, probeSpaceCredential: probe,
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('Share to: additive personal credential copy', () => {
  it('reseals the caller GitHub token as a separate private credential without altering the source or defaults', async () => {
    const source = await db.rpc(claims(), 'read_account_git_credential', ['github']);
    const existing = await space.list(claims(), spaceId);
    const beforeDefaults = await database.query('select * from public.member_defaults where space_id = $1', [spaceId]);
    const added = await add('github');
    expect(added).toMatchObject({ spaceId, provider: 'github', shape: 'token', visibility: 'private', ownerAccountId: accounts[A], isDefault: false, mayBeSpaceDefault: false });
    expect(added.id).not.toBe(existingId);
    expect(probe).toHaveBeenCalledWith({ provider: 'github', secret: TOKEN });
    expect(JSON.stringify(added)).not.toContain(TOKEN);
    expect(await space.readForSpawn(claims(), spaceId, 'github', added.id)).toMatchObject({
      kind: 'secret', credentialId: added.id, secret: TOKEN,
    });
    expect(await github.resolve(claims())).toMatchObject({ token: TOKEN });
    expect(await db.rpc(claims(), 'read_account_git_credential', ['github'])).toEqual(source);
    expect((await space.list(claims(), spaceId)).filter((row) => row.id === existingId)).toEqual(existing);
    expect(await database.query('select * from public.member_defaults where space_id = $1', [spaceId])).toEqual(beforeDefaults);
    const peerView = (await space.list(claims(B), spaceId)).find((row) => row.id === added.id);
    expect(peerView).toMatchObject({ keyHint: null, displayLogin: null });
    await db.rpc(claims(), 'share_space_credential', [added.id, accounts[B]]);
    await db.rpc(claims(), 'unshare_space_credential', [added.id, accounts[B]]);
    expect(await db.rpc(claims(), 'read_account_git_credential', ['github'])).toEqual(source);
    expect(await database.query('select * from public.member_defaults where space_id = $1', [spaceId])).toEqual(beforeDefaults);
  });

  it('refuses a missing personal credential instead of using another account or node token', async () => {
    const prior = probe.mock.calls.length;
    await expect(add('github', B)).rejects.toMatchObject({ code: 'not_found', details: { reason: 'no_personal_credential' } });
    expect(probe.mock.calls).toHaveLength(prior);
  });

  it('refuses nonmembers before the vendor probe', async () => {
    const prior = probe.mock.calls.length;
    await expect(add('github', OUT)).rejects.toMatchObject({ code: 'forbidden' });
    expect(probe.mock.calls).toHaveLength(prior);
  });

  it.each(['agent', 'agent_runtime', 'link'])('refuses %s sessions', async (kind) => {
    await expect(add('github', A, kind)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each(['anthropic', 'openai'])('%s requires a fresh space login; addMine cannot copy its OAuth home', async (provider) => {
    const prior = probe.mock.calls.length;
    await expect(add(provider)).rejects.toThrow();
    expect(probe.mock.calls).toHaveLength(prior);
  });

  it('never accepts an account selector or secret from the client', async () => {
    await expect(add('github', A, 'browser', { accountId: accounts[B] })).rejects.toThrow();
    await expect(add('github', A, 'browser', { secret: 'untrusted-secret' })).rejects.toThrow();
  });
});
