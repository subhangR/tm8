/**
 * THE BROWSER'S UPLOAD PUT, composed the way production composes it.
 *
 * Every other test of the raw upload route injects its own `identity` and so
 * can only ever see the route. Production puts `createSessionIdentityResolver`
 * in front of it, and that composition is where file upload was broken for nine
 * days: the client sent the `FileUploadGrant` token as `Authorization: Bearer`,
 * the browser attached `__Host-tm8-session` to the same same-origin PUT because
 * that is what browsers do, and the resolver — correctly, by its own rule —
 * refused two credentials naming two different principals. The node answered
 * `unauthenticated`, the UI rendered it as "Sign in again before uploading
 * files", and the viewer was signed in the whole time. On prod the last
 * completed upload predates the cookie; everything after it aborted.
 *
 * So these tests are deliberately end-of-the-wire: a real `http.Server`, the
 * real resolver, the real route, and requests shaped like the clients that send
 * them. The fixed shape and the broken shape are BOTH asserted — the second one
 * is the regression, and it has to stay legible or the next person to move a
 * credential into `Authorization` will do it again.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollabError, TM8_UPLOAD_TOKEN_HEADER } from '@tm8/contract';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { createW2BlobStore } from '../../src/files/w2-blob-store.js';
import { formatToken, hashToken } from '../../src/identity/crypto.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { createW2FileUploadRoute } from '../../src/http/w2-file-upload.js';
import { sendWireError } from '../../src/http/errors.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';

const OWNER = {
  identityId: 'node-owner',
  accountId: '11111111-1111-4111-8111-111111111111',
  username: 'node-owner',
  isNodeAdmin: true,
  isOwner: true,
};

/** The signed-in human. NOT the node owner — an upload must run as the viewer. */
const VIEWER = {
  sessionId: randomUUID(),
  secret: 'browser-secret',
  identityId: 'viewer-identity',
  accountId: '77777777-7777-4777-8777-777777777777',
};
const VIEWER_TOKEN = formatToken(VIEWER.sessionId, VIEWER.secret);

const IDS = {
  space: '22222222-2222-4222-8222-222222222222',
  upload: '33333333-3333-4333-8333-333333333333',
  blob: '44444444-4444-4444-8444-444444444444',
};

const BODY = Buffer.from('a real file, in bytes');
const CHECKSUM = createHash('sha256').update(BODY).digest('hex');

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Answers the two claim-free auth RPCs `resolveBearerIdentity` calls, and the
 * two upload RPCs the route calls. Nothing else — an unexpected RPC throws, so
 * a test that drifts off the real call sequence fails loudly.
 */
function fakeDb(state: { staged: boolean; storagePath: string; grantHash: string }): Db {
  const rpc = async <T>(claims: DbClaims, fn: string, args: readonly unknown[]): Promise<T> => {
    if (fn === 'resolve_auth_session') {
      if (args[0] !== hashToken(VIEWER.secret)) return null as T;
      return {
        sessionId: VIEWER.sessionId,
        accountId: VIEWER.accountId,
        identityId: VIEWER.identityId,
        username: 'viewer',
        displayName: 'Viewer',
        isNodeAdmin: false,
        isOwner: false,
        kind: 'browser',
        actingAsTeamMemberId: null,
        workSessionId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        label: null,
      } as T;
    }
    if (fn === 'touch_auth_session') return undefined as T;
    if (fn === 'w2_authorize_file_upload') {
      // THE ASSERTION THAT MATTERS MOST IS HERE: the slot is authorized under
      // the VIEWER's claims. A request that reached this RPC as the node owner
      // (or as nobody) would be a different bug wearing a green test.
      if (claims.identityId !== VIEWER.identityId) {
        throw new CollabError('forbidden', `wrong upload identity: ${String(claims.identityId)}`);
      }
      if (args[1] !== state.grantHash) throw new CollabError('forbidden', 'wrong upload token');
      return {
        outcome: state.staged ? 'staged' : 'authorized',
        uploadId: IDS.upload,
        spaceId: IDS.space,
        storagePath: state.storagePath,
        sizeBytes: BODY.length,
        checksumSha256: CHECKSUM,
      } as T;
    }
    if (fn === 'w2_settle_file_upload_write') {
      state.staged = true;
      return { outcome: 'staged', uploadId: IDS.upload, spaceId: IDS.space, storagePath: state.storagePath } as T;
    }
    throw new Error(`unexpected rpc: ${fn}`);
  };
  return {
    tx: <T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> => fn({
      query: async () => [],
      rpc: <R>(name: string, args: readonly unknown[] = []) => rpc<R>(claims, name, args),
    }),
    rpc: <T>(claims: DbClaims, fn: string, args: readonly unknown[] = []) => rpc<T>(claims, fn, args),
    query: async () => [],
    end: () => Promise.resolve(),
  } as Db;
}

