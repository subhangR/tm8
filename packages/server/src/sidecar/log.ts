/**
 * Minimal leveled logger for the server block's ops code (sidecar + scheduler).
 *
 * Deliberately dependency-free and deliberately small: when the facade lands at
 * W2 and Altair introduces the real server logger, `SidecarLogger` is the seam —
 * every call site takes a logger, so swapping the implementation is a
 * constructor argument, not a rewrite.
 *
 * Level comes from `TM8_LOG_LEVEL` (docs/ops/CONFIG.md §2).
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface SidecarLogger {
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
}

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function normalizeLevel(raw: string | undefined): LogLevel {
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') return raw;
  return 'info';
}

function format(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.name}: ${meta.message}`;
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

/**
 * Console-backed logger with a `[tag]` prefix.
 * @param tag short subsystem name, e.g. `sidecar` or `scheduler`
 * @param level defaults to `TM8_LOG_LEVEL`, else `info`
 */
export function createLogger(
  tag: string,
  level: LogLevel = normalizeLevel(process.env['TM8_LOG_LEVEL']),
): SidecarLogger {
  const enabled = (l: LogLevel) => ORDER[l] <= ORDER[level];
  const emit = (l: LogLevel, sink: (m: string) => void) => (msg: string, meta?: unknown) => {
    if (!enabled(l)) return;
    sink(`[${tag}] ${msg}${format(meta)}`);
  };
  return {
    error: emit('error', (m) => console.error(m)),
    warn: emit('warn', (m) => console.warn(m)),
    info: emit('info', (m) => console.log(m)),
    debug: emit('debug', (m) => console.log(m)),
  };
}

/** Discards everything. For tests and for callers that supply their own sink. */
export const silentLogger: SidecarLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};
