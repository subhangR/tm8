// @vitest-environment jsdom
/**
 * THE HELP SHELF — the graph resolver and the screen it feeds.
 *
 * WHAT THESE CASES EXIST TO PIN, in the order they matter:
 *
 *  · THE SET COMES FROM THE GRAPH. The failure this whole surface is
 *    recovering from is five Help artifacts published and orphaned because
 *    nothing could name them; the failure it would be easy to ship in its
 *    place is a hardcoded list, which makes every future Help page a DEPLOY.
 *    So the resolver is tested through a seam that answers a collection and
 *    its edges, and the screen is tested to list exactly what came back.
 *
 *  · ORDER IS THE EDGE'S. `contains` carries `props.position`, and the
 *    reading order is a property of the CURATION rather than of when an
 *    artifact happened to be published. The out-of-order fixture below would
 *    pass a test that trusted arrival order, which is why it is out of order.
 *
 *  · THE EMPTY STATE IS A REAL ANSWER. A Space with no shelf is told what the
 *    collection is called, because the fix is a graph write somebody can
 *    perform. A screen that spun forever would be the same bug in a nicer
 *    costume.
 *
 *  · THE PHONE IS ONE COLUMN AND HAS A WAY BACK. `stacked` opens on the
 *    contents (never inside a page nobody chose) and a page opened over them
 *    carries a back verb — the only exit on a phone.
 *
 * jsdom loads no stylesheets (the recurring law of this suite), so nothing
 * here claims colour, width or geometry — presence, order and text only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { HELP_COLLECTION_TITLE, loadHelpSet } from './help-set';
import { HelpScreen } from './HelpScreen';

const SPACE = FIXTURE_SPACE_ID as SpaceId;

function summary(id: string, kind: string, title: string): EntitySummary {
  return { id: id as EntityId, kind, title } as unknown as EntitySummary;
}

/**
 * A seam that answers ONE collection scan and ONE edge read.
 *
 * `edges` arrive DELIBERATELY OUT OF READING ORDER: the resolver must sort by
 * `props.position`, and a fixture already in order could not tell a real sort
 * from a passthrough.
 */
function shelfSeam(options: {
  collections?: readonly EntitySummary[];
  edges?: readonly { position?: number; target: EntitySummary }[];
  fail?: boolean;
}): Seam {
  return {
    query: async () => {
      if (options.fail) throw new Error('unreachable');
      return { page: { items: options.collections ?? [] } };
    },
    connections: async () => ({
      items: (options.edges ?? []).map((edge, index) => ({
        id: `edge-${index}`,
        type: 'contains',
        target: edge.target,
        props: edge.position === undefined ? {} : { position: edge.position },
      })),
    }),
  } as unknown as Seam;
}

const SHELF = summary('col-help', 'collection', HELP_COLLECTION_TITLE);

/** Three pages wired out of order, so the sort has something to do. */
const SCRAMBLED = [
  { position: 3, target: summary('art-3', 'artifact', 'Tasks & work') },
  { position: 1, target: summary('art-1', 'artifact', 'The concepts map') },
  { position: 2, target: summary('art-2', 'artifact', 'Entities & the graph') },
];

beforeEach(() => {
  resetNav();
  screenStackStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
});

describe('the help set', () => {
  it('reads the collection by title and orders its pages by edge position', async () => {
    const set = await loadHelpSet(shelfSeam({ collections: [SHELF], edges: SCRAMBLED }), SPACE);
    expect(set.collectionId).toBe('col-help');
    expect(set.pages.map((page) => page.title)).toEqual([
      'The concepts map',
      'Entities & the graph',
      'Tasks & work',
    ]);
  });

  it('appends an unpositioned page instead of promoting it to the front', async () => {
    /* An edge wired with no position is a curation somebody left incomplete.
       Sinking it is the honest reading — silently making it page one would
       hand it the "start here" seat nobody gave it. */
    const set = await loadHelpSet(
      shelfSeam({
        collections: [SHELF],
        edges: [{ target: summary('art-x', 'artifact', 'Unwired') }, ...SCRAMBLED],
      }),
      SPACE,
    );
    expect(set.pages.map((page) => page.title).at(-1)).toBe('Unwired');
  });

  it('drops a non-artifact member rather than handing it to the preview path', async () => {
    /* `contains` may point at anything (`destinationKinds: ['*']`), and this
       screen renders through the artifact preview block. Rejection here beats
       a viewer that has no way to draw what it was given. */
    const set = await loadHelpSet(
      shelfSeam({
        collections: [SHELF],
        edges: [{ position: 1, target: summary('t-1', 'task', 'Not a page') }, ...SCRAMBLED],
      }),
      SPACE,
    );
    expect(set.pages.map((page) => page.kind)).toEqual(['artifact', 'artifact', 'artifact']);
  });

  it('answers empty — not an error — for a space with no shelf', async () => {
    const set = await loadHelpSet(shelfSeam({ collections: [summary('c', 'collection', 'Reading')] }), SPACE);
    expect(set).toEqual({ collectionId: null, pages: [] });
  });
});

