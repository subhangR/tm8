/**
 * Every product mint inserts a work session as `spawning`.
 *
 * Migration session_credential_binding's guard refuses `pending` on the
 * TRANSITION spawning -> running|idle, not on the row (spec §4 R2: "A trigger
 * refuses `pending → running`", narrowed). That narrowing is sound only while
 * leaving `spawning` is the one door into a run, i.e. while no product path
 * inserts a work session in any other status. A row inserted `running` would
 * start pending and never cross the guard; the sweep would report it, but
 * nothing would refuse it. This test reads the source so that the next insert
 * site cannot skip the door.
 *
 * Scope: every `insert into [public.]work_sessions` statement in every
 * migration (a superset of the latest definition of each function: an older
 * body that a later migration replaced is checked too, which can only add
 * failures), plus every file under packages/{name}/src. Each statement is read
 * whole, up to its top-level `;`, not a fixed line window: 101's `'spawning'`
 * sits eleven lines below its `insert into`.
 *
 * If you are here because this failed: insert `'spawning'` and transition the
 * session through `work_session_transition`, which is where the guard lives.
 * Do not add an exemption.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'db', 'migrations');
const PACKAGES = join(ROOT, 'packages');

/** The only status a product mint may insert. */
const MINT_STATUS = "'spawning'";

interface Site {
  file: string;
  line: number;
  /** The status expression per inserted row; null = the column is omitted. */
  statuses: Array<string | null>;
  problem?: string;
}

/** Blank out comments, keeping offsets (and so line numbers) intact. */
function stripSqlComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; }
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Index just past the SQL string literal opening at `start` ('' escapes). */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") { i += 2; continue; }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * The statement from `start` up to its top-level terminator: `;`, or the close
 * of an enclosing TS template/quote. Parens and string literals are respected.
 */
function statementFrom(text: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") { i = skipString(text, i); continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { if (depth === 0) break; depth -= 1; }
    else if ((c === ';' || c === '`') && depth === 0) break;
    i += 1;
  }
  return text.slice(start, i);
}

/** Split on top-level commas. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") { i = skipString(text, i) - 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/** The balanced `( … )` group opening at `open`; returns inner text and the index past `)`. */
function group(text: string, open: number): { inner: string; end: number } | null {
  if (text[open] !== '(') return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") { i = skipString(text, i) - 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 }; }
  }
  return null;
}

