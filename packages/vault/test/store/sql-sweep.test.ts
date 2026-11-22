import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sqlCalls, sweep } from '../support/sql-sweep.js';

/**
 * Review addendum 2, C1: every query the vault package sends keeps values out of the SQL text.
 * A new interpolation, a concatenation or a computed SQL argument fails here until someone has
 * reviewed it and added it below.
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

/**
 * The reviewed interpolations: table and column identifiers in the generic store map
 * (store/postgres-repos.ts, SqlMap), and the placeholder numbers that follow them.
 * - `this.#table` and `this.#keys` come from the compile-time TABLES constant.
 * - `this.#where(...)` joins `snake(key) = $n` over those same keys.
 * - `names` are record field names passed through `sqlColumn`, which refuses anything but
 *   `[a-z][a-z0-9_]{0,62}` (sql-identifier.test.ts).
 */
const REVIEWED_INTERPOLATIONS = new Set([
  'this.#table',
  'this.#where()',
  'this.#where(values.length)',
  "names.map((name, index) => `${name} = $${index + 1}`).join(', ')",
  'values.length + this.#keys.length + 1',
  "names.join(', ')",
  "names.map((_, index) => `$${index + 1}`).join(', ')",
  "this.#keys.map(snake).join(', ')",
]);
/** The reviewed bare names: PgCtx.query's own parameter, which every repository call reaches. */
const REVIEWED_NAMES = new Set(['store/postgres-repos.ts:sql']);

describe('review addendum 2 C1: no string-built SQL in the vault package', () => {
  const calls = sweep(SRC);

  it('finds the queries it sweeps, so a parser change cannot pass with nothing found', () => {
    expect(calls.length).toBeGreaterThanOrEqual(30);
    expect(new Set(calls.map((call) => call.kind))).toEqual(new Set(['literal', 'template', 'name']));
  });

  it('passes every value as a bound parameter; only reviewed identifiers are interpolated', () => {
    const unreviewed = calls.flatMap((call) => {
      const where = `${call.file}:${call.line}`;
      if (call.kind === 'other') return [`${where} computed or concatenated SQL`];
      if (call.kind === 'name' && !REVIEWED_NAMES.has(`${call.file}:${call.name}`)) return [`${where} SQL from ${call.name}`];
      return call.interpolations.filter((text) => !REVIEWED_INTERPOLATIONS.has(text)).map((text) => `${where} interpolates ${text}`);
    });
    expect(unreviewed).toEqual([]);
  });

  it('every vault function lists pg_temp last; every SECURITY DEFINER names its relations with their schema and runs no dynamic SQL', () => {
    // `execute function` (a trigger) and `grant execute on` (a privilege) are not dynamic SQL.
    const DYNAMIC = /\bexecute\s+(?!function\b|on\b)([^;]*);/gi;
    const functions: string[] = [];
    const definers: string[] = [];
    const dynamic: string[] = [];
    for (const name of ['450_vault_store.sql', '451_vault_alert_notifications.sql']) {
      const sql = readFileSync(`${MIGRATIONS}/${name}`, 'utf8');
      for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$([^;]*);/gi)) {
        const [, fn, before, , body, after] = match as unknown as string[];
        const attributes = `${before} ${after}`;
        functions.push(fn!);
        // Unlisted, pg_temp is searched first for type names (450's header; postgres-security.test.ts).
        const path = /set\s+search_path\s*(?:=|to)\s*([^\n]*?)\s+as\s*$/im.exec(before!)?.[1] ?? /set\s+search_path\s*(?:=|to)\s*([^\n;]*)/i.exec(attributes)?.[1];
        expect(path?.split(',').map((schema) => schema.trim()).at(-1), fn).toBe('pg_temp');
        if (!/security\s+definer/i.test(attributes)) continue;
        definers.push(fn!);
        // `into strict` is plpgsql's SELECT INTO and `is not distinct from` an operator, not relations.
        const relations = [...body!.matchAll(/\b(?<!distinct\s+)(?:from|join|update|insert\s+into|delete\s+from)\s+([a-z_][\w.]*)/gi)].map((ref) => ref[1]!);
        expect(relations.filter((relation) => !relation.includes('.')), fn).toEqual([]);
        expect([...body!.matchAll(DYNAMIC)], fn).toEqual([]);
      }
      dynamic.push(...[...sql.matchAll(DYNAMIC)].map((statement) => `${name}: ${statement[1]!.trim()}`));
    }
    expect([functions.length, definers.length]).toEqual([15, 9]);
    // The one dynamic statement, outside any function, quotes the role it grants to with %I.
    expect(dynamic).toEqual(["450_vault_store.sql: format('grant tm8_vault_owner, tm8_vault_audit_writer to %I', current_user)"]);
  });

  it('the relay (packages/server/src/vault) sends two constant queries and binds every value', () => {
    const RELAY = fileURLToPath(new URL('../../../server/src/vault', import.meta.url));
    // db.query(claims, MEMBERSHIP_SQL) takes the caller's claims first and the SQL second.
    expect(sweep(RELAY).map(({ file, kind, name }) => `${file} ${kind} ${name}`)).toEqual(['relay.ts name claims', 'relay.ts name NOTIFY_SQL']);
    const relay = readFileSync(`${RELAY}/relay.ts`, 'utf8');
    expect(relay).toContain('db.query<Membership>(claims, MEMBERSHIP_SQL)');
    for (const name of ['MEMBERSHIP_SQL', 'NOTIFY_SQL']) {
      const text = new RegExp(`^const ${name} = (['\`])([^'\`]*)\\1;$`, 'm').exec(relay)?.[2];
      expect(text, name).toMatch(/^select /);
      expect(text, name).not.toContain('${');
    }
  });
});

