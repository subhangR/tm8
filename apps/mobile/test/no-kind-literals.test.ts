/**
 * L-A (same words as the web) and L-C (colours from tokens) for apps/mobile:
 * the jest port of packages/tm8-ui/src/files/no-kind-literals.test.ts, plus
 * the proof that eslint.config.mjs enforces the same rules (DoD D3).
 *
 * Two guards on purpose. The scan below reads the source like tm8-ui's test
 * does, so it holds even if the ESLint config is broken or skipped. The ESLint
 * cases lint snippets with the real config, so a selector that silently stops
 * matching fails here rather than letting every lint run pass.
 *
 * The registry (src/registry/**) is the one folder that may name a kind; test
 * fixtures (the BRIEF §5 world) may too. Every other app file reaches a kind
 * through configFor(kind) and registry data.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CORE_KIND_INFO } from '@tm8/contract/kind-info';

const APP = join(__dirname, '..');
const CORE_KINDS = Object.keys(CORE_KIND_INFO);

// ── the source scan (the port) ──────────────────────────────────────────────

const SCANNED_ROOTS = ['app', 'src', 'terminal-web'];
const MAY_NAME_KINDS = [/^src\/registry\//, /(^|\/)__fixtures__\//, /(^|\/)fixtures\//, /\.fixture\.tsx?$/];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const appFiles = SCANNED_ROOTS.flatMap((root) => walk(join(APP, root)))
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => relative(APP, file).split(sep).join('/'))
  .filter((file) => !MAY_NAME_KINDS.some((pattern) => pattern.test(file)));

describe('L-A: app code names no kind (the scan)', () => {
  it('scans a non-empty file set that includes the routes (a green run over zero files proves nothing)', () => {
    expect(appFiles).toEqual(expect.arrayContaining(['app/_layout.tsx', 'app/index.tsx']));
  });

  it('reads the 33 core kinds from the contract', () => {
    expect(CORE_KINDS).toHaveLength(33);
    expect(CORE_KINDS).toEqual(expect.arrayContaining(['task', 'work_session', 'chat', 'craft']));
  });

  it('no app file contains a kind string literal', () => {
    const offenders: string[] = [];
    for (const file of appFiles) {
      const text = stripComments(readFileSync(join(APP, file), 'utf8'));
      for (const kind of CORE_KINDS) {
        if (new RegExp(`['"\`]${kind}['"\`]`).test(text)) offenders.push(`${file} → '${kind}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no app file compares a kind against a literal', () => {
    const offenders = appFiles.filter((file) =>
      /\bkind\s*[!=]==?\s*['"`]|['"`]\s*[!=]==?\s*[\w.?]*\bkind\b/.test(stripComments(readFileSync(join(APP, file), 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('no app file carries a raw hex colour', () => {
    const offenders = appFiles
      .filter((file) => file !== 'src/theme/tokens.gen.ts')
      .filter((file) => /#[0-9a-fA-F]{6}\b/.test(stripComments(readFileSync(join(APP, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

// ── the ESLint rules fire (and only where they should) ─────────────────────

interface LintMessage {
  ruleId: string | null;
  message: string;
  line: number;
}

/* eslint-disable no-restricted-syntax -- these snippets are the rules' inputs: lint-cases.mjs lints each one at its filePath */
const cases: Record<string, { filePath: string; code: string }> = {
  literal: { filePath: 'src/ui/Probe.ts', code: "export const k = 'task';\n" },
  inRegistry: { filePath: 'src/registry/task.ts', code: "export const k = 'task';\n" },
  inFixture: { filePath: 'src/state/__fixtures__/world.ts', code: "export const k = 'task';\n" },
  inScript: { filePath: 'scripts/seed-probe.ts', code: "export const k = 'task';\n" },
  template: { filePath: 'src/nav/probe.ts', code: 'export const k = `doc`;\n' },
  jsxProp: { filePath: 'app/probe.tsx', code: 'export const X = () => <Row kind="work_session" />;\n' },
  compareCustom: { filePath: 'src/nav/compare.ts', code: "export const f = (e: { kind: string }) => e.kind === 'c:invoice';\n" },
  compareOptional: { filePath: 'src/nav/optional.ts', code: "export const f = (e?: { kind: string }) => 'c:x' !== e?.kind;\n" },
  notKinds: { filePath: 'src/ui/words.ts', code: "export const w = ['dark', 'tasks', 'Task', 'docs', 'sessions'];\n" },
  terminal: { filePath: 'terminal-web/probe.ts', code: "export const k = 'chat';\n" },
  hex6: { filePath: 'src/ui/colour.ts', code: "export const c = '#1E90FF';\n" },
  hex3: { filePath: 'app/colour.tsx', code: "export const c = '#fff';\n" },
  hexInText: { filePath: 'src/ui/shadow.ts', code: "export const s = '0 1px 2px #00000033';\n" },
  hexTemplate: { filePath: 'src/ui/border.ts', code: 'export const b = (w: number) => `${w}px solid #2B2B2B`;\n' },
  rgba: { filePath: 'src/ui/rgba.ts', code: "export const c = 'rgba(0, 0, 0, 0.5)';\n" },
  prNumber: { filePath: 'src/ui/pr.ts', code: "export const t = ['PR #1383', '#12'];\n" },
  hexInTokens: { filePath: 'src/theme/tokens.gen.ts', code: "export const surface = '#F7F7F7';\n" },
  kindInTokens: { filePath: 'src/theme/tokens.gen.ts', code: "export const k = 'task';\n" },
  hexInRegistry: { filePath: 'src/registry/task.ts', code: "export const c = '#F7F7F7';\n" },
  hexInTest: { filePath: 'test/probe.test.ts', code: "export const c = '#1E90FF';\n" },
  hexInScript: { filePath: 'scripts/gen-probe.ts', code: "export const c = '#1E90FF';\n" },
  window: { filePath: 'src/ui/width.ts', code: 'export const w = window.innerWidth;\n' },
  document: { filePath: 'app/title.tsx', code: 'export const t = () => document.title;\n' },
  localStorage: { filePath: 'src/servers/token.ts', code: "export const t = () => localStorage.getItem('t');\n" },
  windowInTerminal: { filePath: 'terminal-web/size.ts', code: 'export const w = window.innerWidth;\n' },
  barrel: { filePath: 'src/net/http.ts', code: "import { isCollabError } from '@tm8/contract';\nexport { isCollabError };\n" },
  subpath: { filePath: 'src/net/kinds.ts', code: "import { CORE_KIND_INFO } from '@tm8/contract/kind-info';\nexport { CORE_KIND_INFO };\n" },
  reactDom: { filePath: 'src/ui/portal.ts', code: "import { createRoot } from 'react-dom/client';\nexport { createRoot };\n" },
  tm8ui: { filePath: 'src/nav/codec.ts', code: "import { parse } from '../../../../packages/tm8-ui/src/routes/codec';\nexport { parse };\n" },
  deepSrc: { filePath: 'src/net/schemas.ts', code: "import { z } from '@tm8/contract/src/schemas';\nexport { z };\n" },
};
/* eslint-enable no-restricted-syntax */

