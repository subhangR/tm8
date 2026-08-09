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
  SpaceId,
  SpaceSummary,
} from '@tm8/contract';

import {
  SPACE_FOLDER_PACKER_UNAVAILABLE_REASON,
  type ZipPacker,
} from '../space-folder/archive';
import {
  SPACE_FOLDER_ROOT_DEST,
  SPACE_FOLDER_UNAVAILABLE_REASON,
  type SpaceFolderSkipped,
  type SpaceFolderSummary,
  type SpaceFoldersPort,
} from '../space-folder/port';
import {
  SpaceFolderStep,
  type SpaceFolderOutcome,
  type SpaceFolderProgress,
  type SpaceFolderSelection,
} from '../space-folder/SpaceFolderStep';

import './projects.css';

export type OnboardingStage =
  | 'space' | 'project' | 'link' | 'memory'
  | 'pack' | 'folder' | 'upload';

export interface ProjectOnboardingPort {
  directories(path?: string): Promise<ProjectDirectoryListing>;
  createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult>;
  createProject(input: ProjectCreateInput): Promise<ProjectResource>;
  linkProject(spaceId: SpaceId, input: ProjectLinkInput): Promise<void>;
  createMemory(input: CreateEntityInput): Promise<CommandResult>;
  /**
   * Lane B's Space-folder storage. Optional for the same reason `projectSetup`
   * is: a node that does not offer it must leave the step disabled-with-reason
   * rather than offer an upload that cannot happen.
   */
  spaceFolders?: SpaceFoldersPort;
}

export interface ProjectOnboardingInput {
  spaceName: string;
  projectName: string;
  workingDir: string;
  ensureWorkingDir: boolean;
  trusted: boolean;
  /** Absent, or null, when the optional folder step was skipped. */
  folder?: SpaceFolderSelection | null;
}

export interface OnboardingFolderOutcome {
  readonly folder: SpaceFolderSummary;
  readonly added: number;
  readonly replaced: number;
  readonly directories: number;
  /** Client-side refusals and server-side skips, merged, never swallowed. */
  readonly skipped: readonly SpaceFolderSkipped[];
}

