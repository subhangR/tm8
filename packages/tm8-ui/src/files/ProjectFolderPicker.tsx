/**
 * THE PROJECT FOLDER PICKER — browse a connected project's working directory on
 * the tm8 node, and attach a file out of it to one entity.
 *
 * WHY A NODE-SIDE BROWSER AND NOT A FILE INPUT. The strip beside this already
 * has a file input, and it is the right control for a file the user is holding.
 * It cannot reach a connected project folder at all: a browser file input hands
 * over bytes and a bare filename, never an absolute path, so nothing in the
 * page can say *which* file in the folder was meant. The folder is on the node;
 * only the node can read it. Every path rendered here came back from the server
 * and every path sent back is one of those — this component never assembles a
 * path from parts.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No upload progress, no cancel: the bytes
 * never traverse the browser, so there is no transfer to report on. One request
 * either attaches the file or explains why it did not.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EntityId, ProjectFileListing, ProjectId, ProjectResource } from '@tm8/contract';
import { formatSizeChip, formatSizeRow } from './model';
import type { ProjectFolderPort } from './port';
import './project-folder-picker.css';

export interface ProjectFolderPickerProps {
  port: ProjectFolderPort;
  /** Attachments land here — the same anchor the strip's uploads use. */
  anchorId: EntityId;
  onDismiss: () => void;
  /** One file attached. The host refetches the anchor so the new edge shows. */
  onAttached: () => void;
}

function reason(cause: unknown): string {
  const message = (cause as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message : String(cause);
}

export function ProjectFolderPicker({ port, anchorId, onDismiss, onAttached }: ProjectFolderPickerProps) {
  const [projects, setProjects] = useState<readonly ProjectResource[] | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [listing, setListing] = useState<ProjectFileListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The path currently being attached — one at a time, so the row can say so. */
  const [attaching, setAttaching] = useState<string | null>(null);

  const browse = useCallback(
    async (id: ProjectId, path?: string) => {
      setBusy(true);
      setError(null);
      try {
        setListing(await port.list(id, path));
        setProjectId(id);
      } catch (cause) {
        setListing(null);
        setError(reason(cause));
      } finally {
        setBusy(false);
      }
    },
    [port],
  );

  useEffect(() => {
    let live = true;
    setBusy(true);
    port.projects().then(
      (rows) => {
        if (!live) return;
        setProjects(rows);
        setBusy(false);
        // One connected project is not a choice — open it rather than making
        // the user pick from a list of one.
        if (rows.length === 1) void browse(rows[0]!.id);
      },
      (cause) => {
        if (!live) return;
        setProjects([]);
        setBusy(false);
        setError(reason(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [browse, port]);

  const attach = async (path: string) => {
    if (!projectId) return;
    setAttaching(path);
    setError(null);
    try {
      await port.attach({ projectId, path, anchorId });
      onAttached();
    } catch (cause) {
      setError(reason(cause));
    } finally {
      setAttaching(null);
    }
  };

  return (
    <div className="fn-picker" role="dialog" aria-modal="true" aria-labelledby="fn-picker-title">
      <div className="fn-picker__panel">
        <header className="fn-picker__head">
          <h2 id="fn-picker-title">Attach from a project folder</h2>
          <button type="button" className="fn-picker__close" onClick={onDismiss} aria-label="Close">
            ×
          </button>
        </header>

        {projects !== null && projects.length === 0 ? (
          <p className="fn-picker__note">
            This Space has no connected project folder, so there is nothing on the node to browse.
          </p>
        ) : null}

        {projects !== null && projects.length > 1 ? (
          <div className="fn-picker__projects" aria-label="Connected projects">
            {projects.map((project) => (
              <button
                type="button"
                key={project.id}
                className={project.id === projectId ? 'fn-picker__project fn-picker__project--on' : 'fn-picker__project'}
                onClick={() => void browse(project.id)}
                title={project.workingDir}
              >
                {project.name}
              </button>
            ))}
          </div>
        ) : null}

        {listing ? (
          <>
            <div className="fn-picker__path" title={listing.path}>
              {listing.path}
            </div>
            {listing.parentPath ? (
              <button
                type="button"
                className="fn-picker__up"
                onClick={() => void browse(listing.projectId as ProjectId, listing.parentPath!)}
              >
                ↑ Parent
              </button>
            ) : null}

            <ul className="fn-picker__list" aria-label="Folders and files">
              {listing.directories.map((directory) => (
                <li key={directory.path}>
                  <button
                    type="button"
                    className="fn-picker__row"
                    onClick={() => void browse(listing.projectId as ProjectId, directory.path)}
                  >
                    <span aria-hidden="true">▱</span>
                    <span className="fn-picker__name">{directory.name}</span>
                  </button>
                </li>
              ))}
              {listing.files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className="fn-picker__row fn-picker__row--file"
                    onClick={() => void attach(file.path)}
                    disabled={!file.attachable || attaching !== null}
                    /* L6: a file too large to store is shown and refused with
                       the reason, never hidden — hiding it reads as "the
                       folder is empty". */
                    title={
                      file.attachable
                        ? `Attach ${file.name}`
                        : file.sizeBytes === 0
                          ? 'There are no bytes here to attach.'
                          : `Larger than this node's limit of ${formatSizeRow(listing.maxSizeBytes) ?? 'zero'}.`
                    }
                  >
                    <span aria-hidden="true">▤</span>
                    <span className="fn-picker__name">{file.name}</span>
                    <span className="fn-picker__size">{formatSizeChip(file.sizeBytes) ?? ''}</span>
                    {attaching === file.path ? <span className="fn-picker__state">attaching…</span> : null}
                  </button>
                </li>
              ))}
              {!busy && listing.directories.length === 0 && listing.files.length === 0 ? (
                <li className="fn-picker__empty">This folder is empty</li>
              ) : null}
            </ul>

            {listing.truncated ? (
              <p className="fn-picker__note">Only the first 500 folders and files are shown.</p>
            ) : null}
          </>
        ) : null}

        {busy ? (
          <p className="fn-picker__note" role="status">
            Reading the node…
          </p>
        ) : null}
        {error ? (
          <p className="fn-picker__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
