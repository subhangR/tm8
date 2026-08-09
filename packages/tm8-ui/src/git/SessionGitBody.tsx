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
 * THE SESSION GIT RAIL — where is this lane, what did it change, and the four
 * verbs that move it (checkpoint / rollback / commit / merge-base-in).
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

type Verb = 'checkpoint' | 'rollback' | 'commit' | 'merge';

interface Conflict {
  fromRef: string;
  paths: string[];
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
  const [confirming, setConfirming] = useState<'rollback' | 'merge' | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [rollbackTo, setRollbackTo] = useState('');
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
          <p className="pn-git__conflict-title">
            Merge of {conflict.fromRef} CONFLICTED — the worktree was restored clean; nothing was merged.
          </p>
          <ul>
            {conflict.paths.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
          <p className="pn-git__remedy">
            Resolve by merging {conflict.fromRef} in a checkout you control, or land this lane through a PR.
          </p>
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
                    setConflict({ fromRef: r.fromRef, paths: r.conflictedPaths });
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
