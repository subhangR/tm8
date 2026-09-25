import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';

import {
  createRemoteServerProxy,
  resolveRelayCaller,
  type RelayCaller,
} from '../src/http/remote-proxy.js';
import type { IdentityResolver, RequestIdentity } from '../src/http/types.js';

/**
 * The relay must not carry this node's browser cookie to another node.
 *
 * Driven through a REAL upstream rather than by calling the header helper,
 * because the helper is private and, more to the point, the claim under test
 * is about what arrives at the far end. A unit test of the helper would still
 * pass if a later refactor rebuilt the headers somewhere else on the path.
 *
 * Two separate harms, and the test names both so neither can be "fixed" by
 * deleting the half someone finds inconvenient:
 *
 *   - the cookie is this node's session credential, and a remote is someone
 *     else's machine;
 *   - a browser signed in to the remote sends ITS pass plus this node's
 *     cookie, and `identity-resolver.ts` refuses any request carrying two
 *     credentials that disagree — so forwarding it breaks every relayed
 *     operation, not merely leaks one.
 */
describe('remote server relay — credential scope', () => {
  let upstream: Server;
  let seen: IncomingHttpHeaders | null = null;
  let origin = '';

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (typeof address === 'string' || address === null) throw new Error('no upstream port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  // The caller is resolved by server.ts before the proxy is reached; here it
  // is the human whose Authorization header is the remote's pass.
  const human: RelayCaller = {
    identity: { kind: 'bearer', identityId: 'human', authKind: 'browser' },
    forwardAuthorization: true,
  };

  async function relay(headers: Record<string, string>, caller: RelayCaller = human): Promise<void> {
    const proxy = createRemoteServerProxy(async () => origin);
    // Drive the proxy the way the http server does: a request object shaped
    // like the one Node hands it, and a real socket to write the reply into.
    const relayServer = createServer((req, res) => {
      void proxy.handleHttp(req, res, caller);
    });
    await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
    const addr = relayServer.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no relay port');
    await fetch(`http://127.0.0.1:${addr.port}/v2/server-connections/prod/proxy/v2`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    await new Promise<void>((resolve) => relayServer.close(() => resolve()));
  }

  it('does not forward this node’s session cookie to the remote', async () => {
    seen = null;
    await relay({
      cookie: '__Host-tm8-session=tm8s_localsecret',
      'content-type': 'application/json',
    });
    expect(seen).not.toBeNull();
    expect(seen?.cookie).toBeUndefined();
  });

  it('still forwards Authorization — that one IS the remote’s own carrier', async () => {
    seen = null;
    await relay({
      authorization: 'Bearer tm8s_remotepass',
      cookie: '__Host-tm8-session=tm8s_localsecret',
      'content-type': 'application/json',
    });
    // The pair is exactly the case that produced `conflicting authentication
    // credentials` on every relayed operation: the remote saw both, they
    // disagreed, and it refused. Only one of them may survive the hop.
    expect(seen?.authorization).toBe('Bearer tm8s_remotepass');
    expect(seen?.cookie).toBeUndefined();
  });

  it('drops Authorization when it carried THIS node’s session', async () => {
    seen = null;
    await relay(
      { authorization: 'Bearer tm8s_localcli', 'content-type': 'application/json' },
      { ...human, forwardAuthorization: false },
    );
    expect(seen).not.toBeNull();
    expect(seen?.authorization).toBeUndefined();
  });

  it('rewrites host to the target and marks the hop', async () => {
    seen = null;
    await relay({ cookie: 'a=b', 'content-type': 'application/json' });
    expect(seen?.host).toBe(new URL(origin).host);
    expect(seen?.['x-tm8-server-proxy-hop']).toBe('1');
  });
});

/**
 * G1: who may drive the relay, and which carrier is the caller's to hand on.
 * A stub resolver stands in for identity-resolver.ts with the SAME rules that
 * matter here — a known local token resolves, an unknown one is
 * `unauthenticated`, a cookie and a different Authorization conflict — so the
 * test pins the relay's choice of carrier, not the resolver's lookup.
 */
describe('remote server relay — caller resolution (G1)', () => {
  const LOCAL: Record<string, RequestIdentity> = {
    tm8s_browser: { kind: 'bearer', identityId: 'h', authKind: 'browser' },
    tm8s_cli: { kind: 'bearer', identityId: 'h', authKind: 'cli' },
    tm8s_agent: { kind: 'bearer', identityId: 'h', authKind: 'agent' },
    tm8s_runtime: { kind: 'bearer', identityId: 'h', authKind: 'agent_runtime' },
  };
  const resolver = (loopback: boolean): IdentityResolver => (headers: IncomingHttpHeaders) => {
    const auth = typeof headers.authorization === 'string'
      ? headers.authorization.replace(/^Bearer\s+/i, '')
      : '';
    const cookie = /__Host-tm8-session=([^;]+)/.exec(headers.cookie ?? '')?.[1] ?? '';
    if (auth && cookie && auth !== cookie) {
      throw new CollabError('unauthenticated', 'conflicting authentication credentials');
    }
    const raw = auth || cookie;
    if (raw) {
      const found = LOCAL[raw];
      if (!found) throw new CollabError('unauthenticated', 'invalid token');
      return found;
    }
    return loopback ? { kind: 'auto-owner', identityId: 'owner', authKind: 'browser' } : { kind: 'anonymous' };
  };
  const ctx = { remoteAddress: '127.0.0.1', disableAutoOwner: false, autoOwnerCookie: 'off' as const };
  const resolve = (headers: Record<string, string>, loopback = false) =>
    resolveRelayCaller(headers, resolver(loopback), ctx);
  const code = async (headers: Record<string, string>, loopback = false) =>
    resolve(headers, loopback).then(() => 'ok', (e: unknown) => (e as CollabError).code);

  it('refuses no session with unauthenticated', async () => {
    expect(await code({})).toBe('unauthenticated');
  });

  it('refuses an agent token with forbidden, and does not fall back to the auto-owner', async () => {
    expect(await code({ authorization: 'Bearer tm8s_agent' }, true)).toBe('forbidden');
    expect(await code({ authorization: 'Bearer tm8s_runtime' }, true)).toBe('forbidden');
    expect(await code({ cookie: '__Host-tm8-session=tm8s_agent' })).toBe('forbidden');
  });

  it('admits a browser cookie and forwards the remote pass it carries', async () => {
    const caller = await resolve({
      cookie: '__Host-tm8-session=tm8s_browser',
      authorization: 'Bearer tm8s_remote',
    });
    expect(caller.identity.authKind).toBe('browser');
    expect(caller.forwardAuthorization).toBe(true);
  });

  it('does not forward Authorization when it is the same local token as the cookie', async () => {
    const caller = await resolve({
      cookie: '__Host-tm8-session=tm8s_browser',
      authorization: 'Bearer tm8s_browser',
    });
    expect(caller.forwardAuthorization).toBe(false);
  });

  it('admits a cli token and keeps it on this node', async () => {
    const caller = await resolve({ authorization: 'Bearer tm8s_cli' });
    expect(caller.identity.authKind).toBe('cli');
    expect(caller.forwardAuthorization).toBe(false);
  });

  it('treats an Authorization unknown here as the remote pass of the loopback owner', async () => {
    const caller = await resolve({ authorization: 'Bearer tm8s_remote' }, true);
    expect(caller.identity.kind).toBe('auto-owner');
    expect(caller.forwardAuthorization).toBe(true);
    // Off loopback the same request has no local caller at all.
    expect(await code({ authorization: 'Bearer tm8s_remote' })).toBe('unauthenticated');
  });
});
