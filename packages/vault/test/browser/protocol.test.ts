import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretMaterial, zeroize } from '../../src/secret-material.js';
import { FrameReader, MAX_REQUEST_BYTES, decodeOutcome, encodeJsonFrame, encodeOutcome, parseRequest } from '../../src/browser/protocol.js';
import { RemoteFillDriver } from '../../src/browser/remote-driver.js';

const intent = { operationId: 'test-operation', itemId: 'test-item', origin: 'https://github.com', submit: false, devMode: false };

describe('private fill protocol', () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function mock(reply: (id: string, op: string) => Buffer | null) {
    const directory = await mkdtemp(join(tmpdir(), 'vault-protocol-'));
    const socketPath = join(directory, 'fill.sock');
    const server: Server = createServer((socket) => {
      const reader = new FrameReader(MAX_REQUEST_BYTES, (body) => {
        try {
          const request = parseRequest(body);
          const output = reply(request.id, request.op);
          if (output) socket.end(output, () => zeroize(output));
        } finally { zeroize(body); }
      });
      socket.on('data', (chunk) => { try { reader.push(chunk); } catch { socket.destroy(); } });
      socket.on('error', () => {});
      socket.on('close', () => reader.dispose());
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return socketPath;
  }

  it('accepts fragmented frames and wipes input chunks and header/body buffers', () => {
    let received: Buffer | null = null;
    const reader = new FrameReader(100, (body) => { received = body; });
    const outgoing = encodeJsonFrame({ id: 'test', op: 'health' });
    try {
      for (const octet of outgoing) {
        const chunk = Buffer.from([octet]);
        reader.push(chunk);
        expect(chunk.every((value) => value === 0)).toBe(true);
      }
      expect(received !== null).toBe(true);
      expect(parseRequest(received!).op).toBe('health');
    } finally { zeroize(outgoing, received); reader.dispose(); }
  });

  it('rejects oversized and trailing frames without retaining chunks', () => {
    const reader = new FrameReader(10, () => {});
    const chunk = Buffer.alloc(4); chunk.writeUInt32BE(11);
    try { expect(() => reader.push(chunk)).toThrow('invalid worker frame'); expect(chunk.every((x) => x === 0)).toBe(true); }
    finally { reader.dispose(); }
    const trailingReader = new FrameReader(100, () => { throw new Error('must not dispatch a trailing frame'); });
    const valid = encodeJsonFrame({ id: 'test', op: 'health' });
    const combined = Buffer.concat([valid, Buffer.from([0])]);
    try { expect(() => trailingReader.push(combined)).toThrow('invalid worker frame'); expect(combined.every((x) => x === 0)).toBe(true); }
    finally { zeroize(valid, combined); trailingReader.dispose(); }
  });

  it.each([
    { id: 'test', op: 'fill', intent: { ...intent, selector: '#password' }, username: null, password_b64: 'YQ==' },
    { id: 'test', op: 'fill', intent, username: null, password_b64: 'not-base64' },
    { id: 'test', op: 'health', action: 'cookies' },
    { op: 'health' },
  ])('rejects malformed or extended requests', (request) => {
    const body = Buffer.from(JSON.stringify(request));
    try { expect(() => parseRequest(body)).toThrow('invalid worker request'); } finally { zeroize(body); }
  });

  it('does not decode health as a successful fill', () => {
    const body = Buffer.from(JSON.stringify({ id: 'test', op: 'health', ok: true, ready: true }));
    try { expect(decodeOutcome(body, 'test')).toEqual({ ok: false, code: 'browser_unavailable', observedOrigin: null, screenshot: null }); }
    finally { zeroize(body); }
  });

  it.each(['testOnlyDisableSandbox', 'testOnlySingleProcess'])('refuses socket test switch %s by fixed name, without its value', (name) => {
    const body = Buffer.from(JSON.stringify({ id: 'test', op: 'health', [name]: 'must-never-be-printed' }));
    try {
      let message = '';
      try { parseRequest(body); } catch (error) { message = (error as Error).message; }
      expect(message).toBe(`vault fill worker refused: ${name}`);
      expect(message.includes('must-never-be-printed')).toBe(false);
    } finally { zeroize(body); }
  });

  it.each(['wrong-id', 'wrong-op', 'empty-origin'])('fails closed on %s', async (mode) => {
    const socketPath = await mock((id) => mode === 'wrong-id' ? encodeOutcome('other', { ok: true, finalOrigin: intent.origin, submitted: false, screenshot: null }) :
      mode === 'wrong-op' ? encodeJsonFrame({ id, op: 'health', ok: true, ready: true }) :
      encodeOutcome(id, { ok: true, finalOrigin: '', submitted: false, screenshot: null }));
    const driver = new RemoteFillDriver(socketPath);
    const password = SecretMaterial.fromUtf8(['fixture', randomUUID()].join('-'));
    try {
      const outcome = await driver.fill({ intent, material: { username: null, password, totp: null } });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('browser_unavailable');
      expect(password.disposed).toBe(false);
    } finally { password.dispose(); await driver.close(); }
  });

  it('accepts a matching fill response and keeps material caller-owned', async () => {
    const socketPath = await mock((id) => encodeOutcome(id, { ok: true, finalOrigin: intent.origin, submitted: false, screenshot: null }));
    const driver = new RemoteFillDriver(socketPath);
    const password = SecretMaterial.fromUtf8(['fixture', randomUUID()].join('-'));
    try {
      const outcome = await driver.fill({ intent, material: { username: null, password, totp: null } });
      expect(outcome).toEqual({ ok: true, finalOrigin: intent.origin, submitted: false, screenshot: null });
      expect(password.disposed).toBe(false);
    } finally { password.dispose(); await driver.close(); }
  });

  it('bounds a nonresponding worker and supports abort without a secret-bearing error', async () => {
    const socketPath = await mock(() => null);
    const driver = new RemoteFillDriver(socketPath, { timeoutMs: 20 });
    const password = SecretMaterial.fromUtf8(['fixture', randomUUID()].join('-'));
    try {
      const outcome = await driver.fill({ intent, material: { username: null, password, totp: null } });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('timeout');
      const controller = new AbortController(); controller.abort();
      const aborted = await driver.fill({ intent, material: { username: null, password, totp: null }, signal: controller.signal });
      expect(aborted.ok).toBe(false);
      if (!aborted.ok) expect(aborted.code).toBe('timeout');
    } finally { password.dispose(); await driver.close(); }
  });

  it('exposes only fill and close capabilities', () => {
    expect(Object.getOwnPropertyNames(RemoteFillDriver.prototype).sort()).toEqual(['close', 'constructor', 'fill']);
  });
});
