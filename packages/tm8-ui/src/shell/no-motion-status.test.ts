/**
 * THE DETECTOR for the D31 defect class: motion in the shell must never carry
 * status, and only a pool-activity signal attributed to ONE identified session
 * may animate at all (D6 / LLD §2.2-F1 / R-UI-5, §13, C8/L10).
 *
 * WHY IT SCANS THE STYLESHEET RATHER THAN THE DOM. My first plan was a
 * class-surface assertion — `querySelectorAll('[class*="pulse"]')` is empty.
 * That detector would NOT have caught the bug it was written for: the offending
 * element's class was `shell-rail__live-corner`, which contains no "pulse"
 * substring, and the animation was attached in CSS. The test would have passed
 * green over the live defect, which is the exact failure it was meant to end.
 * jsdom also loads no stylesheets, so `getComputedStyle` cannot see an
 * `animation` property here — a DOM-level check is structurally unable to
 * answer this question.
 *
 * So the detector reads the SOURCE and treats every `animation:` declaration in
 * shell.css as guilty until allowlisted. That is deliberately stricter than the
 * law: the law permits animation for a pool-attributed activity signal, and
 * shell currently renders no such element, so the correct allowlist today is
 * empty. When the terminal lane brings a real activity-driven mark into shell,
 * the allowlist gains one entry WITH its justification, and that edit is a
 * visible, reviewable decision instead of a silent reintroduction.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shellCss = readFileSync(fileURLToPath(new URL('./shell.css', import.meta.url)), 'utf8');

/**
 * Selectors permitted to animate, each with the attribution that makes it
 * legal. EMPTY BY DESIGN — see the docblock. Adding an entry is the decision
 * point; it should be hard to do by accident and obvious in review.
 */
const ANIMATION_ALLOWLIST: { selector: string; because: string }[] = [];

/** Every `animation:` declaration in the file, paired with its owning selector. */
function animationDeclarations(source: string): { selector: string; value: string }[] {
  // Strip comments FIRST. Without this, the docblock above a rule is swallowed
  // into the "selector" — which made the failure message unreadable and, worse,
  // would stop an allowlist entry from ever matching its own rule. Found by the
  // inverted run, not by reasoning.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: { selector: string; value: string }[] = [];
  // Walk rule blocks: `<selector> { <body> }`. Good enough for a flat,
  // hand-written stylesheet, and it fails LOUD (a parse miss shows up as a
  // missing hit in the positive-control test below, not as a silent pass).
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(css)) !== null) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
    const body = match[2] ?? '';
    for (const declaration of body.split(';')) {
      const [property, ...rest] = declaration.split(':');
      if (property?.trim() === 'animation') {
        found.push({ selector, value: rest.join(':').trim() });
      }
    }
  }
  return found;
}

describe('shell.css carries no status-bearing motion (D31)', () => {
  it('has no animation declaration outside the allowlist', () => {
    const offenders = animationDeclarations(shellCss)
      // `animation: none` REMOVES motion; it can never introduce it.
      .filter((declaration) => declaration.value !== 'none')
      .filter(
        (declaration) =>
          !ANIMATION_ALLOWLIST.some((allowed) => allowed.selector === declaration.selector),
      );

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Unjustified animation in shell.css: ${offenders
            .map((o) => `${o.selector} { animation: ${o.value} }`)
            .join(' · ')}\n` +
          'Only a pool-activity signal attributed to ONE identified session may ' +
          'animate (D6/§2.2-F1/R-UI-5). If this is that, add it to ' +
          'ANIMATION_ALLOWLIST with its attribution. If it presents liveness, a ' +
          'count, or any other status, it must not move (§13, C8/L10).',
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: the scanner finds an animation when one is present', () => {
    // Without this, "no offenders" is equally consistent with "the parser never
    // matched anything" — a control comes before the thing under test.
    //
    // It runs against a FIXED synthetic stylesheet, never against shell.css.
    // The first version appended an offender to the real file and asserted
    // exactly one hit, which meant the control only passed while the real file
    // was already clean — it failed during the inverted run for the wrong
    // reason, reporting a defect in the product as a broken control. A control
    // coupled to the thing it validates is not a control.
    const synthetic = `
      /* a docblock that must not leak into the selector */
      .cv2-root .fake-status { animation: pnPulse 1.6s infinite; color: red; }
      .cv2-root .fake-quiet  { color: blue; }
    `;
    const found = animationDeclarations(synthetic).filter((d) => d.value !== 'none');
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe('.cv2-root .fake-status');
    expect(found[0]?.value).toBe('pnPulse 1.6s infinite');
  });

  it('POSITIVE CONTROL: `animation: none` is recognised and never counted as motion', () => {
    const synthetic = '.cv2-root .a { animation: none; } .cv2-root .b { animation: spin 1s; }';
    const all = animationDeclarations(synthetic);
    expect(all.some((d) => d.value === 'none')).toBe(true);
    expect(all.filter((d) => d.value !== 'none').map((d) => d.selector)).toEqual([
      '.cv2-root .b',
    ]);
  });
});
