import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §4.3 — THE SHELL FORKS AND THE ROUTER DOES NOT.
 *
 * > One `navStore`, one route codec, one browser history, one URL grammar —
 * > two renderings of the same state.
 *
 * THE LAW, as enforced here: NO FILE UNDER THE MOBILE SHELL WRITES OR READS
 * `location.hash`, DRIVES `history.*`, MOUNTS A ROUTER, OR CONSTRUCTS A
 * `Route`. It renders from the shared store and navigates by asking that store
 * to move. Reading `navStore` is not on the forbidden list and must never be —
 * that is the shared state both shells are supposed to render from.
 *
 * WHY IT IS A TEST AND NOT A CONVENTION. If the mobile shell ever acquires its
 * own routing, two history models exist, and two history models cannot agree
 * about what BACK means. The failure is not a wrong pixel: it is that the same
 * URL means two different things on two devices, and "I share a link from
 * desktop and the correct entity appears on the phone" — §6, the whole point
 * of the feature — fails on the spot. That is invisible to review and obvious
 * only in the bug report, so it is enforced the way this codebase already
 * enforces the kind-literal ban in `panels/no-branching.test.ts`: by reading
 * the files.
 *
 * ── THE ANTI-VACUITY GUARANTEE, STATED BECAUSE IT IS THE POINT ─────────────
 *
 * A boundary test that globs a directory, matches nothing, and reports green
 * is the single most likely way this law dies: it would pass forever while
 * enforcing nothing, and it would look exactly like compliance. Three
 * independent legs below make a vacuous pass IMPOSSIBLE, and each fails LOUDLY
 * rather than silently degrading:
 *
 *   1. SELF-LOCATING (`scans the shell it lives inside`). This file sits IN
 *      the directory it guards, so the directory provably exists — and the
 *      scan must find shipped files in it. If the shell is renamed or moved,
 *      this test moves with it and keeps working. If the shell is emptied, the
 *      test FAILS rather than passing over zero files. There is no
 *      `if (files.length === 0) return` escape hatch anywhere in this file;
 *      `routes/one-router.test.ts` correctly had one while no mobile shell
 *      existed, and the shell existing is exactly what retires it.
 *
 *   2. PER-PATTERN LIVENESS (`every rule below still matches something`). A
 *      regex can go dead — a typo, an escape lost in a refactor — and a dead
 *      regex matches nothing, which reads as compliance. So each forbidden
 *      pattern is proved live against real router-owning code elsewhere in the
 *      package. Deliberately proved by "matches SOMEWHERE outside the shell"
 *      rather than against a named file: naming `stores/navStore.ts` here
 *      would make another lane's ordinary refactor turn this seat red.
 *
 *   3. DETECTOR LIVENESS (`the sweep can see the package at all`). The file
 *      set is a filter over a directory walk. A moved `src/`, a changed
 *      extension, a walk that silently returned nothing — any of these make
 *      every assertion vacuous at once and look identical to a clean run.
 *
 * Legs 2 and 3 are what the file-count check alone cannot give you: a scan can
 * be non-empty and still be enforcing nothing.
 */

const SHELL_ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(SHELL_ROOT, '..');

/**
 * The homes a mobile shell might plausibly take, named so the intent is
 * readable — and BACKED BY the segment sweep below, so a shell that lands
 * somewhere nobody predicted is still caught. A guard that only looks where it
 * expects the violation reports success for the one case it exists to prevent.
 */
const CANDIDATE_DIRS = ['mobile', 'shell-mobile', 'views/mobile', 'shell/mobile', 'phone'];

/** Any path SEGMENT that marks a file as belonging to the small-screen shell. */
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

const isShipped = (f: string) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f);

/**
 * Comments are stripped BEFORE scanning, exactly as `panels/no-branching.test.ts`
 * strips them for the kind-literal ban, and for the identical reason: the
 * docblocks in this shell QUOTE THE VERY THINGS THEY FORBID in order to explain
 * why they are forbidden. `useShellKind.ts` documents the jsdom hash-leak trap
 * by writing out the reset line the next author must add — which is the single
 * most useful sentence in that file, and a law that bans it would be trading
 * real documentation for no extra safety, since a comment cannot navigate.
 *
 * FOUND THE HONEST WAY: this rule was added because the scan CAUGHT THAT
 * DOCBLOCK. The law worked; the scope was wrong.
 *
 * Line comments are matched only when they START the line (`^\s*//`), never
 * mid-line — a mid-line rule would eat the `//` in any URL and silently delete
 * live code from the scan, which is how a strip step turns into a hole.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const readCode = (file: string) => stripComments(readFileSync(file, 'utf8'));

