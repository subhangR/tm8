import { useRef, useState } from 'react';
import type { ProjectResource, SpaceId } from '@tm8/contract';

import {
  OnboardingStageError,
  ProjectDraftFields,
  ProjectFolderBrowser,
  STAGE_LABEL,
  addProjectToSpace,
  explainProjectError,
  newProjectMutationIds,
  useProjectDraft,
  validateProjectDraft,
  type OnboardingStage,
  type ProjectAddPort,
  type ProjectMutationIds,
} from './project-draft';

import './projects.css';

/**
 * CREATE PROJECT — a project added to the CURRENT Space (task 01a0fb4f,
 * owner rulings from form 01a0fb50, 2026-10-02): a full page inside the
 * Space, reached from the Projects list's ＋ and its empty state; folder,
 * GitHub URL or upload; trusted by default; name pre-filled from the folder
 * or repo.
 *
 * It runs `addProjectToSpace`, the exact saga Create Space runs for its
 * optional project, so the two surfaces cannot disagree about what a project
 * is or how a failure retries.
 */

/**
 * Said BEFORE any request, because the server would refuse every source:
 * registering a folder, and materializing an upload, are gate-admin only
 * (`isGateAdmin` = node admin AND not on a space-pinned session).
 */
export const PROJECT_ADD_FORBIDDEN =
  'Adding a project registers a folder on this node’s disk, and only a node admin can do that. Ask a node admin to add the project to this Space for you, or to grant your account node-admin — then come back to this page.';

export const PROJECT_GITHUB_NOTE =
  'The repository URL is recorded on the project; the node does not clone it yet. Clone it into the chosen folder before agents work there (a GitHub clone step is being designed as its own operation).';

export interface NewProjectPageProps {
  space: { id: SpaceId; name: string };
  nodeLabel: string;
  /** Absent when this seam has no node filesystem (fixtures): the page says so and offers nothing. */
  port: ProjectAddPort | null;
  /** `false` disables every source with the reason; unknown keeps them — the server is the backstop. */
  viewerIsNodeAdmin?: boolean | null;
  onCreated(project: ProjectResource, reusedExisting: boolean): void;
  onCancel(): void;
}

export function NewProjectPage(props: NewProjectPageProps) {
  const draft = useProjectDraft({ defaultTrusted: true });
  const [busy, setBusy] = useState(false);
  const [currentStage, setCurrentStage] = useState<OnboardingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const ids = useRef<ProjectMutationIds | null>(null);
  const cancelUpload = useRef<(() => void) | null>(null);
  /** Same-tick double-submit guard; see `NewSpaceProjectDialog`. */
  const submitting = useRef(false);

  const port = props.port;
  const blocked = props.viewerIsNodeAdmin === false;
  const lockedForRetry = ids.current !== null && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!port || blocked || submitting.current) return;
    const wanted = draft.project();
    const invalid = validateProjectDraft(wanted);
    if (invalid) {
      setValidation(invalid);
      return;
    }
    setValidation(null);
    submitting.current = true;
    const stableIds = ids.current ?? newProjectMutationIds();
    ids.current = stableIds;
    setBusy(true);
    setError(null);
    try {
      const result = await addProjectToSpace(
        port,
        props.space,
        wanted,
        stableIds,
        setCurrentStage,
        (cancel) => { cancelUpload.current = cancel; },
        'the Create Project page',
      );
      ids.current = null;
      setCurrentStage(null);
      props.onCreated(result.project, result.reusedExisting);
    } catch (cause) {
      const failed = cause instanceof OnboardingStageError ? cause.stage : currentStage;
      const label = failed ? STAGE_LABEL[failed] : 'Adding the project';
      setError(`${label} failed: ${explainProjectError(cause)}`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="project-page" data-testid="new-project-page">
      <section className="project-onboard project-onboard--page" aria-labelledby="new-project-title">
        <header className="project-onboard__header">
          <div>
            <div className="project-onboard__eyebrow">NEW PROJECT · {props.space.name} · {props.nodeLabel}</div>
            <h2 id="new-project-title">Create project</h2>
          </div>
        </header>

        {port && draft.browserOpen ? (
          <ProjectFolderBrowser draft={draft} port={port} nodeLabel={props.nodeLabel} />
        ) : (
          <form className="project-onboard__form" onSubmit={submit}>
            <p className="project-onboard__note">
              A project is a folder on {props.nodeLabel} that agents in “{props.space.name}” can work in.
            </p>
            {!port ? (
              <p className="project-onboard__error" role="alert">
                This connection has no access to the node’s folders, so a project cannot be added from here.
              </p>
            ) : null}
            {blocked ? (
              <p className="project-onboard__error" role="alert" data-testid="new-project-forbidden">{PROJECT_ADD_FORBIDDEN}</p>
            ) : null}
            {port ? (
              <fieldset className="project-onboard__section" disabled={!port || blocked || busy || lockedForRetry}>
                <legend>Project</legend>
                <ProjectDraftFields
                  draft={draft}
                  port={port}
                  nodeLabel={props.nodeLabel}
                  onEdit={() => setValidation(null)}
                  githubNote={PROJECT_GITHUB_NOTE}
                />
              </fieldset>
            ) : null}

            {lockedForRetry ? <p className="project-onboard__note">Values are locked so Retry replays the same safe steps.</p> : null}
            {validation ? <p className="project-onboard__error" role="alert">{validation}</p> : null}
            {error ? <p className="project-onboard__error" role="alert">{error}</p> : null}
            <footer className="project-onboard__footer">
              <button
                type="button"
                className="project-onboard__button"
                onClick={() => {
                  cancelUpload.current?.();
                  props.onCancel();
                }}
                disabled={busy && currentStage !== 'upload'}
              >
                {busy && currentStage === 'upload' ? 'Cancel upload' : 'Cancel'}
              </button>
              <button
                type="submit"
                className="project-onboard__button project-onboard__button--primary"
                disabled={busy || !port || blocked}
              >
                {busy && currentStage
                  ? `${STAGE_LABEL[currentStage]}…`
                  : lockedForRetry ? 'Retry' : 'Create project'}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
