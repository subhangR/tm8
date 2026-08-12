/**
 * THE PREVIEW BODY — one renderer set over one byte source.
 *
 * Split out of `FilesExplorerScreen` because it owns a resource with a
 * lifetime (an object URL) and an async load, and inlining that into a screen
 * that already owns eight pieces of state made the revoke path easy to get
 * wrong. A leaked object URL pins the whole blob in memory for the life of the
 * document, which for a folder of videos is exactly as bad as it sounds.
 *
 * The states are distinct on purpose — this component is the fix for a screen
 * that had ONE state ("no byte route") standing in for five different facts:
 *
 *   loading      · bytes are on the way
 *   no route     · genuinely unreachable — the only case that copy is true
 *   no renderer  · bytes are fine, the browser has no view for this type
 *   truncated    · a PREFIX rendered, and it says so rather than implying whole
 *   failed       · the read itself was refused, with the node's own reason
 */
import { useEffect, useState } from 'react';
import type { ExplorerEntry, FilesExplorerPort } from './port';
import { EXPLORER_REASONS } from './port';
import { MAX_PREVIEW_TEXT_BYTES, rendererFor, rendersAsSource } from './preview';

type Loaded =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; url: string; text: string | null; truncated: boolean };

export function PreviewBody({ entry, port }: { entry: ExplorerEntry; port: FilesExplorerPort }) {
  const href = port.downloadHref(entry);
  const canRead = typeof port.readBytes === 'function';
  const renderer = rendererFor(entry.mime);
  const [state, setState] = useState<Loaded>({ phase: 'loading' });

  useEffect(() => {
    // Nothing to fetch when there is no route at all, or no way to show it.
    if ((!href && !canRead) || renderer === null) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        // Library files go through fetch rather than straight into the tag so
        // both roots end up holding the same thing: a Blob. See preview.ts for
        // why an href is not enough (attachment disposition breaks <iframe>).
        const bytes = port.readBytes && entry.projectId
          ? await port.readBytes(entry)
          : await (async () => {
              const response = await fetch(href!, { credentials: 'include' });
              if (!response.ok) {
                throw new Error(
                  response.status === 401 || response.status === 403
                    ? 'You are not allowed to read this file.'
                    : `The node refused this file (${response.status}).`,
                );
              }
              return {
                blob: await response.blob(),
                mime: entry.mime ?? 'application/octet-stream',
                truncated: false,
              };
            })();
        if (cancelled) return;
        const asText = renderer === 'text' || rendersAsSource(bytes.mime);
        const text = asText
          ? await bytes.blob.slice(0, MAX_PREVIEW_TEXT_BYTES).text()
          : null;
        if (cancelled) return;
        objectUrl = asText ? '' : URL.createObjectURL(bytes.blob);
        setState({
          phase: 'ready',
          url: objectUrl,
          text,
          truncated: bytes.truncated || (text !== null && bytes.blob.size > MAX_PREVIEW_TEXT_BYTES),
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: 'failed',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'This file could not be read.',
        });
      }
    })();

    return () => {
      cancelled = true;
      // Revoked on unmount AND on entry change, so flicking through a folder
      // does not accumulate one pinned blob per file looked at.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry, href, canRead, renderer, port]);

  // The ONLY case in which the old copy was ever true.
  if (!href && !canRead) {
    return (
      <div className="fx-empty" data-testid="fx-preview-no-route">
        <p>{EXPLORER_REASONS.NO_BYTE_ROUTE}</p>
      </div>
    );
  }

  if (renderer === null) {
    return (
      <div className="fx-empty" data-testid="fx-preview-no-renderer">
        <p>{EXPLORER_REASONS.NO_RENDERER}</p>
        <DownloadAction entry={entry} port={port} href={href} />
      </div>
    );
  }

  if (state.phase === 'loading') return <p className="fx-empty">Loading preview…</p>;

  if (state.phase === 'failed') {
    return (
      <div className="fx-empty" data-testid="fx-preview-failed">
        <p>{state.message}</p>
        <DownloadAction entry={entry} port={port} href={href} />
      </div>
    );
  }

  return (
    <>
      {state.truncated ? (
        <p className="fx-note" data-testid="fx-preview-truncated">
          {EXPLORER_REASONS.PREVIEW_TOO_LARGE}
        </p>
      ) : null}
      {state.text !== null ? (
        <pre className="fx-preview-text">{state.text}</pre>
      ) : renderer === 'image' ? (
        <img className="fx-preview-img" src={state.url} alt={entry.name} />
      ) : renderer === 'pdf' ? (
        <iframe className="fx-preview-frame" src={state.url} title={`Preview of ${entry.name}`} />
      ) : renderer === 'audio' ? (
        <audio className="fx-preview-media" src={state.url} controls />
      ) : (
        <video className="fx-preview-media" src={state.url} controls />
      )}
      <DownloadAction entry={entry} port={port} href={href} />
    </>
  );
}

/**
 * Download, by whichever route this entry actually has.
 *
 * A library file is a plain anchor — the browser streams it and never holds it
 * in memory. A project file has no URL (§4.4), so its bytes are pulled into a
 * Blob and saved from there; that path REFUSES a truncated read rather than
 * writing a file that is quietly the wrong length, and points at the folder
 * zip, which streams without the inline ceiling.
 */
function DownloadAction({
  entry,
  port,
  href,
}: {
  entry: ExplorerEntry;
  port: FilesExplorerPort;
  href: string | null;
}) {
  const [problem, setProblem] = useState<string | null>(null);

  if (href) {
    return (
      <a className="fx-download" href={href} download={entry.name}>
        Download {entry.name}
      </a>
    );
  }
  if (!port.readBytes) return null;

  return (
    <>
      <button
        type="button"
        className="fx-download"
        onClick={() => {
          setProblem(null);
          void (async () => {
            try {
              const bytes = await port.readBytes!(entry);
              if (bytes.truncated) {
                setProblem(EXPLORER_REASONS.PREVIEW_TOO_LARGE);
                return;
              }
              const url = URL.createObjectURL(bytes.blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = entry.name;
              anchor.click();
              // The click is synchronous, but the browser reads the blob after
              // it; revoking on the next turn is the documented safe point.
              setTimeout(() => URL.revokeObjectURL(url), 0);
            } catch (error) {
              setProblem(
                error instanceof Error && error.message
                  ? error.message
                  : 'This file could not be downloaded.',
              );
            }
          })();
        }}
      >
        Download {entry.name}
      </button>
      {problem ? <p className="fx-note">{problem}</p> : null}
    </>
  );
}
