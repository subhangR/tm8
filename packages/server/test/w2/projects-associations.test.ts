import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';

import { runGit } from '@tm8/execution';
import {
  EdgeCorrectionResultSchema,
  ProjectBranchTopologySchema,
  ProjectDirectoryListingSchema,
  ProjectResourceSchema,
  getOperation,
  type OperationName,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2ProjectsAssociationsHandlers } from '../../src/facade/handlers/w2/projects-associations.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  ensureProjectWorkingDirectory,
  listProjectDirectories,
} from '../../src/facade/services/w2/project-directories.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const IDS = {
  space: '00000000-0000-7000-8000-000000000601',
  project: '00000000-0000-7000-8000-000000000602',
  artifact: '00000000-0000-7000-8000-000000000603',
  actor: '00000000-0000-7000-8000-000000000604',
};

const OWNER = {
  identityId: 'g06-owner',
  accountId: '00000000-0000-7000-8000-000000000699',
  username: 'g06-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const PROJECT_ROW = {
  id: IDS.project,
  name: 'tm8',
  repo_url: 'https://example.test/tm8.git',
  working_dir: '/tmp/tm8',
  trust: 'trusted',
  defaults: { model: 'gpt-5.6' },
  link_frozen: false,
  active_link_count: 2,
  created_at: '2026-07-26T10:00:00.000Z',
  updated_at: '2026-07-26T11:00:00.000Z',
};