for (const kind of CORE_KINDS) cases[`kind:${kind}`] = { filePath: 'src/ui/Kinds.ts', code: `export const k = '${kind}';\n` };

const names = Object.keys(cases);
let results: Record<string, LintMessage[]>;

beforeAll(() => {
  const out = execFileSync(process.execPath, [join(__dirname, 'lint-cases.mjs')], {
    cwd: APP,
    input: JSON.stringify(names.map((name) => cases[name])),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const linted = JSON.parse(out) as { messages: LintMessage[] }[];
  results = Object.fromEntries(names.map((name, i) => [name, linted[i]?.messages ?? []]));
}, 120_000);

function messages(name: string, prefix: string): string[] {
  return (results[name] ?? []).map((m) => m.message).filter((message) => message.startsWith(prefix));
}

function ruleIds(name: string): (string | null)[] {
  return (results[name] ?? []).map((m) => m.ruleId);
}

describe('L-A: ESLint fires on a kind literal in app code', () => {
  it.each(['literal', 'template', 'jsxProp', 'terminal'])('%s', (name) => {
    expect(messages(name, 'L-A')).not.toHaveLength(0);
  });

  it.each(CORE_KINDS)('bans the kind %s', (kind) => {
    expect(messages(`kind:${kind}`, 'L-A')).toHaveLength(1);
  });

  it.each(['compareCustom', 'compareOptional'])('bans `kind ===` against any literal: %s', (name) => {
    expect(messages(name, 'L-A').some((m) => m.includes('No `kind ===` branch'))).toBe(true);
  });

  it.each(['inRegistry', 'inFixture', 'inScript', 'notKinds'])('stays quiet: %s', (name) => {
    expect(messages(name, 'L-A')).toEqual([]);
  });

  it('still applies inside the generated tokens file', () => {
    expect(messages('kindInTokens', 'L-A')).toHaveLength(1);
  });
});

describe('L-C: ESLint fires on a raw colour outside src/theme/tokens.gen.ts', () => {
  it.each(['hex6', 'hex3', 'hexInText', 'hexTemplate', 'rgba', 'hexInRegistry', 'hexInTest', 'hexInScript'])('%s', (name) => {
    expect(messages(name, 'L-C')).toHaveLength(1);
  });

  it.each(['hexInTokens', 'prNumber'])('stays quiet: %s', (name) => {
    expect(messages(name, 'L-C')).toEqual([]);
  });
});

describe('D3: ESLint fires on the DOM in React Native code', () => {
  it.each(['window', 'document', 'localStorage'])('%s', (name) => {
    expect(ruleIds(name)).toContain('no-restricted-globals');
  });

  it('allows the DOM in terminal-web/, the WebView page', () => {
    expect(ruleIds('windowInTerminal')).not.toContain('no-restricted-globals');
  });

  it.each(['barrel', 'reactDom', 'tm8ui', 'deepSrc'])('bans the import: %s', (name) => {
    expect(ruleIds(name)).toContain('no-restricted-imports');
  });

  it('allows a contract subpath', () => {
    expect(results.subpath).toEqual([]);
  });
});
