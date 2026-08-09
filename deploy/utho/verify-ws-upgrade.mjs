#!/usr/bin/env node
/**
 * Secret-safe WebSocket handshake probe. Credentials are read from environment
 * variables and are never printed or placed in a URL.
 *
 * Required: TM8_PROBE_URL=https://tm8.sh
 * Optional event probe: TM8_PROBE_COOKIE='__Host-tm8-session=...'
 * Optional PTY probe: TM8_PROBE_SESSION, TM8_PROBE_MODE, TM8_PROBE_GRANT
 * Optional: TM8_PROBE_ORIGIN (defaults to URL origin)
 */
import { randomBytes } from 'node:crypto';
import { request } from 'node:https';

const base = new URL(process.env.TM8_PROBE_URL ?? '');
if (base.protocol !== 'https:') throw new Error('TM8_PROBE_URL must use https');
const origin = process.env.TM8_PROBE_ORIGIN ?? base.origin;
const session = process.env.TM8_PROBE_SESSION;
const mode = process.env.TM8_PROBE_MODE;
const grant = process.env.TM8_PROBE_GRANT;
const cookie = process.env.TM8_PROBE_COOKIE;
const pty = Boolean(session || mode || grant);
if (pty && (!session || !['view', 'drive'].includes(mode ?? '') || !grant)) {
  throw new Error('PTY probe requires TM8_PROBE_SESSION, TM8_PROBE_MODE=view|drive, and TM8_PROBE_GRANT');
}

const path = pty
  ? `/v2/ws?sessionId=${encodeURIComponent(session)}&mode=${mode}&offset=0`
  : '/v2/ws';
const protocols = pty ? `tm8-pty-v1, tm8-grant.${grant}` : undefined;

const result = await new Promise((resolve, reject) => {
  const req = request(base, {
    method: 'GET',
    path,
    headers: {
      Host: base.host,
      Origin: origin,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(protocols ? { 'Sec-WebSocket-Protocol': protocols } : {}),
    },
  });
  req.once('upgrade', (res, socket) => {
    const selected = res.headers['sec-websocket-protocol'];
    socket.destroy();
    resolve({ status: res.statusCode ?? 101, selected });
  });
  req.once('response', (res) => {
    res.resume();
    res.once('end', () => resolve({ status: res.statusCode ?? 0, selected: undefined }));
  });
  req.once('error', reject);
  req.setTimeout(10_000, () => req.destroy(new Error('probe timeout')));
  req.end();
});

if (result.selected && result.selected !== 'tm8-pty-v1') {
  throw new Error('server selected an unexpected WebSocket subprotocol');
}
process.stdout.write(JSON.stringify(result) + '\n');
