/**
 * SC-3 — `credentials.space.*` and `node.credentials.*` against a REAL
 * PostgreSQL with migration 206 applied, running as `tm8_app` under each
 * caller's claims. The service is the real `SpaceCredentialCatalogService`
 * over the real `DbSpaceCredentialStore`; only the vendor probe and the PTY
 * host are fakes (a test never calls a vendor, and there is no PTY here).
 *
 * The TypeScript half — delete's call ORDER, the node-admin gate before any
 * query, the probe's own I5 — is `test/w2/space-credential-catalog.test.ts`.
 * This file proves what only rows can: containment across launchers (M6/A6),
 * the member Disconnect leaving space-credential work alone (A5), D6a, D11's
 * rekey rights and D7's next-spawn, the policy writers, and I5 through
 * success responses, a refused probe, a decrypt failure and the logger.
 *
 * Cast, all in space S:
 *   OWN  space owner (and node owner)   ADM  space admin
 *   A    member                         B    member, owns teammate TB
 * Test names carry the acceptance criterion (t3-N) they evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError } from '@tm8/contract';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import type { SpaceCredentialProbe } from '../../src/credentials/space-credential-probe.js';
import {
  DbSpaceCredentialStore,
  type SpaceCredentialHomeKey,
} from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { W2CredentialCatalogService } from '../../src/facade/services/w2/credential-catalog.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'sc3-owner';
const ADM = 'sc3-admin';
const A = 'sc3-a';
const B = 'sc3-b';
/** Has an account on the node; is NOT a member of S. */
const OUT = 'sc3-outsider';

/** Every I5 assertion greps for a string built from THIS stem; it appears nowhere else. */
const CANARY = 'SC3pgCanary7d41e9b2';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let service: SpaceCredentialCatalogService;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};
const logged: unknown[] = [];
const killed: string[] = [];
const removedHomes: SpaceCredentialHomeKey[] = [];
/** What the fake vendor answers next; defaults to accepting. */
let probeVerdict: Awaited<ReturnType<SpaceCredentialProbe>> = { ok: true, displayLogin: null };
const probed: string[] = [];

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
const secretFor = (stem: string): string => `sk-${CANARY}-${stem}-${randomUUID().replaceAll('-', '')}`;

/** A work session in S created by `createdBy` (a member or teammate entity). */
async function session(
  createdBy: string,
  opts: { status?: string; kind?: 'agent' | 'credential'; agentTool?: string } = {},
): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids.S, createdBy]);
    await c.query(
      `insert into public.work_sessions(entity_id, title, status, session_kind, agent_tool) values ($1, 'fixture', $2, $3, $4)`,
      [id, opts.status ?? 'spawning', opts.kind ?? 'agent', opts.agentTool ?? 'claude-code'],
    );
    return id;
  });
}

