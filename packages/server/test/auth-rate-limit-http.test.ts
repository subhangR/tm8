/**
 * The limiter THROUGH THE PIPELINE.
 *
 * `auth-rate-limit.test.ts` proves the algorithm. It cannot prove the thing
 * that actually protects the node: that the guard is mounted, that it sits
 * ahead of identity resolution, that a refusal survives the single error
 * writer as a real 429 with a real `Retry-After`, and that a handler which
 * never ran cannot have spent a database connection. Those are pipeline
 * properties, and only a request can see them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../src/facade/index.js';
import { AuthRateLimiter } from '../src/http/auth-rate-limit.js';
import { fail } from '../src/http/errors.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';

// `databaseUrl` is required and stays undefined: nothing here reaches a
// database, which is the point — the guard refuses before dispatch.
const TEST_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  uiDir: undefined,
  maxBodyBytes: 1024 * 1024,
  databaseUrl: undefined,
};

/** Counts how often the handler was actually entered. */
let loginCalls = 0;
let loginShouldFail = true;

function buildServer(limiter: AuthRateLimiter | null): FacadeServer {
  const registry = new HandlerRegistry();
  registry.register('auth.login', () => {
    loginCalls += 1;
    // A real refusal, not a bare Error: an unrecognised throw is logged as an
    // unexpected escape, and that noise would hide a genuine failure here.
    if (loginShouldFail) throw fail('unauthenticated', 'invalid credentials');
    return { ok: true };
  });
  return createFacadeServer({ config: TEST_CONFIG, registry, authRateLimiter: limiter });
}

async function postLogin(base: string, username: string): Promise<Response> {
  return fetch(`${base}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'nope' }),
  });
}

describe('auth rate limiting over HTTP', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    loginCalls = 0;
    loginShouldFail = true;
    server = buildServer(new AuthRateLimiter({ maxAttemptsPerClient: 3, attemptWindowMs: 60_000 }));
    const { url } = await server.listen();
    base = url;
  });

  afterAll(async () => { await server.close(); });

  it('refuses past the limit with 429, retryable, and a Retry-After header', async () => {
    for (let i = 0; i < 3; i += 1) {
      const allowed = await postLogin(base, `user-${i}`);
      expect(allowed.status).not.toBe(429);
    }

    const refused = await postLogin(base, 'user-x');
    expect(refused.status).toBe(429);

    const retryAfter = refused.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    // Whole seconds, positive — the header is unparseable otherwise.
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(retryAfter))).toBe(true);

    const body = await refused.json() as { error?: { code?: string; retryable?: boolean } };
    expect(body.error?.code).toBe('rate_limited');
    // `rate_limited` is in RETRYABLE_BY_DEFAULT — a client that backs off and
    // retries is doing the right thing and must be told so.
    expect(body.error?.retryable).toBe(true);
  });

  it('never enters the handler for a refused request', async () => {
    const before = loginCalls;
    await postLogin(base, 'user-y');
    // The whole point of guarding ahead of dispatch: a flood that is going to
    // be refused must not first spend scrypt work and a database connection.
    expect(loginCalls).toBe(before);
  });
});

describe('auth rate limiting — scope', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    loginCalls = 0;
    loginShouldFail = true;
    server = buildServer(new AuthRateLimiter({ maxAttemptsPerClient: 2, attemptWindowMs: 60_000 }));
    const { url } = await server.listen();
    base = url;
  });

  afterAll(async () => { await server.close(); });

  it('leaves unguarded operations untouched once auth is exhausted', async () => {
    await postLogin(base, 'a');
    await postLogin(base, 'b');
    expect((await postLogin(base, 'c')).status).toBe(429);

    // A spent auth budget must not take the rest of the API down with it.
    const other = await fetch(`${base}/v2/spaces`);
    expect(other.status).not.toBe(429);
  });
});

describe('auth rate limiting — opt out', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    loginCalls = 0;
    loginShouldFail = true;
    // `null` is the explicit "no limiting" escape hatch for harnesses that
    // legitimately flood the auth surface.
    server = buildServer(null);
    const { url } = await server.listen();
    base = url;
  });

  afterAll(async () => { await server.close(); });

  it('never refuses when the limiter is explicitly absent', async () => {
    for (let i = 0; i < 40; i += 1) {
      expect((await postLogin(base, 'flood')).status).not.toBe(429);
    }
    expect(loginCalls).toBe(40);
  });
});
