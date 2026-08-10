import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CollabError, TM8_UPLOAD_TOKEN_HEADER } from '@tm8/contract';

import type { DbClaims } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { W2BlobStore } from '../files/w2-blob-store.js';
import { TOKEN_PREFIX } from '../identity/crypto.js';
import { sendWireError } from './errors.js';
import { supportClaims } from './support-claims.js';
import type { RequestIdentity } from './types.js';

const RAW_UPLOAD_PATH = /^\/v2\/files\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/;

interface RawAuthorizeResult {
  outcome: 'authorized' | 'staged' | 'completed' | 'aborted' | 'expired';
  uploadId: string;
  spaceId: string;
  storagePath: string;
  sizeBytes: number;
  checksumSha256: string;
}

interface RawSettleResult {
  outcome: 'staged' | 'aborted' | 'expired';
  uploadId: string;
  spaceId: string;
  storagePath: string;
}

export interface W2FileUploadRouteContext {
  readonly requestId: string;
  readonly identity: RequestIdentity;
}

export interface W2FileUploadRouteOptions {
  readonly deps: FacadeDeps;
  readonly blobStore: W2BlobStore;
}

export type W2FileUploadRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  context: W2FileUploadRouteContext,
) => Promise<boolean>;

/**
 * The grant token, from the header that means "which upload slot".
 *
 * `x-tm8-upload-token` is the carrier. `Authorization` is the LEGACY one and is
 * still honoured, because the identity on this route may legitimately come from
 * nowhere else: on a loopback auto-owner node the CLI has no session to send,
 * so a grant in `Authorization` is the only credential in the request and there
 * is nothing for it to conflict with.
 *
 * What the fallback must NOT do is read a tm8 SESSION token as a grant. A
 * caller that authenticates with `Authorization: Bearer tm8s_…` and forgets the
 * grant header is missing its capability, not presenting a bad one — hashing
 * the session pass into `w2_authorize_file_upload` would answer `forbidden` and
 * send whoever debugs it looking at the upload slot instead of at the client.
 */
function grantToken(req: IncomingMessage): string {
  const explicit = req.headers[TM8_UPLOAD_TOKEN_HEADER];
  const supplied = Array.isArray(explicit) ? explicit[0] : explicit;
  if (typeof supplied === 'string' && supplied.trim() !== '') {
    return supplied.trim().replace(/^Bearer\s+/i, '');
  }
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer\s+\S+$/i.test(header)) {
    throw new CollabError('unauthenticated', 'a FileUploadGrant bearer token is required');
  }
  const legacy = header.replace(/^Bearer\s+/i, '');
  if (legacy.startsWith(TOKEN_PREFIX)) {
    throw new CollabError(
      'unauthenticated',
      `a FileUploadGrant bearer token is required in ${TM8_UPLOAD_TOKEN_HEADER}`,
    );
  }
  return legacy;
}

/**
 * The one raw-byte PUT seam integration mounts outside the semantic router.
 *
 * It returns `false` for every other path/method. A handled request owns its
 * response, including errors, so the shared server never feeds raw bytes into
 * the JSON body reader and never discovers this support path as an operation.
 *
 * TWO credentials, and they answer different questions. `context.identity` is
 * WHO — resolved upstream from the session cookie or an `Authorization` pass,
 * exactly as for every catalog operation, because `w2_authorize_file_upload`
 * runs under that caller's claims. `TM8_UPLOAD_TOKEN_HEADER` is WHICH SLOT —
 * a capability the node minted at `uploadInit`, verified here by hash. Carrying
 * the capability in `Authorization` (as this route originally required) makes
 * the two indistinguishable to the identity path and costs the caller its
 * identity; see the header's docblock in the contract.
 */
export function createW2FileUploadRoute(options: W2FileUploadRouteOptions): W2FileUploadRoute {
  return async (req, res, context) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://tm8.invalid').pathname;
    const match = RAW_UPLOAD_PATH.exec(pathname);
    if (method !== 'PUT' || !match?.[1]) return false;

    const uploadId = match[1];
    let authorize: RawAuthorizeResult | undefined;
    let leaseId: string | undefined;
    let tokenHash: string | undefined;
    let claims: DbClaims | undefined;

    try {
      claims = await supportClaims(options.deps, context.identity, context.requestId);
      const token = grantToken(req);
      tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
      leaseId = randomUUID();
      authorize = await options.deps.db.rpc<RawAuthorizeResult>(
        claims,
        'w2_authorize_file_upload',
        [uploadId, tokenHash, leaseId],
      );

      if (authorize.outcome === 'staged') {
        req.resume();
        res.writeHead(204, {
          'x-content-type-options': 'nosniff',
          'x-tm8-request-id': context.requestId,
        });
        res.end();
        return true;
      }
      if (authorize.outcome === 'expired') {
        req.resume();
        await options.blobStore.remove(authorize.storagePath, authorize.spaceId);
        throw new CollabError('invalid_input', 'upload slot has expired');
      }
      if (authorize.outcome !== 'authorized') {
        req.resume();
        throw new CollabError('invalid_input', `upload slot is ${authorize.outcome}`);
      }

      let verified;
      try {
        verified = await options.blobStore.writeUpload({
          stream: req,
          storagePath: authorize.storagePath,
          expectedSpaceId: authorize.spaceId,
          expectedSizeBytes: Number(authorize.sizeBytes),
          expectedChecksumSha256: authorize.checksumSha256,
        });
      } catch (error) {
        await options.deps.db.rpc<RawSettleResult>(
          claims,
          'w2_settle_file_upload_write',
          [uploadId, tokenHash, leaseId, false, null, null],
        ).catch(() => undefined);
        throw error;
      }

      const settled = await options.deps.db.rpc<RawSettleResult>(
        claims,
        'w2_settle_file_upload_write',
        [uploadId, tokenHash, leaseId, true, verified.sizeBytes, verified.checksumSha256],
      );
      if (settled.outcome !== 'staged') {
        await options.blobStore.remove(authorize.storagePath, authorize.spaceId);
        throw new CollabError('invalid_input', `upload slot is ${settled.outcome}`);
      }

      res.writeHead(204, {
        'x-content-type-options': 'nosniff',
        'x-tm8-request-id': context.requestId,
      });
      res.end();
      return true;
    } catch (error) {
      // If database settlement failed after the file became visible, it is not
      // a staged upload and complete must never observe it.
      if (authorize?.outcome === 'authorized' && authorize.storagePath && authorize.spaceId) {
        const staged = await options.deps.db.query<{ staged_at: Date | string | null }>(
          claims ?? {},
          `select staged_at from public.file_upload_slots where id=$1`,
          [uploadId],
        ).catch(() => []);
        if (staged[0]?.staged_at == null) {
          await options.blobStore.remove(authorize.storagePath, authorize.spaceId).catch(() => undefined);
        }
      }
      sendWireError(res, error, context.requestId);
      return true;
    }
  };
}
