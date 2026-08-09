/**
 * 082 — per-member agent credentials, proved against a REAL PostgreSQL.
 *
 * WHY THIS FILE CANNOT BE A FakeDb TEST, STATED UP FRONT.
 *
 * Everything 082 adds is invisible to the in-memory test double. Row-level
 * security is a Postgres feature; a column-level GRANT is a Postgres privilege;
 * `security definer` and plpgsql are Postgres execution semantics; a partial
 * unique index and a composite foreign key are Postgres constraints. A FakeDb
 * test that "passes" here would be asserting the behaviour of a JavaScript
 * object that has none of those things — it would be green and worth nothing.
 * So every assertion below runs against a scratch database with the whole
 * migration chain applied, and every claim about a refusal checks the SQLSTATE
 * rather than merely that something threw.
 *
 * THE TWO-PRINCIPAL RULE. Isolation is proved with Alice and Bob, two distinct
 * identities with two distinct accounts. A single-principal test cannot
 * distinguish "the policy works" from "there was only ever one row", which is
 * the failure mode a self-select policy is most likely to hide.
 *
 * ONE MEASUREMENT CAVEAT, so the evidence is not overstated: `migrationFiles()`
 * reads the working tree. `internal.current_account_id()` and
 * `public.account_git_credentials` are NOT reachable from `origin/main` — they
 * live in `078_private_projects` / `079_account_git_credentials` on the deployed
 * staging line, renumbered to 080/081 on `origin/feat/per-user-private-workspaces`.
 * 082 carries its own byte-identical copy of `current_account_id()` so it is
 * order-independent, but the git-credential TABLE it does not create. The one
 * assertion that needs that table is therefore gated on its existence and says
 * so loudly when it skips, rather than silently passing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  aliceIdentity: string;
  bobIdentity: string;
  space: string;
  aliceMember: string;
  bobMember: string;
  teamMember: string;
  aliceAccount: string;
  bobAccount: string;
}

/** SQLSTATE off a pg error, or the message when the driver gave us neither. */
function sqlstate(error: unknown): string {
  return (error as { code?: string }).code ?? `no-sqlstate: ${String(error)}`;
}

async function expectRefusal(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected a refusal, the statement succeeded').toBeDefined();
  expect(sqlstate(caught)).toBe(code);
}

let database: W1ScratchDatabase;
let fixture: Fixture;
/** True when the working tree carries 079/081's git-credential table. */
let gitCredentialTablePresent = false;

/**
 * Runs `fn` as the application role with a full, honest claim envelope.
 *
 * `tm8.auth_kind` is the fifth claim 082 introduces. It defaults to 'browser'
 * here because that is what a human request carries; the tests that prove the
 * gate fails closed pass an explicit empty or 'agent' value.
 */
