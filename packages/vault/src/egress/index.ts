import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable, Transform } from 'node:stream';
import {
  isNonPublicAddress, resolvePublicAddresses, OutboundGuardError, type HostResolver, type ResolvedAddress,
} from '@tm8/integrations';
import { createResponseFilter } from '../filter/index.js';
import { EgressRefusal, type ApiResponseOutcome, type BrokerPolicy, type EgressExecutor,
  type EgressExecuteInput, type KeyInjection, type TokenSpanScanner } from '../types.js';
import { CONNECTORS, GENERIC_DENY_SEGMENTS, type ConnectorRegistry } from './connectors.js';
import { nodeHttpsTransport, type EgressTransport, type PinnedHttpsResponse } from './transport.js';

export { CONNECTORS, GENERIC_DENY_SEGMENTS } from './connectors.js';
export type { ConnectorTemplate, ConnectorRegistry, ConnectorDenyEntry } from './connectors.js';
export { nodeHttpsTransport } from './transport.js';
export type { EgressTransport, PinnedHttpsRequest, PinnedHttpsResponse } from './transport.js';

export interface EgressExecutorOptions {
  resolve?: HostResolver;
  transport?: EgressTransport;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  scanTokens?: TokenSpanScanner;
  connectors?: ConnectorRegistry;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAD_VALUE = /[\r\n\0]/;
const BLOCKED_HEADERS = new Set(['authorization', 'cookie', 'host', 'forwarded', 'x-real-ip',
  'content-length', 'transfer-encoding', 'connection', 'te', 'upgrade', 'keep-alive']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const systemResolver: HostResolver = async (host) => (await dnsLookup(host, { all: true }))
  .map(({ address, family }) => ({ address, family: family as 4 | 6 }));

// Gaps in the shared guard at base 7e65fe28 (to be moved there by WS-A):
// 192.88.99/24 (deprecated 6to4), IPv4-compatible/reserved IPv6 outside
// 2000::/3, IETF special-purpose 2001::/23, former 6bone 3ffe::/16 and
// documentation 3fff::/20. Sources:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// https://www.rfc-editor.org/rfc/rfc3701 (6bone phaseout).
// These are additions, not a fork of the shared deny list.
const EXTRA_V4 = new BlockList(); EXTRA_V4.addSubnet('192.88.99.0', 24, 'ipv4');
const GLOBAL_V6 = new BlockList(); GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const EXTRA_V6 = new BlockList();
EXTRA_V6.addSubnet('2001::', 23, 'ipv6'); EXTRA_V6.addSubnet('3fff::', 20, 'ipv6');
EXTRA_V6.addSubnet('3ffe::', 16, 'ipv6');

function nonPublic({ address, family }: ResolvedAddress): boolean {
  if (address.includes('%') || isIP(address) !== family || isNonPublicAddress(address)) return true;
  return family === 4 ? EXTRA_V4.check(address, 'ipv4') :
    !GLOBAL_V6.check(address, 'ipv6') || EXTRA_V6.check(address, 'ipv6');
}

function injectionHeader(injection: KeyInjection): string | null {
  return injection.kind === 'header' ? injection.name.toLowerCase() : injection.kind === 'query' ? null : 'authorization';
}

function blockedHeader(name: string): boolean {
  return BLOCKED_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('x-forwarded-');
}

function validateHeader(name: string, value: string): void {
  if (!TOKEN.test(name) || typeof value !== 'string' || BAD_VALUE.test(value)) throw new EgressRefusal('header_refused');
}

function sameInjection(a: KeyInjection, b: KeyInjection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'header' && b.kind === 'header') return a.name.toLowerCase() === b.name.toLowerCase() && (a.prefix ?? '') === (b.prefix ?? '');
  if (a.kind === 'basic' && b.kind === 'basic') return a.username === b.username;
  if (a.kind === 'query' && b.kind === 'query') return a.name === b.name;
  return a.kind === 'bearer';
}

function prefixMatches(path: string, prefix: string): boolean {
  if (!prefix.startsWith('/')) return false;
  const base = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`);
}

function parseDestination(input: EgressExecuteInput, connectors: ConnectorRegistry): { url: URL; path: string } {
  const { request, policy } = input;
  let url: URL;
  try { url = new URL(request.url); } catch { throw new EgressRefusal('url_refused'); }
  if (url.protocol !== 'https:') throw new EgressRefusal('scheme_refused');
  if (url.username || url.password) throw new EgressRefusal('credentials_in_url');
  // Check the original path too: WHATWG normalization may remove an encoded
  // slash in a segment followed by '..'. A bare '#' still is a fragment.
  const originalPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(request.url)?.[1] ?? '';
  if (request.url.includes('#') || (url.port && url.port !== '443') || /%(?:2f|5c|00)/i.test(originalPath) ||
    /%(?:2f|5c|00)/i.test(url.pathname) || originalPath.includes('\\')) throw new EgressRefusal('url_refused');
  const host = url.hostname;
  if (isIP(host.replace(/^\[|\]$/g, '')) || !policy.hosts.includes(host)) throw new EgressRefusal('host_not_allowed');
  let connector;
  if (policy.mode === 'connector') {
    connector = policy.connector ? connectors[policy.connector] : undefined;
    if (!connector || !connector.hosts.includes(host)) throw new EgressRefusal('host_not_allowed');
    if (!sameInjection(policy.injection, connector.injection)) throw new EgressRefusal('header_refused');
  }
  if (!METHODS.has(request.method) || !policy.methods.includes(request.method)) throw new EgressRefusal('method_not_allowed');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new EgressRefusal('url_refused'); }
  if (/[\0-\x1f\x7f\\]/.test(path) || /%(?:2f|5c|00|2e|25)/i.test(path)) throw new EgressRefusal('url_refused');
  // Deny wins even when an owner selected an overly broad path prefix.
  const denied = connector ? connector.deny.some((entry) =>
    entry.methods.includes(request.method) && new RegExp(entry.pathPattern.source, entry.pathPattern.flags.replace(/[gy]/g, '')).test(path)) :
    path.toLowerCase().split('/').some((segment) => GENERIC_DENY_SEGMENTS.has(segment));
  if (denied) throw new EgressRefusal('token_management_denied');
  if (!policy.pathPrefixes.some((prefix) => prefixMatches(path, prefix))) throw new EgressRefusal('path_not_allowed');
  return { url, path };
}

function prepare(input: EgressExecuteInput, url: URL): { headers: Record<string, string>; body?: Buffer } {
  const { policy, request, canaries } = input;
  const injection = policy.injection;
  if (injection.kind === 'query' && policy.mode !== 'generic') throw new EgressRefusal('url_refused');
  if (injection.kind === 'header' && (!TOKEN.test(injection.name) || blockedHeader(injection.name.toLowerCase()) || BAD_VALUE.test(injection.prefix ?? ''))) {
    throw new EgressRefusal('header_refused');
  }
  if (injection.kind === 'query' && (!injection.name || BAD_VALUE.test(injection.name))) throw new EgressRefusal('header_refused');
  if (injection.kind === 'basic' && (BAD_VALUE.test(injection.username) || injection.username.includes(':'))) throw new EgressRefusal('header_refused');
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = Object.entries(request.headers ?? {});
  if (entries.length > 32) throw new EgressRefusal('header_refused');
  let headerBytes = 0;
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    validateHeader(rawName, value);
    if (blockedHeader(name) || name === injectionHeader(injection) || Object.hasOwn(headers, name)) throw new EgressRefusal('header_refused');
    headerBytes += Buffer.byteLength(rawName) + Buffer.byteLength(value) + 4;
    if (headerBytes > 8192) throw new EgressRefusal('header_refused');
    headers[name] = value;
  }
  let body: Buffer | undefined;
  try {
    if (request.body) {
      const text = request.body.kind === 'json' ? JSON.stringify(request.body.value) : request.body.value;
      if (typeof text !== 'string') throw new EgressRefusal('body_too_large');
      if (!Number.isSafeInteger(policy.maxRequestBytes) || policy.maxRequestBytes < 0 || Buffer.byteLength(text) > policy.maxRequestBytes) throw new EgressRefusal('body_too_large');
      body = Buffer.from(text);
      const contentType = request.body.kind === 'json' ? 'application/json' : request.body.contentType;
      if (contentType !== undefined) { validateHeader('content-type', contentType); headers['content-type'] ??= contentType; }
    }
    if (canaries.matches(request.url) || canaries.matches(url.href) || Object.values(headers).some((value) => canaries.matches(value)) || (body && canaries.matches(body))) {
      throw new EgressRefusal('canary_in_request');
    }
    return { headers, body };
  } catch (error) {
    body?.fill(0);
    if (error instanceof EgressRefusal) throw error;
    throw new EgressRefusal('body_too_large');
  }
}

function inject(input: EgressExecuteInput, url: URL, headers: Record<string, string>): void {
  let key = '';
  try {
    const parsed: unknown = input.key.use((bytes) => JSON.parse(bytes.toString('utf8')));
    if (!parsed || typeof parsed !== 'object' || !('key' in parsed) || typeof parsed.key !== 'string' || !parsed.key) throw new EgressRefusal('header_refused');
    key = parsed.key;
    if (BAD_VALUE.test(key)) throw new EgressRefusal('header_refused');
    const injection = input.policy.injection;
    if (injection.kind === 'bearer') headers.authorization = `Bearer ${key}`;
    else if (injection.kind === 'header') headers[injection.name.toLowerCase()] = `${injection.prefix ?? ''}${key}`;
    else if (injection.kind === 'query') url.searchParams.set(injection.name, key);
    else {
      const basic = Buffer.from(`${injection.username}:${key}`);
      try { headers.authorization = `Basic ${basic.toString('base64')}`; } finally { basic.fill(0); }
    }
    if (input.canaries.matches(url.href) || Object.values(headers).some((value) => input.canaries.matches(value))) throw new EgressRefusal('canary_in_request');
    headers['accept-encoding'] = 'identity'; headers['user-agent'] = 'tm8-vault-broker/1';
  } catch (error) {
    if (error instanceof EgressRefusal) throw error;
    throw new EgressRefusal('header_refused');
  } finally { key = ''; }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new EgressRefusal('timeout'));
    if (signal.aborted) { void work.catch(() => {}); onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function resolveAddress(url: URL, resolve: HostResolver): Promise<ResolvedAddress> {
  let empty = false;
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolvePublicAddresses(url, { protocols: ['https:'], resolve: async (host) => {
      const answers = await resolve(host); empty = answers.length === 0; return answers;
    } });
  } catch (error) {
    throw new EgressRefusal(error instanceof OutboundGuardError && error.reason === 'non_public' && !empty ? 'private_address' : 'dns_failed');
  }
  if (!addresses.length) throw new EgressRefusal('dns_failed');
  if (addresses.some(nonPublic)) throw new EgressRefusal('private_address');
  return { ...addresses[0]! };
}

async function readCapped(response: PinnedHttpsResponse, maxBytes: number): Promise<{ body: Buffer; reason?: 'too_large' | 'binary' }> {
  const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  let decoded: Readable = response.body;
  let decoder: Transform | null = null;
  if (encoding && encoding !== 'identity') {
    decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
    if (!decoder) return { body: Buffer.alloc(0), reason: 'binary' };
    const activeDecoder = decoder;
    response.body.on('error', (error) => activeDecoder.destroy(error));
    decoded = response.body.pipe(decoder);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of decoded) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += bytes.length;
      if (length > maxBytes) return { body: Buffer.alloc(0), reason: 'too_large' };
      chunks.push(bytes);
    }
    return { body: Buffer.concat(chunks, length) };
  } catch (error) {
    if (error instanceof EgressRefusal) throw error;
    // A malformed compressed representation is content, not an agent-visible
    // upstream exception. Network stream failures retain their typed refusal.
    if (decoder?.errored && !response.body.errored) return { body: Buffer.alloc(0), reason: 'binary' };
    throw new EgressRefusal('upstream_unreachable');
  } finally {
    if (decoder) { response.body.unpipe(decoder); decoder.destroy(); }
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function createEgressExecutor(options: EgressExecutorOptions = {}): EgressExecutor {
  const filter = createResponseFilter();
  const connectTimeoutMs = Math.max(1, options.connectTimeoutMs ?? 5000);
  const totalTimeoutMs = Math.max(1, options.totalTimeoutMs ?? 30000);
  const transport = options.transport ?? nodeHttpsTransport;
  return {
    async execute(input): Promise<ApiResponseOutcome> {
      const { url } = parseDestination(input, options.connectors ?? CONNECTORS);
      const prepared = prepare(input, url);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      let response: PinnedHttpsResponse | undefined;
      let decoded: Buffer | undefined;
      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        inject(input, url, prepared.headers);
        if (!Number.isSafeInteger(input.policy.maxResponseBytes) || input.policy.maxResponseBytes < 0) throw new EgressRefusal('body_too_large');
        input.signal?.addEventListener('abort', onAbort, { once: true });
        if (input.signal?.aborted) controller.abort();
        totalTimer = setTimeout(onAbort, totalTimeoutMs);
        if (controller.signal.aborted) throw new EgressRefusal('timeout');
        const address = await abortable(resolveAddress(url, options.resolve ?? systemResolver), controller.signal);
        const pendingResponse = transport({ url, address, method: input.request.method, headers: prepared.headers,
          body: prepared.body, connectTimeoutMs: Math.min(connectTimeoutMs, totalTimeoutMs), totalTimeoutMs, signal: controller.signal });
        // Even an injected transport that ignores abort cannot leave a late socket open.
        pendingResponse.then((late) => { if (controller.signal.aborted) late.close(); }, () => {});
        response = await abortable(pendingResponse, controller.signal);
        if (response.status >= 300 && response.status < 400) throw new EgressRefusal('redirect_refused');
        const pendingBody = readCapped(response, input.policy.maxResponseBytes);
        pendingBody.then((late) => { if (controller.signal.aborted) late.body.fill(0); }, () => {});
        const result = await abortable(pendingBody, controller.signal);
        decoded = result.body;
        const outcome = filter({ status: response.status, headers: response.headers, body: decoded,
          contentType: response.headers['content-type'] ?? null, key: input.key, canaries: input.canaries,
          maxBytes: input.policy.maxResponseBytes, scanTokens: options.scanTokens });
        return result.reason ? { ...outcome, body: { kind: 'withheld', reason: result.reason } } : outcome;
      } catch (error) {
        if (controller.signal.aborted) throw new EgressRefusal('timeout');
        if (error instanceof EgressRefusal) throw error;
        if (['ETIMEDOUT', 'ABORT_ERR'].includes((error as { code?: string } | null)?.code ?? '')) throw new EgressRefusal('timeout');
        throw new EgressRefusal('upstream_unreachable');
      } finally {
        clearTimeout(totalTimer); input.signal?.removeEventListener('abort', onAbort);
        response?.close(); controller.abort(); decoded?.fill(0); prepared.body?.fill(0);
        for (const name of Object.keys(prepared.headers)) delete prepared.headers[name];
        // Query injection and transport headers must not survive the operation.
        url.search = '';
      }
    },
  };
}
