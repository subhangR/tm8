/**
 * W9c: the HOME server's forwarder and the remote-link client, against a real
 * local HTTP server standing in for the target.
 *
 *   · the loopback path exists only with allowLoopback AND a loopback URL;
 *     without it a loopback target is `unreachable` (the guard is unchanged);
 *   · the stored session travels as the bearer with the via chain, nothing else;
 *   · 404 WITHOUT the route marker is `unsupported` and leaves the row alone;
 *     the route's own 404 (an op's not_found) is a refusal;
 *   · only the route's own 401 marks the row signed_out; a proxy's does not;
 *   · a spawn op gets the longer budget.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REMOTE_SPACE_LINK_PATHS } from '@tm8/contract';

import type { DbClaims } from '../../src/db/types.js';
import { SpaceLinkUnusable, type DbSpaceLinkStore } from '../../src/credentials/space-link-store.js';
import { REMOTE_SPAWN_TIMEOUT_MS } from '../../src/remote/forwarder.js';
import { isLoopbackBaseUrl, postRemoteLink } from '../../src/remote/link-client.js';
import { HttpsRemoteInvokeForwarder } from '../../src/remote/link-forwarder.js';
import type { DbServerStore } from '../../src/remote/server-store.js';

interface Seen { path: string; headers: IncomingMessage['headers']; body: unknown }

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: (res: ServerResponse) => void = () => undefined;

const marked = (res: ServerResponse, status: number, body: Record<string, unknown>) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...body, remoteLink: 'v1' }));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

const claims: DbClaims = { identityId: 'h', authKind: 'agent' };
const TOKEN = 'tm8s_00000000-0000-4000-8000-000000000000.secret';

function forwarder(opts: { open?: () => Promise<string>; allowLoopback?: boolean } = {}) {
  const stale: string[] = [];
  const servers = { get: async () => ({ baseUrl }) } as unknown as DbServerStore;
  const links = {
    openRemote: opts.open ?? (async () => TOKEN),
    markStale: async (_c: DbClaims, linkId: string, status: string) => { stale.push(`${linkId}:${status}`); },
  } as unknown as DbSpaceLinkStore;
  return {
    stale,
    fw: new HttpsRemoteInvokeForwarder({ servers, links, client: { allowLoopback: opts.allowLoopback ?? true } }),
  };
}

const request = (op = 'entities.get') => ({
  claims, linkId: 'link-1', serverId: 'srv-1', op, params: { id: 'e1' }, input: undefined,
  via: ['11111111-1111-4111-8111-111111111111'],
});

describe('the remote-link client', () => {
  it('loopback is reached only with allowLoopback; otherwise the guard refuses it as non-public', async () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:7792')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost')).toBe(true);
    expect(isLoopbackBaseUrl('https://tm8.example')).toBe(false);
    expect(isLoopbackBaseUrl('http://user:pw@127.0.0.1')).toBe(false);

    reply = (res) => marked(res, 200, { data: {} });
    const guarded = await postRemoteLink({ baseUrl, path: REMOTE_SPACE_LINK_PATHS.invoke, body: {} });
    expect(guarded.kind).toBe('unreachable');
    expect(seen).toHaveLength(0);
    const dev = await postRemoteLink({ baseUrl, path: REMOTE_SPACE_LINK_PATHS.invoke, body: {} }, { allowLoopback: true });
    expect(dev).toMatchObject({ kind: 'response', status: 200 });
  });
});

describe('HttpsRemoteInvokeForwarder', () => {
  it('ok: posts the op with the stored session as bearer and the via chain; returns the target\'s data', async () => {
    reply = (res) => marked(res, 200, { data: { result: { id: 'e1' }, auditId: 'a-1' } });
    const { fw, stale } = forwarder();
    expect(await fw.forward(request())).toEqual({ kind: 'ok', status: 200, body: { result: { id: 'e1' }, auditId: 'a-1' } });
    expect(seen[0]!.path).toBe(REMOTE_SPACE_LINK_PATHS.invoke);
    expect(seen[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.headers['x-tm8-via']).toBe('11111111-1111-4111-8111-111111111111');
    expect(seen[0]!.headers['cookie']).toBeUndefined();
    expect(seen[0]!.body).toEqual({ op: 'entities.get', params: { id: 'e1' } });
    expect(stale).toEqual([]);
  });

  it('404 without the route marker is unsupported (older or switched-off target) and the row is left alone', async () => {
    reply = (res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"not_found","message":"no operation bound"}}'); };
    const { fw, stale } = forwarder();
    expect(await fw.forward(request())).toEqual({ kind: 'unsupported' });
    expect(stale).toEqual([]);
  });

  it("the route's own 404 is the op's refusal, passed through", async () => {
    reply = (res) => marked(res, 404, { error: { code: 'not_found', message: 'no such entity' } });
    const { fw } = forwarder();
    expect(await fw.forward(request())).toEqual({ kind: 'refused', status: 404, code: 'not_found', message: 'no such entity' });
  });

  it("only the route's own 401 marks the row signed_out; a proxy's 401 is a refusal", async () => {
    reply = (res) => marked(res, 401, { error: { code: 'unauthenticated', message: 'dead' } });
    const a = forwarder();
    expect(await a.fw.forward(request())).toEqual({ kind: 'signed_out' });
    expect(a.stale).toEqual(['link-1:signed_out']);

    reply = (res) => { res.writeHead(401); res.end('unauthorized'); };
    const b = forwarder();
    expect((await b.fw.forward(request())).kind).toBe('refused');
    expect(b.stale).toEqual([]);
  });

  it('a row that is not signed in is signed_out without sending anything or marking again', async () => {
    const { fw, stale } = forwarder({ open: async () => { throw new SpaceLinkUnusable('link-1', 'signed_out'); } });
    expect(await fw.forward(request())).toEqual({ kind: 'signed_out' });
    expect(seen).toHaveLength(0);
    expect(stale).toEqual([]);
  });

  it('a spawn op gets the long budget; a slow ordinary op times out as offline', async () => {
    expect(REMOTE_SPAWN_TIMEOUT_MS).toBeGreaterThan(60_000);
    reply = (res) => setTimeout(() => marked(res, 200, { data: { result: {}, auditId: 'a' } }), 300);
    const { fw } = forwarder();
    expect(await fw.forward({ ...request(), timeoutMs: 100 })).toEqual({ kind: 'offline', reason: 'timeout' });
    expect((await fw.forward(request('execution.spawn'))).kind).toBe('ok');
  });
});
