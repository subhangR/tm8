import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Anti-drift guard: `tokens.css` may not be hand-edited. An accidental change
 * to the palette is a change to every surface in the package at once, and it
 * is the kind of edit that looks harmless in a diff.
 *
 * WHAT TONIGHT'S RULING CHANGED, and why the shape below (2026-07-28).
 * This guard used to compare `tokens.css` against an ABSOLUTE path into the
 * design package — a directory that is NOT TRACKED BY GIT. So it had only ever
 * run on one machine: on any other clone it does not fail, it errors on a
 * missing file. Nobody noticed for the whole build, because the one machine it
 * ran on was the one it was written on.
 *
 * It surfaced when a RULED change tried to move it. The user ruled the T0-1
 * canvas wins over the token file for dark `--pn-paper` (#15130E → #1D1912),
 * and the instruction was that a ruled change moves the guard WITH the value,
 * as one commit, one fact. That turned out to be impossible: git cannot carry
 * the reference, because the reference is not in the repository. A commit
 * would have implied a guarantee it did not have.
 *
 * Hence the twin. `tokens.reference.css` is a TRACKED, byte-identical copy and
 * carries no header of its own — byte-identity is the entire point, so anything
 * written inside it would break the thing it exists to prove. Provenance lives
 * here instead.
 *
 * The guard's real function is preserved: an ACCIDENTAL edit to tokens.css
 * still fails, because the twin only ever changes when someone deliberately
 * changes both in the same ruled stroke. What is lost is the claim that our
 * copy matches the design package on a machine that does not have it — and
 * that claim was never true off this machine, which is the finding.
 */

/** Repo-relative, so this works on any clone. THE PRIMARY GUARD. */
const LOCAL_TOKENS = fileURLToPath(new URL('./tokens.css', import.meta.url));
const ASTRYX_BRIDGE = fileURLToPath(new URL('./astryx-bridge.css', import.meta.url));
/**
 * The twin lives OUTSIDE src/ deliberately, and this collision is the
 * provenance: it was first created at src/styles/tokens.reference.css, and the
 * package hex guard caught it within minutes — a file full of raw hex inside
 * the directory whose palette that guard polices. The fix was not to exempt it.
 * The twin is not SHIPPED SOURCE; it is a test reference — not a hex HOME but a
 * photograph of one — so it belongs outside src/ and the guard's four
 * exclusions stay exactly four.
 *
 * Worth recording for whoever reads the guard next: the first thing that guard
 * did after catching another lane's dev harness was catch OUR OWN new file.
 * A control with no owner's exemption is the only kind worth having.
 */
const TWIN = fileURLToPath(new URL('../../test-references/tokens.reference.css', import.meta.url));

/** Absolute, untracked, this-machine-only. Deliberately a SECOND check. */
const DESIGN_TOKENS =
  '/Users/subhang/Desktop/Projects/tm8/T0-1 workspace structure review (1)/uploads/tm8-ui-design/05-DESIGN-SYSTEM/tokens.css';

describe('tokens.css anti-drift', () => {
  it('is byte-identical to its tracked reference twin', () => {
    const local = readFileSync(LOCAL_TOKENS);
    const twin = readFileSync(TWIN);
    expect(
      local.equals(twin),
      'src/styles/tokens.css has drifted from test-references/tokens.reference.css. If this is a RULED change, move both in the same commit; if it is not, revert it — the palette is not hand-edited.',
    ).toBe(true);
  });

  /**
   * VISIBLY skipped when the design package is absent, never silently passed.
   * A skip that announces itself is a known gap; a silent pass is the D10
   * family — a control that reports success for a check it did not run.
   */
  it.skipIf(!existsSync(DESIGN_TOKENS))(
    'matches the design-package source (this-machine-only oracle check)',
    () => {
      const design = readFileSync(DESIGN_TOKENS);
      const local = readFileSync(LOCAL_TOKENS);
      expect(
        local.equals(design),
        'tokens.css differs from the design package source. Expected after a ruled change until the design package is re-synced.',
      ).toBe(true);
    },
  );
});

describe('Astryx semantic bridge', () => {
  const bridge = readFileSync(ASTRYX_BRIDGE, 'utf8');

  it('pins light-dark() to the tm8 scope in both mount shapes', () => {
    expect(bridge).toMatch(/\.cv2-root\s*\{\s*color-scheme:\s*light;/);
    expect(bridge).toMatch(/\.cv2-root\[data-theme='dark'\]/);
    expect(bridge).toMatch(/\[data-theme='dark'\]\s+\.cv2-root/);
    expect(bridge).toMatch(/color-scheme:\s*dark;/);
  });

  it.each([
    ['--color-background-surface', '--pn-surface'],
    ['--color-background-body', '--pn-paper'],
    ['--color-background-card', '--pn-card'],
    ['--color-background-muted', '--pn-hover'],
    ['--color-neutral', '--pn-idle-soft'],
    ['--color-text-primary', '--pn-ink'],
    ['--color-text-secondary', '--pn-ink-2'],
    ['--color-text-disabled', '--pn-ink-4'],
    ['--color-border', '--pn-line'],
    ['--color-border-emphasized', '--pn-line-2'],
    ['--color-track', '--pn-line-2'],
    ['--color-accent', '--pn-brand'],
    ['--color-accent-muted', '--pn-brand-soft'],
    ['--color-success', '--pn-run'],
    ['--color-success-muted', '--pn-run-soft'],
    ['--color-warning', '--pn-wait'],
    ['--color-warning-muted', '--pn-wait-soft'],
    ['--color-error', '--pn-block'],
    ['--color-error-muted', '--pn-block-soft'],
  ])('%s resolves from the Kinetic semantic token %s', (astryx, kinetic) => {
    expect(bridge).toMatch(
      new RegExp(`${astryx.replaceAll('-', '\\-')}:\\s*var\\(${kinetic.replaceAll('-', '\\-')}\\);`),
    );
  });

  it('gives solid Astryx signals theme-aware readable foregrounds', () => {
    expect(bridge).toMatch(
      /--color-on-accent:\s*light-dark\(var\(--pn-card\),\s*var\(--pn-paper\)\);/,
    );
    for (const semantic of ['success', 'warning', 'error']) {
      expect(bridge).toMatch(
        new RegExp(
          `--color-on-${semantic}:\\s*light-dark\\(var\\(--pn-ink\\),\\s*var\\(--pn-paper\\)\\);`,
        ),
      );
    }
  });

  it('never reintroduces the ruled-out Astryx -> Kinetic palette remap', () => {
    expect(bridge).not.toMatch(/--pn-(?:paper|surface|card|ink|brand|run|wait|block|info|idle):\s*var\(--color-/);
  });
});
