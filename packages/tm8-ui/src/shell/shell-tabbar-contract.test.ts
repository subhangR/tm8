import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(new URL('./shell.css', import.meta.url), 'utf8'));
const component = readFileSync(new URL('./SpaceTabBar.tsx', import.meta.url), 'utf8');

describe('P0 shell bar contract', () => {
  it('centres tabs with balanced gutters instead of pinning them left', () => {
    expect(css).toMatch(
      /\.shell-tabbar\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content\s+minmax\(0,\s*1fr\)/,
    );
    expect(css).toMatch(/\.shell-tabbar__side--end\s*\{[^}]*justify-content:\s*flex-end/);
    expect(css).toMatch(/\.shell-tabbar__tabs\s*\{[^}]*justify-self:\s*center/);
  });

  it('keeps every persistent control on one line without clipping popovers', () => {
    expect(css).toMatch(/\.shell-tabbar__side\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.shell-tabbar__palette\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).not.toMatch(/\.shell-tabbar\s*\{[^}]*overflow:\s*hidden/);
  });

  it('has no redundant More, brand glyph, prompt, or copy-link control', () => {
    expect(component).not.toContain('BrandMark');
    expect(component).not.toContain('>More<');
    expect(component).not.toContain('onOpenPrompts');
    expect(component).not.toContain('shareSlot');
  });
});
