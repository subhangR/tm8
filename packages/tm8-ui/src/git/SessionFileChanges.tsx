import { useCallback, useEffect, useState } from 'react';
import type { EntityId, SessionFileChange, SessionFileChanges as Changes } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DiffView } from '../kit';
import './session-git.css';

/**
 * FILES THIS SESSION CHANGED — the worktree-less answer to "what did this
 * session do to the tree", raised live: a scratch session's Git tab could
 * name its commits and PRs (SessionGitFacts) but not its edits.
 *
 * SOURCE IS THE TRANSCRIPT, AND THE LABEL SAYS SO. These are the Edit/Write
 * tool calls the harness observed the agent make — attribution git cannot
 * give in a shared tree. It is NOT a git diff: shell-made changes are
 * invisible to tool-call parsing, and a later session may have rewritten the
 * same lines. The provenance line renders on the surface itself, because a
 * reader who mistakes this for `git diff` will trust it wrong.
 *
 * COUNTS ARE EXACT EVEN WHERE TEXT ISN'T: an oversized hunk drops its text
 * server-side but keeps its ± counts, and the row says "text elided" rather
 * than rendering a diff that silently lost its middle.
 */

export interface SessionFileChangesProps {
  seam: Seam;
  sessionId: EntityId;
}

type State =
  | { phase: 'loading' }
  | { phase: 'silent' }
  | { phase: 'ready'; changes: Changes };

/** A renderable unified diff from the hunks that still carry text. */
function diffTextOf(change: SessionFileChange): string | null {
  const parts: string[] = [];
  for (const hunk of change.hunks) {
    if (hunk.oldText === null && hunk.newText === null) continue;
    parts.push(`@@ ${hunk.tool} −${String(hunk.linesRemoved)} +${String(hunk.linesAdded)} @@`);
    if (hunk.oldText) for (const line of hunk.oldText.split('\n')) parts.push(`-${line}`);
    if (hunk.newText) for (const line of hunk.newText.split('\n')) parts.push(`+${line}`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function elidedCount(change: SessionFileChange): number {
  return change.hunks.filter((h) => h.oldText === null && h.newText === null).length;
}

export function SessionFileChanges({ seam, sessionId }: SessionFileChangesProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    try {
      // `last: 1` keeps the transcript half of the payload minimal — this
      // section wants the file accounting, not the prose.
      const page = await seam.transcript(sessionId, { last: 1, files: true });
      const changes = page.fileChanges ?? null;
      if (changes === null || changes.files.length === 0) {
        // No accounting (codex dialect, no transcript, or a session that
        // changed nothing): silence, not an empty frame — the rail's other
        // sections already explain their own absences.
        setState({ phase: 'silent' });
        return;
      }
      setState({ phase: 'ready', changes });
    } catch {
      setState({ phase: 'silent' });
    }
  }, [seam, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase !== 'ready') return null;
  const { changes } = state;

  return (
    <div className="pn-git__facts pn-git__file-changes" data-testid="session-file-changes">
      <div className="pn-git__facts-row">
        <span className="pn-git__facts-label">Files this session changed</span>
        <span className="pn-git__change-totals" data-testid="session-file-changes-totals">
          <span className="pn-git__added">+{changes.totalAdded}</span>
          <span className="pn-git__removed">−{changes.totalRemoved}</span>
        </span>
        <span className="pn-git__note pn-git__change-source">
          observed from the agent transcript, not git — shell-made changes are not counted
        </span>
      </div>

      <ul className="pn-git__change-list">
        {changes.files.map((file) => {
          const diff = diffTextOf(file);
          const elided = elidedCount(file);
          return (
            <li key={file.path} data-testid="session-file-change">
              <details className="pn-git__change-file">
                <summary className="pn-git__change-summary">
                  <span className="pn-git__change-path" title={file.path}>{file.path}</span>
                  <span className="pn-git__change-counts">
                    <span className="pn-git__added">+{file.linesAdded}</span>
                    <span className="pn-git__removed">−{file.linesRemoved}</span>
                    <span className="pn-git__note">{file.edits} edit{file.edits === 1 ? '' : 's'}</span>
                  </span>
                </summary>
                {diff !== null ? <DiffView diff={diff} /> : null}
                {elided > 0 || file.hunksTruncated ? (
                  <p className="pn-git__note" data-testid="session-file-change-elided">
                    {elided > 0 ? `${String(elided)} hunk(s) too large to carry text — the ± counts above are exact. ` : ''}
                    {file.hunksTruncated ? 'Further hunks beyond the cap were counted but not carried.' : ''}
                  </p>
                ) : null}
              </details>
            </li>
          );
        })}
        {changes.filesTruncated ? (
          <li className="pn-git__note">…more files were changed than the cap carries</li>
        ) : null}
      </ul>
    </div>
  );
}
