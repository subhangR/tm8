import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EntityId,
  SessionGitDiff,
  SessionGitStatus,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DiffView, Pill } from '../kit';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import './session-git.css';

/**
 * THE SESSION GIT RAIL — where is this lane, what did it change, and the
 * verbs that move it: checkpoint / rollback / commit / merge-base-in, plus
 * the Tier 2 completion verbs — cherry-pick, branch create/rename/delete,
 * and stash push/pop/drop (the stash LIST rides on the status read).
 *
 * SELF-FETCHING like SessionDebugBody: it receives the seam and does its own
 * reads. The host mounts it only while the Git chip is selected, so unmounting
 * stops the poll; `live` carries the other half (no poll on an exited session).
 *
 * HONESTY (requirements, not polish):
 *   · `available:false` renders the NAMED reason — a session without a
 *     worktree is a normal state with an explanation, never an empty panel;
 *   · every verb that is not currently possible renders DisabledWithReason —
 *     a dead button with no caption is the failure mode this rail replaces;
 *   · a merge CONFLICT is surfaced as a banner naming every conflicted path —
 *     the server restored the worktree clean, and saying so is part of the
 *     answer;
 *   · destructive verbs (rollback; merge, which writes a commit) take a
 *     two-step INLINE confirm — never a browser dialog;
 *   · the diff header always shows the full digest; a capped text says so.
 *
 * MERGE DIRECTION, spelled out in the UI: base → session branch only. The
 * other direction is deliberately absent at every layer (base is checked out
 * in the user's primary tree or nowhere); landing on base goes through a PR.
 * CHERRY-PICK has a direction too, and it is spelled out the same way: the
 * named commits are copied ONTO this session's branch, in this session's
 * worktree — no other checkout is ever touched.
 *
 * The Tier 2 destructive gates surface here as the confirm captions: an
 * unmerged branch delete and a stash drop both require force server-side,
 * and the receipts repeat the recoverable oid the server answers, because
 * reversibility is part of the answer.
 */

const POLL_MS = 5_000;

export interface SessionGitBodyProps {
  seam: Seam;
  sessionId: EntityId;
  /** The session is running — poll status. Exited ⇒ one read, no poll. */
  live: boolean;
}

type StatusState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; status: SessionGitStatus };

type DiffState =
  | { phase: 'closed' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; diff: SessionGitDiff };

type Verb =
  | 'checkpoint' | 'rollback' | 'commit' | 'merge'
  | 'cherry-pick' | 'branch' | 'stash-push' | 'stash-pop' | 'stash-drop';

interface Conflict {
  /** The full first line of the banner — each verb states its own facts. */
  title: string;
  paths: string[];
  remedy: string;
}

const UNAVAILABLE_CAUSE: Record<string, string> = {
  no_worktree:
    'This session has no isolated worktree — it runs in a scratch or shared project directory.',
  worktree_not_active: 'This session’s worktree is no longer active.',
  worktree_unreadable: 'This session’s worktree exists but its files are not readable on this node.',
};

function reasonFor(status: SessionGitStatus): { cause: string; remedy?: string } {
  const cause = UNAVAILABLE_CAUSE[status.unavailableReason ?? ''] ?? 'Git state is unavailable for this session.';
  return status.unavailableReason === 'no_worktree'
    ? { cause, remedy: 'spawn with workdir mode “worktree” to get an operable lane' }
    : { cause };
}

function shortOid(oid: string | null): string {
  return oid ? oid.slice(0, 10) : '—';
}

