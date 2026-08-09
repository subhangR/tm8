/**
 * S2/S3/S4/S6 — the transport gates, on BOTH paths.
 *
 * These were named no-ops until the artifacts Phase 0 (items 0.5/0.6). The
 * design's C3 finding is the load-bearing thing this file proves: filling in
 * security.ts closes the HTTP path only — the WS `upgrade` listener never
 * calls the ordinary request handler, so it needs its own wiring, and a
 * regression there is invisible to every HTTP-level test. Hence the upgrade
 * cases below drive a real socket handshake, not checkTransport() directly.
 */
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../src/facade/index.js';
import type { ServerConfig } from '../src/http/config.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { checkCsrf, checkHost, checkOrigin, checkTransport } from '../src/http/security.js';

const TEST_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  uiDir: undefined,
  maxBodyBytes: 1024 * 1024,
  databaseUrl: undefined,
};

describe('Utho nginx artifact compatibility', () => {
  const site = readFileSync(
    new URL('../../../deploy/utho/nginx/sites-available/tm8-sh', import.meta.url),
    'utf8',
  );

  it('enables HTTP/2 using the syntax accepted by the production nginx binary', () => {
    expect(site).toContain('listen 443 ssl http2;');
    expect(site).toContain('listen [::]:443 ssl http2;');
    expect(site).not.toContain('http2 on;');
  });
});

describe('S2 — Host allowlist (unit)', () => {
  it('allows the loopback trio with and without ports', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:4610', 'localhost:4612', 'LOCALHOST', '[::1]:4610', '[::1]']) {
      expect(checkHost({ host }, TEST_CONFIG).refusal, host).toBeUndefined();
    }
  });

  it('refuses a rebound Host', () => {
    for (const host of ['evil.example', 'evil.example:4610', '127.0.0.1.evil.example', 'localhost.evil.example:80']) {
      expect(checkHost({ host }, TEST_CONFIG).refusal?.code, host).toBe('forbidden');
    }
  });

  it('allows an absent Host (non-browser client; browsers always send one)', () => {
    expect(checkHost({}, TEST_CONFIG).refusal).toBeUndefined();
  });

  it('accepts a configured extra hostname, and only then', () => {
    const host = 'tm8-dev.internal';
    expect(checkHost({ host }, TEST_CONFIG).refusal?.code).toBe('forbidden');
    expect(
      checkHost({ host }, { ...TEST_CONFIG, extraAllowedHostnames: ['tm8-dev.internal'] }).refusal,
    ).toBeUndefined();
  });
});

describe('S3/S4 — Origin (unit)', () => {
  it('allows no Origin (CLI, rigs) and loopback origins on any port', () => {
    expect(checkOrigin({}, TEST_CONFIG).refusal).toBeUndefined();
    for (const origin of ['http://127.0.0.1:4612', 'http://localhost:4610', 'http://[::1]:4610']) {
      expect(checkOrigin({ origin }, TEST_CONFIG).refusal, origin).toBeUndefined();
    }
  });

  it('refuses foreign, opaque and garbage origins', () => {
    for (const origin of ['https://evil.example', 'null', 'not a url', 'http://localhost.evil.example']) {
      expect(checkOrigin({ origin }, TEST_CONFIG).refusal?.code, origin).toBe('forbidden');
    }
  });

  it('uses an exact scheme/host/port allowlist when configured for HTTPS', () => {
    const production = {
      ...TEST_CONFIG,
      extraAllowedHostnames: ['tm8.sh'],
      allowedOrigins: ['https://tm8.sh'],
    };
    expect(checkOrigin({ origin: 'https://tm8.sh' }, production).refusal).toBeUndefined();
    for (const origin of [
      'http://tm8.sh',
      'https://tm8.sh:444',
      'https://sub.tm8.sh',
      'https://tm8.sh.evil.example',
      'https://tm8.sh/',
      'https://user:password@tm8.sh',
      'https://tm8.sh/path',
      'https://tm8.sh?query=1',
      'https://tm8.sh, https://evil.example',
    ]) {
      expect(checkOrigin({ origin }, production).refusal?.code, origin).toBe('forbidden');
    }
  });

  it('refuses a CORS preflight outright (S4: same-origin only, no ACAO ever)', () => {
    const decision = checkTransport(
      'OPTIONS',
      { host: '127.0.0.1:4610', 'access-control-request-method': 'POST' },
      TEST_CONFIG,
    );
    expect(decision.refusal?.code).toBe('forbidden');
  });
});

