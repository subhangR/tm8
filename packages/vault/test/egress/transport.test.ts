import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodeHttpsTransport, type PinnedHttpsRequest, type PinnedHttpsResponse } from '../../src/egress/index.js';

describe('production node:https transport, with an ephemeral test CA', () => {
  let directory: string;
  let ca: Buffer;
  let certificate: Buffer;
  let privateKey: Buffer;
  let server: HttpsServer;
  let port: number;
  const sockets = new Set<Socket>();
  const requests: { method: string | undefined; host: string | undefined; sni: string | false; body: string; header: string | string[] | undefined }[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vault-egress-tls-'));
    try {
      const run = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
      run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Vault Egress Test CA',
        '-keyout', 'ca-key.pem', '-out', 'ca.pem');
      run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=vault-egress.test', '-keyout', 'leaf-key.pem', '-out', 'leaf.csr');
      await writeFile(join(directory, 'extensions.cnf'), 'subjectAltName=DNS:vault-egress.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
      run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial',
        '-out', 'leaf.pem', '-days', '2', '-extfile', 'extensions.cnf');
      ca = await readFile(join(directory, 'ca.pem'));
      certificate = await readFile(join(directory, 'leaf.pem'));
      privateKey = await readFile(join(directory, 'leaf-key.pem'));
      // The transport's runtime code never writes a file. Only this test does,
      // and the generated private material is removed even if setup fails.
    } finally { await rm(directory, { recursive: true, force: true }); }
    server = createHttpsServer({ key: privateKey, cert: certificate }, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ method: req.method, host: req.headers.host, sni: (req.socket as TLSSocket).servername,
        body: Buffer.concat(chunks).toString(), header: req.headers['x-transport-test'] });
      res.writeHead(200, { 'content-type': 'text/plain' });
      if (req.url === '/stream') res.write('partial');
      else res.end('transport okay');
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    ca?.fill(0); certificate?.fill(0); privateKey?.fill(0);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function input(overrides: Partial<PinnedHttpsRequest> = {}): PinnedHttpsRequest {
    return { url: new URL(`https://vault-egress.test:${port}/checked`), address: { address: '127.0.0.1', family: 4 },
      method: 'POST', headers: { 'x-transport-test': 'passed' }, body: Buffer.from('request okay'),
      connectTimeoutMs: 2000, totalTimeoutMs: 4000, signal: new AbortController().signal, ...overrides };
  }

  async function consume(response: PinnedHttpsResponse): Promise<string> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    } finally { response.close(); }
  }

  it('pins the supplied address, preserves hostname/SNI, verifies the certificate and sends bytes', async () => {
    const res = await nodeHttpsTransport(input(), { ca });
    expect(res.status).toBe(200);
    expect(await consume(res)).toBe('transport okay');
    expect(requests.at(-1)).toEqual({ method: 'POST', host: `vault-egress.test:${port}`, sni: 'vault-egress.test',
      body: 'request okay', header: 'passed' });
  });

  it('refuses a certificate signed by an untrusted CA with a sanitized typed error', async () => {
    await expect(nodeHttpsTransport(input())).rejects.toMatchObject({ code: 'upstream_unreachable', message: 'egress refused: upstream_unreachable' });
  });

  it('verifies the hostname rather than trusting the pinned address alone', async () => {
    await expect(nodeHttpsTransport(input({ url: new URL(`https://other-name.test:${port}/checked`) }), { ca }))
      .rejects.toMatchObject({ code: 'upstream_unreachable', message: 'egress refused: upstream_unreachable' });
  });

  it('ignores proxy environment variables and uses a fresh connection each time', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1'); vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1');
    try {
      const first = await nodeHttpsTransport(input(), { ca });
      await consume(first);
      const second = await nodeHttpsTransport(input(), { ca });
      expect(await consume(second)).toBe('transport okay');
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps the total timeout active through response-body consumption', async () => {
    const res = await nodeHttpsTransport(input({ url: new URL(`https://vault-egress.test:${port}/stream`), totalTimeoutMs: 100 }), { ca });
    await expect(consume(res)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('aborts an in-flight response body with timeout and cleans up the socket', async () => {
    const controller = new AbortController();
    const res = await nodeHttpsTransport(input({ url: new URL(`https://vault-egress.test:${port}/stream`), signal: controller.signal }), { ca });
    const pending = consume(res);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(res.body.destroyed).toBe(true);
  });

  it('refuses an already-aborted request without sending anything', async () => {
    const controller = new AbortController(); controller.abort();
    const before = requests.length;
    await expect(nodeHttpsTransport(input({ signal: controller.signal }), { ca })).rejects.toMatchObject({ code: 'timeout' });
    expect(requests).toHaveLength(before);
  });

  it('uses a connect deadline that covers the TLS handshake', async () => {
    const stalledSockets = new Set<Socket>();
    const tcp = createTcpServer((socket) => { stalledSockets.add(socket); socket.on('close', () => stalledSockets.delete(socket)); });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    try {
      const stalledPort = (tcp.address() as AddressInfo).port;
      await expect(nodeHttpsTransport(input({ url: new URL(`https://vault-egress.test:${stalledPort}/`), connectTimeoutMs: 40 }), { ca }))
        .rejects.toMatchObject({ code: 'timeout' });
    } finally {
      for (const socket of stalledSockets) socket.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  });
});
