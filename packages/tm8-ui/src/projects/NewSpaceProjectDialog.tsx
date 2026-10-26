import { useEffect, useRef, useState } from 'react';
import type {
  CreateSpaceInput,
  CreateSpaceResult,
  ProjectResource,
  SpaceSummary,
} from '@tm8/contract';

import {
  OnboardingStageError,
  ProjectDraftFields,
  ProjectFolderBrowser,
  STAGE_LABEL,
  addProjectToSpace,
  explainProjectError,
  randomToken,
  stage,
  useProjectDraft,
  validateProjectDraft,
  type OnboardingStage,
  type ProjectAddPort,
  type ProjectMutationIds,
  type ProjectOnboardingProject,
} from './project-draft';

import './projects.css';

/*
 * The project half — source kinds, the saga, validation and the fields — lives
 * in `project-draft.tsx` and is shared with the Create Project page. These
 * re-exports keep this module's public surface unchanged.
 */
export {
  FOLDER_UPLOAD_UNAVAILABLE,
  OnboardingStageError,
  isGithubUrl,
  isWorkingDirConflict,
  repoFolderName,
  type FolderImportHandle,
  type OnboardingStage,
  type ProjectOnboardingProject,
  type ProjectSource,
} from './project-draft';

export interface ProjectOnboardingPort extends ProjectAddPort {
  createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult>;
}

export interface ProjectOnboardingInput {
  spaceName: string;
  /** Absent is the ruled default: a Space may be created with no project. */
  project?: ProjectOnboardingProject;
}

export interface OnboardingMutationIds extends ProjectMutationIds {
  space: string;
}

