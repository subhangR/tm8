/**
 * SC-4 — the space login terminal, against a REAL PostgreSQL with migration
 * 206 applied, through the real `W2CredentialSessionsService`, the real
 * `DbSpaceCredentialStore` and a real filesystem home. Only the PTY host and
 * the vendor CLI are fakes: a test never logs into a vendor.
 *
 * What only this file can prove is ORDER against rows: a terminal is killed
 * before its row is stamped (carry-forward (a)), a start reclaims only what is
 * expired and only for a manager (N1, (b)), the sweep closes an expired login
 * only through `finish_space_credential_login(ws, false)` (A10), and the
 * reported state is the probed row's, never the disk's (I6).
 *
 * Every close is logged into one `events` list — `kill:<ws>` from the PTY host,
 * `finish:<ws>:<ok>` from the store — so an order assertion is one indexOf.
 *
 * Cast, all in space S:  OWN owner · ADM admin · A member · B member.
 * Test names carry the acceptance criterion they evidence.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CollabError } from '@tm8/contract';
import type { PtyHostService } from '@tm8/execution';
import { CredentialSessionLauncher } from '@tm8/execution';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import {
  SpaceLoginHomes,
  spaceLoginConfigDir,
  spaceLoginCredentialDir,
} from '../../src/credentials/space-credential-home.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type {
  CommandRunner,
  CredentialBinaryResolver,
} from '../../src/facade/services/w2/credential-probe.js';
import {
  CREDENTIAL_SESSION_CAP_ENV,
  W2CredentialSessionsService,
  type CredentialPrincipal,
} from '../../src/facade/services/w2/credential-sessions.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'sc4-owner';
const ADM = 'sc4-admin';
const A = 'sc4-a';
const B = 'sc4-b';

/** Every I5 assertion greps for this; it appears only inside credential files. */
const CANARY = 'SC4tokenCanary5e0c7a91';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let homes: SpaceLoginHomes;
let realStore: DbSpaceCredentialStore;
const ids: Record<string, string> = {};

/** The one ordered log every close writes into. */
let events: string[] = [];
/** Terminals the fake PTY host cannot kill. */
const unkillable = new Set<string>();
const live = new Set<string>();
const spawns: { sessionId: string; env: Record<string, string> }[] = [];
let probes = 0;
let probeSaysLoggedIn = true;
const logged: unknown[] = [];

const claims = (identityId: string): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind: 'browser' }) as DbClaims;
const principal = (identityId: string): CredentialPrincipal => ({ claims: claims(identityId), identityId });

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

const pty = {
  spawnIfAbsent(params: { sessionId: string; env: Record<string, string> }): { reused: boolean } {
    spawns.push(params);
    const reused = live.has(params.sessionId);
    live.add(params.sessionId);
    return { reused };
  },
  hasSession: (sessionId: string): boolean => live.has(sessionId),
  kill(sessionId: string): 'killed' | 'not_found' | 'error' {
    events.push(`kill:${sessionId}`);
    if (unkillable.has(sessionId)) return 'error';
    return live.delete(sessionId) ? 'killed' : 'not_found';
  },
} as unknown as PtyHostService;

/** The real store, with every finish logged into `events`. */
const spyStore = {
  startLogin: (...args: Parameters<DbSpaceCredentialStore['startLogin']>) => realStore.startLogin(...args),
  async finishLogin(c: DbClaims, workSessionId: string, ok: boolean, displayLogin?: string | null) {
    events.push(`finish:${workSessionId}:${String(ok)}`);
    return realStore.finishLogin(c, workSessionId, ok, displayLogin ?? null);
  },
  liveSessions: (...args: Parameters<DbSpaceCredentialStore['liveSessions']>) => realStore.liveSessions(...args),
  expirePending: (...args: Parameters<DbSpaceCredentialStore['expirePending']>) => realStore.expirePending(...args),
  recordProbe: (...args: Parameters<DbSpaceCredentialStore['recordProbe']>) => realStore.recordProbe(...args),
};

const BINARY_PRESENT: CredentialBinaryResolver = ({ binary }) => `/test/bin/${binary}`;
const probeRunner: CommandRunner = async () => {
  probes += 1;
  return {
    exitCode: 0,
    stdout: JSON.stringify({ loggedIn: probeSaysLoggedIn, email: 'space-login@example.test' }),
    stderr: '',
  };
};

