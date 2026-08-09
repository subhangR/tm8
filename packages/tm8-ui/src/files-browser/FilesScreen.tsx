import { useCallback, useEffect, useMemo, useState } from 'react';

import { DisabledAction } from '../panels';
import type { Seam } from '../data/seam';
import { FileTree } from './FileTree';
import { FolderUpload } from './FolderUpload';
import { DOWNLOAD_WITHOUT_BYTES, SPACE_FOLDERS_UNAVAILABLE } from './reasons';
import {
  ROOT_KIND_COPY,
  crumbsOf,
  dirViewOfFolder,
  dirViewOfProject,
  fileViewOfFolder,
  fileViewOfProject,
  type DirView,
  type FileView,
  type FilesRoot,
} from './roots';
import { spaceFoldersPortOf, type SpaceFolderSummary } from './space-folders';
import './files-browser.css';

/**
 * ▤ Files — browse and VIEW what this Space can see, from TWO kinds of root.
 *
 * WHAT THIS SCREEN IS NOT. It does not list `file` ENTITIES. A `file` entity is
 * a REFERENCE to a file whose truth lives elsewhere; this screen shows the
 * truth. Browsing and viewing mint nothing — `projects.files.attach` is the
 * operation that turns a path into an entity, and it is not on this screen.
 *
 * THE CENTRAL UX DEFECT THIS SCREEN IS SHAPED TO AVOID is drawing its two root
 * kinds as one anonymous tree. A LINKED PROJECT is a live directory on the node
 * that changes under you; a SPACE FOLDER is a stored snapshot the user
 * uploaded. Their staleness runs in opposite directions and so does the remedy
 * when something looks wrong — re-read one, re-upload the other. So the kind is
 * STATED, in the picker's group labels and again in a banner over the panes.
 * See `roots.ts`.
 *
 * States a careless implementation collapses, drawn distinctly here:
 *   - an EMPTY file renders as an empty `<pre>`, NOT as a refusal;
 *   - each refusal REASON renders distinctly, because each has its own remedy;
 *   - an absent seam group is disabled-with-reason, never an empty list, which
 *     would read as "you have not uploaded anything yet".
 */

export interface FilesScreenProps {
  seam: Seam;
  /** Linked projects — the LIVE roots. */
  projects: readonly { id: string; name: string }[];
  /** Owner of the Space-folder roots. Absent in hosts with no space selected. */
  spaceId?: string;
}

type Load<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the node refused the read';
}

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Human text for every refusal the contract can answer. They are separate
 * strings on purpose: `too-large` is remedied by opening the file another way,
 * `secret-pattern` by not trying at all, `outside-root` by fixing a symlink.
 * One "cannot show this" for all of them tells the reader nothing to act on.
 */
const REFUSAL_TEXT: Record<string, string> = {
  'secret-pattern': 'Withheld: this file matches the secret-name policy.',
  'too-large': 'Too large to show inline.',
  'binary-not-previewable': 'Binary file — no inline preview.',
  'not-a-file': 'Not a readable file.',
  'outside-root': 'Refused: this path resolves outside the project working directory.',
  unreadable: 'The node could not read this file.',
};

function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * SAVING WHAT WAS ALREADY READ. There is no byte-stream read for a path inside
 * a project — `files.download` addresses a file ENTITY and this screen mints
 * none — so the only bytes that can be saved are the ones the DTO already
 * carried. That makes the honest state fall out rather than being invented: a
 * refusal has no bytes, and the control says so instead of offering a link to
 * nothing.
 *
 * A `data:` URL, not a blob URL: it needs no revoke lifecycle, browsers refuse
 * top-level navigation to `data:` so it stays inert, and it is assertable in
 * jsdom, where `URL.createObjectURL` does not exist.
 */
function downloadHref(file: FileView): string | null {
  if (file.refusal) return null;
  const mime = file.mime ?? 'application/octet-stream';
  if (file.encoding === 'base64') {
    return file.base64 === null ? null : `data:${mime};base64,${file.base64}`;
  }
  if (file.encoding === 'utf8' && file.text !== null) {
    return `data:${mime};base64,${base64OfUtf8(file.text)}`;
  }
  return null;
}

