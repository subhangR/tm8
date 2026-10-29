import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'loops-create.spec.ts', timeout: 60_000, workers: 1, reporter: 'line',
  use: {
    ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:14653',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.TM8_BROWSER_SINGLE_PROCESS === '1'
      ? { args: ['--no-zygote', '--single-process', '--disable-gpu'] } : undefined,
  },
  webServer: {
    command: 'bun run dev --port 14653',
    url: 'http://127.0.0.1:14653/e2e/loops-create-harness.html', reuseExistingServer: false,
  },
});
