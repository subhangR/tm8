/**
 * Acceptance test 16, its temp-file clause: temp import files are removed. The
 * vault never makes one. The export travels sealed from the capture page, and
 * the broker opens it in memory, parses it and re-seals each row. Between
 * requests the import session keeps only metadata and envelopes, and it is
 * dropped on commit, cancel, expiry or a failed commit (handlers.test.ts,
 * 'import state and sealed export lifetime', whose first case is the tier-a
 * clause: blocked until rotated).
 *
 * This scan keeps that true. It follows every runtime import (type-only ones
 * are erased) from the broker's import handlers through src. No module it
 * reaches may load modules dynamically past the scan, or load any package
 * outside a reviewed allowlist, none of which touches a file: a new built-in or
 * dependency on this path fails here until someone reviews it. The allowed
 * packages themselves (zod, @tm8/contract) are not followed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../../src/', import.meta.url));
const ENTRY = 'broker/handlers/imports.ts';
/**
 * Every package the import path may load, as reviewed: node:crypto, schemas, and three helpers (isIP from
 * node:net, domainToUnicode from node:url, inspect from node:util). None of what it uses reads or writes a file.
 */
const ALLOWED = new Set(['node:crypto', 'node:util', 'node:net', 'node:url', 'zod', '@tm8/contract']);

/** One file's runtime module specifiers, and whether it loads code the static scan cannot follow. */
function scan(text: string, path: string): { specifiers: string[]; dynamic: boolean } {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  let dynamic = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node)) dynamic = true;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) dynamic = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { specifiers, dynamic };
}

/** Every module one entry loads at run time, followed through relative imports; and the packages they load. */
function closure(entry: string, read: (path: string) => string | undefined) {
  const modules: string[] = [];
  const unresolved: string[] = [];
  const dynamic: string[] = [];
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (modules.includes(path) || unresolved.includes(path)) continue;
    const text = read(path);
    if (text === undefined) { unresolved.push(path); continue; }
    modules.push(path);
    const found = scan(text, path);
    if (found.dynamic) dynamic.push(path);
    for (const specifier of found.specifiers) {
      if (specifier.startsWith('.')) queue.push(posix.join(posix.dirname(path), specifier.replace(/\.js$/, '.ts')));
      else external.add(specifier);
    }
  }
  return { modules, unresolved, dynamic, unreviewed: [...external].filter((specifier) => !ALLOWED.has(specifier)).sort() };
}

const readSource = (path: string): string | undefined => existsSync(`${src}${path}`) ? readFileSync(`${src}${path}`, 'utf8') : undefined;

describe('the import path writes no temp file (acceptance 16)', () => {
  it('reaches the parser, the capture envelope and the handlers, and loads only reviewed packages', () => {
    const reached = closure(ENTRY, readSource);
    expect(['import/index.ts', 'import/csv.ts', 'import/preview.ts', 'capture/seal.ts', 'capture/payload.ts', 'secret-material.ts']
      .every((path) => reached.modules.includes(path))).toBe(true);
    expect({ unresolved: reached.unresolved, dynamic: reached.dynamic, unreviewed: reached.unreviewed })
      .toEqual({ unresolved: [], dynamic: [], unreviewed: [] });
  });

  it('trips on an unreviewed package one import away and on dynamic loading, and ignores a type-only import', () => {
    const planted: Record<string, string> = {
      'entry.ts': "import { a } from './nested/a.js';\nimport type { B } from './b.js';\nexport { c } from './c.js';\nexport const x = a;",
      'nested/a.ts': "import { writeFile } from 'node:fs/promises';\nimport { outputFile } from 'fs-extra';\nimport { z } from 'zod';\nexport const a = [writeFile, outputFile, z];",
      'b.ts': "import { tmpdir } from 'node:os';\nexport type B = ReturnType<typeof tmpdir>;",
      'c.ts': "export const c = await import('node:url');",
    };
    const reached = closure('entry.ts', (path) => planted[path]);
    expect([reached.modules.sort(), reached.unreviewed, reached.dynamic])
      .toEqual([['c.ts', 'entry.ts', 'nested/a.ts'], ['fs-extra', 'node:fs/promises'], ['c.ts']]);
  });
});
