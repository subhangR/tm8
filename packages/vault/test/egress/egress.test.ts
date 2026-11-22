import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createEgressExecutor, CONNECTORS, GENERIC_DENY_SEGMENTS, type EgressExecutorOptions,
  type PinnedHttpsResponse, type PinnedHttpsRequest } from '../../src/egress/index.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { SecretMaterial } from '../../src/secret-material.js';
import { EgressRefusal, type ApiRequestBody, type BrokerPolicy, type EgressExecuteInput, type EgressRefusalCode, type KeyInjection } from '../../src/types.js';

const fixtureKey = ['safe', 'fixture', 'value-1234567890'].join('-');
const publicAddress = { address: '93.184.216.34', family: 4 as const };
const policy: BrokerPolicy = { keyId: 'item', version: 1, mode: 'generic', connector: null, hosts: ['api.example.com'],
  methods: ['GET', 'POST'], pathPrefixes: ['/v1/x'], maxRequestBytes: 4096, maxResponseBytes: 4096, injection: { kind: 'bearer' } };

function response(body: string | Buffer = 'okay', headers: Record<string, string> = { 'content-type': 'text/plain' }, status = 200): PinnedHttpsResponse {
  const stream = Readable.from([typeof body === 'string' ? Buffer.from(body) : body]);
  return { status, headers, body: stream, close: vi.fn(() => { stream.destroy(); }) };
}

function harness(options: EgressExecutorOptions = {}) {
  const resolve = vi.fn(async () => [publicAddress]);
  const transport = vi.fn(async (_request: PinnedHttpsRequest) => response());
  return { resolve, transport, executor: createEgressExecutor({ resolve, transport, ...options }) };
}

async function withInput<T>(fn: (input: EgressExecuteInput) => Promise<T>, overrides: Partial<EgressExecuteInput> = {}): Promise<T> {
  const key = SecretMaterial.fromUtf8(JSON.stringify({ key: fixtureKey }));
  try {
    return await fn({ operationId: 'operation', policy: { ...policy }, key, request: { method: 'GET', url: 'https://api.example.com/v1/x' },
      canaries: buildCanarySet([]), ...overrides });
  } finally { key.dispose(); }
}

async function refused(input: EgressExecuteInput, code: EgressRefusalCode) {
  const h = harness();
  await expect(h.executor.execute(input)).rejects.toMatchObject({ code, message: `egress refused: ${code}` });
  expect(h.resolve).not.toHaveBeenCalled(); expect(h.transport).not.toHaveBeenCalled();
}