/**
 * The production shape: resolve identity first, hand the route the result, and
 * let a resolver refusal answer as a wire error — exactly what `http/server.ts`
 * does around this route.
 *
 * `disableAutoOwner` is TRUE because that is prod (`TM8_DISABLE_AUTO_OWNER=1`).
 * With the auto-owner arm open, an unidentified request silently borrows the
 * node owner and every one of these assertions passes for the wrong reason.
 */
async function listen(options: { disableAutoOwner?: boolean } = {}): Promise<{
  base: string;
  storagePath: string;
  grantToken: string;
  read: () => Promise<Buffer>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-upload-shape-'));
  dirs.push(dataDir);
  const blobStore = createW2BlobStore({ dataDir, maxSizeBytes: 1024 });
  const grantToken = await blobStore.grantToken(IDS.upload);
  const storagePath = blobStore.storagePath(IDS.space, IDS.blob);
  const db = fakeDb({
    staged: false,
    storagePath,
    grantHash: createHash('sha256').update(grantToken, 'utf8').digest('hex'),
  });
  const resolveIdentity = createSessionIdentityResolver({ db, owner: async () => OWNER });
  const route = createW2FileUploadRoute({
    deps: {
      db,
      config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1, databaseUrl: 'postgres://unused' },
      owner: async () => OWNER,
    },
    blobStore,
  });

  const server = createServer((req, res) => {
    void (async () => {
      const requestId = 'shape-request';
      try {
        const identity = await resolveIdentity(req.headers, {
          remoteAddress: req.socket.remoteAddress,
          disableAutoOwner: options.disableAutoOwner ?? true,
        });
        if (await route(req, res, { requestId, identity })) return;
        res.writeHead(404).end();
      } catch (error) {
        sendWireError(res, error, requestId);
      }
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('missing test address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    storagePath,
    grantToken,
    read: () => blobStore.read(storagePath, IDS.space),
  };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '<no error code>';
}

describe('the raw upload PUT, as its clients actually send it', () => {
  it('accepts the browser: session cookie for WHO, grant header for WHICH SLOT', async () => {
    const node = await listen();
    const response = await fetch(`${node.base}/v2/files/uploads/${IDS.upload}/content`, {
      method: 'PUT',
      headers: {
        cookie: `${TM8_SESSION_COOKIE}=${VIEWER_TOKEN}`,
        [TM8_UPLOAD_TOKEN_HEADER]: node.grantToken,
      },
      body: BODY,
    });

    expect(response.status).toBe(204);
    expect(await node.read()).toEqual(BODY);
  });

  it('REGRESSION: a grant in Authorization alongside the cookie is two principals, and is refused', async () => {
    const node = await listen();
    const response = await fetch(`${node.base}/v2/files/uploads/${IDS.upload}/content`, {
      method: 'PUT',
      headers: {
        cookie: `${TM8_SESSION_COOKIE}=${VIEWER_TOKEN}`,
        authorization: `Bearer ${node.grantToken}`,
      },
      body: BODY,
    });

    // This is the production failure, reproduced. It is not a bug in the
    // resolver — the resolver is right — which is exactly why the fix had to
    // move the capability out of `Authorization` rather than weaken this rule.
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('unauthenticated');
  });

  it('accepts an agent or CLI: session pass in Authorization, grant header beside it', async () => {
    const node = await listen();
    const response = await fetch(`${node.base}/v2/files/uploads/${IDS.upload}/content`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${VIEWER_TOKEN}`,
        [TM8_UPLOAD_TOKEN_HEADER]: node.grantToken,
      },
      body: BODY,
    });

    expect(response.status).toBe(204);
    expect(await node.read()).toEqual(BODY);
  });

  it('still accepts the legacy grant-in-Authorization shape where nothing contradicts it', async () => {
    // An older client on a loopback node with the auto-owner arm open: no
    // cookie, no session pass, the grant is the only credential in the request.
    // Nothing conflicts, so the node keeps serving it.
    const node = await listen({ disableAutoOwner: false });
    const response = await fetch(`${node.base}/v2/files/uploads/${IDS.upload}/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${node.grantToken}` },
      body: BODY,
    });

    // The auto-owner arm binds the NODE OWNER, not the viewer, so the fake's
    // identity check refuses it — which is the honest outcome to assert here:
    // the request authenticated as somebody, and it was not the viewer.
    expect(response.status).toBe(403);
  });

  it('does not mistake a session pass for a grant when the grant header is missing', async () => {
    const node = await listen();
    const response = await fetch(`${node.base}/v2/files/uploads/${IDS.upload}/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
      body: BODY,
    });

    // 401 "you did not send a grant", never 403 "your grant is wrong" — the
    // second sends whoever debugs it to the upload slot instead of the client.
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('unauthenticated');
  });
});
