import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, type AuditBody } from '../../src/core-types.js';
import { PgVaultStore } from '../../src/store/postgres.js';
import { FixedClock, OWNER_ID, SPACE_A, T0, fakeSecret, newLogin, scopeOf, testCaller } from '../support/kit.js';
import { NO_APP_ROLE_REACH, PG_ENABLED, PG_REASON, appRoleVaultReach, pgHarness, type PgHarness } from './pg-harness.js';

const sql = (path: string) => readFile(new URL(`../../../../db/${path}`, import.meta.url), 'utf8');
const sys = { kind: 'system', purpose: 'audit' } as const;
const event: AuditBody = { action: 'session.signed_in', actor: actorOf(testCaller), itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: {} };

/** Rows in THIS database that still depend on a vault role: owners, ACL entries, default ACLs. */
const vaultRoleDependents = async (admin: PgHarness['admin']): Promise<number> => Number((await admin.query(`select count(*) as n from pg_shdepend s
  where s.dbid = (select oid from pg_database where datname = current_database())
    and s.refclassid = 'pg_authid'::regclass and s.refobjid in (select oid from pg_roles where rolname like 'tm8_vault\\_%')`)).rows[0].n);

if (!PG_ENABLED) describe('450_vault_store rollback', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('450_vault_store rollback', () => {
  let h: PgHarness | undefined;
  const stores: PgVaultStore[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) await store.close(); await h?.dispose(); h = undefined; });

  it('up, committed down, up: the down removes only the vault, and the re-applied store works and stays closed to tm8_app', async () => {
    h = await pgHarness();
    // Graph-side data the rollback must not touch.
    await h.admin.query("create table public.rollback_sentinel (id integer primary key, note text not null); insert into public.rollback_sentinel values (1, 'graph row')");
    expect(await appRoleVaultReach(h.admin)).toEqual(NO_APP_ROLE_REACH);
    const before = newLogin();
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(before, fakeSecret()));
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(event));
    expect((await h.store.health()).ok).toBe(true);

    // One simple-protocol query is one implicit transaction: the same unit as `psql -1 -f`.
    const down = await sql('rollback/450_vault_store.down.sql');
    await h.admin.query(down);
    expect((await h.admin.query("select to_regnamespace('vault') as schema")).rows[0].schema).toBeNull();
    // Roles are cluster-wide and may be retained for another database, but hold nothing here.
    expect(await vaultRoleDependents(h.admin)).toBe(0);
    expect((await h.admin.query('select id, note from public.rollback_sentinel')).rows).toEqual([{ id: 1, note: 'graph row' }]);
    expect((await h.admin.query("select count(*) as n from pg_roles where rolname = 'tm8_app'")).rows[0].n).toBe('1');
    // Fail closed: a broker over a rolled-back database is unhealthy, so startBroker refuses.
    expect((await h.store.health()).ok).toBe(false);
    // Re-running the rollback after a partial or repeated run is a no-op.
    await h.admin.query(down);

    await h.admin.query(await sql('migrations/450_vault_store.sql'));
    const roles = (await h.admin.query("select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolpassword from pg_authid where rolname like 'tm8_vault\\_%' order by rolname")).rows;
    expect(roles.map((role) => role.rolname)).toEqual(['tm8_vault_audit_writer', 'tm8_vault_broker', 'tm8_vault_owner']);
    for (const role of roles) expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolpassword: null });
    expect(await appRoleVaultReach(h.admin)).toEqual(NO_APP_ROLE_REACH);

    const store = new PgVaultStore({ connectionString: h.url, role: 'tm8_vault_broker', clock: new FixedClock(T0) });
    stores.push(store);
    expect((await store.health()).ok).toBe(true);
    // The rollback destroyed the vault's rows: the re-applied store starts a new, empty chain.
    expect(await store.transaction(sys, (tx) => tx.audit.head())).toMatchObject({ seq: 0 });
    expect(await store.transaction(scopeOf(testCaller), (tx) => tx.items.get(before.id))).toBeNull();
    const after = newLogin();
    await store.transaction(scopeOf(testCaller), (tx) => tx.items.create(after, fakeSecret()));
    expect(await store.transaction(scopeOf(testCaller), (tx) => tx.items.get(after.id))).toMatchObject({ id: after.id });
    await store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(event));
    expect(await store.transaction(sys, (tx) => tx.audit.head())).toMatchObject({ seq: 1 });
    expect((await h.admin.query('select count(*) as n from public.rollback_sentinel')).rows[0].n).toBe('1');
  });
});
