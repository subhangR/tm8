// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type {
  ActorSummary,
  EntityCapabilities,
  EntityCounters,
  EntityDetail,
  EntityState,
  EntitySummary,
} from '@tm8/contract';
import { ReaderBody } from './ReaderBody';

/**
 * THE READER ARCHETYPE — T0-4 frame 2 "DOC" (oracle lines 325-361), with the
 * Z4 "READER (doc)" frame (984-1027) cross-read for the same anatomy at full
 * width and the "DARK DOC" frame (1321-1352) for the dark pairing.
 *
 * WHY THESE ARE THE TESTS. Three of them pin a HONESTY behaviour that a
 * pixel-faithful build would happily get wrong:
 *
 *  · the record's chapter count and the outline we actually hold are TWO
 *    SOURCES. The doc fixture states `childCount: 4` and carries zero
 *    children — a body that drew four chips from the number would be
 *    inventing three of them, which is the "1 live above not running"
 *    defect in reader clothing.
 *  · a table-of-contents entry that navigates nowhere is a dead control (R7).
 *    Entity-backed entries are live only when a dispatch exists. The entries
 *    read out of the prose USED to be inert labels for the same reason — no
 *    anchoring existed to give them — and are live as of the 2026-08-17
 *    ruling; `an outline entry goes to its heading` below is what earns that,
 *    by pinning WHICH heading each one arrives at.
 *  · `history ▸` is the deferred version-history feature's in-body home, so
 *    it renders disabled-carrying-its-reason and never as a live button.
 *
 * The objects below are authored against the contract types (no casts, no
 * optional chains) so tsc fails here if the shape drifts, rather than the
 * assertions quietly passing over an `any`.
 */

/**
 * jsdom SHIPS NO `scrollIntoView` — it has no layout, so there is nothing for
 * it to scroll. Every case in this file that clicks an outline entry reaches
 * the reader's jump, so without this the method is missing rather than merely
 * inert and the handler throws. Defined once for the file because that absence
 * is a fact about the ENVIRONMENT, not a fixture of one test: the alternative
 * is a guard in production code for a method every browser has had for a
 * decade, which would make the real path the untested one.
 */
beforeAll(() => {
  if (!('scrollIntoView' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }
});

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };

const COUNTERS: EntityCounters = {
  likes: 0,
  dislikes: 0,
  stars: 5,
  points: 6,
  messages: 6,
  viewerReaction: null,
};

const CAPS: EntityCapabilities = {
  canEdit: true,
  canDelete: false,
  canAddChild: true,
  canLink: true,
  canPull: false,
  canReact: true,
  canGrantPoints: false,
  canComplete: false,
};

const HISTORY_DEFERRED = 'Version history is not built in this build — the version is real, the timeline is not.';

function summaryOf(id: string, title: string, state: EntityState): EntitySummary {
  return {
    id,
    spaceId: 'sp-test',
    kind: state.kind,
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
    state,
    badges: {},
  };
}

/** A doc whose record claims `childCount` chapters, with `children` supplied. */
function docDetail(
  body: string,
  opts: { childCount: number; children: EntitySummary[] },
): EntityDetail {
  const base = summaryOf('doc-layout-spec', 'Layout spec', {
    kind: 'doc',
    format: 'markdown',
    childCount: opts.childCount,
  });
  return {
    ...base,
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: opts.children, nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: CAPS,
  };
}

function chapter(id: string, title: string): EntitySummary {
  return summaryOf(id, title, { kind: 'doc', format: 'markdown', childCount: 0 });
}

const FIXTURE_BODY = [
  '# Layout spec',
  '',
  'Every shrinkable region states a floor — this app has been broken three separate times by flex tracks with zero minimums, so floors are law, not preference.',
  '',
  '> C_min = max(320, V·320 + (V−1)·8)',
  '',
  'The center hosts pinned panels left-to-right in pin order, with the top of the stack as the rightmost column.',
].join('\n');

function renderReader(over: Partial<React.ComponentProps<typeof ReaderBody>> = {}) {
  const props: React.ComponentProps<typeof ReaderBody> = {
    detail: docDetail(FIXTURE_BODY, {
      childCount: 4,
      children: [
        chapter('doc-shell-regions', 'Shell regions'),
        chapter('doc-cmin', 'C_min formula'),
        chapter('doc-floors', 'Floors'),
        chapter('doc-responsive', 'Responsive'),
      ],
    }),
    blocks: [],
    historyUnavailableReason: HISTORY_DEFERRED,
    onOpenEntity: () => {},
    ...over,
  };
  return render(
    <>
      <div className="cv2-root">
        <ReaderBody {...props} />
      </div>
      <div className="cv2-root" data-theme="dark">
        <ReaderBody {...props} />
      </div>
    </>,
  );
}

