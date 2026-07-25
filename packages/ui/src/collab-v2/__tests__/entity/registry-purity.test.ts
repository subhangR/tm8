// @vitest-environment node
/**
 * THE LAW, enforced honestly: kinds are data. Behavior may not branch on an
 * entity's kind anywhere outside `registry/` — all kind variation lives in
 * the KindRegistry. This test recursively scans ALL of src/collab-v2 (the
 * previous version scanned only entity/ + gallery/ non-recursively, which is
 * why real violations elsewhere stayed green — Sentinel DEF-6).
 *
 * ## The convention (read this before adding a kind conditional anywhere)
 *
 * ALLOWED without annotation:
 *  - `registry/` — the one home of kind branching — and `mock/` (a simulated
 *    BACKEND; it implements the contract, it is not UI).
 *  - Discriminated-union NARROWING READS of the `state`/`content` unions in
 *    ternary or `if`-guard form, e.g.
 *    `s.state.kind === 'task' ? s.state.workStatus : 'open'` — TypeScript
 *    forces the narrow to read union fields; Sentinel explicitly cleared
 *    these. Narrowing that instead gates RENDERING (`state.kind === 'task'
 *    && <Pill…>`) is behavior branching: use `registryFor(kind).status.current`
 *    or another registry field.
 *
 * ALLOWED with a per-line annotation `// registry-purity: allow — <reason>`:
 *  - kind-keyed STORAGE maps (`Record<EntityKind, Detail>` caches), lexical
 *    collisions with other unions, and similar judged-safe lines. The reason
 *    is mandatory prose for the reviewer; annotations are grep-able.
 *
 * FLAGGED (fix via a registry lookup, or annotate with a defensible reason):
 *  - `kind === '<kind>'` / reversed / `!==` on anything that isn't a
 *    state/content narrow-read; `case '<kind>'` switch arms;
 *    `['task','doc'].includes(x.kind)` literal allowlists; `'task' in x`
 *    checks; `Record<EntityKind, …>` dispatch tables; `{ task: …, doc: … }`
 *    kind-keyed object dispatch.
 *
 * EXPECTED_FAILURES below is TEMPORARY debt with exact per-file counts:
 * known violations stay listed (suite green, debt explicit) until their
 * owners consume the registry capability fields; any NEW violation — or a
 * fixed one whose entry wasn't removed — fails immediately. Atlas tracks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = join(here, '..', '..');

const KIND_LITERALS = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
];
const K = KIND_LITERALS.join('|');

// Directories where kind branching is legitimate (see header).
const ALLOWED_DIRS = ['registry', 'mock'];

// Per-line escape hatch; the trailing reason is part of the convention.
const ANNOTATION = /\/\/\s*registry-purity:/;

/**
 * Permanent per-file allowances for lexical collisions with OTHER
 * discriminated unions whose arm names overlap the 11 kind literals.
 * Scoped to a pattern so new, real violations in the same file still fail.
 */
const FILE_ALLOWANCES: Record<string, { pattern: RegExp; reason: string }> = {
  'subsystems/thread/Thread.tsx': {
    pattern: /\brow\.kind\b/,
    reason: "ThreadRow union discriminant ('message'|'unread'|…) — not an entity kind dispatch",
  },
};

/**
 * TEMPORARY expected failures — known debt from the Sentinel audit, kept
 * exact so the suite stays green while the defects stay visible.
 * Remove each entry as its owner lands the registry-lookup fix; a stale
 * entry (count no longer matching) fails the suite in either direction.
 */
const EXPECTED_FAILURES: Record<string, { lines: number; fix: string }> = {
  // Empty since the W3 fix wave — every Sentinel-audit violation is fixed.
  // Any new entry here requires an Atlas-approved DEF number and owner.
};

// --- the scanner (pure — also exercised by the negative controls) -------------

interface Violation { rule: string; line: number; text: string }

const EQ_FORWARD = new RegExp(`([\\w$?.\\[\\]]*kind)\\s*[!=]==?\\s*['"\`](?:${K})['"\`]`, 'g');
const EQ_REVERSED = new RegExp(`['"\`](?:${K})['"\`]\\s*[!=]==?\\s*([\\w$?.\\[\\]]*kind)\\b`, 'g');
const CASE_ARM = new RegExp(`\\bcase\\s+['"\`](?:${K})['"\`]`);
const LITERAL_INCLUDES = new RegExp(`\\[[^\\]]*['"\`](?:${K})['"\`][^\\]]*\\]\\s*\\.includes\\(`);
const IN_CHECK = new RegExp(`['"\`](?:${K})['"\`]\\s+in\\s+[A-Za-z_$]`);
const RECORD_DISPATCH = /Record<\s*EntityKind\b/;
const KIND_KEY = new RegExp(`[{,\\s]['"\`]?(?:${K})['"\`]?\\s*:`, 'g');

/** state/content union receivers — the legitimate narrowing surface. */
const NARROW_RECEIVER = /(^|[.?])(state|content)\?*\.kind$/;

