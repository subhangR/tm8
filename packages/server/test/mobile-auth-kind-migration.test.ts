/**
 * The `mobile` auth kind's migration (TM8 Mobile S4, task 01a1867c) restates
 * every live function that spells the human kinds out, with 'mobile' added
 * beside 'cli'. Three pins keep that honest without a database:
 *   1. every function the S4 migration defines equals its previous definition
 *      (the latest one in a migration that sorts before it) once comments are
 *      dropped and the added 'mobile' is taken back out. A migration numbered
 *      below S4 that lands later and redefines one of them fails here, instead
 *      of being silently reverted by S4 on every fresh database;
 *   2. it missed none: no function whose latest definition before S4 names
 *      'browser' and 'cli' in a list without 'mobile' is left as it was;
 *   3. nothing after S4 names 'browser' and 'cli' in a list without 'mobile'.
 * The pg twin (`db/mobile-auth-kind.pg.test.ts`) asserts the same end state on
 * a migrated database. The S4 file is found by name, never by number, so a
 * renumber is one rename.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'db/migrations');
const FILES = readdirSync(MIGRATIONS).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
const S4 = FILES.find((file) => file.endsWith('_mobile_auth_kind.sql'));

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
function events(file: string): Event[] {
  const text = stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'));
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

/** The live definition of every function once `files` have run. */
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

/** The lists in `sql` that name 'browser' and 'cli' but not 'mobile'. */
function unwidened(sql: string): string[] {
  return [...sql.matchAll(/\(([^()]*'cli'[^()]*)\)/g)]
    .map((match) => match[1]!)
    .filter((list) => list.includes("'browser'") && !list.includes("'mobile'"));
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const withoutMobile = (text: string): string => text.replace(/,\s*'mobile'/g, '');
const shape = (d: Definition): string => withoutMobile(
  squash(d.header.toLowerCase().replace(/^create\s+function/, 'create or replace function')) + ' $$ ' + squash(d.body));

describe('the mobile auth kind migration', () => {
  it('exists, found by name', () => {
    expect(S4).toBeDefined();
  });

  const before = FILES.slice(0, FILES.indexOf(S4!));
  const mine = events(S4!).flatMap((event) => ('definition' in event ? [event.definition] : []));

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

  it('leaves no earlier function naming browser and cli without mobile', () => {
    const restated = new Set(mine.map((definition) => definition.name));
    const missed = [...liveAfter(before).values()]
      .filter((definition) => unwidened(definition.body).length > 0 && !restated.has(definition.name))
      .map((definition) => `${definition.name} (${definition.file})`);
    expect(missed).toEqual([]);
  });

  it('is not undone later: no migration after it names browser and cli without mobile', () => {
    const later = FILES.slice(FILES.indexOf(S4!) + 1)
      .flatMap((file) => unwidened(stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'))).map((list) => `${file}: (${list})`));
    expect(later).toEqual([]);
  });
});
