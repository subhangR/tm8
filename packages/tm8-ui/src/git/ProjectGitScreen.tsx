import { useCallback, useEffect, useState } from 'react';
import {
  isCollabError,
  type ContentionReport,
  type ProjectBranchTopology,
  type ProjectResource,
  type SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { Pill } from '../kit';
import { BranchTopologyList } from '../projects';
import './project-git.css';

/**
 * THE PROJECT GIT SCREEN — git elevated out of Settings into a view of its
 * own: per linked project, the branch topology (#75's read, #74's list
 * component REUSED), the live worktree lanes with their owning sessions, and
 * the CONTENTION map — overlapping touched paths between live lanes,
 * surfaced BEFORE a merge makes one lane silently revert the other.
 *
 * HONESTY:
 *   · a space with no linked projects says so — never a blank screen;
 *   · `invalid_input` from the branch read is a fact about the PROJECT
 *     (workingDir is not a git repo), worded as such (BranchTopologyList's
 *     own rule, inherited by reuse);
 *   · a lane the node cannot read renders SKIPPED with the server's reason —
 *     an unreadable lane is exactly the one a contention report must name;
 *   · zero pairs renders "no contention observed", a measured claim, not an
 *     empty div.
 *
 * Reads are on-mount + manual refresh; this screen is a survey, not a feed.
 */

export interface ProjectGitScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  /** Click-through from a lane to its owning session panel. */
  onOpenEntity?: ((id: string) => void) | undefined;
}

interface ProjectGitState {
  project: ProjectResource;
  branches:
    | { phase: 'loading' }
    | { phase: 'error'; notARepo: boolean; message: string }
    | { phase: 'ready'; topology: ProjectBranchTopology };
  contention:
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; report: ContentionReport };
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; projects: ProjectGitState[] };

export function ProjectGitScreen({ seam, spaceId, onOpenEntity }: ProjectGitScreenProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    let projects: ProjectResource[];
    try {
      projects = await seam.projects(spaceId);
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Projects read failed' });
      return;
    }
    const rows: ProjectGitState[] = projects.map((project) => ({
      project,
      branches: { phase: 'loading' },
      contention: { phase: 'loading' },
    }));
    setState({ phase: 'ready', projects: rows });

    // The two reads land independently per project — one project's dead git
    // must not blank another's answer.
    await Promise.all(
      rows.map(async (row) => {
        try {
          const topology = await seam.projectBranches(row.project.id);
          row.branches = { phase: 'ready', topology };
        } catch (err) {
          row.branches = {
            phase: 'error',
            notARepo: isCollabError(err) && err.code === 'invalid_input',
            message: err instanceof Error ? err.message : String(err),
          };
        }
        try {
          const report = await seam.projectContention(row.project.id);
          row.contention = { phase: 'ready', report };
        } catch (err) {
          row.contention = { phase: 'error', message: err instanceof Error ? err.message : String(err) };
        }
        setState((prev) => (prev.phase === 'ready' ? { phase: 'ready', projects: [...prev.projects] } : prev));
      }),
    );
  }, [seam, spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === 'loading') {
    return <div className="pn-project-git" data-testid="project-git-screen"><p className="pn-project-git__note">Reading projects…</p></div>;
  }
  if (state.phase === 'error') {
    return (
      <div className="pn-project-git" data-testid="project-git-screen">
        <p className="pn-project-git__error" role="alert">Projects read failed: {state.message}</p>
      </div>
    );
  }
  if (state.projects.length === 0) {
    return (
      <div className="pn-project-git" data-testid="project-git-screen">
        <p className="pn-project-git__note" data-testid="project-git-empty">
          This space has no linked projects — git topology exists once a project folder is connected.
        </p>
      </div>
    );
  }

  return (
    <div className="pn-project-git" data-testid="project-git-screen">
      <div className="pn-project-git__head">
        <h2 className="pn-project-git__title">Git</h2>
        <button type="button" className="pn-project-git__btn" onClick={() => void load()}>
          refresh
        </button>
      </div>
      {state.projects.map((row) => (
        <ProjectGitCard key={row.project.id} row={row} onOpenEntity={onOpenEntity} />
      ))}
    </div>
  );
}

