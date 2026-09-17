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
 * So the whole feature is a stylesheet and forty lines of DOM. What the viewer
 * gets is their browser's print dialog with "Save as PDF" already in it.
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
 * Build the print root and hand the document to the browser's print engine.
 * Returns false when the environment cannot print — the caller has already
 * refused in that case, so this is the belt to that braces.
 */
export function printDoc(input: PrintDocInput): boolean {
  if (!canPrint()) return false;

  const doc = input.body.ownerDocument;
  const view = doc.defaultView;
  if (view == null) return false;

  // Idempotent build — see the cleanup note in the file header.
  doc.getElementById(PRINT_ROOT_ID)?.remove();

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
