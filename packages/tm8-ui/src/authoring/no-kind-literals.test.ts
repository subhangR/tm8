import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allKinds } from '../domain';

/**
 * §15.2 FOR THIS LANE — because the existing guard does not reach it.
 *
 * `panels/no-branching.test.ts` scans `OWNED_DIRS = ['panels']` plus four named
 * shell files. `src/authoring/` is neither, so creating this directory created
 * a region where the no-branching law is stated everywhere and enforced
 * nowhere. That is precisely the failure D61 recorded from the other side: the
 * hex guard's coverage shrank TWICE by side effect of decisions that never
 * mentioned the guard, while the ledger went on claiming it scanned the
 * package. Nobody ever decided those files were exempt — it fell out.
 *
 * D62 §3 is the rule that applies: A RULING THAT CREATES A FILE NAMES THE
 * CONTROLS THAT WILL SEE IT. A control's author cannot anticipate a directory
 * that did not exist when the list was written; the directory's creator can,
 * and must. This is that, written by the seat that created the gap.
 *
 * WHY HERE AND NOT BY WIDENING `OWNED_DIRS`: the same argument D61 settled.
 * A lane guard that fails on another seat's file makes the WRONG SEAT RED —
 * they cannot fix it, and their only moves are nag or exempt. Adding
 * `authoring` to the panels guard would make the panels seat red for this
 * lane's mistakes. Two lanes, two guards, same law.
 *
 * THE HEX BAN NEEDS NO COUNTERPART HERE: `src/hex-ban.test.ts` is a PACKAGE
 * guard that walks `src/` with exactly four exclusions, and `authoring` is not
 * one of them — verified below rather than assumed, because "the package guard
 * covers it" is precisely the kind of claim that was true when written and
 * false a week later.
 */

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
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ownedFiles = walk(HERE);

const sourceFiles = ownedFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('§15.2 — the authoring lane knows no kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    // The both-halves control. A glob that silently matched nothing would make
    // every assertion below vacuously true — the exact shape of the "counts
    // survive" test that stood over a dropped count (D31).
    expect(sourceFiles.length).toBeGreaterThan(4);
  });

  it('no source file here contains a kind string literal', () => {
    const kinds = allKinds()
      .map((k) => k.kind)
      .filter((k) => !k.startsWith('c:'));

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const kind of kinds) {
        if (new RegExp(`['"\`]${kind}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)} → '${kind}'`);
        }
      }
    }
    expect(
      offenders,
      `the create/save flows must reach a kind through registry DATA:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no source file compares a kind against a literal', () => {
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
});

describe('§14 — this lane is inside the package hex guard', () => {
  it('is not on any exclusion path, so hex-ban.test.ts really walks it', () => {
    // MEASURED, not assumed: the guard's exclusion list is read from its own
    // source, so a future carve that quietly adds `authoring` fails HERE too
    // and cannot pass by only touching the other file's count assertion.
    const guard = readFileSync(join(SRC, 'hex-ban.test.ts'), 'utf8');
    expect(guard).not.toMatch(/path:\s*'authoring/);
  });

  it('carries no raw hex of its own, checked locally as well', () => {
    // Duplicated on purpose. The package guard is the authority; this is the
    // local smoke so a violation names THIS lane in THIS lane's run, rather
    // than surfacing only in a package-wide red the coordinator has to route.
    const offenders: string[] = [];
    for (const file of [...sourceFiles, ...ownedFiles.filter((f) => f.endsWith('.css'))]) {
      const text = /\.css$/.test(file)
        ? readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        : stripComments(readFileSync(file, 'utf8'));
      const hits = text.match(/#[0-9a-fA-F]{6}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
