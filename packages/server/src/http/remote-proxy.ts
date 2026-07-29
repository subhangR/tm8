import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

import { CollabError } from '@tm8/contract';

const PREFIX = /^\/v2\/server-connections\/([^/]+)\/proxy(?<upstream>\/.*)?$/;
const HOP_HEADER = 'x-tm8-server-proxy-hop';

export type ServerConnectionTargetResolver = (name: string) => Promise<string | null>;

export interface RemoteServerProxy {
  matches(pathname: string): boolean;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
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

function forwardedHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const next = { ...headers };
  delete next.host;
  delete next.origin;
  delete next.referer;
  delete next['content-length'];
  next.host = target.host;
  next[HOP_HEADER] = '1';
  return next;
}

function refuseUpgrade(socket: Duplex, status: number, body: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Bad Gateway'}\r\n` +
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
  async function targetFor(req: IncomingMessage): Promise<{ target: URL; upstream: string }> {
    if (req.headers[HOP_HEADER] !== undefined) {
      throw new CollabError('invariant_violation', 'named Server proxy loop refused');
    }
    const route = match(req);
    if (!route) throw new CollabError('not_found', 'not a named Server proxy route');
    const baseUrl = await resolveTarget(route.name);
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

    async handleHttp(req, res) {
      const { target } = await targetFor(req);
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      await new Promise<void>((resolve, reject) => {
        const upstream = send(target, {
          method: req.method ?? 'GET',
          headers: forwardedHeaders(req.headers, target),
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

    async handleUpgrade(req, socket, head) {
      let resolved: { target: URL };
      try {
        resolved = await targetFor(req);
      } catch (error) {
        refuseUpgrade(socket, error instanceof CollabError && error.code === 'not_found' ? 404 : 502,
          error instanceof Error ? error.message : String(error));
        return;
      }

      const { target } = resolved;
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstreamRequest = send(target, {
        method: 'GET',
        headers: forwardedHeaders(req.headers, target),
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
