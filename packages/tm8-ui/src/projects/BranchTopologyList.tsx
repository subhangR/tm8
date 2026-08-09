/**
 * BRANCH TOPOLOGY — the per-project branch list (git-features Tier 1
 * follow-up; the server read and CLI landed in PR #74, this is the UI half).
 *
 * TWO COMPONENTS, ONE FILE, DIFFERENT CONTRACTS:
 *
 *   `BranchTopologyList`    — presentational. Takes a `ProjectBranchTopology`
 *                             DTO verbatim and renders it. No seam, no clock.
 *   `ProjectBranchesSection`— the container the settings shell's externally-
 *                             owned `projects` slot mounts. Loads linked
 *                             projects, then topology PER PROJECT ON EXPAND —
 *                             the server pays one rev-list per branch, so an
 *                             eager fetch of every project would turn opening
 *                             Settings into a git fan-out nobody asked for.
 *
 * HONESTY RULES CARRIED FROM THE DTO:
 * - `defaultBranchSource` is ALWAYS rendered. "2 behind main" is a different
 *   claim when the trunk came from the remote's own HEAD than when it was
 *   guessed from whatever was checked out; dropping the provenance would
 *   reintroduce exactly the ambiguity the field exists to remove.
 * - `truncated: true` renders as a stated cut, never a silent short list.
 * - `invalid_input` from the read is a fact about the PROJECT (its workingDir
 *   is not a git repository) and is worded as such — not as a tm8 fault.
 * - The default branch shows "trunk" where other rows show drift: ahead/behind
 *   vs itself is 0/0 by definition, and printing "0 behind main" on main
 *   asserts a measurement that was never a question.
 */
import { useEffect, useState } from 'react';
import { isCollabError, type ProjectBranchTopology, type ProjectResource } from '@tm8/contract';
import { Pill } from '../kit';
import './branch-topology.css';

/** What `defaultBranch` is a claim FROM — rendered, never dropped. */
const TRUNK_SOURCE_LABEL: Record<ProjectBranchTopology['defaultBranchSource'], string> = {
  origin_head: "from the remote's HEAD",
  local_conventional: 'guessed from local convention',
  current_branch: 'guessed from the checked-out branch',
};

