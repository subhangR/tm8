import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Review addendum 2, C1: a sweep for string-built SQL.
 *
 * It finds every `.query(` call in a source tree and classifies the SQL argument:
 *   - `literal`: one plain string literal, not joined with `+`;
 *   - `template`: a template literal, with the text of each `${...}` it interpolates;
 *   - `name`: a bare identifier, such as a pass-through parameter or a module constant;
 *   - `other`: anything else, including `+` concatenation. A sweep treats it as a failure.
 * Values belong in bound parameters (`$1`), never in SQL text. Identifiers cannot be bound,
 * so each interpolation a sweep allows has been reviewed by name.
 */
export interface SqlCall {
  file: string;
  line: number;
  kind: 'literal' | 'template' | 'name' | 'other';
  /** The identifier, for `name`. */
  name?: string;
  /** The trimmed text of each top-level `${...}`, for `template`. */
  interpolations: string[];
}

const QUERY_CALL = /\.query(?:<[^>()]*>)?\(/g;

/** Index just past the string literal that starts at `at` (a quote character). */
function skipString(source: string, at: number): number {
  const quote = source[at];
  let i = at + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === '\n') throw new Error('sql sweep: unterminated string');
    i += 1;
  }
  if (i >= source.length) throw new Error('sql sweep: unterminated string');
  return i + 1;
}

/** Index just past the template literal that starts at `at`, collecting its top-level interpolations. */
function skipTemplate(source: string, at: number, interpolations?: string[]): number {
  let i = at + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') { i += 2; continue; }
    if (char === '`') return i + 1;
    if (char === '$' && source[i + 1] === '{') {
      const start = i + 2;
      i = skipExpression(source, start);
      interpolations?.push(source.slice(start, i).trim());
      i += 1;
      continue;
    }
    i += 1;
  }
  throw new Error('sql sweep: unterminated template');
}

/** Index of the `}` that closes an expression starting at `at`, skipping nested strings, templates and braces. */
function skipExpression(source: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "'" || char === '"') { i = skipString(source, i); continue; }
    if (char === '`') { i = skipTemplate(source, i); continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      if (depth === 0) return i;
      depth -= 1;
    }
    i += 1;
  }
  throw new Error('sql sweep: unterminated interpolation');
}

/** What follows the first argument: `+` makes it a concatenation. */
function concatenated(source: string, at: number): boolean {
  let i = at;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  return source[i] === '+';
}

export function sqlCalls(file: string, source: string): SqlCall[] {
  const calls: SqlCall[] = [];
  for (const match of source.matchAll(QUERY_CALL)) {
    let i = match.index + match[0].length;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    const line = source.slice(0, match.index).split('\n').length;
    const char = source[i];
    const call: SqlCall = { file, line, kind: 'other', interpolations: [] };
    if (char === "'" || char === '"') {
      call.kind = concatenated(source, skipString(source, i)) ? 'other' : 'literal';
    } else if (char === '`') {
      const end = skipTemplate(source, i, call.interpolations);
      call.kind = concatenated(source, end) ? 'other' : 'template';
    } else {
      const name = /^([A-Za-z_$][\w$]*)\s*[,)]/.exec(source.slice(i));
      if (name) { call.kind = 'name'; call.name = name[1]!; }
    }
    calls.push(call);
  }
  return calls;
}

/** Every `.ts` file under `root`, except declaration files. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files.sort();
}

export function sweep(root: string): SqlCall[] {
  return sourceFiles(root).flatMap((file) => sqlCalls(file.slice(root.length + 1), readFileSync(file, 'utf8')));
}
