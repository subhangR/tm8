import { useState } from 'react';
import type { ProjectDirectoryListing } from '@tm8/contract';

import type { PickedFile } from '../files-explorer/picker';
import { filesFromInput } from '../files-explorer/picker';
import { broadWorkingDirReason, broadWorkingDirWarning } from './working-dir-risk';

/**
 * THE PROJECT-SOURCE PARTS, SHARED (task 01a13574).
 *
 * The folder browser, the three source radios and their per-source fields were
 * born inside `NewSpaceProjectDialog`. The Projects list's Add project sheet
 * needs exactly the same parts, so they live here and both surfaces compose
 * them — one browser, one upload picker, one GitHub field — rather than two
 * copies that drift.
 *
 * The draft hook holds the state; the two components only render it. The
 * GitHub source differs per surface and says so through `githubMode`:
 *   - `record` (new-space onboarding): the URL is recorded on a folder the
 *     viewer picks; nothing is cloned.
 *   - `clone` (Add project): the node clones the repository into a NEW folder
 *     beneath a destination the viewer picks.
 */

export type SourceKind = 'folder' | 'upload' | 'github';
export type GithubMode = 'record' | 'clone';
export type BrowserMode = 'workingDir' | 'destinationParent';

export interface ProjectSourceDraft {
  sourceKind: SourceKind;
  setSourceKind(kind: SourceKind): void;
  workingDir: string;
  /** A typed path: used as is (a leading `~/` is the node's home), never created. */
  setWorkingDir(value: string): void;
  ensureWorkingDir: boolean;
  repoUrl: string;
  setRepoUrl(value: string): void;
  picked: PickedFile[];
  refusedCount: number;
  destinationParent: string;
  /** The ONE new folder an upload or a clone creates beneath `destinationParent`. */
  rootName: string;
  setRootName(value: string): void;
  browser: {
    open: boolean;
    mode: BrowserMode;
    listing: ProjectDirectoryListing | null;
    busy: boolean;
    error: string | null;
    newFolderName: string;
  };
  setNewFolderName(value: string): void;
  closeBrowser(): void;
  openBrowser(mode: BrowserMode): void;
  browse(path?: string): Promise<void>;
  useCurrent(): void;
  useNew(): void;
  onPick(list: FileList | null): void;
  reset(): void;
}

/** `https://github.com/owner/repo(.git)` → `repo`; '' when unreadable. */
export function repoFolderName(raw: string): string {
  const value = raw.trim().replace(/\.git$/, '');
  const tail = value.split(/[/:]/).filter(Boolean).pop() ?? '';
  return /^[^\\/]+$/.test(tail) && tail !== '.' && tail !== '..' ? tail : '';
}

export function useProjectSourceDraft(options: {
  directories(path?: string): Promise<ProjectDirectoryListing>;
  /** A name the picked files or the repository suggest; the host decides whether to take it. */
  onSuggestName?(name: string): void;
  /** Any edit clears the host's validation message. */
  onEdit?(): void;
}): ProjectSourceDraft {
  const [sourceKind, setSourceKindState] = useState<SourceKind>('folder');
  const [workingDir, setWorkingDir] = useState('');
  const [ensureWorkingDir, setEnsureWorkingDir] = useState(false);
  const [repoUrl, setRepoUrlState] = useState('');
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [refusedCount, setRefusedCount] = useState(0);
  const [destinationParent, setDestinationParent] = useState('');
  const [rootName, setRootNameState] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserMode, setBrowserMode] = useState<BrowserMode>('workingDir');
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  const edited = () => options.onEdit?.();

  const browse = async (path?: string) => {
    setBrowserOpen(true);
    setBrowserBusy(true);
    setBrowserError(null);
    try {
      setListing(await options.directories(path));
    } catch (cause) {
      setBrowserError(String((cause as { message?: unknown } | null)?.message ?? cause));
    } finally {
      setBrowserBusy(false);
    }
  };

  const cleanFolderName = newFolderName.trim();
  const validFolderName = cleanFolderName.length > 0
    && cleanFolderName !== '.'
    && cleanFolderName !== '..'
    && !/[\\/]/.test(cleanFolderName);

  return {
    sourceKind,
    setSourceKind: (kind) => { setSourceKindState(kind); edited(); },
    workingDir,
    setWorkingDir: (value) => {
      setWorkingDir(value);
      setEnsureWorkingDir(false);
      edited();
    },
    ensureWorkingDir,
    repoUrl,
    setRepoUrl: (value) => {
      setRepoUrlState(value);
      edited();
      const suggested = repoFolderName(value);
      if (suggested) {
        options.onSuggestName?.(suggested);
        if (!rootName) setRootNameState(suggested);
      }
    },
    picked,
    refusedCount,
    destinationParent,
    rootName,
    setRootName: (value) => { setRootNameState(value); edited(); },
    browser: { open: browserOpen, mode: browserMode, listing, busy: browserBusy, error: browserError, newFolderName },
    setNewFolderName,
    closeBrowser: () => setBrowserOpen(false),
    openBrowser: (mode) => {
      setBrowserMode(mode);
      void browse();
    },
    browse,
    useCurrent: () => {
      if (!listing) return;
      if (browserMode === 'destinationParent') setDestinationParent(listing.path);
      else {
        setWorkingDir(listing.path);
        setEnsureWorkingDir(false);
      }
      setBrowserOpen(false);
      edited();
    },
    useNew: () => {
      if (!listing || !validFolderName || browserMode !== 'workingDir') return;
      const seam = listing.path.endsWith(listing.separator) ? '' : listing.separator;
      setWorkingDir(`${listing.path}${seam}${cleanFolderName}`);
      setEnsureWorkingDir(true);
      setBrowserOpen(false);
      edited();
    },
    onPick: (list) => {
      const result = filesFromInput(list);
      setPicked(result.files);
      setRefusedCount(result.refused.length);
      edited();
      if (!rootName) {
        const first = result.files[0]?.relativePath ?? '';
        const root = first.includes('/') ? first.split('/')[0]! : '';
        if (root) {
          setRootNameState(root);
          options.onSuggestName?.(root);
        }
      }
    },
    reset: () => {
      setSourceKindState('folder');
      setWorkingDir('');
      setEnsureWorkingDir(false);
      setRepoUrlState('');
      setPicked([]);
      setRefusedCount(0);
      setDestinationParent('');
      setRootNameState('');
      setListing(null);
      setNewFolderName('');
    },
  };
}

