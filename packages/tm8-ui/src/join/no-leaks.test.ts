/**
 * THIS LANE'S OWN GUARD — D62 §3: a ruling that creates a file names the
 * controls that will see it.
 *
 * `settings-space/no-kind-literals.test.ts` opens with the argument, and it is
 * why this file exists rather than a line added to somebody else's list:
 * creating `src/join/` created a region where the package's laws are stated
 * everywhere and enforced nowhere, and widening another lane's guard would
 * make the WRONG SEAT red for a violation they cannot fix.
 *
 * What this lane has that the others do not is a CREDENTIAL passing through
 * it, so the rules it needs are about disclosure rather than about kinds.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const owned = walk(HERE);
const sourceFiles = owned
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

describe('the join lane holds a credential, and treats it like one', () => {
  it('scans a non-empty file set (a green run over zero files proves nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(2);
  });

  it('never writes a raw code to persistent storage — only sessionStorage', () => {
    // A join code must not outlive the tab or land on disk for the next person
    // at this machine. `localStorage` here would be exactly that.
    const offenders = sourceFiles.filter((f) =>
      /localStorage/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('logs nothing — a console line is a credential in a shared screen', () => {
    const offenders = sourceFiles.filter((f) =>
      /console\.(log|info|warn|error|debug)/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('pushes no history entry — Back must not walk to the URL holding the code', () => {
    // `capturePendingJoin` uses replaceState for exactly this reason; a
    // pushState anywhere in this lane would undo it.
    const offenders = sourceFiles.filter((f) =>
      /pushState/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('imports no seam IMPLEMENTATION — the host injects the executors', () => {
    // `JoinScreen` takes `onPreview`/`onRedeem` as props. Reaching for a seam
    // factory here would bind the one screen a stranger sees to a single
    // implementation, and would typecheck perfectly.
    const offenders = sourceFiles.filter((f) =>
      /createFixtureSeam|createRealSeam|createHttpClient/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('carries no raw hex — the package ban, checked locally so it names THIS lane', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles, ...owned.filter((f) => f.endsWith('.css'))]) {
      const text = /\.css$/.test(file)
        ? readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        : stripComments(readFileSync(file, 'utf8'));
      const hits = text.match(/#[0-9a-fA-F]{6}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('creates nothing outside src/join/', () => {
    for (const f of owned) expect(f.startsWith(HERE)).toBe(true);
  });
});
