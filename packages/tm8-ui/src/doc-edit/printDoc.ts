/**
 * DOWNLOAD AS PDF — the print path, and why it is the print path.
 *
 * THE DECISION, stated once so nobody re-derives it. A document here is
 * markdown that `Markdown` has already rendered to real DOM. The browser's own
 * print engine turns that DOM into a PDF with selectable text, working
 * hyphenation, real pagination and embedded images, for zero bytes of new
 * dependency and — the load-bearing half — ZERO SERVER CHANGE. The two
 * alternatives were costed and rejected:
 *
 *   · a client PDF library (jsPDF + html2canvas) RASTERISES the page. The
 *     result is a picture of a document: no selectable text, no search, no
 *     accessibility, and it weighs more than everything in this directory.
 *   · a server renderer (headless Chromium) produces the best PDF and needs a
 *     new dependency, a new blob route and a SERVER RESTART to deploy. Neither
 *     the route nor the restart is free on this host.
 *
 * So the whole feature is a stylesheet and the DOM work in this file. What the
 * viewer gets is their browser's print dialog with "Save as PDF" already in it.
 *
 * THE MECHANISM. `@media print` cannot simply hide the app's chrome — the
 * document body is nested a dozen panels deep inside `#root`, and the
 * visibility/position tricks that "reveal" a deep node leave the hidden
 * ancestors occupying space, which prints as leading blank pages. So we do the
 * honest thing instead: CLONE the rendered node into a print root that is a
 * SIBLING of `#root`, hide `#root` outright in print media, and show the clone.
 * One rule each way, no layout archaeology. The clone is a clone — the live
 * document is never moved, never reparented, and never mutated.
 *
 * THE CLONE IS A SNAPSHOT, WHICH IS WHY THIS IS ASYNC. `cloneNode` copies the
 * DOM as it stands at that instant and is never updated again — React goes on
 * writing to the LIVE node, not to the copy. Two things in a design doc are
 * routinely not ready at the moment the button is pressed: a mermaid diagram
 * that is still drawing (`Mermaid.tsx` lazy-imports a multi-megabyte chunk
 * before it can draw anything) and an image that has not arrived. Both must
 * therefore be waited for BEFORE the clone is taken, on the live node. Waiting
 * afterwards is not a slower version of the same thing; it is an infinite wait
 * on a copy that can never change, and it prints "drawing diagram…" where the
 * architecture should be.
 *
 * CLEANUP IS IDEMPOTENT ON PURPOSE. `afterprint` is the correct hook and it is
 * the one we use, but it is not guaranteed in every browser and every dismissal
 * path. Rather than defend that with a timeout race — which would risk tearing
 * the content down WHILE it prints — the build removes any previous root first,
 * and the root carries `display: none` outside print media. A missed
 * `afterprint` therefore leaves an invisible node that the next print replaces.
 * Nothing compounds, and nothing can be destroyed mid-print.
 */

/** The print root's id. Exported so the stylesheet and the tests agree on it. */
export const PRINT_ROOT_ID = 'tm8-print-root';

export interface PrintDocInput {
  /**
   * The document's title. It becomes `document.title` for the duration of the
   * print, which is what browsers offer as the default PDF FILENAME — the
   * reason this is passed at all rather than read off the clone.
   */
  title: string;
  /** The rendered markdown node. Cloned, never moved. */
  body: HTMLElement;
  /**
   * Ceiling on the settle waits, in ms. Defaults to `SETTLE_TIMEOUT_MS`. Exists
   * because jsdom never loads an image and never fires `load` or `error`, so a
   * test that did not shorten this would sit out the whole default.
   */
  settleTimeoutMs?: number;
}

/**
 * Whether this environment can print at all. A build without it renders the
 * control disabled-with-reason rather than a live button that swallows the
 * press — the package's no-op-handler law, applied to a browser capability.
 */
export function canPrint(): boolean {
  return typeof window !== 'undefined' && typeof window.print === 'function';
}

/**
 * Does the clone already open with this document's own title? Docs here
 * conventionally begin `# Title`, and printing our header above the author's
 * identical `<h1>` prints the title twice. Comparing the rendered TEXT (not the
 * markdown source) is what makes this correct for `# **Title**` too.
 */
function leadsWithTitle(body: HTMLElement, title: string): boolean {
  const first = body.querySelector('h1');
  if (first == null) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(first.textContent ?? '') === norm(title);
}