const allSource = walk(SRC).filter(isShipped);

/** Shipped files in the directory THIS TEST LIVES IN. Leg 1's anchor. */
const shellRootFiles = walk(SHELL_ROOT).filter(isShipped);

const mobileFiles = allSource.filter((file) => {
  const rel = relative(SRC, file);
  if (CANDIDATE_DIRS.some((dir) => rel === dir || rel.startsWith(dir + sep))) return true;
  /* A file NAMED `MobileFoo.tsx` inside the shared shell is deliberately NOT
     caught — a shared component with a responsive branch is the design, and
     banning the word would ban the thing this law permits. It is the DIRECTORY
     that marks a fork. */
  return rel
    .split(sep)
    .slice(0, -1)
    .some((segment) => MOBILE_SEGMENT.test(segment));
});

/**
 * Owning the router means DECIDING WHAT THE ADDRESS SAYS, or WHERE HISTORY
 * GOES. Both are the store's job, for both shells.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\blocation\s*\.\s*hash\b/, why: 'reads or writes the address directly' },
  { pattern: /\b(push|replace)State\b/, why: 'drives browser history directly' },
  { pattern: /\battachRouter\b/, why: 'mounts a second router' },
  { pattern: /\bcreateBrowserTarget\b/, why: 'binds its own transport to the address bar' },
  {
    /* Value imports from the codec — building or parsing a Route is exactly
       "having its own routing". `import type` stays legal and must: naming the
       shared vocabulary is the opposite of forking it. */
    pattern: /import\s+(?!type\b)[^;]*\bfrom\s+['"][^'"]*\/routes(\/[^'"]*)?['"]/,
    why: 'imports the codec as values — it builds or parses routes itself',
  },
];

describe('§4.3 — the shell forks and the router does not', () => {
  it('scans the shell it lives inside (a green run over zero files proves nothing)', () => {
    /* LEG 1. Unconditional by construction: this test file is INSIDE the
       directory it guards, so "no files found" can only mean the detector
       broke or the shell was gutted — never that the law is satisfied. */
    expect(
      shellRootFiles.length,
      `No shipped files found in ${relative(SRC, SHELL_ROOT)}/ — this test lives there, so a zero ` +
        'match means the sweep is broken, NOT that the mobile shell is compliant.',
    ).toBeGreaterThan(0);

    /* The package-wide sweep must be a superset of this directory: if it is
       not, the CANDIDATE_DIRS/segment logic has stopped seeing the shell it is
       standing in, and it would silently stop seeing a shell anywhere else. */
    expect(
      mobileFiles.length,
      'The package-wide mobile sweep no longer contains the shell root it is scanning from.',
    ).toBeGreaterThanOrEqual(shellRootFiles.length);
  });

  it('every rule below still matches something (no rule has quietly gone dead)', () => {
    /* LEG 2. A dead regex matches nothing and reads as compliance. Each rule
       is proved live against real router-owning code elsewhere in the package
       — `stores/navStore.ts`, `routes/transport.ts`, the mount in
       `views/GateApp.tsx`. Proved by EXISTENCE rather than by naming those
       files, so another lane's refactor cannot turn this seat red. */
    const outside = allSource.filter((f) => !mobileFiles.includes(f));
    const dead: string[] = [];
    for (const { pattern, why } of FORBIDDEN) {
      const live = outside.some((f) => pattern.test(readCode(f)));
      if (!live) dead.push(`${pattern} (${why})`);
    }
    expect(
      dead,
      'These rules matched NOTHING anywhere in the package, including the files that legitimately ' +
        'own the router. A rule that matches nothing cannot catch anything:\n' +
        dead.join('\n'),
    ).toEqual([]);
  });

  it('the sweep can see the package at all (the detector is not silently broken)', () => {
    /* LEG 3. The guard on the guard. Every set above is a filter over this
       walk, so an empty `allSource` makes the whole law vacuous FOREVER and
       looks identical to a clean run. */
    expect(allSource.length).toBeGreaterThan(100);
    expect(allSource.some((f) => f.endsWith(join('stores', 'navStore.ts')))).toBe(true);
  });

  it('no mobile-shell file owns the address or the history', () => {
    const violations: string[] = [];
    for (const file of mobileFiles) {
      const text = readCode(file);
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${relative(SRC, file)} — ${why}`);
      }
    }
    expect(
      violations,
      'A mobile shell with its own routing means two history models, and two history models cannot ' +
        'agree about what BACK means. Render differently; route through the one navStore.',
    ).toEqual([]);
  });
});
