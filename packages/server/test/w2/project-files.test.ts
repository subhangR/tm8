import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectFileListingSchema, getOperation, type OperationName } from '@tm8/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2ProjectFilesHandlers } from '../../src/facade/handlers/w2/project-files.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  listProjectFiles,
  mimeForPath,
  resolveProjectFile,
} from '../../src/facade/services/w2/project-files.js';
import { W2BlobStore } from '../../src/files/w2-blob-store.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const IDS = {
  space: '00000000-0000-7000-8000-000000000701',
  project: '00000000-0000-7000-8000-000000000702',
  target: '00000000-0000-7000-8000-000000000703',
};

const OWNER = {
  identityId: 'project-files-owner',
  accountId: '00000000-0000-7000-8000-000000000799',
  username: 'project-files-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const MAX_SIZE = 1_024 * 1_024;

/** Every scratch tree is created under one temp root that doubles as the browse root. */
let scratch: string;
let workingDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'tm8-project-files-'));
  workingDir = join(scratch, 'project');
  await mkdir(workingDir);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

class FakeDb implements Db {
  readonly calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  storagePath = `spaces/${IDS.space}/${randomUUID()}`;
  /** Lets a test make one ledger step answer something other than the happy path. */
  outcomes: Record<string, unknown> = {};

  rpcImpl = async <T>(fn: string, args: readonly unknown[]): Promise<T> => {
    this.calls.push({ fn, args });
    if (this.outcomes[fn] !== undefined) return this.outcomes[fn] as T;
    if (fn === 'w2_init_file_upload') {
      return {
        uploadId: args[0],
        storagePath: this.storagePath,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxSizeBytes: MAX_SIZE,
      } as T;
    }
    if (fn === 'w2_authorize_file_upload') {
      return { outcome: 'authorized', storagePath: this.storagePath, spaceId: IDS.space } as T;
    }
    if (fn === 'w2_settle_file_upload_write') return { outcome: 'staged' } as T;
    if (fn === 'w2_complete_file_upload') {
      return {
        outcome: 'completed',
        storagePath: this.storagePath,
        spaceId: IDS.space,
        patches: [],
      } as T;
    }
    throw new Error(`unexpected rpc ${fn}`);
  };

  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async (sql) =>
    (/from public\.projects/.test(sql) ? [{ working_dir: workingDir }] : []) as never;

  tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: <R>(sql: string, params: readonly unknown[] = []) => this.queryImpl<R>(sql, params),
      rpc: <T>(name: string, args: readonly unknown[] = []) => this.rpcImpl<T>(name, args),
    });
  }

  query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.queryImpl<R>(sql, params);
  }

  rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.rpcImpl<T>(fn, args);
  }

  async end(): Promise<void> {}

  argsFor(fn: string): readonly unknown[] {
    const call = this.calls.find((entry) => entry.fn === fn);
    if (!call) throw new Error(`no ${fn} call`);
    return call.args;
  }
}

function deps(db: Db): FacadeDeps {
  return { db, config: {} as FacadeDeps['config'], owner: async () => OWNER };
}