/**
 * Ceiling on how long the print path waits for the page to become worth
 * printing.
 *
 * It is a CEILING, not a delay. In the ordinary case the reader has had the
 * document open for some seconds, everything is already settled, and every wait
 * below resolves on its first check — the dialog opens with no perceptible
 * pause. The ceiling binds only when something is genuinely stuck, and when it
 * binds we print WHAT WE HAVE rather than refusing: a PDF missing one remote
 * image is worth more to the reader than no PDF at all. It is one budget shared
 * across all three waits, so a pathological diagram cannot also spend the
 * images' share.
 */
const SETTLE_TIMEOUT_MS = 8_000;

/** Poll interval for the diagram wait. React offers no event to await here. */
const SETTLE_POLL_MS = 50;

/**
 * A diagram that is still drawing. `Mermaid.tsx` mounts in `{ phase:
 * 'rendering' }` (:125) and writes `data-phase` on the root in every phase that
 * has one, so there is no window in which a diagram is pending but unmarked.
 * `ok` reports itself; `failed` drops the attribute and keeps the author's
 * source on the page (:179-190), which is a FINISHED state and correctly not
 * awaited.
 */
const DRAWING_SELECTOR = '.md-mermaid[data-phase="rendering"]';

/** The chips `kit/Markdown.tsx` leaves for an image it declined to load. */
const CHIP_SELECTOR = '[data-img-src]';

/**
 * What this path is willing to fetch. `http(s)` is the reader-initiated beacon
 * crossing argued in `printDoc`'s adoption note; `data:image/` carries no
 * request at all. Anything else — `file:`, `javascript:`, a bare word, a scheme
 * this renderer never recognised — is left as the chip it already is.
 */
const PRINTABLE_SRC = /^(?:https?:\/\/|data:image\/)/i;

/**
 * Two presses must not both append a root. The build below awaits, so a second
 * press can begin while the first is still waiting. Whoever started last wins;
 * an earlier build abandons itself at its next checkpoint without having
 * touched the document.
 */
let buildGeneration = 0;

function sleep(view: Window, ms: number): Promise<void> {
  return new Promise((resolve) => {
    view.setTimeout(resolve, ms);
  });
}

/**
 * Wait until no diagram is mid-draw. CALLED ON THE LIVE NODE, BEFORE THE CLONE
 * — see the file header; the order is the whole design, not an optimisation.
 */
async function settleDiagrams(body: HTMLElement, view: Window, deadline: number): Promise<void> {
  while (body.querySelector(DRAWING_SELECTOR) !== null) {
    if (Date.now() >= deadline) return;
    await sleep(view, SETTLE_POLL_MS);
  }
}

/**
 * Resolve once this image has settled, reporting whether it actually decoded.
 * The timeout resolves `false` rather than rejecting: a slow host must cost the
 * reader a missing picture, never the whole download.
 */
function loadImage(img: HTMLImageElement, view: Window, deadline: number): Promise<boolean> {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof view.setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) view.clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
    timer = view.setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
  });
}

/**
 * Turn the chips back into pictures, IN THE CLONE ONLY.
 *
 * THE TRADEOFF, STATED WHERE IT IS MADE. `kit/Markdown.tsx` refuses to request a
 * remote image because doing so on open would hand the author's chosen host
 * every reader's IP, user-agent and reading timestamp, silently and without
 * consent. That argument is sound and the live view still honours it in full.
 * This path crosses it deliberately, at the owner's explicit instruction, and
 * what changes is WHO and WHEN: not every reader on open, but one reader who
 * pressed Download, at the moment they pressed it. The request still leaves the
 * origin and the author's host still learns that much. That is the cost, it was
 * accepted knowingly, and it must not be re-derived as an oversight later.
 *
 * `data:` carries no such cost — `Markdown.tsx` declines it to protect the 200k
 * body budget, which is an authoring concern and not a rendering hazard, and
 * the bytes are in hand already. An `<img>` is also an inert context for SVG,
 * so `data:image/svg+xml` cannot execute anything here.
 *
 * A chip whose image does not load is LEFT EXACTLY AS IT IS, which needs no
 * fallback path because the chip already says "remote image, not loaded" — in
 * the PDF that sentence is simply true.
 */