export function SessionGitBody({ seam, sessionId, live }: SessionGitBodyProps) {
  const [status, setStatus] = useState<StatusState>({ phase: 'loading' });
  const [diff, setDiff] = useState<DiffState>({ phase: 'closed' });
  const [busy, setBusy] = useState<Verb | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [rollbackTo, setRollbackTo] = useState('');
  const [cherryRefs, setCherryRefs] = useState('');
  const [branchName, setBranchName] = useState('');
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [deleteName, setDeleteName] = useState('');
  const [deleteForce, setDeleteForce] = useState(false);
  const hasLoaded = useRef(false);
  const diffOpen = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = await seam.gitStatus(sessionId);
      hasLoaded.current = true;
      setStatus({ phase: 'ready', status: next });
    } catch (err) {
      // A transient poll failure must not blank an already-rendered rail.
      if (!hasLoaded.current) {
        setStatus({ phase: 'error', message: err instanceof Error ? err.message : 'Git status read failed' });
      }
    }
  }, [seam, sessionId]);

  const loadDiff = useCallback(async () => {
    setDiff((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    try {
      const next = await seam.gitDiff(sessionId);
      setDiff({ phase: 'ready', diff: next });
    } catch (err) {
      setDiff({ phase: 'error', message: err instanceof Error ? err.message : 'Diff read failed' });
    }
  }, [seam, sessionId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void loadStatus(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, loadStatus]);

  const refreshAfterVerb = useCallback(async () => {
    await loadStatus();
    if (diffOpen.current) await loadDiff();
  }, [loadStatus, loadDiff]);

  const runVerb = useCallback(
    async (verb: Verb, run: () => Promise<string>) => {
      setBusy(verb);
      setActionError(null);
      setConfirming(null);
      try {
        const text = await run();
        setReceipt(text);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `${verb} failed`);
      } finally {
        setBusy(null);
        await refreshAfterVerb();
      }
    },
    [refreshAfterVerb],
  );

  const toggleDiff = useCallback(() => {
    if (diff.phase === 'closed') {
      diffOpen.current = true;
      void loadDiff();
    } else {
      diffOpen.current = false;
      setDiff({ phase: 'closed' });
    }
  }, [diff.phase, loadDiff]);

  if (status.phase === 'loading') {
    return <div className="pn-git" data-testid="session-git-body"><p className="pn-git__note">Reading git status…</p></div>;
  }
  if (status.phase === 'error') {
    return (
      <div className="pn-git" data-testid="session-git-body">
        <p className="pn-git__error" role="alert">Git status failed: {status.message}</p>
      </div>
    );
  }

  const s = status.status;

  if (!s.available) {
    const reason = reasonFor(s);
    return (
      <div className="pn-git" data-testid="session-git-body">
        <div className="pn-git__empty" data-testid="session-git-unavailable">
          <p className="pn-git__note">{reason.cause}</p>
          {reason.remedy ? <p className="pn-git__remedy">{reason.remedy}</p> : null}
        </div>
      </div>
    );
  }

  const clean = s.dirty.total === 0;

  return (
    <div className="pn-git" data-testid="session-git-body">
      {/* -- status header ---------------------------------------------------- */}
      <div className="pn-git__header" data-testid="session-git-header">
        <span className="pn-git__branch" title={`branch ${s.branch ?? ''}`}>
          <span aria-hidden className="pn-git__branch-glyph">⎇</span>
          {s.branch ?? '(detached)'}
        </span>
        {s.ahead !== null && s.behind !== null ? (
          <span className="pn-git__counts" data-testid="session-git-ahead-behind">
            <Pill tone={s.ahead > 0 ? 'run' : 'idle'} title={`${s.ahead} commit(s) ahead of ${s.baseRef ?? 'base'}`}>
              ↑{s.ahead}
            </Pill>
            <Pill tone={s.behind > 0 ? 'wait' : 'idle'} title={`${s.behind} commit(s) behind ${s.baseRef ?? 'base'}`}>
              ↓{s.behind}
            </Pill>
          </span>
        ) : (
          <span className="pn-git__note">ahead/behind unknown — the base ref did not resolve</span>
        )}
        <Pill tone={clean ? 'idle' : 'info'} title={`${s.dirty.staged} staged · ${s.dirty.unstaged} unstaged · ${s.dirty.untracked} untracked`}>
          {clean ? 'clean' : `${s.dirty.total} dirty`}
        </Pill>
        <span className="pn-git__base">
          base {s.baseRef ?? shortOid(s.baseOid)} · head {shortOid(s.headOid)}
        </span>
      </div>

      {/* -- dirty files ------------------------------------------------------ */}
      {s.files.length > 0 ? (
        <ul className="pn-git__files" data-testid="session-git-files">
          {s.files.map((f) => (
            <li key={`${f.status}:${f.path}`}>
              <code className="pn-git__file-status">{f.status}</code>
              <span className="pn-git__file-path">{f.path}</span>
            </li>
          ))}
          {s.filesTruncated ? <li className="pn-git__note">…list truncated by the server’s cap</li> : null}
        </ul>
      ) : null}

      {/* -- conflict banner -------------------------------------------------- */}
      {conflict ? (
        <div className="pn-git__conflict" role="alert" data-testid="session-git-conflict">
          <p className="pn-git__conflict-title">{conflict.title}</p>
          <ul>
            {conflict.paths.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
          <p className="pn-git__remedy">{conflict.remedy}</p>
        </div>
      ) : null}

      {actionError ? <p className="pn-git__error" role="alert" data-testid="session-git-action-error">{actionError}</p> : null}
      {receipt ? <p className="pn-git__receipt" data-testid="session-git-receipt">{receipt}</p> : null}

      {/* -- action rail ------------------------------------------------------ */}
      <div className="pn-git__actions" data-testid="session-git-actions">
        {clean ? (
          <DisabledAction reason={{ cause: 'The worktree is clean — there is nothing to checkpoint.' }}>
            Checkpoint
          </DisabledAction>
        ) : (
          <button
            type="button"
            className="pn-git__verb"
            disabled={busy !== null}
            data-testid="session-git-checkpoint"
            onClick={() =>
              void runVerb('checkpoint', async () => {
                const r = await seam.commands.gitCheckpoint(sessionId, {});
                setRollbackTo(r.oid);
                return r.created
                  ? `checkpoint ${shortOid(r.oid)} captured ${r.files.length} file(s) — roll back with the ref below`
                  : `worktree already clean; checkpoint ref is HEAD ${shortOid(r.oid)}`;
              })
            }
          >
            {busy === 'checkpoint' ? 'Checkpointing…' : 'Checkpoint'}
          </button>
        )}

        <span className="pn-git__rollback-group">
          <input
            className="pn-git__ref-input"
            placeholder="rollback ref (oid)"
            value={rollbackTo}
            data-testid="session-git-rollback-ref"
            onChange={(e) => setRollbackTo(e.target.value)}
          />
          {rollbackTo.trim() === '' ? (
            <DisabledAction reason={{ cause: 'Rollback needs a checkpoint ref.', remedy: 'checkpoint first — its oid lands here' }}>
              Rollback
            </DisabledAction>
          ) : confirming === 'rollback' ? (
            <span className="pn-git__confirm" data-testid="session-git-rollback-confirm">
              <span className="pn-git__confirm-text">
                Reset {s.branch} to {shortOid(rollbackTo)}? Tracked WIP is discarded (untracked files refuse without force).
              </span>
              <button
                type="button"
                className="pn-git__verb pn-git__verb--danger"
                disabled={busy !== null}
                data-testid="session-git-rollback-go"
                onClick={() =>
                  void runVerb('rollback', async () => {
                    const r = await seam.commands.gitRollback(sessionId, { to: rollbackTo.trim() });
                    return `rolled back to ${shortOid(r.oid)}; previous HEAD ${shortOid(r.previousOid)} stays reachable via the reflog`;
                  })
                }
              >
                Confirm rollback
              </button>
              <button type="button" className="pn-git__verb" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-rollback"
              onClick={() => setConfirming('rollback')}
            >
              {busy === 'rollback' ? 'Rolling back…' : 'Rollback…'}
            </button>
          )}
        </span>

        <span className="pn-git__commit-group">
          <input
            className="pn-git__message-input"
            placeholder="commit message"
            value={commitMessage}
            data-testid="session-git-commit-message"
            onChange={(e) => setCommitMessage(e.target.value)}
          />
          {clean ? (
            <DisabledAction reason={{ cause: 'Nothing to commit — the worktree is clean.' }}>Commit</DisabledAction>
          ) : commitMessage.trim() === '' ? (
            <DisabledAction reason={{ cause: 'A commit needs a message.' }}>Commit</DisabledAction>
          ) : (
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-commit"
              onClick={() =>
                void runVerb('commit', async () => {
                  const r = await seam.commands.gitCommit(sessionId, { message: commitMessage.trim(), all: true });
                  setCommitMessage('');
                  return `committed ${shortOid(r.oid)} on ${r.branch} (${r.files.length} file(s))`;
                })
              }
            >
              {busy === 'commit' ? 'Committing…' : 'Commit all'}
            </button>
          )}
        </span>

        {!clean ? (
          <DisabledAction
            reason={{ cause: 'Merge refuses while the worktree is dirty — a conflicted merge must be able to abort to a clean state.', remedy: 'checkpoint or commit first' }}
          >
            Merge base in
          </DisabledAction>
        ) : confirming === 'merge' ? (
          <span className="pn-git__confirm" data-testid="session-git-merge-confirm">
            <span className="pn-git__confirm-text">
              Merge {s.baseRef ?? 'the recorded base'} INTO {s.branch}? (Landing this lane on {s.baseRef ?? 'base'} goes through a PR — that direction is deliberately not offered.)
            </span>
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-merge-go"
              onClick={() =>
                void runVerb('merge', async () => {
                  const r = await seam.commands.gitMerge(sessionId, {});
                  if (r.status === 'conflict') {
                    setConflict({
                      title: `Merge of ${r.fromRef} CONFLICTED — the worktree was restored clean; nothing was merged.`,
                      paths: r.conflictedPaths,
                      remedy: `Resolve by merging ${r.fromRef} in a checkout you control, or land this lane through a PR.`,
                    });
                    return `merge of ${r.fromRef} conflicted on ${r.conflictedPaths.length} path(s) — worktree restored clean`;
                  }
                  setConflict(null);
                  return r.status === 'up_to_date'
                    ? `already up to date with ${r.fromRef}`
                    : `merged ${r.fromRef} → ${shortOid(r.oid)}`;
                })
              }
            >
              Confirm merge
            </button>
            <button type="button" className="pn-git__verb" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="pn-git__verb"
            disabled={busy !== null}
            data-testid="session-git-merge"
            onClick={() => setConfirming('merge')}
          >
            {busy === 'merge' ? 'Merging…' : 'Merge base in…'}
          </button>
        )}
      </div>

      {/* -- cherry-pick ------------------------------------------------------ */}
      <div className="pn-git__actions" data-testid="session-git-cherry-group">
        <input
          className="pn-git__ref-input"
          placeholder="commit(s) to pick, oldest first"
          value={cherryRefs}
          data-testid="session-git-cherry-refs"
          onChange={(e) => setCherryRefs(e.target.value)}
        />
        {!clean ? (
          <DisabledAction reason={{ cause: 'Cherry-pick refuses while the worktree is dirty — a conflicted pick must be able to abort to a clean state.', remedy: 'checkpoint or commit first' }}>
            Cherry-pick
          </DisabledAction>
        ) : cherryRefs.trim() === '' ? (
          <DisabledAction reason={{ cause: 'Cherry-pick needs at least one commit ref.' }}>Cherry-pick</DisabledAction>
        ) : confirming === 'cherry-pick' ? (
          <span className="pn-git__confirm" data-testid="session-git-cherry-confirm">
            <span className="pn-git__confirm-text">
              Copy {cherryRefs.trim().split(/\s+/).join(', ')} ONTO {s.branch}, in this session’s worktree? No other checkout is touched; a conflict aborts the whole sequence and restores the worktree clean.
            </span>
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-cherry-go"
              onClick={() =>
                void runVerb('cherry-pick', async () => {
                  const commits = cherryRefs.trim().split(/\s+/);
                  const r = await seam.commands.gitCherryPick(sessionId, { commits });
                  if (r.status === 'conflict') {
                    setConflict({
                      title: `Cherry-pick onto ${r.branch} CONFLICTED — the whole sequence was aborted and the worktree was restored clean; nothing was applied.`,
                      paths: r.conflictedPaths,
                      remedy: 'Resolve in a checkout you control, or pick a different commit range.',
                    });
                    return `cherry-pick conflicted on ${r.conflictedPaths.length} path(s) — worktree restored clean`;
                  }
                  setConflict(null);
                  setCherryRefs('');
                  return `picked ${r.newOids.length} commit(s) onto ${r.branch} (${r.newOids.map((o) => o.slice(0, 10)).join(', ')})`;
                })
              }
            >
              Confirm cherry-pick
            </button>
            <button type="button" className="pn-git__verb" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="pn-git__verb"
            disabled={busy !== null}
            data-testid="session-git-cherry"
            onClick={() => setConfirming('cherry-pick')}
          >
            {busy === 'cherry-pick' ? 'Picking…' : 'Cherry-pick…'}
          </button>
        )}
      </div>

      {/* -- branch ops ------------------------------------------------------- */}
      <div className="pn-git__actions" data-testid="session-git-branch-group">
        <span className="pn-git__branch-create">
          <input
            className="pn-git__ref-input"
            placeholder="new branch name"
            value={branchName}
            data-testid="session-git-branch-name"
            onChange={(e) => setBranchName(e.target.value)}
          />
          {branchName.trim() === '' ? (
            <DisabledAction reason={{ cause: 'Creating a branch needs a name.' }}>New branch</DisabledAction>
          ) : (
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-branch-create"
              onClick={() =>
                void runVerb('branch', async () => {
                  const r = await seam.commands.gitBranch(sessionId, { action: 'create', name: branchName.trim() });
                  if (r.action !== 'create') return 'branch created';
                  setBranchName('');
                  return `created ${r.name} at ${shortOid(r.oid)} (not checked out anywhere)`;
                })
              }
            >
              New branch
            </button>
          )}
        </span>
        <span className="pn-git__branch-rename">
          <input
            className="pn-git__ref-input"
            placeholder="rename: old name"
            value={renameFrom}
            data-testid="session-git-branch-rename-from"
            onChange={(e) => setRenameFrom(e.target.value)}
          />
          <input
            className="pn-git__ref-input"
            placeholder="new name"
            value={renameTo}
            data-testid="session-git-branch-rename-to"
            onChange={(e) => setRenameTo(e.target.value)}
          />
          {renameFrom.trim() === '' || renameTo.trim() === '' ? (
            <DisabledAction reason={{ cause: 'Renaming needs both the old and the new name.', remedy: 'a branch checked out in any worktree, or the project base, will refuse' }}>
              Rename
            </DisabledAction>
          ) : (
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-branch-rename"
              onClick={() =>
                void runVerb('branch', async () => {
                  const r = await seam.commands.gitBranch(sessionId, { action: 'rename', from: renameFrom.trim(), to: renameTo.trim() });
                  if (r.action !== 'rename') return 'branch renamed';
                  setRenameFrom('');
                  setRenameTo('');
                  return `renamed ${r.from} → ${r.to}`;
                })
              }
            >
              Rename
            </button>
          )}
        </span>
        <span className="pn-git__branch-delete">
          <input
            className="pn-git__ref-input"
            placeholder="branch to delete"
            value={deleteName}
            data-testid="session-git-branch-delete-name"
            onChange={(e) => setDeleteName(e.target.value)}
          />
          {deleteName.trim() === '' ? (
            <DisabledAction reason={{ cause: 'Deleting a branch needs its name.', remedy: 'checked-out and base branches refuse; an unmerged delete needs force' }}>
              Delete branch
            </DisabledAction>
          ) : confirming === 'branch-delete' ? (
            <span className="pn-git__confirm" data-testid="session-git-branch-delete-confirm">
              <span className="pn-git__confirm-text">
                Delete {deleteName.trim()}? A branch checked out in ANY worktree, or the project base, refuses. An unmerged delete (measured against {s.branch}) refuses without force — the deleted tip stays reachable by its oid until gc.
              </span>
              <label className="pn-git__force">
                <input
                  type="checkbox"
                  checked={deleteForce}
                  data-testid="session-git-branch-delete-force"
                  onChange={(e) => setDeleteForce(e.target.checked)}
                />
                force (delete even if unmerged)
              </label>
              <button
                type="button"
                className="pn-git__verb pn-git__verb--danger"
                disabled={busy !== null}
                data-testid="session-git-branch-delete-go"
                onClick={() =>
                  void runVerb('branch', async () => {
                    const r = await seam.commands.gitBranch(sessionId, {
                      action: 'delete', name: deleteName.trim(), ...(deleteForce ? { force: true } : {}),
                    });
                    if (r.action !== 'delete') return 'branch deleted';
                    setDeleteName('');
                    setDeleteForce(false);
                    return `deleted ${r.name} (tip ${shortOid(r.deletedOid)} stays reachable until gc${r.forced ? `; it was unmerged relative to ${r.measuredAgainst}` : ''})`;
                  })
                }
              >
                Confirm delete
              </button>
              <button type="button" className="pn-git__verb" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="pn-git__verb"
              disabled={busy !== null}
              data-testid="session-git-branch-delete"
              onClick={() => setConfirming('branch-delete')}
            >
              Delete branch…
            </button>
          )}
        </span>
      </div>

      {/* -- stash ------------------------------------------------------------ */}
      <div className="pn-git__stash" data-testid="session-git-stash-group">
        {clean ? (
          <DisabledAction reason={{ cause: 'The worktree is clean — there is nothing to stash.' }}>Stash WIP</DisabledAction>
        ) : (
          <button
            type="button"
            className="pn-git__verb"
            disabled={busy !== null}
            data-testid="session-git-stash-push"
            onClick={() =>
              void runVerb('stash-push', async () => {
                const r = await seam.commands.gitStash(sessionId, { action: 'push' });
                return r.action === 'push' && r.status === 'stashed'
                  ? `stashed ${r.files.length} file(s) as ${shortOid(r.oid)} — untracked files included (stored, not lost)`
                  : 'worktree already clean; nothing stashed';
              })
            }
          >
            {busy === 'stash-push' ? 'Stashing…' : 'Stash WIP'}
          </button>
        )}
        {(s.stashes ?? []).length > 0 ? (
          <ul className="pn-git__stash-list" data-testid="session-git-stash-list">
            {(s.stashes ?? []).map((entry) => (
              <li key={entry.oid} className="pn-git__stash-entry">
                <code>stash@{'{'}{entry.index}{'}'}</code>
                <span className="pn-git__stash-subject">{entry.subject}</span>
                {!clean ? (
                  <DisabledAction reason={{ cause: 'Pop refuses while the worktree is dirty — a conflicted pop must be able to abort to a clean state.', remedy: 'checkpoint, commit, or stash first' }}>
                    Pop
                  </DisabledAction>
                ) : (
                  <button
                    type="button"
                    className="pn-git__verb"
                    disabled={busy !== null}
                    data-testid={`session-git-stash-pop-${entry.index}`}
                    onClick={() =>
                      void runVerb('stash-pop', async () => {
                        const r = await seam.commands.gitStash(sessionId, { action: 'pop', index: entry.index });
                        if (r.action === 'pop' && r.status === 'conflict') {
                          setConflict({
                            title: `Stash pop of ${shortOid(r.oid)} CONFLICTED — the apply was aborted, the worktree was restored clean, and the stash entry was RETAINED.`,
                            paths: r.conflictedPaths,
                            remedy: 'Resolve in a checkout you control; the entry is still in the stash list.',
                          });
                          return `stash pop conflicted on ${r.conflictedPaths.length} path(s) — worktree restored clean, entry retained`;
                        }
                        setConflict(null);
                        return r.action === 'pop' && r.status === 'popped'
                          ? `popped ${shortOid(r.oid)}: ${r.files.length} file(s) back in the worktree`
                          : 'stash popped';
                      })
                    }
                  >
                    Pop
                  </button>
                )}
                {confirming === `stash-drop:${entry.index}` ? (
                  <span className="pn-git__confirm" data-testid={`session-git-stash-drop-confirm-${entry.index}`}>
                    <span className="pn-git__confirm-text">
                      Drop stash@{'{'}{entry.index}{'}'}? This DESTROYS the entry — its content stays reachable only by oid, and only until gc.
                    </span>
                    <button
                      type="button"
                      className="pn-git__verb pn-git__verb--danger"
                      disabled={busy !== null}
                      data-testid={`session-git-stash-drop-go-${entry.index}`}
                      onClick={() =>
                        void runVerb('stash-drop', async () => {
                          const r = await seam.commands.gitStash(sessionId, { action: 'drop', index: entry.index, force: true });
                          return r.action === 'drop'
                            ? `dropped ${r.subject} — content reachable as ${shortOid(r.droppedOid)} until gc`
                            : 'stash entry dropped';
                        })
                      }
                    >
                      Confirm drop
                    </button>
                    <button type="button" className="pn-git__verb" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="pn-git__verb"
                    disabled={busy !== null}
                    data-testid={`session-git-stash-drop-${entry.index}`}
                    onClick={() => setConfirming(`stash-drop:${entry.index}`)}
                  >
                    Drop…
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="pn-git__note" data-testid="session-git-stash-empty">no stash entries</span>
        )}
      </div>

      {/* -- diff ------------------------------------------------------------- */}
      <div className="pn-git__diff-section">
        <button type="button" className="pn-git__verb" data-testid="session-git-diff-toggle" onClick={toggleDiff}>
          {diff.phase === 'closed' ? 'Show diff' : 'Hide diff'}
        </button>
        {diff.phase === 'loading' ? <p className="pn-git__note">Reading diff…</p> : null}
        {diff.phase === 'error' ? <p className="pn-git__error" role="alert">Diff failed: {diff.message}</p> : null}
        {diff.phase === 'ready' ? (
          diff.diff.available ? (
            <div data-testid="session-git-diff">
              <p className="pn-git__diff-digest" data-testid="session-git-diff-digest">
                {diff.diff.stat.filesChanged} file(s) · +{diff.diff.stat.additions} −{diff.diff.stat.deletions}
                {' '}vs {diff.diff.baseRef ?? shortOid(diff.diff.baseOid)}
                {diff.diff.diffTruncated ? ' — diff text truncated by the byte cap; the digest above is complete' : ''}
              </p>
              {diff.diff.diff === '' ? (
                <p className="pn-git__note" data-testid="session-git-diff-empty">
                  No changes against {diff.diff.baseRef ?? 'the base'} — the lane matches its merge-base.
                </p>
              ) : (
                <DiffView diff={diff.diff.diff} />
              )}
            </div>
          ) : (
            <p className="pn-git__note">
              {UNAVAILABLE_CAUSE[diff.diff.unavailableReason ?? ''] ?? 'Diff unavailable for this session.'}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
