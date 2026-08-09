import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  CollabError,
  CommandResultSchema,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  FileUploadGrantSchema,
  getOperation,
  type OperationName,
} from '@tm8/contract';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { registerW2FileHandlers } from '../../src/facade/handlers/w2/files.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createW2BlobStore } from '../../src/files/w2-blob-store.js';
import { createW2FileUploadRoute } from '../../src/http/w2-file-upload.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const OWNER = {
  identityId: 'file-owner',
  accountId: '11111111-1111-4111-8111-111111111111',
  username: 'file-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const IDS = {
  space: '22222222-2222-4222-8222-222222222222',
  upload: '33333333-3333-4333-8333-333333333333',
  blob: '44444444-4444-4444-8444-444444444444',
  file: '55555555-5555-4555-8555-555555555555',
  target: '66666666-6666-4666-8666-666666666666',
};

const BODY = Buffer.from([0, 1, 2, 3, 4, 255, 128, 64]);
const CHECKSUM = createHash('sha256').update(BODY).digest('hex');

class FakeDb implements Db {
  readonly calls: Array<{ kind: 'query' | 'rpc'; claims: DbClaims; name: string; args: readonly unknown[] }> = [];
  queryImpl: <R>(claims: DbClaims, sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(claims: DbClaims, fn: string, args: readonly unknown[]) => Promise<T> = async () => {
    throw new Error(`unexpected rpc: ${fn}`);
  };

  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(sql: string, params: readonly unknown[] = []) => {
        this.calls.push({ kind: 'query', claims, name: sql, args: params });
        return this.queryImpl<R>(claims, sql, params);
      },
      rpc: async <R>(name: string, args: readonly unknown[] = []) => {
        this.calls.push({ kind: 'rpc', claims, name, args });
        return this.rpcImpl<R>(claims, name, args);
      },
    });
  }

  async rpc<T>(claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ kind: 'rpc', claims, name: fn, args });
    return this.rpcImpl<T>(claims, fn, args);
  }

  async query<R>(claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    this.calls.push({ kind: 'query', claims, name: sql, args: params });
    return this.queryImpl<R>(claims, sql, params);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function request(
  opName: OperationName,
  options: { params?: Record<string, string>; body?: unknown; identityId?: string } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(),
    body: options.body,
    requestId: `request-${opName}`,
    identity: { kind: 'auto-owner', identityId: options.identityId ?? OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function configuredRegistry(db: Db, dataDir: string): HandlerRegistry {
  const registry = new HandlerRegistry();
  const maxSizeBytes = 64;
  registerW2FileHandlers(
    registry,
    {
      db,
      config: {
        host: '127.0.0.1',
        port: 0,
        uiDir: undefined,
        maxBodyBytes: 1024 * 1024,
        databaseUrl: 'postgres://unused',
      },
      owner: async () => OWNER,
    },
    {
      blobStore: createW2BlobStore({ dataDir, maxSizeBytes }),
      maxSizeBytes,
    },
  );
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing handler: ${name}`);
  return value;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const tempDirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'tm8-w2-files-'));
  tempDirs.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('W2.G07 file facade and blob store', () => {
  it('registers exactly the four v1 file operations and leaves bridge.fetchBlob reserved', async () => {
    const dataDir = await tempDataDir();
    const registry = configuredRegistry(new FakeDb(), dataDir);
    expect(registry.implemented()).toEqual([
      'files.download',
      'files.uploadAbort',
      'files.uploadComplete',
      'files.uploadInit',
    ]);
    expect(registry.has('bridge.fetchBlob')).toBe(false);
  });

  it('accepts and echoes an effective ceiling above the default and refuses a smaller configured ceiling', async () => {
    const dataDir = await tempDataDir();
    const raisedLimit = FILE_MAX_SIZE_BYTES_DEFAULT + 1;
    const raisedStore = createW2BlobStore({ dataDir, maxSizeBytes: raisedLimit });
    const db = new FakeDb();
    db.rpcImpl = async <T>(_claims, fn, args) => {
      expect(fn).toBe('w2_init_file_upload');
      return {
        uploadId: String(args[0]),
        storagePath: raisedStore.storagePath(IDS.space, String(args[7])),
        expiresAt: new Date('2026-07-26T12:15:00.000Z').toISOString(),
        maxSizeBytes: Number(args[11]),
      } as T;
    };
    const raisedRegistry = new HandlerRegistry();
    registerW2FileHandlers(
      raisedRegistry,
      {
        db,
        config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: 'postgres://unused' },
        owner: async () => OWNER,
      },
      { blobStore: raisedStore, maxSizeBytes: raisedLimit },
    );
    const input = {
      clientMutationId: 'raised-file-limit',
      spaceId: IDS.space,
      name: 'metadata-only.bin',
      mime: 'application/octet-stream',
      sizeBytes: 65,
      checksumSha256: CHECKSUM,
    };
    const grant = await handler(raisedRegistry, 'files.uploadInit')(
      request('files.uploadInit', { body: input }),
    );
    expect(grant).toMatchObject({ maxSizeBytes: raisedLimit });

    const smallRegistry = configuredRegistry(new FakeDb(), await tempDataDir());
    await expect(handler(smallRegistry, 'files.uploadInit')(
      request('files.uploadInit', { body: input }),
    )).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('creates one frozen grant whose client filename is never a path component', async () => {
    const dataDir = await tempDataDir();
    const db = new FakeDb();
    db.rpcImpl = async <T>(_claims, fn, args) => {
      expect(fn).toBe('w2_init_file_upload');
      const uploadId = String(args[0]);
      const storageBlobId = String(args[7]);
      return {
        uploadId,
        storagePath: `spaces/${IDS.space}/${storageBlobId}`,
        expiresAt: new Date('2026-07-26T12:15:00.000Z').toISOString(),
        maxSizeBytes: 64,
      } as T;
    };
    const registry = configuredRegistry(db, dataDir);
    const result = await handler(registry, 'files.uploadInit')(
      request('files.uploadInit', {
        body: {
          clientMutationId: 'file-init-1',
          spaceId: IDS.space,
          name: '../../escape\r\nX-Evil: yes.txt',
          mime: 'application/octet-stream',
          sizeBytes: BODY.length,
          checksumSha256: CHECKSUM,
          entityId: IDS.target,
        },
      }),
    );

    expect(FileUploadGrantSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      uploadUrl: expect.stringMatching(/^\/v2\/files\/uploads\/[0-9a-f-]{36}\/content$/),
      token: expect.any(String),
      maxSizeBytes: 64,
    });
    expect(JSON.stringify(result)).not.toContain('escape');
    const call = db.calls.find((entry) => entry.kind === 'rpc');
    expect(call?.args[3]).toBe('../../escape\r\nX-Evil: yes.txt');
    expect(String(call?.args[8])).toMatch(/^[a-f0-9]{64}$/);
  });

  it('streams bytes to a contained server-generated path and removes every failed staging artifact', async () => {
    const dataDir = await tempDataDir();
    const store = createW2BlobStore({ dataDir, maxSizeBytes: BODY.length });
    const storagePath = store.storagePath(IDS.space, IDS.blob);

    await expect(store.writeUpload({
      stream: Readable.from([BODY.subarray(0, 3), BODY.subarray(3)]),
      storagePath,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    })).resolves.toEqual({ sizeBytes: BODY.length, checksumSha256: CHECKSUM });

    expect(await store.read(storagePath, IDS.space)).toEqual(BODY);
    expect(await readFile(join(dataDir, 'blobs', storagePath))).toEqual(BODY);
    await expect(store.read('../outside', IDS.space)).rejects.toMatchObject({ code: 'invalid_input' });

    const attackedDataDir = await tempDataDir();
    const outsideDataDir = await tempDataDir();
    await symlink(outsideDataDir, join(attackedDataDir, 'blobs'), 'dir');
    const attackedStore = createW2BlobStore({ dataDir: attackedDataDir, maxSizeBytes: BODY.length });
    await expect(attackedStore.read(
      attackedStore.storagePath(IDS.space, randomUUID()),
      IDS.space,
    )).rejects.toMatchObject({ code: 'invalid_input' });

    const second = store.storagePath(IDS.space, randomUUID());
    await expect(store.writeUpload({
      stream: Readable.from([BODY, Buffer.from([9])]),
      storagePath: second,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    })).rejects.toMatchObject({ code: 'payload_too_large' });
    await expect(store.read(second, IDS.space)).rejects.toMatchObject({ code: 'not_found' });

    const third = store.storagePath(IDS.space, randomUUID());
    await expect(store.writeUpload({
      stream: Readable.from([BODY]),
      storagePath: third,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.read(third, IDS.space)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns exact authorized download bytes with checksum, length, nosniff, and conservative disposition', async () => {
    const dataDir = await tempDataDir();
    const store = createW2BlobStore({ dataDir, maxSizeBytes: 64 });
    const storagePath = store.storagePath(IDS.space, IDS.blob);
    await store.writeUpload({
      stream: Readable.from([BODY]),
      storagePath,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    });

    const db = new FakeDb();
    db.queryImpl = async <R>(_claims, sql) => {
      expect(sql).toContain('from public.entities');
      return [{
        entity_id: IDS.file,
        space_id: IDS.space,
        name: 'report.html\r\nX-Evil: yes',
        mime_type: 'text/html',
        size_bytes: BODY.length,
        checksum_sha256: CHECKSUM,
        storage_path: storagePath,
      }] as R[];
    };
    const registry = new HandlerRegistry();
    registerW2FileHandlers(
      registry,
      {
        db,
        config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: 'postgres://unused' },
        owner: async () => OWNER,
      },
      { blobStore: store, maxSizeBytes: 64 },
    );
    const result = await handler(registry, 'files.download')(
      request('files.download', { params: { fileEntityId: IDS.file } }),
    ) as { kind: string; status: number; headers: Record<string, string>; stream: NodeJS.ReadableStream };

    expect(result.kind).toBe('raw-stream');
    expect(result.status).toBe(200);
    expect(await collect(result.stream)).toEqual(BODY);
    expect(result.headers).toMatchObject({
      'content-type': 'text/html',
      'content-length': String(BODY.length),
      'x-content-type-options': 'nosniff',
      'x-tm8-checksum-sha256': CHECKSUM,
      'accept-ranges': 'bytes',
    });
    expect(result.headers.etag).toContain(CHECKSUM);
    expect(result.headers['content-disposition']).toMatch(/^attachment;/);
    expect(result.headers['content-disposition']).not.toMatch(/[\r\n]/);

    db.queryImpl = async () => [];
    await expect(handler(registry, 'files.download')(
      request('files.download', { params: { fileEntityId: IDS.file } }),
    )).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers conditional and single-range downloads without buffering, and refuses metadata drift', async () => {
    const dataDir = await tempDataDir();
    const store = createW2BlobStore({ dataDir, maxSizeBytes: 64 });
    const storagePath = store.storagePath(IDS.space, IDS.blob);
    await store.writeUpload({
      stream: Readable.from([BODY]),
      storagePath,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    });

    const db = new FakeDb();
    let reportedSize = BODY.length;
    db.queryImpl = async <R>() => [{
      entity_id: IDS.file,
      space_id: IDS.space,
      name: 'movie.mp4',
      mime_type: 'video/mp4',
      size_bytes: reportedSize,
      checksum_sha256: CHECKSUM,
      storage_path: storagePath,
    }] as R[];
    const registry = new HandlerRegistry();
    registerW2FileHandlers(
      registry,
      {
        db,
        config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: 'postgres://unused' },
        owner: async () => OWNER,
      },
      { blobStore: store, maxSizeBytes: 64 },
    );
    const etag = `"sha256-${CHECKSUM}"`;
    const download = (headers: Record<string, string>) => handler(registry, 'files.download')({
      ...request('files.download', { params: { fileEntityId: IDS.file } }),
      headers,
    }) as Promise<{
      kind: string; status: number; headers: Record<string, string>;
      body?: Buffer | string; stream?: NodeJS.ReadableStream;
    }>;

    // If-None-Match with the current strong ETag revalidates for free: 304, no body.
    const notModified = await download({ 'if-none-match': etag });
    expect(notModified.status).toBe(304);
    expect(notModified.kind).toBe('raw');
    expect(notModified.body).toBe('');
    // A weak or stale validator still gets bytes.
    for (const validator of [`W/${etag}`, '"sha256-stale"']) {
      const fresh = await download({ 'if-none-match': validator });
      expect(fresh.status).toBe(200);
      expect(await collect(fresh.stream!)).toEqual(BODY);
    }

    // Single closed range → 206 with exactly those bytes and a content-range.
    const middle = await download({ range: 'bytes=2-5' });
    expect(middle.status).toBe(206);
    expect(middle.headers['content-range']).toBe(`bytes 2-5/${BODY.length}`);
    expect(middle.headers['content-length']).toBe('4');
    expect(await collect(middle.stream!)).toEqual(BODY.subarray(2, 6));

    // Open-ended and suffix forms; an over-long end clamps to the file.
    expect(await collect((await download({ range: 'bytes=6-' })).stream!)).toEqual(BODY.subarray(6));
    expect(await collect((await download({ range: 'bytes=-3' })).stream!)).toEqual(BODY.subarray(BODY.length - 3));
    const clamped = await download({ range: `bytes=4-${BODY.length + 100}` });
    expect(clamped.headers['content-range']).toBe(`bytes 4-${BODY.length - 1}/${BODY.length}`);
    expect(await collect(clamped.stream!)).toEqual(BODY.subarray(4));

    // A start past the end is unsatisfiable: 416 names the true size, no stream.
    const past = await download({ range: `bytes=${BODY.length}-` });
    expect(past.status).toBe(416);
    expect(past.kind).toBe('raw');
    expect(past.headers['content-range']).toBe(`bytes */${BODY.length}`);

    // Shapes we do not serve partially are IGNORED, never a corrupt 206:
    // multi-range, non-bytes units, inverted ranges, and a stale If-Range.
    for (const headers of [
      { range: 'bytes=0-1,3-4' },
      { range: 'items=0-1' },
      { range: 'bytes=5-2' },
      { range: 'bytes=2-5', 'if-range': '"sha256-stale"' },
    ]) {
      const whole = await download(headers);
      expect(whole.status).toBe(200);
      expect(await collect(whole.stream!)).toEqual(BODY);
    }
    // A fresh If-Range validator lets the range through.
    const revalidated = await download({ range: 'bytes=2-5', 'if-range': etag });
    expect(revalidated.status).toBe(206);
    expect(await collect(revalidated.stream!)).toEqual(BODY.subarray(2, 6));

    // Metadata that no longer matches the bytes on disk is refused, not served.
    reportedSize = BODY.length + 1;
    await expect(download({})).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('aborts unfinished storage idempotently while completed slots retain their file bytes', async () => {
    const dataDir = await tempDataDir();
    const store = createW2BlobStore({ dataDir, maxSizeBytes: 64 });
    const storagePath = store.storagePath(IDS.space, IDS.blob);
    await store.writeUpload({
      stream: Readable.from([BODY]),
      storagePath,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    });

    const db = new FakeDb();
    let completed = false;
    db.rpcImpl = async <T>(_claims, fn) => {
      expect(fn).toBe('w2_abort_file_upload');
      return {
        uploadId: IDS.upload,
        outcome: completed ? 'completed' : 'aborted',
        storagePath,
        spaceId: IDS.space,
      } as T;
    };
    const registry = new HandlerRegistry();
    registerW2FileHandlers(
      registry,
      {
        db,
        config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: 'postgres://unused' },
        owner: async () => OWNER,
      },
      { blobStore: store, maxSizeBytes: 64 },
    );
    const abort = () => handler(registry, 'files.uploadAbort')(
      request('files.uploadAbort', {
        params: { uploadId: IDS.upload },
        body: { clientMutationId: `abort-${randomUUID()}` },
      }),
    );

    expect(CommandResultSchema.safeParse(await abort()).success).toBe(true);
    expect(CommandResultSchema.safeParse(await abort()).success).toBe(true);
    await expect(store.read(storagePath, IDS.space)).rejects.toMatchObject({ code: 'not_found' });

    await store.writeUpload({
      stream: Readable.from([BODY]),
      storagePath,
      expectedSpaceId: IDS.space,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    });
    completed = true;
    expect(CommandResultSchema.safeParse(await abort()).success).toBe(true);
    expect(await store.read(storagePath, IDS.space)).toEqual(BODY);
  });
});

describe('W2.G07 raw upload route seam', () => {
  async function listen(route: ReturnType<typeof createW2FileUploadRoute>): Promise<{ server: Server; base: string }> {
    const server = createServer((req, res) => {
      void route(req, res, {
        requestId: 'raw-request',
        identity: req.headers['x-test-identity'] === 'anonymous'
          ? { kind: 'anonymous' as const }
          : { kind: 'bearer' as const, identityId: String(req.headers['x-test-identity'] ?? OWNER.identityId) },
      }).then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('missing test address');
    return { server, base: `http://127.0.0.1:${address.port}` };
  }

  it('authenticates the intended token and identity, streams without JSON buffering, and stages verifiable bytes', async () => {
    const dataDir = await tempDataDir();
    const store = createW2BlobStore({ dataDir, maxSizeBytes: 64 });
    const token = await store.grantToken(IDS.upload);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const storagePath = store.storagePath(IDS.space, IDS.blob);
    const db = new FakeDb();
    let staged = false;
    db.rpcImpl = async <T>(claims, fn, args) => {
      if (fn === 'w2_authorize_file_upload') {
        if (claims.identityId !== OWNER.identityId || args[1] !== tokenHash) {
          throw new CollabError('forbidden', 'wrong upload identity or token');
        }
        return {
          outcome: staged ? 'staged' : 'authorized',
          uploadId: IDS.upload,
          spaceId: IDS.space,
          storagePath,
          sizeBytes: BODY.length,
          checksumSha256: CHECKSUM,
        } as T;
      }
      if (fn === 'w2_settle_file_upload_write') {
        expect(args.slice(3)).toEqual([true, BODY.length, CHECKSUM]);
        staged = true;
        return { outcome: 'staged', uploadId: IDS.upload, storagePath } as T;
      }
      throw new Error(`unexpected rpc ${fn}`);
    };
    const route = createW2FileUploadRoute({
      deps: {
        db,
        config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1, databaseUrl: 'postgres://unused' },
        owner: async () => OWNER,
      },
      blobStore: store,
    });
    const { server, base } = await listen(route);
    try {
      const response = await fetch(`${base}/v2/files/uploads/${IDS.upload}/content`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: BODY,
      });
      expect(response.status).toBe(204);
      expect(await store.read(storagePath, IDS.space)).toEqual(BODY);

      const retry = await fetch(`${base}/v2/files/uploads/${IDS.upload}/content`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: BODY,
      });
      expect(retry.status).toBe(204);
      expect(await store.read(storagePath, IDS.space)).toEqual(BODY);

      const wrongIdentity = await fetch(`${base}/v2/files/uploads/${IDS.upload}/content`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'x-test-identity': 'other-identity' },
        body: BODY,
      });
      expect(wrongIdentity.status).toBe(403);

      const wrongToken = await fetch(`${base}/v2/files/uploads/${IDS.upload}/content`, {
        method: 'PUT',
        headers: { authorization: 'Bearer wrong-token' },
        body: BODY,
      });
      expect(wrongToken.status).toBe(403);

      const anonymous = await fetch(`${base}/v2/files/uploads/${IDS.upload}/content`, {
        method: 'PUT',
        headers: { 'x-test-identity': 'anonymous' },
        body: BODY,
      });
      expect(anonymous.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