let clock: number | null = null;
function newService(): W2CredentialSessionsService {
  // A cap high enough that one failed test's open terminal cannot cascade
  // into the next test as `credential session concurrency cap reached`.
  const env = { PATH: '/usr/bin:/bin', HOME: '/home/tm8', [CREDENTIAL_SESSION_CAP_ENV]: '50' };
  return new W2CredentialSessionsService({
    db,
    launcher: new CredentialSessionLauncher({ pty, env }),
    dataDir,
    env,
    binaryResolver: BINARY_PRESENT,
    probeRunner,
    now: () => clock ?? Date.now(),
    spaceStore: spyStore as never,
    spaceHomes: homes,
    logger: { warn: (message: string, fields?: unknown) => { logged.push({ message, fields }); } } as never,
  });
}

async function startSpace(
  service: W2CredentialSessionsService,
  who: string,
  target: { label: string } | { credentialId: string },
  provider: 'anthropic' | 'openai' = 'anthropic',
) {
  return service.start({ spaceId: ids.S!, provider, spaceCredential: target }, principal(who));
}

/** What the vendor CLI writes inside the terminal: into ITS config dir. */
async function logInInsideTerminal(workSessionId: string, provider: 'anthropic' | 'openai' = 'anthropic'): Promise<string> {
  const spawn = spawns.find((s) => s.sessionId === workSessionId)!;
  const configDir = spawn.env[provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']!;
  const token = `${CANARY}-${randomUUID()}`;
  await writeFile(join(configDir, provider === 'anthropic' ? '.credentials.json' : 'auth.json'), JSON.stringify({ token }));
  return token;
}

/** An ACTIVE login credential created by `who`, whose terminal is finished. */
async function activeLoginCredential(service: W2CredentialSessionsService, who: string, provider: 'anthropic' | 'openai' = 'anthropic') {
  const started = await startSpace(service, who, { label: label(`${who} login`) }, provider);
  await logInInsideTerminal(started.workSessionId, provider);
  const finished = await service.finish({ workSessionId: started.workSessionId }, principal(who));
  expect(finished.spaceCredential?.status).toBe('active');
  return started.spaceCredential!;
}

async function row(workSessionId: string) {
  return asOwner(async (c) =>
    (await c.query<{ finished_at: Date | null; expires_at: Date }>(
      'select finished_at, expires_at from public.credential_sessions where work_session_id = $1',
      [workSessionId],
    )).rows[0],
  );
}
async function credentialStatus(id: string): Promise<string | null> {
  return asOwner(async (c) =>
    (await c.query<{ status: string }>('select status from public.space_credentials where id = $1', [id])).rows[0]?.status ?? null,
  );
}
/** Age a terminal past its expires_at, as the database sees it. */
async function expire(workSessionId: string): Promise<void> {
  await asOwner((c) => c.query(`update public.credential_sessions set expires_at = now() - interval '1 minute' where work_session_id = $1`, [workSessionId]));
}
async function expirePendingDeadline(credentialId: string): Promise<void> {
  await asOwner((c) => c.query(`update public.space_credentials set pending_expires_at = now() - interval '1 minute' where id = $1`, [credentialId]));
}
async function refusal(fn: () => Promise<unknown>): Promise<CollabError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CollabError);
    return error as CollabError;
  }
  throw new Error('expected a refusal, the call succeeded');
}
const before = (first: string, second: string): boolean =>
  events.indexOf(first) >= 0 && events.indexOf(second) > events.indexOf(first);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc4-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('space_credential_login');
  database.apply(migrationFiles());
  db = createDb(database.url);
  homes = new SpaceLoginHomes({ dataDir });
  realStore = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2)`,
        [identity, identity === OWN],
      );
    }
    ids.S = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2)`, [ids.S, OWN]);
    for (const [identity, role] of [[OWN, 'owner'], [ADM, 'admin'], [A, 'member'], [B, 'member']] as const) {
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids.S, identity, role],
      );
    }
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir?.includes('tm8-sc4-')) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

beforeEach(() => {
  events = [];
  unkillable.clear();
  probeSaysLoggedIn = true;
  clock = null;
  probes = 0;
});