describe('request policy (acceptance 8)', () => {
  it.each([
    ['not a URL', 'url_refused'], ['http://api.example.com/v1/x', 'scheme_refused'],
    ['https://name:password@api.example.com/v1/x', 'credentials_in_url'],
    ['https://api.example.com/v1/x#fragment', 'url_refused'], ['https://api.example.com/v1/x#', 'url_refused'],
    ['https://api.example.com:444/v1/x', 'url_refused'], ['https://api.example.com/v1/%2f/../x', 'url_refused'],
    ['https://api.example.com/v1/x%2Fchild', 'url_refused'], ['https://api.example.com/v1/x%5cchild', 'url_refused'],
    ['https://api.example.com/v1/x%00', 'url_refused'], ['https://api.example.com/v1/%xx', 'url_refused'],
    ['https://evil.example/v1/x', 'host_not_allowed'], ['https://api.example.com.evil.example/v1/x', 'host_not_allowed'],
    ['https://api.example.com./v1/x', 'host_not_allowed'], ['https://api.example.com/v1/xy', 'path_not_allowed'],
    ['https://api.example.com/v1/x/../../elsewhere', 'path_not_allowed'],
    // Path parameters: an upstream that strips them routes differently from these checks.
    ['https://api.example.com/v1/x;jsessionid=1', 'url_refused'], ['https://api.example.com/v1/x/..;/elsewhere', 'url_refused'],
    ['https://api.example.com/v1/x%3Bchild', 'url_refused'],
  ] as const)('refuses a destination with %s', (url, code) => withInput((input) => refused({ ...input, request: { ...input.request, url } }, code)));

  it('refuses off-allowlist methods', () => withInput((input) => refused({ ...input, request: { ...input.request, method: 'DELETE' } }, 'method_not_allowed')));

  it('matches normalized segment prefixes and exact punycode hostnames', () => withInput(async (input) => {
    const h = harness();
    for (const path of ['/v1/x', '/v1/x/', '/v1/x/child', '/v1/./x', '/v1/%78']) {
      expect((await h.executor.execute({ ...input, request: { ...input.request, url: `https://api.example.com${path}` } })).status).toBe(200);
    }
    await h.executor.execute({ ...input, policy: { ...policy, hosts: ['xn--bcher-kva.example'] }, request: { method: 'GET', url: 'https://bücher.example/v1/x' } });
    expect(h.resolve).toHaveBeenLastCalledWith('xn--bcher-kva.example');
    expect(input.key.disposed).toBe(false);
  }));

  const refusedNames = ['Authorization', 'COOKIE', 'Proxy-Authorization', 'proxy-connection', 'Host', 'Forwarded',
    'X-Forwarded-For', 'x-forwarded-proto', 'X-Real-IP', 'Content-Length', 'Transfer-Encoding', 'Connection', 'TE',
    'Upgrade', 'Keep-Alive', 'bad name', 'x-bad\rname', 'x-bad:name', '',
    // Method/URL overrides and client-address claims an upstream framework may honor.
    'X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override', 'X-Original-URL', 'x-original-uri', 'X-Rewrite-URL',
    'x-override-url', 'X-Host', 'X-Client-IP', 'True-Client-IP', 'X-Originating-IP', 'x-remote-ip', 'x-remote-addr',
    'Client-IP', 'X-Cluster-Client-IP', 'CF-Connecting-IP', 'Fastly-Client-IP'];
  it.each(refusedNames)('refuses header %s before DNS', (name) => withInput((input) =>
    refused({ ...input, request: { ...input.request, headers: { [name]: 'value' } } }, 'header_refused')));
  it.each(['\r', '\n', '\0'])('refuses a header control value', (control) => withInput((input) =>
    refused({ ...input, request: { ...input.request, headers: { 'x-test': `value${control}injection` } } }, 'header_refused')));
  it.each(['\r', '\n', '\0'])('refuses a key control character before DNS', (control) => withInput(async (input) => {
    const key = SecretMaterial.fromUtf8(JSON.stringify({ key: `fixture${control}value` }));
    try { await refused({ ...input, key }, 'header_refused'); } finally { key.dispose(); }
  }));

  it('refuses _method overrides in the query and in form, multipart and JSON bodies before DNS', () => withInput(async (input) => {
    const post = { ...input.request, method: 'POST' as const };
    for (const url of ['https://api.example.com/v1/x?_method=DELETE', 'https://api.example.com/v1/x?a=1&%5FMETHOD=DELETE']) {
      await refused({ ...input, request: { ...post, url } }, 'method_not_allowed');
    }
    const multipart = (disposition: string) => `--b\r\nContent-Disposition: form-data; ${disposition}\r\n\r\nDELETE\r\n--b--\r\n`;
    const spoofing: ApiRequestBody[] = [
      { kind: 'text', value: 'a=1&_method=DELETE', contentType: 'application/x-www-form-urlencoded; charset=utf-8' },
      // Rack parses a POST without a content type as a form.
      { kind: 'text', value: '_method=DELETE' },
      { kind: 'text', value: multipart('name="_method"'), contentType: 'multipart/form-data; boundary=b' },
      { kind: 'text', value: multipart('name=_method'), contentType: 'multipart/form-data; boundary=b' },
      { kind: 'json', value: { _method: 'DELETE' } },
      { kind: 'text', value: '{"_Method":"DELETE"}', contentType: 'application/vnd.api+json' },
    ];
    for (const body of spoofing) await refused({ ...input, request: { ...post, body } }, 'method_not_allowed');
    // Only the whole top-level field counts: Stripe's payment_method is ordinary data.
    const h = harness();
    const ordinary: ApiRequestBody[] = [
      { kind: 'text', value: 'payment_method=pm_fixture', contentType: 'application/x-www-form-urlencoded' },
      { kind: 'json', value: { payment_method: 'pm_fixture', nested: { _method: 'DELETE' } } },
      { kind: 'text', value: multipart('filename="_method"; name="file"'), contentType: 'multipart/form-data; boundary=b' },
      { kind: 'text', value: '_method=DELETE', contentType: 'text/plain' },
    ];
    for (const body of ordinary) expect((await h.executor.execute({ ...input, request: { ...post, body } })).status).toBe(200);
    expect(h.transport).toHaveBeenCalledTimes(ordinary.length);
  }));

  it('refuses the injection header name, duplicates, excessive count and bytes', () => withInput(async (input) => {
    await refused({ ...input, policy: { ...policy, injection: { kind: 'header', name: 'x-api-key' } },
      request: { ...input.request, headers: { 'X-API-Key': 'value' } } }, 'header_refused');
    for (const headers of [{ foo: 'x', FOO: 'y' }, { 'x-test': 'x'.repeat(8192) },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, 'v']))]) {
      await refused({ ...input, request: { ...input.request, headers } }, 'header_refused');
    }
  }));

  it('refuses serialized bodies over the byte cap and body content-type injection', () => withInput(async (input) => {
    await refused({ ...input, request: { ...input.request, body: { kind: 'text', value: 'é'.repeat(2049) } } }, 'body_too_large');
    await refused({ ...input, request: { ...input.request, body: { kind: 'json', value: 'a'.repeat(4095) } } }, 'body_too_large');
    await refused({ ...input, request: { ...input.request, body: { kind: 'text', value: '', contentType: 'text/plain\r\nx-evil: yes' } } }, 'header_refused');
    const cyclic: { child?: unknown } = {}; cyclic.child = cyclic;
    await refused({ ...input, request: { ...input.request, body: { kind: 'json', value: cyclic } } }, 'body_too_large');
  }));

  it('refuses planted canaries in the URL, headers, body and injected credential', () => withInput(async (input) => {
    const canary = ['planted', 'decoy-1234567890'].join('-');
    const canaries = buildCanarySet([canary]);
    for (const request of [
      { ...input.request, url: `${input.request.url}?data=${encodeURIComponent(canary)}` },
      { ...input.request, headers: { 'x-test': Buffer.from(canary).toString('base64') } },
      { ...input.request, body: { kind: 'text' as const, value: canary } },
    ]) await refused({ ...input, canaries, request }, 'canary_in_request');
    await refused({ ...input, canaries: buildCanarySet([fixtureKey]) }, 'canary_in_request');
  }));

  it('supports all injection kinds, fixes encoding and user agent, and clears transport input afterwards', () => withInput(async (input) => {
    const injections: KeyInjection[] = [{ kind: 'bearer' }, { kind: 'header', name: 'x-fixture', prefix: 'Key ' },
      { kind: 'basic', username: 'service' }, { kind: 'query', name: 'api_key' }];
    for (const injection of injections) {
      let retained: PinnedHttpsRequest | undefined;
      const transport = vi.fn(async (sent: PinnedHttpsRequest) => {
        retained = sent;
        expect(sent.address).toEqual(publicAddress);
        expect(sent.headers['accept-encoding']).toBe('identity'); expect(sent.headers['user-agent']).toBe('tm8-vault-broker/1');
        if (injection.kind === 'query') expect(sent.url.searchParams.get('api_key') === fixtureKey).toBe(true);
        else if (injection.kind === 'header') expect(sent.headers['x-fixture'] === `Key ${fixtureKey}`).toBe(true);
        else if (injection.kind === 'bearer') expect(sent.headers.authorization === `Bearer ${fixtureKey}`).toBe(true);
        else expect(sent.headers.authorization === `Basic ${Buffer.from(`service:${fixtureKey}`).toString('base64')}`).toBe(true);
        return response();
      });
      const h = harness({ transport });
      await h.executor.execute({ ...input, policy: { ...policy, injection }, request: { ...input.request, headers: { 'user-agent': 'agent', 'accept-encoding': 'gzip' } } });
      expect(retained?.headers).toEqual({}); expect(retained?.url.search).toBe('');
    }
  }));
});

