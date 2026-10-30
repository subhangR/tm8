/**
 * The `mobile` auth kind's migration (TM8 Mobile S4, task 01a1867c) restates
 * every live function and CHECK constraint that spells the human kinds out,
 * with 'mobile' added beside 'cli'. These pins keep that honest without a
 * database, over the chain in the order main runs it: the lane files S4 as 391
 * and the Merger renumbers it above main's top, so `asMerged()`
 * (mobile-auth-kind-chain.ts) puts it after every file numbered at or below
 * MAIN_TOP. In that order:
 *   1. every function and CHECK the S4 migration writes equals its previous
 *      definition (the last writer before S4) once comments are dropped and the
 *      added 'mobile' is taken back out, so S4 never silently reverts another
 *      migration's body or kind list (395's bridge_runtime included);
 *   2. it missed none: no function or CHECK whose definition before S4 names
 *      'browser' and 'cli' in a list without 'mobile' is left as it was;
 *   3. END STATE: once the whole chain has run, the last writer of every live
 *      function and CHECK that names 'browser' and 'cli' names 'mobile' too.
 * Its hand-run rollback (db/rollback) is held to the same previous definitions,
 * verbatim, so undoing S4 never reverts a later migration's body or kind either.
 * The pg twin (`db/mobile-auth-kind.pg.test.ts`) migrates a scratch database in
 * the same order and reads the end state off the catalog. The S4 file is found
 * by name, never by number, so the merge-time renumber is one rename.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MAIN_TOP, asMerged, s4File } from './mobile-auth-kind-chain.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'db/migrations');
const ROLLBACK = join(ROOT, 'db/rollback');
const FILES = readdirSync(MIGRATIONS).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
const S4 = s4File(FILES);
const CHAIN = asMerged(FILES);

interface Definition {
  file: string;
  name: string;
  header: string;
  body: string;
}

type Event = { at: number; drop: string } | { at: number; definition: Definition };

const DEFINE = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/gi;
const DROP = /drop\s+function\s+(?:if\s+exists\s+)?([a-z0-9_."]+)/gi;
const DOLLAR = /\$[A-Za-z0-9_]*\$/g;

const qualified = (name: string): string => {
  const bare = name.toLowerCase().replaceAll('"', '');
  return bare.includes('.') ? bare : `public.${bare}`;
};

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Each function definition and drop in `file`, in the order the file runs them. */
function events(file: string, dir: string = MIGRATIONS): Event[] {
  const text = stripComments(readFileSync(join(dir, file), 'utf8'));
  const found: Event[] = [];
  for (const match of text.matchAll(DEFINE)) {
    DOLLAR.lastIndex = match.index + match[0].length;
    const open = DOLLAR.exec(text);
    if (!open) continue;
    const close = text.indexOf(open[0], open.index + open[0].length);
    if (close < 0) continue;
    found.push({
      at: match.index,
      definition: {
        file,
        name: qualified(match[1]!),
        header: text.slice(match.index, open.index),
        body: text.slice(open.index + open[0].length, close),
      },
    });
  }
  for (const match of text.matchAll(DROP)) found.push({ at: match.index, drop: qualified(match[1]!) });
  return found.sort((a, b) => a.at - b.at);
}

/** The live definition of every function once `files` have run, in that order. */
function liveAfter(files: readonly string[]): Map<string, Definition> {
  const live = new Map<string, Definition>();
  for (const file of files) {
    for (const event of events(file)) {
      if ('drop' in event) live.delete(event.drop);
      else live.set(event.definition.name, event.definition);
    }
  }
  return live;
}

// --- CHECK constraints, keyed '<schema.table> <constraint>' ------------------

interface Check {
  file: string;
  name: string;
  expr: string;
}

type CheckEvent =
  | { check: Check }
  | { drop: string }
  | { dropTable: string }
  | { rename: [from: string, to: string] }
  | { renameTable: [from: string, to: string] };

/** `text` from the `(` at `open` to its matching `)`, exclusive of both. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Top-level comma-separated parts of `text` (commas inside parentheses stay). */
function parts(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((part) => part !== '');
}