describe('t4-1 — start and a probed finish; the state is the row’s (I6)', () => {
  it('a new login runs in a staging home, and a probed finish activates the credential and promotes the file', async () => {
    const service = newService();
    const started = await startSpace(service, A, { label: label('A claude') });
    const credential = started.spaceCredential!;
    expect(credential).toMatchObject({ status: 'pending', shape: 'login', provider: 'anthropic', spaceId: ids.S });

    // The terminal logs into a STAGING config dir, never the live one (A6).
    const spawn = spawns.find((s) => s.sessionId === started.workSessionId)!;
    const credentialDir = spaceLoginCredentialDir(dataDir, ids.S!, credential.id);
    expect(spawn.env.CLAUDE_CONFIG_DIR).toBe(join(credentialDir, '.login', started.workSessionId, 'anthropic'));
    expect(service.liveSessionIds()).toContain(started.workSessionId);

    const token = await logInInsideTerminal(started.workSessionId);
    const finished = await service.finish({ workSessionId: started.workSessionId }, principal(A));

    expect(finished).toMatchObject({ stored: true, probe: { connected: true, status: 'active' } });
    expect(finished.spaceCredential).toMatchObject({ id: credential.id, status: 'active', isDefault: true });
    expect((await row(started.workSessionId))!.finished_at).not.toBeNull();
    const liveFile = join(spaceLoginConfigDir(dataDir, { spaceId: ids.S!, credentialId: credential.id, provider: 'anthropic' }), '.credentials.json');
    expect(JSON.parse(await readFile(liveFile, 'utf8'))).toEqual({ token });
    await expect(stat(join(credentialDir, '.login', started.workSessionId))).rejects.toThrow(/ENOENT/);
    expect(service.liveSessionIds()).not.toContain(started.workSessionId);
    // I5: the token lives in the file and nowhere a caller or a log can read.
    expect(JSON.stringify([started, finished, logged])).not.toContain(CANARY);
  });

  it('a probe that says "logged in" with no credential file in THIS terminal’s home connects nothing', async () => {
    const service = newService();
    const started = await startSpace(service, A, { label: label('A no file') });
    const finished = await service.finish({ workSessionId: started.workSessionId }, principal(A));
    expect(probes).toBe(1);
    expect(finished.probe.connected).toBe(false);
    expect(finished.spaceCredential?.status).toBe('pending');
    expect(await credentialStatus(started.spaceCredential!.id)).toBe('pending');
  });

  it('a file on disk is not a connection: a stale row reports stale though the live file is there', async () => {
    const service = newService();
    const started = await startSpace(service, A, { label: label('A stale') });
    await logInInsideTerminal(started.workSessionId);
    await service.finish({ workSessionId: started.workSessionId }, principal(A));
    await realStore.recordProbe(claims(A), started.spaceCredential!.id, false);

    // The terminal is closed; a second finish reads the row.
    const again = await service.finish({ workSessionId: started.workSessionId }, principal(A));
    expect(again.probe).toMatchObject({ connected: false, status: 'stale' });
    expect(again.spaceCredential?.status).toBe('stale');
  });

  it('A3b: a closed space login is reported from its space credential, not from the member’s own credential row', async () => {
    const service = newService();
    // A has an ACTIVE member anthropic credential: read without the
    // `space_credential_id is null` filter, a closed space login reports it.
    await asOwner((c) => c.query(
      `insert into public.account_agent_credentials(account_id, provider, status, login)
       select id, 'anthropic', 'active', 'member-login@example.test' from public.accounts where identity_id = $1
       on conflict do nothing`,
      [A],
    ));
    const started = await startSpace(service, A, { label: label('A a3b') });
    await service.finish({ workSessionId: started.workSessionId }, principal(A)); // no file: stays pending
    const reported = await service.finish({ workSessionId: started.workSessionId }, principal(A));
    expect(reported.spaceCredential?.id).toBe(started.spaceCredential!.id);
    expect(reported.probe.connected).toBe(false);
    expect(reported.probe.login).not.toBe('member-login@example.test');
  });

  it('refuses both a label and a credential id, and a provider no space login exists for', async () => {
    const service = newService();
    const both = await refusal(() =>
      service.start({ spaceId: ids.S!, provider: 'anthropic', spaceCredential: { label: 'x', credentialId: randomUUID() } as never }, principal(A)),
    );
    expect(both.code).toBe('invalid_input');
    const github = await refusal(() =>
      service.start({ spaceId: ids.S!, provider: 'github', spaceCredential: { label: 'x' } }, principal(A)),
    );
    expect(github.code).toBe('invalid_input');
  });

  it('openai: the terminal gets CODEX_HOME in its staging home and the finish promotes auth.json', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A, 'openai');
    const liveFile = join(spaceLoginConfigDir(dataDir, { spaceId: ids.S!, credentialId: credential.id, provider: 'openai' }), 'auth.json');
    expect(JSON.parse(await readFile(liveFile, 'utf8'))).toMatchObject({ token: expect.stringContaining(CANARY) });
  });

  it('a taken label answers conflict with reason label_taken', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const taken = await refusal(() => startSpace(service, B, { label: credential.label }));
    expect(taken.code).toBe('conflict');
    expect(taken.details).toMatchObject({ reason: 'label_taken', label: credential.label });
  });
});

