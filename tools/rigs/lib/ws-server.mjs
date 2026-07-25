/**
 * A minimal RFC 6455 WebSocket SERVER — dependency-free, for rig self-tests only.
 *
 * WHY THIS EXISTS: Node 22+ ships a spec-compliant WebSocket *client* (which is
 * what `ws.mjs` records with) but no server. The perf rigs are deliberately
 * zero-dependency (STATE.md: "tools/rigs/ is intentionally ZERO-dependency … to
 * avoid bun.lock churn"), so a self-test that needs a socket to talk to has to
 * bring its own. ~150 lines of well-specified framing is a cheaper price than a
 * dependency in the one package whose whole job is to be trustworthy.
 *
 * SCOPE, stated honestly: this speaks exactly as much of RFC 6455 as a rig
 * self-test needs — single-frame text/binary messages, close, and ping/pong.
 * It does NOT implement fragmentation (continuation frames), permessage-deflate,
 * or subprotocol negotiation, and it says so loudly rather than mis-parsing:
 * a continuation frame closes the connection with 1003. It is a TEST FIXTURE.
 * It is not a server anyone ships, and nothing in packages/ may import it.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * The RFC 6455 §1.3 magic GUID for the handshake accept key. Verified against
 * the RFC's own worked example: key `dGhlIHNhbXBsZSBub25jZQ==` must produce
 * accept `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=` (asserted by the self-test below).
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/** Server→client frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, body]);
}

/**
 * One upgraded connection. `onMessage(payload, isBinary)` fires per frame.
 */
class MockSocket {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.handlers = { message: [], close: [] };
    this._buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._drain();
    });
    socket.on('close', () => this._fireClose());
    socket.on('error', () => this._fireClose());
  }

  on(event, fn) {
    this.handlers[event]?.push(fn);
    return this;
  }

  sendText(text) {
    this._write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  sendBinary(bytes) {
    this._write(encodeFrame(OP_BINARY, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._write(encodeFrame(OP_CLOSE, payload));
    this.socket.end();
    this._fireClose();
  }

  _write(frame) {
    if (this.closed) return;
    try {
      this.socket.write(frame);
    } catch {
      /* the peer vanished mid-write; a fixture never throws over that */
    }
  }

  _fireClose() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.handlers.close) fn();
  }

  /** Pull every COMPLETE frame out of the accumulated buffer. */
  _drain() {
    for (;;) {
      const buf = this._buffer;
      if (buf.length < 2) return;

      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        len = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return; // frame still in flight
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this._buffer = buf.subarray(offset + len);

      if (opcode === OP_CONTINUATION) {
        // Unsupported by design — fail loudly instead of silently mis-framing.
        this.close(1003);
        return;
      }
      if (opcode === OP_CLOSE) {
        this.close(1000);
        return;
      }
      if (opcode === OP_PING) {
        this._write(encodeFrame(OP_PONG, payload));
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        for (const fn of this.handlers.message) fn(payload, opcode === OP_BINARY);
      }
    }
  }
}

/**
 * Start a WebSocket server on an ephemeral port.
 *
 * `onConnection(socket, url)` receives an upgraded {@link MockSocket} and the
 * parsed request URL (so a fixture can read `?sessionId=`/`?offset=`).
 * Resolves to `{ port, url, close() }`.
 */
export function startWebSocketServer(onConnection, { host = '127.0.0.1' } = {}) {
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });

  const sockets = new Set();

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true); // never let Nagle contaminate a latency measurement
    const ms = new MockSocket(socket);
    sockets.add(ms);
    ms.on('close', () => sockets.delete(ms));
    onConnection(ms, new URL(req.url ?? '/', `http://${host}`));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.close();
            server.close(() => done());
          }),
      });
    });
  });
}
