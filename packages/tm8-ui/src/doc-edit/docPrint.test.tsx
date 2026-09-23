// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ActorSummary,
  EntityCapabilities,
  EntityCounters,
  EntityDetail,
  EntityState,
  EntitySummary,
} from '@tm8/contract';
import { ReaderSurface } from '../panels/bodies/ReaderSurface';
import { PRINT_ROOT_ID, canPrint, printDoc } from './printDoc';

/**
 * DOWNLOAD AS PDF — what jsdom can and cannot settle.
 *
 * It CANNOT settle the PDF. There is no print engine here, no page box and no
 * stylesheet, so nothing below proves the output looks right — `doc-print.css`
 * is a set of constraints, and the only thing that can check them is a browser
 * printing a real page.
 *
 * What it CAN settle is everything that is not pixels, and that is most of the
 * risk in this feature:
 *   · the CLONE is a clone — the live document is never moved or emptied. This
 *     is the failure that would be catastrophic and silent: a reader whose text
 *     vanishes when they press Download.
 *   · the tab's title is restored, so a cancelled print leaves no trace.
 *   · the title is not printed TWICE when the body already opens with it.
 *   · the build is idempotent, which is the whole reason a missed `afterprint`
 *     is survivable.
 *   · the control REFUSES with a reason instead of going missing, in each of
 *     the ways it can be unavailable.
 *   · a diagram that is still drawing is WAITED FOR, and one that never
 *     finishes is given up on rather than blocking the download forever.
 *   · the images `kit/Markdown.tsx` declines to load are inlined INTO THE CLONE
 *     ONLY — the live document keeps its chips, which is what makes the beacon
 *     boundary still hold everywhere except the reader's own explicit press.
 *
 * jsdom never fetches an image and fires neither `load` nor `error`, so the
 * image cases run against a stand-in installed below. That stand-in is honest
 * about the one thing that matters — it resolves ASYNCHRONOUSLY — because a
 * synchronous stub would hide exactly the ordering defect these tests exist to
 * catch.
 */

afterEach(cleanup);

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };

const COUNTERS: EntityCounters = {
  likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null,
};

const CAPS: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: true, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

const STATE: EntityState = { kind: 'doc', format: 'markdown', childCount: 0 };

function docDetail(body = '# Floors\n\nfloors are law.', title = 'Layout spec'): EntityDetail {
  const base: EntitySummary = {
    id: 'doc-layout-spec',
    spaceId: 'sp-test',
    kind: 'doc',
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 3,
    activityAt: '2026-07-29T09:00:00.000Z',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-29T09:00:00.000Z',
    deletedAt: null,
    createdBy: ada,
    counters: COUNTERS,
    state: STATE,
    badges: {},
  };
  return {
    ...base,
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: CAPS,
  };
}

/** A minimal executor — `EditEntryControl` needs one, and this suite is not about it. */
const commands = { patchEntity: vi.fn(async () => ({ patches: [] })) } as never;

let printSpy: ReturnType<typeof vi.fn>;
let originalTitle: string;

beforeEach(() => {
  originalTitle = document.title;
  printSpy = vi.fn();
  // jsdom ships a `print` that only warns; a spy makes the call observable.
  Object.defineProperty(window, 'print', { value: printSpy, configurable: true, writable: true });
  loadableImages.clear();
  installImageLoader();
});

afterEach(() => {
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.title = originalTitle;
  restoreImageSrc?.();
});

function makeBody(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const node = host.firstElementChild as HTMLElement;
  document.body.appendChild(host);
  return node;
}

/**
 * The settle ceiling, shortened. Every test that is not ABOUT waiting passes
 * this, because jsdom resolves nothing on its own and the default ceiling is
 * eight seconds.
 */
const FAST = { settleTimeoutMs: 30 } as const;

/**
 * A stand-in for the image fetch jsdom does not perform. Setting `src` resolves
 * on the next macrotask — `load` with a real `naturalWidth` for a URL in
 * `loadableImages`, `error` for anything else — which is what lets the adoption
 * path be exercised at all. It resolves ASYNCHRONOUSLY on purpose: a
 * synchronous stub would let a build that inlines images at the wrong moment
 * pass anyway.
 */
const loadableImages = new Set<string>();
let restoreImageSrc: (() => void) | null = null;

