import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';

/**
 * Exact-origin binding (brief R4, MSG 6, acceptance tests 3 and 4).
 *
 * An origin is `https://<ascii-host>[:<non-default-port>]`. Binding and fill
 * compare these strings for EXACT equality. There is no subdomain, wildcard or
 * "same site" matching, so `gist.github.com` never fills a `github.com` item.
 *
 * Normalisation goes through the WHATWG URL parser (IDNA ToASCII, lowercase,
 * percent-decoding, IPv4 shorthand such as `0x7f.1` -> `127.0.0.1`). After
 * that one trailing dot is stripped, the default port is dropped, and the
 * result is checked against the refusal list below. Development origins (http,
 * localhost, private names, IP literals) are allowed only when the ITEM is in
 * dev mode, and that flag is itself a property change needing step-up.
 */
export type OriginRefusalCode =
  | 'invalid_url'
  | 'scheme_not_https'
  | 'has_credentials'
  | 'has_path'
  | 'has_query_or_fragment'
  | 'ip_literal'
  | 'localhost'
  | 'private_name'
  | 'invalid_hostname';

export class OriginRefusal extends Error {
  constructor(readonly code: OriginRefusalCode) {
    super(`origin refused: ${code}`);
    this.name = 'OriginRefusal';
  }
}

export interface NormalizedOrigin {
  /** Canonical comparison key, e.g. `https://xn--80ak6aa92e.com` or `https://example.com:8443`. */
  origin: string;
  scheme: 'https' | 'http';
  /** ASCII (punycode) host, lowercase, no trailing dot. */
  host: string;
  /** The Unicode rendering of `host`. Shown NEXT TO the ASCII form, never instead of it. */
  displayHost: string;
  /** null = the scheme default. */
  port: number | null;
  /** true when any label is an IDN (`xn--`). The UI must show both forms. */
  idn: boolean;
}

export interface OriginOptions {
  /** Accept a full page URL and keep only its origin (for observed top-frame URLs). */
  allowPath?: boolean;
  /** Per-item development mode: allows http, localhost, private names and IP literals. */
  devMode?: boolean;
}

const PRIVATE_SUFFIXES = ['local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'test', 'invalid', 'example'];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function isPrivateName(host: string): boolean {
  if (!host.includes('.')) return true; // single-label names resolve through search domains
  return PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function normalizeOrigin(input: string, options: OriginOptions = {}): NormalizedOrigin {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) throw new OriginRefusal('invalid_url');
  if (/[\u0000-\u001f\u007f\s]/.test(input)) throw new OriginRefusal('invalid_url');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginRefusal('invalid_url');
  }
  const scheme = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : null;
  if (scheme === null) throw new OriginRefusal('scheme_not_https');
  if (scheme === 'http' && !options.devMode) throw new OriginRefusal('scheme_not_https');
  if (url.username !== '' || url.password !== '') throw new OriginRefusal('has_credentials');
  if (!options.allowPath) {
    if (url.pathname !== '/' && url.pathname !== '') throw new OriginRefusal('has_path');
    if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
      throw new OriginRefusal('has_query_or_fragment');
    }
  }

  let host = url.hostname;
  if (host.startsWith('[') || isIP(host) !== 0) {
    if (!options.devMode) throw new OriginRefusal('ip_literal');
  } else {
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.length === 0 || host.length > 253) throw new OriginRefusal('invalid_hostname');
    const labels = host.split('.');
    if (labels.some((label) => !LABEL.test(label))) throw new OriginRefusal('invalid_hostname');
    if (host === 'localhost' || host.endsWith('.localhost')) {
      if (!options.devMode) throw new OriginRefusal('localhost');
    } else if (isPrivateName(host) && !options.devMode) {
      throw new OriginRefusal('private_name');
    }
  }

  const port = url.port === '' ? null : Number(url.port);
  const origin = `${scheme}://${host}${port === null ? '' : `:${port}`}`;
  const idn = host.split('.').some((label) => label.startsWith('xn--'));
  const displayHost = idn ? domainToUnicode(host) || host : host;
  return { origin, scheme, host, displayHost, port, idn };
}

/** Exact comparison of two origins after normalisation. Never prefix, suffix or site matching. */
export function sameOrigin(a: string, b: string, options: OriginOptions = {}): boolean {
  try {
    return normalizeOrigin(a, { ...options, allowPath: true }).origin === normalizeOrigin(b, { ...options, allowPath: true }).origin;
  } catch {
    return false;
  }
}