describe('connector denials (acceptance 8)', () => {
  const cases: Record<string, string[]> = {
    github: ['/authorizations', '/app/installations/1/access_tokens', '/repos/a/b/keys', '/repos/a/b/hooks',
      '/repos/a/b/actions/secrets', '/login/oauth/access_token', '/orgs/a/invitations', '/orgs/a/personal-access-token-requests',
      '/app/hook/config', '/repos/a/b/collaborators'],
    openai: ['/v1/organization/admin_api_keys', '/v1/realtime/client_secrets', '/v1/webhooks'],
    anthropic: ['/v1/organizations/api_keys', '/v1/api_keys'],
    stripe: ['/v1/tokens', '/v1/webhook_endpoints', '/v1/apps/secrets', '/oauth/token', '/v1/terminal/connection_tokens', '/v1/account_sessions'],
    slack: ['/api/oauth.v2.access', '/api/apps.connections.open', '/api/admin.users.invite', '/api/auth.tokens', '/api/users.admin.invite',
      '/api/apps.auth.external.get', '/api/rtm.connect'],
  };
  it.each(Object.keys(cases))('denies every %s entry, with broad owner allowances', (id) => withInput(async (input) => {
    const connector = CONNECTORS[id]!;
    expect(connector.deny).toHaveLength(cases[id]!.length);
    for (const [index, path] of cases[id]!.entries()) {
      expect(connector.deny[index]!.pathPattern.test(path)).toBe(true);
      for (const method of connector.deny[index]!.methods) {
        await refused({ ...input, policy: { ...policy, mode: 'connector', connector: id, hosts: connector.hosts,
          injection: connector.injection, methods: [method], pathPrefixes: ['/'] }, request: { method, url: `https://${connector.hosts[0]}${path}` } }, 'token_management_denied');
      }
    }
  }));

  it.each([...GENERIC_DENY_SEGMENTS])('denies generic segment %s after decoding and case folding', (segment) => withInput(async (input) => {
    for (const part of [segment, segment.toUpperCase(), `%${segment.charCodeAt(0).toString(16)}${segment.slice(1)}`]) {
      await refused({ ...input, policy: { ...policy, pathPrefixes: ['/'] }, request: { method: 'GET', url: `https://api.example.com/v1/${part}/child` } }, 'token_management_denied');
    }
  }));

  it('enforces vetted hosts and injections, permits test registry overrides', () => withInput(async (input) => {
    await refused({ ...input, policy: { ...policy, mode: 'connector', connector: 'github' } }, 'host_not_allowed');
    await refused({ ...input, policy: { ...policy, mode: 'connector', connector: 'unknown' } }, 'host_not_allowed');
    await refused({ ...input, policy: { ...policy, mode: 'connector', connector: 'github', hosts: ['api.github.com'], injection: { kind: 'query', name: 'key' } },
      request: { method: 'GET', url: 'https://api.github.com/repos/a/b' } }, 'header_refused');
    const h = harness({ connectors: { fixture: { id: 'fixture', hosts: policy.hosts, injection: policy.injection, defaultPathPrefixes: ['/'], deny: [] } } });
    expect((await h.executor.execute({ ...input, policy: { ...policy, mode: 'connector', connector: 'fixture' } })).status).toBe(200);
  }));
});