describe('I2 — a space login is opened and closed by humans only', () => {
  it('agent claims are refused at start and at finish; the human’s terminal stays open and unstamped', async () => {
    const service = newService();
    const agent = (identityId: string): CredentialPrincipal => ({
      claims: { ...claims(identityId), authKind: 'agent' } as DbClaims,
      identityId,
    });
    const spawned = spawns.length;
    const started = await refusal(() =>
      service.start({ spaceId: ids.S!, provider: 'anthropic', spaceCredential: { label: label('agent') } }, agent(A)),
    );
    expect(started.code).toBe('forbidden');
    expect(spawns.length).toBe(spawned);

    const open = await startSpace(service, A, { label: label('A human') });
    await logInInsideTerminal(open.workSessionId);
    events = [];
    // Through the registry, and on a restarted node that holds no entry:
    // refused BEFORE the kill, so the human's terminal is still running.
    for (const node of [service, newService()]) {
      const refused = await refusal(() => node.finish({ workSessionId: open.workSessionId }, agent(A)));
      expect(refused.code).toBe('forbidden');
    }
    expect(events).toEqual([]);
    expect(live.has(open.workSessionId)).toBe(true);
    expect((await row(open.workSessionId))!.finished_at).toBeNull();
    expect(await credentialStatus(open.spaceCredential!.id)).toBe('pending');
    await service.finish({ workSessionId: open.workSessionId }, principal(A));
  });
});

describe('M4 — logging in again is the creator’s or a space admin’s', () => {
  it('another member is refused and nothing is spawned; an admin may', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const spawned = spawns.length;
    const refused = await refusal(() => startSpace(service, B, { credentialId: credential.id }));
    expect(refused.code).toBe('forbidden');
    expect(spawns.length).toBe(spawned);

    const relogin = await startSpace(service, ADM, { credentialId: credential.id });
    expect(relogin.spaceCredential?.id).toBe(credential.id);
    await service.finish({ workSessionId: relogin.workSessionId }, principal(ADM));
  });
});

