import { useState } from 'react';
import type {
  CommandResult,
  CreateEntityInput,
  ProjectCreateInput,
  ProjectDirectoryListing,
  ProjectLinkInput,
  ProjectResource,
  ProjectTrustLevel,
  SpaceId,
} from '@tm8/contract';

import type { PickedFile } from '../files-explorer/picker';
import { filesFromInput } from '../files-explorer/picker';
import { broadWorkingDirReason, broadWorkingDirWarning } from './working-dir-risk';

import './projects.css';

/**
 * ONE PROJECT, ADDED TO ONE EXISTING SPACE — the half of Create Space that
 * does not create the Space.
 *
 * It used to live inside `NewSpaceProjectDialog`, where a project could only
 * ever be born alongside a brand-new Space. A Space created without one then
 * had no door to add one later (task 01a0fb4f, 2026-10-02). The saga, the
 * validation and the form fields moved here so the dialog and the Create
 * Project page run the SAME code rather than two copies that drift.
 */

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

/** Everything adding a project to an EXISTING Space needs — no `createSpace`. */
export interface ProjectAddPort {
  directories(path?: string): Promise<ProjectDirectoryListing>;
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

export interface ProjectMutationIds {
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

export function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function newProjectMutationIds(token = randomToken()): ProjectMutationIds {
  return {
    project: `project-add:${token}:project`,
    link: `project-add:${token}:link`,
    memory: `project-add:${token}:memory`,
    measuredAt: new Date().toISOString(),
  };
}

export async function stage<T>(
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

export function validateProjectDraft(project: ProjectOnboardingProject): string | null {
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

/** `/srv/projects/website/` → `website`; '' for a root. Either separator. */
export function folderBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
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
  port: ProjectAddPort,
  workingDir: string,
  cause: unknown,
): Promise<ProjectResource | null> {
  if (!isWorkingDirConflict(cause) || !port.listProjects) return null;
  // A failed lookup must not mask the original refusal — fall through to it.
  const all = await port.listProjects().catch(() => null);
  return all?.find((candidate) => candidate.workingDir === workingDir) ?? null;
}

/**
 * Create (or reuse) the project, link it into `space`, and record the memory.
 * Retry-safe: every write carries a stable mutation id from `ids`.
 *
 * `recordedBy` names the surface in the memory's mechanism, so a reader can
 * tell an onboarding-born project from one added later.
 */
export async function addProjectToSpace(
  port: ProjectAddPort,
  space: { id: SpaceId; name: string },
  wanted: ProjectOnboardingProject,
  ids: ProjectMutationIds,
  onStage?: (stage: OnboardingStage) => void,
  registerCancel?: (cancel: (() => void) | null) => void,
  recordedBy = 'Space project onboarding',
): Promise<{ project: ProjectResource; reusedExisting: boolean }> {
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
        ? `Recorded by ${recordedBy} after projects.folderUploads.complete succeeded.`
        : reusedExisting
          ? `Recorded by ${recordedBy} after projects.create refused the already-connected folder and projects.link linked its existing project.`
          : `Recorded by ${recordedBy} after projects.create and projects.link succeeded.`,
      subjectScope: `Space ${space.id}; project ${project.id}; working directory ${project.workingDir}`,
      doesNotEstablish: source.kind === 'github'
        ? 'This records the repository URL and the configured working directory; it does not establish a clone, fetched refs, or any Git state on disk.'
        : 'This records the configured working directory; it does not establish file synchronization, Git status, or commit state.',
      measuredAt: ids.measuredAt,
    },
  }));
  return { project, reusedExisting };
}

export const STAGE_LABEL: Record<OnboardingStage, string> = {
  space: 'Creating Space',
  project: 'Creating project folder',
  upload: 'Uploading folder',
  link: 'Connecting project',
  memory: 'Recording memory',
};

export const FOLDER_UPLOAD_UNAVAILABLE =
  'This node does not serve the folder-upload operations, so bytes cannot be sent from the browser here. Browse to a folder on the node instead.';

/**
 * The refusals a person cannot act on as written, translated into what is
 * true and what to do. Anything unrecognised is returned verbatim — a
 * paraphrase of an unknown error is a guess.
 *
 * `this folder belongs to another space` is T30 (db 234): on a node that is
 * not loopback-`single`, a folder is granted to ONE Space and `projects.link`
 * refuses every other. `gate-admin access is required` is the server's
 * `isGateAdmin` (node admin AND not on a space-pinned session).
 */
