/**
 * BRANCH-TOPOLOGY FIXTURE — the sample `projects.branches.list` answer the UI
 * list is built and proved against.
 *
 * The five rows are not decoration; each is a case a naive list gets wrong:
 * the DEFAULT branch (ahead/behind are 0/0 by definition — rendering "0
 * behind main" on main itself is the giveaway), the CURRENT branch when it is
 * not the default, a branch with drift in BOTH directions, a MERGED branch
 * (ahead 0 but not the default), and a STALE branch with no upstream. Dates
 * are fixed relative to FIXTURE_NOW — no Date.now() anywhere in fixtures.
 */
import type { ProjectBranchTopology } from '@tm8/contract';
import { FIXTURE_NOW } from './entities';

/** Matches the fixture seam's one linked project (`proj-tm8ui`). */
export const FIXTURE_BRANCH_TOPOLOGY: ProjectBranchTopology = {
  projectId: 'proj-tm8ui',
  workingDir: '/fixture/tm8-ui',
  defaultBranch: 'main',
  defaultBranchSource: 'origin_head',
  staleAfterDays: 30,
  truncated: false,
  branches: [
    {
      name: 'main',
      head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      lastCommitAt: '2026-07-28T09:15:00.000Z',
      subject: 'fix(spaces): use bearer identity for workspace reads',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isDefault: true,
      isCurrent: false,
      merged: true,
      stale: false,
    },
    {
      name: 'feat/branch-topology-ui',
      head: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a',
      lastCommitAt: FIXTURE_NOW,
      subject: 'feat(tm8-ui): mount the branch list in settings',
      upstream: 'origin/feat/branch-topology-ui',
      ahead: 4,
      behind: 2,
      isDefault: false,
      isCurrent: true,
      merged: false,
      stale: false,
    },
    {
      name: 'feat/diff-renderer',
      head: 'c3d4e5f60718293a4b5c6d7e8f90123456789ab0',
      lastCommitAt: '2026-07-27T18:40:00.000Z',
      subject: 'feat(tm8-ui): bounded unified-diff renderer',
      upstream: 'origin/feat/diff-renderer',
      ahead: 3,
      behind: 11,
      isDefault: false,
      isCurrent: false,
      merged: false,
      stale: false,
    },
    {
      name: 'fix/gate-localstorage',
      head: 'd4e5f60718293a4b5c6d7e8f90123456789ab0c1',
      lastCommitAt: '2026-07-20T08:00:00.000Z',
      subject: 'fix(views): stub localStorage in the gate tests',
      upstream: 'origin/fix/gate-localstorage',
      ahead: 0,
      behind: 25,
      isDefault: false,
      isCurrent: false,
      merged: true,
      stale: false,
    },
    {
      name: 'spike/old-terminal-probe',
      head: 'e5f60718293a4b5c6d7e8f90123456789ab0c1d2',
      lastCommitAt: '2026-05-14T11:30:00.000Z',
      subject: 'spike: probe pty resize behaviour',
      upstream: null,
      ahead: 2,
      behind: 214,
      isDefault: false,
      isCurrent: false,
      merged: false,
      stale: true,
    },
  ],
};
