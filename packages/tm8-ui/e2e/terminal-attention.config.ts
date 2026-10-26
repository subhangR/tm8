import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'terminal-attention.spec.ts', timeout: 90_000, workers: 1, reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:14631', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure',
    launchOptions: process.env.TM8_BROWSER_SINGLE_PROCESS === '1' ? { args: ['--no-zygote', '--single-process', '--disable-gpu'] } : undefined,
  },
  webServer: {
    command: 'bun run dev --config e2e/terminal-attention.vite.config.ts --host 127.0.0.1 --port 14631 --strictPort',
    url: 'http://127.0.0.1:14631/e2e/terminal-attention-harness.html', reuseExistingServer: false,
  },
});
