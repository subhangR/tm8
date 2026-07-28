import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CollabError } from '@tm8/contract';

import type { DbClaims } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { W2BlobStore } from '../files/w2-blob-store.js';
import { sendWireError } from './errors.js';
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

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer\s+\S+$/i.test(header)) {
    throw new CollabError('unauthenticated', 'a FileUploadGrant bearer token is required');
  }
  return header.replace(/^Bearer\s+/i, '');
}

async function rawClaims(
  deps: FacadeDeps,
  identity: RequestIdentity,
  requestId: string,
): Promise<DbClaims> {
  if (identity.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  const owner = await deps.owner();
  const identityId = identity.kind === 'auto-owner' ? owner.identityId : identity.identityId;
  if (!identityId) throw new CollabError('unauthenticated', 'bearer identity is unresolved');
  return {
    identityId,
    nodeAdmin: identityId === owner.identityId ? owner.isNodeAdmin : false,
    requestId,
  };
}

/**
 * The one raw-byte PUT seam integration mounts outside the semantic router.
 *
 * It returns `false` for every other path/method. A handled request owns its
 * response, including errors, so the shared server never feeds raw bytes into
 * the JSON body reader and never discovers this support path as an operation.
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
      claims = await rawClaims(options.deps, context.identity, context.requestId);
      const token = bearerToken(req);
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