async function asApp<T>(
  identity: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
  options: { authKind?: string; nodeAdmin?: boolean } = {},
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', $2, true),
              set_config('tm8.request_id', 'req-082-pg', true),
              set_config('tm8.auth_kind', $3, true)`,
      [identity, String(options.nodeAdmin ?? false), options.authKind ?? 'browser'],
    );
    return fn(client);
  });
}

/** Runs `fn` as the schema owner — used only to seed and to inspect. */
async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<Omit<Fixture, 'aliceAccount' | 'bobAccount'>>(
        `select 'cred-alice'::text "aliceIdentity", 'cred-bob'::text "bobIdentity",
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
    const accounts = (
      await client.query<{ identity_id: string; id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, 'cred-alice', 'Alice', false, true),
                ($2, 'cred-bob', 'Bob', false, false)
         returning identity_id, id::text`,
        [ids.aliceIdentity, ids.bobIdentity],
      )
    ).rows;

    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Credentials', $2)`,
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

    return {
      ...ids,
      aliceAccount: accounts.find((row) => row.identity_id === ids.aliceIdentity)!.id,
      bobAccount: accounts.find((row) => row.identity_id === ids.bobIdentity)!.id,
    };
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('cred_082');
  // The WHOLE chain, in order, exactly as db/migrate.mjs would apply it. If 082
  // broke anything upstream this throws here and no assertion below runs.
  database.apply(migrationFiles());
  gitCredentialTablePresent =
    (
      await database.query<{ present: boolean }>(
        `select to_regclass('public.account_git_credentials') is not null as present`,
      )
    )[0]!.present;
  fixture = await seed();
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('082 — the migration applies and its objects exist', () => {
  it('adds session_kind as NOT NULL DEFAULT agent, so no existing insert path changes', async () => {
    const [column] = await database.query<{
      is_nullable: string;
      column_default: string;
    }>(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'work_sessions'
          and column_name = 'session_kind'`,
    );
    expect(column).toBeDefined();
    expect(column!.is_nullable).toBe('NO');
    expect(column!.column_default).toBe(`'agent'::text`);
  });

  it('creates both tables with row-level security ENABLED', async () => {
    const rows = await database.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relname in ('account_agent_credentials', 'credential_sessions')
        order by relname`,
    );
    expect(rows.map((row) => row.relname)).toEqual([
      'account_agent_credentials',
      'credential_sessions',
    ]);
    // RLS enabled but unenforced is the classic silent hole: the table looks
    // protected in the DDL and admits everything.
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
  });

  it('gives every credential RPC no account parameter at all', async () => {
    const rows = await database.query<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('start_credential_session', 'finish_credential_session',
                            'set_account_agent_credential', 'delete_account_agent_credential')
        order by p.proname`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      // This is THE security property of the whole surface: an account
      // parameter would make each of these a confused deputy, and no check
      // inside the body recovers what an absent parameter gives for free.
      expect(row.args, `${row.proname} must not name an account`).not.toMatch(/account/i);
      // security definer, or deriving the account is pointless.
      // (prosecdef checked below in one query for all four.)
    }
    const [definers] = await database.query<{ all_definer: boolean }>(
      `select bool_and(p.prosecdef) as all_definer
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('start_credential_session', 'finish_credential_session',
                            'set_account_agent_credential', 'delete_account_agent_credential')`,
    );
    expect(definers!.all_definer).toBe(true);
  });
});

describe('082 — isolation between two distinct principals', () => {
  it("never returns Alice's credential row to Bob, and vice versa", async () => {
    await asApp(fixture.aliceIdentity, async (client) => {
      await client.query(`select public.set_account_agent_credential('anthropic', null, 'claude.ai')`);
    });
    await asApp(fixture.bobIdentity, async (client) => {
      await client.query(`select public.set_account_agent_credential('openai', 'bob@example.test', 'chatgpt')`);
    });

    // Alice sees exactly her own row.
    const aliceRows = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query<{ provider: string; account_id: string }>(
        `select provider, account_id::text from public.account_agent_credentials order by provider`,
      )).rows,
    );
    expect(aliceRows.map((row) => row.provider)).toEqual(['anthropic']);
    expect(aliceRows[0]!.account_id).toBe(fixture.aliceAccount);

    // Bob sees exactly his own. Two rows exist; each principal sees one.
    const bobRows = await asApp(fixture.bobIdentity, async (client) =>
      (await client.query<{ provider: string; account_id: string }>(
        `select provider, account_id::text from public.account_agent_credentials order by provider`,
      )).rows,
    );
    expect(bobRows.map((row) => row.provider)).toEqual(['openai']);
    expect(bobRows[0]!.account_id).toBe(fixture.bobAccount);

    // And the owner, who bypasses RLS, confirms BOTH rows are really there — so
    // the two reads above narrowed rather than the table being nearly empty.
    const all = await asOwner(async (client) =>
      (await client.query<{ count: string }>(
        `select count(*)::text from public.account_agent_credentials`,
      )).rows,
    );
    expect(all[0]!.count).toBe('2');
  });

  it('gives a NODE ADMIN no bypass — an operator has no business reading a member identity', async () => {
    // 079's header states this explicitly and 082 copies it. A node admin claim
    // is honoured all over this schema; here it must buy nothing.
    const rows = await asApp(
      fixture.bobIdentity,
      async (client) =>
        (await client.query<{ provider: string }>(
          `select provider from public.account_agent_credentials order by provider`,
        )).rows,
      { nodeAdmin: true },
    );
    expect(rows.map((row) => row.provider)).toEqual(['openai']);
  });

  it("refuses Bob's attempt to delete Alice's credential, silently and without effect", async () => {
    // There is no account parameter to abuse, so the only reachable attempt is
    // "delete my own anthropic" — which is a no-op for Bob and must NOT touch
    // Alice's row of the same provider.
    const result = await asApp(fixture.bobIdentity, async (client) =>
      (await client.query<{ result: { deleted: boolean } }>(
        `select public.delete_account_agent_credential('anthropic') as result`,
      )).rows[0]!.result,
    );
    expect(result.deleted).toBe(false);

    const aliceStillThere = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query<{ count: string }>(
        `select count(*)::text from public.account_agent_credentials where provider = 'anthropic'`,
      )).rows[0]!.count,
    );
    expect(aliceStillThere).toBe('1');
  });
});

describe('082 — privileges, not policies', () => {
  it('gives tm8_app no insert, update or delete on either credential table', async () => {
    const rows = await database.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'tm8_app'
          and table_name in ('account_agent_credentials', 'credential_sessions')
        order by table_name, privilege_type`,
    );
    // Column-level grants do not appear here at all; the point is that no
    // TABLE-level write privilege does either.
    expect(rows.map((row) => `${row.table_name}.${row.privilege_type}`)).toEqual([]);
  });

  it('refuses a direct write to account_agent_credentials as the app role with 42501', async () => {
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(
            `insert into public.account_agent_credentials(account_id, provider)
             values ($1, 'openai')`,
            [fixture.aliceAccount],
          ),
        ),
      '42501',
    );
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(`update public.account_agent_credentials set status = 'revoked'`),
        ),
      '42501',
    );
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(`delete from public.account_agent_credentials`),
        ),
      '42501',
    );
  });

  it('still refuses `select *` on the SHIPPED git-credential table with 42501', async () => {
    if (!gitCredentialTablePresent) {
      // NOT a silent pass. This assertion needs `public.account_git_credentials`,
      // which 082 does not create: it ships in `079_account_git_credentials` on
      // the deployed staging line (`origin/deploy/channels-on-staging`), and as
      // `081_account_git_credentials` on `origin/feat/per-user-private-workspaces`.
      // Neither is reachable from `origin/main`. When one of them merges this
      // gate opens by itself and the assertion below runs for real.
      console.warn(
        '[082] SKIPPED the git-credential 42501 check: public.account_git_credentials ' +
          'is absent from this migration chain (079/081 are not on origin/main).',
      );
      expect(gitCredentialTablePresent).toBe(false);
      return;
    }
    // The column-level grant omits token_ciphertext and token_nonce, so `select
    // *` asks for a privilege that DOES NOT EXIST — which is strictly stronger
    // than a policy a future `using (true)` could widen. 082 must not have
    // weakened it.
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(`select * from public.account_git_credentials`),
        ),
      '42501',
    );
    // The status projection the app actually uses still works.
    const rows = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query(
        `select id, account_id, provider, login from public.account_git_credentials`,
      )).rows,
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('082 — the human-only gate fails closed', () => {
  it('refuses every credential RPC when tm8.auth_kind is missing', async () => {
    for (const statement of [
      `select public.start_credential_session($1, 'anthropic')`,
      `select public.finish_credential_session($1)`,
      `select public.set_account_agent_credential('anthropic', null, null)`,
      `select public.delete_account_agent_credential('anthropic')`,
    ]) {
      await expectRefusal(
        () =>
          asApp(
            fixture.aliceIdentity,
            (client) =>
              client.query(statement, statement.includes('$1') ? [fixture.space] : []),
            { authKind: '' },
          ),
        '42501',
      );
    }
  });

  it('refuses an AGENT auth session even for the read-shaped RPCs', async () => {
    await expectRefusal(
      () =>
        asApp(
          fixture.aliceIdentity,
          (client) => client.query(`select public.delete_account_agent_credential('anthropic')`),
          { authKind: 'agent' },
        ),
      '42501',
    );
  });
});

