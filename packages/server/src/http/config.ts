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

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { FILE_MAX_SIZE_BYTES_DEFAULT } from '@tm8/contract';

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
  /**
   * Absolute Server-owned state root. `loadConfig` always resolves it; the
   * optional marker preserves compatibility for narrow tests that construct a
   * frame-only config and never compose filesystem-backed services.
   */
  readonly dataDir?: string;
  /**
   * One effective per-blob ceiling shared by file grants, the file service,
   * and the blob store. `loadConfig` always supplies a positive safe integer.
   */
  readonly fileMaxSizeBytes?: number;
  /** Seed/repair launchable personas and the current project at boot. */
  readonly launchBootstrap?: boolean;
  /** Absolute current project registered by launch bootstrap. */
  readonly launchProjectDir?: string;
  /**
   * Enables command-ledger replay and recording. Defaults to true; false is a
   * local CRUD-test mode in which client mutation ids are deliberately ignored.
   */
  readonly idempotencyEnabled?: boolean;
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

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function envBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return fallback;
  if (['1', 'true', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be one of 1/0, true/false, or on/off`);
}

/** Resolve the shared tm8 state root without reading any unrelated config. */
export function resolveServerDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const mode = env.TM8_ENV === 'prod' ? 'prod' : 'dev';
  const configured = env.TM8_DATA_DIR?.trim()
    || join(homedir(), mode === 'prod' ? '.tm8' : '.tm8-dev');
  const dataDir = resolve(expandHome(configured));
  if (!isAbsolute(dataDir)) {
    throw new ConfigError(`TM8_DATA_DIR must resolve to an absolute path, got ${JSON.stringify(configured)}`);
  }
  return dataDir;
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

  const fileMaxRaw = env.TM8_FILE_MAX_SIZE_BYTES?.trim();
  const fileMaxSizeBytes = fileMaxRaw === undefined || fileMaxRaw === ''
    ? FILE_MAX_SIZE_BYTES_DEFAULT
    : Number(fileMaxRaw);
  if (!Number.isSafeInteger(fileMaxSizeBytes) || fileMaxSizeBytes <= 0) {
    throw new ConfigError(
      `TM8_FILE_MAX_SIZE_BYTES must be a positive safe integer, got ${JSON.stringify(fileMaxRaw)}`,
    );
  }

  return {
    host,
    port,
    uiDir: env.TM8_UI_DIR?.trim() || undefined,
    maxBodyBytes,
    databaseUrl: env.TM8_DATABASE_URL?.trim() || undefined,
    dataDir: resolveServerDataDir(env),
    fileMaxSizeBytes,
    launchBootstrap: env.TM8_LAUNCH_BOOTSTRAP?.trim() !== '0',
    launchProjectDir: resolve(expandHome(env.TM8_PROJECT_DIR?.trim() || process.cwd())),
    idempotencyEnabled: envBoolean(env.TM8_IDEMPOTENCY_ENABLED, 'TM8_IDEMPOTENCY_ENABLED', true),
  };
}
