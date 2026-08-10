/**
 * E2E-ONLY vite config for `thread-verify.mjs`.
 *
 * WHY THIS EXISTS: `@tm8/cli` is consumed as a PREBUILT dist from the shared
 * checkout (the worktree recipe — the CLI has pre-existing build errors), and
 * that dist resolves `@tm8/contract` through ITS OWN node_modules, i.e. the
 * shared checkout's contract — a tree other lanes are actively editing. When
 * their contract dist declares an operation the stale CLI dist's ROWS table
 * does not know, `operations.js` dies at module init (`row is undefined`
 * reading `.cmd`) and the whole app boots to a blank page.
 *
 * The alias pins every `@tm8/contract` import — the CLI dist's included — to
 * THIS worktree's contract build, which is the tree the code under test was
 * written against. Dev/CI never load this file; it is passed explicitly via
 * `--config` by the e2e run.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        '@tm8/contract': fileURLToPath(new URL('../../contract/dist/index.js', import.meta.url)),
      },
    },
  }),
);
