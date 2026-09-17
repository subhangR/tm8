// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});

afterEach(() => {
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.title = originalTitle;
});

function makeBody(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const node = host.firstElementChild as HTMLElement;
  document.body.appendChild(host);
  return node;
}

describe('printDoc builds a print root without disturbing the document', () => {
  it('clones the body — the live node keeps its content and its parent', () => {
    const node = makeBody('<div data-testid="reader-markdown"><p>floors are law.</p></div>');
    const parentBefore = node.parentElement;

    expect(printDoc({ title: 'Layout spec', body: node })).toBe(true);

    // THE FAILURE THAT WOULD BE CATASTROPHIC: a move instead of a copy.
    expect(node.parentElement).toBe(parentBefore);
    expect(node.textContent).toBe('floors are law.');

    const root = document.getElementById(PRINT_ROOT_ID);
    expect(root).not.toBeNull();
    expect(root?.textContent).toContain('floors are law.');
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('renames the tab so the PDF has the document’s filename, then restores it', () => {
    document.title = 'tm8';
    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');

    printDoc({ title: 'Layout spec', body: node });
    expect(document.title).toBe('Layout spec');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('tm8');
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
  });

  it('adds a title header only when the body does not already open with one', () => {
    const withH1 = makeBody('<div><h1>Layout spec</h1><p>body</p></div>');
    printDoc({ title: 'Layout spec', body: withH1 });
    // One h1, not two: the author's own, not ours stacked above it.
    expect(document.getElementById(PRINT_ROOT_ID)?.querySelectorAll('h1')).toHaveLength(1);
    expect(document.getElementById(PRINT_ROOT_ID)?.querySelector('.dp-title')).toBeNull();
    window.dispatchEvent(new Event('afterprint'));

    const withoutH1 = makeBody('<div><p>body</p></div>');
    printDoc({ title: 'Layout spec', body: withoutH1 });
    const added = document.getElementById(PRINT_ROOT_ID)?.querySelector('.dp-title');
    expect(added?.textContent).toBe('Layout spec');
  });

  it('is idempotent — a missed afterprint cannot stack roots', () => {
    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');
    printDoc({ title: 'A', body: node });
    printDoc({ title: 'A', body: node }); // no afterprint in between
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1);
  });

  it('refuses, rather than half-building, when the environment cannot print', () => {
    // @ts-expect-error — removing a DOM capability is the condition under test.
    delete window.print;
    expect(canPrint()).toBe(false);

    const node = makeBody('<div data-testid="reader-markdown"><p>body</p></div>');
    expect(printDoc({ title: 'A', body: node })).toBe(false);
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
  });
});

describe('the reader bar offers Download PDF, or says why it cannot', () => {
  it('prints the RENDERED document when pressed', () => {
    render(
      <ReaderSurface
        detail={docDetail()}
        blocks={[]}
        historyUnavailableReason=""
        commands={commands}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));

    expect(printSpy).toHaveBeenCalledTimes(1);
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
