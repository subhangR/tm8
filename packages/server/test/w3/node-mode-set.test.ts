import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type PublicJsonResponse,
  type W3PublicServer,
} from './public-harness.js';

/**
 * `node.mode.set` AGAINST A REAL DATABASE, over the production HTTP boundary
 * (doc 15 §2's refusal table, doc 14 §5.2's switch rules).
 *
 * The harness's plain `request` is a loopback caller with no forwarding
 * headers, so it IS the auto-owner arm. `call` adds what the plain one cannot:
 * a bearer token, or a forwarding header that turns a loopback peer into an
 * anonymous one (the proxy case).
 *
 * The tests run in order against ONE node, walking it through the switch
 * ladder: unclaimed (every mode refused) → claimed → personal → peer → server
 * → back down. Decision 34: the chooser runs after the claim.
 */

const PASSWORD = 'owner-password-8+';

interface ModeSetResult {
  previous: string;
  mode: string;
  source: string;
  restartRequired: boolean;
}

function reasonOf(response: PublicJsonResponse): unknown {
  return (response.body.error?.details as { reason?: unknown } | undefined)?.reason;
}

describe('node.mode.set, over the public surface', () => {
  let server: W3PublicServer;
  let ownerToken: string;
  let memberToken: string;

  beforeAll(async () => {
    // Blank, so a TM8_NODE_MODE in the runner's own environment cannot pin this node.
    server = await startW3PublicServer('node_mode', { TM8_NODE_MODE: '' });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function call<T = unknown>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<PublicJsonResponse<T>> {
    const response = await fetch(new URL(path, server.baseUrl), {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      requestIdHeader: response.headers.get('x-tm8-request-id'),
      body: await response.json() as PublicJsonResponse<T>['body'],
    };
  }

  const setMode = (mode: string) => server.request<ModeSetResult>('PUT', '/v2/node/mode', { mode });
  const recorded = async () => (await readFile(join(server.dataDir, 'mode'), 'utf8')).trim();

  it('starts unset: the chooser state, runs as personal', async () => {
    const status = successData(await server.request('GET', '/v2/auth/claim'));
    expect(status).toMatchObject({ claimed: false, mode: 'personal', modeSet: false, modeSource: 'default' });
  });

  it('refuses an anonymous caller — a loopback peer behind a forwarding header is not the owner', async () => {
    const response = await call('PUT', '/v2/node/mode', { mode: 'personal' }, { 'x-forwarded-for': '203.0.113.9' });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('refuses EVERY mode on an UNCLAIMED node, Personal included, and writes nothing', async () => {
    for (const mode of ['personal', 'peer', 'server']) {
      const response = await setMode(mode);
      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('conflict');
      expect(reasonOf(response)).toBe('node_unclaimed');
    }
    await expect(stat(join(server.dataDir, 'mode'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a value outside the three, the legacy aliases included, and any password field', async () => {
    for (const body of [{ mode: 'multi' }, { mode: 'single' }, { mode: 'personal', password: PASSWORD }]) {
      const response = await server.request('PUT', '/v2/node/mode', body);
      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('invalid_input');
    }
  });

  it('after the claim, lets the loopback owner choose personal; the file is 0600', async () => {
    const token = (await readFile(join(server.dataDir, 'setup-token'), 'utf8')).trim();
    const claimed = successData<{ token: string }>(
      await server.request('POST', '/v2/auth/claim', { token, username: 'owner', password: PASSWORD }),
    );
    ownerToken = claimed.token;

    const result = successData(await setMode('personal'));
    expect(result).toEqual({ previous: 'personal', mode: 'personal', source: 'file', restartRequired: false });
    expect(await recorded()).toBe('personal');
    expect((await stat(join(server.dataDir, 'mode'))).mode & 0o777).toBe(0o600);
    // The status reports the RECORDED mode at once: no restart, and the chooser
    // does not come back on the next load.
    const status = successData(await server.request('GET', '/v2/auth/claim'));
    expect(status).toMatchObject({ claimed: true, mode: 'personal', modeSet: true, modeSource: 'file' });
  });

  it('the EXISTING password satisfies personal → peer for the auto-owner', async () => {
    const result = successData(await setMode('peer'));
    // Peer keeps the loopback arm, so the running node needs no restart.
    expect(result).toEqual({ previous: 'personal', mode: 'peer', source: 'file', restartRequired: false });
    expect(await recorded()).toBe('peer');
  });

  it('refuses the auto-owner LOOSENING peer → personal', async () => {
    const response = await setMode('personal');
    expect(response.status).toBe(403);
    expect(reasonOf(response)).toBe('owner_session_required');
    expect(await recorded()).toBe('peer');
  });

  it('lets the auto-owner tighten to server, which moves the arm: restart required', async () => {
    const result = successData(await setMode('server'));
    expect(result).toEqual({ previous: 'peer', mode: 'server', source: 'file', restartRequired: true });
    // Reported as recorded, before the restart that applies it.
    expect(successData(await server.request('GET', '/v2/auth/claim'))).toMatchObject({ mode: 'server', modeSource: 'file' });
  });

  it('judges from the RECORDED mode: still running personal, the auto-owner cannot undo server', async () => {
    const response = await setMode('peer');
    expect(response.status).toBe(403);
    expect(reasonOf(response)).toBe('owner_session_required');
    expect(await recorded()).toBe('server');
  });

  it('same mode as recorded: success, no restart beyond what the running node already needs', async () => {
    const result = successData(await setMode('server'));
    expect(result).toMatchObject({ previous: 'server', mode: 'server' });
  });

  it('refuses a signed-in account that is NOT the owner, tightening or loosening', async () => {
    successData(await server.request('POST', '/v2/auth/signup', { username: 'member', password: PASSWORD }));
    const login = successData<{ token: string }>(
      await server.request('POST', '/v2/auth/login', { username: 'member', password: PASSWORD, kind: 'cli' }),
    );
    memberToken = login.token;
    for (const mode of ['personal', 'server']) {
      const response = await call('PUT', '/v2/node/mode', { mode }, { authorization: `Bearer ${memberToken}` });
      expect(response.status).toBe(403);
      expect(reasonOf(response)).toBe('owner_session_required');
    }
    expect(await recorded()).toBe('server');
  });

  it('lets the owner\'s bearer session loosen server → peer, even through a proxy', async () => {
    const response = await call(
      'PUT',
      '/v2/node/mode',
      { mode: 'peer' },
      { authorization: `Bearer ${ownerToken}`, 'x-forwarded-for': '203.0.113.9' },
    );
    const result = successData<ModeSetResult>(response);
    // Running personal, recorded server: server → peer keeps the arm the node runs with.
    expect(result).toEqual({ previous: 'server', mode: 'peer', source: 'file', restartRequired: false });
  });

  it('lets the owner\'s bearer session loosen peer → personal', async () => {
    const response = await call('PUT', '/v2/node/mode', { mode: 'personal' }, { authorization: `Bearer ${ownerToken}` });
    expect(successData<ModeSetResult>(response)).toMatchObject({ previous: 'peer', mode: 'personal' });
    expect(await recorded()).toBe('personal');
  });
});

describe('node.mode.set on a node PINNED by TM8_NODE_MODE', () => {
  let server: W3PublicServer;

  beforeAll(async () => {
    // The deprecated alias, so this also proves `multi` still means server.
    server = await startW3PublicServer('node_mode_pin', { TM8_NODE_MODE: 'multi' });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it('reports the pin, normalised: server from env', async () => {
    const status = successData(await server.request('GET', '/v2/auth/claim'));
    expect(status).toMatchObject({ mode: 'server', modeSet: true, modeSource: 'env' });
  });

  it('server mode has no auto-owner: a loopback caller with no credential is anonymous', async () => {
    const response = await server.request('PUT', '/v2/node/mode', { mode: 'server' });
    expect(response.status).toBe(401);
  });

  it('refuses every switch with conflict / mode_pinned, and never names the env file', async () => {
    const token = (await readFile(join(server.dataDir, 'setup-token'), 'utf8')).trim();
    const claimed = successData<{ token: string }>(
      await server.request('POST', '/v2/auth/claim', { token, username: 'owner', password: PASSWORD }),
    );
    const response = await call(server, claimed.token, { mode: 'personal' });
    expect(response.status).toBe(409);
    expect(reasonOf(response)).toBe('mode_pinned');
    expect(response.body.error?.message).toContain('TM8_NODE_MODE');
    expect(JSON.stringify(response.body)).not.toMatch(/\/etc\/tm8|\.env/);
    await expect(stat(join(server.dataDir, 'mode'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function call(server: W3PublicServer, bearer: string, body: unknown): Promise<PublicJsonResponse> {
  const response = await fetch(new URL('/v2/node/mode', server.baseUrl), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    requestIdHeader: response.headers.get('x-tm8-request-id'),
    body: await response.json() as PublicJsonResponse['body'],
  };
}