describe('the C1 sweep parser', () => {
  const kinds = (source: string) => sqlCalls('x.ts', source).map(({ kind, name, interpolations }) => ({ kind, name, interpolations }));

  it('accepts a literal with bound parameters, on one line or several', () => {
    expect(kinds("db.query('select 1 from t where id = $1', [id])")).toEqual([{ kind: 'literal', name: undefined, interpolations: [] }]);
    expect(kinds("db.query<Row>(\n  \"select 1\"\n)")).toEqual([{ kind: 'literal', name: undefined, interpolations: [] }]);
  });

  it('flags concatenation, a config object and a computed argument', () => {
    expect(kinds("db.query('select * from t where id = ' + id)")[0]!.kind).toBe('other');
    expect(kinds('db.query(`select * from t` + where)')[0]!.kind).toBe('other');
    expect(kinds("db.query({ text: 'select 1', values })")[0]!.kind).toBe('other');
    expect(kinds('db.query(build(id), [])')[0]!.kind).toBe('other');
  });

  it('reports each interpolation, including nested templates and `$${n}` placeholders', () => {
    expect(kinds("db.query(`select * from t where id = '${id}'`)")).toEqual([{ kind: 'template', name: undefined, interpolations: ['id'] }]);
    expect(kinds("q.query(`update t set ${names.map((name, index) => `${name} = $${index + 1}`).join(', ')} where k = $${n + 1}`, v)")[0]!.interpolations)
      .toEqual(["names.map((name, index) => `${name} = $${index + 1}`).join(', ')", 'n + 1']);
    expect(kinds("q.query(`select '}' as a, ${f({ a: '}' })}`)")[0]!.interpolations).toEqual(["f({ a: '}' })"]);
  });

  it('names a bare identifier, so a sweep can check where its SQL came from', () => {
    expect(kinds('client.query(NOTIFY_SQL, [a])')).toEqual([{ kind: 'name', name: 'NOTIFY_SQL', interpolations: [] }]);
  });

  it('flags the injection shapes the vault must never contain', () => {
    const unreviewed = (source: string) => sqlCalls('x.ts', source)
      .some((call) => call.kind === 'other' || call.interpolations.some((text) => !REVIEWED_INTERPOLATIONS.has(text)));
    expect(unreviewed("db.query(`select * from vault.items where name = '${name}'`)")).toBe(true);
    expect(unreviewed("db.query(`select * from vault.${this.#table} order by ${req.sort}`)")).toBe(true);
    expect(unreviewed("db.query('delete from vault.items where id = ' + id)")).toBe(true);
    expect(unreviewed('db.query(`select * from vault.${this.#table} where ${this.#where()}`, parts)')).toBe(false);
  });
});