const checkExpr = (part: string): string | undefined => {
  const match = /\bcheck\s*\(/i.exec(part);
  return match ? balanced(part, match.index + match[0].length - 1) : undefined;
};
const bareTable = (table: string): string => table.slice(table.indexOf('.') + 1);

/** The CHECK definitions, drops and renames in `file`, in order. Function bodies are skipped. */
function checkEvents(file: string, dir: string = MIGRATIONS): CheckEvent[] {
  const text = stripComments(readFileSync(join(dir, file), 'utf8')).replace(
    /(\$[A-Za-z0-9_]*\$)[\s\S]*?\1/g, ' ');
  const found: CheckEvent[] = [];
  for (const statement of text.split(';')) {
    const create = /^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s*\(/i.exec(statement);
    if (create) {
      const table = qualified(create[1]!);
      for (const part of parts(balanced(statement, create.index + create[0].length - 1))) {
        const expr = checkExpr(part);
        if (expr === undefined) continue;
        const named = /^constraint\s+([a-z0-9_]+)\s+check\b/i.exec(part);
        const column = /^([a-z0-9_]+)\s/i.exec(part);
        if (named) found.push({ check: { file, name: `${table} ${named[1]!.toLowerCase()}`, expr } });
        else if (column && !/^(?:primary|unique|foreign|check|exclude|like)\b/i.test(part)) {
          found.push({ check: { file, name: `${table} ${bareTable(table)}_${column[1]!.toLowerCase()}_check`, expr } });
        }
      }
      continue;
    }
    const alter = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z0-9_."]+)\s+([\s\S]*)$/i.exec(statement);
    if (alter) {
      const table = qualified(alter[1]!);
      for (const part of parts(alter[2]!)) {
        let match: RegExpExecArray | null;
        if ((match = /^add\s+constraint\s+([a-z0-9_]+)\s+check\b/i.exec(part))) {
          found.push({ check: { file, name: `${table} ${match[1]!.toLowerCase()}`, expr: checkExpr(part)! } });
        } else if ((match = /^drop\s+constraint\s+(?:if\s+exists\s+)?([a-z0-9_]+)/i.exec(part))) {
          found.push({ drop: `${table} ${match[1]!.toLowerCase()}` });
        } else if ((match = /^rename\s+constraint\s+([a-z0-9_]+)\s+to\s+([a-z0-9_]+)/i.exec(part))) {
          found.push({ rename: [`${table} ${match[1]!.toLowerCase()}`, `${table} ${match[2]!.toLowerCase()}`] });
        } else if ((match = /^rename\s+to\s+([a-z0-9_."]+)/i.exec(part))) {
          found.push({ renameTable: [table, qualified(match[1]!.includes('.') ? match[1]! : `${table.split('.')[0]}.${match[1]!}`)] });
        } else if ((match = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s/i.exec(part)) && checkExpr(part) !== undefined) {
          found.push({ check: { file, name: `${table} ${bareTable(table)}_${match[1]!.toLowerCase()}_check`, expr: checkExpr(part)! } });
        } else if ((match = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?([a-z0-9_]+)/i.exec(part))) {
          found.push({ drop: `${table} ${bareTable(table)}_${match[1]!.toLowerCase()}_check` });
        }
      }
      continue;
    }
    const dropTables = /^\s*drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*$/i.exec(statement);
    if (dropTables) for (const table of parts(dropTables[1]!)) found.push({ dropTable: qualified(table) });
  }
  return found;
}

/** The live CHECK constraints once `files` have run, in that order. */
function checksAfter(files: readonly string[]): Map<string, Check> {
  const live = new Map<string, Check>();
  for (const file of files) {
    for (const event of checkEvents(file)) {
      if ('check' in event) live.set(event.check.name, event.check);
      else if ('drop' in event) live.delete(event.drop);
      else if ('rename' in event) {
        const check = live.get(event.rename[0]);
        live.delete(event.rename[0]);
        if (check) live.set(event.rename[1], { ...check, name: event.rename[1] });
      } else {
        const [from, to] = 'dropTable' in event ? [event.dropTable, undefined] : event.renameTable;
        for (const [name, check] of [...live]) {
          if (!name.startsWith(`${from} `)) continue;
          live.delete(name);
          if (to) live.set(`${to} ${name.slice(from.length + 1)}`, { ...check, name: `${to} ${name.slice(from.length + 1)}` });
        }
      }
    }
  }
  return live;
}

/** The lists in `sql` that name 'browser' and 'cli' but not 'mobile'. */
function unwidened(sql: string): string[] {
  return [...sql.matchAll(/\(([^()]*'cli'[^()]*)\)/g)]
    .map((match) => match[1]!)
    .filter((list) => list.includes("'browser'") && !list.includes("'mobile'"));
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const withoutMobile = (text: string): string => text.replace(/,\s*'mobile'/g, '');
const normalized = (d: Definition): string =>
  squash(d.header.toLowerCase().replace(/^create\s+function/, 'create or replace function')) + ' $$ ' + squash(d.body);
const shape = (d: Definition): string => withoutMobile(normalized(d));
const checkShape = (c: Check): string => squash(c.expr.toLowerCase());

describe('the mobile auth kind migration', () => {
  it('exists, found by name, and runs after every file numbered at or below main\'s top at its last merge', () => {
    expect(S4).toMatch(/^\d{3}_mobile_auth_kind\.sql$/);
    const s4 = Number.parseInt(S4.slice(0, 3), 10);
    const after = Math.max(MAIN_TOP, s4);
    const at = CHAIN.indexOf(S4);
    expect(CHAIN.slice(0, at).every((file) => Number.parseInt(file.slice(0, 3), 10) <= after)).toBe(true);
    expect(CHAIN.slice(at + 1).every((file) => Number.parseInt(file.slice(0, 3), 10) > after)).toBe(true);
    expect([...CHAIN].sort()).toEqual(FILES);
  });

  const before = CHAIN.slice(0, CHAIN.indexOf(S4));
  const mine = events(S4).flatMap((event) => ('definition' in event ? [event.definition] : []));
  const myChecks = checkEvents(S4).flatMap((event) => ('check' in event ? [event.check] : []));

  it('restates each function as its previous definition with only mobile added', () => {
    const live = liveAfter(before);
    const drift: string[] = [];
    for (const definition of mine) {
      const previous = live.get(definition.name);
      if (!previous) drift.push(`${definition.name}: no earlier definition to restate`);
      else if (shape(definition) !== shape(previous)) {
        drift.push(`${definition.name}: differs from ${previous.file} by more than 'mobile' (re-copy that body)`);
      } else if (!definition.body.includes("'mobile'")) {
        drift.push(`${definition.name}: restated without adding 'mobile'`);
      }
    }
    expect(drift).toEqual([]);
    expect(mine.length).toBeGreaterThan(0);
  });

  it('restates each CHECK as its previous definition with only mobile added (395\'s bridge_runtime kept)', () => {
    const live = checksAfter(before);
    const drift: string[] = [];
    for (const check of myChecks) {
      const previous = live.get(check.name);
      if (!previous) drift.push(`${check.name}: no earlier definition to restate`);
      else if (withoutMobile(checkShape(check)) !== checkShape(previous)) {
        drift.push(`${check.name}: differs from ${previous.file} by more than 'mobile' (re-copy that list)`);
      } else if (!check.expr.includes("'mobile'")) {
        drift.push(`${check.name}: restated without adding 'mobile'`);
      }
    }
    expect(drift).toEqual([]);
    expect(myChecks.map((check) => check.name).sort()).toEqual([
      'public.auth_sessions auth_sessions_kind_check',
      'public.chat_turns chat_turns_requested_by_auth_kind_check',
    ]);
  });

  it('leaves no earlier function or CHECK naming browser and cli without mobile', () => {
    const restated = new Set(mine.map((definition) => definition.name));
    const missed = [...liveAfter(before).values()]
      .filter((definition) => unwidened(definition.body).length > 0 && !restated.has(definition.name))
      .map((definition) => `${definition.name} (${definition.file})`);
    const rechecked = new Set(myChecks.map((check) => check.name));
    const missedChecks = [...checksAfter(before).values()]
      .filter((check) => unwidened(`(${check.expr})`).length > 0 && !rechecked.has(check.name))
      .map((check) => `${check.name} (${check.file})`);
    expect([...missed, ...missedChecks]).toEqual([]);
  });

  it('END STATE: the last writer of every live function and CHECK that names browser and cli names mobile too', () => {
    const functions = [...liveAfter(CHAIN).values()]
      .filter((definition) => unwidened(definition.body).length > 0)
      .map((definition) => `${definition.name} (last written by ${definition.file})`);
    const checks = [...checksAfter(CHAIN).values()]
      .filter((check) => unwidened(`(${check.expr})`).length > 0)
      .map((check) => `${check.name} (last written by ${check.file})`);
    expect([...functions, ...checks]).toEqual([]);
  });

  it('its rollback puts back the previous definition of each of those functions and CHECKs, verbatim', () => {
    const rollback = S4.replace(/\.sql$/, '.down.sql');
    const live = liveAfter(before);
    const restored = events(rollback, ROLLBACK).flatMap((event) => ('definition' in event ? [event.definition] : []));
    expect(restored.map((definition) => definition.name).sort()).toEqual(mine.map((definition) => definition.name).sort());
    const drift = restored
      .filter((definition) => normalized(definition) !== normalized(live.get(definition.name)!))
      .map((definition) => `${definition.name}: differs from ${live.get(definition.name)!.file} (re-copy that body verbatim)`);
    const liveChecks = checksAfter(before);
    const restoredChecks = checkEvents(rollback, ROLLBACK).flatMap((event) => ('check' in event ? [event.check] : []));
    expect(restoredChecks.map((check) => check.name).sort()).toEqual(myChecks.map((check) => check.name).sort());
    const checkDrift = restoredChecks
      .filter((check) => checkShape(check) !== checkShape(liveChecks.get(check.name)!))
      .map((check) => `${check.name}: differs from ${liveChecks.get(check.name)!.file} (re-copy that list verbatim)`);
    expect([...drift, ...checkDrift]).toEqual([]);
  });
});
