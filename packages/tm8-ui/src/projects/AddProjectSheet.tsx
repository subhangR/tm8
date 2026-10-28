import { useEffect, useRef, useState } from 'react';
import { projectHomeDisplayPath } from '@tm8/contract';
import type {
  ProjectCloneInput,
  ProjectCloneJob,
  ProjectDirectoryListing,
  ProjectResource,
  SpaceId,
  SpaceProject,
  SpaceProjectCreateInput,
} from '@tm8/contract';

import type { Seam } from '../data/seam';
import { startFolderImport } from '../files-explorer/folder-import';
import type { PickedFile } from '../files-explorer/picker';
import type { FolderImportHandle } from './NewSpaceProjectDialog';
import { FOLDER_UPLOAD_UNAVAILABLE, isGithubUrl } from './NewSpaceProjectDialog';
import { ProjectFolderBrowser, ProjectSourceFields, useProjectSourceDraft } from './project-source';

import './projects.css';

/**
 * ADD PROJECT — the Projects list's birth sheet (task 01a13574).
 *
 * Three sources, the same parts new-space onboarding uses (`project-source`):
 *   - a FOLDER on the node: `spaces.projects.create` with `workingDir`, which
 *     registers it, grants it to this space and names the project in one step;
 *   - an UPLOADED folder: the folder-upload lifecycle the Files explorer runs;
 *   - a GITHUB repository: `spaces.projects.clone`, a JOB — the node clones in
 *     the background and this sheet reads the job until it lands, so a large
 *     repository never meets an HTTP deadline.
 *
 * Who may add is the node's answer, not this sheet's: a space admin, inside
 * the node's allowed project roots (a node admin anywhere). A refusal is shown
 * here verbatim, with the form intact, so the remedy has something to apply to.
 */

export interface AddProjectPort {
  directories(path?: string): Promise<ProjectDirectoryListing>;
  add(input: SpaceProjectCreateInput): Promise<SpaceProject>;
  clone(input: ProjectCloneInput): Promise<ProjectCloneJob>;
  cloneJob(jobId: string): Promise<ProjectCloneJob>;
  /** Absent when this node does not serve the folder-upload operations. */
  importFolder?(input: {
    projectName: string;
    destinationParent: string;
    rootName: string;
    files: readonly PickedFile[];
  }): FolderImportHandle;
}

/** The port over a seam for one space, or null when the node cannot add projects here. */
export function addProjectPort(seam: Pick<Seam, 'spaceProjects' | 'projectFolderUploads' | 'files'>, spaceId: SpaceId | null | undefined): AddProjectPort | null {
  const projects = seam.spaceProjects;
  if (!projects || !spaceId) return null;
  const folderUploads = seam.projectFolderUploads;
  const directories = (path?: string) => projects.directories(spaceId, path);
  return {
    directories,
    add: (input) => projects.add(spaceId, input),
    clone: (input) => projects.clone(spaceId, input),
    cloneJob: (jobId) => projects.cloneJob(spaceId, jobId),
    ...(folderUploads
      ? {
          importFolder: (input) => {
            // The SAME saga the Files explorer and onboarding run.
            const task = startFolderImport(
              {
                folderUploads,
                putBytes: (grant, bytes) => seam.files.putBytes(grant, bytes),
                directories,
                spaceId,
                projectName: input.projectName,
                destinationParent: input.destinationParent,
                trust: 'untrusted',
              },
              [...input.files],
              input.rootName,
            );
            return { result: task.result.then((outcome) => outcome.project as ProjectResource), cancel: task.cancel };
          },
        }
      : {}),
  };
}

/** How often the sheet reads a running clone job. */
export const CLONE_POLL_MS = 1_500;

const CLONE_STATUS_LABEL: Record<ProjectCloneJob['status'], string> = {
  queued: 'Waiting for a clone slot…',
  cloning: 'Cloning…',
  registering: 'Adding the project…',
  succeeded: 'Added',
  failed: 'Clone failed',
};

function messageOf(cause: unknown): string {
  return String((cause as { message?: unknown } | null)?.message ?? cause);
}

export interface AddProjectSheetProps {
  nodeLabel: string;
  port: AddProjectPort;
  /** The space's new project entity, once it exists. */
  onAdded(projectEntityId: string | null): void;
  onCancel(): void;
  /** Injected in tests. */
  pollMs?: number;
}