export function newOnboardingMutationIds(token = randomToken()): OnboardingMutationIds {
  return {
    space: `space-onboarding:${token}:space`,
    project: `space-onboarding:${token}:project`,
    link: `space-onboarding:${token}:link`,
    memory: `space-onboarding:${token}:memory`,
    measuredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Validation — one function, so "what the button refuses" and "what the tests
// assert" cannot drift apart. A message here means NO request is made.
// ---------------------------------------------------------------------------

export function validateOnboarding(input: ProjectOnboardingInput): string | null {
  if (!input.spaceName.trim()) return 'Give the Space a name.';
  return input.project ? validateProjectDraft(input.project) : null;
}

/**
 * The retry-safe saga, kept separate from rendering for tests.
 *
 * The Space is committed FIRST and independently: a project step that fails
 * leaves a real, usable Space behind rather than nothing, which is why the
 * project is optional in the first place.
 */
export async function onboardSpaceProject(
  port: ProjectOnboardingPort,
  input: ProjectOnboardingInput,
  ids: OnboardingMutationIds,
  onStage?: (stage: OnboardingStage) => void,
  registerCancel?: (cancel: (() => void) | null) => void,
): Promise<{ space: SpaceSummary; project: ProjectResource | null }> {
  const createdSpace = await stage('space', onStage, () => port.createSpace({
    name: input.spaceName.trim(),
    visibility: 'private',
    clientMutationId: ids.space,
  }));
  const space = createdSpace.space;
  const wanted = input.project;
  if (!wanted) return { space, project: null };
  const { project } = await addProjectToSpace(port, space, wanted, ids, onStage, registerCancel);
  return { space, project };
}

/**
 * Truthful early refusal: the server's `projects.create` is node-admin-only,
 * so a non-admin must not be walked into a saga that commits a Space and then
 * refuses its project. Since 2026-08-12 the Space is no longer hostage to it —
 * the project section is what disables, not the dialog.
 */
export const FOLDER_CONNECT_FORBIDDEN =
  'Adding a project creates a folder on the node’s disk, which needs node-admin rights on this node. You can still create the Space; ask an owner to add the project, or to grant your account node-admin.';

export interface NewSpaceProjectDialogProps {
  open: boolean;
  nodeLabel: string;
  /**
   * The viewer's node-admin standing when the host has resolved it; `false`
   * disables the PROJECT section with the truthful reason. Unknown
   * (undefined/null) keeps it available — the server remains the backstop, and
   * a failed enhancement read must not lock the door.
   */
  viewerIsNodeAdmin?: boolean | null;
  port: ProjectOnboardingPort;
  onDismiss(): void;
  onCreated(space: SpaceSummary): void;
}

export function NewSpaceProjectDialog(props: NewSpaceProjectDialogProps) {
  const [spaceName, setSpaceName] = useState('');
  const [addProject, setAddProject] = useState(false);
  const draft = useProjectDraft();
  const [busy, setBusy] = useState(false);
  const [currentStage, setCurrentStage] = useState<OnboardingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const ids = useRef<OnboardingMutationIds | null>(null);
  const cancelUpload = useRef<(() => void) | null>(null);
  /**
   * The double-submit guard that a `disabled` attribute cannot be: two clicks
   * dispatched in the same tick both read the pre-render `busy`, so the second
   * one has to be refused by a ref that was already written synchronously.
   */
  const submitting = useRef(false);

  const lockedForRetry = ids.current !== null && !busy;
  const folderBlocked = props.viewerIsNodeAdmin === false;

  useEffect(() => {
    if (!props.open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) props.onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.open, props.onDismiss, busy]);

  if (!props.open) return null;

  const buildInput = (): ProjectOnboardingInput => ({
    spaceName,
    ...(addProject && !folderBlocked ? { project: draft.project() } : {}),
  });

  const resetForm = () => {
    setSpaceName('');
    setAddProject(false);
    draft.reset();
    setValidation(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    const input = buildInput();
    const invalid = validateOnboarding(input);
    if (invalid) {
      // No request is made: an invalid form never reaches the wire.
      setValidation(invalid);
      return;
    }
    setValidation(null);
    submitting.current = true;
    const stableIds = ids.current ?? newOnboardingMutationIds();
    ids.current = stableIds;
    setBusy(true);
    setError(null);
    try {
      const result = await onboardSpaceProject(
        props.port,
        input,
        stableIds,
        setCurrentStage,
        (cancel) => { cancelUpload.current = cancel; },
      );
      ids.current = null;
      setCurrentStage(null);
      resetForm();
      props.onCreated(result.space);
    } catch (cause) {
      // The dialog STAYS OPEN with every value intact: re-typing a folder path
      // because the node answered 409 is the failure this guards.
      const failed = cause instanceof OnboardingStageError ? cause.stage : currentStage;
      const label = failed ? STAGE_LABEL[failed] : 'Onboarding';
      setError(`${label} failed: ${explainProjectError(cause)} Retry resumes safely with the same mutation ids.`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const disabled = busy || lockedForRetry;

  return (
    <div className="project-onboard__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) props.onDismiss();
    }}>
      <section className="project-onboard" role="dialog" aria-modal="true" aria-labelledby="project-onboard-title">
        <header className="project-onboard__header">
          <div>
            <div className="project-onboard__eyebrow">NEW SPACE · {props.nodeLabel}</div>
            <h2 id="project-onboard-title">Create Space</h2>
          </div>
          <button type="button" className="project-onboard__close" onClick={props.onDismiss} disabled={busy} aria-label="Close">×</button>
        </header>

        {draft.browserOpen ? (
          <ProjectFolderBrowser draft={draft} port={props.port} nodeLabel={props.nodeLabel} />
        ) : (
          <form className="project-onboard__form" onSubmit={submit}>
            <label>
              <span>Space name</span>
              <input
                value={spaceName}
                onChange={(event) => { setSpaceName(event.target.value); setValidation(null); }}
                disabled={disabled}
                autoFocus
              />
            </label>

            <label className="project-onboard__trust">
              <input
                type="checkbox"
                checked={addProject}
                onChange={(event) => { setAddProject(event.target.checked); setValidation(null); }}
                disabled={disabled || folderBlocked}
              />
              <span>
                <strong>Add a project to this Space</strong>
                <small>Optional. A Space works without one; you can add a project later.</small>
              </span>
            </label>
            {folderBlocked ? <p className="project-onboard__error" role="alert">{FOLDER_CONNECT_FORBIDDEN}</p> : null}

            {addProject && !folderBlocked ? (
              <fieldset className="project-onboard__section" disabled={disabled}>
                <legend>Project</legend>
                <ProjectDraftFields
                  draft={draft}
                  port={props.port}
                  nodeLabel={props.nodeLabel}
                  onEdit={() => setValidation(null)}
                />
              </fieldset>
            ) : null}

            {lockedForRetry ? <p className="project-onboard__note">Values are locked so Retry replays the same safe saga.</p> : null}
            {validation ? <p className="project-onboard__error" role="alert">{validation}</p> : null}
            {error ? <p className="project-onboard__error" role="alert">{error}</p> : null}
            <footer className="project-onboard__footer">
              <button
                type="button"
                className="project-onboard__button"
                onClick={() => {
                  cancelUpload.current?.();
                  props.onDismiss();
                }}
                disabled={busy && currentStage !== 'upload'}
              >
                {busy && currentStage === 'upload' ? 'Cancel upload' : 'Cancel'}
              </button>
              <button
                type="submit"
                className="project-onboard__button project-onboard__button--primary"
                disabled={busy}
              >
                {busy && currentStage
                  ? `${STAGE_LABEL[currentStage]}…`
                  : lockedForRetry
                    ? 'Retry'
                    : addProject && !folderBlocked ? 'Create Space & add project' : 'Create Space'}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