describe('N1 — a start reclaims ONLY an expired terminal, and only for a manager', () => {
  it('LIVE: login_open with its expiry, and the open terminal is neither killed nor stamped — even for an admin', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const open = await startSpace(service, A, { credentialId: credential.id });
    events = [];

    for (const who of [ADM, A]) {
      const refused = await refusal(() => startSpace(service, who, { credentialId: credential.id }));
      expect(refused.code).toBe('conflict');
      expect(refused.details).toMatchObject({ reason: 'login_open', credentialId: credential.id, expiresAt: expect.any(String) });
    }
    expect(events).toEqual([]);
    expect(live.has(open.workSessionId)).toBe(true);
    expect((await row(open.workSessionId))!.finished_at).toBeNull();
    await service.finish({ workSessionId: open.workSessionId }, principal(A));
  });

  it('EXPIRED, held by this node: a manager’s start kills it through the registry BEFORE finish(ws,false), then starts', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const stale = await startSpace(service, A, { credentialId: credential.id });
    await expire(stale.workSessionId);
    events = [];
    probes = 0;

    const fresh = await startSpace(service, ADM, { credentialId: credential.id });
    expect(before(`kill:${stale.workSessionId}`, `finish:${stale.workSessionId}:false`)).toBe(true);
    expect(events).not.toContain(`finish:${stale.workSessionId}:true`);
    expect(probes).toBe(0); // abandoned, never probed
    expect((await row(stale.workSessionId))!.finished_at).not.toBeNull();
    expect(service.liveSessionIds()).not.toContain(stale.workSessionId);
    expect(await credentialStatus(credential.id)).toBe('active');
    expect(fresh.workSessionId).not.toBe(stale.workSessionId);
    await service.finish({ workSessionId: fresh.workSessionId }, principal(ADM));
  });

  it('EXPIRED, after a restart (empty registry): the kill by id still precedes the stamp', async () => {
    const first = newService();
    const credential = await activeLoginCredential(first, A);
    const stale = await startSpace(first, A, { credentialId: credential.id });
    await expire(stale.workSessionId);
    events = [];

    const restarted = newService();
    expect(restarted.liveSessionIds()).toEqual([]);
    const fresh = await startSpace(restarted, OWN, { credentialId: credential.id });
    expect(before(`kill:${stale.workSessionId}`, `finish:${stale.workSessionId}:false`)).toBe(true);
    expect(live.has(stale.workSessionId)).toBe(false);
    expect((await row(stale.workSessionId))!.finished_at).not.toBeNull();
    await restarted.finish({ workSessionId: fresh.workSessionId }, principal(OWN));
  });

  it('EXPIRED, not a manager: refused, and the expired terminal is neither killed nor stamped', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const stale = await startSpace(service, A, { credentialId: credential.id });
    await expire(stale.workSessionId);
    events = [];

    const refused = await refusal(() => startSpace(service, B, { credentialId: credential.id }));
    expect(refused.code).toBe('forbidden');
    expect(events).toEqual([]);
    expect((await row(stale.workSessionId))!.finished_at).toBeNull();
    await service.finish({ workSessionId: stale.workSessionId }, principal(A));
  });

  it('EXPIRED but UNKILLABLE: the row stays unstamped and the start answers login_open (kill-before-stamp)', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const stale = await startSpace(service, A, { credentialId: credential.id });
    await expire(stale.workSessionId);
    unkillable.add(stale.workSessionId);
    events = [];

    const refused = await refusal(() => startSpace(service, ADM, { credentialId: credential.id }));
    expect(refused.details).toMatchObject({ reason: 'login_open' });
    expect(events).toContain(`kill:${stale.workSessionId}`);
    expect(events.filter((e) => e.startsWith(`finish:${stale.workSessionId}`))).toEqual([]);
    expect((await row(stale.workSessionId))!.finished_at).toBeNull();
    expect(service.liveSessionIds()).toContain(stale.workSessionId);
    unkillable.clear();
    await service.finish({ workSessionId: stale.workSessionId }, principal(A));
  });

  it('an expired PENDING login gives its label back to the next start (label reclaim)', async () => {
    const service = newService();
    const name = label('A abandoned');
    const abandoned = await startSpace(service, A, { label: name });
    await expire(abandoned.workSessionId);
    await expirePendingDeadline(abandoned.spaceCredential!.id);
    events = [];

    const again = await startSpace(service, A, { label: name });
    expect(before(`kill:${abandoned.workSessionId}`, `finish:${abandoned.workSessionId}:false`)).toBe(true);
    expect(await credentialStatus(abandoned.spaceCredential!.id)).toBeNull();
    expect(again.spaceCredential!.id).not.toBe(abandoned.spaceCredential!.id);
    await service.finish({ workSessionId: again.workSessionId }, principal(A));
  });
});

