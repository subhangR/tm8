/**
 * The audit fixture must load EXACTLY the stylesheets production loads.
 *
 * This is the one assertion about the harness that a unit test can actually
 * make, and it is worth making precisely because the harness's whole job is to
 * be trusted. If `main.tsx` gains a stylesheet and `mobile-audit-entry.tsx` does
 * not, every number the instrument produces from then on is taken off a page
 * styled differently from the app — and it would keep reporting confidently.
 * A wrong baseline is worse than none, because lanes would be measured against
 * it for weeks.
 *
 * It reads the two files as TEXT rather than importing them. Importing either
 * one mounts React against a DOM that does not exist here, and jsdom would load
 * none of these stylesheets anyway — which is the whole reason the Playwright
 * harness exists. This is a source-parity check, and source is what it reads.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cssImportsOf = (file: string): string[] =>
  [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/^import\s+'([^']+\.css)';$/gm)].map((m) => m[1]!);

describe('mobile-audit fixture / main entry CSS parity', () => {
  it('loads the same stylesheets as main.tsx, in the same order', () => {
    const main = cssImportsOf('./main.tsx');
    const audit = cssImportsOf('./mobile-audit-entry.tsx');

    /* Guards the guard: a regex that silently matched nothing would make this
       test pass forever while checking two empty lists against each other. */
    expect(main.length).toBeGreaterThan(5);
    expect(audit).toEqual(main);
  });
});
