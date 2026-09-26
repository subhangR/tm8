#!/usr/bin/env node
// Entry point of the tm8-session-host process. Kept separate from host.ts so
// importing the class (tests, the server's generation hash) never starts a host.
import { main } from './host.js';

main().catch((error: unknown) => {
  process.stderr.write(`session-host: fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
