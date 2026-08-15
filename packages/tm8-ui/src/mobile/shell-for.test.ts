import { describe, expect, it } from 'vitest';
import { MOBILE_MAX_WIDTH, asShellKind, shellFor } from './shell-for';

/**
 * §4.4's decision, proved WITHOUT A DOM. No jsdom, no render, no window — if
 * this file ever needs one, the predicate has stopped being pure and the seam
 * has moved into the hook where it does not belong.
 */

describe('§4.4 — shellFor: coarse pointer AND narrow', () => {
  it('the three worked examples from the ruling', () => {
    // iPhone 390, coarse → mobile
    expect(shellFor({ pointer: 'coarse', width: 390 })).toBe('mobile');
    // iPad 820, coarse → desktop (the override is how a user disagrees)
    expect(shellFor({ pointer: 'coarse', width: 820 })).toBe('desktop');
    // desktop dragged to 390, fine → desktop, descending the existing ladder
    expect(shellFor({ pointer: 'fine', width: 390 })).toBe('desktop');
  });

  it('BOTH conditions are required — neither alone selects the mobile shell', () => {
    // This is the whole content of the ruling: it is an AND, not an OR. A
    // width-only rule would hand touch targets to a narrow desktop window and
    // make the §3.3 solver fix dead code.
    expect(shellFor({ pointer: 'fine', width: 320 })).toBe('desktop');
    expect(shellFor({ pointer: 'coarse', width: 1024 })).toBe('desktop');
    expect(shellFor({ pointer: 'coarse', width: 320 })).toBe('mobile');
  });

  it('the threshold is exclusive: the boundary width itself is desktop', () => {
    expect(shellFor({ pointer: 'coarse', width: MOBILE_MAX_WIDTH - 1 })).toBe('mobile');
    expect(shellFor({ pointer: 'coarse', width: MOBILE_MAX_WIDTH })).toBe('desktop');
  });

  it('the threshold is a named constant, so re-measuring it is a one-line change', () => {
    // §4.4 calls the ~500 a placeholder until reference capture. This pins that
    // the value is reachable and that both sides of it are covered above,
    // rather than pinning the provisional number as if it were ruled.
    expect(MOBILE_MAX_WIDTH).toBeGreaterThan(0);
  });

  describe('the override wins outright — that is what an override is', () => {
    it('forces mobile on a wide fine-pointer desktop', () => {
      expect(shellFor({ pointer: 'fine', width: 1600, override: 'mobile' })).toBe('mobile');
    });

    it('forces desktop on a narrow coarse-pointer phone', () => {
      expect(shellFor({ pointer: 'coarse', width: 390, override: 'desktop' })).toBe('desktop');
    });

    it('an unset override defers to the rule, however it is spelled', () => {
      expect(shellFor({ pointer: 'coarse', width: 390, override: null })).toBe('mobile');
      expect(shellFor({ pointer: 'coarse', width: 390, override: undefined })).toBe('mobile');
      expect(shellFor({ pointer: 'coarse', width: 390 })).toBe('mobile');
    });
  });

  it('an unmeasurable width falls back to DESKTOP, not to the new shell', () => {
    // A measurement bug must not be able to turn the desktop app into a phone
    // app. Failing toward the shell that has always existed is the cheaper of
    // the two failures.
    expect(shellFor({ pointer: 'coarse', width: Number.NaN })).toBe('desktop');
    expect(shellFor({ pointer: 'coarse', width: Number.POSITIVE_INFINITY })).toBe('desktop');
  });

  it('is total and pure: same input, same answer, no hidden state', () => {
    const input = { pointer: 'coarse', width: 390 } as const;
    const answers = new Set([shellFor(input), shellFor(input), shellFor(input)]);
    expect(answers.size).toBe(1);
    // Total over the grid: every combination returns one of exactly two kinds.
    for (const pointer of ['coarse', 'fine'] as const) {
      for (const width of [0, 1, 390, 500, 820, 4096]) {
        expect(['mobile', 'desktop']).toContain(shellFor({ pointer, width }));
      }
    }
  });
});

describe('asShellKind — a corrupt stored preference cannot break shell selection', () => {
  it('accepts exactly the two kinds', () => {
    expect(asShellKind('mobile')).toBe('mobile');
    expect(asShellKind('desktop')).toBe('desktop');
  });

  it('reads anything else as "no override set" rather than throwing', () => {
    // The override is read back from device storage: a stale value from an
    // older build, or whatever someone typed into devtools.
    expect(asShellKind('phone')).toBeNull();
    expect(asShellKind('')).toBeNull();
    expect(asShellKind(null)).toBeNull();
    expect(asShellKind(undefined)).toBeNull();
    expect(asShellKind('MOBILE')).toBeNull();
  });
});
