import { defineConfig, devices } from '@playwright/test';

/**
 * The launch hand-off's live check (task 01a182d2) — see
 * `launch-handoff.spec.ts` for the dev slot it expects. No web server: the
 * node and the UI are started for the slot, and the spec skips without them.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'launch-handoff.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    ...(process.env.TM8_E2E_LIVE_STORAGE ? { storageState: process.env.TM8_E2E_LIVE_STORAGE } : {}),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
