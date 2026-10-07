/**
 * THE READ-ONLY VIEWER of one project file (mockup v2): a breadcrumb that
 * starts with the project name, then the body for what the read returned —
 * highlighted, line-numbered source (CodeMirror, read-only), an image, or a
 * plain "no preview" card. No editing, no diagnostics.
 *
 * Every failure is a sentence, never a crash: the seam without project files,
 * a file gone from disk, a project disconnected since the tab was opened.
 */
import { useEffect, useRef, useState } from 'react';
import type { ProjectFileReadResult, ProjectId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { mountReadOnlyEditor } from './codemirror';
import { LANGUAGE_LABELS, languageFor, type EditorLanguage } from './language';
import { baseName, folderSegments, toAbsolutePath, type ProjectFileTarget } from './paths';
import { projectRoot } from './projects';
import { formatBytes, viewerStateOf, type FileViewerState } from './viewerState';
import './project-file.css';

type Load =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; read: ProjectFileReadResult; requested: string; view: FileViewerState };

/** The sentence a failed read shows. */
export function readFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'not_implemented') return 'Project files are unavailable on this node.';
  if (code === 'not_found') return 'This file is no longer in the project, or the project is no longer connected.';
  if (code === 'forbidden') return 'You don’t have access to this project’s files.';
  if (code === 'unavailable' || code === 'project_unavailable') return 'The project folder isn’t reachable right now.';
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? `Couldn’t read this file: ${message}` : 'Couldn’t read this file.';
}

export interface ProjectFileViewerProps {
  seam: Pick<Seam, 'projectFiles'>;
  target: ProjectFileTarget;
  /** Null while the space's projects load. */
  projectName: string | null;
}

export function ProjectFileViewer({ seam, target, projectName }: ProjectFileViewerProps) {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const { projectId, path } = target;

  useEffect(() => {
    let alive = true;
    setLoad({ phase: 'loading' });
    (async () => {
      const files = seam.projectFiles;
      if (!files) throw Object.assign(new Error('unavailable'), { code: 'not_implemented' });
      const root = await projectRoot(seam, projectId);
      const requested = toAbsolutePath(root.workingDir, root.separator, path);
      const read = await files.read(projectId as ProjectId, requested);
      return { read, requested };
    })().then(
      ({ read, requested }) => {
        if (alive) setLoad({ phase: 'ready', read, requested, view: viewerStateOf(read) });
      },
      (error: unknown) => {
        if (alive) setLoad({ phase: 'failed', message: readFailureMessage(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [seam, projectId, path, attempt]);

  const name = baseName(path);
  const ready = load.phase === 'ready' ? load : null;
  const language = ready && ready.view.kind === 'text' ? languageFor(name, ready.read.mime) : null;

  return (
    <div className="pf-viewer" data-testid="project-file-viewer" data-state={ready ? ready.view.kind : load.phase}>
      <div className="pf-crumb">
        <nav className="pf-crumb-path" aria-label="File path">
          <span className="pf-crumb-project">{projectName ?? 'Project'}</span>
          {folderSegments(path).map((segment, i) => (
            <span key={i} className="pf-crumb-seg">
              <span className="pf-crumb-sep" aria-hidden="true">›</span>
              {segment}
            </span>
          ))}
          <span className="pf-crumb-sep" aria-hidden="true">›</span>
          <b className="pf-crumb-name">{name}</b>
        </nav>
        <span className="pf-crumb-gap" />
        {language ? <span className="pf-chip" data-lang="">{LANGUAGE_LABELS[language]}</span> : null}
        {ready ? <span className="pf-chip">{formatBytes(ready.read.sizeBytes)}</span> : null}
        <span className="pf-chip">Read-only</span>
        <CopyPath path={path} />
      </div>
      {ready && ready.read.path !== ready.requested ? (
        <p className="pf-note">Resolves to {ready.read.path}</p>
      ) : null}
      {load.phase === 'loading' ? (
        <p className="pf-empty" role="status">Loading {name}…</p>
      ) : load.phase === 'failed' ? (
        <div className="pf-empty" role="alert">
          <div>
            <b>{name} can’t be shown</b>
            <span>{load.message}</span>
            <button type="button" className="pf-button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <ViewerBody name={name} read={load.read} view={load.view} language={language ?? 'plain'} />
      )}
    </div>
  );
}

function ViewerBody({
  name,
  read,
  view,
  language,
}: {
  name: string;
  read: ProjectFileReadResult;
  view: FileViewerState;
  language: EditorLanguage;
}) {
  if (view.kind === 'text') {
    return (
      <>
        {view.cutAt !== null ? (
          <p className="pf-banner" role="note">
            Showing the first {formatBytes(view.cutAt)} of this file. It’s {formatBytes(read.sizeBytes)}, so it was cut off at{' '}
            {formatBytes(view.cutAt)}.
          </p>
        ) : null}
        <CodeView text={view.text} language={language} />
      </>
    );
  }
  if (view.kind === 'image') return <ImageView name={name} mime={view.mime} base64={view.base64} />;
  return (
    <div className="pf-empty">
      <div>
        <b>{view.kind === 'tooLarge' ? `${name} is too large to show` : 'No preview for this file type'}</b>
        <span>
          {read.mime} · {formatBytes(read.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

/** Read-only CodeMirror: highlighted source with line numbers. */
export function CodeView({ text, language }: { text: string; language: EditorLanguage }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let alive = true;
    let editor: { destroy(): void } | null = null;
    void mountReadOnlyEditor(parent, text, language).then((mounted) => {
      if (alive) editor = mounted;
      else mounted.destroy();
    });
    return () => {
      alive = false;
      editor?.destroy();
    };
  }, [text, language]);
  return <div ref={host} className="pf-code" data-testid="project-file-code" data-language={language} />;
}

function ImageView({ name, mime, base64 }: { name: string; mime: string; base64: string }) {
  const [fit, setFit] = useState(true);
  return (
    <div className="pf-image" data-fit={fit || undefined}>
      <div className="pf-image-tools">
        <button type="button" className="pf-button" aria-pressed={fit} onClick={() => setFit(true)}>
          Fit
        </button>
        <button type="button" className="pf-button" aria-pressed={!fit} onClick={() => setFit(false)}>
          100%
        </button>
      </div>
      {/* `rendererFor` never says image for SVG, so this is always a raster. */}
      <img src={`data:${mime};base64,${base64}`} alt={name} />
    </div>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="pf-button"
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy path'}
    </button>
  );
}
