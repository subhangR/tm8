import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectFileReadResultSchema, getOperation, type OperationName } from '@tm8/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The TOCTOU case needs to act BETWEEN realpath and open — exactly the window
// the O_NOFOLLOW open exists to close — so realpath is wrapped with a hook
// that a single test arms. Every other call passes straight through.
const raceAfterRealpath: { target: string | null; hook: (() => Promise<void>) | null } = {
  target: null,
  hook: null,
};
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await (actual.realpath as (...a: unknown[]) => Promise<string>)(...args);
      // Only the VICTIM path arms the race: realpath also canonicalizes the
      // roots and the working directory first, and swapping then would make
      // plain containment — not the O_NOFOLLOW open — do the refusing.
      if (raceAfterRealpath.hook && args[0] === raceAfterRealpath.target) {
        const hook = raceAfterRealpath.hook;
        raceAfterRealpath.hook = null;
        raceAfterRealpath.target = null;
        await hook();
      }
      return resolved;
    }) as typeof actual.realpath,
  };
});

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2ProjectFilesHandlers } from '../../src/facade/handlers/w2/project-files.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  isSecretBasename,
  resetDataDirCache,
  secretReason,
  withinTm8DataDir,
} from '../../src/facade/services/w2/project-file-policy.js';
import {
  listProjectFiles,
  readProjectFile,
  resolveProjectFile,
} from '../../src/facade/services/w2/project-files.js';
import type { ProjectFileAuditEvent } from '../../src/facade/services/w2/project-files-service.js';
import { W2BlobStore } from '../../src/files/w2-blob-store.js';
import type { RequestContext } from '../../src/http/types.js';

const IDS = {
  space: '00000000-0000-7000-8000-000000000801',
  project: '00000000-0000-7000-8000-000000000802',
};

const OWNER = {
  identityId: 'file-security-owner',
  accountId: '00000000-0000-7000-8000-000000000899',
  username: 'file-security-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const MAX_SIZE = 1_024 * 1_024;

let scratch: string;
let workingDir: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'tm8-file-security-')));
  workingDir = join(scratch, 'project');
  await mkdir(workingDir);
  resetDataDirCache();
});

afterEach(async () => {
  raceAfterRealpath.hook = null;
  raceAfterRealpath.target = null;
  delete process.env.TM8_DATA_DIR;
  resetDataDirCache();
  await rm(scratch, { recursive: true, force: true });
});

const read = (path: string, inlineMax?: number) =>
  readProjectFile(workingDir, path, inlineMax, [scratch]);

