import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE STRIP FITS THE PHONE (task 01a14e1d). jsdom has no layout, so this pins
 * the rules that made it true; the measured half is `bun run audit:mobile`,
 * whose clip gate fails a phone row when any element's right edge is past the
 * viewport. Before the fix the strip ran to x=1195 at 360 with 20px controls,
 * and the old gate (scrollers only) passed it because the frame clips.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(new URL('./created-here.css', import.meta.url), 'utf8'));
const audit = readFileSync(new URL('../../../e2e/mobile-audit.mjs', import.meta.url), 'utf8');

const P = ".cv2-root[data-shell='mobile']";

function bodiesFor(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  return out.join('\n');
}

describe('the created-entities strip on the phone', () => {
  it('draws its line at the 44px touch floor', () => {
    expect(bodiesFor(`${P} .tch-made`)).toMatch(/--tch-made-rule:\s*var\(--mobile-touch-min, 44px\)/);
  });

  it('wraps the line and the kinds instead of running past the right edge', () => {
    expect(bodiesFor(`${P} .tch-made__rule`)).toMatch(/flex-wrap:\s*wrap/);
    expect(bodiesFor(`${P} .tch-made__rule`)).toMatch(/height:\s*auto/);
    const kinds = bodiesFor(`${P} .tch-made__kinds`);
    expect(kinds).toMatch(/flex-wrap:\s*wrap/);
    expect(kinds).toMatch(/min-width:\s*0/);
    /* Many kinds scroll down, never sideways. */
    expect(kinds).toMatch(/overflow-x:\s*hidden/);
  });

  it.each(['.tch-made__kind', '.tch-made__attach', '.tch-made__toggle'])('gives %s a 44px box', (cls) => {
    const body = bodiesFor(`${P} ${cls}`);
    expect(body).toMatch(/height:\s*var\(--tch-made-rule\)/);
    expect(body).toMatch(/min-width:\s*var\(--tch-made-rule\)/);
    expect(body).toMatch(/background-clip:\s*padding-box/);
  });
});

describe('audit:mobile gates clipped content, not only scrollers', () => {
  it('fails a phone row with any element right of the viewport', () => {
    expect(audit).toMatch(/expectShell === 'mobile' && shellOk && m\.overflowCount > 0\) \{\s*[^}]*noscrollFailures\.push/);
  });
});
