import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

import { CollabError } from '@tm8/contract';

import { readTm8SessionCookie } from './session-cookie.js';
import type { IdentityResolutionContext, IdentityResolver, RequestIdentity } from './types.js';

const PREFIX = /^\/v2\/server-connections\/([^/]+)\/proxy(?<upstream>\/.*)?$/;
const HOP_HEADER = 'x-tm8-server-proxy-hop';

/**
 * Looks the named connection up UNDER THE CALLER'S CLAIMS — never the node
 * owner's. `server_connections` is readable by node admins only (044), so a
 * human who is not one gets `null` (an honest `not_found`) until per-member
 * links exist.
 */
export type ServerConnectionTargetResolver = (
  name: string,
  caller: RequestIdentity,
) => Promise<string | null>;

/**
 * Who is asking this node to relay, and whether the `Authorization` header is
 * theirs to hand onward. See `resolveRelayCaller`.
 */
export interface RelayCaller {
  readonly identity: RequestIdentity;
  /** False when `Authorization` carried THIS node's session: it stays here. */
  readonly forwardAuthorization: boolean;
}

export interface RemoteServerProxy {
  matches(pathname: string): boolean;
  handleHttp(req: IncomingMessage, res: ServerResponse, caller: RelayCaller): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, caller: RelayCaller): Promise<void>;
}

const HUMAN_AUTH_KINDS: ReadonlySet<string> = new Set(['browser', 'cli']);

/**
 * A revoked or expired LOCAL token with no cookie beside it. It is never
 * forwarded either way. 'drop': the caller is whatever the request is without
 * it (the loopback auto-owner, or anonymous -> 401), as if no header had been
 * sent. 'refuse': 401, as every other route answers a dead credential.
 * PENDING a trust ruling (task 01a0da1f); flipping it is this one line plus the
 * T26 cell named 'DEAD-LOCAL-NO-COOKIE'.
 */
const DEAD_LOCAL_TOKEN_WITHOUT_COOKIE: 'drop' | 'refuse' = 'drop';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof CollabError && error.code === 'unauthenticated';
}

/**
 * THE RELAY IS A HUMAN'S TOOL, AND IT RUNS UNDER THAT HUMAN'S CLAIMS.
 *
 * It used to dispatch before any identity was resolved and to look the target
 * up as the node owner, so any caller that could reach the port — no session,
 * or an agent's token — could drive every registered remote (G1).
 *
 * Two carriers ride a relayed request and they mean different things. The
 * session COOKIE is always this node's (it is host-scoped; the remote never set
 * it). `Authorization` is normally the REMOTE's pass — a browser signed in to
 * the remote sends it alongside this node's cookie — which is why the ordinary
 * resolver cannot be used as-is here: it refuses two credentials that disagree.
 * So:
 *
 *   - cookie present: the cookie alone names the local caller, and
 *     `Authorization` is forwarded unless it is that same local token;
 *   - no cookie, `Authorization` resolves HERE: it is this node's session (a
 *     CLI, or an agent) — it names the caller and is NOT forwarded, because a
 *     remote is someone else's machine;
 *   - no cookie, `Authorization` is unknown here: it is the remote's pass, and
 *     the local caller is whatever the request is without it (the loopback
 *     auto-owner, or anonymous).
 *
 * "Unknown here" is not "does not resolve here". A LOCAL token that is revoked
 * or expired does not resolve either, and it has the same `tm8s_<uuid>.<secret>`
 * shape as a remote's pass. So before anything is forwarded, `issuedHere` asks
 * whether this node ever issued that session id, in any state (236); if it did,
 * the token is ours and is dropped, never forwarded. The probe sees the token
 * only to parse out the id; the secret never reaches the database. Without a
 * probe (no database: nothing can resolve a token anyway) the old rule stands.
 *
 * Then: anonymous is `unauthenticated`; anything but a browser/cli session is
 * `forbidden`. The auto-owner resolves as `browser` (identity-resolver.ts).
 */