/** Parse one `insert into … work_sessions …` statement into its status value(s). */
export function parseInsert(stmt: string): Pick<Site, 'statuses' | 'problem'> {
  const head = /^insert\s+into\s+(?:public\.)?work_sessions\b\s*/i.exec(stmt);
  if (!head) return { statuses: [], problem: 'not a work_sessions insert' };
  let rest = stmt.slice(head[0].length);
  const cols = group(rest, 0);
  if (!cols) return { statuses: [], problem: 'no column list: the status cannot be read' };
  const names = splitTop(cols.inner).map((n) => n.replace(/"/g, '').toLowerCase());
  const at = names.indexOf('status');
  rest = rest.slice(cols.end).trimStart();

  const tuples: string[][] = [];
  if (/^values\b/i.test(rest)) {
    let i = rest.search(/\(/);
    while (i >= 0) {
      const g = group(rest, i);
      if (!g) return { statuses: [], problem: 'unbalanced VALUES tuple' };
      tuples.push(splitTop(g.inner));
      const tail = rest.slice(g.end);
      const next = /^\s*,\s*\(/.exec(tail);
      i = next ? g.end + next[0].length - 1 : -1;
    }
  } else if (/^(?:select|with)\b/i.test(rest)) {
    // The select list runs to the first top-level FROM (or the end).
    const body = rest.replace(/^select\s+(?:distinct\s+)?/i, '');
    let depth = 0;
    let end = body.length;
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (c === "'") { i = skipString(body, i) - 1; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (depth === 0 && /^from\b/i.test(body.slice(i)) && /\s/.test(body[i - 1] ?? ' ')) { end = i; break; }
    }
    tuples.push(splitTop(body.slice(0, end)).map((e) => e.replace(/\s+as\s+\w+\s*$/i, '')));
  } else {
    return { statuses: [], problem: 'neither VALUES nor SELECT' };
  }
  return { statuses: tuples.map((t) => (at < 0 ? null : (t[at] ?? '').replace(/\s+/g, ' ').trim())) };
}

/** Every work_sessions insert in `text`, each read as a whole statement. */
export function insertSites(file: string, text: string, sql: boolean): Site[] {
  const clean = sql ? stripSqlComments(text) : text;
  const sites: Site[] = [];
  const re = /insert\s+into\s+(?:public\.)?work_sessions\b/gi;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const stmt = statementFrom(clean, m.index);
    const line = clean.slice(0, m.index).split('\n').length;
    sites.push({ file, line, ...parseInsert(stmt) });
  }
  return sites;
}

/** A site is a violation unless every row inserts `'spawning'` (or omits status: the 001 default). */
export function violations(sites: Site[]): Site[] {
  return sites.filter((s) => s.problem !== undefined
    || s.statuses.length === 0
    || s.statuses.some((v) => v !== null && v.replace(/::text$/i, '') !== MINT_STATUS));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()
    .map((f) => join(MIGRATIONS, f));
}

function productSources(): string[] {
  return readdirSync(PACKAGES).flatMap((pkg) => {
    const src = join(PACKAGES, pkg, 'src');
    try { if (!statSync(src).isDirectory()) return []; } catch { return []; }
    return walk(src).filter((f) => /\.(?:ts|tsx|mts|js|mjs|sql)$/.test(f));
  });
}

describe('every product mint inserts a work session as spawning (session_credential_binding guard)', () => {
  const migrationSites = migrationFiles().flatMap((f) => insertSites(f, readFileSync(f, 'utf8'), true));
  const sourceSites = productSources().flatMap((f) => insertSites(f, readFileSync(f, 'utf8'), f.endsWith('.sql')));

  it('no migration inserts a work session in any status but spawning', () => {
    expect(violations(migrationSites)).toEqual([]);
    // The scan saw the mints (15 sites at base 6b689290); zero would mean the
    // pattern broke, not that the rule holds.
    expect(migrationSites.length).toBeGreaterThanOrEqual(15);
  });

  it('no package source inserts a work session in any status but spawning', () => {
    expect(violations(sourceSites)).toEqual([]);
  });

  it("an omitted status column takes 001's default, which is 'spawning' and never changed", () => {
    const files = migrationFiles();
    const first = stripSqlComments(readFileSync(files[0]!, 'utf8'));
    expect(first).toMatch(/create table public\.work_sessions[\s\S]*?\bstatus\s+text not null default 'spawning'/);
    for (const f of files) {
      const text = stripSqlComments(readFileSync(f, 'utf8'));
      expect(text, f).not.toMatch(/alter\s+column\s+status\s+(?:set|drop)\s+default/i);
    }
  });

  // The scan must be able to go red.
  it('catches a synthetic running insert', () => {
    const sites = insertSites('synthetic.sql', `
      insert into public.work_sessions(entity_id, title, status, session_kind)
      values (v_id, 'x', 'running', 'agent');`, true);
    expect(sites).toHaveLength(1);
    expect(violations(sites)).toHaveLength(1);
    expect(sites[0]!.statuses).toEqual(["'running'"]);
  });

  it('catches a status taken from a variable, a select, a second row, and a TS template', () => {
    expect(violations(insertSites('a.sql',
      'insert into work_sessions (entity_id, status) values (v_id, p_status);', true))).toHaveLength(1);
    expect(violations(insertSites('b.sql',
      "insert into public.work_sessions (entity_id, status) select id, 'idle' from x;", true))).toHaveLength(1);
    expect(violations(insertSites('c.sql',
      "insert into work_sessions (entity_id, status) values (a, 'spawning'), (b, 'running');", true))).toHaveLength(1);
    expect(violations(insertSites('d.ts',
      "await db.query(`insert into work_sessions (entity_id, status) values ($1, 'running')`);", false))).toHaveLength(1);
    expect(violations(insertSites('e.sql', 'insert into work_sessions select * from x;', true))).toHaveLength(1);
  });

  it('passes a spawning literal far below its insert, and an omitted status', () => {
    const far = `insert into public.work_sessions(
        entity_id, title, node_id,
        project_id,
        workdir_mode,
        workdir_path,
        -- a comment with a ; and a 'running' in it
        agent_tool,
        model,
        mode,
        status,
        session_kind)
      values (v_id, coalesce(nullif(btrim(p_title), ''), 'Terminal'), p_node, null, 'project',
        p_dir, null, null, null,
        'spawning',
        'shell');`;
    const sites = insertSites('far.sql', far, true);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.statuses).toEqual(["'spawning'"]);
    expect(violations(sites)).toEqual([]);
    const omitted = insertSites('omit.sql', "insert into work_sessions (entity_id, title) values (v_id, 'x');", true);
    expect(omitted[0]!.statuses).toEqual([null]);
    expect(violations(omitted)).toEqual([]);
  });
});
