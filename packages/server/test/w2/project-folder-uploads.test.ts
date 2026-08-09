import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  CollabError,
  getOperation,
  type OperationName,
  type ProjectFolderUploadGrant,
  type ProjectFolderUploadResult,
} from '@tm8/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { registerW2ProjectFolderUploadHandlers } from '../../src/facade/handlers/w2/project-folder-uploads.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createW2BlobStore } from '../../src/files/w2-blob-store.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const OWNER = {
  identityId: 'folder-owner',
  accountId: '11111111-1111-4111-8111-111111111111',
  username: 'folder-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const SPACE = '22222222-2222-4222-8222-222222222222';
const PROJECT = '77777777-7777-4777-8777-777777777777';

const BODY = Buffer.from('folder upload payload');
const CHECKSUM = createHash('sha256').update(BODY).digest('hex');

const PROJECT_ROW = {
  id: PROJECT,
  name: 'Imported',
  repo_url: null,
  working_dir: '',
  trust: 'untrusted',
  defaults: {},
  link_frozen: false,
  active_link_count: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

class FakeDb implements Db {
  readonly calls: Array<{ kind: 'query' | 'rpc'; claims: DbClaims; name: string; args: readonly unknown[] }> = [];
  queryImpl: <R>(claims: DbClaims, sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(claims: DbClaims, fn: string, args: readonly unknown[]) => Promise<T> = async () => {
    throw new Error('unexpected rpc');
  };

  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(sql: string, params: readonly unknown[] = []) => this.queryImpl<R>(claims, sql, params),
      rpc: async <R>(name: string, args: readonly unknown[] = []) => this.rpcImpl<R>(claims, name, args),
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

function stagingDb(): FakeDb {
  const db = new FakeDb();
  db.rpcImpl = async <T>(_claims: DbClaims, fn: string, args: readonly unknown[]): Promise<T> => {
    if (fn === 'w2_init_file_upload') {
      return {
        uploadId: args[0],
        storagePath: `spaces/${args[1]}/${args[7]}`,
        expiresAt: args[9],
        maxSizeBytes: args[11],
      } as T;
    }
    if (fn === 'w2_abort_file_upload') {
      return { outcome: 'aborted', uploadId: args[0], storagePath: '', spaceId: SPACE } as T;
    }
    if (fn === 'create_project') {
      return { project: { ...PROJECT_ROW, name: args[0], working_dir: args[1], trust: args[3] } } as T;
    }
    if (fn === 'link_project_w2') {
      return { spaceId: args[0], projectId: args[1] } as T;
    }
    throw new Error(`unexpected rpc: ${fn}`);
  };
  // Slot staging read: every requested slot is fully staged with the declared bytes.
  db.queryImpl = async <R>(_claims: DbClaims, sql: string, params: readonly unknown[]): Promise<R[]> => {
    if (sql.includes('file_upload_slots')) {
      const ids = params[0] as string[];
      return ids.map((id) => ({
        id,
        status: 'pending',
        staged_at: new Date().toISOString(),
        staged_size_bytes: BODY.length,
        staged_checksum_sha256: CHECKSUM,
      })) as R[];
    }
    if (sql.includes('public.projects')) return [] as R[];
    throw new Error(`unexpected query: ${sql}`);
  };
  return db;
}

function request(
  opName: OperationName,
  options: { params?: Record<string, string>; body?: unknown; identity?: RequestContext['identity'] } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(),
    body: options.body,
    requestId: `request-${opName}`,
    identity: options.identity ?? { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(value);
  return value;
}

let projectRoot: string;
let dataDir: string;
let stateDir: string;
let previousRoots: string | undefined;

beforeEach(async () => {
  // realpath: macOS tmpdir is a /var -> /private/var symlink and the service
  // canonicalizes every destination it touches.
  projectRoot = await realpath(await tempDir('tm8-pfu-root-'));
  dataDir = await tempDir('tm8-pfu-data-');
  stateDir = join(dataDir, 'folder-uploads');
  previousRoots = process.env.TM8_PROJECT_ROOTS;
  process.env.TM8_PROJECT_ROOTS = projectRoot;
});

afterEach(async () => {
  if (previousRoots === undefined) delete process.env.TM8_PROJECT_ROOTS;
  else process.env.TM8_PROJECT_ROOTS = previousRoots;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function configured(db: Db): { registry: HandlerRegistry; blobStore: ReturnType<typeof createW2BlobStore> } {
  const registry = new HandlerRegistry();
  const blobStore = createW2BlobStore({ dataDir, maxSizeBytes: 1024 });
  registerW2ProjectFolderUploadHandlers(
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
    { blobStore, stateDir, maxSizeBytes: 1024 },
  );
  return { registry, blobStore };
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing handler: ${name}`);
  return value;
}

function initBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientMutationId: 'cmid-1',
    projectName: 'Imported',
    destinationParent: projectRoot,
    rootName: 'imported',
    entries: [
      { kind: 'directory', relativePath: 'empty' },
      { kind: 'file', relativePath: 'src/data.bin', sizeBytes: BODY.length, checksumSha256: CHECKSUM, mime: 'application/octet-stream' },
      {
        kind: 'file', relativePath: 'src/empty.txt', sizeBytes: 0,
        checksumSha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), mime: 'text/plain',
      },
    ],
    ...overrides,
  };
}

async function stageGrantBytes(
  blobStore: ReturnType<typeof createW2BlobStore>,
  grant: ProjectFolderUploadGrant,
): Promise<void> {
  const state = JSON.parse(await readFile(join(stateDir, `${grant.folderUploadId}.json`), 'utf8')) as {
    files: Array<{ relativePath: string; storagePath: string | null }>;
  };
  for (const file of state.files) {
    if (file.storagePath === null) continue;
    await blobStore.writeUpload({
      stream: Readable.from(BODY),
      storagePath: file.storagePath,
      expectedSpaceId: SPACE,
      expectedSizeBytes: BODY.length,
      expectedChecksumSha256: CHECKSUM,
    });
  }
}

describe('projects.folderUploads lifecycle', () => {
  it('registers exactly the three v1 operations', () => {
    const { registry } = configured(new FakeDb());
    expect(registry.implemented()).toEqual([
      'projects.folderUploads.abort',
      'projects.folderUploads.complete',
      'projects.folderUploads.init',
    ]);
  });

  it('init refuses anonymous callers, foreign destinations, and an existing create-mode root', async () => {
    const { registry } = configured(stagingDb());
    const init = handler(registry, 'projects.folderUploads.init');

    await expect(init(request('projects.folderUploads.init', {
      params: { spaceId: SPACE },
      body: initBody(),
      identity: { kind: 'anonymous' },
    }))).rejects.toMatchObject({ code: 'unauthenticated' });

    const outside = await tempDir('tm8-pfu-outside-');
    await expect(init(request('projects.folderUploads.init', {
      params: { spaceId: SPACE },
      body: initBody({ destinationParent: outside }),
    }))).rejects.toMatchObject({ code: 'forbidden' });

    await mkdir(join(projectRoot, 'imported'));
    await expect(init(request('projects.folderUploads.init', {
      params: { spaceId: SPACE },
      body: initBody(),
    }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('init issues grants only for non-empty files and freezes the session on disk', async () => {
    const db = stagingDb();
    const { registry } = configured(db);
    const grant = await handler(registry, 'projects.folderUploads.init')(
      request('projects.folderUploads.init', { params: { spaceId: SPACE }, body: initBody() }),
    ) as ProjectFolderUploadGrant;

    // One slot for the non-empty file; the zero-byte file rides no transport.
    expect(grant.files).toHaveLength(1);
    expect(grant.files[0]!.relativePath).toBe('src/data.bin');
    expect(grant.files[0]!.uploadUrl).toBe(`/v2/files/uploads/${grant.files[0]!.uploadId}/content`);
    expect(db.calls.filter((call) => call.name === 'w2_init_file_upload')).toHaveLength(1);

    const state = JSON.parse(await readFile(join(stateDir, `${grant.folderUploadId}.json`), 'utf8'));
    expect(state.mode).toBe('create');
    expect(state.identityId).toBe(OWNER.identityId);
    expect(state.files).toHaveLength(2);
  });

  it('complete materializes the tree, creates and links the project, and releases staging', async () => {
    const db = stagingDb();
    const { registry, blobStore } = configured(db);
    const grant = await handler(registry, 'projects.folderUploads.init')(
      request('projects.folderUploads.init', { params: { spaceId: SPACE }, body: initBody() }),
    ) as ProjectFolderUploadGrant;
    await stageGrantBytes(blobStore, grant);

    const result = await handler(registry, 'projects.folderUploads.complete')(
      request('projects.folderUploads.complete', {
        params: { folderUploadId: grant.folderUploadId },
        body: { clientMutationId: 'cmid-2' },
      }),
    ) as ProjectFolderUploadResult;

    expect(result).toMatchObject({
      folderUploadId: grant.folderUploadId,
      spaceId: SPACE,
      rootName: 'imported',
      fileCount: 2,
      replacedCount: 0,
    });
    expect(result.project.workingDir).toBe(join(projectRoot, 'imported'));

    expect(await readFile(join(projectRoot, 'imported/src/data.bin'))).toEqual(BODY);
    expect((await readFile(join(projectRoot, 'imported/src/empty.txt'))).length).toBe(0);
    expect((await stat(join(projectRoot, 'imported/empty'))).isDirectory()).toBe(true);

    const rpcNames = db.calls.filter((call) => call.kind === 'rpc').map((call) => call.name);
    expect(rpcNames).toContain('create_project');
    expect(rpcNames).toContain('link_project_w2');
    expect(rpcNames).toContain('w2_abort_file_upload');
    // Session state and staged blobs are gone.
    await expect(readFile(join(stateDir, `${grant.folderUploadId}.json`))).rejects.toThrow();
    const blobDir = join(dataDir, 'blobs', 'spaces', SPACE);
    const leftover = await readdir(blobDir).catch(() => []);
    expect(leftover).toEqual([]);
  });

  it('complete in merge mode reuses the project at the destination and reports replacedCount (R8)', async () => {
    const db = stagingDb();
    const target = join(projectRoot, 'imported');
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src/data.bin'), 'stale bytes');
    db.queryImpl = (async <R>(_claims: DbClaims, sql: string, params: readonly unknown[]): Promise<R[]> => {
      if (sql.includes('file_upload_slots')) {
        return (params[0] as string[]).map((id) => ({
          id, status: 'pending', staged_at: new Date().toISOString(),
          staged_size_bytes: BODY.length, staged_checksum_sha256: CHECKSUM,
        })) as R[];
      }
      if (sql.includes('public.projects')) {
        return [{ ...PROJECT_ROW, working_dir: params[0] }] as R[];
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { registry, blobStore } = configured(db);
    const grant = await handler(registry, 'projects.folderUploads.init')(
      request('projects.folderUploads.init', { params: { spaceId: SPACE }, body: initBody({ mode: 'merge' }) }),
    ) as ProjectFolderUploadGrant;
    await stageGrantBytes(blobStore, grant);

    const result = await handler(registry, 'projects.folderUploads.complete')(
      request('projects.folderUploads.complete', {
        params: { folderUploadId: grant.folderUploadId },
        body: { clientMutationId: 'cmid-3' },
      }),
    ) as ProjectFolderUploadResult;

    expect(result.replacedCount).toBe(1);
    expect(result.project.id).toBe(PROJECT);
    expect(await readFile(join(target, 'src/data.bin'))).toEqual(BODY);
    // An existing project is linked, never re-created.
    expect(db.calls.filter((call) => call.name === 'create_project')).toHaveLength(0);
    expect(db.calls.filter((call) => call.name === 'link_project_w2')).toHaveLength(1);
  });

  it('complete refuses another identity, an unknown session, and unstaged bytes', async () => {
    const db = stagingDb();
    const { registry } = configured(db);
    const complete = handler(registry, 'projects.folderUploads.complete');

    await expect(complete(request('projects.folderUploads.complete', {
      params: { folderUploadId: '99999999-9999-4999-8999-999999999999' },
      body: { clientMutationId: 'cmid-4' },
    }))).rejects.toMatchObject({ code: 'not_found' });

    const grant = await handler(registry, 'projects.folderUploads.init')(
      request('projects.folderUploads.init', { params: { spaceId: SPACE }, body: initBody() }),
    ) as ProjectFolderUploadGrant;

    await expect(complete(request('projects.folderUploads.complete', {
      params: { folderUploadId: grant.folderUploadId },
      body: { clientMutationId: 'cmid-5' },
      identity: { kind: 'bearer', identityId: 'someone-else' },
    }))).rejects.toMatchObject({ code: 'forbidden' });

    // Bytes never staged: refuse, and refuse BEFORE any filesystem write.
    db.queryImpl = (async <R>(_claims: DbClaims, sql: string, params: readonly unknown[]): Promise<R[]> => {
      if (sql.includes('file_upload_slots')) {
        return (params[0] as string[]).map((id) => ({
          id, status: 'pending', staged_at: null, staged_size_bytes: null, staged_checksum_sha256: null,
        })) as R[];
      }
      return [] as R[];
    });
    await expect(complete(request('projects.folderUploads.complete', {
      params: { folderUploadId: grant.folderUploadId },
      body: { clientMutationId: 'cmid-6' },
    }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(stat(join(projectRoot, 'imported'))).rejects.toThrow();
  });

  it('abort aborts the slots, removes staged blobs and forgets the session', async () => {
    const db = stagingDb();
    const { registry, blobStore } = configured(db);
    const grant = await handler(registry, 'projects.folderUploads.init')(
      request('projects.folderUploads.init', { params: { spaceId: SPACE }, body: initBody() }),
    ) as ProjectFolderUploadGrant;
    await stageGrantBytes(blobStore, grant);

    await handler(registry, 'projects.folderUploads.abort')(
      request('projects.folderUploads.abort', {
        params: { folderUploadId: grant.folderUploadId },
        body: { clientMutationId: 'cmid-7' },
      }),
    );

    expect(db.calls.filter((call) => call.name === 'w2_abort_file_upload')).toHaveLength(1);
    await expect(readFile(join(stateDir, `${grant.folderUploadId}.json`))).rejects.toThrow();
    const blobDir = join(dataDir, 'blobs', 'spaces', SPACE);
    expect(await readdir(blobDir).catch(() => [])).toEqual([]);

    // A second abort of the same session is an honest not_found, not a crash.
    await expect(handler(registry, 'projects.folderUploads.abort')(
      request('projects.folderUploads.abort', {
        params: { folderUploadId: grant.folderUploadId },
        body: { clientMutationId: 'cmid-8' },
      }),
    )).rejects.toMatchObject({ code: 'not_found' });
  });
});
