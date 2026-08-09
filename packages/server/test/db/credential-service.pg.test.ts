/**
 * PR2 — the credential home, the launcher, the probes and the session service,
 * proved against a REAL PostgreSQL through the REAL `Db`.
 *
 * WHY THE REAL `Db` AND NOT A HAND-BOUND HARNESS. PR1's suite proved 082's RPC
 * gate by binding `tm8.auth_kind` itself, with its own `set_config`. That is
 * the right test for a migration and it says NOTHING about the server: until
 * this lane, `BIND_CLAIMS_SQL` bound four claims and `internal.require_human_
 * auth_kind()` — which fails closed — refused every caller that arrived through
 * `PgDb`. A green built on a claim the product does not set is the exact
 * false-green this feature's history keeps producing. So every assertion below
 * goes through `createDb(...)` with no hand-binding anywhere, and the claim
 * arrives the way a request's would: from `DbClaims.authKind`.
 *
 * WHY IT CANNOT BE A FakeDb TEST. Everything under test is a Postgres feature:
 * RLS, a partial unique index, a plpgsql `raise ... using errcode`, a
 * `security definer` body. A FakeDb test here would assert the behaviour of a
 * JavaScript object that has none of them, and it would be green and worth
 * nothing.
 *
 * THE TWO-PRINCIPAL RULE. Isolation is proved with Alice and Bob, two distinct
 * identities with two distinct accounts. One principal cannot distinguish "the
 * policy works" from "there was only ever one row".
 */
import { mkdtemp, mkdir, chmod, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError } from '@tm8/contract';

import type { PtyHostService } from '@tm8/execution';
import { CredentialSessionLauncher, CREDENTIAL_LOGIN_COMMANDS } from '@tm8/execution';

import { createDb } from '../../src/db/client.js';
import { sqlStateToCode } from '../../src/db/errors.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import {
  credentialConfigDir,
  credentialHomeDir,
  ensureCredentialHome,
} from '../../src/credentials/agent-credential-home.js';
import {
  assertNoGitHubTokenEnv,
  runCredentialProbe,
  type CommandOutcome,
  type CommandRunner,
} from '../../src/facade/services/w2/credential-probe.js';
import {
  resolveCredentialSessionCap,
  W2CredentialSessionsService,
} from '../../src/facade/services/w2/credential-sessions.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// Real Postgres + a real pool: the default 5s test timeout is not survivable
// under load, and a hook that drops a database does not fit in 10s.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

