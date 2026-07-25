/**
 * Server configuration, resolved from the environment once at startup.
 *
 * 10-SECURITY-MODEL S1 is the only security rule enforced in this pass (CTO
 * scope trim, 2026-07-25): **tm8-server binds loopback only.** Non-loopback
 * binding requires token auth (S8), which does not exist yet — so rather than
 * bind wide open, the server REFUSES TO START. A refusal is honest; a silent
 * downgrade to 0.0.0.0 would be the exact failure S1 exists to prevent.
 *
 * The remaining transport rules (S2 Host allowlist, S3 WS Origin, S4 CORS,
 * S6 X-TM8-Client on mutations) are deferred post-G1A and slot into
 * ./security.ts.
 */

export interface ServerConfig {
  /** Bind address. Loopback only — see S1 above. */
  readonly host: string;
  readonly port: number;
  /**
   * Directory holding the built web UI bundle, served for non-`/v2` paths.
   * Undefined in dev, where Vite serves the UI on 4611 (AM-1: no desktop shell).
   */
  readonly uiDir: string | undefined;
  /** Request body cap — over this the frame answers `payload_too_large` (413). */
  readonly maxBodyBytes: number;
  /**
   * Postgres connection string for the graph (`TM8_DATABASE_URL`).
   *
   * Undefined leaves the handler registry empty, so every operation keeps
   * answering an honest 501 — a node with no database should say it has no
   * database, not boot and then fail at the first query.
   */
  readonly databaseUrl: string | undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.TM8_BIND?.trim() || '127.0.0.1';
  const port = Number.parseInt(env.TM8_PORT?.trim() || '4610', 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`TM8_PORT must be a valid port number, got ${JSON.stringify(env.TM8_PORT)}`);
  }

  // S1. The refusal, not a warning.
  if (!isLoopback(host)) {
    throw new ConfigError(
      `refusing to bind ${host}:${port} — non-loopback binding requires token auth (10-SECURITY S1/S8), ` +
        `which is not implemented yet. Unset TM8_BIND to bind 127.0.0.1.`,
    );
  }

  const maxBodyRaw = env.TM8_MAX_BODY_BYTES?.trim();
  const maxBodyBytes = maxBodyRaw ? Number.parseInt(maxBodyRaw, 10) : 8 * 1024 * 1024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new ConfigError(`TM8_MAX_BODY_BYTES must be a positive integer, got ${JSON.stringify(maxBodyRaw)}`);
  }

  return {
    host,
    port,
    uiDir: env.TM8_UI_DIR?.trim() || undefined,
    maxBodyBytes,
    databaseUrl: env.TM8_DATABASE_URL?.trim() || undefined,
  };
}
