/**
 * 148 — `internal.pr_owning_session` cannot address a session in another Space.
 *
 * The function is the sole answer to "who owns this pull request", and all
 * three of its callers are `security definer` (103:436, 103:1038, 103:1119), so
 * RLS never gets a vote on what it returns. Its tier-3 fallback matched a
 * session by BRANCH NAME with no Space predicate at all, and the ORDER BY puts
 * LIVENESS ahead OF CONFIDENCE — so a live stranger outranked a dead owner, and
 * `post_session_nudge` then posted CI log tails and review-thread bodies
 * (103:1161-1163) into the stranger's transcript.
 *
 * Every case below is written against the shape today's ORDER BY gets WRONG:
 * the correct session is DEAD and the wrong one is LIVE. A fixture where the
 * right answer is also the live one proves nothing — tier ordering would have
 * carried it either way.
 *
 *   1. Two Spaces, one branch name. PR in A, A's session dead, B's session
 *      live. The addressee is A's session or nobody — never B's.
 *   2. Two PROJECTS in ONE Space, one branch name, different repositories.
 *      Same-Space is necessary but not sufficient.
 *   3. A project with no remote url still matches on branch inside its own
 *      Space — the repo predicate is null-tolerant on purpose, and this is the
 *      test that fails if someone "tightens" it into a null-excluding one.
 *   4. Tier 1 and tier 2 still resolve, and still beat tier 3. This is the
 *      over-broad-predicate canary: a `space_id` join written against the wrong
 *      side of the union takes these red.
 *   5. `internal.repo_slug_from_url` agrees with the server's `repoFromUrl`
 *      on every form the tracking code actually reads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { repoFromUrl } from '../../src/tracking/git-local.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const REPO_A = 'acme/forge';
const REPO_B = 'other/thing';
/** The collision. tm8's own lane branches are `tm8/<8 hex>` — a time bucket. */
const BRANCH = 'tm8/deadbeef';

interface SpaceFixture {
  spaceId: string;
  identityId: string;
  memberId: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
}

let database: W1ScratchDatabase;

/**
 * Everything runs as `tm8_graph_owner`, deliberately: that is the role the
 * three `security definer` callers execute as, so it is the only posture in
 * which "RLS would have stopped it" is not available as an excuse.
 */
async function owner<T>(fn: (q: (sql: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(async (sql, params = []) => (await client.query(sql, [...params])).rows);
  });
}

async function ids(count: number): Promise<string[]> {
  const rows = await database.query<{ id: string }>(
    'select internal.new_id()::text as id from generate_series(1, $1)',
    [count],
  );
  return rows.map((r) => r.id);
}

/** A Space with one member, one project, one worktree on `branch`, one session. */
async function seedSpace(
  label: string,
  options: { repoUrl: string | null; branch: string; status: string },
): Promise<SpaceFixture> {
  const [spaceId, memberId, projectId, worktreeId, sessionId] = await ids(5);
  const identityId = `owner-${label}`;
  const f: SpaceFixture = {
    spaceId: spaceId!, identityId, memberId: memberId!,
    projectId: projectId!, worktreeId: worktreeId!, sessionId: sessionId!,
  };
  await owner(async (q) => {
    await q(`insert into public.user_profiles(identity_id, display_name) values ($1, $2)`,
      [f.identityId, `owner ${label}`]);
    await q(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`,
      [f.spaceId, `space ${label}`, f.identityId]);
    await q(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by) values
         ($1, $4, 'member', null, 0, $1),
         ($2, $4, 'worktree', null, 10, $1),
         ($3, $4, 'work_session', null, 20, $1)`,
      [f.memberId, f.worktreeId, f.sessionId, f.spaceId],
    );
    await q(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', $4)`,
      [f.memberId, f.spaceId, f.identityId, `owner ${label}`],
    );
    await q(
      `insert into public.projects(id, name, working_dir, repo_url, trust)
       values ($1, $2, $3, $4, 'trusted')`,
      [f.projectId, `project ${label}`, `/tmp/tm8-148-${label}`, options.repoUrl],
    );
    await q(
      `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid, status)
       values ($1, $2, $3, $4, 'main', repeat('a', 40), 'active')`,
      [f.worktreeId, f.projectId, `/tmp/tm8-148-${label}/wt`, options.branch],
    );
    await q(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1, $2, $3, 'space')`,
      [f.sessionId, `session ${label}`, options.status],
    );
    await q(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'in_worktree', $4)`,
      [f.spaceId, f.sessionId, f.worktreeId, f.memberId],
    );
  });
  return f;
}