export function BranchTopologyList({ topology }: { topology: ProjectBranchTopology }) {
  return (
    <div className="brt" data-testid="branch-topology">
      <div className="brt__head">
        <span className="brt__trunk">
          trunk <span className="brt__mono">{topology.defaultBranch}</span>
        </span>
        <span className="brt__source" data-testid="trunk-source">
          {TRUNK_SOURCE_LABEL[topology.defaultBranchSource]}
        </span>
        <span className="brt__spacer" />
        <span className="brt__meta">stale after {topology.staleAfterDays}d</span>
      </div>
      {topology.branches.length === 0 ? (
        <p className="brt__empty">
          The repository has no local branches — a working directory this fresh has nothing to
          compare yet.
        </p>
      ) : (
        <ul className="brt__rows">
          {topology.branches.map((b) => (
            <li key={b.name} className="brt__row" data-testid="branch-row">
              <div className="brt__row-head">
                <span className="brt__name brt__mono">{b.name}</span>
                {b.isCurrent ? (
                  <Pill tone="run" dot="solid">
                    current
                  </Pill>
                ) : null}
                {b.isDefault ? <Pill tone="info">default</Pill> : null}
                {!b.isDefault && b.merged ? (
                  <Pill tone="idle" title={`the ${topology.defaultBranch} branch already contains all of it`}>
                    merged
                  </Pill>
                ) : null}
                {b.stale ? (
                  <Pill tone="wait" title={`no commit in the last ${topology.staleAfterDays} days`}>
                    stale
                  </Pill>
                ) : null}
                <span className="brt__spacer" />
                {b.isDefault ? (
                  <span className="brt__drift brt__drift--trunk">trunk</span>
                ) : (
                  <span
                    className="brt__drift"
                    title={`${b.ahead} commit(s) ${topology.defaultBranch} does not have · ${b.behind} commit(s) this branch does not have`}
                  >
                    <span aria-label={`${b.ahead} ahead`}>↑{b.ahead}</span>{' '}
                    <span aria-label={`${b.behind} behind`}>↓{b.behind}</span>{' '}
                    <span className="brt__drift-vs">vs {topology.defaultBranch}</span>
                  </span>
                )}
              </div>
              <div className="brt__row-meta">
                {/* The DATE portion only — a fixed slice of the ISO string, so
                    this component never consults a clock and renders the same
                    bytes in every run. Staleness is the SERVER's judgement. */}
                <span className="brt__mono">{b.lastCommitAt.slice(0, 10)}</span>
                <span aria-hidden className="brt__dot">
                  ·
                </span>
                <span className="brt__subject">{b.subject}</span>
                <span aria-hidden className="brt__dot">
                  ·
                </span>
                {b.upstream === null ? (
                  <span className="brt__no-upstream">no upstream</span>
                ) : (
                  <span className="brt__mono">{b.upstream}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {topology.truncated ? (
        <p className="brt__truncated" data-testid="branch-truncated">
          The server capped this list — the repository has more branches than shown here.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The settings-shell section
// ---------------------------------------------------------------------------

/**
 * The section's whole dependency, structurally — the host closes spaceId over
 * the seam. Nothing here imports a seam implementation (the same rule the
 * settings port follows: declaration in the component's file, wiring in the
 * host).
 */
export interface ProjectBranchesPort {
  projects(): Promise<ProjectResource[]>;
  branches(projectId: string): Promise<ProjectBranchTopology>;
}

type BranchesState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'loaded'; topology: ProjectBranchTopology }
  | { phase: 'error'; notARepo: boolean; message: string };

export function ProjectBranchesSection({ port }: { port: ProjectBranchesPort }) {
  const [projects, setProjects] = useState<readonly ProjectResource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setProjects(null);
    setLoadError(null);
    port.projects().then(
      (items) => {
        if (live) setProjects(items);
      },
      (err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [port]);

  return (
    <div className="brt-section" data-testid="project-branches-section">
      <div className="brt-section__head">
        <span className="brt-section__title">Linked projects</span>
      </div>
      <p className="brt-section__note">
        Branches are read live from each project’s working directory — argv-only git, nothing is
        checked out or written.
      </p>
      {loadError !== null ? (
        <p className="brt__error" data-testid="projects-error">
          The linked-projects read failed: {loadError}
        </p>
      ) : projects === null ? (
        <p className="brt__loading">loading linked projects…</p>
      ) : projects.length === 0 ? (
        <p className="brt__empty">
          No projects are linked to this space. Linking one is how a session gets a working
          directory — and how this screen gets a repository to describe.
        </p>
      ) : (
        <ul className="brt-section__projects">
          {projects.map((p) => (
            <ProjectBranchesRow key={p.id} project={p} port={port} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectBranchesRow({ project, port }: { project: ProjectResource; port: ProjectBranchesPort }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BranchesState>({ phase: 'idle' });

  function toggle() {
    const next = !open;
    setOpen(next);
    // Fetch on FIRST expand only; a loaded answer is kept for re-opens. The
    // refresh control below is the deliberate way to re-run the read.
    if (next && state.phase === 'idle') void load();
  }

  async function load() {
    setState({ phase: 'loading' });
    try {
      const topology = await port.branches(project.id);
      setState({ phase: 'loaded', topology });
    } catch (err: unknown) {
      // `invalid_input` is the server saying "this workingDir is not a git
      // repository" — a fact about the project row, stated as one.
      const notARepo = isCollabError(err) && err.code === 'invalid_input';
      setState({
        phase: 'error',
        notARepo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <li className="brt-project" data-testid="project-branches-row">
      <div className="brt-project__head">
        <span aria-hidden className="brt-project__glyph">
          ⬒
        </span>
        <span className="brt-project__name">{project.name}</span>
        <span className="brt__mono brt-project__dir">{project.workingDir}</span>
        <span className="brt__spacer" />
        {open && state.phase === 'loaded' ? (
          <button type="button" className="brt-project__btn" onClick={() => void load()}>
            refresh
          </button>
        ) : null}
        <button
          type="button"
          className="brt-project__btn"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? 'hide branches' : 'show branches'}
        </button>
      </div>
      {open ? (
        state.phase === 'loading' ? (
          <p className="brt__loading">reading branches…</p>
        ) : state.phase === 'error' ? (
          <p className="brt__error" data-testid="branches-error">
            {state.notARepo
              ? `This project’s working directory is not a git repository — branches only exist once it is one. (${state.message})`
              : `The branch read failed: ${state.message}`}
          </p>
        ) : state.phase === 'loaded' ? (
          <BranchTopologyList topology={state.topology} />
        ) : null
      ) : null}
    </li>
  );
}
