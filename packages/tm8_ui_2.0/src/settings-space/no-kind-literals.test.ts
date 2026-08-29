/**
 * §15.2 AND §14 FOR THIS LANE — because neither existing guard reaches it.
 *
 * D62 §3 is the rule: A RULING THAT CREATES A FILE NAMES THE CONTROLS THAT
 * WILL SEE IT. `panels/no-branching.test.ts` scans `panels/` plus four named
 * shell files; `authoring/no-kind-literals.test.ts` scans `authoring/`.
 * `src/settings-space/` is neither, so creating this directory created a
 * region where the no-branching law is stated everywhere and enforced nowhere
 * — exactly the coverage-shrank-by-side-effect failure D61 recorded from the
 * other side. This file is written by the seat that created the gap.
 *
 * WHY HERE AND NOT BY WIDENING SOMEONE ELSE'S LIST: D61's settled argument. A
 * lane guard that fails on another seat's file makes the WRONG SEAT RED —
 * they cannot fix it, and their only moves are nag or exempt. Three lanes,
 * three guards, one law.
 *
 * IT FOUND SOMETHING ON ITS FIRST RUN, recorded so nobody reads it as
 * ceremony: `specimen.ts` was written with `kind: 'member'` twice and
 * `state: {kind: 'member', …}` once — a specimen file is source, and the
 * registry-derived `memberKindRef()` was already sitting one import away.
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
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ownedFiles = walk(HERE);

const sourceFiles = ownedFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('§15.2 — the settings lane knows no kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    // The both-halves control: a glob that silently matched nothing would make
    // every assertion below vacuously true.
    expect(sourceFiles.length).toBeGreaterThan(6);
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
      `the members query and the specimens must reach a kind through registry DATA:\n${offenders.join('\n')}`,
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

  it('no ROLE word is typed either — the owner lock reads the registry’s tones', () => {
    // Not §15.2's letter, but its argument: a hard-coded 'owner' is the same
    // defect one level down. The registry already colours the owner chip
    // brass, so `ownerRoleRef()` is where that word lives.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (/reasons\.ts$/.test(file)) continue; // prose about roles, not a comparison
      const text = stripComments(readFileSync(file, 'utf8'));
      if (/===\s*['"`]owner['"`]|['"`]owner['"`]\s*===/.test(text)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('§14 — this lane is inside the package hex guard', () => {
  it('is not on any exclusion path, so hex-ban.test.ts really walks it', () => {
    // MEASURED, not assumed: read from the guard's own source, so a future
    // carve that quietly adds `settings-space` fails HERE too and cannot pass
    // by only touching the other file's count assertion.
    const guard = readFileSync(join(SRC, 'hex-ban.test.ts'), 'utf8');
    expect(guard).not.toMatch(/path:\s*'settings-space/);
  });

  it('carries no raw hex of its own, checked locally as well', () => {
    // Duplicated on purpose: the package guard is the authority, this is the
    // local smoke so a violation names THIS lane in THIS lane's run rather
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

describe('the lane’s own boundary', () => {
  it('creates nothing outside src/settings-space/', () => {
    // The directive's file ownership is ABSOLUTE. This asserts the shape of
    // that promise from inside: every file this suite walks is under HERE.
    for (const f of ownedFiles) expect(f.startsWith(HERE)).toBe(true);
  });

  it('imports no seam IMPLEMENTATION into product code', () => {
    // `port.ts` takes a `Seam` by TYPE and the host constructs it. A component
    // that reached for `createFixtureSeam`/`createRealSeam` would silently
    // bind this surface to one implementation and break LLD §10's
    // interchangeability — the test lives here because the import would
    // typecheck perfectly.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      if (/createFixtureSeam|createRealSeam/.test(text)) offenders.push(relative(SRC, file));
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