function ProjectGitCard({ row, onOpenEntity }: { row: ProjectGitState; onOpenEntity?: ((id: string) => void) | undefined }) {
  const { project, branches, contention } = row;
  return (
    <section className="pn-project-git__card" data-testid="project-git-card" aria-label={project.name}>
      <div className="pn-project-git__card-head">
        <span className="pn-project-git__name">{project.name}</span>
        <code className="pn-project-git__dir">{project.workingDir}</code>
      </div>

      {/* -- branch topology (#75 read, #74 list, reused) --------------------- */}
      {branches.phase === 'loading' ? (
        <p className="pn-project-git__note">reading branches…</p>
      ) : branches.phase === 'error' ? (
        <p className="pn-project-git__error" data-testid="project-git-branches-error">
          {branches.notARepo
            ? `This project’s working directory is not a git repository — branches only exist once it is one. (${branches.message})`
            : `The branch read failed: ${branches.message}`}
        </p>
      ) : (
        <BranchTopologyList topology={branches.topology} />
      )}

      {/* -- worktree lanes + contention -------------------------------------- */}
      {contention.phase === 'loading' ? (
        <p className="pn-project-git__note">reading worktree lanes…</p>
      ) : contention.phase === 'error' ? (
        <p className="pn-project-git__error" data-testid="project-git-contention-error">
          The contention read failed: {contention.message}
        </p>
      ) : (
        <ContentionBlock report={contention.report} onOpenEntity={onOpenEntity} />
      )}
    </section>
  );
}

function ContentionBlock({ report, onOpenEntity }: { report: ContentionReport; onOpenEntity?: ((id: string) => void) | undefined }) {
  return (
    <div className="pn-project-git__lanes" data-testid="project-git-lanes">
      <h3 className="pn-project-git__subhead">Worktree lanes</h3>
      {report.lanes.length === 0 ? (
        <p className="pn-project-git__note" data-testid="project-git-no-lanes">
          No active worktrees — sessions spawned with workdir mode “worktree” appear here.
        </p>
      ) : (
        <ul className="pn-project-git__lane-list">
          {report.lanes.map((lane) => (
            <li key={lane.worktreeId} data-testid="project-git-lane">
              <span className="pn-project-git__branch">⎇ {lane.branch}</span>
              {lane.sessionId ? (
                <button
                  type="button"
                  className="pn-project-git__link"
                  data-testid="project-git-lane-session"
                  onClick={onOpenEntity ? () => onOpenEntity(lane.sessionId as string) : undefined}
                  disabled={!onOpenEntity}
                >
                  session {lane.sessionId.slice(0, 8)}…
                </button>
              ) : (
                <span className="pn-project-git__note">no owning session</span>
              )}
              <code className="pn-project-git__dir">{lane.path}</code>
              {lane.skipped !== null ? (
                <Pill tone="wait" title={lane.skipped}>skipped</Pill>
              ) : (
                <Pill tone={lane.touchedCount > 0 ? 'info' : 'idle'}>
                  {lane.touchedCount} file(s) touched
                </Pill>
              )}
              {lane.skipped !== null ? (
                <span className="pn-project-git__note" data-testid="project-git-lane-skipped">{lane.skipped}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="pn-project-git__subhead">Contention</h3>
      {report.pairs.length === 0 ? (
        <p className="pn-project-git__note" data-testid="project-git-no-contention">
          No contention observed between readable lanes.
        </p>
      ) : (
        <ul className="pn-project-git__pairs" data-testid="project-git-pairs">
          {report.pairs.map((pair) => (
            <li key={`${pair.aWorktreeId}:${pair.bWorktreeId}`} className="pn-project-git__pair" role="alert">
              <p className="pn-project-git__pair-title">
                <Pill tone="block">overlap</Pill>
                <span className="pn-project-git__branch">⎇ {pair.aBranch}</span> and{' '}
                <span className="pn-project-git__branch">⎇ {pair.bBranch}</span> touch the same file(s) —
                whichever merges second can silently revert the first:
              </p>
              <ul className="pn-project-git__pair-paths">
                {pair.overlappingPaths.map((p) => (
                  <li key={p}><code>{p}</code></li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
