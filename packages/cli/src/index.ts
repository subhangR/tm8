#!/usr/bin/env node
/**
 * @tm8/cli — the binary a spawned agent runs.
 *
 * This file is the entry wrapper and nothing else: everything testable lives
 * in ./run.js. It resolves `@tm8/contract` relative to its own location, never
 * relative to the cwd, because the agent that runs it is sitting in the
 * PROJECT's working directory, not in the tm8 checkout.
 */
import { run } from './run.js';

export const CLI_PACKAGE = '@tm8/cli';

export { run, USAGE, VERSION } from './run.js';
export { composePrompt, commandSurface } from './prompt.js';
export { parseManifest, readManifest } from './manifest.js';
export type { Tm8Manifest } from './manifest.js';

void run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`tm8: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 4;
  },
);
