#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const baseUrl = requiredUrl('TM8_BROWSER_PROBE_URL');
const sessionToken = required('TM8_BROWSER_SESSION_TOKEN');
const workSessionId = required('TM8_BROWSER_SESSION_ID');
const spaceId = required('TM8_BROWSER_SPACE_ID');

if (baseUrl.protocol !== 'https:') fail('probe URL must use https');

const origin = baseUrl.origin;
const cookie = `__Host-tm8-session=${sessionToken}`;
const wsBase = new URL(baseUrl);
wsBase.protocol = 'wss:';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  let parsed;
  try {
    parsed = new URL(required(name));
  } catch {
    fail(`${name} must be an absolute URL`);
  }
  return parsed;
}

function fail(message) {
  throw new Error(message);
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms).unref();
  });
}

async function openEventStream(since) {
  const url = new URL('/v2/ws', wsBase);
  const ws = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie } });
  let refused = false;
  let highestSeq = since;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const frame = JSON.parse(data.toString());
      if (frame?.type === 'control.refused') refused = true;
      const seq = Number(frame?.seq);
      if (Number.isSafeInteger(seq)) highestSeq = Math.max(highestSeq, seq);
    } catch {
      // The event lane is JSON-only, but malformed data is handled below as a
      // failed connection rather than ever echoed to stdout.
      refused = true;
    }
  });

  await Promise.race([
    new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', () => reject(new Error('event websocket failed to open')));
      ws.once('unexpected-response', (_request, response) => {
        reject(new Error(`event websocket upgrade returned ${response.statusCode ?? 'unknown'}`));
      });
    }),
    timeout(10_000, 'event websocket open timed out'),
  ]);

  ws.send(JSON.stringify({ type: 'subscribe', spaceIds: [spaceId] }));
  ws.send(JSON.stringify({ type: 'resume', spaceId, since }));
  await Promise.race([
    new Promise((resolve) => setTimeout(resolve, 900)),
    timeout(2_000, 'event resume observation timed out'),
  ]);
  if (refused) fail('event subscribe or resume was refused');
  await close(ws);
  return highestSeq;
}

async function mintGrant() {
  const url = new URL(`/v2/entities/${encodeURIComponent(workSessionId)}/commands/streams-attach`, baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'drive', clientMutationId: randomUUID() }),
  });
  if (!response.ok) fail(`PTY grant request returned ${response.status}`);
  const envelope = await response.json();
  const grant = envelope?.data ?? envelope;
  if (grant?.protocol !== 'ws' || typeof grant?.url !== 'string' || typeof grant?.token !== 'string') {
    fail('PTY grant response was malformed');
  }
  if (!grant.token.startsWith('tm8g_')) fail('PTY grant token had an unexpected form');
  if (grant.url.includes(grant.token)) fail('PTY grant leaked into its URL');
  return grant;
}

async function attachPty(grant, offset) {
  const url = new URL(grant.url, wsBase);
  if (url.protocol !== 'wss:' || url.origin !== wsBase.origin) {
    fail('PTY grant did not resolve to the expected TLS origin');
  }
  url.searchParams.set('offset', String(offset));

  const ws = new WebSocket(url, ['tm8-pty-v1', `tm8-grant.${grant.token}`], {
    headers: { Origin: origin, Cookie: cookie },
  });

  const attached = await Promise.race([
    new Promise((resolve, reject) => {
      ws.once('error', () => reject(new Error('PTY websocket failed')));
      ws.once('unexpected-response', (_request, response) => {
        reject(new Error(`PTY websocket upgrade returned ${response.statusCode ?? 'unknown'}`));
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (frame?.type === 'attached') resolve(frame);
        if (frame?.type === 'exit') reject(new Error('PTY exited before attach completed'));
      });
    }),
    timeout(15_000, 'PTY attach timed out'),
  ]);

  if (ws.protocol !== 'tm8-pty-v1') fail('server selected an unexpected PTY protocol');
  if (!Number.isSafeInteger(attached.next) || attached.next < 0) fail('PTY attached frame had no valid cursor');
  await close(ws);
  return attached;
}

async function close(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await Promise.race([
    new Promise((resolve) => {
      ws.once('close', resolve);
      ws.close(1000, 'probe complete');
    }),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

const firstEventCursor = await openEventStream(0);
await openEventStream(firstEventCursor);

const firstGrant = await mintGrant();
const firstAttach = await attachPty(firstGrant, 0);
const secondGrant = await mintGrant();
if (firstGrant.token === secondGrant.token) fail('PTY reconnect did not receive a fresh grant');
const secondAttach = await attachPty(secondGrant, firstAttach.next);

if (secondAttach.next < firstAttach.next) fail('PTY reconnect cursor moved backwards');
if (firstAttach.epoch && secondAttach.epoch && firstAttach.epoch !== secondAttach.epoch) {
  fail('PTY epoch changed across reconnect');
}

console.log(JSON.stringify({
  ok: true,
  tlsOrigin: true,
  eventConnections: 2,
  eventResumes: 2,
  ptyConnections: 2,
  freshPtyGrants: true,
  selectedPublicPtyProtocol: 2,
  ptyCursorNonRewind: true,
}));
