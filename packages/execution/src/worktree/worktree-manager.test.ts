// Gate G2 (TM8-WORKTREE-DESIGN §9 Phase 2) — WorktreeManager against REAL git
// repositories in throwaway temp directories. No mocks for git itself: the
// injection and containment claims are about what the real binary receives.
//
//   G2.1  injection — hostile baseRef values are refused or inert, no shell
//   G2.2  containment — segment-wise, symlink root, sibling-prefix path
//   G2.3  post-creation re-assertion catches a parent swapped for a symlink
//         between validation and `git worktree add`, and cleans up
//   G2.4  N concurrent adds on one repo serialize; N distinct paths/branches
//   G2.5  idempotent cleanup — remove twice, remove on already-gone, converge
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorktreeError, assertSafeRefName, runGit } from './git-invoker.js';
import { WorktreeManager, isContainedIn } from './WorktreeManager.js';

// Real git under load — the 5s/10s vitest defaults are not sized for this
// (in-tree precedent: cli inbox.test.ts; the load-sensitivity memory).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const UUIDISH = () =>
  '00000000-0000-4000-8000-000000000000'.replace(/0(?=[0-9a-f]*$)/g, () =>
    Math.floor(Math.random() * 16).toString(16)).slice(0, 36);

function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

let base: string;
let repoRoot: string;
let worktreeRoot: string;
let manager: WorktreeManager;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-worktree-test-'));
  repoRoot = join(base, 'repo');
  worktreeRoot = join(base, 'worktrees');
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  // Repo-LOCAL identity, not the `-c` flags the commits below use. The merge
  // verification exercises production code (`WorktreeManager` runs `git merge`
  // itself), so there is nowhere to thread `-c` through — and a machine with no
  // global identity, which is every fresh CI runner, fails that merge with
  // "empty ident name" before it can answer merged/not-merged.
  await git(['config', 'user.email', 't@t'], repoRoot);
  await git(['config', 'user.name', 't'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'hello\n');
  await git(['add', '.'], repoRoot);
  await git(
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'],
    repoRoot,
  );
  manager = new WorktreeManager({ worktreeRoot });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('G2.1 — injection: hostile refs never reach git as anything but inert argv', () => {
  const hostile = [
    'main; rm -rf /',
    'main`touch /tmp/pwned`',
    'main$(touch /tmp/pwned)',
    'main\nrm -rf /',
    '--upload-pack=/bin/sh',
    '-Oallow-anything',
    'main..HEAD',
    'refs/heads/../../etc',
    'a b',
  ];
  for (const ref of hostile) {
    it(`refuses ${JSON.stringify(ref)}`, async () => {
      await expect(manager.resolveBaseRef(repoRoot, ref)).rejects.toMatchObject({
        name: 'WorktreeError',
        code: 'invalid_input',
      });
      expect(() => assertSafeRefName(ref)).toThrow(WorktreeError);
    });
  }

  it('resolves a legitimate ref to a 40-hex oid, symbolic ref preserved as provenance', async () => {
    const { ref, oid } = await manager.resolveBaseRef(repoRoot, 'main');
    expect(ref).toBe('main');
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('defaults to the repository HEAD branch when no ref is given', async () => {
    const { ref } = await manager.resolveBaseRef(repoRoot);
    expect(ref).toBe('main');
  });

  it('unknown ref → base_ref_not_found, never a fallback', async () => {
    await expect(manager.resolveBaseRef(repoRoot, 'no-such-branch')).rejects.toMatchObject({
      reason: 'base_ref_not_found',
    });
  });

  it('non-repository → not_a_git_repository, never a fallback', async () => {
    const plain = join(base, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    await expect(manager.validateRepository(plain)).rejects.toMatchObject({
      reason: 'not_a_git_repository',
    });
  });
});

describe('G2.2 — containment is segment-wise, on real paths', () => {
  it('sibling-prefix path fails (the startsWith trap)', () => {
    expect(isContainedIn('/data/worktrees-evil/x', '/data/worktrees')).toBe(false);
    expect(isContainedIn('/data/worktrees/x', '/data/worktrees')).toBe(true);
    expect(isContainedIn('/data/worktrees', '/data/worktrees')).toBe(true);
    expect(isContainedIn('/data', '/data/worktrees')).toBe(false);
  });

  it('a .. component in ids is structurally impossible (uuid-shaped or refused)', async () => {
    await expect(manager.computeWorktreePath('..', UUIDISH())).rejects.toMatchObject({
      reason: 'invalid_path_component',
    });
    await expect(manager.computeWorktreePath(PROJECT_ID, '../../etc')).rejects.toMatchObject({
      reason: 'invalid_path_component',
    });
  });

  it('a project dir replaced by a symlink pointing OUTSIDE the root is refused pre-creation', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    const evilProject = '22222222-2222-4222-8222-222222222222';
    await mkdir(await manager.worktreeRoot(), { recursive: true });
    await symlink(outside, join(await manager.worktreeRoot(), evilProject));
    await expect(
      manager.add({
        repoRoot,
        projectId: evilProject,
        worktreeId: UUIDISH(),
        branch: 'tm8/evil-pre',
        baseCommitOid: await git(['rev-parse', 'HEAD'], repoRoot),
      }),
    ).rejects.toMatchObject({ reason: 'containment_violation' });
  });
});

describe('G2.3 — the post-creation re-assertion closes the symlink race', () => {
  it('parent swapped for an outside symlink AFTER validation → caught, checkout cleaned up', async () => {
    const outside = join(base, 'outside-race');
    await mkdir(outside, { recursive: true });
    const raceProject = '33333333-3333-4333-8333-333333333333';
    const worktreeId = UUIDISH();
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    const root = await manager.worktreeRoot();
    const parent = join(root, raceProject);

    await expect(
      manager.add({
        repoRoot,
        projectId: raceProject,
        worktreeId,
        branch: 'tm8/race',
        baseCommitOid: oid,
        onBeforeGitAdd: async () => {
          // The §4.4.3 race, made deterministic: between the parent realpath
          // check and `git worktree add`, the parent becomes a symlink out.
          await rm(parent, { recursive: true, force: true });
          await symlink(outside, parent);
        },
      }),
    ).rejects.toMatchObject({ reason: 'containment_violation' });

    // The escaped checkout was REMOVED, not left behind (§8: cleanup
    // obligation, not warning), and git forgot the worktree registration.
    const escaped = join(outside, worktreeId);
    await expect(stat(escaped)).rejects.toThrow();
    const listed = await manager.list(repoRoot);
    expect(listed.some((e) => e.path.includes(worktreeId))).toBe(false);
    await rm(parent, { recursive: true, force: true });
  });
});

describe('G2.4 — concurrency: one repo, N adds, zero corruption', () => {
  it('5 concurrent adds serialize under the project lock; 5 distinct paths and branches land', async () => {
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        manager.withProjectLock(PROJECT_ID, () =>
          manager.add({
            repoRoot,
            projectId: PROJECT_ID,
            worktreeId: uuidN(i + 1),
            branch: `tm8/conc-${i}`,
            baseCommitOid: oid,
          }),
        ),
      ),
    );
    const paths = new Set(results.map((r) => r.path));
    expect(paths.size).toBe(5);

    // `.git/worktrees` metadata agrees: main + 5, each on its own branch.
    const listed = await manager.list(repoRoot);
    const branches = listed.map((e) => e.branch).filter((b) => b?.startsWith('tm8/conc-'));
    expect(branches).toHaveLength(5);
    expect(new Set(branches).size).toBe(5);

    // Every checkout is real, on disk, inside the root.
    const root = await manager.worktreeRoot();
    for (const r of results) {
      expect(isContainedIn(await realpath(r.path), root)).toBe(true);
    }
  });

  it('a duplicate branch is a refusal, not a silent reuse', async () => {
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    await expect(
      manager.withProjectLock(PROJECT_ID, () =>
        manager.add({
          repoRoot,
          projectId: PROJECT_ID,
          worktreeId: UUIDISH(),
          branch: 'tm8/conc-0',
          baseCommitOid: oid,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'worktree_add_failed' });
  });
});

describe('G2.5 — idempotent cleanup', () => {
  it('remove twice, remove after manual rm -rf — all converge without error', async () => {
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    const { path } = await manager.withProjectLock(PROJECT_ID, () =>
      manager.add({
        repoRoot,
        projectId: PROJECT_ID,
        worktreeId: uuidN(900),
        branch: 'tm8/cleanup-a',
        baseCommitOid: oid,
      }),
    );
    await manager.remove({ repoRoot, path });
    await manager.remove({ repoRoot, path }); // second remove: no throw
    await expect(stat(path)).rejects.toThrow();

    const second = await manager.withProjectLock(PROJECT_ID, () =>
      manager.add({
        repoRoot,
        projectId: PROJECT_ID,
        worktreeId: uuidN(901),
        branch: 'tm8/cleanup-b',
        baseCommitOid: oid,
      }),
    );
    await rm(second.path, { recursive: true, force: true }); // manual disappearance
    await manager.remove({ repoRoot, path: second.path });   // converges via prune
    const listed = await manager.list(repoRoot);
    expect(listed.some((e) => e.branch === 'tm8/cleanup-b')).toBe(false);
  });

  it('remove refuses a dirty worktree without force, removes it with force', async () => {
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    const { path } = await manager.withProjectLock(PROJECT_ID, () =>
      manager.add({
        repoRoot,
        projectId: PROJECT_ID,
        worktreeId: uuidN(902),
        branch: 'tm8/cleanup-dirty',
        baseCommitOid: oid,
      }),
    );
    await writeFile(join(path, 'scratch.txt'), 'uncommitted\n');
    expect(await manager.isDirty(path)).toBe(true);
    await expect(manager.remove({ repoRoot, path })).rejects.toMatchObject({
      reason: 'worktree_remove_refused',
    });
    await manager.remove({ repoRoot, path, force: true });
    await expect(stat(path)).rejects.toThrow();
  });
});

describe('preflight and merge verification (§5.4, §10.1)', () => {
  it('preflight reports dirty/unpushed and mints a stable token over the result', async () => {
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    const { path } = await manager.withProjectLock(PROJECT_ID, () =>
      manager.add({
        repoRoot,
        projectId: PROJECT_ID,
        worktreeId: uuidN(903),
        branch: 'tm8/preflight',
        baseCommitOid: oid,
      }),
    );
    const clean = await manager.preflight({ repoRoot, path, branch: 'tm8/preflight' });
    expect(clean.dirty).toBe(false);
    expect(clean.token).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(path, 'wip.txt'), 'wip\n');
    const dirty = await manager.preflight({ repoRoot, path, branch: 'tm8/preflight' });
    expect(dirty.dirty).toBe(true);
    expect(dirty.token).not.toBe(clean.token);
    await manager.remove({ repoRoot, path, force: true });
  });

  it('an empty worktree answers empty, never merged (the abandoned-before-started case)', async () => {
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);
    const { path } = await manager.withProjectLock(PROJECT_ID, () =>
      manager.add({
        repoRoot,
        projectId: PROJECT_ID,
        worktreeId: uuidN(904),
        branch: 'tm8/verify-empty',
        baseCommitOid: oid,
      }),
    );
    expect(await manager.verifyMerged({
      repoRoot, branch: 'tm8/verify-empty', baseBranch: 'main', baseCommitOid: oid,
    })).toBe('empty');

    // One real commit on the branch, not on main → not_merged.
    await writeFile(join(path, 'feature.txt'), 'feature\n');
    await git(['add', '.'], path);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feature'], path);
    expect(await manager.verifyMerged({
      repoRoot, branch: 'tm8/verify-empty', baseBranch: 'main', baseCommitOid: oid,
    })).toBe('not_merged');

    // Merge it into main (in the primary checkout) → merged.
    await git(['merge', '--no-ff', '-m', 'land', 'tm8/verify-empty'], repoRoot);
    expect(await manager.verifyMerged({
      repoRoot, branch: 'tm8/verify-empty', baseBranch: 'main', baseCommitOid: oid,
    })).toBe('merged');

    // Reset main back so later tests see the original tip.
    await git(['reset', '--hard', oid], repoRoot);
    await manager.remove({ repoRoot, path, force: true });
  });

  it('unpushed counting: a repo with no remotes counts local-only commits', async () => {
    const count = await manager.unpushedCommitCount(repoRoot, 'main');
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// D12 (invariant I3) — a lane branches off the project's DEFAULT branch, never
// whatever branch the working directory is parked on. For a project whose
// working dir is a SHARED checkout, "parked" is the last session's in-flight
// work: 36 of the 68 measured `public.worktrees` rows were based on another
// lane's branch because of it.
describe('G2.6 — default base ref is the project default branch, not parked HEAD', () => {
  let originRepo: string;
  let clone: string;
  let originMainOid: string;
  let parkedOid: string;

  const commit = (cwd: string, message: string) =>
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message], cwd);

  beforeAll(async () => {
    originRepo = join(base, 'origin-repo');
    await mkdir(originRepo, { recursive: true });
    await git(['init', '-b', 'main'], originRepo);
    await writeFile(join(originRepo, 'a.txt'), 'a\n');
    await git(['add', '.'], originRepo);
    await commit(originRepo, 'origin initial');
    originMainOid = await git(['rev-parse', 'HEAD'], originRepo);

    // A clone gets `refs/remotes/origin/HEAD`; a `git remote add` + fetch does
    // not. Both shapes are exercised below.
    clone = join(base, 'shared-checkout');
    await git(['clone', originRepo, clone], base);

    // Park it on another lane's branch, one commit ahead — the shared-checkout
    // situation this defect is about.
    await git(['checkout', '-b', 'lane/parked'], clone);
    await writeFile(join(clone, 'b.txt'), 'b\n');
    await git(['add', '.'], clone);
    await commit(clone, 'another lane in flight');
    parkedOid = await git(['rev-parse', 'HEAD'], clone);
    expect(parkedOid).not.toBe(originMainOid);
    expect(await git(['symbolic-ref', '--short', 'HEAD'], clone)).toBe('lane/parked');
  });

  it('no requested base ref → origin/HEAD’s branch, not the parked branch', async () => {
    const { ref, oid } = await manager.resolveBaseRef(clone);
    expect(ref).toBe('main');
    expect(oid).toBe(originMainOid);
    expect(oid).not.toBe(parkedOid);
  });

  it('the provisioned checkout really lands on the default branch’s commit', async () => {
    const worktreeId = uuidN(612);
    const { ref, oid } = await manager.resolveBaseRef(clone);
    const { path } = await manager.add({
      repoRoot: clone, projectId: PROJECT_ID, worktreeId,
      branch: 'tm8/d12-default', baseCommitOid: oid,
    });
    try {
      expect(ref).toBe('main');
      expect(await git(['rev-parse', 'HEAD'], path)).toBe(originMainOid);
    } finally {
      await manager.remove({ repoRoot: clone, path, force: true });
    }
  });

  it('an explicitly requested ref is still honoured verbatim', async () => {
    const { ref, oid } = await manager.resolveBaseRef(clone, 'lane/parked');
    expect(ref).toBe('lane/parked');
    expect(oid).toBe(parkedOid);
  });

  it('an explicitly requested ref that does not exist still fails base_ref_not_found', async () => {
    await expect(manager.resolveBaseRef(clone, 'lane/never-existed')).rejects.toMatchObject({
      name: 'WorktreeError',
      code: 'invalid_input',
      reason: 'base_ref_not_found',
    });
  });

  it('no origin/HEAD (a fetch-created remote) → the remote-tracking default branch', async () => {
    const fetched = join(base, 'fetched-remote');
    await git(['clone', originRepo, fetched], base);
    await git(['remote', 'set-head', '-d', 'origin'], fetched);
    await git(['checkout', '-b', 'lane/parked-2'], fetched);
    await git(['branch', '-D', 'main'], fetched);

    expect(
      (await runGit(['-C', fetched, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).code,
    ).not.toBe(0);
    const { ref, oid } = await manager.resolveBaseRef(fetched);
    expect(ref).toBe('origin/main');
    expect(oid).toBe(originMainOid);
  });

  it('a repository with no remote and no main/master falls back to local HEAD and provisions', async () => {
    const local = join(base, 'local-only');
    await mkdir(local, { recursive: true });
    await git(['init', '-b', 'wip'], local);
    await writeFile(join(local, 'c.txt'), 'c\n');
    await git(['add', '.'], local);
    await commit(local, 'local only');
    const wipOid = await git(['rev-parse', 'HEAD'], local);

    const { ref, oid } = await manager.resolveBaseRef(local);
    expect(ref).toBe('wip');
    expect(oid).toBe(wipOid);

    const worktreeId = uuidN(613);
    const { path } = await manager.add({
      repoRoot: local, projectId: PROJECT_ID, worktreeId,
      branch: 'tm8/d12-local-only', baseCommitOid: oid,
    });
    try {
      expect(await git(['rev-parse', 'HEAD'], path)).toBe(wipOid);
    } finally {
      await manager.remove({ repoRoot: local, path, force: true });
    }
  });

  it('a remoteless repo that HAS main, parked elsewhere, still bases on main', async () => {
    const localMain = join(base, 'local-with-main');
    await mkdir(localMain, { recursive: true });
    await git(['init', '-b', 'main'], localMain);
    await writeFile(join(localMain, 'd.txt'), 'd\n');
    await git(['add', '.'], localMain);
    await commit(localMain, 'main tip');
    const mainOid = await git(['rev-parse', 'HEAD'], localMain);
    await git(['checkout', '-b', 'lane/other'], localMain);
    await writeFile(join(localMain, 'e.txt'), 'e\n');
    await git(['add', '.'], localMain);
    await commit(localMain, 'other lane');

    const { ref, oid } = await manager.resolveBaseRef(localMain);
    expect(ref).toBe('main');
    expect(oid).toBe(mainOid);
  });
});