describe('082 — D3: a live credential session does not move the spawn cap', () => {
  it('leaves live_work_session_count unchanged and lets a spawn through at cap 1', async () => {
    const countBefore = await asOwner(async (client) =>
      (await client.query<{ live: number }>(
        `select internal.live_work_session_count(null) as live`,
      )).rows[0]!.live,
    );

    const started = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query<{ result: { workSessionId: string; expiresAt: string } }>(
        `select public.start_credential_session($1, 'anthropic') as result`,
        [fixture.space],
      )).rows[0]!.result,
    );
    expect(started.workSessionId).toBeTruthy();

    // The row is genuinely live — 'spawning' is in the same status set the cap
    // counts — so this is not passing because nothing was created.
    const [row] = await asOwner(async (client) =>
      (await client.query<{ status: string; session_kind: string; node_id: string | null; share_mode: string }>(
        `select status, session_kind, node_id, share_mode from public.work_sessions where entity_id = $1`,
        [started.workSessionId],
      )).rows,
    );
    expect(row!.status).toBe('spawning');
    expect(row!.session_kind).toBe('credential');
    expect(row!.share_mode).toBe('none');
    // D5: reconcileNodeGhosts lists candidates BY node_id and force-exits any
    // row it finds no local PTY for. A credential terminal carrying a node_id
    // gets killed at node boot.
    expect(row!.node_id).toBeNull();

    const countAfter = await asOwner(async (client) =>
      (await client.query<{ live: number }>(
        `select internal.live_work_session_count(null) as live`,
      )).rows[0]!.live,
    );
    expect(countAfter, 'a credential session must not consume an agent spawn slot').toBe(
      countBefore,
    );

    // The mirror count DOES see it — so the exclusion above is a narrowed
    // predicate, not a row that failed to exist.
    const mirror = await asOwner(async (client) =>
      (await client.query<{ live: number }>(
        `select internal.credential_session_count(null) as live`,
      )).rows[0]!.live,
    );
    expect(mirror).toBe(1);

    // The end-to-end consequence, which is what actually bites users: with the
    // agent cap set to 1 and a live credential session present, a real spawn
    // must still succeed. Before this fix it answered 53400.
    const spawned = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query<{ result: unknown }>(
        `select public.execution_spawn(
           p_space_id => $1, p_team_member_id => $2, p_session_cap => 1,
           p_title => 'real agent'
         ) as result`,
        [fixture.space, fixture.teamMember],
      )).rows[0]!.result,
    );
    expect(spawned).toBeTruthy();

    // And the agent session DOES count, so cap 1 is genuinely exhausted now.
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(
            `select public.execution_spawn(
               p_space_id => $1, p_team_member_id => $2, p_session_cap => 1,
               p_title => 'second agent'
             )`,
            [fixture.space, fixture.teamMember],
          ),
        ),
      '53400',
    );
  });

  it('refuses a second live credential session for the same account and provider', async () => {
    // The partial unique index, which is the thing that keeps two vendor CLIs
    // from racing each other's config files.
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(`select public.start_credential_session($1, 'anthropic')`, [fixture.space]),
        ),
      '23505',
    );
  });

  it('lets the same account open a DIFFERENT provider, and a different account the same one', async () => {
    // p_session_cap is passed explicitly: the mirror cap defaults to 2 and this
    // case deliberately opens a third live terminal. That default is a floor for
    // a caller that names none, not a ceiling on the design — the point under
    // test is the (account, provider) uniqueness, not the cap.
    await asApp(fixture.aliceIdentity, (client) =>
      client.query(
        `select public.start_credential_session($1, 'github', p_session_cap => 10)`,
        [fixture.space],
      ),
    );
    await asApp(fixture.bobIdentity, (client) =>
      client.query(
        `select public.start_credential_session($1, 'anthropic', p_session_cap => 10)`,
        [fixture.space],
      ),
    );
    const mirror = await asOwner(async (client) =>
      (await client.query<{ live: number }>(
        `select internal.credential_session_count(null) as live`,
      )).rows[0]!.live,
    );
    expect(mirror).toBe(3);
  });
});