function installImageLoader(): void {
  const proto = HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'src');
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get(this: HTMLImageElement): string {
      return this.getAttribute('src') ?? '';
    },
    set(this: HTMLImageElement, value: string) {
      this.setAttribute('src', value);
      const ok = loadableImages.has(value);
      Object.defineProperty(this, 'complete', { configurable: true, value: false });
      setTimeout(() => {
        Object.defineProperty(this, 'complete', { configurable: true, value: true });
        Object.defineProperty(this, 'naturalWidth', { configurable: true, value: ok ? 640 : 0 });
        Object.defineProperty(this, 'naturalHeight', { configurable: true, value: ok ? 480 : 0 });
        this.dispatchEvent(new Event(ok ? 'load' : 'error'));
      }, 0);
    },
  });
  restoreImageSrc = () => {
    if (original !== undefined) Object.defineProperty(proto, 'src', original);
    restoreImageSrc = null;
  };
}

const REMOTE_PNG = 'https://cdn.example.com/architecture.png';
const DATA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function chip(attrs: string, text: string): string {
  return `<div data-testid="reader-markdown"><a class="md-link md-img-chip" data-testid="markdown-image-link" ${attrs}>${text}</a></div>`;
}

describe('printDoc builds a print root without disturbing the document', () => {
  it('clones the body — the live node keeps its content and its parent', async () => {
    const node = makeBody('<div data-testid="reader-markdown"><p>floors are law.</p></div>');
    const parentBefore = node.parentElement;

    expect(await printDoc({ title: 'Layout spec', body: node, ...FAST })).toBe(true);

    // THE FAILURE THAT WOULD BE CATASTROPHIC: a move instead of a copy.
    expect(node.parentElement).toBe(parentBefore);
    expect(node.textContent).toBe('floors are law.');

    const root = document.getElementById(PRINT_ROOT_ID);
    expect(root).not.toBeNull();
    expect(root?.textContent).toContain('floors are law.');
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('renames the tab so the PDF has the document’s filename, then restores it', async () => {
    document.title = 'tm8';
    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');

    await printDoc({ title: 'Layout spec', body: node, ...FAST });
    expect(document.title).toBe('Layout spec');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('tm8');
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
  });

  it('adds a title header only when the body does not already open with one', async () => {
    const withH1 = makeBody('<div><h1>Layout spec</h1><p>body</p></div>');
    await printDoc({ title: 'Layout spec', body: withH1, ...FAST });
    // One h1, not two: the author's own, not ours stacked above it.
    expect(document.getElementById(PRINT_ROOT_ID)?.querySelectorAll('h1')).toHaveLength(1);
    expect(document.getElementById(PRINT_ROOT_ID)?.querySelector('.dp-title')).toBeNull();
    window.dispatchEvent(new Event('afterprint'));

    const withoutH1 = makeBody('<div><p>body</p></div>');
    await printDoc({ title: 'Layout spec', body: withoutH1, ...FAST });
    const added = document.getElementById(PRINT_ROOT_ID)?.querySelector('.dp-title');
    expect(added?.textContent).toBe('Layout spec');
  });

  it('is idempotent — a missed afterprint cannot stack roots', async () => {
    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');
    await printDoc({ title: 'A', body: node, ...FAST });
    await printDoc({ title: 'A', body: node, ...FAST }); // no afterprint in between
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1);
  });

  it('lets the LAST press win when two overlap, rather than appending twice', async () => {
    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');
    /* Both builds are in flight at once — the first must abandon itself at its
       next checkpoint rather than append a second root or print a third time. */
    const [first, second] = await Promise.all([
      printDoc({ title: 'A', body: node, ...FAST }),
      printDoc({ title: 'B', body: node, ...FAST }),
    ]);
    expect(first).toBe(false);
    expect(second).toBe(true);
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses, rather than half-building, when the environment cannot print', async () => {
    // @ts-expect-error — removing a DOM capability is the condition under test.
    delete window.print;
    expect(canPrint()).toBe(false);

    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');
    expect(await printDoc({ title: 'A', body: node, ...FAST })).toBe(false);
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
  });
});

describe('the reader bar offers Download PDF, or says why it cannot', () => {
  it('prints the RENDERED document when pressed', async () => {
    render(
      <ReaderSurface
        detail={docDetail()}
        blocks={[]}
        historyUnavailableReason=""
        commands={commands}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));

    /* The press no longer prints synchronously: `printDoc` settles diagrams and
       images first. Nothing in this fixture has either, so this resolves on the
       first check — but it resolves on a microtask, not in the click. */
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    // The rendered markdown, not the raw source: no asterisks, real prose.
    expect(document.getElementById(PRINT_ROOT_ID)?.textContent).toContain('floors are law.');
  });

  it('refuses WITH A REASON on an empty document instead of going missing', () => {
    render(
      <ReaderSurface detail={docDetail('')} blocks={[]} historyUnavailableReason="" commands={commands} />,
    );

    /* `DisabledAction` keeps `role="button"` so the control stays in the
       reading order — the refusal is a DISABLED control, not a hidden one. So
       the assertion is on the live-ness, not on the role: no real <button>,
       and the reason is on screen. */
    expect(screen.queryByTestId('doc-download-pdf')).toBeNull();
    const refusal = screen.getByRole('button', { name: /download pdf/i });
    expect(refusal.tagName).toBe('SPAN');
    expect(refusal.getAttribute('aria-disabled')).toBe('true');
    /* The REMEDY, not the cause: `ReaderBody`'s designed empty says "has no
       content yet" too, so matching the cause alone matches two elements and
       proves neither. */
    expect(screen.getByText(/add some text before downloading a PDF/i)).toBeTruthy();
  });

  it('refuses WITH A REASON when the browser cannot print', () => {
    // @ts-expect-error — removing a DOM capability is the condition under test.
    delete window.print;

    render(
      <ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} />,
    );

    expect(screen.queryByTestId('doc-download-pdf')).toBeNull();
    expect(screen.getByRole('button', { name: /download pdf/i }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByText(/cannot print/i)).toBeTruthy();
  });
});

