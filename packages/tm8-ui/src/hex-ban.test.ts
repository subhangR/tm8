import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §14 — THE HEX BAN. Colour always resolves through a token.
 *
 * A PACKAGE-LEVEL GUARD, OWNED BY NO LANE. It lives at the package root and is
 * named for the LAW rather than a module, because that is what it enforces:
 * one palette for the whole package. A red here is not a boundary violation
 * and not an accusation — it is information about a package-wide law, routed
 * to the owning seat by the coordinator.
 *
 * WHY IT MOVED HERE (fe->a1c 92/93, found by A1 Nav-Registry).
 *
 * This assertion used to live inside `panels/no-branching.test.ts`, sharing
 * that file's LANE scope. Its coverage then shrank TWICE BY SIDE EFFECT:
 * once when the charter carved `terminal/` to Track P — a jurisdiction ruling
 * nobody intended as a hex exemption — and once by never having included
 * `shell.css`, `kit.css`, `styles/app.css` or `views/` at all. Nobody ever
 * DECIDED those were exempt. It fell out of two other decisions, while the
 * ledger went on claiming the guard "scans every owned stylesheet". Clean when
 * found: a latent hole, not an incident.
 *
 * The first proposed fix was to widen the lane guard's own scope. That was
 * refused, and the reason is the shape of this file: a lane guard that fails
 * on another seat's file makes the WRONG SEAT RED — they cannot fix it, their
 * only moves are nag or exempt, and exempt is how guards die. A guard that
 * blocks the wrong lane is worse than the hole it closes. So the two laws are
 * split by their actual scope instead: §15.2's kind-literal ban is a COMPONENT
 * law and stays lane-scoped in `panels/no-branching.test.ts`; the hex ban is a
 * PACKAGE law and lives here, where a violation turns the package red.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = HERE;

/**
 * EXACTLY FOUR EXCLUSIONS, each carrying its reason. The count is ASSERTED
 * below: this is the transferable fix for the it-fell-out-of-two-other-
 * decisions failure. Coverage can no longer shrink as a side effect, because
 * shrinking it fails a test and whoever shrinks it must justify the new number.
 */
const EXCLUSIONS: readonly { path: string; why: string }[] = [
  {
    path: 'data',
    why: 'bridge lane — a seat the user closed deliberately; not FE territory to police',
  },
  {
    path: 'terminal',
    why: 'Track P jurisdiction (charter carve-out). R9 verbatim transplants legitimately carry raw hex, and bringing one into compliance would stop it being verbatim — the laws are irreconcilable by design, so this is settled jurisdictionally. FLAGGED TO TRACK P through master as their risk to carry, deliberately not a silent exemption.',
  },
  {
    path: 'styles/tokens.css',
    why: 'the byte-verbatim palette transplant — here the hexes ARE the product, guarded by A0 byte-equality',
  },
  {
    path: 'styles/canvas-extra.css',
    why: 'the canvas-measured colours tokens.css has no entry for; the one named, auditable extension file',
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function excluded(rel: string): boolean {
  return EXCLUSIONS.some((x) => rel === x.path || rel.startsWith(`${x.path}/`));
}

const packageFiles = walk(SRC).filter((f) => !excluded(relative(SRC, f)));

const styleFiles = packageFiles.filter((f) => f.endsWith('.css'));

/**
 * Tests are excluded from the SOURCE scan: a test proving a token resolves to
 * a measured value has to be able to name that value.
 */
const sourceFiles = packageFiles
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f));

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('§14 — the hex ban is a PACKAGE law', () => {
  it('excludes EXACTLY four paths, each with a stated reason', () => {
    // The control on the control. A future scope carve must touch this list
    // consciously; it can no longer shrink coverage on its way past.
    expect(EXCLUSIONS).toHaveLength(4);
    for (const x of EXCLUSIONS) {
      expect(x.why.length, `exclusion '${x.path}' must state WHY`).toBeGreaterThan(20);
    }
  });

  it('scans the PACKAGE, including the files the silent shrink had dropped', () => {
    // Both-halves control, aimed at THIS defect: a guard that scanned one
    // directory while its ledger entry claimed the package. Naming the
    // previously-dropped files means a re-shrink fails here rather than
    // passing quietly over a smaller set.
    const scanned = styleFiles.map((f) => relative(SRC, f));
    expect(scanned).toContain('shell/shell.css');
    expect(scanned).toContain('kit/kit.css');
    expect(scanned).toContain('styles/app.css');
    expect(scanned).toContain('panels/panels.css');
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it('no stylesheet in the package carries a raw hex colour', () => {
    const offenders: string[] = [];
    for (const file of styleFiles) {
      const text = stripCssComments(readFileSync(file, 'utf8'));
      const hits = text.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(
      offenders,
      `raw hex outside styles/tokens.css and styles/canvas-extra.css:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no component inlines a hex colour in a style prop', () => {
    // SIX digits deliberately, not {3,8}: prose in source legitimately carries
    // things like 'PR #212', and a 3-digit match would flag an issue number as
    // a colour. The CSS scan above can afford {3,8} because stylesheets do not
    // contain issue numbers.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const hits = text.match(/#[0-9a-fA-F]{6}\b/g);
      if (hits) offenders.push(`${relative(SRC, file)} → ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, `inline hex in a component:\n${offenders.join('\n')}`).toEqual([]);
  });
});