describe('A10 — the sweep closes an expired space login, killing first, only through finish(ws,false)', () => {
  it('kills, then stamps it abandoned: no probe, no activation though a login file is staged, and its pending row expires', async () => {
    const service = newService();
    const started = await startSpace(service, A, { label: label('A swept') });
    await logInInsideTerminal(started.workSessionId); // a probe WOULD succeed
    await expire(started.workSessionId);
    await expirePendingDeadline(started.spaceCredential!.id);
    clock = Date.now() + 3_600_000;
    events = [];

    await service.sweepNow();

    expect(before(`kill:${started.workSessionId}`, `finish:${started.workSessionId}:false`)).toBe(true);
    expect(events).not.toContain(`finish:${started.workSessionId}:true`);
    expect(probes).toBe(0);
    expect((await row(started.workSessionId))?.finished_at ?? 'row gone with its credential').not.toBeNull();
    expect(await credentialStatus(started.spaceCredential!.id)).toBeNull();
    expect(service.liveSessionIds()).not.toContain(started.workSessionId);
  });

  it('an unkillable terminal stays unstamped and registered, and the next tick closes it', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const started = await startSpace(service, A, { credentialId: credential.id });
    await expire(started.workSessionId);
    unkillable.add(started.workSessionId);
    clock = Date.now() + 3_600_000;
    events = [];

    await service.sweepNow();
    expect(events.filter((e) => e.startsWith('finish:'))).toEqual([]);
    expect((await row(started.workSessionId))!.finished_at).toBeNull();
    expect(service.liveSessionIds()).toContain(started.workSessionId);

    unkillable.clear();
    await service.sweepNow();
    expect((await row(started.workSessionId))!.finished_at).not.toBeNull();
    expect(events).toContain(`finish:${started.workSessionId}:false`);
    expect(await credentialStatus(credential.id)).toBe('active');
  });

  it('a login whose CLI exited BEFORE its expiry is the success path, and is probed', async () => {
    const service = newService();
    const started = await startSpace(service, A, { label: label('A exited') });
    await logInInsideTerminal(started.workSessionId);
    live.delete(started.workSessionId); // the CLI exits when the login is done

    await service.sweepNow();
    expect(probes).toBe(1);
    expect(events).toContain(`finish:${started.workSessionId}:true`);
    expect(await credentialStatus(started.spaceCredential!.id)).toBe('active');
  });
});

describe('t4-5 / M5 — the member login paths leave a live space login alone', () => {
  it('a member Connect for the same provider does not kill or stamp the member’s own space login', async () => {
    const service = newService();
    const space = await startSpace(service, B, { label: label('B space') });
    const first = await service.start({ spaceId: ids.S!, provider: 'anthropic' }, principal(B));
    const second = await service.start({ spaceId: ids.S!, provider: 'anthropic' }, principal(B));
    // Control: the member's own earlier login WAS superseded.
    expect(events).toContain(`kill:${first.workSessionId}`);
    expect(events).not.toContain(`kill:${space.workSessionId}`);
    expect(live.has(space.workSessionId)).toBe(true);
    expect((await row(space.workSessionId))!.finished_at).toBeNull();
    expect(service.liveSessionIds()).toContain(space.workSessionId);
    await service.finish({ workSessionId: second.workSessionId }, principal(B));
    await service.finish({ workSessionId: space.workSessionId }, principal(B));
  });
});

describe('t4-4 — delete kills the login terminal first, then stamps it, then removes the home', () => {
  it('through the login registry: kill < finish(ws,false) < home removed; the credential is revoked', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const relogin = await startSpace(service, A, { credentialId: credential.id });
    const credentialDir = spaceLoginCredentialDir(dataDir, ids.S!, credential.id);
    await stat(credentialDir);
    events = [];

    const catalog = new SpaceCredentialCatalogService({
      db,
      store: realStore,
      probe: async () => ({ ok: true, displayLogin: null }),
      terminals: new CredentialSessionLauncher({ pty, env: {} }),
      closeLogin: (c, ws) => service.closeSpaceLogin(c, ws),
      removeLoginHome: async (home) => {
        events.push('removeHome');
        await homes.remove(home);
      },
      env: {},
    });
    const result = await catalog.delete(claims(ADM), credential.id);

    expect(result.failures).toEqual([]);
    expect(result.terminatedLoginSessionIds).toEqual([relogin.workSessionId]);
    expect(before(`kill:${relogin.workSessionId}`, `finish:${relogin.workSessionId}:false`)).toBe(true);
    expect(before(`finish:${relogin.workSessionId}:false`, 'removeHome')).toBe(true);
    expect(await credentialStatus(credential.id)).toBe('revoked');
    await expect(stat(credentialDir)).rejects.toThrow(/ENOENT/);
    expect(service.liveSessionIds()).not.toContain(relogin.workSessionId);
  });
});

