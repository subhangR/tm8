import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Builds the migrated template the integration harness clones from, once,
    // before any worker starts. See test/integration/global-setup.ts.
    globalSetup: ['./test/integration/global-setup.ts'],
  },
});
