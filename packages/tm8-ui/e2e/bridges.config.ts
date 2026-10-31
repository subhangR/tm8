import { defineConfig, devices } from '@playwright/test';

/*
 * Bridges B2-UI browser check: the real GateApp on the fixture seam (the same
 * harness admin-pages uses), driven to Settings → Bridges and the bridge
 * panel, with a screenshot of each new screen and state.
 *
 *   bunx playwright test -c e2e/bridges.config.ts
 *   (screenshots land in test-results/…)
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'bridges.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1508, height: 882 },
    baseURL: 'http://127.0.0.1:14631',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.TM8_BROWSER_SINGLE_PROCESS === '1'
      ? { args: ['--no-zygote', '--single-process', '--disable-gpu'] }
      : undefined,
  },
  webServer: {
    command: 'bun run dev --config e2e/admin-pages.vite.config.ts --port 14631',
    url: 'http://127.0.0.1:14631/e2e/admin-pages-harness.html',
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
