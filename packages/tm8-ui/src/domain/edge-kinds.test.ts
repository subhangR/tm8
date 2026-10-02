import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDGE_KINDS, relationsOf } from './edge-kinds';
import { EDGE_VERBS } from './edge-verbs';
import { allKinds } from './registry';

/**
 * `EDGE_KINDS` and `EDGE_VERBS` are two halves of the same registry rows, and
 * `edge-verbs.test.ts` already holds the verb map to the migrations. Holding
 * the kinds map to the verb map therefore holds it to the migrations too — a
 * new edge type that lands without endpoint kinds here fails, and a type the
 * migrations dropped fails from the other side.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

interface Endpoints {
  src: string[];
  dst: string[];
}

/** `array['a', 'b']` → `['a', 'b']`; `array['*']` → `['*']`. */
function literals(sql: string): string[] {
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

/**
 * Split one `( … )` tuple's body at top-level commas, respecting nested
 * parentheses, brackets and quoted strings — the values carry `array[…]`,
 * `jsonb_build_object(…)` and descriptions with commas in them.
 */
function tupleValues(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "'") {
      i += 1;
      while (i < body.length && !(body[i] === "'" && body[i + 1] !== "'")) i += body[i] === "'" ? 2 : 1;
    } else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out;
}

/** The `(…)` tuples following `values`, as raw bodies, stopping at the statement's `;`. */
function tuplesAfter(sql: string, from: number): string[] {
  const bodies: string[] = [];
  let i = from;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ';') break;
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '(') {
      let depth = 0;
      let j = i;
      for (; j < sql.length; j += 1) {
        const c = sql[j];
        if (c === "'") {
          j += 1;
          while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
        } else if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodies.push(sql.slice(i + 1, j));
      i = j + 1;
      /* After a tuple only `,` continues the list; `on conflict` or anything else ends it. */
      const rest = sql.slice(i).match(/^\s*(,|--[^\n]*\n\s*,)?/);
      if (!rest || rest[0].trim() === '') break;
      i += rest[0].length;
      continue;
    }
    i += 1;
  }
  return bodies;
}

/**
 * REPLAY THE MIGRATIONS' EDGE-TYPE ENDPOINTS, in file order: every
 * `insert into edge_types (type, src_kinds, dst_kinds, …)` tuple registers a
 * type, and every `update edge_types set src_kinds/dst_kinds …` rewrites one —
 * both the `array[…]` form and the `array_append(col, 'x')` form the later
 * migrations use. The result is what `tm8 edge type list` prints on a node
 * at head, which is exactly what this file vendors.
 */
function migratedEndpoints(): Map<string, Endpoints> {
  const types = new Map<string, Endpoints>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');

    const insert = /insert\s+into\s+(?:public\.)?edge_types\s*\(([^)]*)\)\s*values/gi;
    let m: RegExpExecArray | null;
    while ((m = insert.exec(sql))) {
      const columns = m[1]!.split(',').map((c) => c.trim().toLowerCase());
      const typeAt = columns.indexOf('type');
      const srcAt = columns.indexOf('src_kinds');
      const dstAt = columns.indexOf('dst_kinds');
      expect(typeAt, `${file}: insert names no type column`).toBeGreaterThanOrEqual(0);
      for (const body of tuplesAfter(sql, insert.lastIndex)) {
        const values = tupleValues(body);
        const type = literals(values[typeAt] ?? '')[0];
        if (!type) continue;
        types.set(type, { src: literals(values[srcAt] ?? ''), dst: literals(values[dstAt] ?? '') });
      }
    }

    const update = /update\s+(?:public\.)?edge_types\s+set\s+([\s\S]*?)\s+where\s+type\s*=\s*'([^']+)'/gi;
    while ((m = update.exec(sql))) {
      const assignments = m[1]!;
      const type = m[2]!;
      const row = types.get(type);
      expect(row, `${file}: update of unregistered edge type ${type}`).toBeDefined();
      if (!row) continue;
      for (const column of ['src_kinds', 'dst_kinds'] as const) {
        const key = column === 'src_kinds' ? 'src' : 'dst';
        const set = new RegExp(`${column}\\s*=\\s*array\\[([^\\]]*)\\]`, 'i').exec(assignments);
        if (set) row[key] = literals(set[1]!);
        const append = new RegExp(`${column}\\s*=\\s*array_append\\(\\s*${column}\\s*,\\s*'([^']+)'\\s*\\)`, 'i').exec(
          assignments,
        );
        if (append && !row[key].includes(append[1]!)) row[key] = [...row[key], append[1]!];
      }
    }
  }
  return types;
}

describe('EDGE_KINDS — the edge-type registry, endpoint half', () => {
  it('matches the migrations, inserts and updates replayed in order (review M2)', () => {
    const migrated = migratedEndpoints();
    expect(migrated.size).toBeGreaterThan(40);
    const diffs: string[] = [];
    for (const [type, row] of Object.entries(EDGE_KINDS)) {
      const truth = migrated.get(type);
      if (!truth) {
        diffs.push(`${type}: vendored but no migration registers it`);
        continue;
      }
      const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join(',') === [...b].sort().join(',');
      if (!same(row.src, truth.src)) diffs.push(`${type}.src vendored [${row.src}] ≠ migrations [${truth.src}]`);
      if (!same(row.dst, truth.dst)) diffs.push(`${type}.dst vendored [${row.dst}] ≠ migrations [${truth.dst}]`);
    }
    for (const type of migrated.keys()) if (!(type in EDGE_KINDS)) diffs.push(`${type}: registered by a migration, not vendored`);
    expect(diffs).toEqual([]);
  });

  it('names exactly the types EDGE_VERBS names', () => {
    expect(Object.keys(EDGE_KINDS).sort()).toEqual(Object.keys(EDGE_VERBS).sort());
  });

  it('every endpoint is a registry kind or the wildcard', () => {
    const known = new Set(allKinds().map((k) => k.kind));
    const offenders: string[] = [];
    for (const [type, row] of Object.entries(EDGE_KINDS)) {
      for (const kind of [...row.src, ...row.dst]) {
        if (kind !== '*' && !known.has(kind)) offenders.push(`${type} → ${kind}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every row carries a description, so the ledger never prints a bare id', () => {
    for (const row of Object.values(EDGE_KINDS)) expect(row.description.length).toBeGreaterThan(8);
  });

  it('relationsOf ranks a named endpoint above a wildcard admission', () => {
    const rows = relationsOf('task');
    const assigned = rows.find((r) => r.type === 'assigned_to' && r.direction === 'outgoing');
    expect(assigned).toMatchObject({ viaWildcard: false, peers: ['member', 'team_member'] });
    const related = rows.find((r) => r.type === 'relates_to' && r.direction === 'outgoing');
    expect(related?.viaWildcard).toBe(true);
    /* A task is never the TARGET of assigned_to. */
    expect(rows.find((r) => r.type === 'assigned_to' && r.direction === 'incoming')).toBeUndefined();
  });

  it('every collection kind has at least one relation (the wildcard edges see to it)', () => {
    for (const config of allKinds()) {
      if (config.kind.startsWith('c:')) continue;
      expect(relationsOf(config.kind).length, config.kind).toBeGreaterThan(0);
    }
  });
});