describe('082 — existing insert paths are untouched', () => {
  it('defaults an insert that never mentions session_kind to agent, and counts it', async () => {
    const countBefore = await asOwner(async (client) =>
      (await client.query<{ live: number }>(
        `select internal.live_work_session_count(null) as live`,
      )).rows[0]!.live,
    );
    const legacy = await asOwner(async (client) => {
      const id = (
        await client.query<{ id: string }>(
          `insert into public.entities(id, space_id, kind, position, created_by)
           values (internal.new_id(), $1, 'work_session', 99, $2) returning id::text`,
          [fixture.space, fixture.aliceMember],
        )
      ).rows[0]!.id;
      // EXACTLY the column list 007/043/048's execution_spawn uses — no
      // session_kind anywhere. If this needed editing, the column would not be
      // additive and the migration would be a breaking change.
      await client.query(
        `insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                          workdir_path, base_ref, status, agent_tool, model, mode)
         values ($1, 'legacy shaped', 'node-1', null, 'project', null, null,
                 'running', 'claude', null, null)`,
        [id],
      );
      return (
        await client.query<{ session_kind: string }>(
          `select session_kind from public.work_sessions where entity_id = $1`,
          [id],
        )
      ).rows[0]!;
    });
    expect(legacy.session_kind).toBe('agent');

    const countAfter = await asOwner(async (client) =>
      (await client.query<{ live: number }>(
        `select internal.live_work_session_count(null) as live`,
      )).rows[0]!.live,
    );
    expect(countAfter, 'a legacy-shaped agent session must still count').toBe(countBefore + 1);
  });
});

