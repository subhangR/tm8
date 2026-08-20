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
 * `help-plates.provenance.test.ts`'s hash pin meaningful at all.
 *
 * WHY THAT IS SAFE — the sandbox, not trust. `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` is exact and deliberate: the document gets an opaque
 * origin, so its scripts cannot reach this app's DOM, cookies, storage, tokens
 * or `fetch` credentials, cannot navigate the top frame, and cannot submit
 * forms. This is the same posture the app's existing artifact preview takes
 * (`GenericBody.tsx`'s `ArtifactPreviewBlock`), and it is why "vendor the HTML"
 * is not "inject the HTML": nothing here goes through `innerHTML` or
 * `dangerouslySetInnerHTML`, and the bytes are never parsed by this document.
 *
 * WHY IT DOES NOT WEIGH ON BOOT. The bundle is an ASSET URL resolved by a
 * dynamic `import.meta.glob` at open time, so the 3.6 MB library is 55
 * separately-hashed files that only the plate a reader actually opens is ever
 * fetched from. `src` rather than `srcdoc` for the same reason: `srcdoc` would
 * mean pulling every byte through JS to hand it back to the parser.
 *
 * THEME rides the CSS cascade rather than a message channel. `color-scheme` is
 * an inherited property and `.cv2-root[data-theme="dark"]` sets it, so the
 * embedded document's `prefers-color-scheme` resolves dark inside a dark app —
 * which is exactly what every plate's own dark rules key off. A sandboxed
 * opaque-origin frame has no channel we could push a theme through anyway, so
 * inheritance is not a shortcut here, it is the only correct mechanism.
 */
import { useEffect, useState } from 'react';

import { loadPlateAsset, type HelpPlateDefinition } from './help-plates';

export interface HelpPlateProps {
  plate: HelpPlateDefinition;
}

type Phase =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string }
  | { phase: 'failed' };

export function HelpPlate({ plate }: HelpPlateProps) {
  const [state, setState] = useState<Phase>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ phase: 'loading' });
    loadPlateAsset(plate).then(
      (url) => {
        if (alive) setState({ phase: 'ready', url });
      },
      () => {
        // The only realistic cause is a chunk fetch that could not be served —
        // an offline reader on a build whose assets are not cached. Say that,
        // rather than leaving a blank frame that looks like an empty plate.
        if (alive) setState({ phase: 'failed' });
      },
    );
    return () => {
      alive = false;
    };
  }, [plate]);

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
          className="hlp-plate__frame"
          title={`${plate.title} — Help plate ${plate.number}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={state.url}
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
 * a colophon.
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
