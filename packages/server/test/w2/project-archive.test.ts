/**
 * FOLDER DOWNLOAD — `projects.files.archive`.
 *
 * The assertions that matter here are not "a zip came back". They are:
 *   - the archive EXTRACTS, with `unzip`, to a tree byte-identical to the
 *     source (a hand-rolled zip writer that only round-trips through its own
 *     reader proves nothing);
 *   - the secret policy that governs `projects.files.read` governs a whole
 *     subtree identically, and what it withheld is NAMED rather than dropped;
 *   - every refusal happens BEFORE the response starts, because afterwards a
 *     refusal can only be a severed connection.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { getOperation, type OperationName } from '@tm8/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2ProjectFilesHandlers } from '../../src/facade/handlers/w2/project-files.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  ARCHIVE_EXCLUSION_MANIFEST,
  MAX_ARCHIVE_FILES,
  planProjectArchive,
  projectArchiveEntries,
} from '../../src/facade/services/w2/project-files.js';
import { W2BlobStore } from '../../src/files/w2-blob-store.js';
import type { OperationHandler, RawStreamResult, RequestContext } from '../../src/http/types.js';

const run = promisify(execFile);

const IDS = {
  space: '00000000-0000-7000-8000-000000000801',
  project: '00000000-0000-7000-8000-000000000802',
};

const OWNER = {
  identityId: 'archive-owner',
  accountId: '00000000-0000-7000-8000-000000000899',
  username: 'archive-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const MAX_SIZE = 1_024 * 1_024;

let scratch: string;
let workingDir: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'tm8-archive-')));
  workingDir = join(scratch, 'project');
  await mkdir(workingDir);
  process.env.TM8_PROJECT_ROOTS = scratch;
});

afterEach(async () => {
  delete process.env.TM8_PROJECT_ROOTS;
  await rm(scratch, { recursive: true, force: true });
});

class FakeDb implements Db {
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async (sql) =>
    (/from public\.projects/.test(sql) ? [{ working_dir: workingDir }] : []) as never;

  tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: <R>(sql: string, params: readonly unknown[] = []) => this.queryImpl<R>(sql, params),
      rpc: async <T>(): Promise<T> => {
        throw new Error('no rpc expected');
      },
    });
  }

  query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.queryImpl<R>(sql, params);
  }

  async rpc<T>(): Promise<T> {
    throw new Error('no rpc expected');
  }

  async end(): Promise<void> {}
}

function deps(db: Db): FacadeDeps {
  return { db, config: {} as FacadeDeps['config'], owner: async () => OWNER };
}

function request(query = ''): RequestContext {
  const opName: OperationName = 'projects.files.archive';
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: { projectId: IDS.project },
    query: new URLSearchParams(query),
    body: undefined,
    requestId: `req-${randomUUID()}`,
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function archiveHandler(): OperationHandler {
  const store = new W2BlobStore({ dataDir: join(scratch, 'data'), maxSizeBytes: MAX_SIZE });
  const registry = new HandlerRegistry();
  registerW2ProjectFilesHandlers(registry, deps(new FakeDb()), {
    blobStore: store,
    maxSizeBytes: MAX_SIZE,
    audit: () => undefined,
  });
  const handler = registry.get('projects.files.archive');
  if (!handler) throw new Error('projects.files.archive is not registered');
  return handler;
}

async function collect(result: unknown): Promise<Buffer> {
  const stream = (result as RawStreamResult).stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Extract with the system `unzip` — an independent reader, which is the point. */
async function extract(zip: Buffer): Promise<string> {
  const zipPath = join(scratch, `${randomUUID()}.zip`);
  const out = join(scratch, `out-${randomUUID()}`);
  await writeFile(zipPath, zip);
  await mkdir(out);
  await run('unzip', ['-qq', zipPath, '-d', out]);
  return out;
}

async function treeOf(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const row of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, row.name);
      if (row.isDirectory()) await walk(abs);
      else if (row.isFile()) {
        files.set(relative(root, abs).split(/[\\/]/).join('/'), await readFile(abs, 'utf8'));
      }
    }
  };
  await walk(root);
  return files;
}