/** The node folder browser. Rendered by the host IN PLACE of its form while open. */
export function ProjectFolderBrowser(props: {
  draft: ProjectSourceDraft;
  nodeLabel: string;
  /** False where the caller cannot create a folder (changing an existing project's path). */
  allowNewFolder?: boolean;
}) {
  const { draft, nodeLabel } = props;
  const allowNewFolder = props.allowNewFolder ?? true;
  const { listing, mode, busy, error, newFolderName } = draft.browser;
  const browsingBroad = listing ? broadWorkingDirReason(listing.path, listing.separator) : null;
  const cleanFolderName = newFolderName.trim();
  const validFolderName = cleanFolderName.length > 0
    && cleanFolderName !== '.'
    && cleanFolderName !== '..'
    && !/[\\/]/.test(cleanFolderName);
  return (
    <div className="project-browser">
      <div className="project-browser__head">
        <button type="button" className="project-onboard__button" onClick={draft.closeBrowser}>← Form</button>
        <strong>
          {mode === 'destinationParent'
            ? `Choose where the folder lands on ${nodeLabel}`
            : `Browse folders on ${nodeLabel}`}
        </strong>
      </div>
      {listing ? (
        <>
          <div className="project-browser__roots" aria-label="Allowed roots">
            {listing.roots.map((root) => (
              <button type="button" key={root} onClick={() => void draft.browse(root)}>{root}</button>
            ))}
          </div>
          <div className="project-browser__path" title={listing.path}>{listing.path}</div>
          {browsingBroad && mode === 'workingDir' ? (
            <p className="project-onboard__warning" role="alert">{broadWorkingDirWarning(browsingBroad)}</p>
          ) : null}
          <div className="project-browser__actions">
            <button type="button" className="project-onboard__button project-onboard__button--primary" onClick={draft.useCurrent}>Use this folder</button>
            {listing.parentPath ? (
              <button type="button" className="project-onboard__button" onClick={() => void draft.browse(listing.parentPath!)}>↑ Parent</button>
            ) : null}
          </div>
          <ul className="project-browser__list" aria-label="Folders">
            {listing.directories.map((directory) => (
              <li key={directory.path}>
                <button type="button" onClick={() => void draft.browse(directory.path)}>
                  <span aria-hidden="true">▱</span> {directory.name}
                </button>
              </li>
            ))}
            {!busy && listing.directories.length === 0 ? <li className="project-browser__empty">No child folders</li> : null}
          </ul>
          {listing.truncated ? <p className="project-onboard__note">Only the first 500 folders are shown.</p> : null}
          {mode === 'workingDir' && !allowNewFolder ? null : mode === 'workingDir' ? (
            <div className="project-browser__new">
              <label htmlFor="project-new-folder">Create a new folder here</label>
              <div>
                <input
                  id="project-new-folder"
                  value={newFolderName}
                  onChange={(event) => draft.setNewFolderName(event.target.value)}
                  placeholder="folder-name"
                />
                <button type="button" className="project-onboard__button" onClick={draft.useNew} disabled={!validFolderName}>Use new folder</button>
              </div>
              {newFolderName && !validFolderName ? <span role="alert">Use one folder name without slashes.</span> : null}
            </div>
          ) : (
            <p className="project-onboard__note">
              The new folder is created inside the folder you choose here.
            </p>
          )}
        </>
      ) : null}
      {busy ? <p className="project-onboard__note" role="status">Reading folders…</p> : null}
      {error ? <p className="project-onboard__error" role="alert">{error}</p> : null}
    </div>
  );
}

