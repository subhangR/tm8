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
import { EXIT_INTERRUPTED, EXIT_PROTOCOL } from './exit.js';

export { run, USAGE, VERSION } from './run.js';
export type { CommandContext, CommandModule } from './run.js';
// The command list moved out of run.ts into its own composition point so that
// concurrent domain slots each add one file instead of sharing one array.
export { COMMANDS, findCommand, isRegisteredPath } from './commands/registry.js';
export * from './exit.js';
export * from './errors.js';
export * from './args.js';
export * from './output.js';
export * from './context.js';
export * from './mutation.js';
export * from './client.js';
export { composePrompt, commandSurface } from './prompt.js';
export { parseManifest, readManifest } from './manifest.js';
export type { Tm8Manifest } from './manifest.js';

// §7.6: an interrupted command exits 130, and it must do so even mid-request.
process.on('SIGINT', () => {
  process.exitCode = EXIT_INTERRUPTED;
  process.exit(EXIT_INTERRUPTED);
});

void run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // run() funnels every classified failure itself; reaching here means the
    // kernel threw, which is a protocol/implementation failure of this CLI.
    process.stderr.write(`tm8: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = EXIT_PROTOCOL;
  },
);
