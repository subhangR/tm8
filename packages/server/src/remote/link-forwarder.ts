/**
 * W9c: the HOME server's forwarder for a link whose target is on another
 * server. Wired only while `TM8_REMOTE_SPACE_LINKS` is on (forwarder.ts).
 *
 * W7's invoke has already applied the home-side guards (refused set, via
 * chain, own row, spawn switch, rate bucket) when this runs. It then:
 *
 *   1. reads the server entity's base URL under the caller's claims;
 *   2. opens the caller's own sealed link session in memory (never resolved
 *      here: it lives on the target);
 *   3. POSTs `{op, params, query, input}` to the target's
 *      `REMOTE_SPACE_LINK_PATHS.invoke` with the session as bearer and the
 *      via chain, through the guarded client (link-client.ts);
 *   4. maps the answer. 401 is the target no longer honouring the session:
 *      THIS module marks the home row `signed_out` (one owner, no retry). A
 *      404 without the route's marker is an older or switched-off target:
 *      `unsupported`, and the row is left alone.
 *
 * The session is never logged, never put in an error, never audited.
 */
import { REMOTE_SPACE_LINK_PATHS, SPACE_LINK_SPAWN_OPS } from '@tm8/contract';

import { SpaceLinkUnusable, type DbSpaceLinkStore } from '../credentials/space-link-store.js';
import type { RemoteInvokeForwarder, RemoteInvokeRequest, RemoteInvokeResult } from './forwarder.js';
import { REMOTE_INVOKE_TIMEOUT_MS, REMOTE_SPAWN_TIMEOUT_MS } from './forwarder.js';
import { dataOf, errorEnvelopeOf, postRemoteLink, type RemoteLinkClientOptions } from './link-client.js';
import type { DbServerStore } from './server-store.js';

/** Every answer of the target's `/link/v1/*` routes carries this, so a router's 404 is told apart. */
export const REMOTE_LINK_MARKER = 'remoteLink';
export const REMOTE_LINK_MARKER_VALUE = 'v1';

export function isRemoteLinkAnswer(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed[REMOTE_LINK_MARKER] === REMOTE_LINK_MARKER_VALUE;
  } catch {
    return false;
  }
}

export interface HttpsRemoteInvokeForwarderOptions {
  servers: DbServerStore;
  links: DbSpaceLinkStore;
  client?: RemoteLinkClientOptions;
}

export class HttpsRemoteInvokeForwarder implements RemoteInvokeForwarder {
  constructor(private readonly options: HttpsRemoteInvokeForwarderOptions) {}

  async forward(request: RemoteInvokeRequest): Promise<RemoteInvokeResult> {
    const { servers, links, client } = this.options;
    const server = await servers.get(request.claims, request.serverId);
    let token: string;
    try {
      token = await links.openRemote(request.claims, request.linkId);
    } catch (error) {
      // Already not signed in: say so without marking again.
      if (error instanceof SpaceLinkUnusable) return { kind: 'signed_out' };
      throw error;
    }

    const result = await postRemoteLink({
      baseUrl: server.baseUrl,
      path: REMOTE_SPACE_LINK_PATHS.invoke,
      body: {
        op: request.op,
        ...(request.params && Object.keys(request.params).length > 0 ? { params: request.params } : {}),
        ...(request.query && Object.keys(request.query).length > 0 ? { query: request.query } : {}),
        ...(request.input !== undefined ? { input: request.input } : {}),
      },
      bearer: token,
      via: request.via,
      timeoutMs: request.timeoutMs
        ?? (SPACE_LINK_SPAWN_OPS.includes(request.op) ? REMOTE_SPAWN_TIMEOUT_MS : REMOTE_INVOKE_TIMEOUT_MS),
    }, client ?? {});

    if (result.kind !== 'response') return result;
    const marked = isRemoteLinkAnswer(result.body);
    if (result.status === 404 && !marked) return { kind: 'unsupported' };
    // Only the route's own 401 says the session is dead; a proxy's 401 says nothing about it.
    if (result.status === 401 && marked) {
      await links.markStale(request.claims, request.linkId, 'signed_out',
        request.workSessionId ? { workSessionId: request.workSessionId } : {});
      return { kind: 'signed_out' };
    }
    if (result.status >= 200 && result.status < 300 && marked) {
      try {
        return { kind: 'ok', status: result.status, body: dataOf(result.body) };
      } catch {
        return { kind: 'refused', status: 502, code: 'upstream_unavailable', message: 'the linked server answered malformed JSON' };
      }
    }
    // A 3xx (never followed), a 5xx from a proxy, or the route's own refusal.
    const envelope = errorEnvelopeOf(result.body);
    return {
      kind: 'refused',
      status: result.status,
      code: envelope?.code ?? 'upstream_unavailable',
      message: envelope?.message ?? `the linked server answered ${result.status}`,
    };
  }
}
