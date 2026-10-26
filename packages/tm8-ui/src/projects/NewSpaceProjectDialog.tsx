import { useEffect, useRef, useState } from 'react';
import type {
  CommandResult,
  CreateEntityInput,
  CreateSpaceInput,
  CreateSpaceResult,
  ProjectCreateInput,
  ProjectDirectoryListing,
  ProjectLinkInput,
  ProjectResource,
  ProjectTrustLevel,
  SpaceId,
  SpaceSummary,
} from '@tm8/contract';

import type { PickedFile } from '../files-explorer/picker';
import {
  ProjectFolderBrowser,
  ProjectSourceFields,
  repoFolderName,
  useProjectSourceDraft,
  type SourceKind,
} from './project-source';

import './projects.css';

export type OnboardingStage = 'space' | 'project' | 'upload' | 'link' | 'memory';

/**
 * One source, radio-selected (owner ruling 2026-08-12). They are mutually
 * exclusive because their failure modes are: `folder` records a path that
 * already exists on the node, `upload` MATERIALIZES bytes into a new root, and
 * `github` records a remote URL against a folder nobody has cloned into yet.
 * Offering them as independent fields would let a user describe a state the
 * server cannot produce.
 */
export type ProjectSource =
  | { kind: 'folder'; workingDir: string; ensureWorkingDir: boolean }
  /**
   * LINK NOW, CLONE LATER. `repoUrl` is recorded on the project; no clone is
   * attempted here. A clone is slow, needs credentials for a private repo, and
   * can fail halfway — none of which belongs inside a create dialog's saga.
   * The folder is still required: a project without a working directory is not
   * a shape `projects.create` accepts.
   */
  | { kind: 'github'; repoUrl: string; workingDir: string; ensureWorkingDir: boolean }
  | { kind: 'upload'; destinationParent: string; rootName: string; files: readonly PickedFile[] };

export interface ProjectOnboardingProject {
  name: string;
  trusted: boolean;
  source: ProjectSource;
}

/**
 * The imported-folder lifecycle, as the dialog needs it. Shaped as a task and
 * not a promise so a cancel ABORTS the server-side session instead of
 * orphaning its staging directory — the contract `files-explorer/folder-import`
 * already implements over `projects.folderUploads.*`.
 */
export interface FolderImportHandle {
  result: Promise<ProjectResource>;
  cancel(): void;
}

export interface ProjectOnboardingPort {
  directories(path?: string): Promise<ProjectDirectoryListing>;
  createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult>;
  createProject(input: ProjectCreateInput): Promise<ProjectResource>;
  linkProject(spaceId: SpaceId, input: ProjectLinkInput): Promise<void>;
  createMemory(input: CreateEntityInput): Promise<CommandResult>;
  /**
   * Every project on the node, unscoped. Optional so ports that predate it
   * keep compiling; without it a working-dir conflict stays a dead end
   * instead of recovering into a link of the existing project.
   */
  listProjects?(): Promise<ProjectResource[]>;
  /**
   * Absent when this node does not serve `projects.folderUploads.*`; the
   * Upload radio is then disabled with the truthful reason rather than
   * offered and failed at submit.
   */
  importFolder?(input: {
    spaceId: SpaceId;
    projectName: string;
    destinationParent: string;
    rootName: string;
    trust: ProjectTrustLevel;
    files: readonly PickedFile[];
  }): FolderImportHandle;
}

export interface ProjectOnboardingInput {
  spaceName: string;
  /** Absent is the ruled default: a Space may be created with no project. */
  project?: ProjectOnboardingProject;
}

export interface OnboardingMutationIds {
  space: string;
  project: string;
  link: string;
  memory: string;
  measuredAt: string;
}

export class OnboardingStageError extends Error {
  constructor(readonly stage: OnboardingStage, cause: unknown) {
    super(String((cause as { message?: unknown } | null)?.message ?? cause));
    this.name = 'OnboardingStageError';
  }
}

function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
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