describe('projects.files.archive', () => {
  it('round-trips a nested tree through the system unzip, byte for byte', async () => {
    await mkdir(join(workingDir, 'src', 'deep'), { recursive: true });
    await writeFile(join(workingDir, 'README.md'), '# hello\n');
    await writeFile(join(workingDir, 'src', 'index.ts'), 'export const a = 1;\n');
    await writeFile(join(workingDir, 'src', 'deep', 'nested.txt'), 'down here\n');
    // A name that needs UTF-8 flagging, and one with a space.
    await writeFile(join(workingDir, 'ünïcode file.txt'), 'accented\n');

    const zip = await collect(await archiveHandler()(request()));
    const tree = await treeOf(await extract(zip));

    expect([...tree.keys()].sort()).toEqual([
      'project/README.md',
      // The manifest is ALWAYS present, even with nothing withheld: a receipt
      // that appears only sometimes lets a planted file impersonate it.
      'project/_tm8-excluded.txt',
      'project/src/deep/nested.txt',
      'project/src/index.ts',
      'project/ünïcode file.txt',
    ]);
    expect(tree.get(`project/${ARCHIVE_EXCLUSION_MANIFEST}`)).toContain('Nothing was withheld');
    expect(tree.get('project/README.md')).toBe('# hello\n');
    expect(tree.get('project/src/deep/nested.txt')).toBe('down here\n');
    expect(tree.get('project/ünïcode file.txt')).toBe('accented\n');
  });

  it('withholds secrets exactly as the single-file read does, and names each one', async () => {
    await writeFile(join(workingDir, 'app.ts'), 'ok\n');
    await writeFile(join(workingDir, '.env'), 'SECRET=1\n');
    await writeFile(join(workingDir, 'id_rsa'), 'PRIVATE\n');
    await mkdir(join(workingDir, '.ssh'));
    await writeFile(join(workingDir, '.ssh', 'known_hosts'), 'hosts\n');
    await mkdir(join(workingDir, 'node_modules'));
    await writeFile(join(workingDir, 'node_modules', 'junk.js'), 'junk\n');

    const zip = await collect(await archiveHandler()(request()));
    const tree = await treeOf(await extract(zip));
    const paths = [...tree.keys()].sort();

    expect(paths).toEqual(['project/_tm8-excluded.txt', 'project/app.ts']);
    // Not merely absent — every secret is absent AND accounted for.
    const manifest = tree.get(`project/${ARCHIVE_EXCLUSION_MANIFEST}`) ?? '';
    for (const withheld of ['.env', 'id_rsa', '.ssh', 'node_modules']) {
      expect(manifest).toContain(withheld);
    }
    expect(manifest).not.toContain('SECRET=1');
  });

  it('never follows a symlink out of the project, and says it skipped one', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'not in the project\n');
    await writeFile(join(workingDir, 'inside.txt'), 'in\n');
    await symlink(join(scratch, 'outside.txt'), join(workingDir, 'escape.txt'));
    await symlink(scratch, join(workingDir, 'escape-dir'));

    const zip = await collect(await archiveHandler()(request()));
    const tree = await treeOf(await extract(zip));

    expect([...tree.keys()].sort()).toEqual(['project/_tm8-excluded.txt', 'project/inside.txt']);
    const manifest = tree.get(`project/${ARCHIVE_EXCLUSION_MANIFEST}`) ?? '';
    expect(manifest).toContain('escape.txt');
    expect(manifest).toContain('symbolic link');
    // The point of the whole check: the outside bytes are nowhere in the zip.
    expect(zip.includes(Buffer.from('not in the project'))).toBe(false);
  });

  it('archives a subtree, not the whole project, when a path is given', async () => {
    await mkdir(join(workingDir, 'docs'));
    await writeFile(join(workingDir, 'docs', 'guide.md'), 'guide\n');
    await writeFile(join(workingDir, 'top.txt'), 'top\n');

    const result = await archiveHandler()(request(`path=${encodeURIComponent(join(workingDir, 'docs'))}`));
    const tree = await treeOf(await extract(await collect(result)));

    expect([...tree.keys()].sort()).toEqual(['docs/_tm8-excluded.txt', 'docs/guide.md']);
    expect((result as RawStreamResult).headers['content-disposition']).toContain('docs.zip');
  });

  it('carries honest counts in headers and always attaches, never inlines', async () => {
    await writeFile(join(workingDir, 'a.txt'), 'aa\n');
    await writeFile(join(workingDir, 'b.txt'), 'bbb\n');
    await writeFile(join(workingDir, '.env'), 'x\n');

    const result = (await archiveHandler()(request())) as RawStreamResult;
    expect(result.headers['content-type']).toBe('application/zip');
    expect(result.headers['content-disposition']).toMatch(/^attachment;/);
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['x-tm8-archive-entries']).toBe('2');
    expect(result.headers['x-tm8-archive-bytes']).toBe('7');
    expect(result.headers['x-tm8-archive-excluded']).toBe('1');
    // No content-length: a STORED zip's size is not known before it is written.
    expect(result.headers['content-length']).toBeUndefined();
  });

  it('refuses an over-ceiling tree BEFORE any byte is streamed', async () => {
    // The plan is what the handler builds first; a refusal here is a typed
    // error the client can read, which is impossible once headers are sent.
    await mkdir(join(workingDir, 'many'));
    await writeFile(join(workingDir, 'many', 'one.txt'), 'x');

    await expect(
      planProjectArchive(workingDir, undefined, [scratch], { maxFiles: 0 }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('refuses a path outside the project without opening a stream', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'nope\n');
    await expect(
      archiveHandler()(request(`path=${encodeURIComponent(scratch)}`)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gives an empty folder an archive carrying only the receipt', async () => {
    const tree = await treeOf(await extract(await collect(await archiveHandler()(request()))));
    expect([...tree.keys()]).toEqual(['project/_tm8-excluded.txt']);
    expect(tree.get('project/_tm8-excluded.txt')).toContain('Nothing was withheld');
  });

  it('names the ceiling in the refusal so the limit is actionable', async () => {
    await writeFile(join(workingDir, 'a.txt'), 'x');
    await expect(
      planProjectArchive(workingDir, undefined, [scratch], { maxBytes: 0 }),
    ).rejects.toMatchObject({
      code: 'payload_too_large',
      message: expect.stringContaining('archive limit'),
    });
    expect(MAX_ARCHIVE_FILES).toBeGreaterThan(0);
  });
});

/**
 * THE TWO ESCAPES AN ADVERSARIAL REVIEW DEMONSTRATED, 2026-08-12.
 *
 * Both were real: the archive followed a symlink out of the project root and
 * laundered a `.env` whose exclusion its own manifest simultaneously reported.
 * Both are races, so both tests drive the swap deterministically — by doing it
 * between the plan and the read, which is exactly the window that was open —
 * rather than with a timer that would make the suite flaky.
 */
describe('the archive re-verifies what the walk approved', () => {
  it('refuses a file swapped to a symlink between plan and read, and says so', async () => {
    await mkdir(join(scratch, 'outside'));
    await writeFile(join(scratch, 'outside', 'secret.txt'), 'TOP SECRET OUTSIDE THE PROJECT\n');
    await writeFile(join(workingDir, 'innocent.txt'), 'harmless\n');

    const plan = await planProjectArchive(workingDir, undefined, [scratch]);
    expect(plan.entries.map((e) => e.archivePath)).toContain('project/innocent.txt');

    // The window: the walk has approved a regular file; now it becomes a
    // symlink pointing out of the project.
    await rm(join(workingDir, 'innocent.txt'));
    await symlink(join(scratch, 'outside', 'secret.txt'), join(workingDir, 'innocent.txt'));

    const written = new Map<string, string>();
    for await (const entry of projectArchiveEntries(plan, plan.rootPath)) {
      written.set(entry.path, entry.bytes.toString('utf8'));
    }

    expect(written.has('project/innocent.txt')).toBe(false);
    expect([...written.values()].join('')).not.toContain('TOP SECRET');
    const manifest = written.get(`project/${ARCHIVE_EXCLUSION_MANIFEST}`) ?? '';
    expect(manifest).toContain('innocent.txt');
  });

  it('will not launder a withheld secret through a swapped-in symlink', async () => {
    await writeFile(join(workingDir, '.env'), 'API_KEY=hunter2\n');
    await writeFile(join(workingDir, 'readme.md'), 'docs\n');

    const plan = await planProjectArchive(workingDir, undefined, [scratch]);
    // The plan correctly withholds the secret...
    expect(plan.excluded.map((e) => e.path)).toContain('.env');

    // ...so the attack is to make an ALLOWED path point at it after the fact.
    await rm(join(workingDir, 'readme.md'));
    await symlink(join(workingDir, '.env'), join(workingDir, 'readme.md'));

    const written = new Map<string, string>();
    for await (const entry of projectArchiveEntries(plan, plan.rootPath)) {
      written.set(entry.path, entry.bytes.toString('utf8'));
    }

    // The whole point: an archive whose manifest says `.env` was withheld must
    // not contain `.env`'s bytes under another name.
    expect([...written.values()].join('')).not.toContain('hunter2');
    expect(written.has('project/readme.md')).toBe(false);
  });

  /**
   * NOTE ON WHAT THIS ONE DOES AND DOES NOT PROVE. It covers the STATIC case —
   * a directory that is already a symlink when the walk reaches it — and
   * asserts the exclusion is RECORDED, not merely that the loot is absent.
   * The mid-walk variant (a real directory renamed away and replaced with a
   * symlink while the walk is busy elsewhere) was demonstrated by review with
   * a 5 ms timer; it is closed by the realpath containment check now run
   * before EVERY descend, and is deliberately not reproduced here, because a
   * timing-dependent test that passes on a fast machine and fails on a loaded
   * one teaches the next reader to retry rather than to look.
   */
  it('declines a directory symlink out of the root, and records that it declined', async () => {
    await mkdir(join(scratch, 'elsewhere'));
    await writeFile(join(scratch, 'elsewhere', 'LOOT.txt'), 'not yours\n');
    await mkdir(join(workingDir, 'z'));
    await writeFile(join(workingDir, 'z', 'real.txt'), 'mine\n');
    await rm(join(workingDir, 'z'), { recursive: true });
    await symlink(join(scratch, 'elsewhere'), join(workingDir, 'z'));

    const plan = await planProjectArchive(workingDir, undefined, [scratch]);
    expect(plan.entries.map((e) => e.archivePath)).not.toContain('project/z/LOOT.txt');
    // Not merely absent — the walk RECORDS that it declined to descend.
    expect(plan.excluded.map((e) => e.path)).toContain('z');
  });

  it('quotes manifest fields so a filename cannot forge a row', async () => {
    await writeFile(join(workingDir, 'ok.txt'), 'fine\n');
    const forged = 'boring.txt\tsymbolic link\nsanitised.txt\treviewed and safe';
    await symlink(join(workingDir, 'ok.txt'), join(workingDir, forged));

    const plan = await planProjectArchive(workingDir, undefined, [scratch]);
    const written = new Map<string, string>();
    for await (const entry of projectArchiveEntries(plan, plan.rootPath)) {
      written.set(entry.path, entry.bytes.toString('utf8'));
    }
    const manifest = written.get(`project/${ARCHIVE_EXCLUSION_MANIFEST}`) ?? '';
    // The tab and newline survive as ESCAPES, so the forged text cannot become
    // its own line and cannot claim a reason of its own.
    expect(manifest).not.toContain('sanitised.txt\treviewed and safe\t');
    expect(manifest).toContain('\\t');
  });

  it('does not let a real file collide with the receipt and overwrite it', async () => {
    await writeFile(join(workingDir, ARCHIVE_EXCLUSION_MANIFEST), 'nothing was withheld, honest\n');
    await writeFile(join(workingDir, 'app.ts'), 'ok\n');

    const zip = await collect(await archiveHandler()(request()));
    const tree = await treeOf(await extract(zip));

    // The project's own file keeps its name and its content...
    expect(tree.get(`project/${ARCHIVE_EXCLUSION_MANIFEST}`)).toBe('nothing was withheld, honest\n');
    // ...and the real receipt is still present, under a name that did not collide.
    const receipt = [...tree.keys()].find((p) => /_tm8-excluded \(\d+\)\.txt$/.test(p));
    expect(receipt).toBeTruthy();
    expect(tree.get(receipt!)).toContain('JSON-quoted');
  });
});
