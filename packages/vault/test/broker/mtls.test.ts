import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createConnection } from 'node:net';
import { signAttestation } from '../../src/relay/attestation.js';
import { testCaller } from '../support/kit.js';
import { harness, type Harness } from './support.js';

describe('optional pinned-CA mTLS listener', () => {
  let directory: string;
  let h: Harness;
  const file = (name: string) => join(directory, name);
  function openssl(args: string[]): void {
    execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vault-mtls-h-'));
    // All keys/certificates are ephemeral local test fixtures, generated at runtime.
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.crt'), '-subj', '/CN=vault-test-ca', '-days', '1']);
    for (const name of ['server', 'client']) {
      openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file(`${name}.key`), '-out', file(`${name}.csr`), '-subj', `/CN=vault-test-${name}`]);
      await writeFile(file(`${name}.ext`), name === 'server' ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
      openssl(['x509', '-req', '-in', file(`${name}.csr`), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial',
        '-out', file(`${name}.crt`), '-days', '1', '-extfile', file(`${name}.ext`)]);
    }
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('untrusted.key'), '-out', file('untrusted.crt'), '-subj', '/CN=untrusted-test-ca', '-days', '1']);
    h = await harness({ server: { mtls: { host: '127.0.0.1', port: 0, caFile: file('ca.crt'), keyFile: file('server.key'), certFile: file('server.crt') } } });
  }, 20_000);
  afterAll(async () => { await h?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function send(client: 'client' | 'untrusted' | null): Promise<number> {
    const ca = await readFile(file('ca.crt'));
    const cert = client ? await readFile(file(`${client}.crt`)) : undefined;
    const key = client ? await readFile(file(`${client}.key`)) : undefined;
    const port = (h.server.https!.address() as AddressInfo).port;
    const header = signAttestation({ privateKey: h.pair.privateKey, caller: testCaller, clock: h.clock,
      request: { method: 'GET', path: '/v2/vault/status', query: '', body: Buffer.alloc(0) } });
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/v2/vault/status', ca, key, cert, agent: false,
        headers: { 'x-tm8-vault-caller': header } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.once('error', reject);
      req.end();
    });
  }
  it('accepts a client signed by the pinned CA', async () => { expect(await send('client')).toBe(200); });
  it('requires a client certificate before any HTTP handler runs', async () => { await expect(send(null)).rejects.toThrow(); });
  it('rejects a client outside the pinned CA', async () => { await expect(send('untrusted')).rejects.toThrow(); });
  it('sets bounded headers and timeouts, refusing oversized headers without echoing bytes', async () => {
    expect(h.server.http.maxHeadersCount).toBe(64);
    expect(h.server.http.headersTimeout).toBe(5000);
    expect(h.server.http.requestTimeout).toBe(30_000);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(h.socketPath);
      const chunks: Buffer[] = [];
      socket.once('connect', () => socket.write('GET /v2/vault/status HTTP/1.1\r\nHost: localhost\r\nX-Test: ' + 'A'.repeat(20_000) + '\r\n\r\n'));
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => { socket.destroy(); resolve(Buffer.concat(chunks).toString()); });
      socket.once('error', reject);
    });
    expect(response.startsWith('HTTP/1.1 400')).toBe(true);
    expect(response.includes('A'.repeat(20))).toBe(false);
  });
});