describe('traversal and containment', () => {
  it('holds the separator boundary: a sibling that merely shares the prefix is outside', async () => {
    await mkdir(join(scratch, 'project-secrets'));
    await writeFile(join(scratch, 'project-secrets', 'leak.txt'), 'leak');
    await expect(read(join(scratch, 'project-secrets', 'leak.txt')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses dot-dot traversal even when the raw string starts inside the project', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'outside');
    await expect(read(join(workingDir, '..', 'outside.txt')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses the project root itself and a relative path', async () => {
    await expect(read(workingDir)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(readProjectFile(workingDir, 'relative.txt', undefined, [scratch]))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('symlink policy', () => {
  it('refuses a symlink whose target escapes, and follows one that stays inside', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'outside');
    await symlink(join(scratch, 'outside.txt'), join(workingDir, 'escape.txt'));
    await expect(read(join(workingDir, 'escape.txt'))).rejects.toMatchObject({ code: 'forbidden' });

    await writeFile(join(workingDir, 'real.txt'), 'inside');
    await symlink(join(workingDir, 'real.txt'), join(workingDir, 'alias.txt'));
    const result = await read(join(workingDir, 'alias.txt'));
    expect(result.content).toBe('inside');
    expect(result.path).toBe(join(workingDir, 'real.txt')); // canonical, not the alias
  });

  it('refuses an innocently named symlink by what it RESOLVES to', async () => {
    await writeFile(join(workingDir, '.env'), 'SECRET=1');
    await symlink(join(workingDir, '.env'), join(workingDir, 'readme.txt'));
    await expect(read(join(workingDir, 'readme.txt')))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('withheld') });
  });

  it('TOCTOU: a file swapped for a symlink between resolve and open is refused, not followed', async () => {
    await writeFile(join(scratch, 'outside.txt'), 'the secret bytes');
    const victim = join(workingDir, 'notes.txt');
    await writeFile(victim, 'innocent');
    raceAfterRealpath.target = victim;
    raceAfterRealpath.hook = async () => {
      await unlink(victim);
      await symlink(join(scratch, 'outside.txt'), victim);
    };
    await expect(read(victim)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('secret withholding', () => {
  it('withholds env files, key material and credential homes; an EMPTY file stays readable', async () => {
    for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', '.npmrc', 'credentials.json']) {
      await writeFile(join(workingDir, name), 'secret');
      await expect(read(join(workingDir, name)))
        .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('withheld') });
    }
    await mkdir(join(workingDir, '.ssh'));
    await writeFile(join(workingDir, '.ssh', 'known_hosts'), 'hosts');
    await expect(read(join(workingDir, '.ssh', 'known_hosts')))
      .rejects.toMatchObject({ code: 'forbidden' });

    // Withheld and empty are DIFFERENT answers.
    await writeFile(join(workingDir, 'empty.txt'), '');
    const empty = await read(join(workingDir, 'empty.txt'));
    expect(empty).toMatchObject({ content: '', encoding: 'utf8', sizeBytes: 0, truncated: false });
  });

  it('withholds .git/config but not .git/HEAD or .github', async () => {
    await mkdir(join(workingDir, '.git'));
    await mkdir(join(workingDir, '.github'));
    await writeFile(join(workingDir, '.git', 'config'), '[remote "origin"] token');
    await writeFile(join(workingDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(workingDir, '.github', 'workflow.yml'), 'on: push');

    await expect(read(join(workingDir, '.git', 'config'))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await read(join(workingDir, '.git', 'HEAD'))).content).toContain('refs/heads/main');
    expect((await read(join(workingDir, '.github', 'workflow.yml'))).content).toContain('push');
  });

  it('applies the same policy to attach resolution', async () => {
    await writeFile(join(workingDir, '.env'), 'SECRET=1');
    await expect(resolveProjectFile(workingDir, join(workingDir, '.env'), MAX_SIZE, [scratch]))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('withheld') });
  });

  it('omits secret files and node_modules from a listing, so a picker cannot offer them', async () => {
    await writeFile(join(workingDir, '.env'), 'SECRET=1');
    await writeFile(join(workingDir, 'id_ed25519'), 'key');
    await writeFile(join(workingDir, 'notes.md'), 'hello');
    await mkdir(join(workingDir, 'node_modules'));
    await mkdir(join(workingDir, 'src'));

    const listing = await listProjectFiles(workingDir, undefined, MAX_SIZE, [scratch]);
    expect(listing.files.map((entry) => entry.name)).toEqual(['notes.md']);
    expect(listing.directories.map((entry) => entry.name)).toEqual(['src']);
  });

  it('does not let a secret-looking segment ABOVE the jail poison the whole project', async () => {
    const nest = join(scratch, '.aws-tools');
    await mkdir(nest);
    await mkdir(join(nest, 'project'));
    await writeFile(join(nest, 'project', 'notes.md'), 'fine');
    const result = await readProjectFile(join(nest, 'project'), join(nest, 'project', 'notes.md'), undefined, [scratch]);
    expect(result.content).toBe('fine');
  });

  it('names the secret basenames it means', () => {
    expect(isSecretBasename('.env.production')).toBe(true);
    expect(isSecretBasename('id_ed25519.pub')).toBe(true);
    expect(isSecretBasename('.envrc-notes.md')).toBe(false);
    expect(isSecretBasename('environment.ts')).toBe(false);
    expect(secretReason('/p', '/p/.ssh/id_rsa')).toContain('.ssh');
    expect(secretReason('/p', '/p/src/env.ts')).toBeNull();
  });
});

describe('the tm8 data directory', () => {
  it('is denied even when the project root contains it, except the worktrees subtree', async () => {
    const dataDir = join(scratch, 'data');
    await mkdir(dataDir);
    await mkdir(join(dataDir, 'worktrees'));
    await mkdir(join(dataDir, 'worktrees', 'wt'));
    await writeFile(join(dataDir, 'grant.key'), 'grant secret');
    await writeFile(join(dataDir, 'worktrees', 'wt', 'main.ts'), 'export {}');
    process.env.TM8_DATA_DIR = dataDir;
    resetDataDirCache();

    expect(await withinTm8DataDir(join(dataDir, 'grant.key'))).toBe(true);
    expect(await withinTm8DataDir(join(dataDir, 'worktrees', 'wt', 'main.ts'))).toBe(false);
    expect(await withinTm8DataDir(join(scratch, 'elsewhere.txt'))).toBe(false);

    // Through the jail: a project whose workingDir IS the data dir's parent.
    await expect(readProjectFile(scratch, join(dataDir, 'grant.key'), undefined, [scratch]))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('tm8 data directory') });
    const wt = await readProjectFile(scratch, join(dataDir, 'worktrees', 'wt', 'main.ts'), undefined, [scratch]);
    expect(wt.content).toBe('export {}');
  });
});

describe('inline read shape', () => {
  it('answers utf8 for text, base64 for binary, and truncates over the inline ceiling', async () => {
    await writeFile(join(workingDir, 'a.txt'), 'plain text');
    await writeFile(join(workingDir, 'a.bin'), Buffer.from([0x00, 0xff, 0x10, 0x80]));
    await writeFile(join(workingDir, 'big.txt'), 'x'.repeat(64));

    const text = await read(join(workingDir, 'a.txt'));
    expect(text).toMatchObject({ encoding: 'utf8', content: 'plain text', truncated: false });
    expect(ProjectFileReadResultSchema.safeParse({ projectId: IDS.project, ...text }).success).toBe(true);

    const binary = await read(join(workingDir, 'a.bin'));
    expect(binary.encoding).toBe('base64');
    expect(Buffer.from(binary.content, 'base64')).toEqual(Buffer.from([0x00, 0xff, 0x10, 0x80]));

    const big = await read(join(workingDir, 'big.txt'), 16);
    expect(big).toMatchObject({ truncated: true, sizeBytes: 64, content: 'x'.repeat(16) });
  });

  it('never reports an inline type a UI would render as active content', async () => {
    await writeFile(join(workingDir, 'page.html'), '<script>alert(1)</script>');
    await writeFile(join(workingDir, 'pic.svg'), '<svg onload="alert(1)"/>');
    expect((await read(join(workingDir, 'page.html'))).mime).toBe('text/plain');
    expect((await read(join(workingDir, 'pic.svg'))).mime).toBe('text/plain');
  });
});

// ── facade authorization + audit ─────────────────────────────────────────────

class FakeDb implements Db {
  queryImpl: <R>(sql: string) => Promise<R[]> = async (sql) =>
    (/from public\.projects/.test(sql) ? [{ working_dir: workingDir }] : []) as never;

  tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: <R>(sql: string) => this.queryImpl<R>(sql),
      rpc: async () => {
        throw new Error('unexpected rpc');
      },
    });
  }

  query<R>(_claims: DbClaims, sql: string): Promise<R[]> {
    return this.queryImpl<R>(sql);
  }

  async rpc<T>(): Promise<T> {
    throw new Error('unexpected rpc');
  }

  async end(): Promise<void> {}
}

