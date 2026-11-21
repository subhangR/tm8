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
import { CONNECTORS, GENERIC_DENY_SEGMENTS, findConnector, type ConnectorRegistry, type ConnectorTemplate } from './connectors.js';
import {
  checkBody, checkQuery, dispositionNames, headerAllowed, matchOperation, multiplexedBody, multiplexedParams, multiplexedPath,
  type ConnectorOperation,
} from './operations.js';
import { nodeHttpsTransport, type EgressTransport, type PinnedHttpsResponse } from './transport.js';

export { CONNECTORS, GENERIC_DENY_SEGMENTS, findConnector, vettedConnector } from './connectors.js';
export type { ConnectorTemplate, ConnectorRegistry, ConnectorDenyEntry } from './connectors.js';
export {
  catalogProblems, checkBody, checkQuery, dispositionNames, headerAllowed, matchOperation, multiplexedBody, multiplexedJson,
  multiplexedParams, multiplexedPath,
} from './operations.js';
export type { CheckedBody, ConnectorOperation, OperationBody, ValueRule } from './operations.js';
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
  'content-length', 'transfer-encoding', 'connection', 'te', 'upgrade', 'keep-alive',
  // Method and URL overrides. Google APIs, ASP.NET, Symfony, Express
  // method-override and IIS URL Rewrite can honor these upstream, which would
  // escape the method allowlist, path prefixes and deny rules checked here.
  'x-http-method-override', 'x-http-method', 'x-method-override',
  'x-original-url', 'x-original-uri', 'x-rewrite-url', 'x-override-url', 'x-host',
  // Client-address claims, like x-real-ip: the broker is the client.
  'x-client-ip', 'true-client-ip', 'x-originating-ip', 'x-remote-ip', 'x-remote-addr',
  'client-ip', 'x-cluster-client-ip', 'cf-connecting-ip', 'fastly-client-ip']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * A method override field. Rails (Rack), Laravel/Symfony and Express middleware take `_method`
 * as the real method, Salesforce takes `_HttpMethod`, and some frameworks read the override
 * headers' names as fields. A plain `method` or `payment_method` is ordinary data.
 */
const METHOD_FIELD = /^(?:(?:_{1,2}|\$)(?:http_?)?method|x-(?:http-)?method(?:-override)?)$/i;
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

/**
 * A method override field in the body the upstream will parse. Rack parses a POST without a
 * content type as a form, so a missing type is checked as one, and it parses `multipart/related`
 * and `multipart/mixed` as a form too, so every multipart type is checked.
 */
function spoofsMethod(text: string, contentType: string | undefined): boolean {
  const mime = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (mime === '' || mime === 'application/x-www-form-urlencoded') {
    return [...new URLSearchParams(text).keys()].some((key) => METHOD_FIELD.test(key));
  }
  if (mime.startsWith('multipart/')) return dispositionNames(text).some((name) => METHOD_FIELD.test(name));
  if (mime === 'application/json' || mime.endsWith('+json')) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return false; }
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some((key) => METHOD_FIELD.test(key));
  }
  return false;
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

/** Where a request goes. `operation` is set for a connector template with vetted operations. */
interface Destination {
  url: URL;
  path: string;
  connector?: ConnectorTemplate;
  operation?: ConnectorOperation;
}

