/**
 * ONE HELP PLATE, RENDERED — a vendored artifact bundle in a sandboxed frame.
 *
 * WHY A FRAME AND NOT A PORT TO JSX. Each plate is a self-contained teaching
 * instrument: ~55 KB of hand-built HTML with its own inline `<style>` and its
 * own `requestAnimationFrame`/canvas/SVG choreography, published as an
 * immutable artifact revision and QA'd at that revision against the Help design
 * contract's five gates. Re-typing 55 of those as components would fork the
 * design system, throw away the provenance chain, and guarantee visual drift
 * the first time one of them is revised. The frame keeps the shipped bytes
 * BYTE-IDENTICAL to the published revision, which is what makes
 * `help-plates.test.ts`'s hash pin meaningful at all.
 *
 * WHY THAT IS SAFE — the sandbox, not trust. `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` is exact and deliberate: the document gets an opaque
 * origin, so its scripts cannot reach this app's DOM, cookies, storage, tokens
 * or `fetch` credentials, cannot navigate the top frame, and cannot submit
 * forms. This is the same posture the app's existing artifact preview takes
 * (`GenericBody.tsx`'s `ArtifactPreviewBlock`).
 *
 * THE PLATE IS NOT THE SCROLLER — THE PANE IS. The frame is sized to the
 * plate's own height and `.hlp-reader` scrolls, so the reader's header scrolls
 * off the top like the head of a document and a plate gets the entire pane. The
 * height arrives over `postMessage` from a reporter appended at load; see
 * `plate-frame.ts` for why that is the only channel an opaque origin has, and
 * why it is preferred over granting `allow-same-origin`.
 *
 * `srcdoc` RATHER THAN `src`, as the cost of the above. The bytes are fetched
 * and handed to the frame's parser with the reporter appended; nothing goes
 * through `innerHTML` or `dangerouslySetInnerHTML`, and this document never
 * parses a plate. The file on disk is untouched, so its hash still holds.
 *
 * THEME rides the CSS cascade rather than a message. `color-scheme` is an
 * inherited property and `.cv2-root[data-theme="dark"]` sets it, so the embedded
 * document's `prefers-color-scheme` resolves dark inside a dark app — which is
 * what every plate's own dark rules key off.
 */
import { useEffect, useRef, useState } from 'react';

import { loadPlateAsset, type HelpPlateDefinition } from './help-plates';
import { heightFromMessage, withPlateReporter } from './plate-frame';

export interface HelpPlateProps {
  plate: HelpPlateDefinition;
}

type Phase =
  | { phase: 'loading' }
  | { phase: 'ready'; doc: string }
  | { phase: 'failed' };

export function HelpPlate({ plate }: HelpPlateProps) {
  const [state, setState] = useState<Phase>({ phase: 'loading' });
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let alive = true;
    setState({ phase: 'loading' });
    /* Reset with the plate, not on first mount only: a stale height from the
       previous plate would size the new one wrong until its first report. */
    setHeight(null);
    loadPlateAsset(plate)
      .then((url) => fetch(url))
      .then((response) => {
        if (!response.ok) throw new Error(`plate ${plate.slug}: ${response.status}`);
        return response.text();
      })
      .then(
        (html) => {
          if (alive) setState({ phase: 'ready', doc: withPlateReporter(html) });
        },
        () => {
          // The realistic cause is an asset that could not be served — an
          // offline reader on a build whose chunks are not cached. Say that,
          // rather than leaving a blank frame that looks like an empty plate.
          if (alive) setState({ phase: 'failed' });
        },
      );
    return () => {
      alive = false;
    };
  }, [plate]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = heightFromMessage(event, frame.current);
      if (next !== null) setHeight(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (state.phase === 'failed') {
    return (
      <p className="hlp-empty" data-testid="help-plate-failed">
        “{plate.title}” ships with this app but its bundle could not be loaded from this
        build. Reloading the page usually fixes it; nothing is missing from your Space.
      </p>
    );
  }

  return (
    <div className="hlp-plate" data-testid="help-plate" data-plate={plate.slug}>
      {state.phase === 'loading' ? (
        <p className="hlp-plate__wait" role="status">
          Opening plate {String(plate.number).padStart(2, '0')}…
        </p>
      ) : (
        <iframe
          key={plate.slug}
          ref={frame}
          className="hlp-plate__frame"
          title={`${plate.title} — Help plate ${plate.number}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={state.doc}
          /* Until the first report the frame fills the pane, so a plate never
             opens as a sliver. `data-measured` is what the shell's CSS uses to
             stop stretching it once its real height is known. */
          data-measured={height === null ? undefined : 'true'}
          style={height === null ? undefined : { height: `${height}px` }}
        />
      )}
      <PlateProvenance plate={plate} />
    </div>
  );
}

/**
 * The receipt, kept quiet and kept honest.
 *
 * A reader who wants to know where a page came from can read the artifact id
 * and revision and go get the same bytes with `tm8 artifact export`. It is one
 * hairline row rather than a panel because the plate is the product and this is
 * a colophon — and it sits at the END of the scroll, where a colophon belongs.
 */
function PlateProvenance({ plate }: { plate: HelpPlateDefinition }) {
  const { artifactId, revision } = plate.provenance;
  return (
    <p className="hlp-plate__colophon" data-testid="help-plate-provenance">
      <span>Plate {String(plate.number).padStart(2, '0')}</span>
      <span aria-hidden>·</span>
      <span>
        Published artifact <code>{artifactId}</code> revision {revision}
      </span>
    </p>
  );
}