describe('082 — a credential_sessions row over an agent work_session is unproducible', () => {
  it('refuses the insert as the app role, which holds no insert privilege', async () => {
    const agentSession = await asOwner(async (client) =>
      (await client.query<{ entity_id: string }>(
        `select entity_id::text from public.work_sessions where session_kind = 'agent' limit 1`,
      )).rows[0]!.entity_id,
    );
    await expectRefusal(
      () =>
        asApp(fixture.aliceIdentity, (client) =>
          client.query(
            `insert into public.credential_sessions(work_session_id, account_id, provider, expires_at)
             values ($1, $2, 'anthropic', now() + interval '10 minutes')`,
            [agentSession, fixture.aliceAccount],
          ),
        ),
      '42501',
    );
  });

  it('refuses it even as the SCHEMA OWNER — the constraint is declarative, not a missing grant', async () => {
    // This is the assertion that makes the invariant real. "tm8_app has no
    // insert grant" is an ABSENCE; absences are not constraints and the next
    // person to add a grant would not know they had opened a hole. The
    // composite foreign key on (work_session_id, work_session_kind) means the
    // row cannot exist regardless of who is asking.
    const agentSession = await asOwner(async (client) =>
      (await client.query<{ entity_id: string }>(
        `select entity_id::text from public.work_sessions where session_kind = 'agent' limit 1`,
      )).rows[0]!.entity_id,
    );
    // 'openai' rather than 'anthropic': Alice already holds a live anthropic
    // terminal, and the partial unique index would fire FIRST (23505), proving
    // the wrong control. A provider she has no live session for leaves the
    // composite foreign key as the only thing that can refuse this row.
    await expectRefusal(
      () =>
        asOwner((client) =>
          client.query(
            `insert into public.credential_sessions(work_session_id, account_id, provider, expires_at)
             values ($1, $2, 'openai', now() + interval '10 minutes')`,
            [agentSession, fixture.aliceAccount],
          ),
        ),
      '23503',
    );
  });

  it('refuses flipping a credential work_session back to agent underneath a live row', async () => {
    const credentialSession = await asOwner(async (client) =>
      (await client.query<{ work_session_id: string }>(
        `select work_session_id::text from public.credential_sessions limit 1`,
      )).rows[0]!.work_session_id,
    );
    await expectRefusal(
      () =>
        asOwner((client) =>
          client.query(
            `update public.work_sessions set session_kind = 'agent' where entity_id = $1`,
            [credentialSession],
          ),
        ),
      '23503',
    );
  });
});

