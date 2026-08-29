import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./board.css', import.meta.url)), 'utf8');

describe('Board v2 motion contract', () => {
  it('uses the tm8 fast duration for every card transition', () => {
    const transition = css.match(/\.b2__card\s*\{[^}]*transition:\s*([^;]+);/s)?.[1] ?? '';
    expect(transition).toContain('border-color var(--pn-dur-fast)');
    expect(transition).toContain('opacity var(--pn-dur-fast)');
    expect(transition).not.toContain('box-shadow');
    expect(transition).not.toContain('var(--duration-fast)');
  });

  it('stops both skeleton animation and card transitions under reduced motion', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(reduced).toMatch(/\.b2__skeleton\s*\{\s*animation:\s*none;/);
    expect(reduced).toMatch(/\.b2__card\s*\{\s*transition:\s*none;/);
  });

  it('lets the board overlay yield below its usual 272px floor without changing the global panel law', () => {
    const stage = css.match(/\.b2__stage\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(stage).toContain('width: 100%');
    expect(stage).toContain('max-width: 100%');
    expect(stage).toContain('min-width: 0');
    expect(css).toMatch(/\.b2__panel\s*\{[^}]*min-width:\s*min\(272px, calc\(100% - 24px\)\);/s);
    expect(css).toMatch(/\.b2__panel > \.pn-panel\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*box-sizing:\s*border-box;/s);
    expect(css).not.toContain('.b2 .b2__panel .pn-head__row > *');
    expect(css).not.toContain('.b2 .b2__panel .pn-panelbar > *');
  });
});

describe('Board v2 calm surface contract', () => {
  it('uses border-only cards without family rails or hover elevation', () => {
    const hover = css.match(/\.b2__card:hover\s*\{([^}]*)\}/s)?.[1] ?? '';
    const focused = css.match(/\.b2__card--focused\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(hover).toContain('border-color: var(--color-border-emphasized)');
    expect(hover).not.toContain('box-shadow');
    expect(focused).not.toContain('box-shadow');
    expect(css).not.toMatch(/\.b2\[data-family\][^{]*\.b2__card/);
  });

  it('renders column labels as quiet headings rather than coloured kit pills', () => {
    const title = css.match(/\.b2__col-title\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(title).toContain('color: var(--pn-ink-2)');
    expect(css).not.toContain('.b2 .b2__col-head .kit-pill');
  });
});
