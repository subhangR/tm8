import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteServerProxy } from '../src/http/remote-proxy';

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

  async function relay(headers: Record<string, string>): Promise<void> {
    const proxy = createRemoteServerProxy(async () => origin);
    // Drive the proxy the way the http server does: a request object shaped
    // like the one Node hands it, and a real socket to write the reply into.
    const relayServer = createServer((req, res) => {
      void proxy.handleHttp(req, res);
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

  it('rewrites host to the target and marks the hop', async () => {
    seen = null;
    await relay({ cookie: 'a=b', 'content-type': 'application/json' });
    expect(seen?.host).toBe(new URL(origin).host);
    expect(seen?.['x-tm8-server-proxy-hop']).toBe('1');
  });
});
