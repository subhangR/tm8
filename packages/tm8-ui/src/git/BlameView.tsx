import { useEffect, useState } from 'react';
import { isCollabError, type ProjectFileBlame } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { Pill } from '../kit';
import { SessionAttribution } from './SessionAttribution';
import './project-git.css';

/**
 * THE BLAME VIEW WITH SESSION ATTRIBUTION — which lane wrote this hunk
 * (Tier 1 #8). Line-ranges grouped into hunks by the server, each joined to
 * the `created_in` provenance graph; the overlay names the session and links
 * through to its panel.
 *
 * BOUNDED BY CONSTRUCTION with a STATED ceiling: the first read asks for
 * `MAX_LINES`, and a 50,000-line file renders a control saying exactly how
 * many lines it holds back — pressing it raises the window (the ceiling
 * bounds RENDERING, never DISCLOSURE). `totalLines` is measured server-side,
 * so the number on the control is a fact, not an estimate.
 *
 * HONESTY: an uncommitted hunk says "not yet committed"; a commit with no
 * provenance edge says "no tm8 session recorded"; an unreadable path is a
 * fact about the path, worded as such — never a blank panel.
 */

/** Stated ceiling: blame lines fetched per read. */
export const MAX_LINES = 2000;
/** Each press of the show-more control raises the window by this much. */
const MORE_LINES_STEP = 2000;

export interface BlameViewProps {
  seam: Seam;
  projectId: string;
  path: string;
  onOpenEntity?: ((id: string) => void) | undefined;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; invalidInput: boolean; message: string }
  | { phase: 'ready'; blame: ProjectFileBlame };

export function BlameView({ seam, projectId, path, onOpenEntity }: BlameViewProps) {
  const [maxLines, setMaxLines] = useState(MAX_LINES);
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    setMaxLines(MAX_LINES);
  }, [projectId, path]);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    seam
      .projectFileBlame(projectId, path, { maxLines })
      .then((blame) => {
        if (!cancelled) setState({ phase: 'ready', blame });
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
  }, [seam, projectId, path, maxLines]);

  if (state.phase === 'loading') {
    return <p className="pn-project-git__note" data-testid="blame-loading">reading blame of <code>{path}</code>…</p>;
  }
  if (state.phase === 'error') {
    return (
      <p className="pn-project-git__error" data-testid="blame-error" role="alert">
        {state.invalidInput
          ? `This path cannot be blamed — it is missing from the working tree or is not a valid pathspec; a fact about the path, not a tm8 fault. (${state.message})`
          : `The blame read failed: ${state.message}`}
      </p>
    );
  }

  const { blame } = state;
  if (blame.hunks.length === 0) {
    return (
      <p className="pn-project-git__note" data-testid="blame-empty">
        <code>{path}</code> has no lines to blame — it is empty in the working tree.
      </p>
    );
  }

  const heldBack = blame.totalLines - blame.blamedLines;
  return (
    <div className="pn-blame" data-testid="blame-view">
      <p className="pn-project-git__note" data-testid="blame-coverage">
        {blame.blamedLines} of {blame.totalLines} line(s) blamed
      </p>
      <ol className="pn-blame__list">
        {blame.hunks.map((hunk) => {
          const end = hunk.startLine + hunk.lineCount - 1;
          return (
            <li key={`${hunk.oid}:${hunk.startLine}`} className="pn-blame__hunk" data-testid="blame-hunk">
              <code className="pn-blame__range">
                L{hunk.startLine}{hunk.lineCount > 1 ? `–${end}` : ''}
              </code>
              {hunk.uncommitted ? (
                <Pill tone="wait">not yet committed</Pill>
              ) : (
                <>
                  <code className="pn-blame__oid">{hunk.oid.slice(0, 12)}</code>
                  <span className="pn-blame__summary">{hunk.summary}</span>
                  <span className="pn-project-git__note">{hunk.author}</span>
                  <SessionAttribution session={hunk.session} onOpenEntity={onOpenEntity} />
                </>
              )}
            </li>
          );
        })}
      </ol>
      {blame.truncated ? (
        <button
          type="button"
          className="pn-project-git__btn"
          data-testid="blame-show-more"
          onClick={() => setMaxLines((current) => current + MORE_LINES_STEP)}
        >
          show more — {heldBack} line(s) held back by the {maxLines}-line ceiling
        </button>
      ) : null}
    </div>
  );
}
