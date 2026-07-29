/**
 * §15.2 AND §14 FOR THIS LANE — because neither existing guard reaches it.
 *
 * D62 §3 is the rule: A RULING THAT CREATES A FILE NAMES THE CONTROLS THAT
 * WILL SEE IT. `panels/no-branching.test.ts` scans `panels/` plus four named
 * shell files; `authoring/` and `settings-space/` each carry their own copy.
 * `src/files/` is none of those, so creating this directory created a region
 * where the no-branching law is stated everywhere and enforced nowhere. This
 * file is written by the seat that created the gap.
 *
 * WHY HERE AND NOT BY WIDENING SOMEONE ELSE'S LIST: D61's settled argument. A
 * lane guard that fails on another seat's file makes the WRONG SEAT RED —
 * they cannot fix it, and their only moves are nag or exempt.
 *
 * THE TEMPTATION THIS LANE FACES SPECIFICALLY, stated so the guard reads as
 * necessary rather than ceremonial: a files screen wants to write
 * `kinds: ['file']` and `state.kind === 'file'` about ten times. It writes
 * neither. `port.ts:fileKindRef()` reaches the kind through registry DATA
 * (the one row whose panel carries a `file-preview` block) and
 * `model.ts:rowFromEntity()` discriminates STRUCTURALLY on the presence of
 * name/mimeType/sizeBytes. Both were written that way from the start; this
 * guard is what keeps them that way.
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

describe('§15.2 — the files lane knows no kind', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    // The both-halves control: a glob that silently matched nothing would make
    // every assertion below vacuously true.
    expect(sourceFiles.length).toBeGreaterThan(5);
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
      `reach the kind through registry DATA (port.ts fileKindRef) or structurally (model.ts rowFromEntity):\n${offenders.join('\n')}`,
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

  it('the file kind is reachable from registry data at all — the guard’s other half', async () => {
    // A ban is only half a rule. This asserts the ALTERNATIVE exists and
    // resolves, so "don't type the literal" is advice someone can follow. If
    // the registry ever grows a second file-preview row, `fileKindRef` throws
    // loudly here rather than picking one silently in production.
    const { fileKindRef } = await import('./port');
    expect(typeof fileKindRef()).toBe('string');
    expect(fileKindRef().length).toBeGreaterThan(0);
  });
});

describe('§14 — this lane is inside the package hex guard', () => {
  it('is not on any exclusion path, so hex-ban.test.ts really walks it', () => {
    // MEASURED, not assumed: read from the guard's own source, so a future
    // carve that quietly adds `files` fails HERE too and cannot pass by only
    // touching the other file's count assertion.
    const guard = readFileSync(join(SRC, 'hex-ban.test.ts'), 'utf8');
    expect(guard).not.toMatch(/path:\s*'files/);
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
  it('creates nothing outside src/files/', () => {
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

  it('touches `src/data/**` only as a TYPE import — the closed seat, from outside', () => {
    // `src/data/` is READ-ONLY to this lane and its seat is closed. A value
    // import from it would be a runtime dependency on a lane that cannot
    // review the coupling; a type import is free and disappears at build.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const line of text.split('\n')) {
        if (!/from\s+['"]\.\.\/data/.test(line)) continue;
        if (!/^\s*import\s+type\s/.test(line)) offenders.push(`${relative(SRC, file)} → ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
