import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { signAttestation } from '../../src/relay/attestation.js';
import { publicKeySha256 } from '../../src/relay/retired-keys.js';
import { createBrokerServer } from '../../src/broker/server.js';
import { testBroker, testCaller } from '../support/kit.js';
import { harness, stubHandlers, type Harness } from './support.js';

/** SHA-256 over the certificate's DER, the value TM8_VAULT_RELAY_CLIENT_CERT_SHA256 holds. */
const pinOf = (pem: Buffer): Buffer => createHash('sha256').update(new X509Certificate(pem).raw).digest();

describe('optional mTLS listener: the pinned CA and the pinned relay certificate (review F03)', () => {
  let directory: string;
  let h: Harness;
  const refused: { fingerprint: string | null; retired?: true }[] = [];
  const requests: unknown[] = [];
  const file = (name: string) => join(directory, name);
  function openssl(args: string[]): void {
    execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vault-mtls-h-'));
    // All keys/certificates are ephemeral local test fixtures, generated at runtime.
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.crt'), '-subj', '/CN=vault-test-ca', '-days', '1']);
    // `other` is a second client certificate from the same CA: it passes the CA, not the pin.
    for (const name of ['server', 'client', 'other']) {
      openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', file(`${name}.key`), '-out', file(`${name}.csr`), '-subj', `/CN=vault-test-${name}`]);
      await writeFile(file(`${name}.ext`), name === 'server' ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
      openssl(['x509', '-req', '-in', file(`${name}.csr`), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial',
        '-out', file(`${name}.crt`), '-days', '1', '-extfile', file(`${name}.ext`)]);
    }
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('untrusted.key'), '-out', file('untrusted.crt'), '-subj', '/CN=untrusted-test-ca', '-days', '1']);
    const pin = pinOf(await readFile(file('client.crt')));
    h = await harness({ server: {
      mtls: { host: '127.0.0.1', port: 0, caFile: file('ca.crt'), keyFile: file('server.key'), certFile: file('server.crt'), clientCertSha256: pin },
      onRefusedPeer: (peer) => refused.push(peer), log: (record) => requests.push(record),
    } });
    // The broker keeps its own copy, so every test below also shows a later change to this buffer is ignored.
    pin.fill(0);
  }, 20_000);
  afterAll(async () => { await h?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function send(client: 'client' | 'other' | 'untrusted' | null, to: Harness = h): Promise<number> {
    const ca = await readFile(file('ca.crt'));
    const cert = client ? await readFile(file(`${client}.crt`)) : undefined;
    const key = client ? await readFile(file(`${client}.key`)) : undefined;
    const port = (to.server.https!.address() as AddressInfo).port;
    const header = signAttestation({ privateKey: to.pair.privateKey, caller: testCaller, clock: to.clock,
      request: { method: 'GET', path: '/v2/vault/status', query: '', body: Buffer.alloc(0) } });
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/v2/vault/status', ca, key, cert, agent: false,
        headers: { 'x-tm8-vault-caller': header } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.once('error', reject);
      req.end();
    });
  }
  it('accepts the pinned relay certificate', async () => { expect(await send('client')).toBe(200); });
  it('requires a client certificate before any HTTP handler runs', async () => { await expect(send(null)).rejects.toThrow(); });
  it('rejects a client outside the pinned CA', async () => { await expect(send('untrusted')).rejects.toThrow(); });
  it('closes a certificate the same CA issued that is not the pinned one, before any handler runs', async () => {
    const before = { refused: h.server.refusedPeers, requests: requests.length, failures: [...h.server.attestationFailures] };
    // The request carries a valid attestation: only the certificate is wrong.
    await expect(send('other')).rejects.toThrow();
    expect(h.server.refusedPeers).toBe(before.refused + 1);
    expect(refused.at(-1)).toEqual({ fingerprint: pinOf(await readFile(file('other.crt'))).toString('hex') });
    // No handler ran: no request was logged and no attestation was even checked.
    expect(requests.length).toBe(before.requests);
    expect([...h.server.attestationFailures]).toEqual(before.failures);
    // The refusal closes one connection only; the relay's next request is served.
    expect(await send('client')).toBe(200);
    expect(requests.length).toBe(before.requests + 1);
  });
  it('drops requests that arrive with the handshake on a refused connection: no handler, no response, no throw', async () => {
    const before = { refused: h.server.refusedPeers, requests: requests.length };
    const header = signAttestation({ privateKey: h.pair.privateKey, caller: testCaller, clock: h.clock,
      request: { method: 'GET', path: '/v2/vault/status', query: '', body: Buffer.alloc(0) } });
    const request = `GET /v2/vault/status HTTP/1.1\r\nHost: 127.0.0.1\r\nx-tm8-vault-caller: ${header}\r\n\r\n`;
    const [ca, cert, key] = await Promise.all(['ca.crt', 'other.crt', 'other.key'].map((name) => readFile(file(name))));
    const received = await new Promise<Buffer>((resolve) => {
      const socket = tlsConnect({ host: '127.0.0.1', port: (h.server.https!.address() as AddressInfo).port, ca, cert, key });
      // Written before the handshake ends, so two keep-alive requests ride with the client's last flight.
      socket.write(request + request);
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('error', () => undefined);
      socket.once('close', () => resolve(Buffer.concat(chunks)));
    });
    expect(received.length).toBe(0);
    expect(h.server.refusedPeers).toBe(before.refused + 1);
    expect(requests.length).toBe(before.requests);
  });
  it('review F03, B2: closes the pinned certificate when its key is retired, as with a pin left stale at a key rotation', async () => {
    const clientPem = await readFile(file('client.crt'));
    const seen: { fingerprint: string | null; retired?: true }[] = [];
    const logged: unknown[] = [];
    const stale = await harness({ server: {
      mtls: { host: '127.0.0.1', port: 0, caFile: file('ca.crt'), keyFile: file('server.key'), certFile: file('server.crt'), clientCertSha256: pinOf(clientPem) },
      retiredRelayKeys: new Set([publicKeySha256(new X509Certificate(clientPem).publicKey)]),
      onRefusedPeer: (peer) => seen.push(peer), log: (record) => logged.push(record),
    } });
    try {
      // The request carries a valid attestation and the pinned certificate: only its key is retired.
      await expect(send('client', stale)).rejects.toThrow();
      expect(stale.server.refusedPeers).toBe(1);
      expect(seen).toEqual([{ fingerprint: pinOf(clientPem).toString('hex'), retired: true }]);
      expect(logged).toEqual([]);
      expect([...stale.server.attestationFailures]).toEqual([]);
      // A certificate the pin refuses anyway is not reported as retired.
      await expect(send('other', stale)).rejects.toThrow();
      expect(seen.at(-1)).toEqual({ fingerprint: pinOf(await readFile(file('other.crt'))).toString('hex') });
      expect(logged).toEqual([]);
    } finally {
      await stale.close();
    }
  });
  it('review F03, B2: admits the pinned certificate when other keys are listed, and keeps its own copy of the list', async () => {
    const clientPem = await readFile(file('client.crt'));
    const retired = new Set(['ab'.repeat(32)]);
    const listed = await harness({ server: {
      mtls: { host: '127.0.0.1', port: 0, caFile: file('ca.crt'), keyFile: file('server.key'), certFile: file('server.crt'), clientCertSha256: pinOf(clientPem) },
      retiredRelayKeys: retired,
    } });
    try {
      expect(await send('client', listed)).toBe(200);
      retired.add(publicKeySha256(new X509Certificate(clientPem).publicKey));
      expect(await send('client', listed)).toBe(200);
      expect(listed.server.refusedPeers).toBe(0);
    } finally {
      await listed.close();
    }
  });
  it('refuses to create a listener without a 32-byte pin, before it reads any file', async () => {
    const broker = testBroker();
    try {
      for (const clientCertSha256 of [Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(0), 'a'.repeat(64) as unknown as Buffer, undefined as unknown as Buffer]) {
        await expect(createBrokerServer({ ...broker, handlers: stubHandlers(), socketPath: file('never.sock'), relayPublicKeyFile: file('absent.pub'),
          mtls: { host: '127.0.0.1', port: 0, caFile: file('absent'), keyFile: file('absent'), certFile: file('absent'), clientCertSha256 } }))
          .rejects.toThrow(new TypeError('vault broker: invalid mtls.clientCertSha256'));
      }
    } finally {
      await broker.store.close();
      broker.components.captureKeys.destroy();
    }
  });
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