async function setStatus(sessionId: string, status: string): Promise<void> {
  // A fixture shortcut past R29's single-writer guard, which the transition
  // function itself passes by setting this claim.
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

/**
 * Record, while it is spawning, that `sessionId` launched `provider` on space
 * credential `credentialId` as `who` — then let it run.
 */
async function launchedOn(who: DbClaims, sessionId: string, provider: string, credentialId: string): Promise<void> {
  await db.rpc(who, 'record_session_manifest', [
    sessionId,
    JSON.stringify({ launch: { credentialSources: { [provider]: 'space' }, spaceCredentialIds: { [provider]: credentialId } } }),
  ]);
  await setStatus(sessionId, 'running');
}

async function create(who: string, provider: 'anthropic' | 'openai' | 'github' = 'anthropic', secret = secretFor(who)) {
  const view = await service.create(claims(who), ids.S!, {
    provider,
    shape: provider === 'github' ? 'token' : 'api_key',
    label: label(`${who} key`),
    secret,
  });
  return { view, secret };
}

/** A login credential A made, active, with its terminal finished. */
async function loginCredential(who: string, provider: 'anthropic' | 'openai' = 'anthropic'): Promise<string> {
  const login = await store.startLogin(claims(who), { spaceId: ids.S!, provider, label: label(`${who} login`), sessionCap: 100 });
  await store.finishLogin(claims(who), login.workSessionId, true);
  return login.credential.id;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc3-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('space_credential_operations');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({
    db,
    dataDir,
    logger: { warn: (message, fields) => { logged.push({ level: 'warn', message, fields }); } },
  });
  const probe: SpaceCredentialProbe = async ({ secret }) => {
    probed.push(secret);
    return probeVerdict;
  };
  service = new SpaceCredentialCatalogService({
    db,
    store,
    probe,
    terminals: {
      terminate: (id) => { killed.push(id); return 'killed'; },
      hasLiveTerminal: () => true,
    },
    removeLoginHome: async (home) => { removedHomes.push(home); },
    env: {},
  });
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
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2)`, [ids.S, OWN]);
    for (const [identity, role] of [[OWN, 'owner'], [ADM, 'admin'], [A, 'member'], [B, 'member']] as const) {
      const member = ids[`member:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids.S, identity, role],
      );
    }
    // TB: a teammate entity OWNED by B. A session A's agent spawns for it is
    // created by TB — neither A nor B — and must still be contained.
    ids.TB = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $3)`, [
      ids.TB, ids.S, ids[`member:${B}`],
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

describe('t3-4/t3-8: delete contains every launcher, and only on the deleted credential', () => {
  it('kills an agent-spawned session, another launcher\'s session and another member\'s login terminal on X; Y\'s session lives', async () => {
    // X: a LOGIN credential A made, so it has a file home and can carry a terminal.
    const x = await loginCredential(A);
    // Y: another anthropic credential in the same space.
    const { view: y } = await create(B);

    // On X: a session A's AGENT spawned for B's teammate (agent claims, created by TB) …
    const agentSpawned = await session(ids.TB!);
    await launchedOn(agent(A), agentSpawned, 'anthropic', x);
    // … a session B launched himself …
    const byB = await session(ids[`member:${B}`]!);
    await launchedOn(claims(B), byB, 'anthropic', x);
    // … and the space admin's live re-login terminal onto X (M6: not the deleter's).
    const admTerminal = await store.startLogin(claims(ADM), { spaceId: ids.S!, provider: 'anthropic', credentialId: x, sessionCap: 100 });
    // On Y: a session that must survive.
    const onY = await session(ids[`member:${B}`]!);
    await launchedOn(claims(B), onY, 'anthropic', y.id);
    // On X but already finished: not live, not killed.
    const finished = await session(ids[`member:${A}`]!);
    await launchedOn(claims(A), finished, 'anthropic', x);
    await setStatus(finished, 'exited');

    // Control: before the delete, the definer lookup sees both launchers and the terminal.
    const before = await store.liveSessions(claims(A), x);
    expect(new Set(before.sessions.map((s) => s.launcherAccountId))).toEqual(new Set([accounts[A], accounts[B]]));
    expect(before.loginTerminals.map((t) => t.accountId)).toEqual([accounts[ADM]]);

    killed.length = 0;
    removedHomes.length = 0;
    // A, the creator — neither the admin who holds the terminal nor B.
    const result = await service.delete(claims(A), x);

    expect(result.revoked).toBe(true);
    expect(result.failures).toEqual([]);
    expect(new Set(result.terminatedAgentSessionIds)).toEqual(new Set([agentSpawned, byB]));
    expect(result.terminatedLoginSessionIds).toEqual([admTerminal.workSessionId]);
    expect(new Set(killed)).toEqual(new Set([agentSpawned, byB, admTerminal.workSessionId]));
    expect(killed).not.toContain(onY);
    expect(killed).not.toContain(finished);
    expect(removedHomes).toEqual([{ spaceId: ids.S, credentialId: x, provider: 'anthropic' }]);

    // The terminal is stamped finished; the credential row does not come back.
    const after = await store.liveSessions(claims(ADM), x);
    expect(after.loginTerminals).toEqual([]);
    const [row] = await asOwner(async (c) => (await c.query<{ status: string }>(
      'select status from public.space_credentials where id = $1', [x])).rows);
    expect(row!.status).toBe('revoked');
    // Y is untouched: still active, its session still listed live.
    const onYLive = await store.liveSessions(claims(B), y.id);
    expect(onYLive.sessions.map((s) => s.workSessionId)).toEqual([onY]);
  });

  it('a member who is neither the creator nor an admin cannot delete, and nothing is killed', async () => {
    const { view } = await create(A, 'openai');
    const s = await session(ids[`member:${A}`]!);
    await launchedOn(claims(A), s, 'openai', view.id);
    killed.length = 0;
    await expect(service.delete(claims(B), view.id)).rejects.toThrow(/creator or a space admin/);
    expect(killed).toEqual([]);
    // Control: an admin can.
    await expect(service.delete(claims(ADM), view.id)).resolves.toMatchObject({ revoked: true, terminatedAgentSessionIds: [s] });
  });

  it('D6a: deleting the default leaves NO default — the next credential is not promoted', async () => {
    const first = await create(A, 'github');
    const second = await create(B, 'github');
    expect(first.view.isDefault).toBe(true);
    expect(second.view.isDefault).toBe(false);
    await service.delete(claims(A), first.view.id);
    const listed = await service.list(claims(A), ids.S!);
    const github = listed.credentials.filter((c) => c.provider === 'github');
    expect(github.map((c) => c.id)).toContain(second.view.id);
    expect(github.some((c) => c.isDefault)).toBe(false);
  });
});

describe('t3-9: the member Disconnect leaves space-credential work alone (A5)', () => {
  it('kills A\'s own member session and member login; spares A\'s space-credential session and space login terminal', async () => {
    const { view: x } = await create(ADM);
    // A launched this on the SPACE credential — it never held A's own key.
    const onSpace = await session(ids[`member:${A}`]!);
    await launchedOn(claims(A), onSpace, 'anthropic', x.id);
    // A's space login terminal onto a new pending anthropic credential.
    const spaceLogin = await store.startLogin(claims(A), { spaceId: ids.S!, provider: 'anthropic', label: label('a space login'), sessionCap: 100 });
    // Controls — what the Disconnect IS for: a member session and a member login.
    const memberSession = await session(ids[`member:${A}`]!, { status: 'running' });
    const memberLogin = await asOwner(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids.S, ids[`member:${A}`]]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind) values ($1, 'login', 'running', 'credential')`, [id]);
      await c.query(
        `insert into public.credential_sessions(work_session_id, account_id, provider, expires_at) values ($1, $2, 'anthropic', now() + interval '15 minutes')`,
        [id, accounts[A]],
      );
      return id;
    });

    const disconnect = new W2CredentialCatalogService({
      db,
      terminals: {
        terminate: (id) => { killed.push(id); return 'killed'; },
        hasLiveTerminal: () => true,
      },
      dataDir,
      removeCredentialFiles: async () => undefined,
    });
    killed.length = 0;
    const result = await disconnect.delete('anthropic', { identityId: A, claims: claims(A) });

    expect(result.terminatedAgentSessionIds).toContain(memberSession);
    expect(result.terminatedCredentialSessionIds).toContain(memberLogin);
    expect(killed).toEqual(expect.arrayContaining([memberSession, memberLogin]));
    expect(killed).not.toContain(onSpace);
    expect(killed).not.toContain(spaceLogin.workSessionId);
    expect(result.terminatedAgentSessionIds).not.toContain(onSpace);
    expect(result.terminatedCredentialSessionIds).not.toContain(spaceLogin.workSessionId);
    // The space login terminal is still open, and the space credential still active.
    expect((await store.liveSessions(claims(A), spaceLogin.credential.id)).loginTerminals.map((t) => t.workSessionId))
      .toEqual([spaceLogin.workSessionId]);
    expect((await store.liveSessions(claims(ADM), x.id)).sessions.map((s) => s.workSessionId)).toEqual([onSpace]);
  });
});