export function explainProjectError(cause: unknown): string {
  const raw = String((cause as { message?: unknown } | null)?.message ?? cause);
  if (/folder belongs to another space/i.test(raw)) {
    return 'This folder is already a project in another Space. On this node each folder belongs to exactly one Space, so it cannot be linked here as well. Choose a different folder, or ask a node admin to move the folder’s grant to this Space.';
  }
  if (/gate-admin access is required|node[- ]admin/i.test(raw) && /forbidden|required/i.test(raw)) {
    return 'Only a node admin can register a folder on this node. Ask a node admin to add the project for you, or to grant your account node-admin.';
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The draft — form state shared by the Create Space dialog and the Create
// Project page. A hook plus two render pieces; the host owns the frame, the
// submit and the saga call.
// ---------------------------------------------------------------------------

export type SourceKind = ProjectSource['kind'];

export function useProjectDraft(options: { defaultTrusted?: boolean } = {}) {
  const defaultTrusted = options.defaultTrusted ?? false;
  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('folder');
  const [workingDir, setWorkingDir] = useState('');
  const [ensureWorkingDir, setEnsureWorkingDir] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [refusedCount, setRefusedCount] = useState(0);
  const [destinationParent, setDestinationParent] = useState('');
  const [uploadRootName, setUploadRootName] = useState('');
  const [trusted, setTrusted] = useState(defaultTrusted);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserMode, setBrowserMode] = useState<'workingDir' | 'destinationParent'>('workingDir');
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  /** Pre-fill the name from the folder or repo (owner ruling 2026-10-02) — never over a typed one. */
  const suggestName = (suggested: string) => {
    if (suggested) setName((current) => current || suggested);
  };

  const source = (): ProjectSource => {
    if (sourceKind === 'upload') {
      return { kind: 'upload', destinationParent, rootName: uploadRootName.trim(), files: picked };
    }
    if (sourceKind === 'github') {
      return { kind: 'github', repoUrl, workingDir, ensureWorkingDir };
    }
    return { kind: 'folder', workingDir, ensureWorkingDir };
  };

  const reset = () => {
    setName('');
    setSourceKind('folder');
    setWorkingDir('');
    setEnsureWorkingDir(false);
    setRepoUrl('');
    setPicked([]);
    setRefusedCount(0);
    setDestinationParent('');
    setUploadRootName('');
    setTrusted(defaultTrusted);
    setListing(null);
    setNewFolderName('');
  };

  return {
    name, setName, sourceKind, setSourceKind, workingDir, setWorkingDir, ensureWorkingDir,
    setEnsureWorkingDir, repoUrl, setRepoUrl, picked, setPicked, refusedCount, setRefusedCount,
    destinationParent, setDestinationParent, uploadRootName, setUploadRootName, trusted, setTrusted,
    browserOpen, setBrowserOpen, browserMode, setBrowserMode, listing, setListing, browserBusy,
    setBrowserBusy, browserError, setBrowserError, newFolderName, setNewFolderName,
    suggestName,
    /** The draft as the saga reads it. */
    project: (): ProjectOnboardingProject => ({ name, trusted, source: source() }),
    reset,
  };
}

export type ProjectDraft = ReturnType<typeof useProjectDraft>;

async function browse(draft: ProjectDraft, port: Pick<ProjectAddPort, 'directories'>, path?: string) {
  draft.setBrowserOpen(true);
  draft.setBrowserBusy(true);
  draft.setBrowserError(null);
  try {
    draft.setListing(await port.directories(path));
  } catch (cause) {
    draft.setBrowserError(String((cause as { message?: unknown } | null)?.message ?? cause));
  } finally {
    draft.setBrowserBusy(false);
  }
}

function openBrowser(
  draft: ProjectDraft,
  port: Pick<ProjectAddPort, 'directories'>,
  mode: 'workingDir' | 'destinationParent',
) {
  draft.setBrowserMode(mode);
  void browse(draft, port);
}

/**
 * `workingDir` is only ever set from the browser, so a listing has normally
 * been seen by the time either of these matters; the regex is the fallback
 * for a restored/typed value, not the primary source.
 */
function separatorFor(draft: ProjectDraft, path: string): '/' | '\\' {
  return draft.listing?.separator ?? (/^[A-Za-z]:[\\/]/.test(path) ? '\\' : '/');
}

/** The node-folder browser. Rendered by the host IN PLACE OF the form while `draft.browserOpen`. */
export function ProjectFolderBrowser(props: {
  draft: ProjectDraft;
  port: Pick<ProjectAddPort, 'directories'>;
  nodeLabel: string;
  backLabel?: string;
}) {
  const { draft, port } = props;
  const listing = draft.listing;
  /** The consequence at the moment of the click, in the browser. */
  const browsingBroad = listing ? broadWorkingDirReason(listing.path, listing.separator) : null;
  const cleanFolderName = draft.newFolderName.trim();
  const validFolderName = cleanFolderName.length > 0
    && cleanFolderName !== '.'
    && cleanFolderName !== '..'
    && !/[\\/]/.test(cleanFolderName);

  const useCurrent = () => {
    if (!listing) return;
    if (draft.browserMode === 'destinationParent') draft.setDestinationParent(listing.path);
    else {
      draft.setWorkingDir(listing.path);
      draft.setEnsureWorkingDir(false);
      draft.suggestName(folderBaseName(listing.path));
    }
    draft.setBrowserOpen(false);
  };

  const useNew = () => {
    if (!listing || !validFolderName || draft.browserMode !== 'workingDir') return;
    const seam = listing.path.endsWith(listing.separator) ? '' : listing.separator;
    draft.setWorkingDir(`${listing.path}${seam}${cleanFolderName}`);
    draft.setEnsureWorkingDir(true);
    draft.suggestName(cleanFolderName);
    draft.setBrowserOpen(false);
  };

  return (
    <div className="project-browser">
      <div className="project-browser__head">
        <button type="button" className="project-onboard__button" onClick={() => draft.setBrowserOpen(false)}>
          {props.backLabel ?? '← Form'}
        </button>
        <strong>
          {draft.browserMode === 'destinationParent'
            ? `Choose where the upload lands on ${props.nodeLabel}`
            : `Browse folders on ${props.nodeLabel}`}
        </strong>
      </div>
      {listing ? (
        <>
          <div className="project-browser__roots" aria-label="Allowed roots">
            {listing.roots.map((root) => (
              <button type="button" key={root} onClick={() => void browse(draft, port, root)}>{root}</button>
            ))}
          </div>
          <div className="project-browser__path" title={listing.path}>{listing.path}</div>
          {browsingBroad && draft.browserMode === 'workingDir' ? (
            <p className="project-onboard__warning" role="alert">{broadWorkingDirWarning(browsingBroad)}</p>
          ) : null}
          <div className="project-browser__actions">
            <button type="button" className="project-onboard__button project-onboard__button--primary" onClick={useCurrent}>Use this folder</button>
            {listing.parentPath ? (
              <button type="button" className="project-onboard__button" onClick={() => void browse(draft, port, listing.parentPath!)}>↑ Parent</button>
            ) : null}
          </div>
          <ul className="project-browser__list" aria-label="Folders">
            {listing.directories.map((directory) => (
              <li key={directory.path}>
                <button type="button" onClick={() => void browse(draft, port, directory.path)}>
                  <span aria-hidden="true">▱</span> {directory.name}
                </button>
              </li>
            ))}
            {!draft.browserBusy && listing.directories.length === 0 ? <li className="project-browser__empty">No child folders</li> : null}
          </ul>
          {listing.truncated ? <p className="project-onboard__note">Only the first 500 folders are shown.</p> : null}
          {draft.browserMode === 'workingDir' ? (
            <div className="project-browser__new">
              <label htmlFor="project-new-folder">Create a new folder here</label>
              <div>
                <input
                  id="project-new-folder"
                  value={draft.newFolderName}
                  onChange={(event) => draft.setNewFolderName(event.target.value)}
                  placeholder="folder-name"
                />
                <button type="button" className="project-onboard__button" onClick={useNew} disabled={!validFolderName}>Use new folder</button>
              </div>
              {draft.newFolderName && !validFolderName ? <span role="alert">Use one folder name without slashes.</span> : null}
            </div>
          ) : (
            <p className="project-onboard__note">
              The uploaded folder is created inside the folder you choose here.
            </p>
          )}
        </>
      ) : null}
      {draft.browserBusy ? <p className="project-onboard__note" role="status">Reading folders…</p> : null}
      {draft.browserError ? <p className="project-onboard__error" role="alert">{explainProjectError(draft.browserError)}</p> : null}
    </div>
  );
}

/** Name, source, and trust — the fields of one project, without a frame. */
export function ProjectDraftFields(props: {
  draft: ProjectDraft;
  port: Pick<ProjectAddPort, 'directories' | 'importFolder'>;
  nodeLabel: string;
  /** Called on every edit; the host clears its validation message here. */
  onEdit(): void;
  /** Said under the GitHub URL — where the clone happens next differs per host. */
  githubNote?: string;
}) {
  const { draft, port, onEdit } = props;
  const uploadUnavailable = !port.importFolder;
  const sourceKind = draft.sourceKind;
  /** The same consequence, kept visible on the selection until submit. */
  const selectedBroad = draft.workingDir
    ? broadWorkingDirReason(draft.workingDir, separatorFor(draft, draft.workingDir))
    : null;

  const onPick = (list: FileList | null) => {
    const result = filesFromInput(list);
    draft.setPicked(result.files);
    draft.setRefusedCount(result.refused.length);
    onEdit();
    if (!draft.uploadRootName) {
      const first = result.files[0]?.relativePath ?? '';
      const root = first.includes('/') ? first.split('/')[0]! : '';
      if (root) draft.setUploadRootName(root);
      draft.suggestName(root);
    }
  };

  return (
    <>
      <label>
        <span>Project name</span>
        <input value={draft.name} onChange={(event) => { draft.setName(event.target.value); onEdit(); }} />
      </label>

      <div className="project-onboard__field" role="radiogroup" aria-label="Project source">
        <span>Where do its files come from?</span>
        <label className="project-onboard__radio">
          <input
            type="radio"
            name="project-source"
            checked={sourceKind === 'folder'}
            onChange={() => { draft.setSourceKind('folder'); onEdit(); }}
          />
          <span>A folder already on {props.nodeLabel}</span>
        </label>
        <label className="project-onboard__radio">
          <input
            type="radio"
            name="project-source"
            checked={sourceKind === 'upload'}
            disabled={uploadUnavailable}
            onChange={() => { draft.setSourceKind('upload'); onEdit(); }}
          />
          <span>Upload a folder or files from this computer</span>
        </label>
        <label className="project-onboard__radio">
          <input
            type="radio"
            name="project-source"
            checked={sourceKind === 'github'}
            onChange={() => { draft.setSourceKind('github'); onEdit(); }}
          />
          <span>A GitHub repository</span>
        </label>
        {uploadUnavailable ? <p className="project-onboard__note">{FOLDER_UPLOAD_UNAVAILABLE}</p> : null}
      </div>

      {sourceKind === 'folder' || sourceKind === 'github' ? (
        <div className="project-onboard__field">
          <span>{sourceKind === 'github' ? `Folder for the repository on ${props.nodeLabel}` : `Local folder on ${props.nodeLabel}`}</span>
          <div className="project-onboard__folder-row">
            <code>{draft.workingDir || 'No folder selected'}</code>
            <button type="button" className="project-onboard__button" onClick={() => openBrowser(draft, port, 'workingDir')}>Browse folders</button>
          </div>
          {draft.ensureWorkingDir ? <small>This folder will be created when you submit.</small> : null}
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
              value={draft.repoUrl}
              placeholder="https://github.com/owner/repo"
              onChange={(event) => {
                draft.setRepoUrl(event.target.value);
                onEdit();
                draft.suggestName(repoFolderName(event.target.value));
              }}
            />
          </label>
          <p className="project-onboard__note">
            {props.githubNote ?? 'The repository URL is recorded on the project. Nothing is cloned now — clone it from the project once the Space exists.'}
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
          {draft.picked.length > 0 ? (
            <small>{draft.picked.length} file{draft.picked.length === 1 ? '' : 's'} selected.</small>
          ) : null}
          {draft.refusedCount > 0 ? (
            <p className="project-onboard__error" role="alert">
              {draft.refusedCount} path{draft.refusedCount === 1 ? ' was' : 's were'} refused for an unsafe shape and will not be uploaded.
            </p>
          ) : null}
          <label>
            <span>New folder name on {props.nodeLabel}</span>
            <input value={draft.uploadRootName} onChange={(event) => { draft.setUploadRootName(event.target.value); onEdit(); }} placeholder="folder-name" />
          </label>
          <div className="project-onboard__folder-row">
            <code>{draft.destinationParent || 'No destination chosen'}</code>
            <button type="button" className="project-onboard__button" onClick={() => openBrowser(draft, port, 'destinationParent')}>Choose destination</button>
          </div>
        </div>
      ) : null}

      <label className="project-onboard__trust">
        <input type="checkbox" checked={draft.trusted} onChange={(event) => draft.setTrusted(event.target.checked)} />
        <span>
          <strong>Trust this folder for agent execution</strong>
          <small>Trusted projects allow agents to run with this folder as their working directory.</small>
        </span>
      </label>
    </>
  );
}