describe('SSRF and DNS pinning (acceptance 9)', () => {
  const privateAddresses = ['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.254', '192.168.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.1.2.3', '240.1.2.3', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fdff::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3',
    '::ffff:100.64.0.1', '::ffff:169.254.169.254', '::ffff:0a01:0203', '::127.0.0.1', '64:ff9b::a00:1',
    '100::1', '2001::1', '2001:2::1', '2001:20::1', '2001:db8::1', '2002:7f00:1::1', '3ffe::1', '3fff::1', '5f00::1'];
  it.each(privateAddresses)('refuses non-public DNS answer %s', (address) => withInput(async (input) => {
    const resolve = vi.fn(async () => [{ address, family: isIP(address) as 4 | 6 }]);
    const h = harness({ resolve });
    await expect(h.executor.execute(input)).rejects.toMatchObject({ code: 'private_address' });
    expect(resolve).toHaveBeenCalledTimes(1); expect(h.transport).not.toHaveBeenCalled();
  }));

  it('refuses mixed public/private answers, empty DNS, resolution failures and invalid families', () => withInput(async (input) => {
    for (const answers of [[publicAddress, { address: '10.0.0.1', family: 4 as const }], [{ address: publicAddress.address, family: 6 as const }]]) {
      const h = harness({ resolve: async () => answers });
      await expect(h.executor.execute(input)).rejects.toMatchObject({ code: 'private_address' });
      expect(h.transport).not.toHaveBeenCalled();
    }
    for (const resolve of [async () => [], async () => { throw new Error('unsafe upstream detail'); }]) {
      await expect(harness({ resolve }).executor.execute(input)).rejects.toMatchObject({ code: 'dns_failed', message: 'egress refused: dns_failed' });
    }
  }));

  it('resolves exactly once and passes only the checked address to the transport', () => withInput(async (input) => {
    const resolve = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const transport = vi.fn(async (sent: PinnedHttpsRequest) => { expect(sent.address).toEqual(publicAddress); return response(); });
    await harness({ resolve, transport }).executor.execute(input);
    expect(resolve).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
    const ipv6 = { address: '2606:4700:4700::1111', family: 6 as const };
    await harness({ resolve: async () => [ipv6], transport: async (sent) => { expect(sent.address).toEqual(ipv6); return response(); } }).executor.execute(input);
  }));

  it.each(['127.0.0.1', '2130706433', '0177.0.0.1', '0x7f000001', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]'])('refuses IP-literal %s before DNS', (host) => withInput((input) =>
    refused({ ...input, request: { ...input.request, url: `https://${host}/v1/x` }, policy: { ...policy, hosts: [host] } }, 'host_not_allowed')));

  it.each([300, 301, 302, 303, 304, 307, 308, 399])('never follows redirect status %s', (status) => withInput(async (input) => {
    const upstream = response('', { location: 'http://169.254.169.254/latest/meta-data' }, status);
    const transport = vi.fn(async () => upstream);
    await expect(harness({ transport }).executor.execute(input)).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(transport).toHaveBeenCalledTimes(1); expect(upstream.close).toHaveBeenCalled();
  }));
});

