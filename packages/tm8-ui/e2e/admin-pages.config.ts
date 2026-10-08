import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'admin-pages.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:14627',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Restricted runners may prevent Chromium from starting renderer processes.
    launchOptions: process.env.TM8_BROWSER_SINGLE_PROCESS === '1'
      ? { args: ['--no-zygote', '--single-process', '--disable-gpu'] }
      : undefined,
  },
  webServer: {
    command: 'bun run dev --config e2e/admin-pages.vite.config.ts --port 14627',
    url: 'http://127.0.0.1:14627/e2e/admin-pages-harness.html',
    reuseExistingServer: false,
  },
});