function harness(): { registry: HandlerRegistry; events: ProjectFileAuditEvent[] } {
  const events: ProjectFileAuditEvent[] = [];
  const registry = new HandlerRegistry();
  registerW2ProjectFilesHandlers(
    registry,
    { db: new FakeDb(), config: {} as FacadeDeps['config'], owner: async () => OWNER },
    {
      blobStore: new W2BlobStore({ dataDir: join(scratch, 'blob-data'), maxSizeBytes: MAX_SIZE }),
      maxSizeBytes: MAX_SIZE,
      audit: (event) => events.push(event),
    },
  );
  return { registry, events };
}

function request(opName: OperationName, options: {
  query?: string;
  body?: unknown;
  identity?: RequestContext['identity'];
} = {}): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: { projectId: IDS.project },
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: `req-${opName}`,
    identity: options.identity ?? { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

const MEMBER = { kind: 'bearer' as const, identityId: 'ordinary-member', token: 't', nodeAdmin: false };

describe('authorization at the facade', () => {
  it('lets a member the project row is VISIBLE to list and read, but not attach', async () => {
    await writeFile(join(workingDir, 'notes.md'), 'hello');
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const { registry } = harness();
      const listing = await registry.get('projects.files.list')!(
        request('projects.files.list', { identity: MEMBER }),
      ) as { files: Array<{ name: string }> };
      expect(listing.files.map((entry) => entry.name)).toEqual(['notes.md']);

      const result = await registry.get('projects.files.read')!(
        request('projects.files.read', { identity: MEMBER, query: `path=${join(workingDir, 'notes.md')}` }),
      ) as { content: string };
      expect(result.content).toBe('hello');

      await expect(registry.get('projects.files.attach')!(
        request('projects.files.attach', {
          identity: MEMBER,
          body: { clientMutationId: 'm-1', spaceId: IDS.space, path: join(workingDir, 'notes.md') },
        }),
      )).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });

  it('refuses anonymous callers and requires the path parameter on read', async () => {
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const { registry } = harness();
      await expect(registry.get('projects.files.read')!(
        request('projects.files.read', { identity: { kind: 'anonymous' } }),
      )).rejects.toMatchObject({ code: 'invalid_input' }); // path missing is answered first
      await expect(registry.get('projects.files.list')!(
        request('projects.files.list', { identity: { kind: 'anonymous' } }),
      )).rejects.toMatchObject({ code: 'unauthenticated' });
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });

  it('audits every access INCLUDING refusals, with the caller and the refusal code', async () => {
    await writeFile(join(workingDir, '.env'), 'SECRET=1');
    await writeFile(join(workingDir, 'notes.md'), 'hello');
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      const { registry, events } = harness();
      await registry.get('projects.files.read')!(
        request('projects.files.read', { identity: MEMBER, query: `path=${join(workingDir, 'notes.md')}` }),
      );
      await registry.get('projects.files.read')!(
        request('projects.files.read', { identity: MEMBER, query: `path=${join(workingDir, '.env')}` }),
      ).catch(() => undefined);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        op: 'projects.files.read',
        projectId: IDS.project,
        path: join(workingDir, 'notes.md'),
        identityId: 'ordinary-member',
        outcome: 'allowed',
      });
      expect(events[1]).toMatchObject({
        outcome: 'refused',
        code: 'forbidden',
        path: join(workingDir, '.env'),
      });
    } finally {
      delete process.env.TM8_PROJECT_ROOTS;
    }
  });
});
