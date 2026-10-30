// The node log for SpawnService: one JSON line per event.
//
// CONTRACT
//   Called by: `createExecutionRuntime` (execution-handlers.ts), once, when the
//   composition root passes no logger of its own.
//   Output: `{"component":"spawn","level":…,"event":…,…meta}` on stdout (info)
//   or stderr (warn, error), one line per call, so `grep '"component":"spawn"'`
//   and `JSON.parse` both work on the server's log. `debug` is dropped.
//   Invariant: an error's message is recorded, never its stack; SpawnService's
//   own messages name sessions and reasons, never a credential (I5).
//
// Why it exists: SpawnService logs through an injected `Logger`, and the node
// injected none, so every line it writes — including `SpawnService: spawn
// timings`, the per-phase record of each launch — went nowhere in production.

import type { Logger } from '@tm8/execution';

type Writer = (line: string) => void;

export function createSpawnLogger(writers: { info?: Writer; warn?: Writer; error?: Writer } = {}): Logger {
  const emit = (level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>): void => {
    const writer = writers[level] ?? (level === 'info' ? console.info : level === 'warn' ? console.warn : console.error);
    writer(JSON.stringify({ component: 'spawn', level, event, ...(meta ?? {}) }));
  };
  return {
    info: (event, meta) => emit('info', event, meta),
    warn: (event, meta) => emit('warn', event, meta),
    error: (event, error, meta) => emit('error', event, { ...(meta ?? {}), ...(error ? { error: error.message } : {}) }),
    debug: () => undefined,
  };
}
