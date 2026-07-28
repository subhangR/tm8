import { defineConfig } from 'vitest/config';

/**
 * W2/W3 public HTTP semantic gate. These suites intentionally remain red
 * against the contract-shaped 501 stub and are never part of W1's green gate.
 */
export default defineConfig({
  test: {
    include: ['./test/*.test.ts'],
    globalSetup: ['./src/global-setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