describe('t3-7: rekey — creator and admins only; the next spawn reads the new key (D7)', () => {
  it('B is refused; A (creator) and ADM rekey; readForSpawn returns each new key in turn', async () => {
    const { view, secret: original } = await create(A, 'openai');
    const pinned = (who: DbClaims) => store.readForSpawn(who, ids.S!, 'openai', view.id);
    expect(await pinned(agent(B))).toMatchObject({ kind: 'secret', secret: original });

    await expect(service.rekey(claims(B), view.id, secretFor('b-rekey'))).rejects.toThrow(/creator or a space admin/);
    expect(await pinned(agent(B))).toMatchObject({ secret: original });

    const byCreator = secretFor('a-rekey');
    const rekeyed = await service.rekey(claims(A), view.id, byCreator);
    expect(rekeyed.keyHint).toBe(byCreator.slice(-4));
    expect(await pinned(agent(B))).toMatchObject({ secret: byCreator });

    const byAdmin = secretFor('adm-rekey');
    await service.rekey(claims(ADM), view.id, byAdmin);
    expect(await pinned(agent(A))).toMatchObject({ secret: byAdmin });
  });

  it('refusals come BEFORE the vendor probe: non-manager rekey, non-member create, agent bearer — 0 probe calls', async () => {
    const { view, secret: original } = await create(A, 'openai');
    probed.length = 0;
    // B is a member of S, but neither the creator nor an admin.
    await expect(service.rekey(claims(B), view.id, secretFor('b-oracle')))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/creator or a space admin/) });
    // OUT is not in S at all: the RLS select answers nothing.
    await expect(service.rekey(claims(OUT), view.id, secretFor('out-oracle'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.create(claims(OUT), ids.S!, {
      provider: 'anthropic', shape: 'api_key', label: label('outsider'), secret: secretFor('out-create'),
    })).rejects.toMatchObject({ code: 'forbidden' });
    // An agent bearer carrying the CREATOR's identity.
    await expect(service.rekey(agent(A), view.id, secretFor('agent-oracle'))).rejects.toThrow(/human-only/);
    await expect(service.create(agent(A), ids.S!, {
      provider: 'anthropic', shape: 'api_key', label: label('agent'), secret: secretFor('agent-create'),
    })).rejects.toThrow(/human-only/);
    expect(probed).toEqual([]);
    expect(await store.readForSpawn(agent(A), ids.S!, 'openai', view.id)).toMatchObject({ secret: original });

    // CONTROL: the admin's rekey and a member's create DO reach the probe.
    const byAdmin = secretFor('adm-control');
    await service.rekey(claims(ADM), view.id, byAdmin);
    const { secret: byMember } = await create(B, 'openai');
    expect(probed).toEqual([byAdmin, byMember]);
  });

  it('a key the vendor refuses leaves the old one in place, and is never probed-then-stored', async () => {
    const { view, secret: original } = await create(A, 'openai');
    probeVerdict = { ok: false, reason: 'rejected', detail: 'HTTP 401' };
    try {
      await expect(service.rekey(claims(A), view.id, secretFor('refused'))).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      probeVerdict = { ok: true, displayLogin: null };
    }
    expect(await store.readForSpawn(agent(A), ids.S!, 'openai', view.id)).toMatchObject({ secret: original });
  });
});

