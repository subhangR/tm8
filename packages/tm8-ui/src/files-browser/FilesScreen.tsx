import { useCallback, useEffect, useState } from 'react';
import type { FileBrowseView, FileReadView, SpaceId } from '@tm8/contract';

import type { Seam } from '../data/seam';
import './files-browser.css';

/**
 * ▤ Files — the node's REAL filesystem, root-jailed to a project linked to this
 * space (FILES-DESIGN §3, §5.3).
 *
 * WHAT THIS SCREEN IS NOT. It does not list `file` ENTITIES. A `file` entity is
 * a REFERENCE to a file whose truth lives elsewhere; this screen shows the
 * truth. Browsing mints nothing, and no row here carries an entity id. The
 * `file` kind's own collection list is a different screen about different rows,
 * which is why the rail glyph is a folder and not the file kind's page mark.
 *
 * The three states a careless implementation collapses, each drawn distinctly:
 *   - a MASKED entry is LISTED, greyed, and says it is withheld — never hidden,
 *     because a tree with silent holes teaches the reader a lie they will act on;
 *   - an EMPTY file renders as an empty `<pre>` and NOT as a refusal;
 *   - a REFUSAL names its reason instead of showing nothing.
 */

export interface FilesScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  /** Linked projects — the only browsable roots (§3). */
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

/** Human text for every refusal the contract can answer (§5.1). */
const REFUSAL_TEXT: Record<string, string> = {
  'secret-pattern': 'Withheld: this file matches the secret-name policy.',
  'too-large': 'Too large to show inline.',
  'binary-not-previewable': 'Binary file — no inline preview.',
  'not-a-file': 'Not a readable file.',
  'outside-root': 'Refused: this path resolves outside the project root.',
  unreadable: 'The node could not read this file.',
};

export function FilesScreen({ seam, spaceId, projects }: FilesScreenProps) {
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<Load<FileBrowseView>>({ phase: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<Load<FileReadView>>({ phase: 'idle' });

  // A space can gain its first project after mount; adopt it rather than
  // staying permanently empty.
  useEffect(() => {
    if (projectId === null && projects.length > 0) setProjectId(projects[0].id);
  }, [projectId, projects]);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    setListing({ phase: 'loading' });
    seam.files
      .browse(spaceId, projectId, path)
      .then((value) => { if (!cancelled) setListing({ phase: 'ready', value }); })
      .catch((error) => { if (!cancelled) setListing({ phase: 'error', message: messageOf(error) }); });
    return () => { cancelled = true; };
  }, [seam, spaceId, projectId, path]);

  const openFile = useCallback((filePath: string) => {
    if (projectId === null) return;
    setSelected(filePath);
    setContent({ phase: 'loading' });
    seam.files
      .read(spaceId, projectId, filePath)
      .then((value) => setContent({ phase: 'ready', value }))
      .catch((error) => setContent({ phase: 'error', message: messageOf(error) }));
  }, [seam, spaceId, projectId]);

  const enterDir = useCallback((dirPath: string) => {
    setPath(dirPath);
    setSelected(null);
    setContent({ phase: 'idle' });
  }, []);

  if (projects.length === 0) {
    return (
      <div className="fb-root" data-testid="files-screen">
        <p className="fb-empty" data-testid="files-no-projects">
          No project is linked to this space, so there is no directory to browse.
          Files reads a project’s working directory on this node — link a project
          to see it here.
        </p>
      </div>
    );
  }

  return (
    <div className="fb-root" data-testid="files-screen">
      <header className="fb-head">
        {projects.length > 1 ? (
          <label className="fb-rootpick">
            <span className="fb-rootpick-label">Project</span>
            <select
              data-testid="files-root-select"
              value={projectId ?? ''}
              onChange={(event) => { setProjectId(event.target.value); enterDir(''); }}
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
          <button type="button" className="fb-crumb" onClick={() => enterDir('')}>root</button>
          {path.split('/').filter(Boolean).map((segment, index, all) => (
            <button
              key={all.slice(0, index + 1).join('/')}
              type="button"
              className="fb-crumb"
              onClick={() => enterDir(all.slice(0, index + 1).join('/'))}
            >
              {segment}
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
                  onClick={() => enterDir(listing.value.parentPath ?? '')}
                >
                  <span className="fb-name">../</span>
                </button>
              ) : null}
              {listing.value.entries.length === 0 ? (
                <p className="fb-note" data-testid="files-empty-dir">This directory is empty.</p>
              ) : null}
              {listing.value.entries.map((entry) => {
                const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
                const isDir = entry.kind === 'dir';
                return (
                  <button
                    key={entry.name}
                    type="button"
                    className={[
                      'fb-row',
                      isDir ? 'fb-row-dir' : 'fb-row-file',
                      entry.masked ? 'fb-row-masked' : '',
                      selected === childPath ? 'fb-row-on' : '',
                    ].filter(Boolean).join(' ')}
                    data-testid={`files-entry-${entry.name}`}
                    data-masked={entry.masked ? 'true' : 'false'}
                    onClick={() => (isDir ? enterDir(childPath) : openFile(childPath))}
                  >
                    <span className="fb-name">{entry.name}{isDir ? '/' : ''}</span>
                    {entry.symlink ? <span className="fb-tag">link</span> : null}
                    {/* Listed, not hidden — §4.2. */}
                    {entry.masked ? (
                      <span className="fb-tag fb-tag-masked" data-testid={`files-masked-${entry.name}`}>
                        withheld
                      </span>
                    ) : null}
                    <span className="fb-size">{sizeLabel(entry.sizeBytes)}</span>
                  </button>
                );
              })}
              {listing.value.truncated ? (
                <p className="fb-note" data-testid="files-truncated">
                  {`Showing ${listing.value.entries.length} of ${listing.value.totalEntries} entries.`}
                </p>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="fb-view" data-testid="files-content">
          {content.phase === 'idle' ? (
            <p className="fb-note">Select a file to view it.</p>
          ) : null}
          {content.phase === 'loading' ? <p className="fb-note">Reading file…</p> : null}
          {content.phase === 'error' ? (
            <p className="fb-note fb-note-bad" data-testid="files-content-error">{content.message}</p>
          ) : null}
          {content.phase === 'ready' ? (
            <>
              <div className="fb-view-head">
                <span className="fb-view-path">{content.value.path}</span>
                <span className="fb-view-meta">
                  {[content.value.mimeType, sizeLabel(content.value.sizeBytes)]
                    .filter(Boolean).join(' · ')}
                </span>
              </div>
              {content.value.refusal ? (
                /* Named, never blank — a reader must be able to tell "withheld"
                   from "empty". */
                <p className="fb-note fb-note-bad" data-testid="files-refusal" data-reason={content.value.refusal.reason}>
                  {REFUSAL_TEXT[content.value.refusal.reason] ?? content.value.refusal.detail}
                </p>
              ) : content.value.encoding === 'base64' ? (
                <img
                  className="fb-img"
                  data-testid="files-image"
                  alt={content.value.path}
                  src={`data:${content.value.mimeType ?? 'application/octet-stream'};base64,${content.value.base64 ?? ''}`}
                />
              ) : (
                /* A `<pre>`, never innerHTML: nothing off a project's disk is
                   given a document context on the app origin (§4.4). */
                <pre className="fb-pre" data-testid="files-text">{content.value.text ?? ''}</pre>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
