/**
 * 450 creates each vault role only when it is missing. On a cluster where a role
 * of that name already exists, that role's attributes are whatever its creator
 * chose. The broker works as tm8_vault_broker (`set local role`), and row
 * security is skipped for a SUPERUSER or BYPASSRLS current role, so such a role
 * would void every tenant policy. 450 must refuse it.
 *
 * Roles are cluster-global. Each case therefore renames the three roles in the
 * migration text to names of its own, and never touches a real vault role or
 * the lock the other suites share (holdingVaultRoles).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENSURE_APP_ROLE, PG_ENABLED, PG_REASON, scratchUrl } from './pg-harness.js';

const ROLES = ['owner', 'broker', 'audit_writer'] as const;
type Role = (typeof ROLES)[number];

/** Every way a pre-made role can be unsafe that 450 refuses, made on one role of the case. */
const UNSAFE: ReadonlyArray<{ name: string; role: Role; make: (role: string) => string[] }> = [
  { name: 'a BYPASSRLS broker', role: 'broker', make: (role) => [`create role ${role} nologin noinherit bypassrls`] },
  { name: 'a SUPERUSER broker', role: 'broker', make: (role) => [`create role ${role} nologin noinherit superuser`] },
  { name: 'a LOGIN broker', role: 'broker', make: (role) => [`create role ${role} login noinherit`] },
  { name: 'an INHERIT owner', role: 'owner', make: (role) => [`create role ${role} nologin inherit`] },
  { name: 'a CREATEROLE audit writer', role: 'audit_writer', make: (role) => [`create role ${role} nologin noinherit createrole`] },
  { name: 'a CREATEDB owner', role: 'owner', make: (role) => [`create role ${role} nologin noinherit createdb`] },
  { name: 'a REPLICATION broker', role: 'broker', make: (role) => [`create role ${role} nologin noinherit replication`] },
  { name: 'a broker that is a member of another role', role: 'broker',
    make: (role) => [`create role ${role} nologin noinherit`, `grant pg_read_all_data to ${role}`] },
];

if (!PG_ENABLED) describe('450_vault_store refuses an unsafe pre-made vault role', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('450_vault_store refuses an unsafe pre-made vault role', () => {
  let migration = '';
  const cases: string[] = [];
  beforeAll(async () => { migration = await readFile(new URL('../../../../db/migrations/450_vault_store.sql', import.meta.url), 'utf8'); });

  const withAdmin = async <T>(work: (admin: pg.Client) => Promise<T>): Promise<T> => {
    const admin = new pg.Client({ connectionString: scratchUrl().toString() });
    admin.on('error', () => undefined);
    await admin.connect();
    try { return await work(admin); } finally { await admin.end().catch(() => undefined); }
  };

  afterEach(async () => {
    await withAdmin(async (admin) => {
      for (const prefix of cases.splice(0)) {
        await admin.query(`drop database if exists ${prefix}_db with (force)`);
        for (const role of ROLES) await admin.query(`drop role if exists ${prefix}_${role}`);
      }
    });
  });

  /** A fresh database and three role names of this case's own, matching no other suite's pattern. */
  const newCase = (): { prefix: string; role: (role: Role) => string } => {
    const prefix = `t8guard_${randomBytes(6).toString('hex')}`;
    cases.push(prefix);
    return { prefix, role: (role) => `${prefix}_${role}` };
  };

  /** Applies 450, with this case's role names, to a fresh database. */
  const apply = async (prefix: string): Promise<{ error: { code?: string; message: string } | null; schema: boolean }> => {
    const renamed = migration.replace(/\btm8_vault_(owner|broker|audit_writer)\b/g, `${prefix}_$1`);
    expect(renamed).not.toMatch(/\btm8_vault_(owner|broker|audit_writer)\b/);
    await withAdmin((admin) => admin.query(`create database ${prefix}_db`));
    const url = scratchUrl(); url.pathname = `/${prefix}_db`;
    const database = new pg.Client({ connectionString: url.toString() });
    database.on('error', () => undefined);
    await database.connect();
    try {
      await database.query(ENSURE_APP_ROLE);
      let error: { code?: string; message: string } | null = null;
      try { await database.query(renamed); } catch (caught) { error = { code: (caught as { code?: string }).code, message: (caught as Error).message }; }
      const schema = (await database.query("select to_regnamespace('vault') is not null as present")).rows[0].present as boolean;
      return { error, schema };
    } finally { await database.end().catch(() => undefined); }
  };

  it('applies cleanly when the roles are new, and creates them with exactly the safe attributes', async () => {
    const { prefix, role } = newCase();
    expect(await apply(prefix)).toEqual({ error: null, schema: true });
    const rows = await withAdmin(async (admin) => (await admin.query(`select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit,
        (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships
      from pg_roles r where rolname = any($1) order by rolname`, [ROLES.map(role)])).rows);
    expect(rows.map((row) => row.rolname)).toEqual([role('audit_writer'), role('broker'), role('owner')]);
    for (const row of rows) {
      expect(row).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
        rolreplication: false, rolinherit: false, memberships: 0 });
    }
  });

  it('applies cleanly over safe roles another database already made', async () => {
    const { prefix } = newCase();
    expect(await apply(prefix)).toEqual({ error: null, schema: true });
    // The second database of the same case reuses the roles the first one created.
    const second = `${prefix}_db`;
    await withAdmin((admin) => admin.query(`alter database ${second} rename to ${prefix}_first`));
    try {
      expect(await apply(prefix)).toEqual({ error: null, schema: true });
    } finally {
      await withAdmin((admin) => admin.query(`drop database if exists ${prefix}_first with (force)`));
    }
  });

  for (const unsafe of UNSAFE) {
    it(`refuses ${unsafe.name}, and leaves nothing behind`, async () => {
      const { prefix, role } = newCase();
      await withAdmin(async (admin) => { for (const statement of unsafe.make(role(unsafe.role))) await admin.query(statement); });
      const result = await apply(prefix);
      expect(result.error).toEqual({ code: '42501', message: 'vault: a vault role exists with attributes or memberships 450 does not grant' });
      expect(result.schema).toBe(false);
      // The apply is one transaction, so the two roles it would have created are gone with it.
      const left = await withAdmin(async (admin) => (await admin.query('select rolname from pg_roles where rolname = any($1) order by 1', [ROLES.map(role)])).rows.map((row) => row.rolname as string));
      expect(left).toEqual([role(unsafe.role)]);
    });
  }
});