export interface OnboardingHooks {
  signal?: AbortSignal;
  /** Lane C's store-only ZIP encoder. Absent means the step cannot run. */
  packArchive?: ZipPacker;
  onPack?(packedMembers: number, totalMembers: number): void;
  onSend?(sentBytes: number, totalBytes: number): void;
  /**
   * A Space folder created by an EARLIER attempt. `spaceFolders.create` takes no
   * client mutation id, so it is not idempotent: replaying it after a failed
   * upload would create a second folder with the same name. The caller retains
   * what was created and hands it back, and `create` is then skipped.
   */
  retainedFolder?: SpaceFolderSummary | null;
  onFolderCreated?(folder: SpaceFolderSummary): void;
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

/**
 * The retry-safe saga, kept separate from rendering for tests.
 *
 * FOUR stages when no folder was picked — unchanged, byte for byte, from before
 * this lane. SIX when one was: the folder is created and uploaded LAST, after
 * the Space is complete and durable.
 *
 * That ordering is forced by a measurement, not a preference. There is NO
 * `spaces.delete` operation in the catalog at all (packages/contract/src/
 * catalog.ts exposes spaces.list/create/get/update/… and no delete), so
 * "roll back the Space" is not a thing this client can do. Uploading first, or
 * in the middle, would therefore be the one sequence that CAN strand a user:
 * a Space they can neither see finished nor remove. Uploading last means the
 * worst outcome is a complete, visible, usable Space whose folder is empty or
 * partial, said out loud, with Retry replaying the same locked mutation ids.
 */
export async function onboardSpaceProject(
  port: ProjectOnboardingPort,
  input: ProjectOnboardingInput,
  ids: OnboardingMutationIds,
  onStage?: (stage: OnboardingStage) => void,
  hooks?: OnboardingHooks,
): Promise<{ space: SpaceSummary; project: ProjectResource; folder?: OnboardingFolderOutcome }> {
  const createdSpace = await stage('space', onStage, () => port.createSpace({
    name: input.spaceName.trim(),
    visibility: 'private',
    clientMutationId: ids.space,
  }));
  const project = await stage('project', onStage, () => port.createProject({
    name: input.projectName.trim(),
    workingDir: input.workingDir,
    ensureWorkingDir: input.ensureWorkingDir,
    trust: input.trusted ? 'trusted' : 'untrusted',
    clientMutationId: ids.project,
  }));
  await stage('link', onStage, () => port.linkProject(createdSpace.space.id, {
    projectId: project.id,
    clientMutationId: ids.link,
  }));
  await stage('memory', onStage, () => port.createMemory({
    clientMutationId: ids.memory,
    spaceId: createdSpace.space.id,
    kind: 'memory',
    title: `Project folder: ${project.name}`,
    content: {
      statement: `Space “${createdSpace.space.name}” uses project “${project.name}” at node-local folder “${project.workingDir}”.`,
      mechanism: 'Recorded by Space project onboarding after projects.create and projects.link succeeded.',
      subjectScope: `Space ${createdSpace.space.id}; project ${project.id}; working directory ${project.workingDir}`,
      doesNotEstablish: 'This records the configured working directory; it does not establish file synchronization, Git status, or commit state.',
      measuredAt: ids.measuredAt,
    },
  }));

  const selection = input.folder;
  const folders = port.spaceFolders;
  const pack = hooks?.packArchive;
  if (!selection || !folders || !pack) {
    return { space: createdSpace.space, project };
  }

  // PACK FIRST, CREATE SECOND. Packing is client-side and is the stage a user
  // is most likely to cancel; doing it before `create` means a cancelled or
  // failed pack leaves no empty folder sitting on the server at all.
  const archive = await stage('pack', onStage, () => pack(
    { files: selection.files, directories: selection.directories },
    { signal: hooks?.signal, onProgress: hooks?.onPack },
  ));

  // `spaceFolders.create` carries no client mutation id, so it is NOT
  // idempotent. A retry after a failed upload must reuse the folder the first
  // attempt made, or the user gets two folders with one name.
  let created = hooks?.retainedFolder ?? null;
  if (!created) {
    created = await stage('folder', onStage, () => folders.create(
      createdSpace.space.id,
      selection.name.trim(),
    ));
    hooks?.onFolderCreated?.(created);
  }
  const folderRef = created;

  const folder = await stage('upload', onStage, async () => {
    const result = await folders.upload(folderRef.id, SPACE_FOLDER_ROOT_DEST, archive.blob, {
      signal: hooks?.signal,
      onProgress: hooks?.onSend,
    });
    return {
      folder: result.folder,
      added: result.added,
      replaced: result.replaced,
      directories: result.directories,
      // The packer's refusals and the server's skips are DIFFERENT facts about
      // the same upload. Reporting only one of them would let a file vanish
      // between two lanes that each believe the other surfaced it.
      skipped: [...archive.skipped, ...result.skipped],
    } satisfies OnboardingFolderOutcome;
  });
  return { space: createdSpace.space, project, folder };
}

const STAGE_LABEL: Record<OnboardingStage, string> = {
  space: 'Creating Space',
  project: 'Creating project folder',
  link: 'Connecting project',
  memory: 'Recording memory',
  pack: 'Packaging folder',
  folder: 'Creating Space folder',
  upload: 'Uploading folder',
};

/**
 * What is already real when a stage fails. A folder-stage failure is NOT a
 * failed Space, and saying only "Uploading folder failed" would leave a user
 * believing nothing was created — then starting again, with no `spaces.delete`
 * on the wire to undo the first one.
 */
function alreadyMade(failed: OnboardingStage | null, folderName: string): string {
  switch (failed) {
    case 'pack':
      return ' The Space and its project were created and are ready. Nothing was sent and no Space folder was created.';
    case 'folder':
      return ' The Space and its project were created and are ready. The Space folder was not created, so nothing was uploaded.';
    case 'upload':
      return ` The Space and its project were created and are ready. The Space folder “${folderName}” EXISTS and is empty or partial until you retry.`;
    default:
      return '';
  }
}

export interface NewSpaceProjectDialogProps {
  open: boolean;
  nodeLabel: string;
  port: ProjectOnboardingPort;
  /**
   * Lane C's store-only ZIP encoder. Absent until that commit lands, and the
   * optional folder step then renders disabled-with-reason — this lane does not
   * ship a second encoder for the same format.
   */
  packArchive?: ZipPacker;
  onDismiss(): void;
  onCreated(space: SpaceSummary): void;
}

export function NewSpaceProjectDialog(props: NewSpaceProjectDialogProps) {
  const [spaceName, setSpaceName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [ensureWorkingDir, setEnsureWorkingDir] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentStage, setCurrentStage] = useState<OnboardingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderSelection, setFolderSelection] = useState<SpaceFolderSelection | null>(null);
  const [folderProgress, setFolderProgress] = useState<SpaceFolderProgress | null>(null);
  const [folderOutcome, setFolderOutcome] = useState<SpaceFolderOutcome | null>(null);
  // Set only when the saga SUCCEEDED but something did not arrive. The dialog
  // then stays open: closing it would be the moment the skipped files are lost.
  const [settled, setSettled] = useState<SpaceSummary | null>(null);
  const ids = useRef<OnboardingMutationIds | null>(null);
  const abort = useRef<AbortController | null>(null);
  // `spaceFolders.create` has no client mutation id and is therefore not
  // idempotent. Retaining what a failed attempt already created is the only way
  // Retry avoids making a second folder with the same name.
  const createdFolder = useRef<SpaceFolderSummary | null>(null);

