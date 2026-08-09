import { useCallback, useEffect, useState } from 'react';
import type { ProjectFileContent, ProjectFileListing } from '@tm8/contract';

import type { Seam } from '../data/seam';
import './files-browser.css';

/**
 * ▤ Files — browse and VIEW a connected project's working directory on the node.
 *
 * WHAT THIS SCREEN IS NOT. It does not list `file` ENTITIES. A `file` entity is
 * a REFERENCE to a file whose truth lives elsewhere; this screen shows the
 * truth. Browsing and viewing mint nothing — `projects.files.attach` is the
 * operation that turns a path into an entity, and it is not on this screen.
 *
 * It is built on `seam.projectFiles`, which already listed directories for the
 * attach picker. This lane added only the `read` half: the group could list a
 * directory and attach a file but never SHOW one.
 *
 * Two states a careless implementation collapses, drawn distinctly here:
 *   - an EMPTY file renders as an empty `<pre>`, NOT as a refusal;
 *   - a REFUSAL names its reason instead of rendering nothing.
 */

export interface FilesScreenProps {
  seam: Seam;
  /** Linked projects — the only browsable roots. */
  projects: readonly { id: string; name: string }[];
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

/** Human text for every refusal the contract can answer. */
const REFUSAL_TEXT: Record<string, string> = {
  'secret-pattern': 'Withheld: this file matches the secret-name policy.',
  'too-large': 'Too large to show inline.',
  'binary-not-previewable': 'Binary file — no inline preview.',
  'not-a-file': 'Not a readable file.',
  'outside-root': 'Refused: this path resolves outside the project working directory.',
  unreadable: 'The node could not read this file.',
};

/** Path segments between the working directory and the current directory. */
function crumbsOf(listing: ProjectFileListing): { label: string; path: string }[] {
  const { workingDir, path, separator } = listing;
  if (!path.startsWith(workingDir)) return [];
  const rest = path.slice(workingDir.length).split(separator).filter(Boolean);
  let walked = workingDir;
  return rest.map((segment) => {
    walked = `${walked}${separator}${segment}`;
    return { label: segment, path: walked };
  });
}

export function FilesScreen({ seam, projects }: FilesScreenProps) {
  const port = seam.projectFiles;
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [path, setPath] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<Load<ProjectFileListing>>({ phase: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<Load<ProjectFileContent>>({ phase: 'idle' });

  // A space can gain its first project after mount; adopt it rather than
  // staying permanently empty.
  useEffect(() => {
    if (projectId === null && projects.length > 0) setProjectId(projects[0].id);
  }, [projectId, projects]);

  useEffect(() => {
    if (!port || projectId === null) return;
    let cancelled = false;
    setListing({ phase: 'loading' });
    port
      .list(projectId, path)
      .then((value) => { if (!cancelled) setListing({ phase: 'ready', value }); })
      .catch((error) => { if (!cancelled) setListing({ phase: 'error', message: messageOf(error) }); });
    return () => { cancelled = true; };
  }, [port, projectId, path]);

  const openFile = useCallback((filePath: string) => {
    if (!port || projectId === null) return;
    setSelected(filePath);
    setContent({ phase: 'loading' });
    port
      .read(projectId, filePath)
      .then((value) => setContent({ phase: 'ready', value }))
      .catch((error) => setContent({ phase: 'error', message: messageOf(error) }));
  }, [port, projectId]);

  const enterDir = useCallback((dirPath: string | undefined) => {
    setPath(dirPath);
    setSelected(null);
    setContent({ phase: 'idle' });
  }, []);

  /* The seam group is OPTIONAL — a fixture seam has no filesystem — so its
     absence is a fact about this build, said out loud rather than drawn as an
     empty tree the user would read as "this project has no files". */
  if (!port) {
    return (
      <div className="fb-root" data-testid="files-screen">
        <p className="fb-empty" data-testid="files-no-port">
          This build cannot read the node’s filesystem: the seam in use has no
          project-files support. Nothing is hidden here — the capability is absent.
        </p>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="fb-root" data-testid="files-screen">
        <p className="fb-empty" data-testid="files-no-projects">
          No project is linked to this space, so there is no working directory to
          browse. Files reads a linked project’s folder on this node — link a
          project to see it here.
        </p>
      </div>
    );
  }

  const crumbs = listing.phase === 'ready' ? crumbsOf(listing.value) : [];

  return (
    <div className="fb-root" data-testid="files-screen">
      <header className="fb-head">
        {projects.length > 1 ? (
          <label className="fb-rootpick">
            <span className="fb-rootpick-label">Project</span>
            <select
              data-testid="files-root-select"
              value={projectId ?? ''}
              onChange={(event) => { setProjectId(event.target.value); enterDir(undefined); }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="fb-rootname">{projects[0].name}</span>
        )}
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

      <div className="fb-body">
        <section className="fb-list" data-testid="files-list">
          {listing.phase === 'loading' ? <p className="fb-note">Reading directory…</p> : null}
          {listing.phase === 'error' ? (
            <p className="fb-note fb-note-bad" data-testid="files-list-error">{listing.message}</p>
          ) : null}
          {listing.phase === 'ready' ? (
            <>
              {listing.value.parentPath !== null ? (
                <button
                  type="button"
                  className="fb-row fb-row-up"
                  data-testid="files-up"
                  onClick={() => enterDir(listing.value.parentPath ?? undefined)}
                >
                  <span className="fb-name">../</span>
                </button>
              ) : null}
              {listing.value.directories.length === 0 && listing.value.files.length === 0 ? (
                <p className="fb-note" data-testid="files-empty-dir">This directory is empty.</p>
              ) : null}
              {listing.value.directories.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  className="fb-row fb-row-dir"
                  data-testid={`files-dir-${dir.name}`}
                  onClick={() => enterDir(dir.path)}
                >
                  <span className="fb-name">{dir.name}/</span>
                </button>
              ))}
              {listing.value.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`fb-row fb-row-file${selected === file.path ? ' fb-row-on' : ''}`}
                  data-testid={`files-entry-${file.name}`}
                  onClick={() => openFile(file.path)}
                >
                  <span className="fb-name">{file.name}</span>
                  <span className="fb-size">{sizeLabel(file.sizeBytes)}</span>
                </button>
              ))}
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
            <>
              <div className="fb-view-head">
                <span className="fb-view-path">{content.value.path}</span>
                <span className="fb-view-meta">
                  {[content.value.mime, sizeLabel(content.value.sizeBytes)].filter(Boolean).join(' · ')}
                </span>
              </div>
              {content.value.refusal ? (
                /* Named, never blank — a reader must be able to tell "withheld"
                   from "empty". */
                <p
                  className="fb-note fb-note-bad"
                  data-testid="files-refusal"
                  data-reason={content.value.refusal.reason}
                >
                  {REFUSAL_TEXT[content.value.refusal.reason] ?? content.value.refusal.detail}
                </p>
              ) : content.value.encoding === 'base64' ? (
                <img
                  className="fb-img"
                  data-testid="files-image"
                  alt={content.value.path}
                  src={`data:${content.value.mime};base64,${content.value.base64 ?? ''}`}
                />
              ) : (
                /* A `<pre>`, never innerHTML: nothing off a project's disk is
                   given a document context on the app origin. */
                <pre className="fb-pre" data-testid="files-text">{content.value.text ?? ''}</pre>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