/** A PR mirror in `space`, tracked so it looks exactly like a real watch target. */
async function seedPullRequest(
  space: SpaceFixture,
  options: { repo: string; number: number; headRef: string | null; headSha?: string | null },
): Promise<string> {
  const [prId] = await ids(1);
  await owner(async (q) => {
    await q(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
       values ($1, $2, 'pull_request', null, 30, $3)`,
      [prId, space.spaceId, space.memberId],
    );
    await q(
      `insert into public.pull_requests(entity_id, space_id, url, repo, number, state, head_ref, head_sha)
       values ($1, $2, $3, $4, $5, 'open', $6, $7)`,
      [prId, space.spaceId, `https://github.com/${options.repo}/pull/${options.number}`,
        options.repo, options.number, options.headRef, options.headSha ?? null],
    );
  });
  return prId!;
}

/** An extra work session inside an existing Space (for the tier-1 / tier-2 cases). */
async function seedSession(space: SpaceFixture, label: string, status: string): Promise<string> {
  const [sessionId] = await ids(1);
  await owner(async (q) => {
    await q(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
       values ($1, $2, 'work_session', null, 40, $3)`,
      [sessionId, space.spaceId, space.memberId],
    );
    await q(
      `insert into public.work_sessions(entity_id, title, status, share_mode)
       values ($1, $2, $3, 'space')`,
      [sessionId, `session ${label}`, status],
    );
  });
  return sessionId!;
}

async function owningSession(prId: string): Promise<string | null> {
  const rows = await database.query<{ id: string | null }>(
    'select internal.pr_owning_session($1)::text as id', [prId]);
  return rows[0]?.id ?? null;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('pr-own-148');
  database.apply(migrationFiles());
});

afterAll(async () => {
  await database?.destroy();
});

describe('148 — tier 3 cannot cross a Space boundary', () => {
  it('does not address a LIVE session in another Space for a PR in this one', async () => {
    // The exact combination the ORDER BY gets wrong: correct session DEAD,
    // stranger LIVE, same branch name in both Spaces.
    const spaceA = await seedSpace('a1', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: BRANCH, status: 'exited',
    });
    const spaceB = await seedSpace('b1', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: BRANCH, status: 'running',
    });
    const pr = await seedPullRequest(spaceA, { repo: REPO_A, number: 1, headRef: BRANCH });

    const owningId = await owningSession(pr);

    expect(owningId).not.toBe(spaceB.sessionId);
    // Positive half: the SAME-Space worktree still resolves, so this is a
    // scope fix and not tier 3 quietly switched off.
    expect(owningId).toBe(spaceA.sessionId);
  });

  it('returns nobody rather than a stranger when this Space has no candidate', async () => {
    // Space A contributes no worktree on the branch at all. The only session
    // that matches by name lives in Space B and is live. Before 148 it won.
    const spaceA = await seedSpace('a2', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: 'main', status: 'exited',
    });
    await seedSpace('b2', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: BRANCH, status: 'running',
    });
    const pr = await seedPullRequest(spaceA, { repo: REPO_A, number: 2, headRef: BRANCH });

    expect(await owningSession(pr)).toBeNull();
  });
});

describe('148 — tier 3 cannot cross a project boundary either', () => {
  it('does not match a same-branch worktree from a different repository in the same Space', async () => {
    const space = await seedSpace('a3', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: 'main', status: 'exited',
    });
    // A second project in the SAME Space, different repo, same branch name,
    // and its session is the live one.
    const [projectId, worktreeId, sessionId] = await ids(3);
    await owner(async (q) => {
      await q(
        `insert into public.projects(id, name, working_dir, repo_url, trust)
         values ($1, 'other project', '/tmp/tm8-148-a3-other', $2, 'trusted')`,
        [projectId, `https://github.com/${REPO_B}.git`],
      );
      await q(
        `insert into public.entities(id, space_id, kind, parent_id, position, created_by) values
           ($1, $3, 'worktree', null, 50, $4), ($2, $3, 'work_session', null, 60, $4)`,
        [worktreeId, sessionId, space.spaceId, space.memberId],
      );
      await q(
        `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid, status)
         values ($1, $2, '/tmp/tm8-148-a3-other/wt', $3, 'main', repeat('b', 40), 'active')`,
        [worktreeId, projectId, BRANCH],
      );
      await q(
        `insert into public.work_sessions(entity_id, title, status, share_mode)
         values ($1, 'other project session', 'running', 'space')`,
        [sessionId],
      );
      await q(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'in_worktree', $4)`,
        [space.spaceId, sessionId, worktreeId, space.memberId],
      );
    });
    const pr = await seedPullRequest(space, { repo: REPO_A, number: 3, headRef: BRANCH });

    expect(await owningSession(pr)).toBeNull();
  });

  it('still matches when the project has no remote url — unknown is not excluded', async () => {
    // A local-only project cannot be shown to be a DIFFERENT repository, and
    // turning that into an exclusion would delete working behaviour for every
    // project without a remote. The Space predicate is the guarantee here.
    const space = await seedSpace('a4', { repoUrl: null, branch: BRANCH, status: 'running' });
    const pr = await seedPullRequest(space, { repo: REPO_A, number: 4, headRef: BRANCH });

    expect(await owningSession(pr)).toBe(space.sessionId);
  });

  it('matches case-insensitively, because a forge slug is', async () => {
    const space = await seedSpace('a5', {
      repoUrl: `git@github.com:ACME/Forge.git`, branch: BRANCH, status: 'running',
    });
    const pr = await seedPullRequest(space, { repo: REPO_A, number: 5, headRef: BRANCH });

    expect(await owningSession(pr)).toBe(space.sessionId);
  });
});

describe('148 — tiers 1 and 2 are unchanged', () => {
  it('tier 1 (created_in on the PR) still wins over a live tier-3 match', async () => {
    const space = await seedSpace('a6', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: BRANCH, status: 'running',
    });
    const pr = await seedPullRequest(space, { repo: REPO_A, number: 6, headRef: BRANCH });
    // The tier-1 session is LIVE too, so confidence — not liveness — decides.
    const authored = await seedSession(space, 'a6-tier1', 'running');
    await owner(async (q) => {
      await q(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'created_in', $4)`,
        [space.spaceId, pr, authored, space.memberId],
      );
    });

    expect(await owningSession(pr)).toBe(authored);
  });

  it('tier 2 (the head commit) still resolves, and beats tier 3', async () => {
    const space = await seedSpace('a7', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: BRANCH, status: 'running',
    });
    const headSha = 'c'.repeat(40);
    const pr = await seedPullRequest(space, {
      repo: REPO_A, number: 7, headRef: BRANCH, headSha: headSha.toUpperCase(),
    });
    const committer = await seedSession(space, 'a7-tier2', 'running');
    const [commitId] = await ids(1);
    await owner(async (q) => {
      await q(
        `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
         values ($1, $2, 'commit', null, 70, $3)`,
        [commitId, space.spaceId, space.memberId],
      );
      await q(
        `insert into public.commits(entity_id, space_id, repo, sha, message)
         values ($1, $2, $3, $4, 'head')`,
        [commitId, space.spaceId, REPO_A, headSha],
      );
      await q(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'created_in', $4)`,
        [space.spaceId, commitId, committer, space.memberId],
      );
    });

    expect(await owningSession(pr)).toBe(committer);
  });

  it('a commit in ANOTHER Space is not a tier-2 candidate', async () => {
    // 103 already scoped tier 2; 148 must not have loosened it. The predicate
    // this catches is a `space_id` join written on the wrong side of the union.
    const spaceA = await seedSpace('a8', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: 'main', status: 'exited',
    });
    const spaceB = await seedSpace('b8', {
      repoUrl: `https://github.com/${REPO_A}.git`, branch: 'main', status: 'running',
    });
    const headSha = 'd'.repeat(40);
    const pr = await seedPullRequest(spaceA, {
      repo: REPO_A, number: 8, headRef: 'feat/unmatched', headSha,
    });
    const [commitId] = await ids(1);
    await owner(async (q) => {
      await q(
        `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
         values ($1, $2, 'commit', null, 80, $3)`,
        [commitId, spaceB.spaceId, spaceB.memberId],
      );
      await q(
        `insert into public.commits(entity_id, space_id, repo, sha, message)
         values ($1, $2, $3, $4, 'stranger head')`,
        [commitId, spaceB.spaceId, REPO_A, headSha],
      );
      await q(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'created_in', $4)`,
        [spaceB.spaceId, commitId, spaceB.sessionId, spaceB.memberId],
      );
    });

    expect(await owningSession(pr)).toBeNull();
  });
});

describe('148 — repo_slug_from_url agrees with the server', () => {
  it.each([
    'https://github.com/acme/forge.git',
    'https://github.com/acme/forge',
    'https://github.com/acme/forge/',
    'git@github.com:acme/forge.git',
    'ssh://git@github.com/acme/forge.git',
    '/srv/bare/forge.git',
    'forge',
    '',
  ])('%s', async (url) => {
    const rows = await database.query<{ slug: string | null }>(
      'select internal.repo_slug_from_url($1) as slug', [url]);
    expect(rows[0]?.slug ?? null).toBe(repoFromUrl(url === '' ? null : url));
  });

  it('is NULL for NULL', async () => {
    const rows = await database.query<{ slug: string | null }>(
      'select internal.repo_slug_from_url(null) as slug');
    expect(rows[0]?.slug ?? null).toBeNull();
  });
});