describe('S6 — X-TM8-Client on cookie-carrying mutations (unit)', () => {
  it('is inert without a cookie, on reads, and for header-carrying clients', () => {
    expect(checkCsrf('POST', {}, TEST_CONFIG).refusal).toBeUndefined();
    expect(checkCsrf('GET', { cookie: 'tm8_session=x' }, TEST_CONFIG).refusal).toBeUndefined();
    expect(
      checkCsrf('POST', { cookie: 'tm8_session=x', 'x-tm8-client': 'tm8-ui' }, TEST_CONFIG).refusal,
    ).toBeUndefined();
  });

  it('refuses a tm8-cookie-carrying mutation without the header', () => {
    expect(checkCsrf('POST', { cookie: 'tm8_session=x' }, TEST_CONFIG).refusal?.code).toBe('forbidden');
    expect(checkCsrf('DELETE', { cookie: 'tm8-sid=x' }, TEST_CONFIG).refusal?.code).toBe('forbidden');
    // Both the __Host- prefixed form and a cookie riding alongside foreign ones.
    expect(checkCsrf('POST', { cookie: '__Host-tm8_session=x' }, TEST_CONFIG).refusal?.code).toBe('forbidden');
    expect(
      checkCsrf('POST', { cookie: 'grafana_session=a; TM8_SESSION=x; _ga=b' }, TEST_CONFIG).refusal?.code,
    ).toBe('forbidden');
  });

  /**
   * The regression this gate actually shipped with. Cookies are host-scoped,
   * not port-scoped, so a cookie set by ANY other app on 127.0.0.1 arrives
   * here — and gating on the mere presence of a Cookie header 403'd every
   * mutation the UI made ("Launch refused … require X-TM8-Client"), with no
   * tm8 cookie anywhere in sight.
   */
  it('ignores foreign cookies entirely — they authenticate nothing here', () => {
    for (const cookie of [
      'sid=abc',
      'connect.sid=s%3Aabc',
      '_ga=GA1.1.123; _gid=GA1.1.456',
      'jupyter-token=zzz; grafana_session=qqq',
    ]) {
      expect(checkCsrf('POST', { cookie }, TEST_CONFIG).refusal, cookie).toBeUndefined();
      expect(checkCsrf('DELETE', { cookie }, TEST_CONFIG).refusal, cookie).toBeUndefined();
    }
  });
});

describe('the gates on the wire — HTTP path and WS upgrade path', () => {
  let server: FacadeServer;
  let base: string;
  let port: number;
  const upgradesSeen: string[] = [];

  beforeAll(async () => {
    server = createFacadeServer({
      config: TEST_CONFIG,
      registry: new HandlerRegistry(),
      upgrades: {
        handleUpgrade(req, socket) {
          upgradesSeen.push(req.url ?? '');
          // Minimal acceptance so a permitted handshake is distinguishable:
          socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
          socket.destroy();
        },
      },
    });
    const listening = await server.listen();
    base = listening.url;
    port = listening.port;
  });

  afterAll(async () => {
    await server.close();
  });

  it('bad Host on the HTTP path → 403, before routing', async () => {
    // Raw socket on purpose: fetch/undici silently refuses to override Host,
    // which would turn this into a test of the DEFAULT host passing.
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write('GET /health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
      setTimeout(() => socket.destroy(), 2000);
    });
    expect(statusLine).toContain('403');
  });

  it('foreign Origin on the HTTP path → 403, even on a mutation that would land', async () => {
    const res = await fetch(`${base}/v2/spaces`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('good Host and loopback Origin pass through to the ordinary pipeline', async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: `http://127.0.0.1:${port}` } });
    expect(res.status).toBe(200);
  });

  it('tm8-cookie mutation without X-TM8-Client → 403; with it, passes the gate', async () => {
    const refused = await fetch(`${base}/v2/spaces`, {
      method: 'POST',
      headers: { cookie: 'tm8_session=abc', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(refused.status).toBe(403);
    const passed = await fetch(`${base}/v2/spaces`, {
      method: 'POST',
      headers: {
        cookie: 'tm8_session=abc',
        'x-tm8-client': 'tm8-ui',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    // Past the gate: an empty registry answers 501, not 403 — the point is
    // the refusal is gone, not that the operation is implemented here.
    expect(passed.status).not.toBe(403);
  });

  it('a foreign cookie on the wire does NOT gate a mutation (the shipped regression)', async () => {
    const res = await fetch(`${base}/v2/spaces`, {
      method: 'POST',
      headers: { cookie: 'sid=abc; _ga=GA1.1.9', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(403);
  });

  /** Raw upgrade handshake; returns the first response line the socket sees. */
  function upgrade(headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        const lines = [
          'GET /v2/ws HTTP/1.1',
          `Host: ${headers.host ?? `127.0.0.1:${port}`}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ];
        if (headers.origin) lines.push(`Origin: ${headers.origin}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
      setTimeout(() => socket.destroy(), 2000);
    });
  }

  it('bad Host on the WS UPGRADE path → 403 and no handshake (the C3 second wiring)', async () => {
    const before = upgradesSeen.length;
    const statusLine = await upgrade({ host: 'evil.example' });
    expect(statusLine).toContain('403');
    expect(upgradesSeen.length).toBe(before);
  });

  it('foreign Origin on the WS UPGRADE path → 403 and no handshake', async () => {
    const before = upgradesSeen.length;
    const statusLine = await upgrade({ origin: 'https://evil.example' });
    expect(statusLine).toContain('403');
    expect(upgradesSeen.length).toBe(before);
  });

  it('a clean loopback upgrade still reaches the socket server', async () => {
    const before = upgradesSeen.length;
    const statusLine = await upgrade({ origin: `http://127.0.0.1:${port}` });
    expect(statusLine).toContain('101');
    expect(upgradesSeen.length).toBe(before + 1);
  });
});
