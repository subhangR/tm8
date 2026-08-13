// @tm8/execution — the branch fact of a checkout (107).
//
// One probe, `git branch --show-current`, run in the directory a session is
// about to work in. Every non-answer collapses to NULL and NULL is the honest
// value: not a repository, a detached HEAD (the command prints an empty
// line), git missing, the directory gone, or the probe timing out. A lane
// line renders NO claim for NULL — so this function must never invent one,
// and it must never make a spawn fail: a session that cannot report its
// branch is degraded, not broken.

import { runGit } from '../worktree/git-invoker.js';

/** Fast — this sits on the spawn path; a hung git must not delay a launch. */
const PROBE_TIMEOUT_MS = 5_000;

export async function detectCheckoutBranch(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(['branch', '--show-current'], {
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.code !== 0) return null;
    const branch = result.stdout.trim();
    return branch === '' ? null : branch;
  } catch {
    // git not runnable at all — the same NULL as "no repo": no claim.
    return null;
  }
}