interface Fixture {
  aliceIdentity: string;
  bobIdentity: string;
  space: string;
  aliceMember: string;
  bobMember: string;
  teamMember: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;
let dataDir: string;

/** The claim envelope a BROWSER request produces once R11's binding is in. */
function humanClaims(identityId: string): DbClaims {
  return { identityId, nodeAdmin: false, requestId: 'req-pr2', authKind: 'browser' };
}

/**
 * The code a CALLER actually sees, and the SQLSTATE that produced it.
 *
 * `PgDb` translates every driver error through `translateDbError`, so an
 * assertion on a raw SQLSTATE here would be testing a layer the product does
 * not expose — and would fail even when the refusal is perfectly correct. But
 * asserting only the contract code loses which database rule fired: `forbidden`
 * is reachable from several SQLSTATEs. So each refusal below pins BOTH ends of
 * the chain — the SQLSTATE the RPC raised, via the translation table, and the
 * code the client receives. A change at either end fails.
 */
function refusalCode(error: unknown): string {
  if (error instanceof CollabError) return error.code;
  const direct = (error as { code?: string }).code;
  if (typeof direct === 'string') return direct;
  return `not-a-CollabError: ${String(error)}`;
}

/** Assert a refusal by the SQLSTATE that caused it, through the real mapping. */
function expectRefusedBySqlstate(error: unknown, expectedSqlstate: string): void {
  const expectedCode = sqlStateToCode(expectedSqlstate);
  // Guards the guard: a typo'd SQLSTATE would map to undefined and the
  // assertion below would compare undefined to undefined and pass.
  expect(expectedCode, `SQLSTATE ${expectedSqlstate} is not in the translation table`).toBeDefined();
  expect(refusalCode(error)).toBe(expectedCode);
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, the statement succeeded');
}

// ---------------------------------------------------------------------------
// A PTY host stand-in. It records spawns and models liveness, which is all the
// service ever asks of it.
// ---------------------------------------------------------------------------
interface FakePty {
  pty: PtyHostService;
  spawns: { sessionId: string; command: string; cwd: string; env: Record<string, string> }[];
  kills: string[];
  live: Set<string>;
}

function fakePty(): FakePty {
  const spawns: FakePty['spawns'] = [];
  const kills: string[] = [];
  const live = new Set<string>();
  const pty = {
    spawnIfAbsent(params: {
      sessionId: string;
      command: string;
      cwd: string;
      env: Record<string, string>;
    }): { reused: boolean } {
      const reused = live.has(params.sessionId);
      spawns.push(params);
      live.add(params.sessionId);
      return { reused };
    },
    hasSession(sessionId: string): boolean {
      return live.has(sessionId);
    },
    kill(sessionId: string): 'killed' | 'not_found' {
      kills.push(sessionId);
      if (!live.delete(sessionId)) return 'not_found';
      return 'killed';
    },
  } as unknown as PtyHostService;
  return { pty, spawns, kills, live };
}

function outcome(partial: Partial<CommandOutcome>): CommandOutcome {
  return { exitCode: 0, stdout: '', stderr: '', ...partial };
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<Fixture>(
        `select 'pr2-alice'::text "aliceIdentity", 'pr2-bob'::text "bobIdentity",
                internal.new_id()::text "space",
                internal.new_id()::text "aliceMember", internal.new_id()::text "bobMember",
                internal.new_id()::text "teamMember"`,
      )
    ).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Alice'), ($2, 'Bob')`,
      [ids.aliceIdentity, ids.bobIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'pr2-alice', 'Alice', false, true),
              ($2, 'pr2-bob', 'Bob', false, false)`,
      [ids.aliceIdentity, ids.bobIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'PR2', $2)`,
      [ids.space, ids.aliceIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($2, $1, 'member', 0, $2), ($3, $1, 'member', 1, $3), ($4, $1, 'team_member', 2, $2)`,
      [ids.space, ids.aliceMember, ids.bobMember, ids.teamMember],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($2, $1, $4, 'owner', 'Alice'), ($3, $1, $5, 'member', 'Bob')`,
      [ids.space, ids.aliceMember, ids.bobMember, ids.aliceIdentity, ids.bobIdentity],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name)
       values ($1, $2, 'Worker')`,
      [ids.teamMember, ids.aliceMember],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('pr2_cred');
  database.apply(migrationFiles());
  fixture = await seed();
  db = createDb(database.url, { max: 6 });
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-pr2-'));
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir?.includes('tm8-pr2-')) await rm(dataDir, { recursive: true, force: true });
});

// ===========================================================================
// R11 — the fifth claim, through the real Db, with NO hand-binding
// ===========================================================================

describe('R11 — tm8.auth_kind is bound by the server, not by a test harness', () => {
  it('binds the fifth GUC inside the transaction', async () => {
    const [row] = await db.query<{ kind: string }>(
      humanClaims(fixture.aliceIdentity),
      `select current_setting('tm8.auth_kind', true) as kind`,
    );
    // Before this lane, BIND_CLAIMS_SQL bound four claims and this read NULL —
    // which is exactly what makes require_human_auth_kind refuse everyone.
    expect(row!.kind).toBe('browser');
  });

  it('lets a BROWSER principal start a credential session', async () => {
    const started = await db.rpc<{ workSessionId: string; provider: string }>(
      humanClaims(fixture.aliceIdentity),
      'start_credential_session',
      [fixture.space, 'anthropic', 900, 2],
    );
    expect(started.provider).toBe('anthropic');
    await db.rpc(humanClaims(fixture.aliceIdentity), 'finish_credential_session', [
      started.workSessionId,
    ]);
  });

  it('refuses an AGENT principal with 42501, even though it carries its owner’s identity', async () => {
    // The measured reason this matters (sub-doc 14, C7): an agent's bearer
    // credential binds the SPAWNING HUMAN's account, so identity_id(),
    // can_act_as and is_space_member all answer as Alice. `kind` is the only
    // thing that tells them apart — and here it is Alice's own identity.
    const error = await captureError(() =>
      db.rpc(
        { ...humanClaims(fixture.aliceIdentity), authKind: 'agent' },
        'start_credential_session',
        [fixture.space, 'openai', 900, 2],
      ),
    );
    expectRefusedBySqlstate(error, '42501');
    expect(refusalCode(error)).toBe('forbidden');
  });

  it('refuses a principal with NO kind — fail closed, no is-null escape', async () => {
    const { authKind: _dropped, ...noKind } = humanClaims(fixture.aliceIdentity);
    const error = await captureError(() =>
      db.rpc(noKind, 'start_credential_session', [fixture.space, 'openai', 900, 2]),
    );
    expectRefusedBySqlstate(error, '42501');
  });

  it('refuses an UNRECOGNISED kind rather than treating unknown as human', async () => {
    const error = await captureError(() =>
      db.rpc(
        { ...humanClaims(fixture.aliceIdentity), authKind: 'service' },
        'start_credential_session',
        [fixture.space, 'openai', 900, 2],
      ),
    );
    expectRefusedBySqlstate(error, '42501');
  });

  it('refuses the other three credential RPCs to an agent too — status included', async () => {
    const agent = { ...humanClaims(fixture.aliceIdentity), authKind: 'agent' };
    for (const [fn, args] of [
      ['set_account_agent_credential', ['anthropic', null, 'claude.ai', 'active']],
      ['delete_account_agent_credential', ['anthropic']],
      ['finish_credential_session', ['00000000-0000-0000-0000-000000000000']],
    ] as const) {
      const error = await captureError(() => db.rpc(agent, fn, args as readonly unknown[]));
      expect(refusalCode(error), `${fn} admitted an agent`).toBe(sqlStateToCode('42501'));
    }
  });
});

// ===========================================================================
// Acceptance criterion 7 — the credential home is 0700, including the repair
// ===========================================================================

describe('AC7 — the credential home, and the 0755 repair case', () => {
  const mode = async (path: string): Promise<string> =>
    ((await stat(path)).mode & 0o777).toString(8);

  it('creates all three levels at 0700', async () => {
    const { homeDir, configDir } = await ensureCredentialHome(dataDir, 'identity-fresh', 'anthropic');
    expect(homeDir).toBe(credentialHomeDir(dataDir, 'identity-fresh'));
    expect(configDir).toBe(credentialConfigDir(dataDir, 'identity-fresh', 'anthropic'));
    expect(await mode(join(dataDir, 'credentials'))).toBe('700');
    expect(await mode(homeDir)).toBe('700');
    expect(await mode(configDir)).toBe('700');
  });

  it('REPAIRS a directory that already exists at 0755 — the case mkdir silently ignores', async () => {
    // The failure this covers is not hypothetical: `mkdir(path, {mode})` applies
    // its mode only to directories it CREATES, so on an upgraded node the call
    // returns success having changed nothing, and a world-readable directory
    // holds `.credentials.json`. Every observable signal says it worked.
    const identity = 'identity-legacy';
    const home = credentialHomeDir(dataDir, identity);
    const config = credentialConfigDir(dataDir, identity, 'github');
    await mkdir(config, { recursive: true });
    await chmod(join(dataDir, 'credentials'), 0o755);
    await chmod(home, 0o755);
    await chmod(config, 0o755);
    // The precondition, asserted — otherwise a repair test can pass against a
    // directory that was never broken.
    expect(await mode(home)).toBe('755');

    await ensureCredentialHome(dataDir, identity, 'github');

    expect(await mode(join(dataDir, 'credentials'))).toBe('700');
    expect(await mode(home)).toBe('700');
    expect(await mode(config)).toBe('700');
  });

  it('gives two identities two different homes', async () => {
    const alice = await ensureCredentialHome(dataDir, 'identity-a', 'anthropic');
    const bob = await ensureCredentialHome(dataDir, 'identity-b', 'anthropic');
    expect(alice.configDir).not.toBe(bob.configDir);
  });

  it('refuses an identity id that would escape the credentials root', async () => {
    for (const hostile of ['../../etc', 'a/b', '..', '']) {
      await expect(ensureCredentialHome(dataDir, hostile, 'anthropic')).rejects.toThrow();
    }
  });
});

// ===========================================================================
// Acceptance criteria 5 and 6 — the probes
// ===========================================================================

describe('AC6 — success is never inferred from a clean exit', () => {
  it('records anthropic as NOT connected when loggedIn is false, despite exit 0', async () => {
    // `claude auth status` exits 0 either way. Reading the exit code instead of
    // the field marks every abandoned login as connected.
    const run: CommandRunner = async () =>
      outcome({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) });
    const probe = await runCredentialProbe({
      provider: 'anthropic',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(false);
    expect(probe.status).toBe('stale');
  });

  it('records anthropic as connected ONLY on loggedIn === true', async () => {
    const run: CommandRunner = async () =>
      outcome({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', orgId: 'org_1' }),
      });
    const probe = await runCredentialProbe({
      provider: 'anthropic',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(true);
    expect(probe.status).toBe('active');
    expect(probe.authMethod).toBe('claude.ai');
    // This fixture's stdout carries no `email` field, so the parser must pass
    // NULL through rather than invent a name. (Post-R4-amendment, `claude auth
    // login` grants `user:profile` and a real probe answer carries `email` —
    // see the passthrough test below.)
    expect(probe.login).toBeNull();
  });

  it('passes the email through when the login persisted one (R4 amendment)', async () => {
    // The REAL logged-in shape, captured from `claude auth status` (2.1.220)
    // after `claude auth login` — the verb the table now runs. `user:profile`
    // is in its grant, so `email` is present and must land in `login`.
    const run: CommandRunner = async () =>
      outcome({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'member@example.test',
          orgId: 'org_1',
          orgName: 'Example Org',
          subscriptionType: 'max',
        }),
      });
    const probe = await runCredentialProbe({
      provider: 'anthropic',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(true);
    expect(probe.status).toBe('active');
    expect(probe.login).toBe('member@example.test');
    expect(probe.authMethod).toBe('claude.ai');
  });

  it('does not accept the STRING "false" as truthy', async () => {
    const run: CommandRunner = async () =>
      outcome({ stdout: JSON.stringify({ loggedIn: 'false' }) });
    const probe = await runCredentialProbe({
      provider: 'anthropic',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(false);
  });

  it('marks openai STALE on an answer it cannot parse, and never claims success', async () => {
    // `codex login status`'s output has not been captured on any node. The
    // finish step must tolerate that rather than guess.
    const run: CommandRunner = async () =>
      outcome({ exitCode: 0, stdout: 'some future format nobody has measured' });
    const probe = await runCredentialProbe({
      provider: 'openai',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(false);
    expect(probe.status).toBe('stale');
    expect(probe.detail).toMatch(/cannot parse/);
  });

  it('reads openai properly if the CLI ever answers JSON', async () => {
    const run: CommandRunner = async () =>
      outcome({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.test' }) });
    const probe = await runCredentialProbe({
      provider: 'openai',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(true);
    expect(probe.login).toBe('a@b.test');
  });
});

describe('AC5 — the GitHub finish step (finding D6)', () => {
  const GH_STATUS = 'github.com\n  ✓ Logged in to github.com account alice (keyring)\n  - Token scopes: repo, read:org';

  it('REFUSES to probe when GH_TOKEN is in the environment', () => {
    // `gh auth token` prefers $GH_TOKEN over hosts.yml, so a probe run with it
    // set would confirm the MACHINE account as a success.
    expect(() => assertNoGitHubTokenEnv({ HOME: '/x', GH_TOKEN: 'ghp_x' })).toThrow(/D6/);
    expect(() => assertNoGitHubTokenEnv({ HOME: '/x', GITHUB_TOKEN: 'ghp_x' })).toThrow(/D6/);
    expect(() => assertNoGitHubTokenEnv({ HOME: '/x' })).not.toThrow();
  });

  it('refuses through runCredentialProbe as well, BEFORE any command runs', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (argv) => {
      calls.push([...argv]);
      return outcome({ stdout: GH_STATUS });
    };
    await expect(
      runCredentialProbe({
        provider: 'github',
        env: { HOME: '/x', GH_TOKEN: 'ghp_machine' },
        cwd: '/x',
        run,
      }),
    ).rejects.toThrow(/D6/);
    // Ordering is the point: probing first and checking after would run the
    // cross-check inside a poisoned environment, where both readings agree —
    // on the wrong account.
    expect(calls).toEqual([]);
  });

  it('stores only when `gh api user` AGREES with the hosts.yml login', async () => {
    const run: CommandRunner = async (argv) =>
      argv.includes('api')
        ? outcome({ stdout: 'alice\n' })
        : outcome({ stdout: GH_STATUS });
    const probe = await runCredentialProbe({
      provider: 'github',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(true);
    expect(probe.login).toBe('alice');
  });

  it('REFUSES when `gh api user` disagrees — the D6 false positive, caught', async () => {
    const run: CommandRunner = async (argv) =>
      argv.includes('api')
        ? outcome({ stdout: 'tm8-machine-account\n' })
        : outcome({ stdout: GH_STATUS });
    const probe = await runCredentialProbe({
      provider: 'github',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(false);
    expect(probe.status).toBe('stale');
    // Both names are in the message because the difference IS the diagnosis.
    expect(probe.detail).toContain('tm8-machine-account');
    expect(probe.detail).toContain('alice');
  });

  it('does not confirm a login when gh reports none', async () => {
    const run: CommandRunner = async () =>
      outcome({ exitCode: 1, stderr: 'You are not logged into any GitHub hosts.' });
    const probe = await runCredentialProbe({
      provider: 'github',
      env: { HOME: '/x' },
      cwd: '/x',
      run,
    });
    expect(probe.connected).toBe(false);
  });
});

// ===========================================================================
// Acceptance criteria 4 and 8 — the service, against the real Db
// ===========================================================================

function serviceFor(
  pty: PtyHostService,
  options: {
    run?: CommandRunner;
    now?: () => number;
    storeGitCredential?: W2CredentialSessionsService['finish'] extends never ? never : undefined;
  } = {},
): W2CredentialSessionsService {
  return new W2CredentialSessionsService({
    db,
    launcher: new CredentialSessionLauncher({
      pty,
      env: { PATH: '/usr/bin:/bin', HOME: '/home/tm8', GH_TOKEN: 'ghp_machine_LEAKED' },
    }),
    dataDir,
    env: {},
    ...(options.run ? { probeRunner: options.run } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

describe('AC4 / AC8 — start, the cap, the TTL and the one-per-pair rule', () => {
  it('starts a session whose work_session is credential-kind, share_mode none and node_id NULL', async () => {
    const pty = fakePty();
    const service = serviceFor(pty.pty);
    const started = await service.start(
      { spaceId: fixture.space, provider: 'anthropic' },
      { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' },
    );

    const [row] = await database.query<{
      session_kind: string;
      share_mode: string;
      node_id: string | null;
      created_by: string;
    }>(
      `select ws.session_kind, ws.share_mode, ws.node_id::text, e.created_by::text
         from public.work_sessions ws join public.entities e on e.id = ws.entity_id
        where ws.entity_id = $1`,
      [started.workSessionId],
    );
    expect(row!.session_kind).toBe('credential');
    expect(row!.share_mode).toBe('none');
    // D5: a credential row carrying a node_id is force-exited at node boot,
    // because reconcileNodeGhosts lists candidates BY node_id.
    expect(row!.node_id).toBeNull();

    // FINDING D2, the assertion that distinguishes the two resolvers. The
    // envelope must be Alice's own MEMBERSHIP — `internal.current_member_id` —
    // and never `internal.resolve_actor`, which would resolve to the TEAM
    // MEMBER and make the login terminal belong to a persona.
    expect(row!.created_by).toBe(fixture.aliceMember);
    expect(row!.created_by).not.toBe(fixture.teamMember);

    // The command is the table entry, unmodified.
    expect(started.command).toBe(CREDENTIAL_LOGIN_COMMANDS.anthropic);
    expect(pty.spawns[0]?.command).toBe(CREDENTIAL_LOGIN_COMMANDS.anthropic);

    await service.finish(
      { workSessionId: started.workSessionId },
      { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' },
    );
  });

  it('D2 again, from the other side: an actorId on the claims is REFUSED outright', async () => {
    const service = serviceFor(fakePty().pty);
    await expect(
      service.start(
        { spaceId: fixture.space, provider: 'anthropic' },
        {
          claims: { ...humanClaims(fixture.aliceIdentity), actorId: fixture.teamMember },
          identityId: 'pr2-alice',
        },
      ),
    ).rejects.toThrow(/D2/);
  });

  it('spawns with the SCRUBBED env — no GH_TOKEN, even though the server has one', async () => {
    const pty = fakePty();
    const service = serviceFor(pty.pty);
    const started = await service.start(
      { spaceId: fixture.space, provider: 'github' },
      { claims: humanClaims(fixture.bobIdentity), identityId: 'pr2-bob' },
    );
    const env = pty.spawns.at(-1)!.env;
    // The server env handed to the launcher DOES carry GH_TOKEN (see
    // serviceFor). `gh` refuses to log in while it is set, so a leak here is
    // not merely insecure — the login silently no-ops.
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(Object.keys(env).sort()).toEqual([
      'GH_CONFIG_DIR',
      'HOME',
      'LANG',
      'PATH',
      'SHELL',
      'TERM',
      'XDG_CONFIG_HOME',
    ]);
    expect(env['HOME']).toBe(credentialHomeDir(dataDir, 'pr2-bob'));

    await service.finish(
      { workSessionId: started.workSessionId },
      { claims: humanClaims(fixture.bobIdentity), identityId: 'pr2-bob' },
    );
  });

  it('SUPERSEDES the member’s own live terminal on a same-provider re-connect', async () => {
    const pty = fakePty();
    const service = serviceFor(pty.pty);
    const principal = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const first = await service.start({ spaceId: fixture.space, provider: 'openai' }, principal);

    // The abandoned-tab case, measured on utho-prod 2026-08-09: the first
    // terminal is still LIVE and UNEXPIRED, and the member clicks Connect
    // again. The old behaviour let the partial unique index refuse with a raw
    // `duplicate key value violates …one_live_per_account_provider` for the
    // whole TTL. The member asking again IS the authority to retire their own
    // login terminal: only one login flow per (account, provider) can be real.
    const second = await service.start({ spaceId: fixture.space, provider: 'openai' }, principal);
    expect(second.workSessionId).not.toBe(first.workSessionId);
    expect(pty.kills).toContain(first.workSessionId);
    const [old] = await database.query<{ finished_at: Date | null }>(
      `select finished_at from public.credential_sessions where work_session_id = $1`,
      [first.workSessionId],
    );
    expect(old!.finished_at).not.toBeNull();

    // …a DIFFERENT provider still runs concurrently — only the same-provider
    // slot is superseded, and the index stays per (account, provider)…
    const other = await service.start({ spaceId: fixture.space, provider: 'github' }, principal);
    expect(other.workSessionId).not.toBe(second.workSessionId);
    // …and opening it did NOT retire the openai terminal.
    expect(pty.live.has(second.workSessionId)).toBe(true);

    await service.finish({ workSessionId: second.workSessionId }, principal);
    await service.finish({ workSessionId: other.workSessionId }, principal);
  });

  it('lets a DIFFERENT account hold the same provider at the same time', async () => {
    const pty = fakePty();
    const service = serviceFor(pty.pty);
    const alice = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const bob = { claims: humanClaims(fixture.bobIdentity), identityId: 'pr2-bob' };
    const a = await service.start({ spaceId: fixture.space, provider: 'anthropic' }, alice);
    const b = await service.start({ spaceId: fixture.space, provider: 'anthropic' }, bob);
    expect(a.workSessionId).not.toBe(b.workSessionId);
    await service.finish({ workSessionId: a.workSessionId }, alice);
    await service.finish({ workSessionId: b.workSessionId }, bob);
  });

  it('reclaims the member’s OWN stale row instead of refusing them (R10 element 2)', async () => {
    const pty = fakePty();
    const clock = { now: Date.now() };
    const service = serviceFor(pty.pty, { now: () => clock.now });
    const principal = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };

    const first = await service.start({ spaceId: fixture.space, provider: 'openai' }, principal);
    // Simulate the crash this exists for: the PTY is gone, but the row is still
    // unfinished. Before the reclaim, the partial unique index would refuse the
    // member forever.
    pty.live.delete(first.workSessionId);

    const second = await service.start({ spaceId: fixture.space, provider: 'openai' }, principal);
    expect(second.workSessionId).not.toBe(first.workSessionId);

    const [old] = await database.query<{ finished_at: Date | null }>(
      `select finished_at from public.credential_sessions where work_session_id = $1`,
      [first.workSessionId],
    );
    expect(old!.finished_at).not.toBeNull();

    await service.finish({ workSessionId: second.workSessionId }, principal);
  });

  it('EXPIRY terminates the PTY and finishes the row (R10 element 1)', async () => {
    const pty = fakePty();
    const clock = { now: Date.now() };
    const service = serviceFor(pty.pty, { now: () => clock.now });
    const principal = { claims: humanClaims(fixture.bobIdentity), identityId: 'pr2-bob' };
    const started = await service.start({ spaceId: fixture.space, provider: 'openai' }, principal);

    expect(pty.live.has(started.workSessionId)).toBe(true);
    // Nothing to sweep while it is live and unexpired.
    expect(await service.sweepNow()).toBe(0);

    // Past the TTL ceiling.
    clock.now += 2_000_000;
    expect(await service.sweepNow()).toBe(1);

    expect(pty.kills).toContain(started.workSessionId);
    expect(pty.live.has(started.workSessionId)).toBe(false);
    const [row] = await database.query<{ finished_at: Date | null }>(
      `select finished_at from public.credential_sessions where work_session_id = $1`,
      [started.workSessionId],
    );
    expect(row!.finished_at).not.toBeNull();
    expect(service.liveSessionIds()).toEqual([]);
  });

  it('sweeps a session whose PTY died on its own, without waiting for the TTL', async () => {
    const pty = fakePty();
    const service = serviceFor(pty.pty);
    const principal = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const started = await service.start({ spaceId: fixture.space, provider: 'github' }, principal);
    pty.live.delete(started.workSessionId);
    expect(await service.sweepNow()).toBe(1);
    const [row] = await database.query<{ finished_at: Date | null }>(
      `select finished_at from public.credential_sessions where work_session_id = $1`,
      [started.workSessionId],
    );
    expect(row!.finished_at).not.toBeNull();
  });

  it('CAP: refuses once the credential cap is reached, with its own error', async () => {
    const pty = fakePty();
    const service = new W2CredentialSessionsService({
      db,
      launcher: new CredentialSessionLauncher({ pty: pty.pty, env: { PATH: '/usr/bin' } }),
      dataDir,
      // The cap is ITS OWN env var and its own count — disjoint from the agent
      // cap, so a full node of agents can never block a login.
      env: { TM8_CREDENTIAL_SESSION_CAP: '1' },
    });
    const alice = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const bob = { claims: humanClaims(fixture.bobIdentity), identityId: 'pr2-bob' };
    const first = await service.start({ spaceId: fixture.space, provider: 'anthropic' }, alice);

    const error = await captureError(() =>
      service.start({ spaceId: fixture.space, provider: 'anthropic' }, bob),
    );
    // 082's own cap raise, not the agent cap's.
    expectRefusedBySqlstate(error, '53400');
    expect(refusalCode(error)).toBe('limit_exceeded');

    await service.finish({ workSessionId: first.workSessionId }, alice);
    // Freed: the cap counts unfinished, unexpired rows.
    const third = await service.start({ spaceId: fixture.space, provider: 'anthropic' }, bob);
    await service.finish({ workSessionId: third.workSessionId }, bob);
  });

  it('reads TM8_CREDENTIAL_SESSION_CAP, and falls back rather than to zero', () => {
    expect(resolveCredentialSessionCap({})).toBe(2);
    expect(resolveCredentialSessionCap({ TM8_CREDENTIAL_SESSION_CAP: '5' })).toBe(5);
    // A typo must not refuse every login with a cap error, which would read as
    // a bug in the feature rather than as a bad unit file.
    expect(resolveCredentialSessionCap({ TM8_CREDENTIAL_SESSION_CAP: 'nonsense' })).toBe(2);
    expect(resolveCredentialSessionCap({ TM8_CREDENTIAL_SESSION_CAP: '0' })).toBe(2);
  });
});

describe('R10 element 3 — the cap counts lifecycle columns, not work_sessions.status', () => {
  it('does NOT count a row that is unfinished but EXPIRED — the crash-orphan case', async () => {
    // The chain this closes: a crashed node's credential work_session stays
    // 'running' forever (no lifecycle writer survives the process, the reaper
    // skips it because node_id is NULL, and finish stamps finished_at only).
    // Counting by status meant two crashes blocked every login on the node,
    // permanently, with no error naming the cause.
    const pty = fakePty();
    const service = serviceFor(pty.pty);
    const alice = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const started = await service.start({ spaceId: fixture.space, provider: 'openai' }, alice);

    const countLive = async (): Promise<number> =>
      (
        await database.query<{ n: number }>(
          `select internal.credential_session_count(null)::int as n`,
        )
      )[0]!.n;

    expect(await countLive()).toBeGreaterThanOrEqual(1);

    // Age the row out WITHOUT touching work_sessions.status — precisely the
    // state a crash leaves behind.
    await database.query(
      `update public.credential_sessions set expires_at = now() - interval '1 hour'
        where work_session_id = $1`,
      [started.workSessionId],
    );
    const [ws] = await database.query<{ status: string }>(
      `select status from public.work_sessions where entity_id = $1`,
      [started.workSessionId],
    );
    // The row still says 'running' — that is the whole point.
    expect(['spawning', 'running', 'idle']).toContain(ws!.status);
    expect(await countLive()).toBe(0);
  });
});

describe('the probe runs in the SAME environment the terminal ran in', () => {
  it('hands the probe the credential env and the credential home as cwd', async () => {
    const pty = fakePty();
    const seen: { env: Record<string, string>; cwd: string }[] = [];
    const run: CommandRunner = async (_argv, options) => {
      seen.push({ env: options.env, cwd: options.cwd });
      return outcome({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) });
    };
    const service = serviceFor(pty.pty, { run });
    const principal = { claims: humanClaims(fixture.bobIdentity), identityId: 'pr2-bob' };
    const started = await service.start({ spaceId: fixture.space, provider: 'anthropic' }, principal);
    const finished = await service.finish({ workSessionId: started.workSessionId }, principal);

    expect(finished.probe.connected).toBe(true);
    expect(finished.stored).toBe(true);
    // A probe run anywhere else would read the NODE's credential and cheerfully
    // confirm it — the config dir IS the credential's location.
    expect(seen[0]!.env['CLAUDE_CONFIG_DIR']).toBe(
      credentialConfigDir(dataDir, 'pr2-bob', 'anthropic'),
    );
    expect(seen[0]!.cwd).toBe(credentialHomeDir(dataDir, 'pr2-bob'));

    const [row] = await database.query<{ provider: string; auth_method: string; login: string | null }>(
      `select provider, auth_method, login from public.account_agent_credentials
        where account_id = (select id from public.accounts where identity_id = 'pr2-bob')
          and provider = 'anthropic'`,
    );
    expect(row!.auth_method).toBe('claude.ai');
    expect(row!.login).toBeNull();
  });

  it('writes NOTHING when the probe is stale — an abandoned login is not a connection', async () => {
    const pty = fakePty();
    const run: CommandRunner = async () =>
      outcome({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) });
    const service = serviceFor(pty.pty, { run });
    const principal = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const started = await service.start({ spaceId: fixture.space, provider: 'openai' }, principal);
    const finished = await service.finish({ workSessionId: started.workSessionId }, principal);

    expect(finished.probe.connected).toBe(false);
    expect(finished.stored).toBe(false);
    // Not a `status='stale'` row either: an unwritten row means "not
    // connected", while a stale row means "connected once, cannot confirm" —
    // and the second would put a Connected card in front of a member who never
    // completed a login.
    const rows = await database.query(
      `select 1 from public.account_agent_credentials
        where account_id = (select id from public.accounts where identity_id = 'pr2-alice')
          and provider = 'openai'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does not persist a GitHub credential on this branch, and says so', async () => {
    // The storage split is by SHAPE: a GitHub token is string-shaped and
    // belongs in 079's already-shipped `account_git_credentials`, which is
    // reachable from no local git object. The seam is injected and absent here
    // rather than duplicated or faked.
    const pty = fakePty();
    const run: CommandRunner = async (argv) =>
      argv.includes('api')
        ? outcome({ stdout: 'alice\n' })
        : outcome({ stdout: 'github.com\n  ✓ Logged in to github.com account alice (keyring)' });
    const service = serviceFor(pty.pty, { run });
    const principal = { claims: humanClaims(fixture.aliceIdentity), identityId: 'pr2-alice' };
    const started = await service.start({ spaceId: fixture.space, provider: 'github' }, principal);
    const finished = await service.finish({ workSessionId: started.workSessionId }, principal);

    expect(finished.probe.connected).toBe(true);
    expect(finished.stored).toBe(false);
    // And it never lands in the FILE-shaped table, whose CHECK admits only the
    // two file-shaped providers (R6).
    const rows = await database.query(
      `select 1 from public.account_agent_credentials where provider = 'github'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the credential home really is where the vendor CLI would write', () => {
  it('two identities resolve to two different config directories on disk', async () => {
    const a = await ensureCredentialHome(dataDir, 'iso-a', 'anthropic');
    const b = await ensureCredentialHome(dataDir, 'iso-b', 'anthropic');
    await writeFile(join(a.configDir, '.credentials.json'), '{"a":1}', { mode: 0o600 });
    await writeFile(join(b.configDir, '.credentials.json'), '{"b":2}', { mode: 0o600 });
    const modeA = ((await stat(join(a.configDir, '.credentials.json'))).mode & 0o777).toString(8);
    expect(modeA).toBe('600');
    expect(a.configDir).not.toBe(b.configDir);
  });
});