describe('the help screen', () => {
  it('lists the curated pages in order and opens page one on a wide screen', async () => {
    const view = render(
      <HelpScreen seam={shelfSeam({ collections: [SHELF], edges: SCRAMBLED })} spaceId={SPACE} />,
    );
    await waitFor(() => expect(view.getAllByTestId('help-row')).toHaveLength(3));
    expect(view.getAllByTestId('help-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('The concepts map'),
      expect.stringContaining('Entities & the graph'),
      expect.stringContaining('Tasks & work'),
    ]);
    /* Page one is selected without a press — the wide screen has room for the
       reader beside the shelf, and an empty pane there would be a wasted half
       of the window. `help-no-host` is the reader saying it has no shell
       bundle behind it, which is TRUE of this mount: it is still the reader. */
    await waitFor(() => view.getByTestId('help-no-host'));
    view.unmount();
  });

  it('names the collection that would fix an empty shelf', async () => {
    const view = render(<HelpScreen seam={shelfSeam({})} spaceId={SPACE} />);
    const none = await waitFor(() => view.getByTestId('help-none'));
    expect(none.textContent).toContain(HELP_COLLECTION_TITLE);
    view.unmount();
  });

  it('says the shelf could not be READ, distinctly from having none', async () => {
    /* Two different statements about the graph, and a reader is owed the right
       one: "this Space has no Help" is repairable by a graph write, "this node
       could not answer" is not. */
    const view = render(<HelpScreen seam={shelfSeam({ fail: true })} spaceId={SPACE} />);
    await waitFor(() => view.getByTestId('help-error'));
    expect(view.queryByTestId('help-none')).toBeNull();
    view.unmount();
  });

  it('opens on the contents on a phone, and a page carries a way back', async () => {
    const view = render(
      <HelpScreen
        seam={shelfSeam({ collections: [SHELF], edges: SCRAMBLED })}
        spaceId={SPACE}
        stacked
      />,
    );
    await waitFor(() => expect(view.getAllByTestId('help-row')).toHaveLength(3));
    /* NOT auto-opened: a stacked shell that selected page one would land a
       reader inside a page they never chose, with the shelf they came for one
       back-press away. */
    expect(view.queryByTestId('help-back')).toBeNull();

    fireEvent.click(view.getAllByTestId('help-row')[0]!);
    const back = await waitFor(() => view.getByTestId('help-back'));
    expect(view.queryAllByTestId('help-row')).toHaveLength(0);

    fireEvent.click(back);
    await waitFor(() => expect(view.getAllByTestId('help-row')).toHaveLength(3));
    view.unmount();
  });
});

describe('the help route', () => {
  it('mounts the shelf at #/s/{s}/help', async () => {
    /* The tab-mount wiring end to end: contract ref → route codec →
       `landingOfRoute` → GateApp's branch. The fixture space has no Help
       collection, so the screen answers `help-none` — which is the screen,
       correctly mounted, telling the truth about that space. */
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/help`)} />);
    await waitFor(() => view.getByTestId('help-screen'));
    view.unmount();
  });

  it('is reached from the tab bar’s ? — the door that replaces an eighth tab', async () => {
    /* THE RULING, PINNED. Help takes no seat in the tab spine: the seven
       groups there are surfaces you inhabit and Help is a reference you
       consult, so its door is a bar control beside the bell — the posture
       Inbox has held since its own rail row retired. A test that only proved
       the ROUTE works would leave the door itself unasserted, and a door
       nobody can find is the failure this whole surface is recovering from. */
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/home`)} />);
    const door = await waitFor(() => view.getByTestId('open-help'));
    expect(door.getAttribute('aria-disabled')).toBeNull();
    /* And it is NOT a tab: the tablist must not have grown one. */
    expect(
      view.getAllByRole('tab').map((tab) => tab.textContent),
    ).not.toContain('Help');

    fireEvent.click(door);
    await waitFor(() => view.getByTestId('help-screen'));
    view.unmount();
  });
});
