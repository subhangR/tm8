/**
 * Build the migrated template ONCE, in vitest's main process, before any
 * worker starts (see db/scratch-template.mjs for why a template at all).
 *
 * Done per worker instead, every integration file raced to build it at the same
 * moment, each running all 185 migrations. Measured at load ~120: five
 * concurrent builds, every `beforeAll` timed out, and the killed workers left
 * orphaned `migrate.mjs` children behind. Here there is one build, no hook
 * timeout around it, and no worker to be SIGTERM'd out from under it.
 *
 * Never fatal: with no reachable Postgres (a unit-only run) or a failing build,
 * this logs and returns, and each integration file's own
 * `createFromMigratedTemplate` call reports the real error where it belongs.
 */
import { ensureMigratedTemplate } from '../../../../db/scratch-template.mjs';
import { adminUrl } from './harness.js';

export default async function setup(): Promise<void> {
  const env = { ...process.env, PGCONNECT_TIMEOUT: '5' };
  const started = Date.now();
  try {
    const template = await ensureMigratedTemplate(adminUrl(), env);
    console.log(`[cli integration] migrated template ${template} ready in ${Date.now() - started}ms`);
  } catch (error) {
    console.warn(`[cli integration] no migrated template (${(error as Error).message.split('\n')[0]}); files will build their own`);
  }
}
