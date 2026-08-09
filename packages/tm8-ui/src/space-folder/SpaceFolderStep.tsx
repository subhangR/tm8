import { useMemo, useRef, useState } from 'react';

import { isValidRootName, treeFromDataTransfer, treeFromFileList } from './pick';
import {
  DEFAULT_ACTIVE_RULE_IDS,
  DEFAULT_EXCLUSION_RULES,
  formatBytes,
  formatFiles,
  preflight,
  type PickedFile,
  type PickedTree,
} from './preflight';
import './space-folder.css';

/**
 * THE OPTIONAL STEP.
 *
 * Skipping is the default and costs one glance: the step is a single unchecked
 * line. A user who only wants a Space never opens it, and nothing about the
 * Space-creation form changes when they do not.
 */

export interface SpaceFolderSelection {
  /** The server-side root the user named. */
  readonly name: string;
  /** Exactly the files that will be sent, after visible exclusions. */
  readonly files: readonly PickedFile[];
  /** Empty directories to recreate; only a drop can observe these. */
  readonly directories: readonly string[];
}

export interface SpaceFolderProgress {
  readonly phase: 'packing' | 'sending';
  readonly packedFiles: number;
  readonly totalFiles: number;
  readonly sentBytes: number;
  readonly totalBytes: number;
}

/**
 * Lane B's counts, unrenamed. It returns `added`/`replaced`/`directories` and
 * the folder's own `entryCount`/`totalSizeBytes` — there is no single
 * "uploaded N bytes" number, and inventing one would be this lane making up a
 * figure the server never reported.
 */
export interface SpaceFolderOutcome {
  readonly name: string;
  readonly added: number;
  readonly replaced: number;
  readonly directories: number;
  readonly entryCount: number;
  readonly totalSizeBytes: number;
  readonly skipped: readonly { path: string; reason: string }[];
}

export interface SpaceFolderStepProps {
  /** Non-null when Lane B's `seam.spaceFolders` is absent on this node. */
  readonly unavailableReason: string | null;
  readonly disabled: boolean;
  /** Emitted on every change; null means "nothing will be uploaded". */
  onChange(selection: SpaceFolderSelection | null): void;
  readonly progress: SpaceFolderProgress | null;
  readonly outcome: SpaceFolderOutcome | null;
  onCancel?(): void;
}

