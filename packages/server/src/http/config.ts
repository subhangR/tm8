/**
 * Server configuration, resolved from the environment once at startup.
 *
 * tm8-server binds loopback only and is published through a TLS reverse proxy.
 * S2 Host, exact S3 Origin, S4 same-origin and S6 cookie-mutation checks are
 * resolved here and enforced in ./security.ts on HTTP and upgrade paths.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { FILE_MAX_SIZE_BYTES_DEFAULT } from '@tm8/contract';

import {
  CLIPBOARD_MAX_BYTES_DEFAULT,
  CLIPBOARD_RETENTION_DAYS_DEFAULT,
} from '../files/clipboard-store.js';

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
  /**
   * Where pasted clipboard images land so an agent can read them by path
   * (`TM8_CLIPBOARD_DIR`, default `<dataDir>/clipboard`).
   *
   * It is a CONVENTION, not an implementation detail: the same value is
   * exported to every spawned agent as `TM8_CLIPBOARD_DIR`, so an agent can
   * resolve where a pasted image lives without anything being hardcoded, and
   * it differs per node, which is what keeps a prod path from being handed to
   * a staging session.
   */
  readonly clipboardDir?: string;
  /** Per-image ceiling for a clipboard paste (`TM8_CLIPBOARD_MAX_BYTES`). */
  readonly clipboardMaxBytes?: number;
  /** Days a clipboard date-bucket survives (`TM8_CLIPBOARD_RETENTION_DAYS`, 0 = keep). */
  readonly clipboardRetentionDays?: number;
  /** Seed/repair launchable personas and the current project at boot. */
  readonly launchBootstrap?: boolean;
  /** Absolute current project registered by launch bootstrap. */
  readonly launchProjectDir?: string;
  /**
   * Enables command-ledger replay and recording. **Defaults to ON**, and
   * `TM8_IDEMPOTENCY_ENABLED=0` is the only way to turn it off.
   *
   * The default is load-bearing, not a preference. With it off,
   * `normalizeCommandInputForIdempotencyMode` REPLACES every incoming
   * `clientMutationId` with a fresh UUID before validation — so replay dedup
   * and ledger idempotency silently stop working while every command still
   * succeeds and every event still arrives. Only the id differs, which surfaces
   * as a cmid round-trip mismatch that reads exactly like a pump or load flake
   * (found that way twice: `ws-e2e.pg.test.ts` A9 timed out for 15s looking
   * like load). A correctness feature defaults ON; anyone who wants it off for
   * a local loop can say so in their environment.
   */
  readonly idempotencyEnabled?: boolean;
  /**
   * Disables the loopback auto-owner arm (`TM8_DISABLE_AUTO_OWNER=1`).
   * Bearer authentication remains available. This is a deployment kill
   * switch, not an authorization signal supplied by an HTTP header.
   */
  readonly disableAutoOwner?: boolean;
  /**
   * How this node admits people (`TM8_NODE_MODE`, design D4). Default `single`.
   *
   * `single` — a loopback caller with no credential resolves as the owner, so
   * the operator never sees a gate on the server's own machine. `multi` — the
   * auto-owner arm is off and everyone signs in, everywhere.
   *
   * IT IS CONFIG, AND DELIBERATELY NOT A GRAPH ROW. The mode gates a security
   * arm, and before a node is claimed "node admin" means anyone who can reach
   * loopback — precisely the population the mode exists to constrain. A row
   * would make the switch writable over the network by exactly the party it is
   * meant to bound. Converting a node is an env edit and a restart; no
   * operation writes this, and `tm8 node mode` only reads it.
   *
   * `multi` IMPLIES `disableAutoOwner`. The combination "multi + auto-owner
   * live" is refused in `loadConfig` rather than left to convention, because a
   * multiplayer node that still auto-authenticates its loopback caller is the
   * silent version of the bug this whole design closes.
   */
  readonly nodeMode?: 'single' | 'multi';
  /**
   * The origin this node is actually reachable at from a browser
   * (`TM8_PUBLIC_ORIGIN`), when that differs from its bind address.
   *
   * Exists for exactly one reason: the first-run claim link. S1 keeps the bind
   * loopback, so behind nginx or a tailnet the server's own `url` is
   * `http://127.0.0.1:<port>` — a link the off-box claimant cannot open, which
   * defeats the entire point of a ceremony designed to run from another device.
   * The design specified this and the first implementation shipped without it.
   *
   * Display only. It never widens who is trusted, and nothing authorizes
   * against it — an operator who sets it wrong prints an unreachable link, not
   * an insecure one.
   */
  readonly publicOrigin?: string;
  /**
   * Upper bound on the Postgres pool (`TM8_DB_POOL_MAX`). Default 8.
   *
   * This number IS the node's read concurrency: the pool queues past it and
   * callers time out after `connectionTimeoutMillis` as 503s. It was a
   * hardcoded default in db/client.ts with no way to raise it per deployment
   * while every other operational knob had an env var — on a box whose
   * Postgres can take more, the only fix was a rebuild.
   */
  readonly dbPoolMax?: number;
  /**
   * Self-hosted LiveKit SFU, for voice channels. All three or none — a node
   * with a URL and no secret cannot mint a token, so a half-set environment is
   * a configuration error, not a degraded mode.
   *
   * Absent leaves voice unconfigured, and `voice.token.create` answers a clear
   * refusal rather than a 500. Audio never reaches this process: the browser
   * connects to `url` directly with the token this server signs (voice plan §2).
   */
  readonly livekit?: LiveKitConfig;
  /**
   * Extra hostnames the S2 Host allowlist and S3 Origin check accept beyond
   * the loopback trio (`TM8_ALLOWED_HOSTNAMES`, comma-separated). When the
   * artifact-preview listener is configured, the preview hostname is
   * PARTITIONED OUT of this seam (security.ts): the app socket refuses the
   * preview name, the preview socket answers only to it (design §9.3).
   */
  readonly extraAllowedHostnames?: readonly string[];
  /**
   * Exact browser origins accepted by HTTP and WebSocket transport checks.
   * When set, this supersedes hostname-only Origin matching, so an HTTPS
   * deployment cannot be called from HTTP or from an unexpected port on the
   * same host (`TM8_ALLOWED_ORIGINS`, comma-separated origins only).
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * The artifact-preview origin. DEFAULT: the app origin itself — previews
   * are served as a `/p/` route on the app socket, so a default-config node
   * renders artifacts with no extra listener and no extra hostname. An
   * explicit `TM8_PREVIEW_HOST`/`TM8_PREVIEW_PORT` opts back into the SECOND
   * listener on its own origin (TM8-ARTIFACTS-DESIGN §9, true origin
   * isolation). Absent when `TM8_PREVIEW_ENABLED=0`, or in tests that
   * construct a frame-only config — `artifacts.preview.start` then mints
   * capabilities with no URL to spend them at.
   */
  readonly preview?: PreviewConfig;
}

