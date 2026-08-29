import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const homeCss = strip(readFileSync(new URL('./home-page.css', import.meta.url), 'utf8'));
const metricsCss = strip(
  readFileSync(new URL('../navigation/entity-navigation-metrics.css', import.meta.url), 'utf8'),
);
const pageTsx = strip(readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8'));

describe('Home entity navigation surface contract', () => {
  it('keeps the workspace map bounded by its parent instead of viewport math', () => {
    const overview = homeCss.match(/\.cv2-root \.hp-overview\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(overview).toContain('max-height: 38%');
    expect(overview).toContain('overflow-y: auto');
    expect(overview).toContain('overscroll-behavior: contain');
    expect(homeCss).not.toMatch(/calc\(\s*100vh/i);
  });

  it('uses the shared Kinetic richness and interaction grammar', () => {
    expect(pageTsx).toContain('hp-overview k-hero k-accent-top k-enter');
    expect(pageTsx).toContain('hp-overview__kind k-press');
    expect(pageTsx).toContain('k-btn k-btn--secondary k-btn--sm');
  });

  it('preserves selected state and count meaning in forced colours', () => {
    expect(homeCss).toMatch(/@media \(forced-colors: active\)[\s\S]*\.hp-overview__kind\[aria-current='page'\]/);
    expect(metricsCss).toMatch(/@media \(forced-colors: active\)[\s\S]*\.enav-metric--live/);
    expect(metricsCss).toContain('.enav-metric__unit');
  });

  it('introduces no literal colours outside the token sheet', () => {
    expect(homeCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(metricsCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
