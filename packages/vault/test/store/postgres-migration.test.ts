import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, type AuditBody } from '../../src/core-types.js';
import { PgVaultStore } from '../../src/store/postgres.js';
import { FixedClock, OWNER_ID, SPACE_A, T0, fakeSecret, newLogin, scopeOf, testCaller } from '../support/kit.js';
import { NO_APP_ROLE_REACH, PG_ENABLED, PG_REASON, appRoleVaultReach, holdingVaultRoles, pgHarness, type PgHarness } from './pg-harness.js';

const sql = (path: string) => readFile(new URL(`../../../../db/${path}`, import.meta.url), 'utf8');
const sys = { kind: 'system', purpose: 'audit' } as const;
const event: AuditBody = { action: 'session.signed_in', actor: actorOf(testCaller), itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: {} };

/** Rows in THIS database that still depend on a vault role: owners, ACL entries, default ACLs. */
const vaultRoleDependents = async (admin: PgHarness['admin']): Promise<number> => Number((await admin.query(`select count(*) as n from pg_shdepend s
  where s.dbid = (select oid from pg_database where datname = current_database())
    and s.refclassid = 'pg_authid'::regclass and s.refobjid in (select oid from pg_roles where rolname like 'tm8_vault\\_%')`)).rows[0].n);

/**
 * The vault roles held HERE, or held ELSEWHERE: by another database or a shared object.
 * DROP ROLE refuses exactly the roles held anywhere.
 */
const vaultRolesHeld = async (admin: PgHarness['admin'], where: 'here' | 'elsewhere'): Promise<string[]> => (await admin.query(`select distinct r.rolname from pg_shdepend s
  join pg_roles r on r.oid = s.refobjid
  where s.refclassid = 'pg_authid'::regclass and r.rolname like 'tm8_vault\\_%'
    and (s.dbid = (select oid from pg_database where datname = current_database())) = $1
  order by 1`, [where === 'here'])).rows.map((row) => row.rolname as string);
const vaultRoles = async (admin: PgHarness['admin']): Promise<string[]> =>
  (await admin.query("select rolname from pg_roles where rolname like 'tm8_vault\\_%' order by 1")).rows.map((row) => row.rolname as string);

if (!PG_ENABLED) describe('450_vault_store rollback', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('450_vault_store rollback', () => {
  let h: PgHarness | undefined;
  const stores: PgVaultStore[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) await store.close(); await h?.dispose(); h = undefined; });

  it('up, committed down, up: the down removes only the vault, and the re-applied store works and stays closed to tm8_app', async () => {
    const harness = h = await pgHarness();
    // Graph-side data the rollback must not touch.
    await h.admin.query("create table public.rollback_sentinel (id integer primary key, note text not null); insert into public.rollback_sentinel values (1, 'graph row')");
    expect(await appRoleVaultReach(h.admin)).toEqual(NO_APP_ROLE_REACH);
    const before = newLogin();
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(before, fakeSecret()));
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append(event));
    expect((await h.store.health()).ok).toBe(true);

    // The roles are cluster-global, so the committed down runs alone: no other suite's
    // database is between holds while it drops them (pg-harness.ts, holdingVaultRoles).
    await holdingVaultRoles('exclusive', async () => {
      const heldElsewhere = await vaultRolesHeld(harness.admin, 'elsewhere');
      // One simple-protocol query is one implicit transaction: the same unit as `psql -1 -f`.
      const down = await sql('rollback/450_vault_store.down.sql');
      await harness.admin.query(down);
      expect((await harness.admin.query("select to_regnamespace('vault') as schema")).rows[0].schema).toBeNull();
      // Nothing here holds a vault role any more, and the down dropped exactly the roles no
      // other database holds: the last vault to go takes them, any other vault keeps them.
      expect(await vaultRoleDependents(harness.admin)).toBe(0);
      expect(await vaultRoles(harness.admin)).toEqual(heldElsewhere);
      expect((await harness.admin.query('select id, note from public.rollback_sentinel')).rows).toEqual([{ id: 1, note: 'graph row' }]);
      expect((await harness.admin.query("select count(*) as n from pg_roles where rolname = 'tm8_app'")).rows[0].n).toBe('1');
      // Fail closed: a broker over a rolled-back database is unhealthy, so startBroker refuses.
      expect((await harness.store.health()).ok).toBe(false);
      // Re-running the rollback after a partial or repeated run is a no-op.
      await harness.admin.query(down);
      expect(await vaultRoles(harness.admin)).toEqual(heldElsewhere);

      // The re-apply re-creates any dropped role, and this database holds all three again.
      await harness.admin.query(await sql('migrations/450_vault_store.sql'));
      const roles = (await harness.admin.query("select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolpassword from pg_authid where rolname like 'tm8_vault\\_%' order by rolname")).rows;
      expect(roles.map((role) => role.rolname)).toEqual(['tm8_vault_audit_writer', 'tm8_vault_broker', 'tm8_vault_owner']);
      for (const role of roles) expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolpassword: null });
      expect(await vaultRolesHeld(harness.admin, 'here')).toEqual(['tm8_vault_audit_writer', 'tm8_vault_broker', 'tm8_vault_owner']);
    });
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
