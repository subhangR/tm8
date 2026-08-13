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
import { MAX_PREVIEW_TEXT_BYTES, rendererFor } from './preview';

type Loaded =
  | { phase: 'loading' }
  /** `missing` distinguishes "the node has no bytes for this" from any other refusal. */
  | { phase: 'failed'; message: string; missing: boolean }
  | { phase: 'ready'; url: string; text: string | null; truncated: boolean };

export function PreviewBody({ entry, port }: { entry: ExplorerEntry; port: FilesExplorerPort }) {
  const href = port.downloadHref(entry);
  const canRead = typeof port.readBytes === 'function' && entry.projectId !== undefined;
  const renderer = rendererFor(entry.mime);
  // Media the browser can stream from a URL is never buffered; see the header.
  const streamsFromHref = href !== null && (renderer === 'image' || renderer === 'audio' || renderer === 'video');
  const [state, setState] = useState<Loaded>({ phase: 'loading' });

  useEffect(() => {
    // Nothing to fetch when there is no route, or when the browser will fetch
    // it itself from the href. An UNRENDERABLE type is still probed — one byte,
    // only to learn whether bytes exist at all before offering a download.
    if ((!href && !canRead) || streamsFromHref) return;
    const probeOnly = renderer === null;
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        // Library files go through fetch rather than straight into the tag so
        // both roots end up holding the same thing: a Blob. See preview.ts for
        // why an href is not enough (attachment disposition breaks <iframe>).
        const bytes = canRead
          ? await port.readBytes!(entry)
          : await (async () => {
              const response = await fetch(href!, {
                credentials: 'include',
                // One byte is enough to learn whether the file exists; the
                // download link streams the rest. `files.download` honours
                // Range, and a server that ignores it just sends more.
                ...(probeOnly ? { headers: { range: 'bytes=0-0' } } : {}),
              });
              if (!response.ok) {
                throw Object.assign(
                  new Error(
                    response.status === 401 || response.status === 403
                      ? 'You are not allowed to read this file.'
                      : `The node refused this file (${response.status}).`,
                  ),
                  { missing: response.status === 404 },
                );
              }
              return {
                blob: probeOnly ? new Blob() : await response.blob(),
                mime: entry.mime ?? 'application/octet-stream',
                truncated: false,
              };
            })();
        if (probeOnly) {
          if (!cancelled) setState({ phase: 'ready', url: '', text: null, truncated: false });
          return;
        }
        if (cancelled) return;
        const asText = renderer === 'text';
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
          missing: (error as { missing?: boolean }).missing === true,
        });
      }
    })();

    return () => {
      cancelled = true;
      // Revoked on unmount AND on entry change, so flicking through a folder
      // does not accumulate one pinned blob per file looked at.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry, href, canRead, renderer, streamsFromHref, port]);


  // The ONE case in which this copy is true: no route of either kind exists.
  // "Has an id but no stored bytes" is a DIFFERENT fact and is established by
  // asking the route, in the unrenderable branch below.
  if (!href && !canRead) {
    return (
      <div className="fx-empty" data-testid="fx-preview-no-route">
        <p>{EXPLORER_REASONS.NO_BYTE_ROUTE}</p>
      </div>
    );
  }

  if (renderer === null) {
    // The bytes are NOT assumed. A blob-less `file` entity — the wreckage of
    // the old create door — has an id, so it looks routeable, and
    // `files.download` answers 404. Claiming "no renderer, download it" there
    // would be the original bug in new words, so the route is asked first.
    if (state.phase === 'loading') return <p className="fx-empty">Checking this file…</p>;
    if (state.phase === 'failed') {
      return (
        <div className="fx-empty" data-testid="fx-preview-no-bytes">
          <p>{state.missing ? EXPLORER_REASONS.NO_STORED_BYTES : state.message}</p>
        </div>
      );
    }
    return (
      <div className="fx-empty" data-testid="fx-preview-no-renderer">
        <p>{EXPLORER_REASONS.NO_RENDERER}</p>
        <DownloadAction entry={entry} port={port} href={href} />
      </div>
    );
  }

  if (streamsFromHref) {
    return (
      <>
        {renderer === 'image' ? (
          <img className="fx-preview-img" src={href!} alt={entry.name} />
        ) : renderer === 'audio' ? (
          <audio className="fx-preview-media" src={href!} controls />
        ) : (
          <video className="fx-preview-media" src={href!} controls />
        )}
        <DownloadAction entry={entry} port={port} href={href} />
      </>
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
                setProblem(EXPLORER_REASONS.DOWNLOAD_TOO_LARGE);
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
