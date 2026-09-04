/**
 * THE PLATE FRAME BRIDGE — how a sandboxed plate tells the shell how tall it is.
 *
 * WHY ANYTHING IS INJECTED AT ALL. A plate is rendered at an OPAQUE ORIGIN
 * (`sandbox="allow-scripts"` with no `allow-same-origin`), which is what keeps
 * 55 documents of hand-built HTML away from this app's DOM, storage and
 * credentials. The price is total blindness: the shell cannot read the frame's
 * `scrollHeight`, cannot see its scroll position, and does not receive wheel or
 * scroll events that land inside it. So a frame sized to the pane must scroll
 * INTERNALLY, and the reader's header can never get out of the way.
 *
 * THE FIX IS TO INVERT THE SCROLLER. The frame is sized to its own content and
 * the reader PANE scrolls, so the section/title/plate-count header scrolls off
 * the top like the head of any document and the plate gets the whole pane. That
 * needs exactly one number out of the frame — its height — and `postMessage` is
 * the one channel an opaque origin still has.
 *
 * THE SANDBOX IS UNCHANGED. `allow-same-origin` would also have solved this and
 * is precisely what must not be granted: it would defeat the sandbox entirely
 * and hand every plate this origin's storage. A height over `postMessage` is
 * strictly weaker than that, and is the reason this shim exists instead.
 *
 * THE VENDORED BYTES ARE NOT EDITED. The file in `./plates/` is untouched —
 * `help-plates.test.ts` still hashes it against the published revision — and the
 * shim is APPENDED at load time, after the closing bytes, as a separate
 * code-owned string that lives in this file where it can be read and tested.
 * Nothing rewrites the plate's own markup.
 *
 * SAFE BY CONSTRUCTION ON BOTH SIDES:
 *  · the child sends `{ source, height }` and nothing else — no page content
 *    crosses the boundary, so `targetOrigin: '*'` (unavoidable: an opaque origin
 *    cannot know the embedder's origin) leaks nothing to a frame-ancestor;
 *  · the parent authenticates by `event.source === iframe.contentWindow`, not by
 *    origin, because a sandboxed frame's origin is the string `"null"` and every
 *    such frame shares it — origin cannot distinguish plates from each other or
 *    from any other opaque frame on the page;
 *  · the parent CLAMPS the number, so a buggy or hostile plate cannot ask for a
 *    two-million-pixel element.
 */

/** Marks a message as ours. Not a secret — `event.source` is the real check. */
export const PLATE_MESSAGE_SOURCE = 'tm8-help-plate';

/** Below this the frame would look broken mid-measure; above it, absurd. */
export const PLATE_MIN_HEIGHT = 320;
export const PLATE_MAX_HEIGHT = 40_000;

/**
 * The reporter appended to every plate.
 *
 * MEASURES THE BODY, NOT `documentElement.scrollHeight`, and the difference is
 * the whole correctness of this: once the parent sizes the frame to H, the root
 * element fills the viewport and its `scrollHeight` becomes H — so a root
 * measurement latches and a plate that COLLAPSES a panel never shrinks back.
 * The body is an auto-height block and reports what its content actually needs,
 * in both directions.
 *
 * `ResizeObserver` because plates are interactive: steppers, toggles and replays
 * change the document's height long after load, and a one-shot measurement on
 * `load` would leave the frame the wrong size for the rest of the session.
 */
export const PLATE_REPORTER = `<script>(function () {
  var last = -1;
  function measure() {
    var b = document.body;
    if (!b) return;
    var style = window.getComputedStyle(b);
    var height = Math.ceil(
      b.getBoundingClientRect().height +
      (parseFloat(style.marginTop) || 0) +
      (parseFloat(style.marginBottom) || 0)
    );
    if (height === last) return;
    last = height;
    parent.postMessage({ source: '${PLATE_MESSAGE_SOURCE}', height: height }, '*');
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(measure).observe(document.documentElement);
  }
  window.addEventListener('load', measure);
  document.addEventListener('DOMContentLoaded', measure);
  measure();
})();<\/script>`;

/** The published bytes, then our reporter. Never an edit of the plate's markup. */
export function withPlateReporter(html: string): string {
  return html + PLATE_REPORTER;
}

/**
 * Read a height off a window message, or `null` if it is not one of ours.
 *
 * `frame` is the authentication: any page can post to any window, and every
 * sandboxed frame reports origin `"null"`, so the sending WINDOW is the only
 * thing that identifies a plate.
 */
export function heightFromMessage(event: MessageEvent, frame: HTMLIFrameElement | null): number | null {
  if (!frame || event.source !== frame.contentWindow) return null;
  const data = event.data as { source?: unknown; height?: unknown } | null;
  if (!data || data.source !== PLATE_MESSAGE_SOURCE) return null;
  const height = data.height;
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return Math.min(Math.max(Math.round(height), PLATE_MIN_HEIGHT), PLATE_MAX_HEIGHT);
}