  const lockedForRetry = ids.current !== null && !busy;

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

  const useCurrent = () => {
    if (!listing) return;
    setWorkingDir(listing.path);
    setEnsureWorkingDir(false);
    setBrowserOpen(false);
  };

  const cleanFolderName = newFolderName.trim();
  const validFolderName = cleanFolderName.length > 0
    && cleanFolderName !== '.'
    && cleanFolderName !== '..'
    && !/[\\/]/.test(cleanFolderName);
  const useNew = () => {
    if (!listing || !validFolderName) return;
    const seam = listing.path.endsWith(listing.separator) ? '' : listing.separator;
    setWorkingDir(`${listing.path}${seam}${cleanFolderName}`);
    setEnsureWorkingDir(true);
    setBrowserOpen(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceName.trim() || !projectName.trim() || !workingDir) return;
    const stableIds = ids.current ?? newOnboardingMutationIds();
    ids.current = stableIds;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setFolderOutcome(null);
    setFolderProgress(folderSelection ? {
      phase: 'packing',
      packedFiles: 0,
      totalFiles: folderSelection.files.length,
      sentBytes: 0,
      totalBytes: folderSelection.files.reduce((sum, file) => sum + file.size, 0),
    } : null);
    try {
      const result = await onboardSpaceProject(props.port, {
        spaceName,
        projectName,
        workingDir,
        ensureWorkingDir,
        trusted,
        folder: folderSelection,
      }, stableIds, setCurrentStage, {
        signal: controller.signal,
        packArchive: props.packArchive,
        retainedFolder: createdFolder.current,
        onFolderCreated: (folder) => { createdFolder.current = folder; },
        onPack: (packedFiles, totalFiles) => setFolderProgress((previous) => ({
          phase: 'packing',
          packedFiles,
          totalFiles,
          sentBytes: 0,
          totalBytes: previous?.totalBytes ?? 0,
        })),
        onSend: (sentBytes, totalBytes) => setFolderProgress((previous) => ({
          phase: 'sending',
          packedFiles: previous?.packedFiles ?? 0,
          totalFiles: previous?.totalFiles ?? 0,
          sentBytes,
          totalBytes,
        })),
      });
      ids.current = null;
      createdFolder.current = null;
      setCurrentStage(null);
      setFolderProgress(null);

      if (result.folder && result.folder.skipped.length > 0) {
        // Hold the dialog open. `onCreated` navigates into the new Space, and a
        // list of files that never arrived is not something to flash past.
        setFolderOutcome({
          name: result.folder.folder.name,
          added: result.folder.added,
          replaced: result.folder.replaced,
          directories: result.folder.directories,
          entryCount: result.folder.folder.entryCount,
          totalSizeBytes: result.folder.folder.totalSizeBytes,
          skipped: result.folder.skipped,
        });
        setSettled(result.space);
        return;
      }

      setSpaceName('');
      setProjectName('');
      setWorkingDir('');
      setEnsureWorkingDir(false);
      setTrusted(false);
      setListing(null);
      setNewFolderName('');
      setFolderSelection(null);
      props.onCreated(result.space);
    } catch (cause) {
      const failed = cause instanceof OnboardingStageError ? cause.stage : currentStage;
      const label = failed ? STAGE_LABEL[failed] : 'Onboarding';
      setFolderProgress(null);
      const made = alreadyMade(failed, createdFolder.current?.name ?? folderSelection?.name ?? '');
      setError(`${label} failed: ${String((cause as { message?: unknown } | null)?.message ?? cause)}${made} Retry resumes safely with the same mutation ids.`);
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="project-onboard__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) props.onDismiss();
    }}>
      <section className="project-onboard" role="dialog" aria-modal="true" aria-labelledby="project-onboard-title">
        <header className="project-onboard__header">
          <div>
            <div className="project-onboard__eyebrow">NEW SPACE · {props.nodeLabel}</div>
            <h2 id="project-onboard-title">Add a local project</h2>
          </div>
          <button type="button" className="project-onboard__close" onClick={props.onDismiss} disabled={busy} aria-label="Close">×</button>
        </header>

