#!/usr/bin/env node
/**
 * Signed-in browser proof for the Utho event and PTY WebSockets.
 *
 * Secrets enter only through environment variables and the browser's login
 * form. This program never prints a password, cookie value, bearer, PTY grant,
 * WebSocket protocol offer, work-session id, or URL query string.
 *
 * Required:
 *   TM8_BROWSER_PROBE_URL=https://tm8.sh
 *   TM8_BROWSER_USERNAME=...
 *   TM8_BROWSER_PASSWORD=...
 *
 * Optional PTY proof:
 *   TM8_BROWSER_SESSION_ID=<live work-session uuid>
 *   TM8_BROWSER_REQUIRE_OFFSET_ADVANCE=0  # default 1 when a session is given
 *
 * Optional browser selection:
 *   TM8_BROWSER_CHANNEL=chrome|chromium   # default chrome
 *   TM8_BROWSER_HEADLESS=0                # default 1
 *
 * Run only against a designated account/session inside an approved cutover
 * window. Login and PTY grant minting create revocable database rows. The
 * browser session is signed out in cleanup whenever the UI remains reachable.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const WS_PATH = '/v2/ws';
const SESSION_COOKIE = '__Host-tm8-session';
const CREDENTIAL_QUERY_NAMES = new Set([
  'access_token',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'grant',
  'password',
  'session',
  'session_token',
  'token',
]);
const PTY_QUERY_NAMES = new Set(['sessionId', 'mode', 'offset']);
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(message) {
  throw new Error(`authenticated browser stream proof refused: ${message}`);
}

/** Classify without returning any query value that could reach output. */
export function classifyWebSocketUrl(raw) {
  const url = new URL(raw);
  if (url.pathname !== WS_PATH) refusal('unexpected WebSocket path');
  if (/tm8[sg]_/i.test(url.href)) refusal('credential material appeared in a WebSocket URL');
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAMES.has(name.toLowerCase())) {
      refusal('credential material appeared in a WebSocket URL');
    }
  }

  const sessionId = url.searchParams.get('sessionId');
  if (sessionId === null) {
    if ([...url.searchParams.keys()].length > 0) refusal('event WebSocket carried query arguments');
    return { kind: 'event', offset: null };
  }
  for (const name of url.searchParams.keys()) {
    if (!PTY_QUERY_NAMES.has(name)) refusal('PTY WebSocket carried an unexpected query argument');
  }
  if (!UUID_SHAPE.test(sessionId)) refusal('PTY WebSocket carried an invalid session coordinate');
  const mode = url.searchParams.get('mode');
  if (mode !== 'view' && mode !== 'drive') refusal('PTY WebSocket omitted its authorized mode');
  const rawOffset = url.searchParams.get('offset');
  const offset = Number(rawOffset);
  if (rawOffset === null || !Number.isSafeInteger(offset) || offset < 0) {
    refusal('PTY WebSocket carried an invalid offset');
  }
  return { kind: 'pty', offset };
}

/** Validate grant freshness/echo behavior without returning any secret. */
export function summarizePtyProtocols(offers, selected) {
  if (offers.length === 0) refusal('no PTY protocol offer was observed');
  for (const offer of offers) {
    if (!/^tm8-pty-v1\s*,\s*tm8-grant\.tm8g_[^\s,]+$/i.test(offer)) {
      refusal('PTY protocol offer did not contain exactly one scoped grant');
    }
  }
  const uniqueOffers = new Set(offers).size;
  if (uniqueOffers !== offers.length) refusal('PTY reconnect did not mint a fresh grant');
  for (const protocol of selected) {
    if (/tm8[sg]_/i.test(protocol)) refusal('server echoed credential material in the selected protocol');
    if (protocol !== 'tm8-pty-v1') refusal('server selected an unexpected PTY protocol');
  }
  if (selected.length < offers.length) refusal('a PTY handshake response was not observed');
  return { offers: offers.length, uniqueOffers, selected: selected.length };
}

function headerValue(headers, wanted) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  return entry === undefined ? '' : String(entry[1]);
}

function frameType(payload) {
  if (typeof payload !== 'string') return null;
  try {
    const value = JSON.parse(payload);
    return typeof value === 'object' && value !== null && typeof value.type === 'string'
      ? value.type
      : null;
  } catch {
    return null;
  }
}