/** Ternary / if-guard forms count as narrowing READS (optional chains stripped first). */
function isNarrowReadForm(line: string): boolean {
  const stripped = line.replace(/\?\./g, '.').replace(/\?\?/g, '');
  return /\bif\s*\(/.test(stripped) || stripped.includes('?');
}

function scanSource(src: string): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>(); // one violation per (line, rule) — counts stay line-based
  src.split('\n').forEach((line, i) => {
    if (ANNOTATION.test(line)) return; // documented, reviewed exception
    const add = (rule: string) => {
      const key = `${i}:${rule}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ rule, line: i + 1, text: line.trim() });
    };

    for (const [rule, re] of [['kind equality', EQ_FORWARD], ['reversed kind equality', EQ_REVERSED]] as const) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const receiver = m[1];
        if (NARROW_RECEIVER.test(receiver) && isNarrowReadForm(line)) continue; // narrowing read — cleared
        add(NARROW_RECEIVER.test(receiver) ? 'narrowing used to gate rendering/behavior' : rule);
      }
    }
    if (CASE_ARM.test(line)) add('switch case on a kind literal');
    if (LITERAL_INCLUDES.test(line)) add('literal kind-array .includes() allowlist');
    if (IN_CHECK.test(line)) add("'<kind>' in … check");
    if (RECORD_DISPATCH.test(line)) add('Record<EntityKind, …> dispatch table');
    KIND_KEY.lastIndex = 0;
    if ((line.match(KIND_KEY)?.length ?? 0) >= 2) add('kind-keyed object dispatch literal');
  });
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      if (dir === moduleRoot && ALLOWED_DIRS.includes(e.name)) continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(file: string): Violation[] {
  const rel = relative(moduleRoot, file);
  const allowance = FILE_ALLOWANCES[rel];
  const src = allowance
    ? readFileSync(file, 'utf8').split('\n')
      .map((l) => (allowance.pattern.test(l) ? '' : l)).join('\n')
    : readFileSync(file, 'utf8');
  return scanSource(src);
}

// --- the tests -----------------------------------------------------------------

describe('registry purity — no kind-conditionals outside registry/ (DEF-6 rewrite)', () => {
  const files = walk(moduleRoot);

  it('scans the whole module, not a corner of it', () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    const dirs = new Set(files.map((f) => relative(moduleRoot, f).split('/')[0]));
    for (const d of ['entity', 'gallery', 'shell', 'collections', 'subsystems', 'stores', 'facade', 'types']) {
      expect(dirs, `walker must reach ${d}/`).toContain(d);
    }
  });

  it('negative control: the scanner flags every forbidden pattern', () => {
    const flagged = (src: string) => scanSource(src).length;
    expect(flagged(`draggable={entity.kind === 'task'}`)).toBe(1);
    expect(flagged(`if ('doc' !== e.kind) return null;`)).toBe(1);
    expect(flagged(`case 'spell':`)).toBe(1);
    expect(flagged(`if (['channel', 'task', 'doc'].includes(ctx.kind)) {`)).toBeGreaterThanOrEqual(1);
    expect(flagged(`const has = 'task' in handlers;`)).toBe(1);
    expect(flagged(`const hints: Record<EntityKind, string> = {};`)).toBe(1);
    expect(flagged(`const run = { task: runTask, doc: runDoc };`)).toBe(1);
    expect(flagged(`{entity.state.kind === 'task' && <Pill>…</Pill>}`)).toBe(1); // narrowing-render
    expect(flagged(`const x = kind === 'pull_request' ? a : b;`)).toBe(1); // bare kind, ternary is no excuse
  });

  it('negative control: the scanner clears narrowing reads and annotated lines', () => {
    const flagged = (src: string) => scanSource(src).length;
    expect(flagged(`const s = e.state.kind === 'task' ? e.state.workStatus : 'open';`)).toBe(0);
    expect(flagged(`if (detail.content.kind !== 'task') return [];`)).toBe(0);
    expect(flagged(`if (e && (e.state.kind === 'member' || e.state.kind === 'team_member')) {`)).toBe(0);
    expect(flagged(`const m: Record<EntityKind, Detail> = load(); // registry-purity: allow — storage, not dispatch`)).toBe(0);
    expect(flagged(`if (mode.kind === 'create') open();`)).toBe(0); // other unions don't collide
  });

  it('keeps the module kind-agnostic (modulo tracked expected failures)', () => {
    const problems: string[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const rel = relative(moduleRoot, file);
      const violations = scanFile(file);
      const expected = EXPECTED_FAILURES[rel];
      if (expected) seen.add(rel);

      const allowed = expected?.lines ?? 0;
      if (violations.length > allowed) {
        const detail = violations.map((v) => `    L${v.line} [${v.rule}] ${v.text}`).join('\n');
        problems.push(`${rel}: ${violations.length} violation(s), ${allowed} expected — move kind logic into registry/ (${expected?.fix ?? 'see test header for the convention'})\n${detail}`);
      } else if (expected && violations.length < expected.lines) {
        problems.push(`${rel}: only ${violations.length} violation(s) remain but ${expected.lines} are expected — the fix landed; DELETE this EXPECTED_FAILURES entry (Atlas tracks).`);
      }
    }

    for (const rel of Object.keys(EXPECTED_FAILURES)) {
      if (!seen.has(rel)) problems.push(`${rel}: listed in EXPECTED_FAILURES but not found by the walker — remove the stale entry.`);
    }

    expect(problems, `\n${problems.join('\n\n')}\n`).toEqual([]);
  });
});
