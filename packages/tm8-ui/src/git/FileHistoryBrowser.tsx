import { useCallback, useEffect, useState } from 'react';
import { isCollabError, type ProjectFileHistory, type ProjectFileRevision } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DiffView, Pill } from '../kit';
import { SessionAttribution } from './SessionAttribution';
import './project-git.css';

/**
 * THE FILE-HISTORY BROWSER — the revisions of one path in a linked project's
 * working directory (Tier 1 #10), each carrying its `created_in` session
 * attribution, with the selected revision's patch rendered through the kit's
 * EXISTING bounded DiffView (#74) — no second diff renderer.
 *
 * HONESTY (SessionGitBody's rules, inherited):
 *   · zero revisions says WHY (never committed on this branch) — no blank list;
 *   · `invalid_input` is a fact about the PROJECT or the PATH, worded as such;
 *   · the walk is BOUNDED (`MAX_REVISIONS`) and a cut renders as a note naming
 *     the ceiling — the cap bounds rendering, never disclosure;
 *   · attribution comes only from the provenance join: `session: null` renders
 *     "no tm8 session recorded", never a guess from author name or timestamp.
 */

/** Stated ceiling: revisions fetched per read. The DTO's `truncated` reports the cut. */
export const MAX_REVISIONS = 100;

export interface FileHistoryBrowserProps {
  seam: Seam;
  projectId: string;
  /** The path under inspection; the host owns the picker. */
  path: string;
  /** Click-through from an attributed revision to its session panel. */
  onOpenEntity?: ((id: string) => void) | undefined;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; invalidInput: boolean; message: string }
  | { phase: 'ready'; history: ProjectFileHistory };

type DiffState =
  | { phase: 'closed' }
  | { phase: 'loading'; oid: string }
  | { phase: 'error'; oid: string; message: string }
  | { phase: 'ready'; oid: string; diff: string; truncated: boolean };

export function FileHistoryBrowser({ seam, projectId, path, onOpenEntity }: FileHistoryBrowserProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [diff, setDiff] = useState<DiffState>({ phase: 'closed' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    setDiff({ phase: 'closed' });
    seam
      .projectFileHistory(projectId, path, { maxRevisions: MAX_REVISIONS })
      .then((history) => {
        if (!cancelled) setState({ phase: 'ready', history });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          phase: 'error',
          invalidInput: isCollabError(err) && err.code === 'invalid_input',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [seam, projectId, path]);

  const selectRevision = useCallback(
    (oid: string) => {
      setDiff({ phase: 'loading', oid });
      seam
        .projectFileHistory(projectId, path, { maxRevisions: 1, diffOid: oid })
        .then((history) => {
          setDiff(
            history.diff === null
              ? { phase: 'error', oid, message: 'the server answered no patch for this revision' }
              : { phase: 'ready', oid, diff: history.diff.diff, truncated: history.diff.truncated },
          );
        })
        .catch((err: unknown) => {
          setDiff({ phase: 'error', oid, message: err instanceof Error ? err.message : String(err) });
        });
    },
    [seam, projectId, path],
  );

  if (state.phase === 'loading') {
    return <p className="pn-project-git__note" data-testid="file-history-loading">reading revisions of <code>{path}</code>…</p>;
  }
  if (state.phase === 'error') {
    return (
      <p className="pn-project-git__error" data-testid="file-history-error" role="alert">
        {state.invalidInput
          ? `This path cannot be read as a pathspec of the project's repository — a fact about the project or the path, not a tm8 fault. (${state.message})`
          : `The history read failed: ${state.message}`}
      </p>
    );
  }

  const { history } = state;
  if (history.revisions.length === 0) {
    return (
      <p className="pn-project-git__note" data-testid="file-history-empty">
        <code>{path}</code> has no committed revisions on this branch — history exists once the path is committed.
      </p>
    );
  }

  return (
    <div className="pn-file-history" data-testid="file-history">
      <ol className="pn-file-history__list">
        {history.revisions.map((revision) => (
          <RevisionRow
            key={revision.oid}
            revision={revision}
            requestedPath={history.path}
            selected={diff.phase !== 'closed' && diff.oid === revision.oid}
            onSelect={selectRevision}
            onOpenEntity={onOpenEntity}
          />
        ))}
      </ol>
      {history.truncated ? (
        <p className="pn-project-git__note" data-testid="file-history-truncated">
          Showing the newest {MAX_REVISIONS} revisions — older ones exist and were not fetched (the ceiling bounds this list, not the repository).
        </p>
      ) : null}
      {diff.phase === 'loading' ? (
        <p className="pn-project-git__note">reading patch {diff.oid.slice(0, 12)}…</p>
      ) : diff.phase === 'error' ? (
        <p className="pn-project-git__error" data-testid="file-history-diff-error" role="alert">
          The patch read failed: {diff.message}
        </p>
      ) : diff.phase === 'ready' ? (
        <div data-testid="file-history-diff">
          {diff.truncated ? (
            <p className="pn-project-git__note" data-testid="file-history-diff-truncated">
              This patch was byte-capped by the server; the text below is an honest prefix.
            </p>
          ) : null}
          <DiffView diff={diff.diff} />
        </div>
      ) : null}
    </div>
  );
}

function RevisionRow({
  revision,
  requestedPath,
  selected,
  onSelect,
  onOpenEntity,
}: {
  revision: ProjectFileRevision;
  requestedPath: string;
  selected: boolean;
  onSelect: (oid: string) => void;
  onOpenEntity?: ((id: string) => void) | undefined;
}) {
  return (
    <li className={`pn-file-history__row${selected ? ' pn-file-history__row--selected' : ''}`} data-testid="file-history-revision">
      <button
        type="button"
        className="pn-project-git__link"
        data-testid="file-history-select"
        onClick={() => onSelect(revision.oid)}
        aria-pressed={selected}
      >
        <code>{revision.oid.slice(0, 12)}</code>
      </button>
      <span className="pn-file-history__subject">{revision.subject}</span>
      <Pill tone="idle">
        {/* `-` in numstat means binary: additions are honestly unknown, not zero. */}
        {revision.additions === null || revision.deletions === null
          ? 'binary'
          : `+${revision.additions}/-${revision.deletions}`}
      </Pill>
      <span className="pn-project-git__note">{revision.author} · {revision.committedAt}</span>
      {revision.path !== requestedPath ? (
        <span className="pn-project-git__note" data-testid="file-history-rename">as <code>{revision.path}</code></span>
      ) : null}
      <SessionAttribution session={revision.session} onOpenEntity={onOpenEntity} />
    </li>
  );
}