function baseName(path: string, separator: string): string {
  const parts = path.split(separator).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function FilesScreen({ seam, projects, spaceId }: FilesScreenProps) {
  const projectPort = seam.projectFiles;
  const folderPort = spaceFoldersPortOf(seam);

  const [folders, setFolders] = useState<Load<readonly SpaceFolderSummary[]>>({ phase: 'idle' });
  const [rootId, setRootId] = useState<string | null>(null);
  const [path, setPath] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<Load<DirView>>({ phase: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<Load<FileView>>({ phase: 'idle' });

  const loadFolders = useCallback(() => {
    if (!folderPort || spaceId === undefined) return;
    setFolders({ phase: 'loading' });
    folderPort
      .list(spaceId)
      .then((value) => setFolders({ phase: 'ready', value }))
      .catch((error) => setFolders({ phase: 'error', message: messageOf(error) }));
  }, [folderPort, spaceId]);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  const roots = useMemo<FilesRoot[]>(() => {
    const out: FilesRoot[] = projects.map((project) => ({
      kind: 'project', id: `project:${project.id}`, name: project.name,
    }));
    if (folders.phase === 'ready') {
      for (const folder of folders.value) {
        out.push({
          kind: 'space-folder', id: `folder:${folder.id}`, name: folder.name, summary: folder,
        });
      }
    }
    return out;
  }, [folders, projects]);

  const activeRoot = useMemo(
    () => roots.find((root) => root.id === rootId) ?? roots[0] ?? null,
    [rootId, roots],
  );

  // A Space can gain its first root after mount — a project link, or the first
  // uploaded folder. Adopt it rather than staying permanently empty.
  useEffect(() => {
    if (rootId === null && roots.length > 0) setRootId(roots[0].id);
  }, [rootId, roots]);

  /* Root ids are namespaced (`project:` / `folder:`) so that a project and a
     folder sharing an id can never be confused for one another by the picker. */
  const rawId = activeRoot ? activeRoot.id.slice(activeRoot.id.indexOf(':') + 1) : null;

  useEffect(() => {
    if (!activeRoot || rawId === null) return;
    let cancelled = false;
    setListing({ phase: 'loading' });
    const pending =
      activeRoot.kind === 'project'
        ? projectPort?.list(rawId, path).then(dirViewOfProject)
        : folderPort?.browse(rawId, path).then(dirViewOfFolder);
    if (!pending) return;
    pending
      .then((value) => { if (!cancelled) setListing({ phase: 'ready', value }); })
      .catch((error) => {
        if (!cancelled) setListing({ phase: 'error', message: messageOf(error) });
      });
    return () => { cancelled = true; };
  }, [activeRoot, folderPort, path, projectPort, rawId]);

  const openFile = useCallback(
    (filePath: string) => {
      if (!activeRoot || rawId === null) return;
      setSelected(filePath);
      setContent({ phase: 'loading' });
      const pending =
        activeRoot.kind === 'project'
          ? projectPort?.read(rawId, filePath).then(fileViewOfProject)
          : folderPort?.read(rawId, filePath).then(fileViewOfFolder);
      if (!pending) return;
      pending
        .then((value) => setContent({ phase: 'ready', value }))
        .catch((error) => setContent({ phase: 'error', message: messageOf(error) }));
    },
    [activeRoot, folderPort, projectPort, rawId],
  );

  const enterDir = useCallback((dirPath: string | undefined) => {
    setPath(dirPath);
    setSelected(null);
    setContent({ phase: 'idle' });
  }, []);

  /* Both seam groups are OPTIONAL — a fixture seam has no filesystem, and the
     Space-folders group does not exist in this build at all. Both absent means
     there is nothing to browse from either kind of root, and that is a fact
     about the build, said out loud rather than drawn as an empty tree the user
     would read as "there are no files". */
  if (!projectPort && !folderPort) {
    return (
      <div className="fb-root" data-testid="files-screen">
        <p className="fb-empty" data-testid="files-no-port">
          This build cannot read the node’s filesystem: the seam in use has no
          project-files support. Nothing is hidden here — the capability is absent.
        </p>
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="fb-root" data-testid="files-screen">
        <p className="fb-empty" data-testid="files-no-roots">
          Nothing is browsable from this Space yet. Files reads two kinds of root:
          a LINKED PROJECT’s working directory on this node, and a SPACE FOLDER
          you have uploaded. Link a project or upload a folder to see it here.
        </p>
        {folderPort ? null : (
          <div className="fb-empty" data-testid="files-space-folders-off">
            <DisabledAction reason={SPACE_FOLDERS_UNAVAILABLE} label="Space folders">
              Space folders
            </DisabledAction>
          </div>
        )}
      </div>
    );
  }

  const kind = activeRoot?.kind ?? 'project';
  const crumbs = listing.phase === 'ready' ? crumbsOf(listing.value) : [];
  const destination =
    activeRoot && activeRoot.kind === 'space-folder'
      ? { id: activeRoot.summary.id, name: activeRoot.name }
      : null;

  return (
    <div className="fb-root" data-testid="files-screen">
      <header className="fb-head">
        <label className="fb-rootpick">
          <span className="fb-rootpick-label">Root</span>
          <select
            data-testid="files-root-select"
            value={activeRoot?.id ?? ''}
            onChange={(event) => { setRootId(event.target.value); enterDir(undefined); }}
          >
            {/* The two kinds are never one flat list: an anonymous row cannot
                say whether it is live disk or a snapshot. */}
            <optgroup label={ROOT_KIND_COPY.project.group}>
              {roots.filter((root) => root.kind === 'project').map((root) => (
                <option key={root.id} value={root.id}>{root.name}</option>
              ))}
            </optgroup>
            {roots.some((root) => root.kind === 'space-folder') ? (
              <optgroup label={ROOT_KIND_COPY['space-folder'].group}>
                {roots.filter((root) => root.kind === 'space-folder').map((root) => (
                  <option key={root.id} value={root.id}>{root.name}</option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <nav className="fb-crumbs" data-testid="files-breadcrumbs">
          <button type="button" className="fb-crumb" onClick={() => enterDir(undefined)}>root</button>
          {crumbs.map((crumb) => (
            <button
              key={crumb.path}
              type="button"
              className="fb-crumb"
              onClick={() => enterDir(crumb.path)}
            >
              {crumb.label}
            </button>
          ))}
        </nav>
      </header>

      {/* The kind, STATED. Not an icon, not "the group the row came from" — the
          property that decides what the user should do about a surprise. */}
      <p className={`fb-kind fb-kind-${kind}`} data-testid="files-root-kind" data-kind={kind}>
        {ROOT_KIND_COPY[kind].banner}
      </p>

      {folders.phase === 'error' ? (
        <p className="fb-note fb-note-bad" data-testid="files-folders-error">
          Space folders could not be listed: {folders.message}. Linked projects
          are unaffected.
        </p>
      ) : null}

      {folderPort ? (
        <FolderUpload
          port={folderPort}
          spaceId={spaceId}
          destination={destination}
          projectRootSelected={activeRoot?.kind === 'project'}
          onUploaded={loadFolders}
        />
      ) : (
        <div className="fb-upload fb-upload-off" data-testid="files-space-folders-off">
          <DisabledAction reason={SPACE_FOLDERS_UNAVAILABLE} label="Space folders">
            Space folders
          </DisabledAction>
        </div>
      )}

      <div className="fb-body">
        <section className="fb-list" data-testid="files-list">
          {listing.phase === 'loading' ? <p className="fb-note">Reading directory…</p> : null}
          {listing.phase === 'error' ? (
            <p className="fb-note fb-note-bad" data-testid="files-list-error">{listing.message}</p>
          ) : null}
          {listing.phase === 'ready' ? (
            <>
              {listing.value.directories.length === 0 && listing.value.files.length === 0 ? (
                <p className="fb-note" data-testid="files-empty-dir">This directory is empty.</p>
              ) : null}
              <FileTree
                view={listing.value}
                selectedPath={selected}
                onEnterDir={enterDir}
                onOpenFile={openFile}
              />
              {listing.value.truncated ? (
                <p className="fb-note" data-testid="files-truncated">
                  This directory is larger than the browser shows; narrow the path
                  to see the rest.
                </p>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="fb-view" data-testid="files-content">
          {content.phase === 'idle' ? <p className="fb-note">Select a file to view it.</p> : null}
          {content.phase === 'loading' ? <p className="fb-note">Reading file…</p> : null}
          {content.phase === 'error' ? (
            <p className="fb-note fb-note-bad" data-testid="files-content-error">{content.message}</p>
          ) : null}
          {content.phase === 'ready' ? (
            <FileViewer
              file={content.value}
              separator={listing.phase === 'ready' ? listing.value.separator : '/'}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function FileViewer({ file, separator }: { file: FileView; separator: string }) {
  const href = downloadHref(file);
  return (
    <>
      <div className="fb-view-head">
        <span className="fb-view-path">{file.path}</span>
        <span className="fb-view-meta">
          {[file.mime, sizeLabel(file.sizeBytes)].filter(Boolean).join(' · ')}
        </span>
        {href === null ? (
          <DisabledAction reason={DOWNLOAD_WITHOUT_BYTES} label="Save this file">
            Save
          </DisabledAction>
        ) : (
          <a
            className="fb-btn fb-save"
            data-testid="files-download"
            href={href}
            download={baseName(file.path, separator)}
          >
            Save
          </a>
        )}
      </div>
      {file.refusal ? (
        /* Named, never blank — a reader must be able to tell "withheld" from
           "empty", and one refusal reason from another. */
        <p
          className="fb-note fb-note-bad"
          data-testid="files-refusal"
          data-reason={file.refusal.reason}
        >
          {REFUSAL_TEXT[file.refusal.reason] ?? file.refusal.detail}
        </p>
      ) : file.encoding === 'base64' ? (
        <img
          className="fb-img"
          data-testid="files-image"
          alt={file.path}
          src={`data:${file.mime ?? 'application/octet-stream'};base64,${file.base64 ?? ''}`}
        />
      ) : (
        /* A `<pre>`, never innerHTML: nothing off a disk is given a document
           context on the app origin. */
        <pre className="fb-pre" data-testid="files-text">{file.text ?? ''}</pre>
      )}
    </>
  );
}