/** The artifact-preview route's resolved identity (design §9.2/§9.3). */
export interface PreviewConfig {
  /**
   * The hostname the preview is REACHED BY. In the same-origin default this
   * is the app host; in second-origin mode it is the origin's identity,
   * enforced per-request by the preview listener's own Host check. Distinct
   * from the bind address: both listeners bind the same loopback interface.
   */
  readonly host: string;
  readonly port: number;
  /** `http://<host>:<port>`, precomputed once — the string minted into previewUrl and CSP. */
  readonly origin: string;
  /**
   * True in the default deployment: previews are a `/p/` route on the app
   * socket, no second listener starts, and the app's host allowlist is left
   * alone. False only when an operator sets an explicit TM8_PREVIEW_HOST /
   * TM8_PREVIEW_PORT — the second-origin mode, which keeps every boot
   * refusal and the allowlist partition.
   */
  readonly sameOrigin: boolean;
  /**
   * Origins allowed to FRAME a preview (`frame-ancestors`). Always contains
   * the app origin; `TM8_PREVIEW_FRAME_ANCESTORS` (space-separated) adds more
   * — the dev vite host, for one.
   */
  readonly frameAncestors: readonly string[];
}

/** The three values a LiveKit deployment needs, resolved together. */
export interface LiveKitConfig {
  /** Client-facing signalling URL, e.g. `ws://localhost:7880` (dev) or `wss://…`. */
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
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

/**
 * The clipboard handoff root — `<dataDir>/clipboard` unless overridden.
 *
 * Derived from `dataDir` on purpose. Two nodes on one box (prod and staging)
 * already have different data directories, so their clipboard paths cannot
 * collide, and a path minted by one node is visibly not the other's.
 */
export function resolveClipboardDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  const configured = env.TM8_CLIPBOARD_DIR?.trim();
  const dir = configured ? resolve(expandHome(configured)) : join(dataDir, 'clipboard');
  if (!isAbsolute(dir)) {
    throw new ConfigError(
      `TM8_CLIPBOARD_DIR must resolve to an absolute path, got ${JSON.stringify(configured)}`,
    );
  }
  return dir;
}

