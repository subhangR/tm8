import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'attention-scroll.spec.ts', timeout: 30_000, workers: 1, reporter: 'line',
  use: {
    ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:14637',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.TM8_BROWSER_SINGLE_PROCESS === '1'
      ? { args: ['--no-zygote', '--single-process', '--disable-gpu'] } : undefined,
  },
  webServer: {
    command: 'bun run dev --port 14637',
    url: 'http://127.0.0.1:14637/e2e/attention-scroll-harness.html', reuseExistingServer: false,
  },
});