function request(
  opName: OperationName,
  options: {
    params?: Record<string, string>;
    query?: string;
    body?: unknown;
    identity?: RequestContext['identity'];
  } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? { projectId: IDS.project },
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: `req-${opName}`,
    identity: options.identity ?? { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

async function registered(db: Db): Promise<{ registry: HandlerRegistry; store: W2BlobStore }> {
  const store = new W2BlobStore({ dataDir: join(scratch, 'data'), maxSizeBytes: MAX_SIZE });
  const registry = new HandlerRegistry();
  registerW2ProjectFilesHandlers(registry, deps(db), { blobStore: store, maxSizeBytes: MAX_SIZE });
  return { registry, store };
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

describe('reading a connected project folder', () => {
  it('lists files beside directories, omits symlinks, and flags what is too large to attach', async () => {
    await mkdir(join(workingDir, 'docs'));
    await writeFile(join(workingDir, 'notes.md'), 'hello');
    await writeFile(join(workingDir, 'huge.bin'), Buffer.alloc(MAX_SIZE + 1));
    await writeFile(join(workingDir, 'empty.txt'), '');
    await writeFile(join(scratch, 'outside.txt'), 'not in the project');
    await symlink(join(scratch, 'outside.txt'), join(workingDir, 'escape.txt'));
    await symlink(scratch, join(workingDir, 'escape-dir'));

    const listing = await listProjectFiles(workingDir, undefined, MAX_SIZE, [scratch]);
    expect(ProjectFileListingSchema.safeParse({ projectId: IDS.project, ...listing }).success).toBe(true);

    expect(listing.directories.map((entry) => entry.name)).toEqual(['docs']);
    expect(listing.files.map((entry) => entry.name)).toEqual(['empty.txt', 'huge.bin', 'notes.md']);
    expect(listing.parentPath).toBeNull();
    expect(listing.maxSizeBytes).toBe(MAX_SIZE);

    const byName = new Map(listing.files.map((entry) => [entry.name, entry]));
    expect(byName.get('notes.md')).toMatchObject({ sizeBytes: 5, mime: 'text/markdown', attachable: true });
    expect(byName.get('huge.bin')?.attachable).toBe(false);
    expect(byName.get('empty.txt')?.attachable).toBe(false);
  });

  it('walks down into a subdirectory and offers the way back up, but never above the project', async () => {
    await mkdir(join(workingDir, 'docs'));
    await writeFile(join(workingDir, 'docs', 'guide.txt'), 'a guide');

    const nested = await listProjectFiles(workingDir, join(workingDir, 'docs'), MAX_SIZE, [scratch]);
    expect(nested.files.map((entry) => entry.name)).toEqual(['guide.txt']);
    expect(nested.parentPath).toBe(workingDir);

    await expect(listProjectFiles(workingDir, scratch, MAX_SIZE, [scratch]))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a working directory outside TM8_PROJECT_ROOTS, however the project was registered', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'tm8-unrooted-'));
    try {
      await expect(listProjectFiles(elsewhere, undefined, MAX_SIZE, [scratch]))
        .rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('names the file types a picker shows, and stays unspecific about everything else', () => {
    expect(mimeForPath('/p/a.PNG')).toBe('image/png');
    expect(mimeForPath('/p/a.md')).toBe('text/markdown');
    // Not video/mp2t: inside a project folder this is a TypeScript source file.
    expect(mimeForPath('/p/a.ts')).toBe('text/plain');
    expect(mimeForPath('/p/Makefile')).toBe('application/octet-stream');
  });
});

describe('resolving one file for attachment', () => {
  it('hashes the bytes this node actually read', async () => {
    const bytes = Buffer.from('attach me');
    await writeFile(join(workingDir, 'notes.md'), bytes);

    const resolved = await resolveProjectFile(workingDir, join(workingDir, 'notes.md'), MAX_SIZE, [scratch]);
    expect(resolved).toMatchObject({
      name: 'notes.md',
      mime: 'text/markdown',
      sizeBytes: bytes.length,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('refuses a symlink out of the project, a directory, an empty file and an oversize file', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'not in the project');
    await symlink(join(scratch, 'outside.txt'), join(workingDir, 'escape.txt'));
    await mkdir(join(workingDir, 'docs'));
    await writeFile(join(workingDir, 'empty.txt'), '');
    await writeFile(join(workingDir, 'huge.bin'), Buffer.alloc(MAX_SIZE + 1));

    const refuse = (path: string) =>
      resolveProjectFile(workingDir, path, MAX_SIZE, [scratch]);

    await expect(refuse(join(workingDir, 'escape.txt'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(refuse(join(scratch, 'outside.txt'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(refuse(join(workingDir, 'docs'))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(refuse(join(workingDir, 'empty.txt'))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(refuse(join(workingDir, 'huge.bin'))).rejects.toMatchObject({ code: 'payload_too_large' });
    await expect(refuse(join(workingDir, 'missing.txt'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(refuse('relative/path.txt')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('W2 connected project folder facade', () => {
  it('exports one registration seam for exactly the two project-file operations', async () => {
    const { registry } = await registered(new FakeDb());
    expect(registry.implemented()).toEqual(['projects.files.attach', 'projects.files.list']);
  });

  it('requires node-admin claims to read or attach node-local files', async () => {
    const { registry } = await registered(new FakeDb());
    const identity = {
      kind: 'bearer' as const,
      identityId: 'ordinary-user',
      token: 'test-token',
      nodeAdmin: false,
    };
    await expect(handler(registry, 'projects.files.list')(
      request('projects.files.list', { identity }),
    )).rejects.toMatchObject({ code: 'forbidden' });
    await expect(handler(registry, 'projects.files.attach')(
      request('projects.files.attach', {
        identity,
        body: { clientMutationId: 'm-1', spaceId: IDS.space, path: join(workingDir, 'notes.md') },
      }),
    )).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('answers the listing for the project the path parameter names', async () => {
    await writeFile(join(workingDir, 'notes.md'), 'hello');
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const { registry } = await registered(new FakeDb());
      const listing = await handler(registry, 'projects.files.list')(request('projects.files.list')) as
        Awaited<ReturnType<typeof listProjectFiles>> & { projectId: string };
      expect(listing.projectId).toBe(IDS.project);
      expect(listing.workingDir).toBe(workingDir);
      expect(listing.files.map((entry) => entry.name)).toEqual(['notes.md']);
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });

  it('drives the upload ledger end to end and leaves the bytes readable in the blob store', async () => {
    const bytes = Buffer.from('# release notes\n');
    await writeFile(join(workingDir, 'notes.md'), bytes);
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const db = new FakeDb();
      const { registry, store } = await registered(db);
      const result = await handler(registry, 'projects.files.attach')(request('projects.files.attach', {
        body: {
          clientMutationId: 'attach-1',
          spaceId: IDS.space,
          path: join(workingDir, 'notes.md'),
          targets: [IDS.target],
        },
      }));

      expect(result).toEqual({ patches: [] });
      expect(db.calls.map((call) => call.fn)).toEqual([
        'w2_init_file_upload',
        'w2_authorize_file_upload',
        'w2_settle_file_upload_write',
        'w2_complete_file_upload',
      ]);

      const digest = createHash('sha256').update(bytes).digest('hex');
      const init = db.argsFor('w2_init_file_upload');
      expect(init[1]).toBe(IDS.space);
      expect(init[3]).toBe('notes.md');
      expect(init[4]).toBe('text/markdown');
      expect(init[5]).toBe(bytes.length);
      expect(init[6]).toBe(digest);
      expect(init[12]).toBe('attach-1');

      // The frozen target set travels on complete, exactly as a browser upload's does.
      expect(db.argsFor('w2_complete_file_upload')[4]).toEqual([IDS.target]);
      expect(await store.read(db.storagePath, IDS.space)).toEqual(bytes);
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });

  it('honours an overriding name and MIME type without re-reading a different file', async () => {
    await writeFile(join(workingDir, 'notes.md'), 'body');
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const db = new FakeDb();
      const { registry } = await registered(db);
      await handler(registry, 'projects.files.attach')(request('projects.files.attach', {
        body: {
          clientMutationId: 'attach-2',
          spaceId: IDS.space,
          path: join(workingDir, 'notes.md'),
          name: 'Release notes.md',
          mime: 'text/plain',
        },
      }));
      const init = db.argsFor('w2_init_file_upload');
      expect(init[3]).toBe('Release notes.md');
      expect(init[4]).toBe('text/plain');
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });

  it('skips the write when a previous attempt already staged the bytes', async () => {
    await writeFile(join(workingDir, 'notes.md'), 'retry me');
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const db = new FakeDb();
      db.outcomes.w2_authorize_file_upload = {
        outcome: 'staged',
        storagePath: db.storagePath,
        spaceId: IDS.space,
      };
      const { registry } = await registered(db);
      await handler(registry, 'projects.files.attach')(request('projects.files.attach', {
        body: { clientMutationId: 'attach-3', spaceId: IDS.space, path: join(workingDir, 'notes.md') },
      }));
      expect(db.calls.map((call) => call.fn)).toEqual([
        'w2_init_file_upload',
        'w2_authorize_file_upload',
        'w2_complete_file_upload',
      ]);
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });

  it('refuses to attach a file the project does not contain, before opening any upload slot', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'not in the project');
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const db = new FakeDb();
      const { registry } = await registered(db);
      await expect(handler(registry, 'projects.files.attach')(request('projects.files.attach', {
        body: { clientMutationId: 'attach-4', spaceId: IDS.space, path: join(scratch, 'outside.txt') },
      }))).rejects.toMatchObject({ code: 'forbidden' });
      expect(db.calls).toEqual([]);
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });
});