/** The source radios and each source's fields. */
export function ProjectSourceFields(props: {
  draft: ProjectSourceDraft;
  nodeLabel: string;
  githubMode: GithubMode;
  /** Set when the node does not serve folder uploads; the radio is disabled with this reason. */
  uploadUnavailableReason?: string | null;
  /**
   * The folder a project with NO working directory gets (`~/<name>`, Add
   * project only). Set, the field may be left empty and says what happens;
   * absent, a folder is required.
   */
  defaultWorkingDir?: string | null;
}) {
  const { draft, nodeLabel, githubMode } = props;
  const uploadUnavailable = Boolean(props.uploadUnavailableReason);
  const separatorFor = (path: string): '/' | '\\' =>
    draft.browser.listing?.separator ?? (/^[A-Za-z]:[\\/]/.test(path) ? '\\' : '/');
  const selectedBroad = draft.workingDir ? broadWorkingDirReason(draft.workingDir, separatorFor(draft.workingDir)) : null;
  const pickWorkingDir = draft.sourceKind === 'folder' || (draft.sourceKind === 'github' && githubMode === 'record');
  const pickDestination = draft.sourceKind === 'upload' || (draft.sourceKind === 'github' && githubMode === 'clone');

  return (
    <>
      <div className="project-onboard__field" role="radiogroup" aria-label="Project source">
        <span>Where do its files come from?</span>
        <label className="project-onboard__radio">
          <input
            type="radio"
            name="project-source"
            checked={draft.sourceKind === 'folder'}
            onChange={() => draft.setSourceKind('folder')}
          />
          <span>A folder already on {nodeLabel}</span>
        </label>
        <label className="project-onboard__radio">
          <input
            type="radio"
            name="project-source"
            checked={draft.sourceKind === 'upload'}
            disabled={uploadUnavailable}
            onChange={() => draft.setSourceKind('upload')}
          />
          <span>Upload a folder or files from this computer</span>
        </label>
        <label className="project-onboard__radio">
          <input
            type="radio"
            name="project-source"
            checked={draft.sourceKind === 'github'}
            onChange={() => draft.setSourceKind('github')}
          />
          <span>A GitHub repository</span>
        </label>
        {uploadUnavailable ? <p className="project-onboard__note">{props.uploadUnavailableReason}</p> : null}
      </div>

      {pickWorkingDir ? (
        <div className="project-onboard__field">
          <span>{draft.sourceKind === 'github' ? `Folder for the repository on ${nodeLabel}` : `Working folder on ${nodeLabel}`}</span>
          {props.defaultWorkingDir !== undefined ? (
            <small className="project-onboard__help" data-testid="project-folder-help">
              The folder this project’s chats, sessions, worktrees and terminals start in. Pick a folder that
              already holds your code, or leave it empty for a new one.
            </small>
          ) : null}
          <div className="project-onboard__folder-row">
            <input
              aria-label="Working directory"
              value={draft.workingDir}
              placeholder={props.defaultWorkingDir ?? '/path/to/folder'}
              onChange={(event) => draft.setWorkingDir(event.target.value)}
              spellCheck={false}
            />
            <button type="button" className="project-onboard__button" onClick={() => draft.openBrowser('workingDir')}>Browse folders</button>
          </div>
          {draft.ensureWorkingDir ? <small>This folder will be created when you submit.</small> : null}
          {props.defaultWorkingDir !== undefined && !draft.workingDir.trim() ? (
            <small data-testid="project-default-dir">
              Left empty, {nodeLabel} creates <code>{props.defaultWorkingDir ?? '~/<project-name>'}</code> and uses it.
            </small>
          ) : null}
          {selectedBroad ? (
            <p className="project-onboard__warning" role="alert">{broadWorkingDirWarning(selectedBroad)}</p>
          ) : null}
        </div>
      ) : null}

      {draft.sourceKind === 'github' ? (
        <>
          <label>
            <span>GitHub repository URL</span>
            <input
              value={draft.repoUrl}
              placeholder="https://github.com/owner/repo"
              onChange={(event) => draft.setRepoUrl(event.target.value)}
            />
          </label>
          {githubMode === 'record' ? (
            <p className="project-onboard__note">
              The repository URL is recorded on the project. Nothing is cloned now — clone it from the
              project once the Space exists.
            </p>
          ) : (
            <p className="project-onboard__note">
              {nodeLabel} clones the repository into a new folder. A private repository uses your GitHub
              sign-in, then this Space’s GitHub credential, then the node’s token where the node allows it.
            </p>
          )}
        </>
      ) : null}

      {draft.sourceKind === 'upload' ? (
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
                onChange={(event) => draft.onPick(event.target.files)}
              />
            </label>
            <label className="project-onboard__button">
              Choose files
              <input
                type="file"
                aria-label="Choose files"
                multiple
                onChange={(event) => draft.onPick(event.target.files)}
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
        </div>
      ) : null}

      {pickDestination ? (
        <div className="project-onboard__field">
          <label>
            <span>New folder name on {nodeLabel}</span>
            <input value={draft.rootName} onChange={(event) => draft.setRootName(event.target.value)} placeholder="folder-name" />
          </label>
          <div className="project-onboard__folder-row">
            <code>{draft.destinationParent || 'No destination chosen'}</code>
            <button type="button" className="project-onboard__button" onClick={() => draft.openBrowser('destinationParent')}>Choose destination</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
