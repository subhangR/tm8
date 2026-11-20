import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHROMIUM_FLAGS, PLAYWRIGHT_DISABLED_FEATURES } from '../../src/browser/chromium-flags.js';

const here = dirname(fileURLToPath(import.meta.url));

function disabledFeatures(flags: readonly string[]): string[] {
  const values = flags.filter((flag) => flag.startsWith('--disable-features='));
  expect(values).toHaveLength(1);
  return values[0]!.slice('--disable-features='.length).split(',');
}

describe('worker Chromium flags', () => {
  it("keeps Playwright's own disabled features in force", () => {
    // Playwright appends caller args after its defaults without merging --disable-features.
    const root = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
    const source = readFileSync(join(root, 'lib/server/chromium/chromiumSwitches.js'), 'utf8');
    const list = /const disabledFeatures = \(assistantMode\) => \[([\s\S]*?)\]/.exec(source)?.[1];
    expect(list).toBeDefined();
    // AutomationControlled is disabled only in assistantMode, which the worker never uses.
    const unconditional = list!.replace(/assistantMode\s*\?\s*"AutomationControlled"\s*:\s*""/, '');
    const playwright = [...unconditional.matchAll(/"([A-Za-z0-9]+)"/g)].map((match) => match[1]!);
    expect(playwright.length).toBeGreaterThan(5);
    expect(new Set(PLAYWRIGHT_DISABLED_FEATURES)).toEqual(new Set(playwright));
    expect(disabledFeatures(CHROMIUM_FLAGS)).toEqual(expect.arrayContaining([...playwright,
      'AutofillServerCommunication', 'PasswordManagerOnboarding']));
  });

  it('never carries a sandbox, debugging or single-process switch', () => {
    for (const flag of CHROMIUM_FLAGS) {
      expect(flag).not.toMatch(/^--(?:no-sandbox|single-process|no-zygote|remote-debugging|disable-web-security|user-data-dir)/);
    }
  });

  it('matches the deploy reference copy', () => {
    const conf = readFileSync(join(here, '../../../../deploy/vault/fill-worker/chromium-flags.conf'), 'utf8');
    expect(conf.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'))).toEqual([...CHROMIUM_FLAGS]);
  });
});