describe('the outline is the chapters we HOLD, never the number the record claims', () => {
  it('draws one chip per real child, labelled with its title', () => {
    const { getAllByTestId } = renderReader();
    const outlines = getAllByTestId('reader-outline');
    // Both themes render, so every query is doubled — asserting on the first
    // scope only would let a dark-only failure through.
    expect(outlines).toHaveLength(2);
    const labels = within(outlines[0]!)
      .getAllByTestId('reader-toc-chip')
      .map((el) => el.textContent);
    expect(labels).toEqual(['Shell regions', 'C_min formula', 'Floors', 'Responsive']);
  });

  it('opens the chapter entity when a chip is clicked', () => {
    const onOpenEntity = vi.fn();
    const { getAllByTestId } = renderReader({ onOpenEntity });
    const chips = within(getAllByTestId('reader-outline')[0]!).getAllByTestId('reader-toc-chip');
    fireEvent.click(chips[1]!);
    expect(onOpenEntity).toHaveBeenCalledWith('doc-cmin');
  });

  it('states the gap instead of inventing chips when the record claims chapters we do not hold', () => {
    // The fixture shape exactly: `childCount: 4`, `children: []`. Four chips
    // drawn off the number would be three entities that do not exist.
    const { getAllByTestId, queryAllByTestId } = renderReader({
      detail: docDetail('Prose only, no headings.', { childCount: 4, children: [] }),
    });
    expect(queryAllByTestId('reader-toc-chip')).toHaveLength(0);
    const absence = getAllByTestId('reader-outline-absent')[0];
    expect(absence).toBeDefined();
    // Both numbers, because "4 chapters" alone above an empty row is the lie.
    expect(absence!.textContent).toContain('4');
    expect(absence!.textContent?.toLowerCase()).toContain('outline');
  });

  it('falls back to the document’s own headings when there are no child entities', () => {
    const { getAllByTestId } = renderReader({
      detail: docDetail(FIXTURE_BODY, { childCount: 1, children: [] }),
    });
    const labels = within(getAllByTestId('reader-outline')[0]!)
      .getAllByTestId('reader-toc-chip')
      .map((el) => el.textContent);
    expect(labels).toEqual(['Layout spec']);
  });

  it('never dispatches an entity open from a heading-derived entry — it jumps in-document', () => {
    // The reversal of an earlier ruling, kept as a test because the two entry
    // kinds now LOOK the same and only the dispatch tells them apart: a heading
    // entry that reached `onOpenEntity` would try to open a doc id it never had.
    const onOpenEntity = vi.fn();
    const { getAllByTestId } = renderReader({
      detail: docDetail(FIXTURE_BODY, { childCount: 1, children: [] }),
      onOpenEntity,
    });
    const entry = within(getAllByTestId('reader-outline')[0]!).getAllByTestId('reader-toc-chip')[0]!;
    expect(entry.tagName).toBe('BUTTON');
    fireEvent.click(entry);
    expect(onOpenEntity).not.toHaveBeenCalled();
  });
});

/**
 * THE TABLE OF CONTENTS IS NAVIGATION THAT ARRIVES (user ruling 2026-08-17).
 *
 * These pin the behaviour the chip row could not have: clicking an entry moves
 * the reader to THAT heading. The load-bearing assertion in each is WHICH
 * element got scrolled — a table of contents whose entries all land on the
 * first heading is worse than one that does nothing, because it looks like it
 * worked. Two failure modes get their own case:
 *
 *  · DUPLICATE HEADING TEXT. Two sections called "Proof standard" slugify the
 *    same; without the dedup in `headingsIn` the second entry scrolls to the
 *    first section, forever.
 *  · DUPLICATE MOUNTS. This body renders twice here (both themes) and in the
 *    app whenever two panels split on one doc. A `getElementById` lookup would
 *    resolve to whichever mounted first, so clicking in the dark copy would
 *    scroll the light one.
 *
 * `scrollIntoView` is not implemented in jsdom, so it is a spy on the
 * prototype — which is also what makes "which element" observable at all.
 */