describe('response and failure path (acceptance 10)', () => {
  it.each(['gzip', 'deflate', 'br'])('caps decoded %s bytes and stops a zip bomb', (encoding) => withInput(async (input) => {
    const raw = Buffer.from('a'.repeat(1_000_000));
    const zipped = encoding === 'gzip' ? gzipSync(raw) : encoding === 'deflate' ? deflateSync(raw) : brotliCompressSync(raw);
    const upstream = response(zipped, { 'content-type': 'text/plain', 'content-encoding': encoding });
    const h = harness({ transport: async () => upstream });
    expect((await h.executor.execute(input)).body).toEqual({ kind: 'withheld', reason: 'too_large' });
    expect(upstream.body.destroyed).toBe(true);
  }));

  it.each(['gzip', 'deflate', 'br'])('decodes a bounded %s response before filtering', (encoding) => withInput(async (input) => {
    const raw = Buffer.from(`echo: ${fixtureKey}`);
    const zipped = encoding === 'gzip' ? gzipSync(raw) : encoding === 'deflate' ? deflateSync(raw) : brotliCompressSync(raw);
    const result = await harness({ transport: async () => response(zipped, { 'content-type': 'text/plain', 'content-encoding': encoding, 'set-cookie': 'drop', location: 'drop' }) }).executor.execute(input);
    expect(result.body).toEqual({ kind: 'text', value: 'echo: [redacted]' }); expect(result.redactions).toBe(1);
    expect(result.headers).toEqual({ 'content-type': 'text/plain' });
  }));

  it('withholds wire/decoded binary and malformed or unsupported encodings', () => withInput(async (input) => {
    for (const [body, headers] of [[Buffer.from([0, 1, 2]), { 'content-type': 'image/png' }],
      [Buffer.from('text'), { 'content-type': 'text/plain', 'content-encoding': 'compress' }],
      [Buffer.from('not gzip'), { 'content-type': 'text/plain', 'content-encoding': 'gzip' }],
      [Buffer.from('not deflate'), { 'content-type': 'text/plain', 'content-encoding': 'deflate' }],
      [Buffer.from([0xff, 0xff, 0xff]), { 'content-type': 'text/plain', 'content-encoding': 'br' }]] as const) {
      expect((await harness({ transport: async () => response(body, headers) }).executor.execute(input)).body).toEqual({ kind: 'withheld', reason: 'binary' });
    }
  }));

  it('withholds a compressed canary and passes the shared scanner to body and headers', () => withInput(async (input) => {
    const decoy = ['planted', 'canary-1234567890'].join('-');
    const h = harness({ transport: async () => response(gzipSync(decoy), { 'content-type': 'text/plain', 'content-encoding': 'gzip' }) });
    expect((await h.executor.execute({ ...input, canaries: buildCanarySet([decoy]) })).body).toEqual({ kind: 'withheld', reason: 'canary' });
    const scanTokens = (text: string) => text === 'scannable' ? [{ start: 0, end: text.length }] : [];
    const result = await harness({ scanTokens, transport: async () => response('scannable', { 'content-type': 'text/plain', etag: 'scannable' }) }).executor.execute(input);
    expect(result.redactions).toBe(2); expect(result.headers.etag).toBe('[redacted]');
  }));

  it('sanitizes connection and stream errors', () => withInput(async (input) => {
    await expect(harness({ transport: async () => { throw new Error('unsafe upstream detail'); } }).executor.execute(input))
      .rejects.toMatchObject({ code: 'upstream_unreachable', message: 'egress refused: upstream_unreachable' });
    const upstream = response();
    upstream.body = Readable.from((async function* () { yield Buffer.from('hello'); throw new Error('unsafe stream detail'); })());
    await expect(harness({ transport: async () => upstream }).executor.execute(input)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  }));

  it('times out during DNS, transport wait and body consumption, without disposing caller material', () => withInput(async (input) => {
    const forever = new Promise<never>(() => {});
    for (const options of [{ resolve: () => forever }, { transport: () => forever },
      { transport: async () => ({ ...response(), body: new Readable({ read() {} }) }) }]) {
      await expect(harness({ ...options, totalTimeoutMs: 15 }).executor.execute(input)).rejects.toMatchObject({ code: 'timeout' });
      expect(input.key.disposed).toBe(false);
    }
  }));

  it('maps a caller abort to timeout before DNS and during I/O', () => withInput(async (input) => {
    const controller = new AbortController(); controller.abort();
    const h = harness();
    await expect(h.executor.execute({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'timeout' });
    expect(h.resolve).not.toHaveBeenCalled();
    const active = new AbortController();
    const transport = vi.fn(async () => { active.abort(); return response(); });
    await expect(harness({ transport }).executor.execute({ ...input, signal: active.signal })).rejects.toMatchObject({ code: 'timeout' });
  }));

  it('handles abort during a failing resolver, late transports and transport timeout codes', () => withInput(async (input) => {
    const active = new AbortController();
    const resolve = async () => { active.abort(); throw new Error('resolver detail'); };
    await expect(harness({ resolve }).executor.execute({ ...input, signal: active.signal })).rejects.toMatchObject({ code: 'timeout' });
    for (const code of ['ETIMEDOUT', 'ABORT_ERR']) {
      await expect(harness({ transport: async () => { throw Object.assign(new Error('unsafe detail'), { code }); } }).executor.execute(input))
        .rejects.toMatchObject({ code: 'timeout', message: 'egress refused: timeout' });
    }
    const lateResponse = response();
    let finish!: (value: PinnedHttpsResponse) => void;
    const pending = new Promise<PinnedHttpsResponse>((resolveLate) => { finish = resolveLate; });
    await expect(harness({ transport: () => pending, totalTimeoutMs: 15 }).executor.execute(input)).rejects.toMatchObject({ code: 'timeout' });
    finish(lateResponse);
    await Promise.resolve();
    expect(lateResponse.close).toHaveBeenCalled();
  }));

  it('only throws fixed EgressRefusal messages for policy decisions', () => {
    const error = new EgressRefusal('url_refused');
    expect(error.message).toBe('egress refused: url_refused'); expect(error.name).toBe('EgressRefusal');
  });
});