class FakeDb implements Db {
  readonly calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> = async (fn, args) => {
    this.calls.push({ fn, args });
    if (fn === 'correct_project_association') {
      return {
        artifactId: IDS.artifact,
        projectId: IDS.project,
        outcome: 'removed',
        edgeId: null,
      } as T;
    }
    if (fn === 'link_project_w2' || fn === 'unlink_project_w2') {
      return { spaceId: IDS.space, projectId: IDS.project, patches: [] } as T;
    }
    return { project: PROJECT_ROW, patches: [] } as T;
  };

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
    params: options.params ?? {},
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: `req-${opName}`,
    identity: options.identity ?? { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function registered(db: Db): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2ProjectsAssociationsHandlers(registry, deps(db));
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

describe('W2.G06 projects and association correction facade', () => {
  it('exports one registration seam for the project operations', () => {
    expect(registered(new FakeDb()).implemented()).toEqual([
      'projects.associations.correct',
      'projects.branches.list',
      'projects.create',
      'projects.directories.list',
    'projects.file.blame',
    'projects.file.history',
      'projects.get',
      'projects.link',
      'projects.list',
      'projects.unlink',
      'projects.update',
    ]);
  });

  it('lists only directories inside configured roots and creates one retry-safe child', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'tm8-project-browser-'));
    const root = join(scratch, 'root');
    const outside = join(scratch, 'outside');
    try {
      await mkdir(join(root, 'alpha'), { recursive: true });
      await mkdir(outside);
      await writeFile(join(root, 'notes.txt'), 'not a directory');
      await symlink(outside, join(root, 'escape'));

      const listing = await listProjectDirectories(root, [root]);
      expect(ProjectDirectoryListingSchema.safeParse(listing).success).toBe(true);
      expect(listing.directories).toEqual([{ name: 'alpha', path: join(root, 'alpha') }]);
      expect(listing.parentPath).toBeNull();

      await expect(listProjectDirectories(outside, [root]))
        .rejects.toMatchObject({ code: 'forbidden' });

      const created = await ensureProjectWorkingDirectory(join(root, 'new-project'), [root]);
      expect(created).toBe(join(root, 'new-project'));
      expect(await ensureProjectWorkingDirectory(join(root, 'new-project'), [root])).toBe(created);
      await expect(ensureProjectWorkingDirectory(join(root, 'missing', 'deep'), [root]))
        .rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('defaults the browse scope to the OS filesystem root, not the home directory', async () => {
    const previous = process.env.TM8_PROJECT_ROOTS;
    delete process.env.TM8_PROJECT_ROOTS;
    try {
      const listing = await listProjectDirectories();
      expect(ProjectDirectoryListingSchema.safeParse(listing).success).toBe(true);

      // OS-generic assertion of "this is a filesystem root": `/` on POSIX and
      // `C:\`-shaped on Windows both satisfy `parse(root).root === root`, and
      // the home directory satisfies it on neither.
      expect(listing.roots.length).toBeGreaterThan(0);
      for (const root of listing.roots) expect(parse(root).root).toBe(root);

      // The SCOPE is the filesystem root but the picker OPENS on home: `/` is
      // one click away in the roots rail, while "register a project at /" is
      // not two clicks from the start. See `defaultStartPath`.
      const homeCanonical = await realpath(homedir());
      expect(listing.path).toBe(homeCanonical);

      // The regression itself: the root of the volume that holds the home
      // directory used to be refused as 'outside TM8_PROJECT_ROOTS', which is
      // what made every folder outside home unreachable.
      const osRoot = parse(homedir()).root;
      const atRoot = await listProjectDirectories(osRoot);
      expect(atRoot.path).toBe(await realpath(osRoot));
      expect(atRoot.parentPath).toBeNull();

      // ...and the picker no longer dead-ends at home with no way up, which is
      // what makes opening on home safe to prefer.
      if (homeCanonical !== atRoot.path) {
        expect(listing.parentPath).not.toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env.TM8_PROJECT_ROOTS;
      else process.env.TM8_PROJECT_ROOTS = previous;
    }
  });

  it('still honours TM8_PROJECT_ROOTS when a deployment narrows the browse scope', async () => {
    const previous = process.env.TM8_PROJECT_ROOTS;
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'tm8-narrowed-roots-')));
    process.env.TM8_PROJECT_ROOTS = scratch;
    try {
      await mkdir(join(scratch, 'inside'));
      const listing = await listProjectDirectories();
      expect(listing.roots).toEqual([scratch]);
      expect(listing.path).toBe(scratch);
      expect(listing.parentPath).toBeNull();

      // The configured window still refuses the OS root it sits under.
      await expect(listProjectDirectories(parse(scratch).root))
        .rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      if (previous === undefined) delete process.env.TM8_PROJECT_ROOTS;
      else process.env.TM8_PROJECT_ROOTS = previous;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('refuses authenticated non-admin users both browsing and creating local directories', async () => {
    const registry = registered(new FakeDb());
    const identity = {
      kind: 'bearer' as const,
      identityId: 'ordinary-user',
      token: 'test-token',
      nodeAdmin: false,
    };

    // Browsing used to be open to any authenticated user — the one filesystem
    // verb that was. That was survivable while a node had a single account; it
    // is not once space roles are writable and invite-bound signup makes
    // ordinary members routine, because the default browse scope is the OS
    // filesystem root and `project-files.ts` shares the same roots to read
    // file CONTENTS. A non-admin cannot create a project from what they find
    // (below), so browsing bought them nothing anyway.
    await expect(handler(registry, 'projects.directories.list')(
      request('projects.directories.list', { identity }),
    )).rejects.toMatchObject({ code: 'forbidden' });

    // The node admin still browses, so the picker itself is not broken.
    const listing = await handler(registry, 'projects.directories.list')(
      request('projects.directories.list', {
        identity: { ...identity, nodeAdmin: true },
      }),
    );
    expect(ProjectDirectoryListingSchema.safeParse(listing).success).toBe(true);

    await expect(handler(registry, 'projects.create')(
      request('projects.create', {
        identity,
        body: {
          name: 'refused',
          workingDir: '/tmp/refused-project',
          ensureWorkingDir: true,
          clientMutationId: 'refused-create',
        },
      }),
    )).rejects.toMatchObject({ code: 'forbidden' });

    // The DB's create_project is node-admin-only for BOTH branches (007's
    // require_node_admin), so the handler must refuse the existing-directory
    // path truthfully up front too — not let it fall through to the raw
    // plpgsql 'node admin required'.
    await expect(handler(registry, 'projects.create')(
      request('projects.create', {
        identity,
        body: {
          name: 'refused-existing',
          workingDir: '/tmp/refused-existing-dir',
          clientMutationId: 'refused-create-existing',
        },
      }),
    )).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('node-admin access is required to create a project'),
    });
  });

  it('still requires authentication before exposing local directory names', async () => {
    await expect(handler(registered(new FakeDb()), 'projects.directories.list')(
      request('projects.directories.list', { identity: { kind: 'anonymous' } }),
    )).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns complete ProjectResource shapes and narrows list by a validated active Space link', async () => {
    const db = new FakeDb();
    let sql = '';
    let params: readonly unknown[] = [];
    db.queryImpl = async <R>(text: string, values: readonly unknown[]) => {
      sql = text;
      params = values;
      return [PROJECT_ROW] as R[];
    };
    const result = await handler(registered(db), 'projects.list')(
      request('projects.list', { query: `spaceId=${IDS.space}` }),
    );
    expect(ProjectResourceSchema.array().safeParse(result).success).toBe(true);
    expect(result).toEqual([expect.objectContaining({ linkFrozen: false, activeLinkCount: 2 })]);
    expect(sql).toContain('public.space_projects');
    expect(params).toEqual([IDS.space]);

    await expect(handler(registered(db), 'projects.list')(
      request('projects.list', { query: 'spaceId=not-a-uuid' }),
    )).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('preserves nullable repoUrl in the update patch and uses the W2 fan-out RPC', async () => {
    const db = new FakeDb();
    const result = await handler(registered(db), 'projects.update')(
      request('projects.update', {
        params: { projectId: IDS.project },
        body: { repoUrl: null, clientMutationId: 'g06-update' },
      }),
    );
    expect(ProjectResourceSchema.safeParse(result).success).toBe(true);
    expect(db.calls).toContainEqual({
      fn: 'update_project_w2',
      args: [IDS.project, JSON.stringify({ repoUrl: null }), 'g06-update'],
    });
  });

  it('routes create/link/unlink only through named definer RPCs with the frozen wire results', async () => {
    const db = new FakeDb();
    const registry = registered(db);
    const created = await handler(registry, 'projects.create')(
      request('projects.create', {
        body: { name: 'tm8', workingDir: '/tmp/tm8', clientMutationId: 'g06-create' },
      }),
    );
    expect(created).toMatchObject({ kind: 'json', status: 201 });
    await handler(registry, 'projects.link')(
      request('projects.link', {
        params: { spaceId: IDS.space },
        body: { projectId: IDS.project, actorId: IDS.actor, clientMutationId: 'g06-link' },
      }),
    );
    await handler(registry, 'projects.unlink')(
      request('projects.unlink', {
        params: { spaceId: IDS.space, projectId: IDS.project },
        body: { clientMutationId: 'g06-unlink' },
      }),
    );
    expect(db.calls.map(({ fn }) => fn)).toEqual([
      'create_project',
      'link_project_w2',
      'unlink_project_w2',
    ]);
    expect(db.calls[1]?.args).toEqual([IDS.space, IDS.project, IDS.actor, 'g06-link']);
    expect(db.calls[2]?.args).toEqual([IDS.space, IDS.project, 'g06-unlink']);
  });

  it('returns the exact correction DTO and keeps removed edges null', async () => {
    const db = new FakeDb();
    const result = await handler(registered(db), 'projects.associations.correct')(
      request('projects.associations.correct', {
        params: { artifactId: IDS.artifact },
        body: {
          projectId: IDS.project,
          expectedArtifactVersion: 4,
          clientMutationId: 'g06-correct',
        },
      }),
    );
    expect(EdgeCorrectionResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      artifactId: IDS.artifact,
      projectId: IDS.project,
      outcome: 'removed',
      edge: null,
    });
    expect(db.calls).toContainEqual({
      fn: 'correct_project_association',
      args: [IDS.artifact, IDS.project, 4, 'g06-correct'],
    });
  });

  it('does not redefine the G03 public edge/placement seam in migration 021', async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const [g03, g06] = await Promise.all([
      readFile(resolve(root, 'db/migrations/018_w2_edges_placements.sql'), 'utf8'),
      readFile(resolve(root, 'db/migrations/021_w2_projects.sql'), 'utf8'),
    ]);
    for (const signature of [
      'write_edge(',
      'update_edge(',
      'delete_edge(',
      'place_entity(',
    ]) {
      expect(g03).toContain(`function public.${signature}`);
      expect(g06).not.toContain(`function public.${signature}`);
    }
  });
});

describe('projects.branches.list — the working directory comes from the ROW', () => {
  /** A real repository: the claim is about what git actually answers. */
  async function repoWithBranches(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const scratch = await mkdtemp(join(tmpdir(), 'tm8-branch-topology-facade-'));
    const dir = join(scratch, 'repo');
    const author = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const run = async (args: string[], cwd: string): Promise<void> => {
      const res = await runGit(args, { cwd });
      if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    };
    await run(['init', '-b', 'main', dir], scratch);
    await writeFile(join(dir, 'README.md'), 'hello\n');
    await run(['add', '.'], dir);
    await run([...author, 'commit', '-m', 'initial'], dir);
    await run(['checkout', '-b', 'feat/one'], dir);
    await writeFile(join(dir, 'a.txt'), 'a\n');
    await run(['add', '.'], dir);
    await run([...author, 'commit', '-m', 'feature'], dir);
    await run(['checkout', 'main'], dir);
    return { dir, cleanup: () => rm(scratch, { recursive: true, force: true }) };
  }

  function dbFor(workingDir: string): FakeDb {
    const db = new FakeDb();
    db.queryImpl = async <R,>() => [{ ...PROJECT_ROW, working_dir: workingDir }] as R[];
    return db;
  }

  it('reads the project row, runs git there, and answers the contract shape', async () => {
    const { dir, cleanup } = await repoWithBranches();
    try {
      const topology = await handler(registered(dbFor(dir)), 'projects.branches.list')(
        request('projects.branches.list', { params: { projectId: IDS.project } }),
      );
      expect(ProjectBranchTopologySchema.safeParse(topology).success).toBe(true);
      expect(topology).toMatchObject({
        projectId: IDS.project,
        workingDir: dir,
        defaultBranch: 'main',
        truncated: false,
      });
      const branches = (topology as { branches: { name: string; ahead: number }[] }).branches;
      expect(branches.map((b) => b.name).sort()).toEqual(['feat/one', 'main']);
      expect(branches.find((b) => b.name === 'feat/one')).toMatchObject({ ahead: 1, behind: 0 });
    } finally {
      await cleanup();
    }
  });

  it('names a working directory that is not a repository as invalid_input, not internal', async () => {
    // Otherwise the operator goes looking for a bug in tm8 when the real fact
    // is that THEIR project points at a directory git does not manage.
    const scratch = await mkdtemp(join(tmpdir(), 'tm8-branch-topology-empty-'));
    try {
      await expect(
        handler(registered(dbFor(scratch)), 'projects.branches.list')(
          request('projects.branches.list', { params: { projectId: IDS.project } }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('is not_found for an unknown project, so no git runs at all', async () => {
    const db = new FakeDb();
    db.queryImpl = async <R,>() => [] as R[];
    await expect(
      handler(registered(db), 'projects.branches.list')(
        request('projects.branches.list', { params: { projectId: IDS.project } }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a non-positive staleAfterDays instead of silently defaulting', async () => {
    const { dir, cleanup } = await repoWithBranches();
    try {
      await expect(
        handler(registered(dbFor(dir)), 'projects.branches.list')(
          request('projects.branches.list', {
            params: { projectId: IDS.project },
            query: 'staleAfterDays=0',
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      await cleanup();
    }
  });
});