describe('082 — finish stamps, it does not exit', () => {
  it('sets finished_at and leaves work_sessions.status exactly where it was', async () => {
    const target = await asOwner(async (client) =>
      (await client.query<{ work_session_id: string }>(
        `select cs.work_session_id::text from public.credential_sessions cs
          where cs.finished_at is null and cs.provider = 'github' limit 1`,
      )).rows[0]!.work_session_id,
    );
    const statusBefore = await asOwner(async (client) =>
      (await client.query<{ status: string }>(
        `select status from public.work_sessions where entity_id = $1`,
        [target],
      )).rows[0]!.status,
    );

    const result = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query<{ result: { finished: boolean } }>(
        `select public.finish_credential_session($1) as result`,
        [target],
      )).rows[0]!.result,
    );
    expect(result.finished).toBe(true);

    const after = await asOwner(async (client) =>
      (await client.query<{ status: string; finished_at: string | null }>(
        `select ws.status, cs.finished_at from public.work_sessions ws
           join public.credential_sessions cs on cs.work_session_id = ws.entity_id
          where ws.entity_id = $1`,
        [target],
      )).rows[0]!,
    );
    expect(after.finished_at).not.toBeNull();
    // Lifecycle has ONE writer, the process-side terminate/PTY-exit path. An
    // RPC that flipped this to 'exited' while the PTY may still be live would
    // be telling the same false-'exited' lie SpawnService.terminate refuses to
    // tell on EPERM.
    expect(after.status).toBe(statusBefore);
  });

  it("answers `finished: false` for Bob asking about Alice's session, without saying it exists", async () => {
    const aliceSession = await asOwner(async (client) =>
      (await client.query<{ work_session_id: string }>(
        `select work_session_id::text from public.credential_sessions
          where account_id = $1 and finished_at is null limit 1`,
        [fixture.aliceAccount],
      )).rows[0]!.work_session_id,
    );
    const result = await asApp(fixture.bobIdentity, async (client) =>
      (await client.query<{ result: { finished: boolean } }>(
        `select public.finish_credential_session($1) as result`,
        [aliceSession],
      )).rows[0]!.result,
    );
    // Identical to the already-finished answer on purpose: distinguishing the
    // two would tell Bob whether Alice has a session open.
    expect(result.finished).toBe(false);

    const stillOpen = await asOwner(async (client) =>
      (await client.query<{ finished_at: string | null }>(
        `select finished_at from public.credential_sessions where work_session_id = $1`,
        [aliceSession],
      )).rows[0]!.finished_at,
    );
    expect(stillOpen).toBeNull();
  });
});

describe('082 — maintenance and rail counters ignore login terminals', () => {
  it('emits no participant_backfill_unresolved audit for a credential session', async () => {
    const credentialSession = await asOwner(async (client) =>
      (await client.query<{ work_session_id: string }>(
        `select work_session_id::text from public.credential_sessions limit 1`,
      )).rows[0]!.work_session_id,
    );
    const backfilled = await asOwner(async (client) =>
      (await client.query<{ backfilled: number }>(
        `select internal.w1_backfill_participant($1) as backfilled`,
        [credentialSession],
      )).rows[0]!.backfilled,
    );
    expect(backfilled).toBe(0);

    // Zero is also what the UNGUARDED function returns when it cannot resolve a
    // candidate — so the return value alone proves nothing. The audit row is
    // what distinguishes "guarded and skipped" from "fell through and gave up",
    // and it is the row that would otherwise reappear on every maintenance pass
    // forever.
    // internal.w1_audit (015_w1_foundations.sql:318) does not write to a table
    // of its own — it appends a workspace_events row typed 'migration.w1.audit'
    // with the audit kind and details nested under payload.
    const audits = await asOwner(async (client) =>
      (await client.query<{ count: string }>(
        `select count(*)::text from public.workspace_events
          where event_type = 'migration.w1.audit'
            and payload->>'kind' = 'participant_backfill_unresolved'
            and payload#>>'{details,workSessionId}' = $1`,
        [credentialSession],
      )).rows[0]!.count,
    );
    expect(audits).toBe('0');
  });

  it('keeps credential sessions out of space_kind_counts', async () => {
    const counts = await asApp(fixture.aliceIdentity, async (client) =>
      (await client.query<{ kind: string; total: number }>(
        `select kind, total from public.space_kind_counts($1)`,
        [fixture.space],
      )).rows,
    );
    const workSessions = counts.find((row) => row.kind === 'work_session');
    const agentSessions = await asOwner(async (client) =>
      (await client.query<{ count: number }>(
        `select count(*)::integer as count from public.work_sessions ws
           join public.entities e on e.id = ws.entity_id
          where e.space_id = $1 and e.deleted_at is null and ws.session_kind = 'agent'`,
        [fixture.space],
      )).rows[0]!.count,
    );
    // Non-zero on both sides, or this would pass on an empty space.
    expect(agentSessions).toBeGreaterThan(0);
    expect(workSessions?.total ?? 0).toBe(agentSessions);
  });
});