        {browserOpen ? (
          <div className="project-browser">
            <div className="project-browser__head">
              <button type="button" className="project-onboard__button" onClick={() => setBrowserOpen(false)}>← Form</button>
              <strong>Browse folders on {props.nodeLabel}</strong>
            </div>
            {listing ? (
              <>
                <div className="project-browser__roots" aria-label="Allowed roots">
                  {listing.roots.map((root) => (
                    <button type="button" key={root} onClick={() => void browse(root)}>{root}</button>
                  ))}
                </div>
                <div className="project-browser__path" title={listing.path}>{listing.path}</div>
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
              </>
            ) : null}
            {browserBusy ? <p className="project-onboard__note" role="status">Reading folders…</p> : null}
            {browserError ? <p className="project-onboard__error" role="alert">{browserError}</p> : null}
          </div>
        ) : (
          <form className="project-onboard__form" onSubmit={submit}>
            <label>
              <span>Space name</span>
              <input value={spaceName} onChange={(event) => setSpaceName(event.target.value)} disabled={busy || lockedForRetry} autoFocus />
            </label>
            <label>
              <span>Project name</span>
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} disabled={busy || lockedForRetry} />
            </label>
            <div className="project-onboard__field">
              <span>Local folder on {props.nodeLabel}</span>
              <div className="project-onboard__folder-row">
                <code>{workingDir || 'No folder selected'}</code>
                <button type="button" className="project-onboard__button" onClick={() => void browse()} disabled={busy || lockedForRetry}>Browse folders</button>
              </div>
              {ensureWorkingDir ? <small>This folder will be created when you submit.</small> : null}
            </div>
            <label className="project-onboard__trust">
              <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} disabled={busy || lockedForRetry} />
              <span>
                <strong>Trust this folder for agent execution</strong>
                <small>Off by default. Trusted projects allow agents to run with this folder as their working directory.</small>
              </span>
            </label>
            <SpaceFolderStep
              unavailableReason={
                !props.port.spaceFolders
                  ? SPACE_FOLDER_UNAVAILABLE_REASON
                  : !props.packArchive ? SPACE_FOLDER_PACKER_UNAVAILABLE_REASON : null
              }
              disabled={busy || lockedForRetry || settled !== null}
              onChange={setFolderSelection}
              progress={folderProgress}
              outcome={folderOutcome}
              onCancel={() => abort.current?.abort(new Error('Upload cancelled.'))}
            />
            {lockedForRetry ? <p className="project-onboard__note">Values are locked so Retry replays the same safe saga.</p> : null}
            {error ? <p className="project-onboard__error" role="alert">{error}</p> : null}
            <footer className="project-onboard__footer">
              {settled ? (
                <button
                  type="button"
                  className="project-onboard__button project-onboard__button--primary"
                  onClick={() => props.onCreated(settled)}
                >
                  Open the Space
                </button>
              ) : (
                <>
                  <button type="button" className="project-onboard__button" onClick={props.onDismiss} disabled={busy}>Cancel</button>
                  <button
                    type="submit"
                    className="project-onboard__button project-onboard__button--primary"
                    disabled={busy || !spaceName.trim() || !projectName.trim() || !workingDir}
                  >
                    {busy && currentStage ? `${STAGE_LABEL[currentStage]}…` : lockedForRetry ? 'Retry' : 'Create Space & add project'}
                  </button>
                </>
              )}
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
