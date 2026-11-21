/**
 * The browser's VaultTransport (task 01a1fa87, WS-A): the catalog adapter
 * `src/vault/port.ts` asks for. It lives outside `src/vault`, which by design
 * never imports a seam or the HttpClient.
 *
 * COOKIE-ONLY, ON PURPOSE. Two things about the broker decide this.
 * - Every vault call must carry the broker's own cookies (`tm8_vault_session`
 *   on /v2/vault, `tm8_vault_refresh` on /v2/vault/session). Those never ride a
 *   request sent with credentials omitted, and that is exactly how a pinned
 *   space session sends its bearer (auth/space-sessions.ts).
 * - A bearer sent next to a different `__Host-tm8-session` cookie is refused
 *   as a pair (identity-resolver).
 * So this transport sends NO Authorization header and never reads the stored
 * pass. The browser's own HttpOnly `__Host-tm8-session` cookie names the
 * member. Under TM8_SPACE_SESSIONS=enforce that cookie is the session
 * `auth.space.enter` pinned to this space, and the relay refuses an unpinned
 * gate session (server.ts, `assertSpaceGate`). A pass in storage that script
 * could read therefore never becomes a vault credential through this module.
 *
 * SAME ORIGIN ONLY. The vault cookies are path-scoped to this origin's
 * /v2/vault, so a named server reached through the proxy route has no vault
 * here. GateApp mounts the section only for the local server.
 *
 * Errors are passed on as `{ status, error: { code, details: { reason } } }`,
 * the shape `vaultError` reads. Nothing else from a refusal is kept: no
 * server message and no request id. A 401 becomes `unauthorized`, the code
 * the vault copy knows, because the relay's 401 says `unauthenticated`.
 */
import {
  TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, VAULT_OPERATIONS, VAULT_SPACE_HEADER,
  type VaultOperationName,
} from '@tm8/contract';

import type { VaultCallOptions, VaultTransport } from '../vault';

/** The subset of `fetch` this transport calls; tests pass their own. */
export type VaultFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface VaultTransportOptions {
  /** The space every call acts in, sent as `x-tm8-vault-space`. */
  spaceId: string | null;
  fetch?: VaultFetch;
}

/** What `vaultError` reads off a failed call. */
export interface VaultTransportFailure {
  status?: number;
  error: { code?: string; details?: { reason: string } };
}

const ROUTES: ReadonlyMap<string, (typeof VAULT_OPERATIONS)[number]> = new Map(VAULT_OPERATIONS.map((row) => [row.name, row]));
const PARAM = /^:([A-Za-z]+)$/;

const failure = (code: string, status?: number): VaultTransportFailure => ({ ...(status === undefined ? {} : { status }), error: { code } });

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The catalog path with each `:name` segment filled from `params`, which must name exactly those segments. */
function fillPath(template: string, params: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const segments = template.split('/').map((segment) => {
    const name = PARAM.exec(segment)?.[1];
    if (name === undefined) return segment;
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (typeof value !== 'string' || value === '') throw failure('invalid_input');
    used.add(name);
    return encodeURIComponent(value);
  });
  if (Object.keys(params).some((name) => !used.has(name))) throw failure('invalid_input');
  return segments.join('/');
}

/** Scalars only, each key once: the broker parses a GET query with URLSearchParams and refuses a repeated key. */
function encodeQuery(query: Readonly<Record<string, unknown>> | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') search.set(key, value);
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') search.set(key, String(value));
    else throw failure('invalid_input');
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

function refusal(status: number, parsed: unknown): VaultTransportFailure {
  const source = record(record(parsed).error);
  const code = status === 401 ? 'unauthorized' : typeof source.code === 'string' ? source.code : undefined;
  const reason = record(source.details).reason;
  return {
    status,
    error: {
      ...(code === undefined ? {} : { code }),
      ...(typeof reason === 'string' ? { details: { reason } } : {}),
    },
  };
}

export function createVaultTransport(options: VaultTransportOptions): VaultTransport {
  const send: VaultFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const spaceId = options.spaceId;
  return {
    spaceId,
    async call<T>(op: VaultOperationName, opts: VaultCallOptions = {}): Promise<T> {
      const route = ROUTES.get(op);
      if (!route) throw failure('invalid_input');
      const reads = route.method === 'GET';
      if (!reads && opts.query !== undefined) throw failure('invalid_input');
      if (reads && opts.body !== undefined) throw failure('invalid_input');
      const url = fillPath(route.path, opts.params ?? {}) + (reads ? encodeQuery(opts.query) : '');
      const headers: Record<string, string> = {
        accept: 'application/json',
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        ...(spaceId ? { [VAULT_SPACE_HEADER]: spaceId } : {}),
        ...(reads ? {} : { 'content-type': 'application/json' }),
      };
      let response: Response;
      try {
        response = await send(url, {
          method: route.method,
          headers,
          // The broker parses every command body as JSON, an empty one included.
          ...(reads ? {} : { body: JSON.stringify(opts.body ?? {}) }),
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        throw failure('request_failed');
      }
      const parsed = await readJson(response);
      if (!response.ok) throw refusal(response.status, parsed);
      const envelope = record(parsed);
      if (!Object.hasOwn(envelope, 'data')) throw failure('invalid_response', response.status);
      return envelope.data as T;
    },
  };
}
