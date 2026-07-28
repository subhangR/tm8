// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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
 *  · a table-of-contents chip that navigates nowhere is a dead control (R7):
 *    entity-backed entries are live only when a dispatch exists, and the
 *    outline read out of the prose is a LABEL, never a control.
 *  · `history ▸` is the deferred version-history feature's in-body home, so
 *    it renders disabled-carrying-its-reason and never as a live button.
 *
 * The objects below are authored against the contract types (no casts, no
 * optional chains) so tsc fails here if the shape drifts, rather than the
 * assertions quietly passing over an `any`.
 */

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

  it('never makes a heading-derived chip clickable — it is a label, not a control', () => {
    const onOpenEntity = vi.fn();
    const { getAllByTestId } = renderReader({
      detail: docDetail(FIXTURE_BODY, { childCount: 1, children: [] }),
      onOpenEntity,
    });
    const chip = within(getAllByTestId('reader-outline')[0]!).getAllByTestId('reader-toc-chip')[0]!;
    expect(chip.tagName).not.toBe('BUTTON');
    fireEvent.click(chip);
    expect(onOpenEntity).not.toHaveBeenCalled();
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
    const paragraphs = within(body).getAllByTestId('reader-prose').map((el) => el.textContent);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('Every shrinkable region states a floor');
    expect(paragraphs[1]).toContain('The center hosts pinned panels');
  });

  it('gives a quoted line the rule treatment, outside the prose flow', () => {
    const { getAllByTestId } = renderReader();
    const body = getAllByTestId('reader-body')[0]!;
    const quote = within(body).getAllByTestId('reader-quote')[0]!;
    expect(quote.textContent).toBe('C_min = max(320, V·320 + (V−1)·8)');
    for (const p of within(body).getAllByTestId('reader-prose')) {
      expect(p.textContent).not.toContain('C_min');
    }
  });

  it('promotes a heading to the outline rather than restating it as prose', () => {
    // Deliberate, and the reason is D5-shaped: the oracle's in-panel column
    // draws prose and quote only — there is no MEASURED in-panel heading
    // style to ship, and an eyeballed one is exactly what D5 forbids.
    const { getAllByTestId } = renderReader();
    for (const p of getAllByTestId('reader-prose')) {
      expect(p.textContent).not.toBe('Layout spec');
      expect(p.textContent).not.toContain('#');
    }
  });

  it('renders the designed empty when the document has no content at all', () => {
    const { getAllByTestId, queryAllByTestId } = renderReader({
      detail: docDetail('', { childCount: 0, children: [] }),
    });
    expect(getAllByTestId('panel-empty')).toHaveLength(2);
    expect(queryAllByTestId('reader-prose')).toHaveLength(0);
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
    expect(getAllByTestId('reader-prose')[0]!.textContent).toContain('Everything the floors argument');
    expect(getAllByTestId('reader-quote')[0]!.textContent).toBe('floors are law, not preference');
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