async function waitUntil(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  refusal(`timed out waiting for ${label}`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) refusal(`${name} is required`);
  return value;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message
    .replace(/tm8[sg]_[^\s,;]+/gi, '<redacted>')
    .replace(/([?&](?:token|grant|password|session_token)=)[^&\s]+/gi, '$1<redacted>');
}

async function signIn(page, username, password) {
  await page.locator('[data-testid="auth-frame"]').waitFor({ timeout: 60_000 });
  if ((await page.getByLabel('HANDLE').count()) === 0) {
    await page
      .getByRole('button', { name: /already have an account.*sign in|back to sign in/i })
      .click();
  }
  await page.getByLabel('HANDLE').fill(username);
  await page.getByLabel('PASSWORD').fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.locator('[data-testid="auth-frame"]').waitFor({ state: 'detached', timeout: 60_000 });
}

async function signOut(page) {
  const trigger = page.getByTestId('account-menu-trigger');
  if ((await trigger.count()) === 0) return;
  await trigger.click({ timeout: 5_000 });
  const button = page.getByRole('button', { name: /sign out/i });
  if ((await button.count()) === 0) return;
  await button.click({ timeout: 5_000 });
  await page.locator('[data-testid="auth-frame"]').waitFor({ timeout: 10_000 });
}

