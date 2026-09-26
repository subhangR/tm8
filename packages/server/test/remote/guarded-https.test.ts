/**
 * W8 — the guarded outbound client (T27, a2/a3) and the forwarder's hard-coded
 * refusal (lead ruling 09:12Z (e)).
 *
 * The guard is exercised for real: `resolve` only stands in for DNS, and the
 * test transport only moves the socket from the pinned public address to a
 * local HTTPS stub AFTER the guard has admitted the address (the address
 * policy itself is not injectable). Every refusal is paired with a positive
 * through the same client.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest, type RequestOptions, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardedHttpsRequest, type HttpsTransport } from '../../src/remote/guarded-https.js';
import { DisabledRemoteInvokeForwarder } from '../../src/remote/forwarder.js';

const PUBLIC = { address: '93.184.216.34', family: 4 as const };
const HOST = 'remote.example';

let cert: string;
let key: string;
let stub: HttpsServer;
let stubPort: number;
let silent: NetServer;
let silentPort: number;
const silentSockets: Socket[] = [];
let closedPort: number;

function listen(server: NetServer | HttpsServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Records what the guard handed the transport, then connects to `port` on loopback. */
function transportTo(port: number, seen: RequestOptions[], trust = true): HttpsTransport {
  return (options) => {
    seen.push(options);
    return httpsRequest({ ...options, hostname: '127.0.0.1', port, lookup: undefined, ...(trust ? { ca: cert } : {}) });
  };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-guarded-https-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST}`,
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ], { stdio: 'ignore' });
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  key = readFileSync(join(dir, 'key.pem'), 'utf8');

  stub = createHttpsServer({ cert, key }, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://127.0.0.1/' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  stubPort = await listen(stub);

  // Accepts and says nothing: a hung target.
  silent = createNetServer((socket) => { silentSockets.push(socket); });
  silentPort = await listen(silent);

  const probe = createNetServer();
  closedPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  for (const socket of silentSockets) socket.destroy();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

describe('T27 — a loopback-only or private target is unreachable, and nothing is sent', () => {
  it('refuses a loopback literal, a host resolving to loopback, and one private answer among public ones', async () => {
    const seen: RequestOptions[] = [];
    const transport = transportTo(stubPort, seen);
    expect(await guardedHttpsRequest({ url: `https://127.0.0.1:${stubPort}/health`, method: 'GET' }, { transport }))
      .toEqual({ kind: 'unreachable', reason: 'non_public_address' });
    expect(await guardedHttpsRequest({ url: 'https://[::1]/health', method: 'GET' }, { transport }))
      .toEqual({ kind: 'unreachable', reason: 'non_public_address' });
    expect(await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET' },
      { transport, resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
    )).toEqual({ kind: 'unreachable', reason: 'non_public_address' });
    expect(await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET' },
      { transport, resolve: async () => [PUBLIC, { address: '10.0.0.8', family: 4 }] },
    )).toEqual({ kind: 'unreachable', reason: 'non_public_address' });
    expect(seen).toHaveLength(0);
  });

  it('refuses http:, embedded credentials, a bad URL and a failed resolve; nothing is sent', async () => {
    const seen: RequestOptions[] = [];
    const transport = transportTo(stubPort, seen);
    const resolve = async () => [PUBLIC];
    expect(await guardedHttpsRequest({ url: `http://${HOST}/health`, method: 'GET' }, { transport, resolve }))
      .toEqual({ kind: 'unreachable', reason: 'invalid_url' });
    expect(await guardedHttpsRequest({ url: `https://u:p@${HOST}/health`, method: 'GET' }, { transport, resolve }))
      .toEqual({ kind: 'unreachable', reason: 'invalid_url' });
    expect(await guardedHttpsRequest({ url: 'not a url', method: 'GET' }, { transport, resolve }))
      .toEqual({ kind: 'unreachable', reason: 'invalid_url' });
    expect(await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET' },
      { transport, resolve: async () => { throw new Error('ENOTFOUND'); } },
    )).toEqual({ kind: 'unreachable', reason: 'dns' });
    expect(seen).toHaveLength(0);
  });

  it('POSITIVE: a public-resolving HTTPS host is admitted, pinned to the checked address, and answers', async () => {
    const seen: RequestOptions[] = [];
    const result = await guardedHttpsRequest(
      { url: `https://${HOST}/health?x=1`, method: 'GET' },
      { transport: transportTo(stubPort, seen), resolve: async () => [PUBLIC] },
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ method: 'GET', url: '/health?x=1' });

    // Pinned: whatever name the socket layer asks about, it gets the checked address.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.servername).toBe(HOST);
    const answers: Array<[string, number]> = [];
    seen[0]!.lookup!('rebound.example', {}, ((_err: unknown, address: string, family: number) => {
      answers.push([address, family]);
    }) as never);
    expect(answers).toEqual([[PUBLIC.address, 4]]);
  });

  it('an untrusted certificate is unreachable (tls); POSITIVE: the same stub trusted answers', async () => {
    const resolve = async () => [PUBLIC];
    expect(await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET' },
      { transport: transportTo(stubPort, [], false), resolve },
    )).toEqual({ kind: 'unreachable', reason: 'tls' });
    expect((await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET' },
      { transport: transportTo(stubPort, []), resolve },
    )).kind).toBe('response');
  });
});