export async function resolveRelayCaller(
  headers: IncomingHttpHeaders,
  resolveIdentity: IdentityResolver,
  context: IdentityResolutionContext,
  issuedHere?: (token: string) => Promise<boolean>,
): Promise<RelayCaller> {
  const { authorization, ...withoutAuthorization } = headers;
  const presented = typeof authorization === 'string'
    ? authorization.replace(/^Bearer\s+/i, '').trim()
    : '';
  const cookie = readTm8SessionCookie(headers) ?? '';

  let caller: RelayCaller;
  if (cookie) {
    caller = {
      identity: await resolveIdentity(withoutAuthorization, context),
      forwardAuthorization: presented !== '' && presented !== cookie && !(await issuedHere?.(presented)),
    };
  } else if (presented) {
    try {
      const identity = await resolveIdentity(headers, context);
      caller = { identity, forwardAuthorization: identity.kind !== 'bearer' };
    } catch (error) {
      if (!isUnauthenticated(error)) throw error;
      const ours = (await issuedHere?.(presented)) === true;
      if (ours && DEAD_LOCAL_TOKEN_WITHOUT_COOKIE === 'refuse') throw error;
      caller = {
        identity: await resolveIdentity(withoutAuthorization, context),
        forwardAuthorization: !ours,
      };
    }
  } else {
    caller = { identity: await resolveIdentity(headers, context), forwardAuthorization: false };
  }

  if (caller.identity.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'the named Server relay requires a signed-in session');
  }
  if (!caller.identity.authKind || !HUMAN_AUTH_KINDS.has(caller.identity.authKind)) {
    throw new CollabError('forbidden', 'the named Server relay is for browser and cli sessions only');
  }
  return caller;
}

function match(req: IncomingMessage): { name: string; upstream: string } | null {
  const url = new URL(req.url ?? '/', 'http://tm8.invalid');
  const found = PREFIX.exec(url.pathname);
  if (!found) return null;
  let name: string;
  try {
    name = decodeURIComponent(found[1] ?? '').toLowerCase();
  } catch {
    throw new CollabError('invalid_input', 'server connection name is not valid URL text');
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new CollabError('invalid_input', 'server connection name is invalid');
  }
  const upstream = found.groups?.upstream ?? '/';
  if (upstream !== '/health' && upstream !== '/v2' && !upstream.startsWith('/v2/')) {
    throw new CollabError('not_found', `the named Server proxy does not expose ${upstream}`);
  }
  return { name, upstream: `${upstream}${url.search}` };
}

/**
 * COOKIES DO NOT CROSS NODES, and forwarding one is both a leak and a break.
 *
 * Cookies are scoped by host and ignore port, so the `__Host-tm8-session`
 * cookie this node sets for its own origin rides along on every browser
 * request the relay carries — to a Server that has no business seeing it. Two
 * consequences, and the second is the one that shows up as a bug report:
 *
 *   - DISCLOSURE. The local node's session credential is handed to every
 *     registered remote, each of which can replay it back here. A remote is
 *     someone else's machine; it is not inside this node's trust boundary.
 *   - REFUSAL. Once signed in to the remote, the browser holds a pass for it
 *     AND this node's cookie. `identity-resolver.ts` requires that two
 *     present credentials name the same token and otherwise refuses with
 *     `conflicting authentication credentials` — so EVERY relayed operation
 *     fails, not just sign-in. `auth.login`/`auth.signup` escape it via the
 *     dead-carrier strip in `server.ts`, which is why sign-in appears to work
 *     and everything after it does not.
 *
 * `authorization` is still forwarded when it is the remote's own carrier — the
 * thing the caller meant to send — and dropped when it is THIS node's session
 * (`RelayCaller.forwardAuthorization`, decided in `resolveRelayCaller`).
 *
 * NOTE THE SHAPE OF THIS FUNCTION, because it is how the bug got here. A
 * deny-list forwards every header nobody thought to name, so each new
 * credential header is a leak until someone remembers it. An allow-list would
 * fail closed instead. That is a wider change than a blocked deploy should
 * carry, so it is filed rather than smuggled in here.
 */
function forwardedHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  caller: RelayCaller,
): IncomingHttpHeaders {
  const next = { ...headers };
  if (!caller.forwardAuthorization) delete next.authorization;
  delete next.host;
  delete next.origin;
  delete next.referer;
  delete next['content-length'];
  delete next.cookie;
  next.host = target.host;
  next[HOP_HEADER] = '1';
  return next;
}

const UPGRADE_STATUS_TEXT: Readonly<Record<number, string>> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
};

export function upgradeRefusalStatus(error: unknown): number {
  if (!(error instanceof CollabError)) return 502;
  if (error.code === 'unauthenticated') return 401;
  if (error.code === 'forbidden') return 403;
  if (error.code === 'not_found') return 404;
  return 502;
}

export function refuseUpgrade(socket: Duplex, status: number, body: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${UPGRADE_STATUS_TEXT[status] ?? 'Bad Gateway'}\r\n` +
      'connection: close\r\n' +
      'content-type: text/plain; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

function responseHead(response: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export function createRemoteServerProxy(resolveTarget: ServerConnectionTargetResolver): RemoteServerProxy {
  async function targetFor(
    req: IncomingMessage,
    caller: RelayCaller,
  ): Promise<{ target: URL; upstream: string }> {
    if (req.headers[HOP_HEADER] !== undefined) {
      throw new CollabError('invariant_violation', 'named Server proxy loop refused');
    }
    const route = match(req);
    if (!route) throw new CollabError('not_found', 'not a named Server proxy route');
    const baseUrl = await resolveTarget(route.name, caller.identity);
    if (!baseUrl) throw new CollabError('not_found', `no such server connection: ${route.name}`);
    const target = new URL(baseUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new CollabError('invalid_input', 'server connection URL must use http or https');
    }
    target.pathname = route.upstream.split('?')[0] ?? '/';
    target.search = route.upstream.includes('?') ? route.upstream.slice(route.upstream.indexOf('?')) : '';
    return { target, upstream: route.upstream };
  }

  return {
    matches(pathname) {
      return PREFIX.test(pathname);
    },

    async handleHttp(req, res, caller) {
      const { target } = await targetFor(req, caller);
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      await new Promise<void>((resolve, reject) => {
        const upstream = send(target, {
          method: req.method ?? 'GET',
          headers: forwardedHeaders(req.headers, target, caller),
        }, (reply) => {
          const headers = { ...reply.headers };
          delete headers['access-control-allow-origin'];
          res.writeHead(reply.statusCode ?? 502, headers);
          reply.pipe(res);
          reply.once('end', resolve);
          reply.once('error', reject);
        });
        upstream.once('error', (error) => reject(
          new CollabError('upstream_unavailable', `cannot reach named tm8 Server: ${error.message}`),
        ));
        req.once('aborted', () => upstream.destroy());
        req.pipe(upstream);
      });
    },

    async handleUpgrade(req, socket, head, caller) {
      let resolved: { target: URL };
      try {
        resolved = await targetFor(req, caller);
      } catch (error) {
        refuseUpgrade(socket, upgradeRefusalStatus(error),
          error instanceof Error ? error.message : String(error));
        return;
      }

      const { target } = resolved;
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstreamRequest = send(target, {
        method: 'GET',
        headers: forwardedHeaders(req.headers, target, caller),
      });

      upstreamRequest.once('upgrade', (reply, upstreamSocket, upstreamHead) => {
        socket.write(responseHead(reply));
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
        socket.once('error', () => upstreamSocket.destroy());
        upstreamSocket.once('error', () => socket.destroy());
      });
      upstreamRequest.once('response', (reply) => {
        refuseUpgrade(socket, reply.statusCode ?? 502, 'named Server refused the WebSocket upgrade');
        reply.resume();
      });
      upstreamRequest.once('error', (error) => refuseUpgrade(socket, 502, error.message));
      upstreamRequest.end();
    },
  };
}