async function run() {
  const target = new URL(requiredEnv('TM8_BROWSER_PROBE_URL'));
  if (target.protocol !== 'https:' || target.pathname !== '/' || target.search || target.hash) {
    refusal('TM8_BROWSER_PROBE_URL must be an HTTPS origin with no path, query, or fragment');
  }
  const username = requiredEnv('TM8_BROWSER_USERNAME');
  const password = requiredEnv('TM8_BROWSER_PASSWORD');
  const sessionId = process.env.TM8_BROWSER_SESSION_ID ?? null;
  if (sessionId !== null && !UUID_SHAPE.test(sessionId)) {
    refusal('TM8_BROWSER_SESSION_ID must be a work-session uuid');
  }
  const requireOffsetAdvance = sessionId !== null
    && process.env.TM8_BROWSER_REQUIRE_OFFSET_ADVANCE !== '0';
  const channel = process.env.TM8_BROWSER_CHANNEL ?? 'chrome';
  if (channel !== 'chrome' && channel !== 'chromium') {
    refusal('TM8_BROWSER_CHANNEL must be chrome or chromium');
  }

  const browser = await chromium.launch({
    headless: process.env.TM8_BROWSER_HEADLESS !== '0',
    ...(channel === 'chrome' ? { channel: 'chrome' } : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  const sockets = [];
  const requestKinds = new Map();
  const pendingPtyOffers = new Map();
  const successfulPtyOffers = [];
  const ptySelected = [];
  let grantMints = 0;

  page.on('websocket', (socket) => {
    const classification = classifyWebSocketUrl(socket.url());
    const record = {
      ...classification,
      closed: false,
      sentTypes: [],
      receivedTypes: [],
    };
    sockets.push(record);
    socket.on('framesent', ({ payload }) => {
      const type = frameType(payload);
      if (type) record.sentTypes.push(type);
    });
    socket.on('framereceived', ({ payload }) => {
      const type = frameType(payload);
      if (type) record.receivedTypes.push(type);
    });
    socket.on('close', () => { record.closed = true; });
  });

  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === 'POST'
      && /\/v2\/entities\/[^/]+\/commands\/streams-attach$/.test(url.pathname)
      && response.status() >= 200
      && response.status() < 300
    ) {
      grantMints += 1;
    }
  });

  cdp.on('Network.webSocketWillSendHandshakeRequest', ({ requestId, request }) => {
    const classification = classifyWebSocketUrl(request.url);
    requestKinds.set(requestId, classification.kind);
    if (classification.kind === 'pty') {
      const offer = headerValue(request.headers, 'Sec-WebSocket-Protocol');
      if (!offer) refusal('PTY handshake omitted its protocol offer');
      pendingPtyOffers.set(requestId, offer);
    }
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
    if (requestKinds.get(requestId) !== 'pty') return;
    const offer = pendingPtyOffers.get(requestId);
    if (!offer) refusal('successful PTY handshake had no matching protocol offer');
    const selected = headerValue(response.headers, 'Sec-WebSocket-Protocol');
    if (!selected) refusal('PTY handshake omitted its selected protocol');
    successfulPtyOffers.push(offer);
    ptySelected.push(selected);
  });

  let signedIn = false;
  try {
    await page.goto(target.origin, { waitUntil: 'commit', timeout: 30_000 });
    await signIn(page, username, password);
    signedIn = true;

    const cookies = await context.cookies(target.origin);
    const cookie = cookies.find((entry) => entry.name === SESSION_COOKIE);
    assert.ok(cookie, 'signed-in browser did not receive the tm8 session cookie');
    assert.equal(cookie.httpOnly, true, 'tm8 session cookie must be HttpOnly');
    assert.equal(cookie.secure, true, 'tm8 session cookie must be Secure');
    assert.equal(cookie.sameSite, 'Strict', 'tm8 session cookie must be SameSite=Strict');
    assert.equal(cookie.path, '/', 'tm8 session cookie must use Path=/');

    await waitUntil(
      () => sockets.some((record) => record.kind === 'event' && record.sentTypes.length > 0),
      'the authenticated event WebSocket',
    );

    let initialPty = null;
    if (sessionId !== null) {
      const sessionUrl = new URL(target.origin);
      sessionUrl.searchParams.set('session', sessionId);
      await page.goto(sessionUrl, { waitUntil: 'commit', timeout: 30_000 });
      await waitUntil(
        () => sockets.some(
          (record) => record.kind === 'pty' && record.receivedTypes.includes('attached'),
        ),
        'the authenticated PTY attach',
      );
      initialPty = [...sockets].reverse().find((record) => record.kind === 'pty') ?? null;
      assert.ok(initialPty, 'PTY socket record is missing');
    }

    const eventCountBefore = sockets.filter((record) => record.kind === 'event').length;
    const ptyCountBefore = sockets.filter((record) => record.kind === 'pty').length;
    const grantMintsBefore = grantMints;

    await context.setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await context.setOffline(false);

    await waitUntil(
      () => sockets.filter((record) => record.kind === 'event').length > eventCountBefore
        && sockets
          .filter((record) => record.kind === 'event')
          .slice(eventCountBefore)
          .some((record) => record.sentTypes.includes('resume')),
      'an authenticated event reconnect with a resume frame',
    );

    let ptySummary = null;
    if (sessionId !== null) {
      await waitUntil(
        () => grantMints > grantMintsBefore
          && sockets.filter((record) => record.kind === 'pty').length > ptyCountBefore
          && sockets
            .filter((record) => record.kind === 'pty')
            .slice(ptyCountBefore)
            .some((record) => record.receivedTypes.includes('attached')),
        'a freshly granted PTY reconnect',
      );
      await waitUntil(
        () => ptySelected.length >= 2,
        'the PTY handshake response protocol',
      );
      const protocols = summarizePtyProtocols(successfulPtyOffers, ptySelected);
      const reconnectedPty = sockets
        .filter((record) => record.kind === 'pty')
        .slice(ptyCountBefore)
        .find((record) => record.receivedTypes.includes('attached'));
      assert.ok(reconnectedPty, 'reconnected PTY socket record is missing');
      assert.ok(reconnectedPty.offset >= initialPty.offset, 'PTY reconnect rewound its raw offset');
      if (requireOffsetAdvance) {
        assert.ok(
          reconnectedPty.offset > initialPty.offset,
          'PTY proof requires output before the forced reconnect so the raw offset advances',
        );
      }
      ptySummary = {
        connections: sockets.filter((record) => record.kind === 'pty').length,
        grantMints,
        ...protocols,
        initialOffset: initialPty.offset,
        reconnectOffset: reconnectedPty.offset,
      };
    }

    const eventSockets = sockets.filter((record) => record.kind === 'event');
    const result = {
      cookie: {
        name: cookie.name,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        path: cookie.path,
      },
      event: {
        connections: eventSockets.length,
        resumeFrames: eventSockets.reduce(
          (sum, record) => sum + record.sentTypes.filter((type) => type === 'resume').length,
          0,
        ),
      },
      pty: ptySummary ?? 'skipped',
      websocketUrls: 'credential-free',
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    if (signedIn) {
      await signOut(page).catch(() => {});
    }
    await browser.close();
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  run().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
