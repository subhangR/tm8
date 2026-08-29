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
import { filesFromInput } from '../files-explorer/picker';
import { broadWorkingDirReason, broadWorkingDirWarning } from './working-dir-risk';

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

/** `https://github.com/owner/repo(.git)` → `repo`; '' when unreadable. */
export function repoFolderName(raw: string): string {
  const value = raw.trim().replace(/\.git$/, '');
  const tail = value.split(/[/:]/).filter(Boolean).pop() ?? '';
  return /^[^\\/]+$/.test(tail) && tail !== '.' && tail !== '..' ? tail : '';
}

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

type SourceKind = ProjectSource['kind'];

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
  const [sourceKind, setSourceKind] = useState<SourceKind>('folder');
  const [workingDir, setWorkingDir] = useState('');
  const [ensureWorkingDir, setEnsureWorkingDir] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [refusedCount, setRefusedCount] = useState(0);
  const [destinationParent, setDestinationParent] = useState('');
  const [uploadRootName, setUploadRootName] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserMode, setBrowserMode] = useState<'workingDir' | 'destinationParent'>('workingDir');
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
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

  const browse = async (path?: string) => {
    setBrowserOpen(true);
    setBrowserBusy(true);
    setBrowserError(null);
    try {
      setListing(await props.port.directories(path));
    } catch (cause) {
      setBrowserError(String((cause as { message?: unknown } | null)?.message ?? cause));
    } finally {
      setBrowserBusy(false);
    }
  };

  const openBrowser = (mode: 'workingDir' | 'destinationParent') => {
    setBrowserMode(mode);
    void browse();
  };

  const useCurrent = () => {
    if (!listing) return;
    if (browserMode === 'destinationParent') setDestinationParent(listing.path);
    else {
      setWorkingDir(listing.path);
      setEnsureWorkingDir(false);
    }
    setBrowserOpen(false);
  };

  /**
   * `workingDir` is only ever set from the browser, so a listing has normally
   * been seen by the time either of these matters; the regex is the fallback
   * for a restored/typed value, not the primary source.
   */
  const separatorFor = (path: string): '/' | '\\' =>
    listing?.separator ?? (/^[A-Za-z]:[\\/]/.test(path) ? '\\' : '/');
  /** The consequence at the moment of the click, in the browser. */
  const browsingBroad = listing ? broadWorkingDirReason(listing.path, listing.separator) : null;
  /** The same consequence, kept visible on the selection until submit. */
  const selectedBroad = workingDir ? broadWorkingDirReason(workingDir, separatorFor(workingDir)) : null;

  const cleanFolderName = newFolderName.trim();
  const validFolderName = cleanFolderName.length > 0
    && cleanFolderName !== '.'
    && cleanFolderName !== '..'
    && !/[\\/]/.test(cleanFolderName);
  const useNew = () => {
    if (!listing || !validFolderName || browserMode !== 'workingDir') return;
    const seam = listing.path.endsWith(listing.separator) ? '' : listing.separator;
    setWorkingDir(`${listing.path}${seam}${cleanFolderName}`);
    setEnsureWorkingDir(true);
    setBrowserOpen(false);
  };

  const onPick = (list: FileList | null) => {
    const result = filesFromInput(list);
    setPicked(result.files);
    setRefusedCount(result.refused.length);
    setValidation(null);
    if (!uploadRootName) {
      const first = result.files[0]?.relativePath ?? '';
      const root = first.includes('/') ? first.split('/')[0]! : '';
      if (root) setUploadRootName(root);
      if (root && !projectName) setProjectName(root);
    }
  };

  const currentSource = (): ProjectSource => {
    if (sourceKind === 'upload') {
      return { kind: 'upload', destinationParent, rootName: uploadRootName.trim(), files: picked };
    }
    if (sourceKind === 'github') {
      return { kind: 'github', repoUrl, workingDir, ensureWorkingDir };
    }
    return { kind: 'folder', workingDir, ensureWorkingDir };
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
    setSourceKind('folder');
    setWorkingDir('');
    setEnsureWorkingDir(false);
    setRepoUrl('');
    setPicked([]);
    setRefusedCount(0);
    setDestinationParent('');
    setUploadRootName('');
    setTrusted(false);
    setListing(null);
    setNewFolderName('');
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

        {browserOpen ? (
          <div className="project-browser">
            <div className="project-browser__head">
              <button type="button" className="project-onboard__button" onClick={() => setBrowserOpen(false)}>← Form</button>
              <strong>
                {browserMode === 'destinationParent'
                  ? `Choose where the upload lands on ${props.nodeLabel}`
                  : `Browse folders on ${props.nodeLabel}`}
              </strong>
            </div>
            {listing ? (
              <>
                <div className="project-browser__roots" aria-label="Allowed roots">
                  {listing.roots.map((root) => (
                    <button type="button" key={root} onClick={() => void browse(root)}>{root}</button>
                  ))}
                </div>
                <div className="project-browser__path" title={listing.path}>{listing.path}</div>
                {browsingBroad && browserMode === 'workingDir' ? (
                  <p className="project-onboard__warning" role="alert">{broadWorkingDirWarning(browsingBroad)}</p>
                ) : null}
                <div className="project-browser__actions">
                  <button type="button" className="project-onboard__button project-onboard__button--primary" onClick={useCurrent}>Use this folder</button>
                  {listing.parentPath ? (
                    <button type="button" className="project-onboard__button" onClick={() => void browse(listing.parentPath!)}>↑ Parent</button>
                  ) : null}
                </div>
                <ul className="project-browser__list" aria-label="Folders">
                  {listing.directories.map((directory) => (
                    <li key={directory.path}>
                      <button type="button" onClick={() => void browse(directory.path)}>
                        <span aria-hidden="true">▱</span> {directory.name}
                      </button>
                    </li>
                  ))}
                  {!browserBusy && listing.directories.length === 0 ? <li className="project-browser__empty">No child folders</li> : null}
                </ul>
                {listing.truncated ? <p className="project-onboard__note">Only the first 500 folders are shown.</p> : null}
                {browserMode === 'workingDir' ? (
                  <div className="project-browser__new">
                    <label htmlFor="project-new-folder">Create a new folder here</label>
                    <div>
                      <input
                        id="project-new-folder"
                        value={newFolderName}
                        onChange={(event) => setNewFolderName(event.target.value)}
                        placeholder="folder-name"
                      />
                      <button type="button" className="project-onboard__button" onClick={useNew} disabled={!validFolderName}>Use new folder</button>
                    </div>
                    {newFolderName && !validFolderName ? <span role="alert">Use one folder name without slashes.</span> : null}
                  </div>
                ) : (
                  <p className="project-onboard__note">
                    The uploaded folder is created inside the folder you choose here.
                  </p>
                )}
              </>
            ) : null}
            {browserBusy ? <p className="project-onboard__note" role="status">Reading folders…</p> : null}
            {browserError ? <p className="project-onboard__error" role="alert">{browserError}</p> : null}
          </div>
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

                <div className="project-onboard__field" role="radiogroup" aria-label="Project source">
                  <span>Where do its files come from?</span>
                  <label className="project-onboard__radio">
                    <input
                      type="radio"
                      name="project-source"
                      checked={sourceKind === 'folder'}
                      onChange={() => { setSourceKind('folder'); setValidation(null); }}
                    />
                    <span>A folder already on {props.nodeLabel}</span>
                  </label>
                  <label className="project-onboard__radio">
                    <input
                      type="radio"
                      name="project-source"
                      checked={sourceKind === 'upload'}
                      disabled={uploadUnavailable}
                      onChange={() => { setSourceKind('upload'); setValidation(null); }}
                    />
                    <span>Upload a folder or files from this computer</span>
                  </label>
                  <label className="project-onboard__radio">
                    <input
                      type="radio"
                      name="project-source"
                      checked={sourceKind === 'github'}
                      onChange={() => { setSourceKind('github'); setValidation(null); }}
                    />
                    <span>A GitHub repository</span>
                  </label>
                  {uploadUnavailable ? <p className="project-onboard__note">{FOLDER_UPLOAD_UNAVAILABLE}</p> : null}
                </div>

                {sourceKind === 'folder' || sourceKind === 'github' ? (
                  <div className="project-onboard__field">
                    <span>{sourceKind === 'github' ? `Folder for the repository on ${props.nodeLabel}` : `Local folder on ${props.nodeLabel}`}</span>
                    <div className="project-onboard__folder-row">
                      <code>{workingDir || 'No folder selected'}</code>
                      <button type="button" className="project-onboard__button" onClick={() => openBrowser('workingDir')}>Browse folders</button>
                    </div>
                    {ensureWorkingDir ? <small>This folder will be created when you submit.</small> : null}
                    {selectedBroad ? (
                      <p className="project-onboard__warning" role="alert">{broadWorkingDirWarning(selectedBroad)}</p>
                    ) : null}
                  </div>
                ) : null}

                {sourceKind === 'github' ? (
                  <>
                    <label>
                      <span>GitHub repository URL</span>
                      <input
                        value={repoUrl}
                        placeholder="https://github.com/owner/repo"
                        onChange={(event) => {
                          setRepoUrl(event.target.value);
                          setValidation(null);
                          if (!projectName) {
                            const suggested = repoFolderName(event.target.value);
                            if (suggested) setProjectName(suggested);
                          }
                        }}
                      />
                    </label>
                    <p className="project-onboard__note">
                      The repository URL is recorded on the project. Nothing is cloned now — clone it from the
                      project once the Space exists.
                    </p>
                  </>
                ) : null}

                {sourceKind === 'upload' ? (
                  <div className="project-onboard__field">
                    <span>Folder or files to upload</span>
                    <div className="project-onboard__upload-row">
                      <label className="project-onboard__button">
                        Choose folder
                        <input
                          type="file"
                          aria-label="Choose folder"
                          multiple
                          // Non-standard attributes, spread because React's DOM
                          // typings have no member for either.
                          {...{ webkitdirectory: '', directory: '' }}
                          onChange={(event) => onPick(event.target.files)}
                        />
                      </label>
                      <label className="project-onboard__button">
                        Choose files
                        <input
                          type="file"
                          aria-label="Choose files"
                          multiple
                          onChange={(event) => onPick(event.target.files)}
                        />
                      </label>
                    </div>
                    {picked.length > 0 ? (
                      <small>{picked.length} file{picked.length === 1 ? '' : 's'} selected.</small>
                    ) : null}
                    {refusedCount > 0 ? (
                      <p className="project-onboard__error" role="alert">
                        {refusedCount} path{refusedCount === 1 ? ' was' : 's were'} refused for an unsafe shape and will not be uploaded.
                      </p>
                    ) : null}
                    <label>
                      <span>New folder name on {props.nodeLabel}</span>
                      <input value={uploadRootName} onChange={(event) => { setUploadRootName(event.target.value); setValidation(null); }} placeholder="folder-name" />
                    </label>
                    <div className="project-onboard__folder-row">
                      <code>{destinationParent || 'No destination chosen'}</code>
                      <button type="button" className="project-onboard__button" onClick={() => openBrowser('destinationParent')}>Choose destination</button>
                    </div>
                  </div>
                ) : null}

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