export function SpaceFolderStep(props: SpaceFolderStepProps) {
  const unavailable = props.unavailableReason !== null;
  const [enabled, setEnabled] = useState(false);
  const [tree, setTree] = useState<PickedTree | null>(null);
  const [rootName, setRootName] = useState('');
  const [activeRuleIds, setActiveRuleIds] = useState<readonly string[]>(DEFAULT_ACTIVE_RULE_IDS);
  const [pickError, setPickError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const report = useMemo(
    () => (tree ? preflight(tree, activeRuleIds) : null),
    [tree, activeRuleIds],
  );

  const validName = isValidRootName(rootName);

  // The parent is told the RESOLVED selection, never the raw pick, so the saga
  // can never send a file the preflight said was excluded.
  const publish = (
    nextTree: PickedTree | null,
    nextRules: readonly string[],
    nextName: string,
  ) => {
    if (!nextTree) {
      props.onChange(null);
      return;
    }
    const next = preflight(nextTree, nextRules);
    if (next.includedFiles === 0 || !isValidRootName(nextName)) {
      props.onChange(null);
      return;
    }
    props.onChange({
      name: nextName.trim(),
      files: next.included,
      directories: next.includedEmptyDirectories,
    });
  };

  const adoptTree = (next: PickedTree | null, failure: string | null) => {
    setPickError(failure);
    if (!next) {
      if (failure) {
        setTree(null);
        publish(null, activeRuleIds, rootName);
      }
      return;
    }
    if (next.files.length === 0) {
      setTree(null);
      setPickError('That folder has no files in it, so there is nothing to upload.');
      publish(null, activeRuleIds, rootName);
      return;
    }
    const name = rootName || next.rootName;
    setTree(next);
    setRootName(name);
    publish(next, activeRuleIds, name);
  };

  const onFiles = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) {
      adoptTree(null, 'No files came back from that folder.');
      return;
    }
    adoptTree(treeFromFileList(files), null);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (props.disabled) return;
    // A dropped DIRECTORY is not in `dataTransfer.files`; only
    // `webkitGetAsEntry()` sees it, and the entries die with the event, so the
    // walk is started before any await.
    void treeFromDataTransfer(event.dataTransfer)
      .then((next) => {
        if (next) adoptTree(next, null);
        else adoptTree(null, 'Drop a folder — a single file is not a folder upload.');
      })
      .catch((cause) => adoptTree(null, String((cause as { message?: unknown })?.message ?? cause)));
  };

  const toggleRule = (id: string, on: boolean) => {
    const next = on ? [...activeRuleIds, id] : activeRuleIds.filter((each) => each !== id);
    setActiveRuleIds(next);
    publish(tree, next, rootName);
  };

  const clear = () => {
    setTree(null);
    setRootName('');
    setPickError(null);
    if (inputRef.current) inputRef.current.value = '';
    publish(null, activeRuleIds, '');
  };

  const toggleStep = (on: boolean) => {
    setEnabled(on);
    if (!on) clear();
  };

  return (
    <section className="space-folder" aria-labelledby="space-folder-title">
      <label className="space-folder__toggle">
        <input
          id="space-folder-enable"
          type="checkbox"
          checked={enabled}
          disabled={unavailable || props.disabled}
          onChange={(event) => toggleStep(event.target.checked)}
        />
        <span>
          <strong id="space-folder-title">Also upload a folder into this Space</strong>
          <small>Optional. Leave this off and the Space is created exactly as before.</small>
        </span>
      </label>

      {unavailable ? (
        <p className="space-folder__note" role="note">{props.unavailableReason}</p>
      ) : null}

      {enabled && !unavailable ? (
        <div className="space-folder__body">
          <p className="space-folder__note">
            The folder is stored as a snapshot owned by this Space. It is not a
            connected project folder on disk, and editing files here later will not change it.
          </p>

          <div
            className={dragOver ? 'space-folder__drop space-folder__drop--over' : 'space-folder__drop'}
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            data-testid="space-folder-drop"
          >
            <label htmlFor="space-folder-input">Choose a folder</label>
            <input
              id="space-folder-input"
              ref={inputRef}
              type="file"
              multiple
              disabled={props.disabled}
              onChange={(event) => onFiles(event.target.files)}
              // React has no typed prop for these; a directory picker needs the
              // attribute present, and `directory` is the non-WebKit spelling.
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
            <small>…or drop a folder here.</small>
          </div>

          {pickError ? <p className="space-folder__error" role="alert">{pickError}</p> : null}

          {tree && report ? (
            <>
              <label className="space-folder__name">
                <span>Name for the folder in this Space</span>
                <input
                  value={rootName}
                  disabled={props.disabled}
                  onChange={(event) => {
                    setRootName(event.target.value);
                    publish(tree, activeRuleIds, event.target.value);
                  }}
                />
              </label>
              {rootName && !validName ? (
                <p className="space-folder__error" role="alert">
                  Use one folder name without slashes.
                </p>
              ) : null}

              <fieldset className="space-folder__rules">
                <legend>Leave these out</legend>
                {DEFAULT_EXCLUSION_RULES.map((rule) => {
                  const hit = report.excludedGroups.find((group) => group.ruleId === rule.id);
                  return (
                    <label key={rule.id}>
                      <input
                        type="checkbox"
                        checked={activeRuleIds.includes(rule.id)}
                        disabled={props.disabled}
                        onChange={(event) => toggleRule(rule.id, event.target.checked)}
                      />
                      <span>{rule.label}</span>
                      {hit ? (
                        <em data-testid={`space-folder-excluded-${rule.id}`}>
                          −{formatFiles(hit.files)}, {formatBytes(hit.bytes)}
                        </em>
                      ) : null}
                    </label>
                  );
                })}
              </fieldset>

              <dl className="space-folder__preflight" data-testid="space-folder-preflight">
                <div>
                  <dt>Picked</dt>
                  <dd>
                    {tree.rootName ? `${tree.rootName} — ` : ''}
                    {formatFiles(report.totalFiles)}, {formatBytes(report.totalBytes)}
                  </dd>
                </div>
                <div>
                  <dt>Will be sent</dt>
                  <dd data-testid="space-folder-included">
                    {formatFiles(report.includedFiles)}, {formatBytes(report.includedBytes)}
                  </dd>
                </div>
                <div>
                  <dt>Left out</dt>
                  <dd data-testid="space-folder-excluded-total">
                    {report.excludedFiles === 0
                      ? 'Nothing — the whole folder will be sent.'
                      : `${formatFiles(report.excludedFiles)}, ${formatBytes(report.excludedBytes)}`}
                  </dd>
                </div>
                <div>
                  <dt>Empty folders</dt>
                  <dd data-testid="space-folder-empty-dirs">
                    {report.emptyDirectoriesObservable
                      ? (report.includedEmptyDirectories.length === 0
                        ? 'None in this folder.'
                        : `${report.includedEmptyDirectories.length} will be recreated.`)
                      : 'Not knowable from a folder picker — the browser hides folders that contain no files, so any empty folder will be missing. Drop the folder instead to keep them.'}
                  </dd>
                </div>
              </dl>

              {report.refused.length > 0 ? (
                <div className="space-folder__refused">
                  <p className="space-folder__error" role="alert">
                    {formatFiles(report.refused.length)} refused and will not be sent — their paths
                    could not be used as given, and rewriting them would put your files somewhere
                    you did not choose:
                  </p>
                  <ul aria-label="Refused paths">
                    {report.refused.map((entry) => (
                      <li key={entry.path}><code>{entry.path}</code> — {entry.reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {report.includedFiles === 0 ? (
                <p className="space-folder__error" role="alert">
                  Every file is excluded, so nothing would be sent. Uncheck a rule above to
                  include some, or turn this step off.
                </p>
              ) : null}

              <button
                type="button"
                className="space-folder__clear"
                onClick={clear}
                disabled={props.disabled}
              >
                Remove this folder
              </button>
              {!validName && report.includedFiles > 0 ? (
                <p className="space-folder__note">
                  Name the folder to include it; the Space is still created without it.
                </p>
              ) : null}
            </>
          ) : null}

          {props.progress ? (
            <div className="space-folder__progress" role="status" data-testid="space-folder-progress">
              <p>
                {props.progress.phase === 'packing'
                  ? `Packing ${props.progress.packedFiles} of ${props.progress.totalFiles} files…`
                  : `Sending ${formatBytes(props.progress.sentBytes)} of ${formatBytes(props.progress.totalBytes)} — ${formatFiles(props.progress.totalFiles)}`}
              </p>
              <progress
                max={props.progress.phase === 'packing' ? props.progress.totalFiles : props.progress.totalBytes}
                value={props.progress.phase === 'packing' ? props.progress.packedFiles : props.progress.sentBytes}
              />
              {props.onCancel ? (
                <button type="button" onClick={props.onCancel}>Cancel upload</button>
              ) : null}
            </div>
          ) : null}

          {props.outcome ? (
            <div className="space-folder__outcome" data-testid="space-folder-outcome">
              <p>
                “{props.outcome.name}” now holds {formatFiles(props.outcome.entryCount)},{' '}
                {formatBytes(props.outcome.totalSizeBytes)}. This upload added{' '}
                {props.outcome.added}, replaced {props.outcome.replaced}, and created{' '}
                {props.outcome.directories} {props.outcome.directories === 1 ? 'folder' : 'folders'}.
              </p>
              {props.outcome.skipped.length > 0 ? (
                <>
                  <p className="space-folder__error" role="alert">
                    {formatFiles(props.outcome.skipped.length)} did not arrive:
                  </p>
                  <ul aria-label="Skipped files">
                    {props.outcome.skipped.map((skip) => (
                      <li key={skip.path}><code>{skip.path}</code> — {skip.reason}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