describe('t3-3: a refused key is never stored; status is the probe\'s', () => {
  it('rejected and unreachable both leave no row; accepted is active', async () => {
    const count = async () => (await asOwner(async (c) => (await c.query<{ n: number }>(
      `select count(*)::int n from public.space_credentials where space_id = $1 and provider = 'github'`, [ids.S])).rows))[0]!.n;
    const before = await count();
    for (const verdict of [
      { ok: false, reason: 'rejected', detail: 'HTTP 401' },
      { ok: false, reason: 'unreachable', detail: 'HTTP 503' },
    ] as const) {
      probeVerdict = verdict;
      try {
        await expect(create(A, 'github')).rejects.toBeInstanceOf(CollabError);
      } finally {
        probeVerdict = { ok: true, displayLogin: null };
      }
    }
    expect(await count()).toBe(before);
    probeVerdict = { ok: true, displayLogin: 'octo-sc3' };
    try {
      const { view } = await create(A, 'github');
      expect(view).toMatchObject({ status: 'active', displayLogin: 'octo-sc3' });
    } finally {
      probeVerdict = { ok: true, displayLogin: null };
    }
    expect(await count()).toBe(before + 1);
  });
});

describe('t3-5: policy writers', () => {
  it('space policy: a member is refused, an admin sets it, policy.get reads it back', async () => {
    await expect(service.setPolicy(claims(A), ids.S!, 'openai', ['space'])).rejects.toThrow(/admin/);
    await expect(service.setPolicy(claims(ADM), ids.S!, 'openai', ['space', 'member']))
      .resolves.toEqual({ spaceId: ids.S, provider: 'openai', allowedSources: ['space', 'member'] });
    const view = await service.policy(claims(A), ids.S!);
    expect(view.providers.find((p) => p.provider === 'openai')?.allowedSources).toEqual(['space', 'member']);
    await service.setPolicy(claims(OWN), ids.S!, 'openai', null);
  });

  it('node policy: a space admin who is not a node admin is refused; the node owner sets it', async () => {
    await expect(service.setNodePolicy(claims(ADM), 'github', false)).rejects.toThrow(/node admin required/);
    await expect(service.setNodePolicy(claims(OWN), 'github', false)).resolves.toEqual({ provider: 'github', allowNode: false });
    expect((await service.nodeStatus(claims(OWN))).providers.find((p) => p.provider === 'github'))
      .toMatchObject({ allowNode: false, envKeyPresent: false });
    await service.setNodePolicy(claims(OWN), 'github', null);
  });

  it('t3-1: an agent bearer is refused by SQL on every write, even for an admin', async () => {
    const { view } = await create(A, 'openai');
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['rekey', () => service.rekey(agent(A), view.id, secretFor('agent'))],
      ['rename', () => service.rename(agent(A), view.id, label('agent'))],
      ['setDefault', () => service.setDefault(agent(A), view.id)],
      ['delete', () => service.delete(agent(A), view.id)],
      ['setPolicy', () => service.setPolicy(agent(OWN), ids.S!, 'openai', ['space'])],
      ['setNodePolicy', () => service.setNodePolicy(agent(OWN), 'openai', true)],
    ];
    for (const [name, call] of refusals) {
      await expect(call(), name).rejects.toThrow(/human-only/);
    }
  });
});

