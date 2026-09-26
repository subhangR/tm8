/**
 * W10c / R9 — the PTY server closes OPEN sockets a private credential no longer
 * admits. The attach is decided once, at the upgrade; `recheckCredentialStreams`
 * is the re-ask W10b's switch-to-private/revoke path and main.ts's sweep call.
 * The SQL answer itself is proven in test/db/credential-attach-gate.pg.test.ts;
 * this pins what the server does with it: close refused subjects with 1008,
 * ask once per (session, subject), and leave a socket open when the check fails.
 */
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '@tm8/execution';

import { createCredentialStreamSweepJob, createPtyWsServer } from '../src/pty/index.js';

const CWD = process.cwd();
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  setNoDelay(): this {
    return this;
  }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  /** The close code of the server's close frame, or null if it sent none. */
  closeCode(): number | null {
    const raw = Buffer.concat(this.chunks);
    const sep = raw.indexOf('\r\n\r\n');
    let buf = sep >= 0 ? raw.subarray(sep + 4) : raw;
    while (buf.length >= 2) {
      const opcode = buf.readUInt8(0) & 0x0f;
      const len7 = buf.readUInt8(1) & 0x7f;
      const offset = len7 === 126 ? 4 : len7 === 127 ? 10 : 2;
      const length = len7 === 126 ? buf.readUInt16BE(2) : len7 === 127 ? Number(buf.readBigUInt64BE(2)) : len7;
      if (opcode === 0x8) return buf.readUInt16BE(offset);
      buf = buf.subarray(offset + length);
    }
    return null;
  }
}

/** One masked client->server binary frame (RFC 6455 §5.3: clients always mask). */
function clientBinary(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x82, 0x80 | data.length]), mask, masked]);
}

function upgradeReq(sessionId: string, subject?: string): IncomingMessage {
  return {
    url: `/v2/ws?sessionId=${sessionId}&offset=0`,
    headers: {
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...(subject ? { 'x-test-subject': subject } : {}),
    },
  } as unknown as IncomingMessage;
}

describe('PtyWsServer.recheckCredentialStreams (R9)', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
  });

  it('closes every socket of a refused subject with 1008, asks once per subject, and leaves the admitted, the unknown and the errored open', async () => {
    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-rc', command: 'sleep 10', cwd: CWD, env: {} });
    const recheck = vi.fn(async (_sessionId: string, subject: string) => {
      if (subject === 'w10c-errors') throw new Error('db unavailable');
      return subject === 'w10c-owner';
    });
    const server = createPtyWsServer({
      pty: host,
      logger: quiet,
      authorize: async (req) => {
        const subject = req.headers['x-test-subject'];
        return { ok: true, canDrive: true, ...(typeof subject === 'string' ? { subjectIdentity: subject } : {}) };
      },
      credentialRecheck: recheck,
    });
    const sockets = {
      member1: new FakeSocket(),
      member2: new FakeSocket(),
      owner: new FakeSocket(),
      errored: new FakeSocket(),
      unnamed: new FakeSocket(),
    };
    await server.handleUpgrade(upgradeReq('s-rc', 'w10c-member'), sockets.member1, Buffer.alloc(0));
    await server.handleUpgrade(upgradeReq('s-rc', 'w10c-member'), sockets.member2, Buffer.alloc(0));
    await server.handleUpgrade(upgradeReq('s-rc', 'w10c-owner'), sockets.owner, Buffer.alloc(0));
    await server.handleUpgrade(upgradeReq('s-rc', 'w10c-errors'), sockets.errored, Buffer.alloc(0));
    await server.handleUpgrade(upgradeReq('s-rc'), sockets.unnamed, Buffer.alloc(0));
    expect(server.connectionCount()).toBe(5);

    expect(await server.recheckCredentialStreams(['s-rc'])).toBe(2);

    expect(sockets.member1.closeCode()).toBe(1008);
    expect(sockets.member2.closeCode()).toBe(1008);
    expect(sockets.owner.closeCode()).toBeNull();
    expect(sockets.errored.closeCode()).toBeNull();
    expect(sockets.unnamed.closeCode()).toBeNull();
    // One question per (session, subject); 'authenticated' is never asked about.
    expect(recheck.mock.calls.map(([, subject]) => subject).sort()).toEqual(['w10c-errors', 'w10c-member', 'w10c-owner']);

    // A closed socket still in its handshake types into nothing; the owner still drives.
    const write = vi.spyOn(host, 'write');
    sockets.member1.push(clientBinary('refused'));
    sockets.owner.push(clientBinary('admitted'));
    await new Promise((r) => setTimeout(r, 50));
    expect(write.mock.calls.map(([, data]) => Buffer.from(data as Buffer).toString('utf8'))).toEqual(['admitted']);

    // A later sweep neither re-counts nor re-asks about a socket it already closed.
    recheck.mockClear();
    expect(await server.recheckCredentialStreams()).toBe(0);
    expect(recheck.mock.calls.map(([, subject]) => subject)).not.toContain('w10c-member');
  });

  it('PAIRED POSITIVE: without a configured recheck nothing is closed', async () => {
    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-rc2', command: 'sleep 10', cwd: CWD, env: {} });
    const server = createPtyWsServer({
      pty: host,
      logger: quiet,
      authorize: async () => ({ ok: true, canDrive: true, subjectIdentity: 'w10c-member' }),
    });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('s-rc2'), sock, Buffer.alloc(0));
    expect(await server.recheckCredentialStreams()).toBe(0);
    expect(sock.closeCode()).toBeNull();
  });

  it('the sweep job reports what it closed, and skips when nothing was refused', async () => {
    const streams = { recheckCredentialStreams: vi.fn(async () => 0) };
    const job = createCredentialStreamSweepJob({ streams });
    const ctx = () => ({ name: job.name, firedAt: new Date(), logger: quiet, signal: new AbortController().signal }) as unknown as Parameters<typeof job.run>[0];
    expect(job.runOnStart).toBe(false);
    expect(await job.run(ctx())).toMatchObject({ skipped: true });
    streams.recheckCredentialStreams.mockResolvedValueOnce(3);
    expect(await job.run(ctx())).toEqual({ affected: 3 });
    expect(streams.recheckCredentialStreams).toHaveBeenCalledWith();
  });
});
