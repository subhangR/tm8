/**
 * `POST /v2/clipboard/images?sessionId=<uuid>` — the clipboard file handoff.
 *
 * Raw bytes in, an absolute node-local path out. The path is then typed into
 * that session's PTY as plain text, which is what makes paste work for every
 * agent without teaching the terminal any agent's inline-file protocol.
 *
 * THE PATH KEEPS ITS `/images` SPELLING even though the store now takes the
 * whole agent-readable set (R2). A URL is a wire identifier: renaming it would
 * break every already-loaded tab mid-session to buy a tidier noun, and the
 * route has always carried whatever the store accepted.
 *
 * Like the FileUploadGrant PUT this is a SUPPORT transport, not a catalog
 * operation: it carries raw bytes, so it must be dispatched before the shared
 * JSON body reader, and it has no place in a grammar that describes the graph.
 *
 * Authorization reuses the PTY-attach vocabulary exactly (main.ts): the caller
 * must be able to SEE the work_session entity under their own claims. RLS
 * decides, so membership of the owning Space is the only rule, and there is no
 * second authorization vocabulary here. The same read yields the Space the
 * image is bucketed under, so visibility and placement can never disagree.
 * Not-visible and nonexistent are both 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CollabError } from '@tm8/contract';

import type { FacadeDeps } from '../facade/deps.js';
import type { ClipboardStore } from '../files/clipboard-store.js';
import { readRawBody } from './body.js';
import { sendWireError } from './errors.js';
import { supportClaims } from './support-claims.js';
import type { RequestIdentity } from './types.js';

export const CLIPBOARD_UPLOAD_PATH = '/v2/clipboard/images';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClipboardUploadRouteContext {
  readonly requestId: string;
  readonly identity: RequestIdentity;
}

export interface ClipboardUploadRouteOptions {
  readonly deps: FacadeDeps;
  readonly store: ClipboardStore;
}

export type ClipboardUploadRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  context: ClipboardUploadRouteContext,
) => Promise<boolean>;

export function createClipboardUploadRoute(
  options: ClipboardUploadRouteOptions,
): ClipboardUploadRoute {
  return async (req, res, context) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    if (method !== 'POST' || url.pathname !== CLIPBOARD_UPLOAD_PATH) return false;

    try {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (!UUID_SHAPE.test(sessionId)) {
        req.resume();
        throw new CollabError('not_found', 'no such session');
      }

      const claims = await supportClaims(options.deps, context.identity, context.requestId);
      const rows = await options.deps.db.query<{ space_id: string }>(
        claims,
        'select space_id from public.entities where id = $1 and deleted_at is null',
        [sessionId],
      );
      const spaceId = rows[0]?.space_id;
      if (!spaceId) {
        req.resume();
        throw new CollabError('not_found', 'no such session');
      }

      // Bounded BEFORE the store sees anything: an oversized paste is refused
      // while streaming, so it is never fully buffered.
      const data = await readRawBody(req, options.store.maxBytes);
      const stored = await options.store.store({
        data,
        declaredMimeType: req.headers['content-type'],
        /* The viewer's own filename, when the paste had one. Header rather
           than a query parameter because it is content metadata, and used for
           its EXTENSION only — the store generates the name it writes. */
        declaredFilename: headerValue(req.headers['x-tm8-filename']),
        spaceId,
      });

      const payload = JSON.stringify({
        path: stored.path,
        filename: stored.filename,
        mimeType: stored.mimeType,
        bytes: stored.bytes,
      });
      res.writeHead(201, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'x-content-type-options': 'nosniff',
        'x-tm8-request-id': context.requestId,
      });
      res.end(payload);
      return true;
    } catch (error) {
      sendWireError(res, error, context.requestId);
      return true;
    }
  };
}

/**
 * One header value, or nothing. A repeated header arrives as an array, and
 * "the first of two filenames" is a guess — the store's extension fallback is
 * a better answer than a coin toss.
 */
function headerValue(raw: string | string[] | undefined): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}
