/**
 * THE FILES EXPLORER — the first-class `files` view (rail: Library → Files).
 *
 * A screen over `FilesExplorerPort` and nothing else: it cannot tell a fixture
 * from a node, builds no URLs, and names no kinds. Layout:
 *
 *   roots rail (explicit roots — Library + each linked project)
 *   │ breadcrumbs · mode switcher (list / tree / gallery) · upload controls
 *   │ body: listing in the chosen mode, or the honest state that is true
 *   │ upload queue ledger (when anything was ever queued)
 *
 * EVERY VOID SAYS WHY. Loading, error-with-retry, measured-empty, refused
 * verbs and truncated listings are all distinct renders — a silent blank is
 * the one state this screen never draws.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExplorerEntry,
  ExplorerListing,
  ExplorerRoot,
  FilesExplorerPort,
} from './port';
import { EXPLORER_REASONS } from './port';
import { createUploadQueue, type UploadQueue, type UploadQueueSnapshot } from './upload-queue';
import {
  filesFromDataTransfer,
  filesFromInput,
  findConflicts,
  resolveConflicts,
  type ConflictChoice,
  type PickedFile,
} from './picker';

export type ExplorerMode = 'list' | 'tree' | 'gallery';

export interface FilesExplorerScreenProps {
  port: FilesExplorerPort;
  onNotice?: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

export function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return '—';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = sizeBytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

export function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  if (path === '') return [];
  const parts = path.split('/');
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }));
}

function isImage(entry: ExplorerEntry): boolean {
  // SVG is deliberately NOT previewed inline: the server excludes it from
  // inline serving for script-safety and this screen honours the same line.
  return entry.type === 'file' && entry.mime !== null
    && entry.mime.startsWith('image/') && entry.mime !== 'image/svg+xml';
}

type Listing =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; listing: ExplorerListing };

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function FilesExplorerScreen({ port, onNotice }: FilesExplorerScreenProps) {
  const [roots, setRoots] = useState<ExplorerRoot[] | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<ExplorerMode>('list');
  const [trashTab, setTrashTab] = useState(false);
  const [listing, setListing] = useState<Listing>({ phase: 'loading' });
  const [preview, setPreview] = useState<ExplorerEntry | null>(null);
  const [renaming, setRenaming] = useState<ExplorerEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [conflictAsk, setConflictAsk] = useState<{ picked: PickedFile[]; count: number } | null>(null);
  const [queueSnap, setQueueSnap] = useState<UploadQueueSnapshot | null>(null);
  const [imports, setImports] = useState<Array<{ rootName: string; cancel: () => void }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const queueRef = useRef<UploadQueue | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);
  const refreshSeq = useRef(0);

  const activeRoot = useMemo(
    () => roots?.find((r) => r.id === activeRootId) ?? null,
    [roots, activeRootId],
  );

  // -- roots ---------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    port
      .roots()
      .then((r) => {
        if (!alive) return;
        setRoots(r);
        setRootsError(null);
        setActiveRootId((current) => current ?? r[0]?.id ?? null);
      })
      .catch(() => alive && setRootsError('Could not load the file roots. Retry.'));
    return () => {
      alive = false;
    };
  }, [port]);

  // -- listing ---------------------------------------------------------------
  const refresh = useCallback(() => {
    if (!activeRoot) return;
    const seq = ++refreshSeq.current;
    setListing({ phase: 'loading' });
    port
      .list(activeRoot, path, { trashed: trashTab })
      .then((result) => {
        if (refreshSeq.current === seq) setListing({ phase: 'ready', listing: result });
      })
      .catch((error: unknown) => {
        if (refreshSeq.current !== seq) return;
        const message =
          error instanceof Error && error.message ? error.message : 'Could not read this folder.';
        setListing({ phase: 'error', message });
      });
  }, [port, activeRoot, path, trashTab]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // -- upload queue -----------------------------------------------------------
  const upload = activeRoot?.writable === true ? port.upload : undefined;

  function ensureQueue(): UploadQueue | null {
    if (!upload) return null;
    if (!queueRef.current) {
      const queue = createUploadQueue(upload);
      queue.subscribe(setQueueSnap);
      queue.onItemDone(() => refresh());
      queueRef.current = queue;
    }
    return queueRef.current;
  }

  /**
   * R7 split: flat file picks go through the library upload queue; anything
   * carrying a directory path is a FOLDER IMPORT, which materializes on the
   * node as a linked project — never a flattened library upload. With no
   * `importFolder` capability the folder half is refused with its reason.
   */
  const enqueue = useCallback(
    (picked: PickedFile[]) => {
      const flat = picked.filter((p) => !p.relativePath.includes('/'));
      const foldered = picked.filter((p) => p.relativePath.includes('/'));
      if (flat.length > 0) {
        const queue = ensureQueue();
        queue?.add(flat.map(({ file, relativePath }) => ({ file, relativePath })));
      }
      if (foldered.length === 0) return;
      if (!port.importFolder) {
        onNotice?.(EXPLORER_REASONS.FOLDER_IMPORT_UNAVAILABLE);
        return;
      }
      // One import per top-level folder; re-import merges and replaces (R8).
      const byRoot = new Map<string, PickedFile[]>();
      for (const p of foldered) {
        const top = p.relativePath.split('/')[0]!;
        const group = byRoot.get(top) ?? [];
        group.push(p);
        byRoot.set(top, group);
      }
      for (const [rootName, group] of byRoot) {
        const task = port.importFolder.start(
          group.map(({ file, relativePath }) => ({ file, relativePath })),
          rootName,
        );
        setImports((current) => [...current, { rootName, cancel: task.cancel }]);
        void task.result
          .then(({ replacedCount, merged }) => {
            onNotice?.(
              merged
                ? `Merged into ${rootName} — ${replacedCount} existing file${replacedCount === 1 ? '' : 's'} replaced.`
                : `Imported ${rootName} as a linked project.`,
            );
            refresh();
          })
          .catch((error: unknown) => {
            onNotice?.(
              error instanceof Error && error.message
                ? `Folder import: ${error.message}`
                : 'Folder import failed.',
            );
          })
          .finally(() => {
            setImports((current) => current.filter((i) => i.cancel !== task.cancel));
          });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upload, port, onNotice, refresh],
  );

  const existingNames = useMemo(() => {
    const names = new Set<string>();
    if (listing.phase === 'ready') for (const e of listing.listing.entries) names.add(e.name);
    return names;
  }, [listing]);

  const preflight = useCallback(
    (picked: PickedFile[], refusedCount: number) => {
      if (refusedCount > 0) {
        onNotice?.(`${refusedCount} item${refusedCount === 1 ? '' : 's'} refused: unsafe path shape.`);
      }
      if (picked.length === 0) return;
      const conflicts = findConflicts(picked, existingNames);
      if (conflicts.length > 0) setConflictAsk({ picked, count: conflicts.length });
      else enqueue(picked);
    },
    [existingNames, enqueue, onNotice],
  );

  const settleConflicts = useCallback(
    (choice: ConflictChoice) => {
      if (!conflictAsk) return;
      enqueue(resolveConflicts(conflictAsk.picked, existingNames, choice));
      setConflictAsk(null);
    },
    [conflictAsk, existingNames, enqueue],
  );

  // -- verbs -----------------------------------------------------------------
  async function act(label: string, fn: () => Promise<void>) {
    try {
      await fn();
      refresh();
    } catch (error) {
      onNotice?.(
        error instanceof Error && error.message ? `${label}: ${error.message}` : `${label} failed.`,
      );
    }
  }

  const submitRename = () => {
    if (!renaming || !port.rename) return;
    const entry = renaming;
    const next = renameValue.trim();
    setRenaming(null);
    if (next.length === 0 || next === entry.name) return;
    void act('Rename', () => port.rename!(entry, next));
  };

  // -- renders ---------------------------------------------------------------

  function entryRow(entry: ExplorerEntry) {
    const href = entry.type === 'file' ? port.downloadHref(entry) : null;
    return (
      <li key={`${entry.type}:${entry.path}`} className="fx-row" data-entry-type={entry.type}>
        {entry.type === 'dir' ? (
          <button type="button" className="fx-name fx-dir" onClick={() => setPath(entry.path)}>
            {entry.name}
          </button>
        ) : (
          <button
            type="button"
            className="fx-name"
            onClick={() => setPreview(entry)}
            aria-label={`Preview ${entry.name}`}
          >
            {entry.name}
          </button>
        )}
        <span className="fx-meta">{entry.type === 'dir' ? 'folder' : formatSize(entry.sizeBytes)}</span>
        <span className="fx-acts">
          {href ? (
            <a className="fx-act" href={href} download={entry.name} aria-label={`Download ${entry.name}`}>
              ↓
            </a>
          ) : null}
          {!trashTab && entry.entityId && port.rename ? (
            <button
              type="button"
              className="fx-act"
              aria-label={`Rename ${entry.name}`}
              onClick={() => {
                setRenaming(entry);
                setRenameValue(entry.name);
              }}
            >
              ✎
            </button>
          ) : null}
          {!trashTab && entry.entityId && port.trash ? (
            <button
              type="button"
              className="fx-act"
              aria-label={`Move ${entry.name} to trash`}
              onClick={() => void act('Trash', () => port.trash!(entry))}
            >
              🗑
            </button>
          ) : null}
          {trashTab && entry.entityId && port.restore ? (
            <button
              type="button"
              className="fx-act"
              aria-label={`Restore ${entry.name}`}
              onClick={() => void act('Restore', () => port.restore!(entry))}
            >
              ↺
            </button>
          ) : null}
        </span>
      </li>
    );
  }

  function body() {
    if (!activeRoot) return null;
    if (activeRoot.unavailableReason) {
      return <p className="fx-empty">{activeRoot.unavailableReason}</p>;
    }
    if (listing.phase === 'loading') return <p className="fx-empty">Loading…</p>;
    if (listing.phase === 'error') {
      return (
        <div className="fx-empty">
          <p>{listing.message}</p>
          <button type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      );
    }
    const entries = listing.listing.entries;
    if (entries.length === 0) {
      return (
        <p className="fx-empty" data-testid="fx-measured-empty">
          {trashTab
            ? 'Trash is empty — nothing has been deleted here.'
            : 'This folder is empty. Nothing is hidden; there is nothing to show yet.'}
        </p>
      );
    }
    if (mode === 'gallery') {
      return (
        <ul className="fx-gallery" aria-label="Files, gallery">
          {entries
            .filter((e) => e.type === 'file')
            .map((entry) => {
              const href = isImage(entry) ? port.downloadHref(entry) : null;
              return (
                <li key={entry.path} className="fx-tile">
                  <button
                    type="button"
                    className="fx-tile-btn"
                    onClick={() => setPreview(entry)}
                    aria-label={`Preview ${entry.name}`}
                  >
                    {href ? (
                      <img className="fx-thumb" src={href} alt="" />
                    ) : (
                      <span className="fx-thumb fx-thumb-none" aria-hidden="true">
                        ⬚
                      </span>
                    )}
                    <span className="fx-tile-name">{entry.name}</span>
                  </button>
                </li>
              );
            })}
        </ul>
      );
    }
    if (mode === 'tree') {
      return (
        <ul role="tree" aria-label="Folder tree" className="fx-list">
          {entries.map((entry) => (
            <li key={`${entry.type}:${entry.path}`} role="treeitem" aria-selected={false} className="fx-tree-item">
              {entryRowInner(entry)}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ul className="fx-list" aria-label="Files">
        {entries.map(entryRow)}
      </ul>
    );
  }

  // Tree rows reuse the list row's content without the <li> wrapper.
  function entryRowInner(entry: ExplorerEntry) {
    return entryRow(entry).props.children;
  }

  const crumbs = breadcrumbSegments(path);
  const truncated = listing.phase === 'ready' && listing.listing.truncated;

  return (
    <div className="fx-root" data-testid="files-explorer">
      <aside className="fx-roots" aria-label="File roots">
        <h2 className="fx-h">Files</h2>
        {rootsError ? <p className="fx-empty">{rootsError}</p> : null}
        {roots === null && !rootsError ? <p className="fx-empty">Loading roots…</p> : null}
        <ul className="fx-root-list">
          {(roots ?? []).map((root) => (
            <li key={root.id}>
              <button
                type="button"
                className="fx-root-btn"
                aria-current={root.id === activeRootId ? 'true' : undefined}
                onClick={() => {
                  setActiveRootId(root.id);
                  setPath('');
                  setTrashTab(false);
                }}
              >
                <span className="fx-root-kind" aria-hidden="true">
                  {root.kind === 'library' ? '▤' : '⌦'}
                </span>
                {root.label}
              </button>
            </li>
          ))}
        </ul>
        {activeRoot?.kind === 'project' ? (
          <p className="fx-note">{EXPLORER_REASONS.PROJECT_READ_ONLY}</p>
        ) : null}
      </aside>

      <section
        className={`fx-main${dragOver ? ' fx-dragover' : ''}`}
        aria-label="File browser"
        onDragOver={
          upload
            ? (e) => {
                e.preventDefault();
                setDragOver(true);
              }
            : undefined
        }
        onDragLeave={upload ? () => setDragOver(false) : undefined}
        onDrop={
          upload
            ? (e) => {
                e.preventDefault();
                setDragOver(false);
                void filesFromDataTransfer(e.dataTransfer).then((r) =>
                  preflight(r.files, r.refused.length),
                );
              }
            : undefined
        }
      >
        <header className="fx-bar">
          <nav aria-label="Breadcrumbs" className="fx-crumbs">
            <button type="button" className="fx-crumb" onClick={() => setPath('')}>
              {activeRoot?.label ?? '—'}
            </button>
            {crumbs.map((c) => (
              <span key={c.path}>
                <span aria-hidden="true"> / </span>
                <button type="button" className="fx-crumb" onClick={() => setPath(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
          <div className="fx-tools" role="group" aria-label="Layout">
            {(['list', 'tree', 'gallery'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="fx-tool"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          {activeRoot?.kind === 'library' ? (
            <div className="fx-tools" role="group" aria-label="Library tabs">
              <button
                type="button"
                className="fx-tool"
                aria-pressed={!trashTab}
                onClick={() => setTrashTab(false)}
              >
                Files
              </button>
              <button
                type="button"
                className="fx-tool"
                aria-pressed={trashTab}
                onClick={() => setTrashTab(true)}
              >
                Trash
              </button>
            </div>
          ) : null}
          <div className="fx-tools">
            {upload ? (
              <button type="button" className="fx-tool" onClick={() => fileInputRef.current?.click()}>
                Upload files
              </button>
            ) : null}
            {port.importFolder ? (
              <button type="button" className="fx-tool" onClick={() => dirInputRef.current?.click()}>
                Import folder
              </button>
            ) : activeRoot?.writable ? (
              <button
                type="button"
                className="fx-tool"
                disabled
                title={EXPLORER_REASONS.FOLDER_IMPORT_UNAVAILABLE}
              >
                Import folder
              </button>
            ) : null}
            {port.createFolder ? (
              <button
                type="button"
                className="fx-tool"
                onClick={() => {
                  const name = globalThis.prompt?.('Folder name');
                  if (name) void act('Create folder', () => port.createFolder!(path, name));
                }}
              >
                New folder
              </button>
            ) : activeRoot?.kind === 'library' ? (
              <button type="button" className="fx-tool" disabled title={EXPLORER_REASONS.CREATE_FOLDER_UNAVAILABLE}>
                New folder
              </button>
            ) : null}
          </div>
        </header>

        {truncated ? (
          <p className="fx-note" data-testid="fx-truncated">
            This listing was cut by the server — not everything here is shown.
          </p>
        ) : null}

        {body()}

        {imports.length > 0 ? (
          <section className="fx-queue" aria-label="Folder imports">
            <ul className="fx-queue-list">
              {imports.map((item, i) => (
                <li key={`${item.rootName}:${i}`} className="fx-queue-row" data-status="uploading">
                  <span className="fx-queue-name">Importing {item.rootName} as a linked project…</span>
                  <button type="button" onClick={() => item.cancel()}>
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {queueSnap && queueSnap.items.length > 0 ? (
          <section className="fx-queue" aria-label="Upload queue">
            <header className="fx-queue-head">
              <span>
                Uploads — {queueSnap.done} done
                {queueSnap.failed > 0 ? ` · ${queueSnap.failed} failed` : ''}
                {queueSnap.busy ? ` · ${queueSnap.queued + queueSnap.uploading} in progress` : ''}
              </span>
              {queueSnap.busy ? (
                <button type="button" onClick={() => queueRef.current?.cancelAll()}>
                  Cancel all
                </button>
              ) : null}
            </header>
            <ul className="fx-queue-list">
              {queueSnap.items.map((item) => (
                <li key={item.id} className="fx-queue-row" data-status={item.status}>
                  <span className="fx-queue-name">{item.relativePath}</span>
                  <span className="fx-queue-status">
                    {item.status}
                    {item.failureReason ? ` — ${item.failureReason}` : ''}
                  </span>
                  {item.status === 'failed' || item.status === 'cancelled' ? (
                    <button type="button" onClick={() => queueRef.current?.retry(item.id)}>
                      Retry
                    </button>
                  ) : null}
                  {item.status === 'queued' || item.status === 'uploading' ? (
                    <button type="button" onClick={() => queueRef.current?.cancel(item.id)}>
                      Cancel
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* hidden pickers — two doors, one handler */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          data-testid="fx-file-input"
          onChange={(e) => {
            const r = filesFromInput(e.currentTarget.files);
            e.currentTarget.value = '';
            preflight(r.files, r.refused.length);
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          hidden
          data-testid="fx-dir-input"
          // React's DOM typings omit the non-standard directory attributes.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            const r = filesFromInput(e.currentTarget.files);
            e.currentTarget.value = '';
            preflight(r.files, r.refused.length);
          }}
        />
      </section>

      {preview ? (
        <div
          className="fx-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview of ${preview.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPreview(null);
          }}
        >
          <header className="fx-overlay-bar">
            <span>{preview.name}</span>
            <button type="button" onClick={() => setPreview(null)} aria-label="Close preview">
              ✕
            </button>
          </header>
          {(() => {
            const href = port.downloadHref(preview);
            if (href && isImage(preview)) return <img className="fx-preview-img" src={href} alt={preview.name} />;
            return (
              <div className="fx-empty">
                <p>{EXPLORER_REASONS.PREVIEW_UNAVAILABLE}</p>
                {href ? (
                  <a href={href} download={preview.name}>
                    Download {preview.name}
                  </a>
                ) : null}
              </div>
            );
          })()}
        </div>
      ) : null}

      {renaming ? (
        <div className="fx-overlay" role="dialog" aria-modal="true" aria-label={`Rename ${renaming.name}`}>
          <form
            className="fx-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <label>
              New name
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.currentTarget.value)}
              />
            </label>
            <div className="fx-dialog-acts">
              <button type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button type="submit">Rename</button>
            </div>
          </form>
        </div>
      ) : null}

      {conflictAsk ? (
        <div className="fx-overlay" role="dialog" aria-modal="true" aria-label="Name conflicts">
          <div className="fx-dialog" data-testid="fx-conflict-dialog">
            <p>
              {conflictAsk.count} item{conflictAsk.count === 1 ? '' : 's'} already exist
              {conflictAsk.count === 1 ? 's' : ''} here. What should happen?
            </p>
            <div className="fx-dialog-acts">
              <button type="button" onClick={() => settleConflicts('keep-both')}>
                Keep both
              </button>
              <button type="button" onClick={() => settleConflicts('replace')}>
                Replace
              </button>
              <button type="button" onClick={() => settleConflicts('skip')}>
                Skip
              </button>
              <button type="button" onClick={() => setConflictAsk(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