describe('t4-6 / M6 — a login finished after its credential was deleted refuses and writes no file', () => {
  it('the success is refused, the terminal is stamped as a failure, and no home is re-created', async () => {
    const service = newService();
    const credential = await activeLoginCredential(service, A);
    const relogin = await startSpace(service, A, { credentialId: credential.id });
    await logInInsideTerminal(relogin.workSessionId);
    // Revoked out from under the running terminal (the revoke step alone),
    // and the home removed as delete's last step does.
    await db.rpc(claims(ADM), 'delete_space_credential', [credential.id]);
    await homes.remove({ spaceId: ids.S!, credentialId: credential.id });
    events = [];

    const finished = await service.finish({ workSessionId: relogin.workSessionId }, principal(A));
    expect(finished.stored).toBe(false);
    expect(finished.probe.connected).toBe(false);
    expect(finished.spaceCredential?.status).toBe('revoked');
    expect(events).toContain(`finish:${relogin.workSessionId}:false`);
    expect((await row(relogin.workSessionId))!.finished_at).not.toBeNull();
    await expect(stat(spaceLoginCredentialDir(dataDir, ids.S!, credential.id))).rejects.toThrow(/ENOENT/);
  });
});

describe('kill-before-stamp on the paths with NO registry entry (after a restart)', () => {
  it('a manager’s reclaim of an expired, unkillable terminal it does not hold: no stamp, and login_open', async () => {
    const first = newService();
    const credential = await activeLoginCredential(first, A);
    const stale = await startSpace(first, A, { credentialId: credential.id });
    await expire(stale.workSessionId);
    unkillable.add(stale.workSessionId);
    events = [];

    const restarted = newService();
    expect(await restarted.closeSpaceLogin(claims(ADM), stale.workSessionId)).toBe('kill_failed');
    const refused = await refusal(() => startSpace(restarted, ADM, { credentialId: credential.id }));
    expect(refused.details).toMatchObject({ reason: 'login_open' });
    expect(events).toContain(`kill:${stale.workSessionId}`);
    expect(events.filter((e) => e.startsWith(`finish:${stale.workSessionId}`))).toEqual([]);
    expect((await row(stale.workSessionId))!.finished_at).toBeNull();
    unkillable.clear();
    await first.finish({ workSessionId: stale.workSessionId }, principal(A));
  });

  it('the opener’s finish of an unkillable terminal the node does not hold refuses and stamps nothing', async () => {
    const first = newService();
    const started = await startSpace(first, A, { label: label('A unkillable') });
    unkillable.add(started.workSessionId);
    events = [];

    const refused = await refusal(() => newService().finish({ workSessionId: started.workSessionId }, principal(A)));
    expect(refused.code).toBe('upstream_unavailable');
    expect(events).toEqual([`kill:${started.workSessionId}`]);
    expect((await row(started.workSessionId))!.finished_at).toBeNull();
    unkillable.clear();
    await first.finish({ workSessionId: started.workSessionId }, principal(A));
  });
});

describe('I6 — a connected finish whose promote fails marks the credential stale', () => {
  it('stored:false, connected:false, and the row the answer carries is not active', async () => {
    const credential = await activeLoginCredential(newService(), A);
    const failingHomes = Object.assign(Object.create(homes) as SpaceLoginHomes, {
      promote: async () => {
        throw new Error('disk full');
      },
    });
    const service = new W2CredentialSessionsService({
      db,
      launcher: new CredentialSessionLauncher({ pty, env: {} }),
      dataDir,
      env: { PATH: '/usr/bin:/bin', HOME: '/home/tm8', [CREDENTIAL_SESSION_CAP_ENV]: '50' },
      binaryResolver: BINARY_PRESENT,
      probeRunner,
      spaceStore: spyStore as never,
      spaceHomes: failingHomes,
    });
    const relogin = await startSpace(service, A, { credentialId: credential.id });
    await logInInsideTerminal(relogin.workSessionId);
    events = [];

    const outcome = await service.finish({ workSessionId: relogin.workSessionId }, principal(A));
    // The finish RPC committed `connected`; only the promote failed after it.
    expect(events).toContain(`finish:${relogin.workSessionId}:true`);
    expect(await credentialStatus(credential.id)).toBe('stale');
    expect(outcome).toMatchObject({ stored: false, probe: { connected: false, status: 'stale' } });
    expect(outcome.spaceCredential?.status).toBe('stale');
  });
});