export function AddProjectSheet(props: AddProjectSheetProps) {
  const [projectName, setProjectName] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<ProjectCloneJob | null>(null);
  const cancelUpload = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const draft = useProjectSourceDraft({
    directories: (path) => props.port.directories(path),
    onSuggestName: (name) => { if (!projectName) setProjectName(name); },
    onEdit: () => setValidation(null),
  });

  useEffect(() => () => { alive.current = false; }, []);

  const validate = (): string | null => {
    if (!projectName.trim()) return 'Give the project a name.';
    // An empty folder is the home default, `~/<name>`; the name must give one.
    if (draft.sourceKind === 'folder') {
      return draft.workingDir.trim() || projectHomeDisplayPath(projectName)
        ? null
        : 'Use letters or digits in the name, or choose the folder this project lives in.';
    }
    if (draft.sourceKind === 'github') {
      if (!isGithubUrl(draft.repoUrl) && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(draft.repoUrl.trim())) {
        return 'Enter a GitHub repository, like https://github.com/owner/repo.';
      }
    } else if (draft.picked.length === 0) {
      return 'Choose a folder or files to upload.';
    }
    if (!draft.destinationParent) return 'Choose where on the node the new folder should go.';
    if (!draft.rootName.trim()) return 'Name the new folder.';
    return null;
  };

  /* A clone job is read until it lands. One timer at a time; a closed sheet
     stops reading (the job keeps running on the node either way). */
  const follow = async (started: ProjectCloneJob) => {
    let current = started;
    setJob(current);
    while (alive.current && (current.status === 'queued' || current.status === 'cloning' || current.status === 'registering')) {
      await new Promise((resolve) => setTimeout(resolve, props.pollMs ?? CLONE_POLL_MS));
      if (!alive.current) return;
      try {
        current = await props.port.cloneJob(started.id);
      } catch (cause) {
        setError(`Could not read the clone’s progress: ${messageOf(cause)}`);
        setBusy(false);
        return;
      }
      setJob(current);
    }
    if (!alive.current) return;
    setBusy(false);
    if (current.status === 'succeeded') props.onAdded(current.project?.id ?? null);
    else setError(current.error ? current.error.message : 'The clone failed.');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const invalid = validate();
    if (invalid) {
      setValidation(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    setJob(null);
    const name = projectName.trim();
    try {
      if (draft.sourceKind === 'folder') {
        const workingDir = draft.workingDir.trim();
        const project = await props.port.add({
          name,
          ...(workingDir ? { workingDir } : {}),
          ...(workingDir && draft.ensureWorkingDir ? { ensureWorkingDir: true } : {}),
          clientMutationId: `add-project:${crypto.randomUUID()}`,
        });
        setBusy(false);
        props.onAdded(project.id);
        return;
      }
      if (draft.sourceKind === 'upload') {
        const importFolder = props.port.importFolder;
        if (!importFolder) throw new Error(FOLDER_UPLOAD_UNAVAILABLE);
        const task = importFolder({
          projectName: name,
          destinationParent: draft.destinationParent,
          rootName: draft.rootName.trim(),
          files: draft.picked,
        });
        cancelUpload.current = task.cancel;
        try {
          const project = await task.result;
          setBusy(false);
          props.onAdded(project.projectEntityId ?? null);
        } finally {
          cancelUpload.current = null;
        }
        return;
      }
      const started = await props.port.clone({
        repoUrl: draft.repoUrl.trim(),
        destinationParent: draft.destinationParent,
        directoryName: draft.rootName.trim(),
        name,
        clientMutationId: `clone-project:${crypto.randomUUID()}`,
      });
      await follow(started);
    } catch (cause) {
      // The sheet STAYS OPEN with every value intact.
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  const running = job !== null && busy;

  return (
    <section className="project-onboard project-onboard--sheet" aria-labelledby="add-project-title">
      <header className="project-onboard__header">
        <div>
          <div className="project-onboard__eyebrow">ADD PROJECT · {props.nodeLabel}</div>
          <h2 id="add-project-title">Add project</h2>
        </div>
        <button type="button" className="project-onboard__close" onClick={props.onCancel} disabled={busy && !running} aria-label="Close">×</button>
      </header>
      {draft.browser.open ? (
        <ProjectFolderBrowser draft={draft} nodeLabel={props.nodeLabel} />
      ) : (
        <form className="project-onboard__form" onSubmit={submit}>
          <fieldset className="project-onboard__section" disabled={busy}>
            <label>
              <span>Project name</span>
              <input value={projectName} onChange={(event) => { setProjectName(event.target.value); setValidation(null); }} autoFocus />
            </label>
            <ProjectSourceFields
              draft={draft}
              nodeLabel={props.nodeLabel}
              githubMode="clone"
              uploadUnavailableReason={props.port.importFolder ? null : FOLDER_UPLOAD_UNAVAILABLE}
              defaultWorkingDir={projectHomeDisplayPath(projectName)}
            />
            <p className="project-onboard__note">
              The project is added untrusted: agents ask for confirmation before running in it until a node admin
              trusts it. A node admin can change its folder or trust it later from the project’s page.
            </p>
          </fieldset>
          {job ? (
            <p className="project-onboard__note" role="status">
              {CLONE_STATUS_LABEL[job.status]}
              {job.credentialSource && job.credentialSource !== 'none' ? ` (using the ${job.credentialSource} GitHub credential)` : ''}
            </p>
          ) : null}
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
            >
              {running ? 'Close (the clone keeps running)' : busy && draft.sourceKind === 'upload' ? 'Cancel upload' : 'Cancel'}
            </button>
            <button type="submit" className="project-onboard__button project-onboard__button--primary" disabled={busy}>
              {busy ? (job ? CLONE_STATUS_LABEL[job.status] : 'Adding…') : error ? 'Retry' : draft.sourceKind === 'github' ? 'Clone & add' : 'Add project'}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
