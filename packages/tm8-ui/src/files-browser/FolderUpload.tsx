import { useCallback, useRef, useState, type DragEvent, type InputHTMLAttributes } from 'react';

import { DisabledAction } from '../panels';
import {
  SKIP_REASON_TEXT,
  UploadCancelled,
  byteLabel,
  countLabel,
  packFolder,
  type PackProgress,
} from './archive';
import {
  filesFromInput,
  folderFromDataTransfer,
  folderFromInput,
  type PickedFolder,
} from './picked-folder';
import {
  FOLDER_UPLOAD_UNAVAILABLE,
  UPLOAD_INTO_PROJECT_REFUSED,
  UPLOAD_NEEDS_SPACE,
} from './reasons';
import type { SpaceFoldersPort, SpaceFolderUploadResult } from './space-folders';
import { ZipTooLargeError } from './zip';

/**
 * FILE OR FOLDER UPLOAD, AND PROGRESS THAT DOES NOT LIE.
 *
 * THE DROP BUG THIS DOES NOT REPRODUCE: `event.dataTransfer.files` is EMPTY for
 * a dropped directory, so the obvious implementation accepts the drop and does
 * nothing, forever, silently. The walk lives in `picked-folder.ts`; the point
 * here is that the drop handler never touches `.files`.
 *
 * THE FIRST FOLDER IS REACHABLE. Review finding, and it was a real dead end:
 * an earlier draft required an existing Space folder as the destination, so a
 * Space that had none could never acquire one from this screen. Uploading with
 * no destination selected CREATES the folder — `create` then `upload` at the
 * root — and works in a Space that has only linked projects, or nothing at all.
 * Uploading INTO a live project is still refused, because that would write to
 * the disk the agents are working on; making a snapshot is a different act and
 * is offered instead of that refusal, not behind it.
 *
 * THE THREE NUMBERS. A progress line that shows only a percentage cannot be
 * checked by the person reading it. This one names FILES and BYTES at every
 * stage, and the stages are distinct because they fail differently: reading the
 * folder off the disk, packing it, and sending it are three different waits and
 * a user told "uploading" during the first has been misinformed about what to
 * blame when it is slow.
 *
 * THE RESULT IS NOT A CHECKMARK. `added` and `replaced` are shown separately —
 * a re-upload that replaces two thousand files and adds none is a different
 * event from one that adds two thousand — and everything skipped is rendered,
 * grouped by reason, from BOTH sides: the paths this page refused to archive
 * and the paths the node refused to expand. Including when there are none,
 * because "nothing was skipped" is worth stating once the user knows skipping
 * happens.
 */

/** `webkitdirectory` is not in React's prop types; it is still how the button path works. */
const DIRECTORY_ATTRS = {
  webkitdirectory: '',
  directory: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>;

type Stage =
  | { phase: 'idle' }
  | { phase: 'scanning'; source: PickedFolder['source'] }
  | { phase: 'packing'; progress: PackProgress }
  | { phase: 'creating'; name: string }
  | { phase: 'sending'; files: number; dirs: number; archiveBytes: number; sent: number | null }
  | {
      phase: 'done';
      result: SpaceFolderUploadResult;
      sentFiles: number;
      localSkips: readonly { path: string; reason: string }[];
      source: PickedFolder['source'];
      created: boolean;
    }
  | { phase: 'cancelled' }
  | { phase: 'not-a-folder' }
  | { phase: 'failed'; message: string };

export interface FolderUploadProps {
  /** Absent until the seam carries the group. Absence is drawn, not hidden. */
  port?: SpaceFoldersPort;
  /** Owner of any folder this creates. Without it nothing can be created. */
  spaceId?: string;
  /**
   * An existing Space folder to upload INTO. `null` means "create a new one",
   * which is the state a Space with no folders is permanently in.
   */
  destination: { id: string; name: string } | null;
  /** True when a LIVE project root is selected, so the refusal can be stated. */
  projectRootSelected?: boolean;
  onUploaded?: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof ZipTooLargeError) return error.message;
  return error instanceof Error ? error.message : 'The upload did not complete.';
}