describe('t3-2/t3-10: no response, error or log line quotes a secret (I5, A8)', () => {
  it('success responses: create, list, rekey, rename, setDefault, delete', async () => {
    const secret = secretFor('success');
    const { view } = await create(A, 'openai', secret);
    const next = secretFor('success-rekey');
    const responses = [
      view,
      await service.list(claims(A), ids.S!),
      await service.rekey(claims(A), view.id, next),
      await service.rename(claims(A), view.id, label('renamed')),
      await service.setDefault(claims(A), view.id),
      await service.delete(claims(A), view.id),
    ];
    const text = JSON.stringify(responses);
    expect(JSON.stringify({ control: secret })).toContain(CANARY); // the grep can find it
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(next);
    // The metadata fields are there: a hint of four characters, not the key.
    expect(view.keyHint).toBe(secret.slice(-4));
  });

  it('a refused and an unreachable vendor probe: the error carries no secret', async () => {
    for (const verdict of [
      { ok: false, reason: 'rejected', detail: 'HTTP 401' },
      { ok: false, reason: 'unreachable', detail: 'TypeError' },
    ] as const) {
      probeVerdict = verdict;
      let caught: unknown;
      try {
        await create(A, 'anthropic');
      } catch (error) {
        caught = error;
      } finally {
        probeVerdict = { ok: true, displayLogin: null };
      }
      expect(caught).toBeInstanceOf(CollabError);
      const error = caught as CollabError;
      expect(`${error.message} ${JSON.stringify(error)} ${JSON.stringify(error.details ?? null)} ${error.stack ?? ''}`)
        .not.toContain(CANARY);
    }
  });

  it('a decrypt failure: the error and the captured logger output carry no secret (control: it logged)', async () => {
    const { view, secret } = await create(B, 'openai');
    // Flip one ciphertext byte: the AEAD tag no longer verifies.
    await asOwner((c) => c.query(
      `update public.space_credentials
          set secret_ciphertext = set_byte(secret_ciphertext, 0, (get_byte(secret_ciphertext, 0) + 1) % 256)
        where id = $1`,
      [view.id],
    ));
    logged.length = 0;
    let caught: unknown;
    try {
      await store.readForSpawn(agent(B), ids.S!, 'openai', view.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('stored space credential is unreadable');
    expect(logged).toHaveLength(1); // control: the logger did capture the failure
    const text = `${JSON.stringify(logged)} ${(caught as Error).stack ?? ''}`;
    expect(text).toContain(view.id);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(-8));
  });

  it('every captured logger line across this file is secret-free', () => {
    expect(JSON.stringify(logged)).not.toContain(CANARY);
    // The probe did see the canaries — the grep above had something to miss.
    expect(probed.some((s) => s.includes(CANARY))).toBe(true);
  });
});
