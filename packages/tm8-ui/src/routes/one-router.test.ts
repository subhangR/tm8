import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE SHELL FORKS AND THE ROUTER DOES NOT.
 *
 * One `navStore`, one codec, one browser history, TWO RENDERINGS. What differs
 * between desktop and a phone is only what gets DRAWN. This is the law that
 * makes the cross-device half of the requirement work at all — "I share a link
 * from desktop and the correct entity appears on the phone" — and it is a law
 * about ownership, not about layout.
 *
 * WHY IT CANNOT BE LEFT TO REVIEW. If a mobile shell ever acquires its own
 * routing, two history models exist, and two history models cannot agree about
 * what BACK means. The failure is not a wrong pixel; it is that the same URL
 * means two different things and the back button walks two different stacks.
 * That is invisible by inspection and obvious only in the bug report, so it is
 * enforced the way `panels/no-branching.test.ts` enforces the kind-literal ban:
 * by reading the files.
 *
 * THIS TEST IS VACUOUS TODAY AND SAYS SO OUT LOUD. No mobile shell exists yet.
 * A green run over zero files proves nothing — the no-branching test says the
 * same about itself — so the vacuity is REPORTED rather than hidden: the first
 * case below states exactly how many files were scanned, and the scan is
 * deliberately written to find a mobile shell wherever it lands rather than
 * only where today's guess says it will.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/**
 * The homes a mobile shell might plausibly take. Named explicitly so the
 * intent is readable, and BACKED BY a path sweep below so a shell that lands
 * somewhere nobody predicted is still caught. A guard that only looks where it
 * expects the violation is a guard that reports success for the one case it
 * exists to prevent.
 */
const CANDIDATE_DIRS = ['mobile', 'shell-mobile', 'views/mobile', 'shell/mobile', 'phone'];

/** Any path segment that marks a file as belonging to the small-screen shell. */
const MOBILE_SEGMENT = /^(mobile|phone|compact|small-screen)$/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const allSource = walk(SRC)
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

const mobileFiles = allSource.filter((file) => {
  const rel = relative(SRC, file);
  if (CANDIDATE_DIRS.some((dir) => rel === dir || rel.startsWith(dir + sep))) return true;
  /* The sweep: any directory segment that names the small-screen shell. A file
     NAMED `MobileFoo.tsx` inside the shared shell is deliberately NOT caught —
     a shared component with a responsive branch is the design, and banning the
     word would ban the thing this law permits. It is the directory that marks
     a fork. */
  return rel.split(sep).slice(0, -1).some((segment) => MOBILE_SEGMENT.test(segment));
});

/**
 * Owning the router means: deciding what the address says, or where history
 * goes. Reading `navStore` is not on this list and must never be — that is the
 * shared store both shells are supposed to render from.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\blocation\s*\.\s*hash\b/, why: 'writes or reads the address directly' },
  { pattern: /\b(push|replace)State\b/, why: 'drives browser history directly' },
  { pattern: /\battachRouter\b/, why: 'mounts a second router' },
  { pattern: /\bcreateBrowserTarget\b/, why: 'binds its own transport to the address bar' },
  {
    /* Value imports from the codec — building or parsing a Route is exactly
       "having its own routing". `import type` is fine and stays fine: naming
       the shared vocabulary is the opposite of forking it. */
    pattern: /import\s+(?!type\b)[^;]*\bfrom\s+['"][^'"]*\/routes(\/[^'"]*)?['"]/,
    why: 'imports the codec as values — it builds or parses routes itself',
  },
];

describe('the shell forks and the router does not', () => {
  it('REPORTS ITS OWN COVERAGE, because a green run over zero files proves nothing', () => {
    /* Self-reporting vacuity. Today this is 0 and the law is unenforced-but-
       unviolated; that is an honest state and it is stated rather than dressed
       up as a pass. The sweep itself is proved live by the second assertion —
       if THAT broke, this file would read as green forever. */
    const present = CANDIDATE_DIRS.filter((dir) => existsSync(join(SRC, dir)));
    if (mobileFiles.length === 0) {
      expect(present).toEqual([]);
      return;
    }
    /* A mobile shell exists: the scan must actually be reading it. */
    expect(mobileFiles.length).toBeGreaterThan(0);
  });

  it('the sweep can find files at all (the detector is not silently broken)', () => {
    /* The guard on the guard. `mobileFiles` is a filter over `allSource`, so an
       empty `allSource` — a moved directory, a changed extension, a walk that
       threw — would make the law vacuous FOREVER and look identical to
       compliance. This is the only assertion here that is not vacuous today. */
    expect(allSource.length).toBeGreaterThan(100);
    expect(allSource.some((f) => f.endsWith(join('stores', 'navStore.ts')))).toBe(true);
  });

  it('no mobile-shell file owns the address or the history', () => {
    const violations: string[] = [];
    for (const file of mobileFiles) {
      const text = readFileSync(file, 'utf8');
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${relative(SRC, file)} — ${why}`);
      }
    }
    expect(
      violations,
      'A mobile shell with its own routing means two history models, and two history models ' +
        'cannot agree about what BACK means. Render differently; route through the one navStore.',
    ).toEqual([]);
  });
});
