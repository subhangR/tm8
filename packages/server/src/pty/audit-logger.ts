import type { PtyWsLogger } from './pty-ws-server.js';

type Writer = (line: string) => void;

const SAFE_KEYS = new Set(['sessionId', 'mode', 'status', 'reason', 'gap', 'offset']);

function safeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!SAFE_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** Structured PTY audit records with a fixed, credential-free field allowlist. */
export function createPtyAuditLogger(writers: {
  info?: Writer;
  warn?: Writer;
  error?: Writer;
} = {}): PtyWsLogger {
  const emit = (level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>) => {
    const writer = writers[level]
      ?? (level === 'info' ? console.info : level === 'warn' ? console.warn : console.error);
    writer(JSON.stringify({ component: 'pty-ws', level, event, ...safeMeta(meta) }));
  };
  return {
    info: (event, meta) => emit('info', event, meta),
    warn: (event, meta) => emit('warn', event, meta),
    // Error messages/stacks may contain driver or SQL inputs. Record only the
    // fixed event and safe context; detailed errors stay in local diagnostics.
    error: (event, _error, meta) => emit('error', event, meta),
  };
}