describe('a3 — a downed target is offline, and the call fails within the timeout', () => {
  it('connection refused is offline at once', async () => {
    const started = Date.now();
    const result = await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET', timeoutMs: 2_000 },
      { transport: transportTo(closedPort, []), resolve: async () => [PUBLIC] },
    );
    expect(result).toEqual({ kind: 'offline', reason: 'connect_refused' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a silent listener is offline (timeout) inside the budget', async () => {
    const started = Date.now();
    const result = await guardedHttpsRequest(
      { url: `https://${HOST}/health`, method: 'GET', timeoutMs: 400 },
      { transport: transportTo(silentPort, []), resolve: async () => [PUBLIC] },
    );
    const elapsed = Date.now() - started;
    expect(result).toEqual({ kind: 'offline', reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('what leaves the node', () => {
  it('only allow-listed headers are sent; authorization and the body pass', async () => {
    const result = await guardedHttpsRequest(
      {
        url: `https://${HOST}/v2/x`,
        method: 'POST',
        headers: { Authorization: 'Bearer test-not-a-token', cookie: 'tm8_session=nope', 'x-forwarded-for': '10.0.0.1', 'content-type': 'application/json' },
        body: '{"a":1}',
      },
      { transport: transportTo(stubPort, []), resolve: async () => [PUBLIC] },
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const echoed = JSON.parse(result.body) as { headers: Record<string, string>; body: string };
    expect(echoed.headers['authorization']).toBe('Bearer test-not-a-token');
    expect(echoed.headers['cookie']).toBeUndefined();
    expect(echoed.headers['x-forwarded-for']).toBeUndefined();
    expect(echoed.body).toBe('{"a":1}');
  });

  it('a redirect is returned, never followed', async () => {
    const seen: RequestOptions[] = [];
    const result = await guardedHttpsRequest(
      { url: `https://${HOST}/redirect`, method: 'GET' },
      { transport: transportTo(stubPort, seen), resolve: async () => [PUBLIC] },
    );
    expect(result).toMatchObject({ kind: 'response', status: 302 });
    expect(seen).toHaveLength(1);
  });
});

describe('the forwarder refuses (lead ruling 09:12Z (e))', () => {
  it('forward() returns remote_links_disabled, and no switch reaches past it', async () => {
    const result = await new DisabledRemoteInvokeForwarder().forward({
      claims: { identityId: 'x', requestId: 'r' } as never,
      linkId: 'l', serverId: 's', op: 'entities.get', input: {}, via: ['a'],
    });
    expect(result).toEqual({ kind: 'disabled', reason: 'remote_links_disabled' });
    const source = readFileSync(new URL('../../src/remote/forwarder.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/process\.env|ENABLED|import\.meta\.env/);
  });
});
