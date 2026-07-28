/**
 * Frame tests — the parts of the skeleton that are REAL today.
 *
 * The conformance suite proves the frame reproduces the stub's honest-501
 * profile from the outside. These tests prove the things conformance cannot
 * see because the registry is empty: that the success envelope is right when
 * a handler DOES exist, that the router covers the whole catalog, and that
 * the registry's tripwires actually fire.
 *
 * Deliberately NOT tested here: semantics. There are none yet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  OPERATIONS,
  RESERVED_OPERATIONS,
  V1_OPERATIONS,
  WireErrorBodySchema,
  bindPath,
  type OperationName,
} from '@tm8/contract';
import { HandlerRegistry } from '../src/facade/index.js';
import { ConfigError, loadConfig } from '../src/http/config.js';
import { Router } from '../src/http/router.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { json, raw } from '../src/http/types.js';

const TEST_CONFIG = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024 };

describe('router (catalog-driven)', () => {
  const router = new Router();

  it('mounts every non-WS catalog operation and nothing else', () => {
    const expected = OPERATIONS.filter((op) => op.method !== 'WS').length;
    expect(router.mounted()).toHaveLength(expected);
  });

  it('every operation matches the path its own bindPath() produces', () => {
    for (const op of OPERATIONS) {
      if (op.method === 'WS') continue;
      const params: Record<string, string> = {};
      for (const m of op.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)) {
        const name = m[1];
        if (name) params[name] = `test-${name}`;
      }
      const path = bindPath(op.name as OperationName, params);
      const match = router.match(op.method, path);
      expect(match?.opName, `${op.name} did not round-trip through the router`).toBe(op.name);
      for (const [key, value] of Object.entries(params)) {
        expect(match?.params[key], `${op.name} lost param :${key}`).toBe(value);
      }
    }
  });

  it('no two operations share a method + path (silent shadowing tripwire)', () => {
    const seen = new Set<string>();
    for (const op of OPERATIONS) {
      const key = `${op.method} ${op.path}`;
      expect(seen.has(key), `duplicate catalog binding: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('a known path under the wrong method is not_found, not a 405', () => {
    // The closed taxonomy (DEV-8) has no method_not_allowed; inventing one
    // would put an off-contract code on the wire.
    expect(router.match('DELETE', '/v2/spaces')).toBeUndefined();
    expect(router.hasPath('/v2/spaces')).toBe(true);
  });
});

describe('config (S1 — loopback only)', () => {
  it('defaults to 127.0.0.1:4610', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4610);
  });

  it('REFUSES to start on a non-loopback bind (no token auth exists yet)', () => {
    expect(() => loadConfig({ TM8_BIND: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ TM8_BIND: '192.168.1.10' })).toThrow(/requires token auth/);
  });

  it('accepts the loopback spellings', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(loadConfig({ TM8_BIND: host }).host).toBe(host);
    }
  });
});

describe('handler registry (the W2 seam)', () => {
  it('is EMPTY by default — that is the acceptance criterion, not an omission', () => {
    expect(new HandlerRegistry().size).toBe(0);
  });

  it('refuses to implement a reserved operation (DEV-13)', () => {
    const registry = new HandlerRegistry();
    for (const op of RESERVED_OPERATIONS) {
      expect(() => registry.register(op.name as OperationName, () => ({}))).toThrow(/reserved/);
    }
  });

  it('refuses an operation the catalog does not declare', () => {
    expect(() => new HandlerRegistry().register('entities.frobnicate' as OperationName, () => ({})))
      .toThrow(/not an operation in the catalog/);
  });

  it('refuses a duplicate registration', () => {
    const registry = new HandlerRegistry().register('spaces.list', () => ({}));
    expect(() => registry.register('spaces.list', () => ({}))).toThrow(/duplicate/);
  });
});

describe('the pipeline, end to end', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    const registry = new HandlerRegistry()
      .register('spaces.list', () => ({ page: { items: [], nextCursor: null } }))
      .register('entities.get', (ctx) => json({ id: ctx.params.id, echoed: true }))
      .register('entities.create', (ctx) => json({ received: ctx.body }, { status: 201 }))
      .register('files.download', () =>
        raw(200, { 'content-type': 'application/octet-stream' }, Buffer.from('bytes')),
      );
    server = createFacadeServer({ config: TEST_CONFIG, registry });
    const { url } = await server.listen();
    base = url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('/health is unenveloped and reports how much of the catalog is built', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.server).toBe('tm8-server');
    expect(body.implemented).toBe(4);
    expect('data' in body, '/health must not look like an operation').toBe(false);
  });

  it('a registered read returns the DEV-6 envelope — and nothing at envelope level', async () => {
    const res = await fetch(`${base}/v2/spaces`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['data', 'requestId']);
    expect(typeof body.requestId).toBe('string');
    // DEV-6: nextCursor lives inside data.page, never on the envelope.
    expect('nextCursor' in body).toBe(false);
  });

  it('the envelope requestId matches the response header (audit joinability)', async () => {
    const res = await fetch(`${base}/v2/spaces`);
    const body = (await res.json()) as { requestId: string };
    expect(res.headers.get('x-tm8-request-id')).toBe(body.requestId);
  });

  it('path params reach the handler', async () => {
    const res = await fetch(`${base}/v2/entities/ent_123`);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('ent_123');
  });

  it('a handler may choose its status', async () => {
    const res = await fetch(`${base}/v2/entities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientMutationId: 'frame-handler-status-201',
        spaceId: 's',
        kind: 'task',
        title: 'x',
      }),
    });
    expect(res.status).toBe(201);
  });

  it('a raw result escapes the envelope (files.download returns bytes)', async () => {
    const res = await fetch(`${base}/v2/files/file_1/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('bytes');
  });

  it('an unregistered v1 operation answers an honest 501, never a 404', async () => {
    const res = await fetch(`${base}/v2/actions`);
    expect(res.status).toBe(501);
    const parsed = WireErrorBodySchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('not_implemented');
      expect(parsed.data.error.retryable).toBe(false);
    }
  });

  it('a reserved operation answers 501 (DEV-13) even with valid-looking input', async () => {
    for (const op of RESERVED_OPERATIONS) {
      if (op.method === 'WS') continue;
      const path = op.path.replace(/:[A-Za-z]+/g, 'x');
      const res = await fetch(`${base}${path}?q=anything`, { method: op.method });
      expect(res.status, `${op.name} must 501`).toBe(501);
    }
  });

  it('an unknown route is the wire 404', async () => {
    const res = await fetch(`${base}/v2/definitely-not-a-route`);
    expect(res.status).toBe(404);
    const parsed = WireErrorBodySchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('not_found');
  });

  it('malformed JSON is invalid_input — before routing, so it applies everywhere', async () => {
    for (const path of ['/v2/entities', '/v2/no-such-route']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(res.status, path).toBe(400);
      const parsed = WireErrorBodySchema.safeParse(await res.json());
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.error.code).toBe('invalid_input');
    }
  });

  it('an oversized body is payload_too_large, refused while streaming', async () => {
    const res = await fetch(`${base}/v2/entities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    const parsed = WireErrorBodySchema.safeParse(await res.json());
    if (parsed.success) expect(parsed.data.error.code).toBe('payload_too_large');
  });

  it('a registered handler still validates its input against the contract', async () => {
    const res = await fetch(`${base}/v2/entities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(400);
    const parsed = WireErrorBodySchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('invalid_input');
  });

  it('every error status observed equals ERROR_STATUS[code] (DEV-8 mapping)', async () => {
    const probes = await Promise.all([
      fetch(`${base}/v2/entities/x`, { method: 'DELETE' }),
      fetch(`${base}/v2/nope`),
      fetch(`${base}/v2/search?q=x`),
      fetch(`${base}/v2/entities`, { method: 'POST', body: 'oops{' }),
    ]);
    for (const res of probes) {
      if (res.status < 400) continue;
      const parsed = WireErrorBodySchema.safeParse(await res.json());
      expect(parsed.success, `error body drift at ${res.status}`).toBe(true);
      if (parsed.success) expect(res.status).toBe(ERROR_STATUS[parsed.data.error.code]);
    }
  });
});

describe('honest-501 profile with an EMPTY registry (the stub-replacement proof)', () => {
  let server: FacadeServer;
  let base: string;

  beforeAll(async () => {
    server = createFacadeServer({ config: TEST_CONFIG, registry: new HandlerRegistry() });
    base = (await server.listen()).url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('every v1 GET answers 501 with a contract-shaped body — red the RIGHT way', async () => {
    const wrong: string[] = [];
    for (const op of V1_OPERATIONS) {
      if (op.method !== 'GET') continue;
      const res = await fetch(`${base}${op.path.replace(/:[A-Za-z]+/g, 'x')}`);
      if (res.status !== 501) {
        wrong.push(`${op.name} answered ${res.status}`);
        continue;
      }
      const parsed = WireErrorBodySchema.safeParse(await res.json());
      if (!parsed.success) wrong.push(`${op.name} 501 body drift`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