export function FolderUpload({
  port,
  spaceId,
  destination,
  projectRootSelected = false,
  onUploaded,
}: FolderUploadProps) {
  const [stage, setStage] = useState<Stage>({ phase: 'idle' });
  const [over, setOver] = useState(false);
  const [newName, setNewName] = useState('');
  const abort = useRef<AbortController | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const filesInput = useRef<HTMLInputElement | null>(null);

  const run = useCallback(
    async (picked: PickedFolder | null) => {
      if (!port) return;
      if (picked === null || picked.files.length + picked.directories.length === 0) {
        setStage({ phase: 'not-a-folder' });
        return;
      }
      const controller = new AbortController();
      abort.current = controller;
      try {
        setStage({ phase: 'scanning', source: picked.source });
        const packed = await packFolder(picked, {
          signal: controller.signal,
          onProgress: (progress) => setStage({ phase: 'packing', progress }),
        });

        let folderId = destination?.id;
        const created = folderId === undefined;
        if (folderId === undefined) {
          if (spaceId === undefined) throw new Error('No Space is selected, so no folder can be created.');
          const name = newName.trim() || picked.rootName;
          setStage({ phase: 'creating', name });
          folderId = (await port.create(spaceId, name)).id;
        }

        const archiveBytes = packed.archive.size;
        setStage({
          phase: 'sending',
          files: packed.includedFiles,
          dirs: packed.includedDirectories,
          archiveBytes,
          sent: null,
        });
        /* destPath is '' — the coordinator's seam ruling, 2026-08-09: an
           stored Space-folder root expands at its own root and the picked
           folder's NAME is not part of the destination. Archive members are
           already folder-relative (`picked-folder.ts` strips the root segment),
           so the tree lands where the user named it rather than one level
           deeper inside a directory they never asked for. */
        const result = await port.upload(folderId, '', packed.archive, {
          signal: controller.signal,
          onProgress: (sent) =>
            setStage({
              phase: 'sending',
              files: packed.includedFiles,
              dirs: packed.includedDirectories,
              archiveBytes,
              sent,
            }),
        });
        setStage({
          phase: 'done',
          result,
          sentFiles: packed.includedFiles,
          localSkips: packed.skipped,
          source: picked.source,
          created,
        });
        onUploaded?.();
      } catch (error) {
        if (error instanceof UploadCancelled || controller.signal.aborted) {
          setStage({ phase: 'cancelled' });
        } else {
          setStage({ phase: 'failed', message: messageOf(error) });
        }
      } finally {
        abort.current = null;
      }
    },
    [destination, newName, onUploaded, port, spaceId],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setOver(false);
      // NOTE: `event.dataTransfer.files` is deliberately never read — it is
      // empty for a directory, which is the whole bug.
      void folderFromDataTransfer(event.dataTransfer).then(run);
    },
    [run],
  );

  if (!port) {
    return (
      <div className="fb-upload fb-upload-off" data-testid="folder-upload">
        <DisabledAction reason={FOLDER_UPLOAD_UNAVAILABLE} label="Upload files or a folder">
          Upload files or a folder
        </DisabledAction>
      </div>
    );
  }

  if (destination === null && spaceId === undefined) {
    return (
      <div className="fb-upload fb-upload-off" data-testid="folder-upload">
        <DisabledAction reason={UPLOAD_NEEDS_SPACE} label="Upload files or a folder">
          Upload files or a folder
        </DisabledAction>
      </div>
    );
  }

  const busy =
    stage.phase === 'scanning' || stage.phase === 'packing' ||
    stage.phase === 'creating' || stage.phase === 'sending';

  return (
    <div className="fb-upload" data-testid="folder-upload">
      <div
        className={`fb-drop${over ? ' fb-drop-over' : ''}`}
        data-testid="folder-dropzone"
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {destination ? (
          <span className="fb-drop-text" data-testid="folder-dest-existing">
            Drop a folder here, or choose local files, to add them to the Space
            folder <strong>{destination.name}</strong>
          </span>
        ) : (
          <>
            <span className="fb-drop-text" data-testid="folder-dest-new">
              Drop a folder here, or choose local files, to upload them as a NEW
              Space folder — a snapshot this Space owns.
              {projectRootSelected ? (
                /* Stated where the user would otherwise assume the drop lands in
                   the project they are looking at. */
                <span data-testid="folder-not-into-project">
                  {' '}{UPLOAD_INTO_PROJECT_REFUSED.cause}. It is not written
                  into the linked project you are browsing; that folder is live
                  disk the agents are using.
                </span>
              ) : null}
            </span>
            <label className="fb-drop-name">
              <span>Name</span>
              <input
                type="text"
                data-testid="folder-new-name"
                value={newName}
                placeholder="taken from the folder you choose"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
          </>
        )}
        <input
          ref={folderInput}
          type="file"
          multiple
          className="fb-drop-input"
          data-testid="folder-pick-input"
          {...DIRECTORY_ATTRS}
          onChange={(event) => {
            void run(folderFromInput(event.target.files));
            // Re-picking the same folder must fire `change` again.
            event.target.value = '';
          }}
        />
        <input
          ref={filesInput}
          type="file"
          multiple
          className="fb-drop-input"
          data-testid="files-pick-input"
          onChange={(event) => {
            void run(filesFromInput(event.target.files));
            // Re-picking the same files must fire `change` again.
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="fb-btn"
          data-testid="folder-pick-button"
          disabled={busy}
          onClick={() => folderInput.current?.click()}
        >
          Choose a folder…
        </button>
        <button
          type="button"
          className="fb-btn"
          data-testid="files-pick-button"
          disabled={busy}
          onClick={() => filesInput.current?.click()}
        >
          Choose files…
        </button>
        {busy ? (
          <button
            type="button"
            className="fb-btn"
            data-testid="folder-cancel"
            onClick={() => abort.current?.abort()}
          >
            Cancel
          </button>
        ) : null}
      </div>

      <UploadStage stage={stage} />
    </div>
  );
}

function UploadStage({ stage }: { stage: Stage }) {
  switch (stage.phase) {
    case 'idle':
      return null;

    case 'scanning':
      return (
        <p className="fb-note" data-testid="upload-progress" aria-live="polite">
          {stage.source === 'files'
            ? 'Reading the selected files off the disk…'
            : 'Reading the folder off the disk…'}
        </p>
      );

    case 'packing':
      return (
        <p className="fb-note" data-testid="upload-progress" aria-live="polite">
          Packing {countLabel(stage.progress.filesPacked)} of{' '}
          {countLabel(stage.progress.totalFiles)} files ·{' '}
          {byteLabel(stage.progress.bytesPacked)} of {byteLabel(stage.progress.totalBytes)}
        </p>
      );

    case 'creating':
      return (
        <p className="fb-note" data-testid="upload-progress" aria-live="polite">
          Creating the Space folder “{stage.name}”…
        </p>
      );

    case 'sending':
      return (
        <p className="fb-note" data-testid="upload-progress" aria-live="polite">
          {/* An unreported byte count is stated as unknown rather than drawn as
              zero-of-total, which would look stalled rather than unmeasured. */}
          {stage.sent === null
            ? `Sending ${byteLabel(stage.archiveBytes)} · ${countLabel(stage.files)} files, ${countLabel(stage.dirs)} folders (no byte progress reported for this transfer)`
            : `Sending ${byteLabel(stage.sent)} of ${byteLabel(stage.archiveBytes)} · ${countLabel(stage.files)} files, ${countLabel(stage.dirs)} folders`}
        </p>
      );

    case 'cancelled':
      return (
        <p className="fb-note" data-testid="upload-cancelled">
          {/* MEASURED, not assumed: the transfer is a raw PUT and ingest runs
              transactionally only after the whole archive has arrived, so an
              aborted transfer expands nothing. Claiming "some of it may already
              be in there" would send the user hunting for partial members that
              cannot exist. */}
          Cancelled. The transfer was aborted before it finished, and the node
          expands an archive only once all of it has arrived — so the folder is
          unchanged.
        </p>
      );

    case 'not-a-folder':
      return (
        <p className="fb-note fb-note-bad" data-testid="upload-not-a-folder">
          That was not a folder. This control uploads a whole directory tree —
          drop a folder, use “Choose a folder…”, or use “Choose files…” for
          individual files.
        </p>
      );

    case 'failed':
      return (
        <p className="fb-note fb-note-bad" data-testid="upload-failed">
          {stage.message}
        </p>
      );

    case 'done':
      return (
        <UploadResult
          result={stage.result}
          sentFiles={stage.sentFiles}
          localSkips={stage.localSkips}
          source={stage.source}
          created={stage.created}
        />
      );
  }
}

function UploadResult({
  result,
  sentFiles,
  localSkips,
  source,
  created,
}: {
  result: SpaceFolderUploadResult;
  sentFiles: number;
  localSkips: readonly { path: string; reason: string }[];
  source: PickedFolder['source'];
  created: boolean;
}) {
  // Both sides of the refusal, in one list: this page's and the node's.
  const groups = new Map<string, string[]>();
  for (const entry of [...localSkips, ...result.skipped]) {
    const list = groups.get(entry.reason);
    if (list) list.push(entry.path);
    else groups.set(entry.reason, [entry.path]);
  }
  const landed = result.added + result.replaced;

  return (
    <div className="fb-upload-result" data-testid="upload-result">
      <p className="fb-note" data-testid="upload-expanded">
        {created ? `Created “${result.folder.name}”. ` : null}
        {countLabel(result.added)} added, {countLabel(result.replaced)} replaced,{' '}
        {countLabel(result.directories)} folders · the Space folder now holds{' '}
        {countLabel(result.folder.entryCount)} entries,{' '}
        {byteLabel(result.folder.totalSizeBytes)}
        {landed !== sentFiles ? (
          /* The headline and the send count disagreeing is itself the news. */
          <> — {countLabel(sentFiles)} files were sent.</>
        ) : null}
      </p>

      {source === 'picker' ? (
        /* A browser limitation, named where it costs the user something, rather
           than a silent difference between two controls that look equivalent. */
        <p className="fb-note" data-testid="upload-picker-limit">
          Chosen with the folder button: this browser API lists files only, so
          any EMPTY folder in the tree could not be seen and was not uploaded.
          Drag the folder onto this area instead to include them.
        </p>
      ) : null}

      {source === 'files' ? (
        <p className="fb-note" data-testid="upload-files-flat">
          Chosen as individual files: they were added at this Space folder's
          root, with no local directory structure.
        </p>
      ) : null}

      {groups.size === 0 ? (
        <p className="fb-note" data-testid="upload-skipped-none">
          Nothing was skipped.
        </p>
      ) : (
        <ul className="fb-skipped" data-testid="upload-skipped">
          {[...groups].map(([reason, paths]) => (
            <li key={reason} data-testid="upload-skipped-group" data-reason={reason}>
              <span className="fb-skipped-reason">
                {countLabel(paths.length)} skipped — {SKIP_REASON_TEXT[reason] ?? reason}
              </span>
              <ul className="fb-skipped-paths">
                {paths.slice(0, 20).map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
              {paths.length > 20 ? (
                <span className="fb-skipped-more">
                  …and {countLabel(paths.length - 20)} more
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
