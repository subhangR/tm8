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
import { PreviewBody } from './PreviewBody';
import { createUploadQueue, type UploadQueue, type UploadQueueSnapshot } from './upload-queue';
import type { FolderImportProgress } from './folder-import';
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

export type ExplorerSort = 'name' | 'size' | 'modified';

/**
 * Directories first, then the chosen key. Folders-before-files is not a
 * preference — a listing that interleaves them makes "where does this folder
 * end" a reading exercise, and every file manager worth using does the same.
 *
 * `null` size/date means NOT KNOWN (D7.2), and unknown sorts LAST rather than
 * as zero: a project directory has no size, and letting it rank above a 4 GB
 * file because `null < 1` would be the numeric version of the same lie the
 * dash in the size column exists to avoid.
 */
export function sortEntries(
  entries: readonly ExplorerEntry[],
  sort: ExplorerSort,
): ExplorerEntry[] {
  const rank = (entry: ExplorerEntry) => (entry.type === 'dir' ? 0 : 1);
  const missingLast = (a: number | null, b: number | null, compare: (x: number, y: number) => number) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return compare(a, b);
  };
  return [...entries].sort((a, b) => {
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    if (sort === 'size') {
      const bySize = missingLast(a.sizeBytes, b.sizeBytes, (x, y) => y - x);
      if (bySize !== 0) return bySize;
    }
    if (sort === 'modified') {
      const at = a.modifiedAt === null ? null : Date.parse(a.modifiedAt);
      const bt = b.modifiedAt === null ? null : Date.parse(b.modifiedAt);
      const byTime = missingLast(
        Number.isNaN(at as number) ? null : at,
        Number.isNaN(bt as number) ? null : bt,
        (x, y) => y - x,
      );
      if (byTime !== 0) return byTime;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Case-insensitive substring match on the display name. */
export function filterEntries(
  entries: readonly ExplorerEntry[],
  query: string,
): ExplorerEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/**
 * What an import is doing, in words plus real counts. The phase matters: the
 * checksum pass runs before any upload, so an import that showed only
 * "0 of 1208" would look wedged for its slowest stretch.
 */
export function importCaption(progress: FolderImportProgress): string {
  const { phase, filesDone, filesTotal } = progress;
  if (phase === 'hashing') return `Checking ${filesTotal} file${filesTotal === 1 ? '' : 's'}…`;
  if (phase === 'starting') return 'Reserving a destination on the node…';
  if (phase === 'finishing') return 'Linking the project…';
  return `${filesDone} of ${filesTotal} file${filesTotal === 1 ? '' : 's'} · ${formatSize(progress.bytesDone)} of ${formatSize(progress.bytesTotal)}`;
}

type Listing =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; listing: ExplorerListing };

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------


/**
 * One tree row, and its children once expanded.
 *
 * MODULE SCOPE, not nested in the screen. Declared inside `FilesExplorerScreen`
 * this was a NEW function identity on every render, so React saw a new element
 * type and unmounted/remounted the entire subtree on any state change — typing
 * one character in the filter box rebuilt every node. The visible cost was
 * keyboard focus: pressing a twisty destroyed the button being pressed and
 * dropped focus to `document.body`, ejecting a keyboard or screen-reader user
 * to the top of the document on every expand. In the one component whose whole
 * purpose is announcing structure correctly.
 *
 * Children are fetched ON EXPAND and cached by path, so opening a tree does not
 * fan out a request per directory before the user has asked for any of them — a
 * project root with 200 folders would otherwise storm the node on a mode
 * switch. A failed load renders as a retryable row rather than a silently empty
 * branch, because "this folder is empty" and "we could not read this folder"
 * are different facts.
 */
function TreeNode({
  entry,
  depth,
  expanded,
  branches,
  renderRow,
  onToggle,
  onRetry,
}: {
  entry: ExplorerEntry;
  depth: number;
  expanded: ReadonlySet<string>;
  branches: Record<string, ExplorerEntry[] | 'loading' | 'error'>;
  renderRow: (entry: ExplorerEntry) => React.ReactNode;
  onToggle: (entry: ExplorerEntry) => void;
  onRetry: (entry: ExplorerEntry) => void;
}) {
  const open = expanded.has(entry.path);
  const children = branches[entry.path];
  if (entry.type !== 'dir') {
    return (
      <li role="treeitem" aria-selected={false} className="fx-tree-item" style={{ '--fx-depth': depth } as never}>
        {renderRow(entry)}
      </li>
    );
  }
  return (
    <li
      role="treeitem"
      aria-selected={false}
      aria-expanded={open}
      className="fx-tree-item"
      style={{ '--fx-depth': depth } as never}
    >
      <span className="fx-tree-row">
        <button
          type="button"
          className="fx-twisty"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.name}`}
          onClick={() => onToggle(entry)}
        >
          {open ? '▾' : '▸'}
        </button>
        {renderRow(entry)}
      </span>
      {open ? (
        <ul role="group" className="fx-list">
          {children === 'loading' ? (
            <li className="fx-empty">Loading…</li>
          ) : children === 'error' ? (
            <li className="fx-empty">
              Could not read {entry.name}.{' '}
              <button type="button" onClick={() => onRetry(entry)}>Retry</button>
            </li>
          ) : children && children.length === 0 ? (
            <li className="fx-empty">Empty.</li>
          ) : (
            (children ?? []).map((child) => (
              <TreeNode
                key={`${child.type}:${child.path}`}
                entry={child}
                depth={depth + 1}
                expanded={expanded}
                branches={branches}
                renderRow={renderRow}
                onToggle={onToggle}
                onRetry={onRetry}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function FilesExplorerScreen({ port, onNotice }: FilesExplorerScreenProps) {
  const [roots, setRoots] = useState<ExplorerRoot[] | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<ExplorerMode>('list');
  const [sort, setSort] = useState<ExplorerSort>('name');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [branches, setBranches] = useState<Record<string, ExplorerEntry[] | 'loading' | 'error'>>({});
  const [filter, setFilter] = useState('');
  const [trashTab, setTrashTab] = useState(false);
  const [listing, setListing] = useState<Listing>({ phase: 'loading' });
  const [preview, setPreview] = useState<ExplorerEntry | null>(null);
  const [renaming, setRenaming] = useState<ExplorerEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [conflictAsk, setConflictAsk] = useState<{ picked: PickedFile[]; count: number } | null>(null);
  const [queueSnap, setQueueSnap] = useState<UploadQueueSnapshot | null>(null);
  const [imports, setImports] = useState<
    Array<{ rootName: string; cancel: () => void; progress: FolderImportProgress }>
  >([]);
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
  // Reloadable, not mount-only: a successful folder import links a NEW
  // project root, and a rail that reads roots once renders that success as
  // silence — the connected project stays missing until a full remount.
  const rootsSeq = useRef(0);
  const loadRoots = useCallback(() => {
    const seq = ++rootsSeq.current;
    port
      .roots()
      .then((r) => {
        if (rootsSeq.current !== seq) return;
        setRoots(r);
        setRootsError(null);
        setActiveRootId((current) => current ?? r[0]?.id ?? null);
      })
      .catch(() => rootsSeq.current === seq && setRootsError('Could not load the file roots. Retry.'));
  }, [port]);
  useEffect(() => {
    loadRoots();
  }, [loadRoots]);

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
    // Branches belong to the directory that was open when they were read; a
    // new root, path or tab makes them stale rather than merely unused.
    setExpanded(new Set());
    setBranches({});
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
        onNotice?.(port.importFolderBlockedReason ?? EXPLORER_REASONS.FOLDER_IMPORT_UNAVAILABLE);
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
        setImports((current) => [
          ...current,
          { rootName, cancel: task.cancel, progress: task.progress() },
        ]);
        // The denominator is known, so the ledger reports counts rather than
        // an indeterminate spinner. See folder-import.ts for why this is not
        // the fake-percentage the single-file queue refuses to draw.
        task.subscribe((progress) =>
          setImports((current) =>
            current.map((item) => (item.cancel === task.cancel ? { ...item, progress } : item)),
          ),
        );
        void task.result
          .then(({ replacedCount, merged }) => {
            onNotice?.(
              merged
                ? `Merged into ${rootName} — ${replacedCount} existing file${replacedCount === 1 ? '' : 's'} replaced.`
                : `Imported ${rootName} as a linked project.`,
            );
            refresh();
            loadRoots();
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
    [upload, port, onNotice, refresh, loadRoots],
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

  /**
   * Save a project file's bytes. A truncated read is REFUSED rather than
   * written: a download that silently produces the first 5 MB of a 200 MB
   * file is worse than one that does not happen, because nothing about the
   * saved file says it is incomplete. The folder zip streams past that
   * ceiling, so the refusal points there.
   */
  const downloadEntryBytes = useCallback(
    async (entry: ExplorerEntry) => {
      if (!port.readBytes) return;
      try {
        const bytes = await port.readBytes(entry);
        if (bytes.truncated) {
          onNotice?.(EXPLORER_REASONS.DOWNLOAD_TOO_LARGE);
          return;
        }
        const url = URL.createObjectURL(bytes.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = entry.name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (error) {
        onNotice?.(
          error instanceof Error && error.message
            ? `Download: ${error.message}`
            : 'Download failed.',
        );
      }
    },
    [port, onNotice],
  );

  const loadBranch = useCallback(
    async (entry: ExplorerEntry) => {
      if (!activeRoot) return;
      setBranches((current) => ({ ...current, [entry.path]: 'loading' }));
      try {
        const listing = await port.list(activeRoot, entry.path, { trashed: trashTab });
        setBranches((current) => ({ ...current, [entry.path]: listing.entries }));
      } catch {
        setBranches((current) => ({ ...current, [entry.path]: 'error' }));
      }
    },
    [port, activeRoot, trashTab],
  );

  const toggleBranch = useCallback(
    (entry: ExplorerEntry) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) {
          next.delete(entry.path);
          return next;
        }
        next.add(entry.path);
        return next;
      });
      // Fetch once per path; a re-expand reuses what is already cached.
      if (branches[entry.path] === undefined) void loadBranch(entry);
    },
    [branches, loadBranch],
  );

  const archiveHrefFor = useCallback(
    (target: ExplorerEntry | ExplorerRoot) => port.archiveHref?.(target) ?? null,
    [port],
  );

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
          ) : entry.type === 'file' && port.readBytes ? (
            // A project file has no URL (§4.4): its bytes come back as a DTO
            // and are saved from a Blob. Same glyph, because to the user it is
            // the same verb — the transport difference is ours, not theirs.
            <button
              type="button"
              className="fx-act"
              aria-label={`Download ${entry.name}`}
              onClick={() => void downloadEntryBytes(entry)}
            >
              ↓
            </button>
          ) : null}
          {entry.type === 'dir' && archiveHrefFor(entry) ? (
            <a
              className="fx-act"
              href={archiveHrefFor(entry)!}
              aria-label={`Download ${entry.name} as a zip archive`}
              title="Download as zip"
            >
              🗜
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
    const all = listing.listing.entries;
    if (all.length === 0) {
      // The library's own empty state names what the library IS and the one
      // move that fills it — a new space lands here with nothing, and "this
      // folder is empty" alone leaves a user unsure what the library even holds.
      const emptyText = trashTab
        ? 'Trash is empty — nothing has been deleted here.'
        : activeRoot.kind === 'library' && path === ''
          ? 'Your library is empty. It holds files shared across this space — drop files here or use Upload files above to add the first. A linked project’s code lives under its own root, not here.'
          : 'This folder is empty. Nothing is hidden; there is nothing to show yet.';
      return (
        <p className="fx-empty" data-testid="fx-measured-empty">
          {emptyText}
        </p>
      );
    }
    const entries = sortEntries(filterEntries(all, filter), sort);
    // A filter that hides everything is a DIFFERENT state from an empty
    // folder, and says so — otherwise the user reads their own typing as
    // "this folder is empty" and goes looking for missing files.
    if (entries.length === 0) {
      return (
        <div className="fx-empty" data-testid="fx-filtered-empty">
          <p>Nothing here matches “{filter}”. {all.length} item{all.length === 1 ? '' : 's'} hidden by the filter.</p>
          <button type="button" onClick={() => setFilter('')}>Clear filter</button>
        </div>
      );
    }
    if (mode === 'gallery') {
      return (
        <ul className="fx-gallery" aria-label="Files, gallery">
          {/* Directories are TILES here, not omissions. Filtering them out
              made gallery the one mode a folder could not be opened from,
              so switching to it silently stranded the user at whatever
              depth they had reached. */}
          {entries.map((entry) => {
            const href = isImage(entry) ? port.downloadHref(entry) : null;
            return (
              <li key={`${entry.type}:${entry.path}`} className="fx-tile">
                <button
                  type="button"
                  className="fx-tile-btn"
                  onClick={() => (entry.type === 'dir' ? setPath(entry.path) : setPreview(entry))}
                  aria-label={entry.type === 'dir' ? `Open ${entry.name}` : `Preview ${entry.name}`}
                >
                  {href ? (
                    <img className="fx-thumb" src={href} alt="" />
                  ) : (
                    <span className="fx-thumb fx-thumb-none" aria-hidden="true">
                      {entry.type === 'dir' ? '📁' : '⬚'}
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
      // A REAL tree. This used to render the same single-level listing with
      // `role="tree"` on it — no nesting, no expansion — which is worse than
      // a plain list, because a screen reader announces "tree" and then
      // reports every item at level 1 with nothing to expand.
      return (
        <ul role="tree" aria-label="Folder tree" className="fx-list">
          {entries.map((entry) => (
            <TreeNode
              key={`${entry.type}:${entry.path}`}
              entry={entry}
              depth={0}
              expanded={expanded}
              branches={branches}
              renderRow={entryRowInner}
              onToggle={toggleBranch}
              onRetry={(e) => void loadBranch(e)}
            />
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
        {/* When no project is linked there is only the Library root, and nothing
            on this screen says a project can be here at all. Name what a project
            root is and the real way to add one — folder import when the node
            serves it, otherwise the CLI, which always works. */}
        {roots !== null && !roots.some((r) => r.kind === 'project') ? (
          <p className="fx-note fx-roots-hint" data-testid="fx-no-projects">
            Link a project and its files appear here as their own root to browse.{' '}
            {port.importFolder
              ? 'Use “Import folder” to bring a local folder in as a linked project, '
              : ''}
            {port.importFolder ? 'or link ' : 'Link '}an existing one from the CLI:{' '}
            <code className="fx-code">tm8 project link &lt;project-id&gt; --space &lt;space&gt;</code>.
          </p>
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
          <input
            className="fx-filter"
            type="search"
            value={filter}
            placeholder="Filter this folder…"
            aria-label="Filter this folder by name"
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          <div className="fx-tools" role="group" aria-label="Sort">
            {(['name', 'size', 'modified'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className="fx-tool"
                aria-pressed={sort === key}
                onClick={() => setSort(key)}
              >
                {key}
              </button>
            ))}
          </div>
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
                title={port.importFolderBlockedReason ?? EXPLORER_REASONS.FOLDER_IMPORT_UNAVAILABLE}
              >
                Import folder
              </button>
            ) : null}
            {activeRoot && archiveHrefFor(activeRoot) ? (
              <a
                className="fx-tool"
                href={archiveHrefFor(activeRoot)!}
                title="Download this whole project as a zip"
              >
                Download zip
              </a>
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
                  <span className="fx-queue-name">{item.rootName}</span>
                  <span className="fx-queue-status">{importCaption(item.progress)}</span>
                  <progress
                    className="fx-progress"
                    aria-label={`Import progress for ${item.rootName}`}
                    max={item.progress.bytesTotal || 1}
                    value={item.progress.bytesDone}
                  />
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
                Uploads — {queueSnap.done} of {queueSnap.items.length} done
                {queueSnap.bytesTotal > 0
                  ? ` · ${formatSize(queueSnap.bytesDone)} of ${formatSize(queueSnap.bytesTotal)}`
                  : ''}
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
          <PreviewBody entry={preview} port={port} />
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
