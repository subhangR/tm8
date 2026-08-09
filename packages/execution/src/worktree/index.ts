// Worktree lifecycle (TM8-WORKTREE-DESIGN Phase 2). Exported for the server's
// spawn-integration phase; nothing in this package wires it into SpawnService
// yet — the contract's SpawnWorkdir deliberately still refuses 'worktree'
// until the saga lands (§7.4 prohibition 3: the manager and the contract
// widening must land together, and the widening is Phase 3).
export {
  WorktreeManager,
  isContainedIn,
  type WorktreeAddParams,
  type WorktreeListEntry,
  type WorktreeManagerOptions,
  type WorktreePreflight,
} from './WorktreeManager.js';
export {
  WorktreeError,
  assertCommitOid,
  assertSafeBranchName,
  assertSafeRefName,
  runGit,
  type GitResult,
  type GitRunOptions,
} from './git-invoker.js';
// Tier 2 — the mutating verbs (checkpoint/rollback/stage/commit/merge).
// Exposed through the `@tm8/execution/worktree` subpath so the CLI can load
// them WITHOUT importing the package root, whose module graph pulls node-pty.
export {
  assertMutableWorktree,
  assertSafeMessage,
  assertSafePathspec,
  assertWorktreeDir,
  changedFiles,
  checkpoint,
  commit,
  currentBranch,
  mergeFromRef,
  resolveCommitish,
  rollback,
  stage,
  stagedFiles,
  type ChangedFile,
  type CheckpointResult,
  type CommitResult,
  type GitIdentity,
  type MergeResult,
  type RollbackResult,
} from './git-mutations.js';
// Tier 2 completion — cherry-pick / branch ops / stash (same subpath law).
export {
  assertGitLegalBranchName,
  branchCreate,
  branchDelete,
  branchRename,
  checkedOutBranches,
  cherryPick,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  type BranchCreateResult,
  type BranchDeleteResult,
  type BranchRenameResult,
  type CherryPickResult,
  type StashDropResult,
  type StashEntry,
  type StashPopResult,
  type StashPushResult,
} from './git-mutations.js';
