/**
 * Acceptance test 7, its cookie clause: a cookie export from the credentialed
 * browser fails. The browser code never opens a persistent profile, never reads
 * or writes storage state or cookies, never attaches over CDP and never names a
 * profile or debugging switch. Each fill's cookies therefore live only in one
 * off-the-record context, which closes with the fill. Only src/browser may import
 * Playwright, so this scan covers every file that can.
 *
 * The opt-in E2E (browser.test.ts, test 7) adds the running proof. While a fill
 * is in flight there is no debug port, no listener and no extension, and the
 * page's cookie is live only in that fill. Its profile is one owner-only tmpfs
 * directory, which is gone when the fill ends, and the same driver's next fill
 * of the same origin sends no cookie. A fill that is killed (the deadline, its
 * broker gone, its child or its worker SIGKILLed) leaves no profile either:
 * worker.test.ts and broker-kill.test.ts check that its directory is removed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../../src/', import.meta.url));
const PLAYWRIGHT = /^(?:playwright|@playwright\/)/;

/** Playwright and CDP names that would persist, read or hand out a profile's cookies. */
const FORBIDDEN_NAMES = new Set(['launchPersistentContext', 'storageState', 'cookies', 'addCookies', 'newCDPSession',
  'connectOverCDP', 'launchServer']);
/** Chromium switches that would pin the profile on disk or open a debugging channel. */
const FORBIDDEN_SWITCHES = ['--user-data-dir', '--profile-directory', '--remote-debugging-port', '--remote-debugging-pipe',
  '--remote-debugging-address'];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const parse = (text: string, path: string): ts.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

/** Every forbidden use in one source file. Comments never count; names, string keys and template text do. */
function profileExports(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && FORBIDDEN_NAMES.has(node.text.replace(/^#/, ''))) found.push(node.text);
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (FORBIDDEN_NAMES.has(node.text)) found.push(node.text);
      for (const flag of FORBIDDEN_SWITCHES) if (node.text.includes(flag)) found.push(flag);
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'chromium' && node.name.text !== 'launch') {
      found.push(`chromium.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Module specifiers of every import, export-from, dynamic import and require in one file. */
function moduleSpecifiers(file: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    const loads = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'));
    if (loads && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

describe('the credentialed browser keeps no exportable profile (acceptance 7)', () => {
  const sources = files(src).map((path) => ({ path: relative(src, path), file: parse(readFileSync(path, 'utf8'), path) }));

  it('imports Playwright only under src/browser', () => {
    const importers = sources.filter(({ file }) => moduleSpecifiers(file).some((specifier) => PLAYWRIGHT.test(specifier)));
    expect(importers.length > 0).toBe(true);
    expect(importers.filter(({ path }) => !path.startsWith('browser/')).map(({ path }) => path)).toEqual([]);
    const planted = parse(["import a from 'playwright';", "export * from '@playwright/test';", "await import('playwright-core');",
      "require('playwright-chromium');", "import b from 'node:fs';"].join('\n'), 'planted.ts');
    expect(moduleSpecifiers(planted).filter((specifier) => PLAYWRIGHT.test(specifier)))
      .toEqual(['playwright', '@playwright/test', 'playwright-core', 'playwright-chromium']);
  });

  it('never opens a persistent profile, touches cookies or storage state, attaches over CDP or names a profile switch', () => {
    const uses = sources.filter(({ path }) => path.startsWith('browser/')).flatMap(({ path, file }) => profileExports(file).map((use) => `${path}: ${use}`));
    expect(uses).toEqual([]);
  });

  it('trips on each forbidden use in a planted fixture, and not on a comment', () => {
    const planted = parse([
      '// cookies, storageState and --user-data-dir in a comment are fine',
      "import { chromium } from 'playwright-core';",
      'const context = await chromium.launchPersistentContext(dir);',
      'await context.storageState();',
      'await context.cookies();',
      "await context['addCookies']([]);",
      'await context.newCDPSession(page);',
      'await chromium.connectOverCDP(url);',
      'await chromium.launchServer();',
      'await chromium.connect(url);',
      "await chromium.launch({ args: [`--user-data-dir=${dir}`, '--profile-directory=Default', '--remote-debugging-port=0'] });",
      "await chromium.launch({ args: ['--remote-debugging-pipe', '--remote-debugging-address=0.0.0.0'] });",
    ].join('\n'), 'planted.ts');
    expect(profileExports(planted).sort()).toEqual([
      '--profile-directory', '--remote-debugging-address', '--remote-debugging-pipe', '--remote-debugging-port', '--user-data-dir',
      'addCookies', 'chromium.connect', 'chromium.connectOverCDP', 'chromium.launchPersistentContext', 'chromium.launchServer',
      'connectOverCDP', 'cookies', 'launchPersistentContext', 'launchServer', 'newCDPSession', 'storageState',
    ].sort());
    expect(profileExports(parse("// chromium.launchPersistentContext, cookies()\nawait chromium.launch({ headless: true });", 'clean.ts'))).toEqual([]);
  });
});