async function adoptChipImages(
  root: HTMLElement,
  doc: Document,
  view: Window,
  deadline: number,
): Promise<void> {
  const chips = Array.from(root.querySelectorAll<HTMLElement>(CHIP_SELECTOR));
  if (chips.length === 0) return;
  await Promise.all(
    chips.map(async (chip) => {
      const src = (chip.getAttribute('data-img-src') ?? '').trim();
      if (!PRINTABLE_SRC.test(src)) return;
      const img = doc.createElement('img');
      img.className = 'md-img';
      img.setAttribute('data-testid', 'doc-print-adopted-image');
      img.alt = chip.getAttribute('data-img-alt') ?? 'image';
      img.loading = 'eager';
      img.src = src;
      if (await loadImage(img, view, deadline)) chip.replaceWith(img);
    }),
  );
}

/**
 * Wait for the pictures already in the clone.
 *
 * `loading` is forced to `eager` first because the print root carries
 * `display: none` outside print media, and a lazy image inside a `display:
 * none` subtree is one the browser is entitled to never fetch at all — the
 * attribute that makes the live document cheap is the one that would empty the
 * PDF.
 */
async function settleImages(root: HTMLElement, view: Window, deadline: number): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length === 0) return;
  for (const img of imgs) {
    img.loading = 'eager';
    /*
     * And force the load algorithm to actually run. A node produced by
     * `cloneNode` carries a `src` ATTRIBUTE rather than a fresh assignment, and
     * whether that by itself starts a fetch on a still-DETACHED element is not
     * a thing to guess at across browsers — guessing wrong means waiting out
     * the whole ceiling for a picture that was never requested. Re-assigning is
     * deterministic, and for an image the live document is already showing it
     * is served from cache.
     */
    const src = img.getAttribute('src');
    if (src !== null && src !== '' && !img.complete) img.src = src;
  }
  await Promise.all(imgs.map((img) => loadImage(img, view, deadline)));
}

/**
 * Build the print root and hand the document to the browser's print engine.
 * Returns false when the environment cannot print — the caller has already
 * refused in that case, so this is the belt to that braces — and when a later
 * press superseded this build.
 */
export async function printDoc(input: PrintDocInput): Promise<boolean> {
  if (!canPrint()) return false;

  const doc = input.body.ownerDocument;
  const view = doc.defaultView;
  if (view == null) return false;

  const generation = (buildGeneration += 1);
  const deadline = Date.now() + (input.settleTimeoutMs ?? SETTLE_TIMEOUT_MS);

  await settleDiagrams(input.body, view, deadline);
  if (generation !== buildGeneration) return false;

  const root = doc.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.setAttribute('role', 'document');
  root.setAttribute('data-testid', 'doc-print-root');
  root.setAttribute('aria-hidden', 'true');

  const title = input.title.trim();
  if (title !== '' && !leadsWithTitle(input.body, title)) {
    const heading = doc.createElement('h1');
    heading.className = 'dp-title';
    heading.textContent = title;
    root.appendChild(heading);
  }

  const cloned = input.body.cloneNode(true) as HTMLElement;
  cloned.removeAttribute('data-testid');
  const holder = doc.createElement('div');
  holder.className = 'dp-body';
  holder.appendChild(cloned);
  root.appendChild(holder);

  await adoptChipImages(root, doc, view, deadline);
  if (generation !== buildGeneration) return false;
  await settleImages(root, view, deadline);
  if (generation !== buildGeneration) return false;

  /*
   * Idempotent build — see the cleanup note in the file header. Deferred to
   * here rather than done on entry: with awaits above, clearing at entry would
   * leave the document with no print root for the whole of the wait, and a
   * print triggered by the browser's own shortcut in that window would produce
   * a blank page.
   */
  doc.getElementById(PRINT_ROOT_ID)?.remove();
  doc.body.appendChild(root);

  /*
   * The filename. Restored in the same cleanup that removes the root, so a
   * print that is cancelled leaves the tab's title exactly as it found it.
   */
  const previousTitle = doc.title;
  if (title !== '') doc.title = title;

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    view.removeEventListener('afterprint', cleanup);
    doc.getElementById(PRINT_ROOT_ID)?.remove();
    doc.title = previousTitle;
  };
  view.addEventListener('afterprint', cleanup);

  try {
    view.print();
  } catch {
    /*
     * A browser that refuses to open the dialog must not leave the tab renamed
     * and a hidden clone behind. This is the only path that tears down eagerly,
     * and it is safe precisely because nothing was printed.
     */
    cleanup();
    return false;
  }

  return true;
}