function parseDestination(input: EgressExecuteInput, connectors: ConnectorRegistry): Destination {
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
  let connector: ConnectorTemplate | undefined;
  if (policy.mode === 'connector') {
    connector = findConnector(connectors, policy.connector);
    if (!connector || !connector.hosts.includes(host)) throw new EgressRefusal('host_not_allowed');
    if (!sameInjection(policy.injection, connector.injection)) throw new EgressRefusal('header_refused');
  }
  // A template without a vetted operation list is unrestricted, so it is held to generic mode's
  // rules on top of its own deny list. An empty list matches nothing and refuses everything.
  const operations = connector?.operations;
  if (!METHODS.has(request.method) || !policy.methods.includes(request.method)) throw new EgressRefusal('method_not_allowed');
  if ([...url.searchParams.keys()].some((key) => METHOD_FIELD.test(key))) throw new EgressRefusal('method_not_allowed');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new EgressRefusal('url_refused'); }
  // ';' starts a path parameter: Tomcat-style upstreams strip it before routing,
  // so `/tokens;x` would miss a deny rule and `/allowed/..;/other` would leave
  // the allowed prefix after these checks pass.
  if (/[\0-\x1f\x7f\\;]/.test(path) || /%(?:2f|5c|00|2e|25)/i.test(path)) throw new EgressRefusal('url_refused');
  // Deny wins even when an owner selected an overly broad path prefix.
  const connectorDenied = connector?.deny.some((entry) =>
    entry.methods.includes(request.method) && new RegExp(entry.pathPattern.source, entry.pathPattern.flags.replace(/[gy]/g, '')).test(path)) ?? false;
  const genericDenied = !operations && path.toLowerCase().split('/').some((segment) => GENERIC_DENY_SEGMENTS.has(segment));
  if (connectorDenied || genericDenied) throw new EgressRefusal('token_management_denied');
  // GraphQL, JSON-RPC and batch envelopes hide the real operation from every check here (F02).
  if (multiplexedParams(url.searchParams)) throw new EgressRefusal('multiplexer_refused');
  if (!operations && multiplexedPath(path)) throw new EgressRefusal('multiplexer_refused');
  if (!policy.pathPrefixes.some((prefix) => prefixMatches(path, prefix))) throw new EgressRefusal('path_not_allowed');
  if (!operations) return { url, path, connector };
  const operation = matchOperation(operations, request.method, path);
  if (!operation) throw new EgressRefusal(multiplexedPath(path) ? 'multiplexer_refused' : 'operation_not_allowed');
  // The upstream receives the query rebuilt from the checked pairs, not the agent's raw text.
  url.search = checkQuery(operation, url);
  return { url, path, connector, operation };
}

function prepare(input: EgressExecuteInput, { url, connector, operation }: Destination): { headers: Record<string, string>; body?: Buffer } {
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
    // A vetted operation takes only its template's agent headers, each value checked by its rule.
    if (operation && !headerAllowed(connector?.headers, name, value)) throw new EgressRefusal('header_refused');
    headerBytes += Buffer.byteLength(rawName) + Buffer.byteLength(value) + 4;
    if (headerBytes > 8192) throw new EgressRefusal('header_refused');
    headers[name] = value;
  }
  let body: Buffer | undefined;
  let rebuilt: Buffer | undefined;
  try {
    if (request.body) {
      const text = request.body.kind === 'json' ? JSON.stringify(request.body.value) : request.body.value;
      if (typeof text !== 'string') throw new EgressRefusal('body_too_large');
      if (!Number.isSafeInteger(policy.maxRequestBytes) || policy.maxRequestBytes < 0 || Buffer.byteLength(text) > policy.maxRequestBytes) throw new EgressRefusal('body_too_large');
      body = Buffer.from(text);
      const contentType = request.body.kind === 'json' ? 'application/json' : request.body.contentType;
      if (contentType !== undefined) { validateHeader('content-type', contentType); headers['content-type'] ??= contentType; }
      if (spoofsMethod(text, headers['content-type'])) throw new EgressRefusal('method_not_allowed');
      if (multiplexedBody(text, headers['content-type'])) throw new EgressRefusal('multiplexer_refused');
    }
    if (operation) {
      // The operation fixes the body and its content type. A form goes upstream rebuilt from the
      // checked pairs; the agent's own text is still what the canary check below reads.
      const checked = checkBody(operation, request.body);
      if (checked) headers['content-type'] = checked.contentType;
      if (checked?.text !== undefined) {
        if (Buffer.byteLength(checked.text) > policy.maxRequestBytes) throw new EgressRefusal('body_too_large');
        rebuilt = Buffer.from(checked.text);
      }
    }
    if (canaries.matches(request.url) || canaries.matches(url.href) || Object.values(headers).some((value) => canaries.matches(value)) ||
      (body && canaries.matches(body)) || (rebuilt && canaries.matches(rebuilt))) {
      throw new EgressRefusal('canary_in_request');
    }
    if (rebuilt) { body?.fill(0); body = rebuilt; rebuilt = undefined; }
    return { headers, body };
  } catch (error) {
    body?.fill(0);
    rebuilt?.fill(0);
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
      const destination = parseDestination(input, options.connectors ?? CONNECTORS);
      const { url } = destination;
      const prepared = prepare(input, destination);
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