describe('printDoc waits for the page to be worth printing', () => {
  it('waits for a diagram that is still drawing, then clones the FINISHED one', async () => {
    const node = makeBody(
      '<div data-testid="reader-markdown">' +
        '<div class="md-mermaid" data-phase="rendering">' +
        '<span class="md-mermaid__pending">drawing diagram…</span></div></div>',
    );
    const figure = node.querySelector('.md-mermaid') as HTMLElement;

    /* The diagram finishes AFTER the press — which is the whole race, and it
       finishes on the LIVE node. Only a wait that happens before `cloneNode`
       can ever observe this; a wait on the clone would sit here forever. */
    setTimeout(() => {
      figure.setAttribute('data-phase', 'ok');
      figure.innerHTML = '<div class="md-mermaid__svg"><svg><text>API Layer</text></svg></div>';
    }, 20);

    await printDoc({ title: 'Architecture', body: node, settleTimeoutMs: 2_000 });

    const root = document.getElementById(PRINT_ROOT_ID);
    expect(root?.querySelector('.md-mermaid')?.getAttribute('data-phase')).toBe('ok');
    expect(root?.textContent).toContain('API Layer');
    expect(root?.textContent).not.toContain('drawing diagram');
  });

  it('gives up on a diagram that never finishes, rather than never printing', async () => {
    const node = makeBody(
      '<div data-testid="reader-markdown">' +
        '<div class="md-mermaid" data-phase="rendering"><span>drawing diagram…</span></div>' +
        '<p>the rest of the document</p></div>',
    );

    expect(await printDoc({ title: 'A', body: node, ...FAST })).toBe(true);
    /* A PDF missing one diagram beats no PDF at all, and the placeholder that
       lands in its place is honest about what happened. */
    expect(document.getElementById(PRINT_ROOT_ID)?.textContent).toContain('the rest of the document');
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('does not wait on a diagram that FAILED — that is a finished state', async () => {
    const node = makeBody(
      '<div data-testid="reader-markdown">' +
        '<div class="md-mermaid md-mermaid--failed"><pre><code>graph TD;</code></pre></div></div>',
    );

    const started = Date.now();
    await printDoc({ title: 'A', body: node, settleTimeoutMs: 5_000 });

    /* `Mermaid.tsx` drops `data-phase` entirely on failure and keeps the
       author's source. If this waited on it, it would wait the full five
       seconds and the source would still be all there was to print. */
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(document.getElementById(PRINT_ROOT_ID)?.textContent).toContain('graph TD;');
  });
});

describe('printDoc inlines declined images INTO THE CLONE ONLY', () => {
  it('inlines a remote image that loads, keeping its alt text', async () => {
    loadableImages.add(REMOTE_PNG);
    const node = makeBody(
      chip(
        `href="${REMOTE_PNG}" data-img-src="${REMOTE_PNG}" data-img-alt="Architecture stack"`,
        'Architecture stack — remote image, not loaded',
      ),
    );

    await printDoc({ title: 'A', body: node, settleTimeoutMs: 2_000 });

    const root = document.getElementById(PRINT_ROOT_ID);
    const img = root?.querySelector<HTMLImageElement>('[data-testid="doc-print-adopted-image"]');
    expect(img?.getAttribute('src')).toBe(REMOTE_PNG);
    expect(img?.alt).toBe('Architecture stack');
    expect(root?.querySelector('[data-testid="markdown-image-link"]')).toBeNull();
  });

  it('inlines a data:image URI, which costs no request at all', async () => {
    loadableImages.add(DATA_PNG);
    const node = makeBody(
      `<div data-testid="reader-markdown"><span class="md-img-chip" data-testid="markdown-image-rejected" data-img-src="${DATA_PNG}" data-img-alt="Sequence">Sequence — inline image data is not rendered</span></div>`,
    );

    await printDoc({ title: 'A', body: node, settleTimeoutMs: 2_000 });

    const img = document
      .getElementById(PRINT_ROOT_ID)
      ?.querySelector<HTMLImageElement>('[data-testid="doc-print-adopted-image"]');
    expect(img?.getAttribute('src')).toBe(DATA_PNG);
    expect(img?.alt).toBe('Sequence');
  });

  it('leaves the chip exactly as it was when the image does not load', async () => {
    // Deliberately NOT in `loadableImages` — the stand-in fires `error`.
    const node = makeBody(
      chip(
        `href="${REMOTE_PNG}" data-img-src="${REMOTE_PNG}" data-img-alt="Architecture stack"`,
        'Architecture stack — remote image, not loaded',
      ),
    );

    await printDoc({ title: 'A', body: node, settleTimeoutMs: 2_000 });

    const root = document.getElementById(PRINT_ROOT_ID);
    expect(root?.querySelector('[data-testid="doc-print-adopted-image"]')).toBeNull();
    /* No fallback path is needed for this, and that is the point: the chip
       already reads "remote image, not loaded", which in the PDF is simply a
       true sentence. */
    expect(root?.textContent).toContain('remote image, not loaded');
  });

  it('never attempts a scheme that is neither http(s) nor data:image', async () => {
    /* Registered as loadable ON PURPOSE. If the scheme check were missing this
       would load and replace the chip, so the chip's survival is what proves
       the request was never made — rather than merely that it failed. */
    loadableImages.add('javascript:alert(1)');
    const node = makeBody(
      chip('href="#" data-img-src="javascript:alert(1)" data-img-alt="nope"', 'nope — remote image, not loaded'),
    );

    await printDoc({ title: 'A', body: node, settleTimeoutMs: 2_000 });

    const root = document.getElementById(PRINT_ROOT_ID);
    expect(root?.querySelector('img')).toBeNull();
    expect(root?.querySelector('[data-testid="markdown-image-link"]')).not.toBeNull();
  });

  it('leaves the LIVE document alone, so opening a doc still sends nothing', async () => {
    loadableImages.add(REMOTE_PNG);
    const node = makeBody(
      chip(
        `href="${REMOTE_PNG}" data-img-src="${REMOTE_PNG}" data-img-alt="Architecture stack"`,
        'Architecture stack — remote image, not loaded',
      ),
    );

    await printDoc({ title: 'A', body: node, settleTimeoutMs: 2_000 });

    /* THE BOUNDARY. `kit/Markdown.tsx` refuses remote images because loading
       them on open would beacon every reader to the author's host. Downloading
       crosses that once, for the one reader who pressed the button. The live
       view must be exactly as it was. */
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelector('[data-testid="markdown-image-link"]')).not.toBeNull();
  });
});