describe('an outline entry goes to its heading', () => {
  /** Records the elements `scrollIntoView` was called on, in order. */
  function spyScroll() {
    const hit: Element[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      hit.push(this);
    });
    return { hit, spy };
  }

  const MULTI_BODY = [
    '# Fully mobile-responsive tm8',
    '',
    'Opening prose.',
    '',
    '## 0. Correcting the premise',
    '',
    'More prose.',
    '',
    '## Phase 7 — The `zoom: 1.1` decision',
    '',
    'Yet more prose.',
    '',
    '### Proof standard',
    '',
    'Deeper still.',
    '',
    '## Proof standard',
    '',
    'A second section of the same name, one level up.',
  ].join('\n');

  function renderMulti() {
    return renderReader({ detail: docDetail(MULTI_BODY, { childCount: 0, children: [] }) });
  }

  it('scrolls the heading the entry names, not the first one', () => {
    const { hit, spy } = spyScroll();
    const { getAllByTestId } = renderMulti();
    const outline = getAllByTestId('reader-outline')[0]!;
    const entries = within(outline).getAllByTestId('reader-toc-chip');

    fireEvent.click(entries[1]!); // "0. Correcting the premise"
    expect(hit).toHaveLength(1);
    expect(hit[0]!.tagName).toBe('H2');
    expect(hit[0]!.textContent).toBe('0. Correcting the premise');
    spy.mockRestore();
  });

  it('tells two identically-titled headings apart', () => {
    const { hit, spy } = spyScroll();
    const { getAllByTestId } = renderMulti();
    const entries = within(getAllByTestId('reader-outline')[0]!).getAllByTestId('reader-toc-chip');
    // Entries 3 and 4 are the `###` and the `##` both called "Proof standard".
    const labels = entries.map((e) => e.textContent);
    expect(labels[3]).toBe('Proof standard');
    expect(labels[4]).toBe('Proof standard');

    fireEvent.click(entries[3]!);
    fireEvent.click(entries[4]!);
    expect(hit).toHaveLength(2);
    // Same text, DIFFERENT elements, and each at its own level — the whole
    // point of slugging in document order with a dedup suffix.
    expect(hit[0]).not.toBe(hit[1]);
    expect(hit[0]!.tagName).toBe('H3');
    expect(hit[1]!.tagName).toBe('H2');
    spy.mockRestore();
  });

  it('scrolls the heading inside ITS OWN body when the same doc is mounted twice', () => {
    const { hit, spy } = spyScroll();
    const { getAllByTestId } = renderMulti();
    const bodies = getAllByTestId('reader-body');
    expect(bodies).toHaveLength(2);

    // The SECOND mount (the dark copy) is the one that would break under a
    // document-wide id lookup.
    const entries = within(getAllByTestId('reader-outline')[1]!).getAllByTestId('reader-toc-chip');
    fireEvent.click(entries[1]!);
    expect(hit).toHaveLength(1);
    expect(bodies[1]!.contains(hit[0]!)).toBe(true);
    expect(bodies[0]!.contains(hit[0]!)).toBe(false);
    spy.mockRestore();
  });

  it('moves focus to the heading so a keyboard user arrives with it', () => {
    // Without this the viewport moves and the caret stays in the list, so every
    // subsequent Tab walks the outline again instead of the section.
    const { spy } = spyScroll();
    const { getAllByTestId } = renderMulti();
    const entries = within(getAllByTestId('reader-outline')[0]!).getAllByTestId('reader-toc-chip');
    fireEvent.click(entries[1]!);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('0. Correcting the premise');
    spy.mockRestore();
  });

  it('strips inline markdown from the label but not from the rendered heading', () => {
    const { getAllByTestId } = renderMulti();
    const entries = within(getAllByTestId('reader-outline')[0]!).getAllByTestId('reader-toc-chip');
    // The chip row printed the backticks verbatim. The list is a set of
    // destinations, so the label is plain text …
    expect(entries[2]!.textContent).toBe('Phase 7 — The zoom: 1.1 decision');
    // … while the document itself still renders the code span.
    const md = getAllByTestId('reader-markdown')[0]!;
    expect(md.querySelector('h2 code')?.textContent).toBe('zoom: 1.1');
  });

  it('draws a real list, indented by the depth the document uses', () => {
    const { getAllByTestId } = renderMulti();
    const outline = getAllByTestId('reader-outline')[0]!;
    // A <nav> around an <ol>: the count, the order and the nesting are audible
    // to a screen reader, which a bare div of pills gave it none of.
    expect(outline.tagName).toBe('NAV');
    expect(outline.getAttribute('aria-label')).toBe('Table of contents');
    const items = outline.querySelectorAll('li');
    expect(items).toHaveLength(5);
    // `#` → 0, `##` → 1, `###` → 2. Depth is relative to the shallowest
    // heading the document actually uses, so a doc of all-`##` is flat.
    expect([...items].map((li) => li.getAttribute('data-depth'))).toEqual(['0', '1', '1', '2', '1']);
  });

  it('names itself on screen, not only to a screen reader', () => {
    /* The `aria-label` above is what a screen reader hears; a sighted reader
       got nineteen grey lines and no word saying they were navigation, which
       is half of the 2026-08-31 report. The eyebrow is presentational — the
       <nav> already carries the accessible name — so it is aria-hidden and the
       label above must stay the single announced one. */
    const { getAllByTestId } = renderMulti();
    const outline = getAllByTestId('reader-outline')[0]!;
    const head = outline.querySelector('.rd-toc__head');
    expect(head?.textContent).toBe('Contents');
    expect(head?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is flat for a document that never uses its top level', () => {
    const { getAllByTestId } = renderReader({
      detail: docDetail(['## One', '', 'a', '', '## Two', '', 'b'].join('\n'), {
        childCount: 0,
        children: [],
      }),
    });
    const items = getAllByTestId('reader-outline')[0]!.querySelectorAll('li');
    expect([...items].map((li) => li.getAttribute('data-depth'))).toEqual(['0', '0']);
  });

  it('renders a chapter chip disabled-with-reason when no dispatch was supplied', () => {
    // R7 / the five-dead-verbs finding: a chip that looks live and does
    // nothing is indistinguishable from a broken app.
    const { getAllByTestId } = renderReader({ onOpenEntity: undefined });
    const outline = getAllByTestId('reader-outline')[0]!;
    // No <button> element at all — the disabled treatment carries role=button
    // deliberately (it stays focusable so the reason is reachable), so the
    // assertion is on the ELEMENT, not the role.
    expect(outline.querySelectorAll('button')).toHaveLength(0);
    const disabled = within(outline).getAllByTestId('disabled-with-reason');
    expect(disabled).toHaveLength(4);
    expect(disabled[0]!.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the reading column', () => {
  it('renders the prose paragraphs in document order', () => {
    const { getAllByTestId } = renderReader();
    const body = getAllByTestId('reader-body')[0]!;
    const md = within(body).getAllByTestId('reader-markdown')[0]!;
    // DIRECT children only: a blockquote renders its own inner <p>, so an
    // unscoped `p` query counts the quote as a third paragraph.
    const paragraphs = [...md.querySelectorAll(':scope > p')].map((el) => el.textContent);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('Every shrinkable region states a floor');
    expect(paragraphs[1]).toContain('The center hosts pinned panels');
  });

  it('gives a quoted line the rule treatment, outside the prose flow', () => {
    const { getAllByTestId } = renderReader();
    const body = getAllByTestId('reader-body')[0]!;
    const md = within(body).getAllByTestId('reader-markdown')[0]!;
    const quote = md.querySelector('blockquote')!;
    expect(quote.textContent).toContain('C_min = max(320, V·320 + (V−1)·8)');
    // The quote is its own block, never folded back into a sibling paragraph.
    for (const p of md.querySelectorAll(':scope > p')) {
      expect(p.textContent).not.toContain('C_min');
    }
  });

  it('renders a heading AS a heading, and lists it in the outline too', () => {
    // REVERSES the earlier rule that a heading was promoted out of the column
    // and never restated (user ruling 2026-07-31). Headings now live in both
    // places on purpose: the outline is navigation, the body is the document.
    // What must never happen is the `#` leaking through as literal text, which
    // is the failure a non-renderer produces.
    const { getAllByTestId } = renderReader();
    const md = getAllByTestId('reader-markdown')[0]!;
    const heading = md.querySelector('h1, h2, h3')!;
    expect(heading).not.toBeNull();
    expect(heading.textContent).toBe('Layout spec');
    for (const p of md.querySelectorAll('p')) {
      expect(p.textContent).not.toContain('#');
    }
  });

  it('renders the markdown shapes the old four-shape parser destroyed', () => {
    // The regression this renderer exists to prevent: a list rendered as one
    // run-on paragraph, `**bold**` printed as asterisks, a fence hidden behind
    // a "not rendered" placeholder.
    const { getAllByTestId } = renderReader({
      detail: docDetail(
        '- alpha\n- beta\n\nA **bold** word and `code`.\n\n```ts\nconst x = 1;\n```',
        { childCount: 0, children: [] },
      ),
    });
    const md = getAllByTestId('reader-markdown')[0]!;
    expect(md.querySelectorAll('li')).toHaveLength(2);
    expect(md.querySelector('strong')!.textContent).toBe('bold');
    expect(md.querySelector('code')!.textContent).toBe('code');
    const fence = md.querySelector('[data-testid="markdown-fence"]')!;
    expect(fence.getAttribute('data-lang')).toBe('ts');
    expect(fence.textContent).toContain('const x = 1;');
    expect(md.textContent).not.toContain('not rendered');
    expect(md.textContent).not.toContain('**');
  });

  it('wears the DOCUMENT stance, so the reader and the editor preview read alike', () => {
    /* `md-doc` is what carries the reading size, leading and measure
       (`kit/markdown.css`). It cannot be asserted as pixels — this suite runs
       with `css: false` and can see no stylesheet at all — so what is pinned
       here is that the stance is REQUESTED. `DocPreview` requests the same one;
       if either drops it, one of the two surfaces silently falls back to the
       chat-bubble size and "what it will look like" stops being true. */
    const { getAllByTestId } = renderReader();
    expect(getAllByTestId('reader-markdown')[0]!.className.split(/\s+/)).toContain('md-doc');
  });

  it('renders the designed empty when the document has no content at all', () => {
    const { getAllByTestId, queryAllByTestId } = renderReader({
      detail: docDetail('', { childCount: 0, children: [] }),
    });
    expect(getAllByTestId('panel-empty')).toHaveLength(2);
    expect(queryAllByTestId('reader-markdown')).toHaveLength(0);
  });
});

describe('the facts line under the column', () => {
  it('states the chapter count and the format the record carries', () => {
    const { getAllByTestId } = renderReader();
    const facts = getAllByTestId('reader-facts')[0]!;
    expect(facts.textContent).toContain('4 chapters');
    expect(facts.textContent).toContain('markdown');
  });

  it('renders `history` disabled, carrying the injected reason — never a live control', () => {
    const { getAllByTestId } = renderReader();
    const facts = getAllByTestId('reader-facts')[0]!;
    expect(within(facts).queryAllByRole('link')).toHaveLength(0);
    const history = within(facts).getAllByTestId('disabled-with-reason')[0]!;
    expect(history.getAttribute('aria-disabled')).toBe('true');
    expect(history.textContent).toContain('history');
    // The reason is IN THE DOM, not only on hover — a reason a screen reader
    // cannot reach is not a reason. Both halves: `toReason` splits the
    // sentence at the em-dash into the canvas's cause/remedy voice, so the
    // string arrives as two spans rather than one.
    expect(facts.textContent).toContain('Version history is not built in this build');
    expect(facts.textContent).toContain('the version is real, the timeline is not.');
  });

  it('omits a fact it does not hold rather than printing a zero', () => {
    const noChapters = docDetail('Prose.', { childCount: 0, children: [] });
    const { getAllByTestId } = renderReader({ detail: noChapters });
    const facts = getAllByTestId('reader-facts')[0]!;
    expect(facts.textContent).not.toContain('0 chapters');
    expect(facts.textContent).toContain('markdown');
  });
});

describe('§15.2 — this is an ARCHETYPE body, not a doc body', () => {
  it('renders the same anatomy for another kind whose prose lives in `description`', () => {
    // A collection routed through the reader archetype: different kind,
    // different content member, identical reading column. If this file ever
    // learns a kind, this is the test that stops passing.
    const base = summaryOf('col-reading-list', 'Reading list', {
      kind: 'collection',
      collectionType: 'set',
      itemCount: 2,
    });
    const detail: EntityDetail = {
      ...base,
      content: {
        kind: 'collection',
        description: 'Everything the floors argument rests on.\n\n> floors are law, not preference',
        items: [],
      },
      hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
      connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
      capabilities: CAPS,
    };
    const { getAllByTestId } = renderReader({ detail });
    const md = getAllByTestId('reader-markdown')[0]!;
    expect(md.querySelector('p')!.textContent).toContain('Everything the floors argument');
    expect(md.querySelector('blockquote')!.textContent).toContain('floors are law, not preference');
    expect(getAllByTestId('reader-facts')).toHaveLength(2);
  });
});

describe('the registry drives the additions, not a branch', () => {
  it('renders a `notice` block’s honest text under the column', () => {
    const { getAllByTestId } = renderReader({
      blocks: [{ block: 'notice', params: { text: 'Chapter bodies are not fetched in this build.' } }],
    });
    expect(getAllByTestId('reader-notice')[0]!.textContent).toBe(
      'Chapter bodies are not fetched in this build.',
    );
  });

  it('renders no notice when the registry declares none', () => {
    const { queryAllByTestId } = renderReader();
    expect(queryAllByTestId('reader-notice')).toHaveLength(0);
  });
});
