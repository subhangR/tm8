/**
 * The VENDOR PROBE for a pasted space credential (SC-3, design 01a0cfa8 I6).
 *
 * A key is stored as `active` only after its vendor has accepted it, so the
 * status a member sees is a probe's verdict and never a guess. A probe that
 * cannot reach the vendor is not a verdict either way: the caller refuses the
 * write rather than storing an unmeasured key.
 *
 * One cheap authenticated read per vendor:
 *   anthropic  GET https://api.anthropic.com/v1/models   (x-api-key)
 *   openai     GET https://api.openai.com/v1/models      (Bearer)
 *   github     GET https://api.github.com/user           (Bearer) — also names
 *              the account commits will be authored by (D10).
 *
 * The secret goes into ONE request header and nowhere else: not a URL, not a
 * log line, not an error (I5). Failures carry an HTTP status or an error NAME.
 */
import type { SpaceCredentialProvider } from './space-credential-store.js';

export type SpaceCredentialProbeResult =
  | { ok: true; displayLogin: string | null }
  | { ok: false; reason: 'rejected' | 'unreachable'; detail: string };

export type SpaceCredentialProbe = (input: {
  provider: SpaceCredentialProvider;
  secret: string;
}) => Promise<SpaceCredentialProbeResult>;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{
    status: number;
    ok: boolean;
    headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;

export interface VendorProbeOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface VendorRequest {
  url: string;
  headers(secret: string): Record<string, string>;
}

const VENDORS: Record<SpaceCredentialProvider, VendorRequest> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (secret) => ({ 'x-api-key': secret, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (secret) => ({ authorization: `Bearer ${secret}` }),
  },
  github: {
    url: 'https://api.github.com/user',
    headers: (secret) => ({
      authorization: `Bearer ${secret}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'tm8-space-credential-probe',
    }),
  },
};

export function createVendorProbe(options: VendorProbeOptions = {}): SpaceCredentialProbe {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async ({ provider, secret }) => {
    const vendor = VENDORS[provider];
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(vendor.url, {
        method: 'GET',
        headers: vendor.headers(secret),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The error NAME only: a driver message may quote the request.
      return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.name : 'unknown' };
    }
    // GitHub answers a VALID token that has run out of rate limit with 403 and
    // x-ratelimit-remaining: 0. That is no verdict on the key: unreachable.
    if (response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0') {
      return { ok: false, reason: 'unreachable', detail: 'HTTP 403 rate limited' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'rejected', detail: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, reason: 'unreachable', detail: `HTTP ${response.status}` };
    }
    if (provider !== 'github') return { ok: true, displayLogin: null };
    // D10: a GitHub token is stored only with the login its commits will be
    // authored by. A 200 that does not name one is no usable verdict: the
    // spawn would have no account to author as, so nothing is stored.
    let login: string | null = null;
    try {
      const body = (await response.json()) as { login?: unknown };
      if (typeof body.login === 'string' && body.login.trim()) login = body.login.trim();
    } catch {
      login = null;
    }
    return login
      ? { ok: true, displayLogin: login }
      : { ok: false, reason: 'unreachable', detail: 'no account login in the GitHub response' };
  };
}
