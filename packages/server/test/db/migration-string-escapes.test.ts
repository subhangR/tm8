/**
 * 387 — no migration may use a backslash escape PostgreSQL does not define.
 *
 * PostgreSQL's E'' strings know \b \f \n \r \t, octal digits, \x, \u, \U, \\
 * and \'. Every other backslash pair is the character itself, silently: E'\v'
 * is the letter v. 037, 085 and 223 spelled the whitespace set E' \t\n\r\f\v',
 * so btrim stripped a leading or trailing 'v' from every session claim, every
 * renamed session title and every selection header (387 replaces all three).
 * JavaScript and most other languages DO know \v, which is how it read right.
 *
 * This file needs no database, so it runs on every `check.sh --fast`. It
 * scans the migration files as text: those three historical files are the only
 * ones allowed to carry such an escape (applied migrations are checksummed and
 * never edited), and a new hit anywhere fails here, naming the file and line.
 * The live catalog is checked by claim-text-vertical-tab.pg.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR } from './w1-pg.js';

/** The escapes PostgreSQL defines inside E'...' (4.1.2.2). */
const KNOWN_ESCAPES = new Set(['b', 'f', 'n', 'r', 't', 'x', 'u', 'U', '\\', "'", '0', '1', '2', '3', '4', '5', '6', '7']);

/** Applied before 387 and superseded by it; checksummed, so they stay as written. */
const SUPERSEDED_BY_387 = [
  '037_w2_absent_means_merge_and_unbound_write_repairs.sql:341 \\v',
  '085_rename_work_session.sql:67 \\v',
  '223_entity_headers_lenient.sql:76 \\v',
];

/**
 * Every `<line> \<char>` where an E'' literal uses an escape PostgreSQL does
 * not define. Skips `--` and block comments and plain '' literals; reads
 * through dollar quotes, because function bodies are where the literals live.
 */
function unknownEscapes(sql: string): string[] {
  const found: string[] = [];
  let line = 1;
  let i = 0;
  const skipQuoted = (from: number, escapes: boolean): number => {
    let j = from;
    while (j < sql.length) {
      const c = sql[j];
      if (c === '\n') line += 1;
      if (escapes && c === '\\') {
        const next = sql[j + 1] ?? '';
        if (!KNOWN_ESCAPES.has(next)) found.push(`${line} \\${next}`);
        if (next === '\n') line += 1;
        j += 2;
        continue;
      }
      if (c === "'" && sql[j + 1] === "'") { j += 2; continue; }
      if (c === "'") return j + 1;
      j += 1;
    }
    return j;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (let k = i; k < stop; k += 1) if (sql[k] === '\n') line += 1;
      i = stop;
      continue;
    }
    if ((c === 'E' || c === 'e') && sql[i + 1] === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? ' ')) {
      i = skipQuoted(i + 2, true);
      continue;
    }
    if (c === "'") { i = skipQuoted(i + 1, false); continue; }
    i += 1;
  }
  return found;
}

describe('387 — E-string escapes in migrations', () => {
  it('the scanner flags \\v and other undefined escapes, and nothing PostgreSQL defines', () => {
    expect(unknownEscapes(String.raw`select btrim(x, E' \t\n\r\f\v')`)).toEqual(['1 \\v']);
    expect(unknownEscapes(String.raw`select E'\d+', E'a\.b'`)).toEqual(['1 \\d', '1 \\.']);
    expect(unknownEscapes(String.raw`select btrim(x, E' \t\n\r\f\x0B'), E'\\v', E'it''s\'', E'\101A'`)).toEqual([]);
    // Plain literals and comments are not E-strings: '\v' is backslash + v, on purpose or not.
    expect(unknownEscapes(String.raw`select '\v' -- E'\v'` + '\n' + String.raw`/* E'\v' */ select 1`)).toEqual([]);
    expect(unknownEscapes(String.raw`select type'x', ne'\v'`)).toEqual([]);
    expect(unknownEscapes(`select 1;\n\ndo $$ begin perform E'\\v'; end $$;`)).toEqual(['3 \\v']);
  });

  it('no migration uses one, except the three 387 supersedes', () => {
    const hits = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      .sort()
      .flatMap((file) => unknownEscapes(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')).map((hit) => `${file}:${hit}`));
    expect(
      hits,
      "an E'' literal uses a backslash escape PostgreSQL does not define, so it is the bare letter " +
        "(E'\\v' = 'v'); write the byte as \\x0B / chr(11), or the character itself",
    ).toEqual(SUPERSEDED_BY_387);
  });
});