async function stage<T>(
  name: OnboardingStage,
  notify: ((stage: OnboardingStage) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  notify?.(name);
  try {
    return await run();
  } catch (error) {
    throw new OnboardingStageError(name, error);
  }
}

// ---------------------------------------------------------------------------
// Validation — one function, so "what the button refuses" and "what the tests
// assert" cannot drift apart. A message here means NO request is made.
// ---------------------------------------------------------------------------

export function validateOnboarding(input: ProjectOnboardingInput): string | null {
  if (!input.spaceName.trim()) return 'Give the Space a name.';
  const project = input.project;
  if (!project) return null;
  if (!project.name.trim()) return 'Give the project a name, or remove the project.';
  const source = project.source;
  if (source.kind === 'folder') {
    if (!source.workingDir) return 'Choose the local folder this project lives in.';
    return null;
  }
  if (source.kind === 'github') {
    if (!isGithubUrl(source.repoUrl)) return 'Enter a GitHub repository URL, like https://github.com/owner/repo.';
    if (!source.workingDir) return 'Choose the local folder the repository will live in.';
    return null;
  }
  if (source.files.length === 0) return 'Choose a folder or files to upload.';
  if (!source.destinationParent) return 'Choose where on the node the uploaded folder should land.';
  if (!source.rootName) return 'Name the folder that will be created for the upload.';
  return null;
}

/** Deliberately narrow: this URL is RECORDED, so a typo is silent forever. */
export function isGithubUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  const ssh = /^git@github\.com:[^/\s]+\/[^/\s]+?(?:\.git)?$/.test(value);
  if (ssh) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return false;
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

export { repoFolderName };

function memoryStatement(
  spaceName: string,
  project: ProjectResource,
  source: ProjectSource,
  reusedExisting: boolean,
): string {
  const base = `Space “${spaceName}” uses project “${project.name}” at node-local folder “${project.workingDir}”.`;
  const reuse = reusedExisting
    ? ' The folder already belonged to this EXISTING project, which was linked as-is; nothing new was created on disk and the project keeps its own name and trust level.'
    : '';
  if (source.kind === 'github') {
    return `${base}${reuse} Its GitHub repository ${source.repoUrl} is RECORDED as the project's remote; nothing has been cloned.`;
  }
  if (source.kind === 'upload') {
    return `${base} Its contents were uploaded from a browser and materialized on the node.`;
  }
  return `${base}${reuse}`;
}

/**
 * `working_dir` is node-globally unique BY DESIGN — two projects sharing a
 * directory would make a spawn's cwd ambiguous. So "this folder already has a
 * project" is not a failure of the user's intent: the existing project IS the
 * thing they pointed at, and the honest continuation is to link it into the
 * new Space. Surfacing the raw constraint name (`projects_working_dir_key`)
 * walked the user into a dead end where Retry could only replay the refusal.
 */
export function isWorkingDirConflict(cause: unknown): boolean {
  return String((cause as { message?: unknown } | null)?.message ?? cause)
    .includes('projects_working_dir_key');
}

async function existingProjectForWorkingDir(
  port: ProjectOnboardingPort,
  workingDir: string,
  cause: unknown,
): Promise<ProjectResource | null> {
  if (!isWorkingDirConflict(cause) || !port.listProjects) return null;
  // A failed lookup must not mask the original refusal — fall through to it.
  const all = await port.listProjects().catch(() => null);
  return all?.find((candidate) => candidate.workingDir === workingDir) ?? null;
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

  const trust: ProjectTrustLevel = wanted.trusted ? 'trusted' : 'untrusted';
  const source = wanted.source;
  let project: ProjectResource;
  let reusedExisting = false;

  if (source.kind === 'upload') {
    const importFolder = port.importFolder;
    if (!importFolder) {
      throw new OnboardingStageError('upload', new Error(FOLDER_UPLOAD_UNAVAILABLE));
    }
    project = await stage('upload', onStage, async () => {
      const task = importFolder({
        spaceId: space.id,
        projectName: wanted.name.trim(),
        destinationParent: source.destinationParent,
        rootName: source.rootName,
        trust,
        files: source.files,
      });
      registerCancel?.(task.cancel);
      try {
        return await task.result;
      } finally {
        registerCancel?.(null);
      }
    });
    // `projects.folderUploads.complete` creates AND links the project itself,
    // so a second `projects.link` here would be a duplicate, not a safety net.
  } else {
    let reused = false;
    project = await stage('project', onStage, async () => {
      try {
        return await port.createProject({
          name: wanted.name.trim(),
          workingDir: source.workingDir,
          ensureWorkingDir: source.ensureWorkingDir,
          trust,
          ...(source.kind === 'github' ? { repoUrl: source.repoUrl.trim() } : {}),
          clientMutationId: ids.project,
        });
      } catch (cause) {
        const existing = await existingProjectForWorkingDir(port, source.workingDir, cause);
        if (!existing) throw cause;
        reused = true;
        return existing;
      }
    });
    await stage('link', onStage, () => port.linkProject(space.id, {
      projectId: project.id,
      clientMutationId: ids.link,
    }));
    reusedExisting = reused;
  }

  await stage('memory', onStage, () => port.createMemory({
    clientMutationId: ids.memory,
    spaceId: space.id,
    kind: 'memory',
    title: `Project folder: ${project.name}`,
    content: {
      statement: memoryStatement(space.name, project, source, reusedExisting),
      mechanism: source.kind === 'upload'
        ? 'Recorded by Space project onboarding after projects.folderUploads.complete succeeded.'
        : reusedExisting
          ? 'Recorded by Space project onboarding after projects.create refused the already-connected folder and projects.link linked its existing project.'
          : 'Recorded by Space project onboarding after projects.create and projects.link succeeded.',
      subjectScope: `Space ${space.id}; project ${project.id}; working directory ${project.workingDir}`,
      doesNotEstablish: source.kind === 'github'
        ? 'This records the repository URL and the configured working directory; it does not establish a clone, fetched refs, or any Git state on disk.'
        : 'This records the configured working directory; it does not establish file synchronization, Git status, or commit state.',
      measuredAt: ids.measuredAt,
    },
  }));
  return { space, project };
}

const STAGE_LABEL: Record<OnboardingStage, string> = {
  space: 'Creating Space',
  project: 'Creating project folder',
  upload: 'Uploading folder',
  link: 'Connecting project',
  memory: 'Recording memory',
};

/**
 * Truthful early refusal: the server's `projects.create` is node-admin-only,
 * so a non-admin must not be walked into a saga that commits a Space and then
 * refuses its project. Since 2026-08-12 the Space is no longer hostage to it —
 * the project section is what disables, not the dialog.
 */
export const FOLDER_CONNECT_FORBIDDEN =
  'Adding a project creates a folder on the node’s disk, which needs node-admin rights on this node. You can still create the Space; ask an owner to add the project, or to grant your account node-admin.';

export const FOLDER_UPLOAD_UNAVAILABLE =
  'This node does not serve the folder-upload operations, so bytes cannot be sent from the browser here. Browse to a folder on the node instead.';

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
  const [projectName, setProjectName] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const draft = useProjectSourceDraft({
    directories: (path) => props.port.directories(path),
    onSuggestName: (name) => { if (!projectName) setProjectName(name); },
    onEdit: () => setValidation(null),
  });
  const [busy, setBusy] = useState(false);
  const [currentStage, setCurrentStage] = useState<OnboardingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const uploadUnavailable = !props.port.importFolder;

  useEffect(() => {
    if (!props.open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) props.onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.open, props.onDismiss, busy]);

  if (!props.open) return null;

  const currentSource = (): ProjectSource => {
    const kind: SourceKind = draft.sourceKind;
    if (kind === 'upload') {
      return { kind: 'upload', destinationParent: draft.destinationParent, rootName: draft.rootName.trim(), files: draft.picked };
    }
    if (kind === 'github') {
      return { kind: 'github', repoUrl: draft.repoUrl, workingDir: draft.workingDir, ensureWorkingDir: draft.ensureWorkingDir };
    }
    return { kind: 'folder', workingDir: draft.workingDir, ensureWorkingDir: draft.ensureWorkingDir };
  };

  const buildInput = (): ProjectOnboardingInput => ({
    spaceName,
    ...(addProject && !folderBlocked
      ? { project: { name: projectName, trusted, source: currentSource() } }
      : {}),
  });

  const resetForm = () => {
    setSpaceName('');
    setAddProject(false);
    setProjectName('');
    draft.reset();
    setTrusted(false);
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
      setError(`${label} failed: ${String((cause as { message?: unknown } | null)?.message ?? cause)} Retry resumes safely with the same mutation ids.`);
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

        {draft.browser.open ? (
          <ProjectFolderBrowser draft={draft} nodeLabel={props.nodeLabel} />
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
                <label>
                  <span>Project name</span>
                  <input value={projectName} onChange={(event) => { setProjectName(event.target.value); setValidation(null); }} />
                </label>

                <ProjectSourceFields
                  draft={draft}
                  nodeLabel={props.nodeLabel}
                  githubMode="record"
                  uploadUnavailableReason={uploadUnavailable ? FOLDER_UPLOAD_UNAVAILABLE : null}
                />

                <label className="project-onboard__trust">
                  <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
                  <span>
                    <strong>Trust this folder for agent execution</strong>
                    <small>Off by default. Trusted projects allow agents to run with this folder as their working directory.</small>
                  </span>
                </label>
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