function envPositiveInt(raw: string | undefined, name: string, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function envNonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
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

  const dbPoolMaxRaw = env.TM8_DB_POOL_MAX?.trim();
  const dbPoolMax = dbPoolMaxRaw ? Number.parseInt(dbPoolMaxRaw, 10) : 8;
  if (!Number.isInteger(dbPoolMax) || dbPoolMax <= 0 || dbPoolMax > 1000) {
    throw new ConfigError(`TM8_DB_POOL_MAX must be an integer between 1 and 1000, got ${JSON.stringify(dbPoolMaxRaw)}`);
  }

  // An unrecognised value REFUSES rather than falling back to `single`. A typo
  // (`TM8_NODE_MODE=multiplayer`) silently defaulting to the permissive mode is
  // exactly how a node ends up auto-authenticating everyone who reaches
  // loopback while its operator believes it is locked down.
  const nodeModeRaw = env.TM8_NODE_MODE?.trim().toLowerCase();
  if (nodeModeRaw !== undefined && nodeModeRaw !== '' && nodeModeRaw !== 'single' && nodeModeRaw !== 'multi') {
    throw new ConfigError(
      `TM8_NODE_MODE must be "single" or "multi", got ${JSON.stringify(env.TM8_NODE_MODE)}`,
    );
  }
  const nodeMode: 'single' | 'multi' = nodeModeRaw === 'multi' ? 'multi' : 'single';

  // Validated at load rather than at print time: a malformed origin should stop
  // the operator now, not silently produce a broken claim link on the one boot
  // where it matters.
  const publicOriginRaw = env.TM8_PUBLIC_ORIGIN?.trim();
  let publicOrigin: string | undefined;
  if (publicOriginRaw) {
    let parsed: URL;
    try {
      parsed = new URL(publicOriginRaw);
    } catch {
      throw new ConfigError(`TM8_PUBLIC_ORIGIN must be a valid URL, got ${JSON.stringify(publicOriginRaw)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError(`TM8_PUBLIC_ORIGIN must be http(s), got ${JSON.stringify(publicOriginRaw)}`);
    }
    publicOrigin = parsed.origin;
  }

  const livekit = resolveLiveKit(env);

  const extraAllowedHostnames = (env.TM8_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  const allowedOrigins = (env.TM8_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new ConfigError(`TM8_ALLOWED_ORIGINS contains an invalid URL: ${JSON.stringify(value)}`);
      }
      const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.pathname !== '/'
        || parsed.search !== ''
        || parsed.hash !== ''
        || normalized !== parsed.origin
      ) {
        throw new ConfigError(
          `TM8_ALLOWED_ORIGINS entries must be bare http(s) origins, got ${JSON.stringify(value)}`,
        );
      }
      if ((env.TM8_ENV ?? '').trim() === 'prod' && parsed.protocol !== 'https:') {
        throw new ConfigError(`production TM8_ALLOWED_ORIGINS entries must use https, got ${JSON.stringify(value)}`);
      }
      return parsed.origin;
    });

  const preview = resolvePreview(env, host, port, extraAllowedHostnames, publicOrigin);

  const dataDir = resolveServerDataDir(env);
  const clipboardDir = resolveClipboardDir(env, dataDir);
  const clipboardMaxBytes = envPositiveInt(
    env.TM8_CLIPBOARD_MAX_BYTES,
    'TM8_CLIPBOARD_MAX_BYTES',
    CLIPBOARD_MAX_BYTES_DEFAULT,
  );
  const clipboardRetentionDays = envNonNegativeInt(
    env.TM8_CLIPBOARD_RETENTION_DAYS,
    'TM8_CLIPBOARD_RETENTION_DAYS',
    CLIPBOARD_RETENTION_DAYS_DEFAULT,
  );

  return {
    host,
    port,
    extraAllowedHostnames,
    allowedOrigins,
    ...(preview ? { preview } : {}),
    uiDir: env.TM8_UI_DIR?.trim() || undefined,
    maxBodyBytes,
    databaseUrl: env.TM8_DATABASE_URL?.trim() || undefined,
    dataDir,
    fileMaxSizeBytes,
    clipboardDir,
    clipboardMaxBytes,
    clipboardRetentionDays,
    launchBootstrap: env.TM8_LAUNCH_BOOTSTRAP?.trim() !== '0',
    launchProjectDir: resolve(expandHome(env.TM8_PROJECT_DIR?.trim() || process.cwd())),
    idempotencyEnabled: envBoolean(env.TM8_IDEMPOTENCY_ENABLED, 'TM8_IDEMPOTENCY_ENABLED', true),
    nodeMode,
    ...(publicOrigin ? { publicOrigin } : {}),
    // `multi` implies the kill switch. The explicit env var still wins when it
    // asks for MORE restriction (a hardened single-player node), and can never
    // ask for less: `||` here means no combination of the two can produce a
    // multiplayer node with a live auto-owner arm.
    disableAutoOwner:
      nodeMode === 'multi'
      || envBoolean(env.TM8_DISABLE_AUTO_OWNER, 'TM8_DISABLE_AUTO_OWNER', false),
    dbPoolMax,
    ...(livekit ? { livekit } : {}),
  };
}

/**
 * The artifact-preview origin.
 *
 * DEFAULT — same-origin: no `TM8_PREVIEW_*` set means previews are served as
 * a `/p/` route on the app socket, so the preview origin IS the app origin.
 * No second listener, no second hostname, no allowlist partition. What
 * contains the bundle then is not origin separation but the renderer's
 * server-enforced CSP sandbox (`sandbox allow-scripts` inside the response
 * header) plus the app's own refusal of `Origin: null` callers — see
 * ./artifact-preview.ts and ./security.ts.
 *
 * SECOND-ORIGIN — an explicit `TM8_PREVIEW_HOST` or `TM8_PREVIEW_PORT` opts
 * into the separate listener (TM8-ARTIFACTS-DESIGN §9.2, user-ratified
 * 2026-07-31), and then every boot refusal below still stands:
 *
 * Two refusals, and the second is the one that matters: port-only separation
 * satisfies the browser's origin comparison but NOT cookies, which ignore
 * port — the moment tm8 issues a cookie for host `127.0.0.1`, a preview
 * served from `127.0.0.1:4613` would receive it. So the rule is a HOST rule,
 * enforced here before any listener binds. A node silently serving artifacts
 * from its privileged origin is worse than a node that does not start.
 *
 * A third refusal follows from §9.3: a hostname is only distinct if the
 * other listener refuses it. Listing the preview hostname in
 * `TM8_ALLOWED_HOSTNAMES` would make the app socket ANSWER to the preview
 * name — two names for one socket, cosmetic separation. Refused loudly
 * rather than silently partitioned: an explicit config contradiction is the
 * operator's to resolve.
 */
function resolvePreview(
  env: NodeJS.ProcessEnv,
  appHost: string,
  appPort: number,
  extraAllowedHostnames: readonly string[],
  publicOrigin: string | undefined,
): PreviewConfig | undefined {
  if (envBoolean(env.TM8_PREVIEW_ENABLED, 'TM8_PREVIEW_ENABLED', true) === false) return undefined;

  /**
   * The UI is served from a DIFFERENT origin than the API socket in every
   * topology this repo ships — vite dev (`:4612` vs `:4610`), local prod
   * (`:7777` vs `:7778`), local staging (`:8888` vs `:8887`), and the nginx
   * boxes, where the browser reaches an `https://…` name while the node binds
   * loopback. `frame-ancestors` derived from the BIND address therefore names
   * an origin that never does the framing, and the preview renders nothing:
   * the browser refuses to paint the frame and the block shows an empty box,
   * because its error state only covers a missing previewUrl.
   *
   * So the framing origin is the origin the node is REACHED BY. Widening
   * `frame-ancestors` to it costs nothing — that is precisely the document
   * meant to embed the preview — and the sandbox is untouched, so the frame
   * stays opaque-origin either way. `TM8_PREVIEW_FRAME_ANCESTORS` remains the
   * escape hatch for topologies this cannot infer (a dev vite port, a second
   * reverse proxy). Duplicates are collapsed: the header is noisy enough.
   */
  const framingOrigins = (extra: string) =>
    Array.from(
      new Set([
        ...(publicOrigin ? [publicOrigin] : []),
        ...(env.TM8_PREVIEW_FRAME_ANCESTORS ?? '')
          .split(/\s+/)
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
        extra,
      ]),
    );

  const explicitHost = env.TM8_PREVIEW_HOST?.trim() || undefined;
  const explicitPort = env.TM8_PREVIEW_PORT?.trim() || undefined;
  if (explicitHost === undefined && explicitPort === undefined) {
    const host = appHost.toLowerCase();
    const origin = `http://${host}:${appPort}`;
    const frameAncestors = framingOrigins(origin);
    return { host, port: appPort, origin, sameOrigin: true, frameAncestors };
  }

  // Second-origin mode. The host DEFAULT complements the bind host so the
  // host rule holds for every legal TM8_BIND without extra config: app
  // `127.0.0.1` (the ratified pair) or `::1` get preview `localhost`; a node
  // bound to `localhost` gets the mirrored pair. An EXPLICIT
  // TM8_PREVIEW_HOST is never adjusted — a collision there is refused below,
  // not repaired.
  const defaultHost = appHost.toLowerCase() === 'localhost' ? '127.0.0.1' : 'localhost';
  const host = (explicitHost || defaultHost).toLowerCase();
  // An EXPLICIT `TM8_PREVIEW_PORT=0` is legal and means ephemeral — the
  // escape hatch for harnesses that boot this server as a CHILD PROCESS and
  // so cannot substitute config after validation (packages/cli integration).
  // Without it, every such boot raced the long-lived local node for the fixed
  // 4613 default and failed EADDRINUSE (ten files at once, 2026-07-31). The
  // in-process harnesses use the `config.port === 0` follow-suit in main.ts.
  const port = Number.parseInt(explicitPort || '4613', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`TM8_PREVIEW_PORT must be a valid port number, got ${JSON.stringify(env.TM8_PREVIEW_PORT)}`);
  }

  const appOrigin = `http://${appHost.toLowerCase()}:${appPort}`;
  const origin = `http://${host}:${port}`;

  if (origin === appOrigin) {
    throw new ConfigError(
      `refusing to start: the artifact-preview origin ${origin} (TM8_PREVIEW_HOST/TM8_PREVIEW_PORT) ` +
        `is the app origin ${appOrigin} (TM8_BIND/TM8_PORT). Untrusted bundle content must never be ` +
        `served from the privileged origin (TM8-ARTIFACTS-DESIGN §9.2).`,
    );
  }
  if (host === appHost.toLowerCase()) {
    throw new ConfigError(
      `refusing to start: the artifact-preview host of ${origin} (TM8_PREVIEW_HOST/TM8_PREVIEW_PORT) ` +
        `equals the app host of ${appOrigin} (TM8_BIND/TM8_PORT). Port-only separation is not ` +
        `separation — cookies ignore ports (TM8-ARTIFACTS-DESIGN §9.2). Pick a distinct hostname, ` +
        `e.g. TM8_PREVIEW_HOST=localhost with TM8_BIND=127.0.0.1.`,
    );
  }
  if (extraAllowedHostnames.includes(host)) {
    throw new ConfigError(
      `refusing to start: TM8_ALLOWED_HOSTNAMES lists ${JSON.stringify(host)}, the artifact-preview ` +
        `hostname (TM8_PREVIEW_HOST). The app socket answering to the preview name makes the origin ` +
        `split cosmetic (TM8-ARTIFACTS-DESIGN §9.3) — remove it from one of the two.`,
    );
  }

  // Second-origin mode has the same reached-by problem: the app socket's BIND
  // origin is not necessarily the origin the browser frames from.
  const frameAncestors = framingOrigins(appOrigin);

  return { host, port, origin, sameOrigin: false, frameAncestors };
}

/**
 * All three LiveKit values, or none.
 *
 * A partial set is refused at startup rather than at the first join attempt.
 * The failure it prevents is specific: a URL with no secret produces a token
 * signed with `undefined`, which LiveKit rejects during the WebRTC handshake —
 * i.e. the user sees "cannot join, no reason given" long after the mistake,
 * with nothing in tm8's logs. Booting is the last moment this is still cheap.
 */
function resolveLiveKit(env: NodeJS.ProcessEnv): LiveKitConfig | undefined {
  const url = env.TM8_LIVEKIT_URL?.trim() || '';
  const apiKey = env.TM8_LIVEKIT_API_KEY?.trim() || '';
  const apiSecret = env.TM8_LIVEKIT_API_SECRET?.trim() || '';
  const present = [url, apiKey, apiSecret].filter((value) => value !== '').length;
  if (present === 0) return undefined;
  if (present < 3) {
    throw new ConfigError(
      'TM8_LIVEKIT_URL, TM8_LIVEKIT_API_KEY and TM8_LIVEKIT_API_SECRET must be set together ' +
        '(voice channels); set all three or none.',
    );
  }
  if (!/^wss?:\/\//.test(url)) {
    throw new ConfigError(
      `TM8_LIVEKIT_URL must be a ws:// or wss:// signalling URL, got ${JSON.stringify(url)}`,
    );
  }
  return { url, apiKey, apiSecret };
}
