/**
 * THE HOME LANE'S OWN GUARDS.
 *
 * D62.3: *a ruling that creates a file names the controls that will see it.*
 * `src/home/` is a new directory, so it is worth being explicit about which
 * package-wide laws already reach it and which do not:
 *
 *  · THE HEX BAN reaches it already — `src/hex-ban.test.ts` walks the whole
 *    package with exactly four exclusions and `home` is not one of them. The
 *    assertion below is therefore a LOCAL ECHO, not the enforcement: it exists
 *    so a violation in this directory fails with this directory's name on it
 *    (and it asserts its own file set is non-empty, so it cannot pass
 *    vacuously).
 *  · THE KIND-LITERAL BAN DOES NOT. `panels/no-branching.test.ts` is
 *    deliberately LANE-scoped — its docblock explains why a lane guard that
 *    reddens another seat's file is worse than the hole it closes — and its
 *    owned set is `panels/` plus four named shell files. So `src/home/` was
 *    outside §15.2's enforcement the moment it was created. This file closes
 *    that gap for this lane rather than widening someone else's guard, which
 *    is the shape that ruling settled on.
 *
 * The law matters here specifically: Home decides which kinds to read by
 * REGISTRY CAPABILITY (`list.liveTreatment` exists ⇒ live-shaped;
 * `tile.badges` names `assignees` ⇒ assignable), and the entire value of that
 * choice evaporates the first time someone writes the kind name instead.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const ownedFiles = walk(HERE);

/**
 * Tests are excluded from the SOURCE scan for the reason the panels guard
 * gives: a test proving a session row renders correctly has to be able to name
 * a session. The ban is on shipped screen code.
 */
const sourceFiles = ownedFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

const styleFiles = ownedFiles.filter((f) => f.endsWith('.css'));

describe('src/home — the lane guards', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(3);
    expect(styleFiles.length).toBeGreaterThan(0);
  });

  it('§15.2 — no file in src/home names an entity kind', () => {
    const kinds = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'));

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      // Comments stripped FIRST: the docblocks in this directory quote the
      // very literals they forbid in order to explain the ban, and prose that
      // cannot name the rule is worse documentation and no safer.
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (new RegExp(`['"\`]${kind}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → '${kind}'`);
        }
      }
    }
    expect(
      offenders,
      `Home reaches kinds through registry CAPABILITY, never by name:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('§15.2 — no file in src/home compares a kind against a literal', () => {
    const kinds = allKinds().map((k) => k.kind);
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (new RegExp(`kind\\s*===\\s*['"\`]${kind.replace('*', '\\*')}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → kind === '${kind}'`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('§14 — home.css resolves every colour through a token', () => {
    const offenders: string[] = [];
    for (const file of styleFiles) {
      const hits = stripCssComments(readFileSync(file, 'utf8')).match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, `raw hex in src/home:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('§14 — and neither does a component, in a style prop or anywhere else', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const hits = stripComments(readFileSync(file, 'utf8')).match(/#[0-9a-fA-F]{6}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, `inline hex in src/home:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('home.css introduces NO per-theme override — dark is a token swap or it is mis-tokenised', () => {
    // The oracle's own dark annotation: "Token swap; the dashboard carries no
    // extra chrome to re-skin — it is made of rows." A `data-theme` selector
    // appearing in this stylesheet is therefore evidence about the LIGHT rules
    // above it, not a dark-mode fix — which is why it is a test and not a
    // review habit.
    for (const file of styleFiles) {
      const text = stripCssComments(readFileSync(file, 'utf8'));
      expect(text, `${relative(SRC, file)} restates the theme`).not.toMatch(/data-theme/);
    }
  });
});
