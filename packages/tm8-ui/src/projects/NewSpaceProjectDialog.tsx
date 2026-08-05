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

import './projects.css';

export type OnboardingStage = 'space' | 'project' | 'link' | 'memory';

export interface ProjectOnboardingPort {
  directories(path?: string): Promise<ProjectDirectoryListing>;
  createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult>;
  createProject(input: ProjectCreateInput): Promise<ProjectResource>;
  linkProject(spaceId: SpaceId, input: ProjectLinkInput): Promise<void>;
  createMemory(input: CreateEntityInput): Promise<CommandResult>;
}

export interface ProjectOnboardingInput {
  spaceName: string;
  projectName: string;
  workingDir: string;
  ensureWorkingDir: boolean;
  trusted: boolean;
  /** Private keeps the folder, repo and sessions visible to you alone. */
  keepPrivate: boolean;
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

/** The retry-safe four-command saga, kept separate from rendering for tests. */
export async function onboardSpaceProject(
  port: ProjectOnboardingPort,
  input: ProjectOnboardingInput,
  ids: OnboardingMutationIds,
  onStage?: (stage: OnboardingStage) => void,
): Promise<{ space: SpaceSummary; project: ProjectResource }> {
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
    shareMode: input.keepPrivate ? 'private' : 'space',
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
  return { space: createdSpace.space, project };
}

const STAGE_LABEL: Record<OnboardingStage, string> = {
  space: 'Creating Space',
  project: 'Creating project folder',
  link: 'Connecting project',
  memory: 'Recording memory',
};

export interface NewSpaceProjectDialogProps {
  open: boolean;
  nodeLabel: string;
  port: ProjectOnboardingPort;
  onDismiss(): void;
  onCreated(space: SpaceSummary): void;
}

export function NewSpaceProjectDialog(props: NewSpaceProjectDialogProps) {
  const [spaceName, setSpaceName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [ensureWorkingDir, setEnsureWorkingDir] = useState(false);
  const [trusted, setTrusted] = useState(false);
  // Private by default: publishing someone's working directory because they
  // did not notice a checkbox is not a mistake they can take back.
  const [keepPrivate, setKeepPrivate] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentStage, setCurrentStage] = useState<OnboardingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useRef<OnboardingMutationIds | null>(null);

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
    setBusy(true);
    setError(null);
    try {
      const result = await onboardSpaceProject(props.port, {
        spaceName,
        projectName,
        workingDir,
        ensureWorkingDir,
        trusted,
        keepPrivate,
      }, stableIds, setCurrentStage);
      ids.current = null;
      setCurrentStage(null);
      setSpaceName('');
      setProjectName('');
      setWorkingDir('');
      setEnsureWorkingDir(false);
      setTrusted(false);
      setListing(null);
      setNewFolderName('');
      props.onCreated(result.space);
    } catch (cause) {
      const failed = cause instanceof OnboardingStageError ? cause.stage : currentStage;
      const label = failed ? STAGE_LABEL[failed] : 'Onboarding';
      setError(`${label} failed: ${String((cause as { message?: unknown } | null)?.message ?? cause)} Retry resumes safely with the same mutation ids.`);
    } finally {
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
              <input type="checkbox" checked={keepPrivate} onChange={(event) => setKeepPrivate(event.target.checked)} disabled={busy || lockedForRetry} />
              <span>
                <strong>Keep this project private to me</strong>
                <small>
                  On by default. Other people in the Space cannot see this project, its folder, or the
                  sessions you run in it — Space admins included. Turn it off to share it with everyone
                  in the Space.
                </small>
              </span>
            </label>
            <label className="project-onboard__trust">
              <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} disabled={busy || lockedForRetry} />
              <span>
                <strong>Trust this folder for agent execution</strong>
                <small>Off by default. Trusted projects allow agents to run with this folder as their working directory.</small>
              </span>
            </label>
            {lockedForRetry ? <p className="project-onboard__note">Values are locked so Retry replays the same safe saga.</p> : null}
            {error ? <p className="project-onboard__error" role="alert">{error}</p> : null}
            <footer className="project-onboard__footer">
              <button type="button" className="project-onboard__button" onClick={props.onDismiss} disabled={busy}>Cancel</button>
              <button
                type="submit"
                className="project-onboard__button project-onboard__button--primary"
                disabled={busy || !spaceName.trim() || !projectName.trim() || !workingDir}
              >
                {busy && currentStage ? `${STAGE_LABEL[currentStage]}…` : lockedForRetry ? 'Retry' : 'Create Space & add project'}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
