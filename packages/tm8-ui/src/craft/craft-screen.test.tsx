// @vitest-environment jsdom
/**
 * ONE DESIGN, MOUNTED — `DesignScreen` over the fixture seam and a fixture
 * design source, plus the GateApp router mounts at `#/s/{s}/craft[/{id}]`
 * (Craft → Designs, change list items 10–13).
 *
 * What these cases pin:
 *  · the routes: bare `/craft` is the Designs home, `/craft/{id}` the design;
 *  · the header `‹ Designs · Title`, and ‹ going home;
 *  · ONE empty state for a design with no pages, and `[+ page]` making one;
 *  · a graph page renders the ROW and re-renders on its patch event (R1),
 *    mermaid and unknown graph types included;
 *  · the page row: order, selection by URL, keyboard reorder writing a
 *    position, "Remove from design" keeping the entity, the "updated" dot on
 *    a page changed while not active, and "Add existing entity…";
 *  · a nested design page draws its own smaller row in place, and a design
 *    one level deeper is cards plus Open (D7);
 *  · the chat pane: hosted SOLO, a thread picker over the design's chats, and
 *    ＋ New chat back to the composer after a send;
 *  · Orchestrate, the graph picker and the old chat picker are gone (D4).
 *
 * jsdom loads no stylesheets (the recurring law): structure and text only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { createFixtureSeam } from '../data';
import { DesignScreen, type DesignTarget } from './DesignScreen';
import { fixtureDesignSource, positionAt } from './design-source';

const SPACE = FIXTURE_SPACE_ID;
const DESIGN = 'design-1' as EntityId;

function installStorage(): void {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
}

beforeEach(() => {
  installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
});

type Seam = ReturnType<typeof createFixtureSeam>;
type Source = ReturnType<typeof fixtureDesignSource>;

/** The host's URL, held in state, so the screen's navigation is observable. */
function Harness({ seam, source, initial, onTarget }: { seam: Seam; source: Source; initial: DesignTarget; onTarget?: (t: DesignTarget) => void }) {
  const [target, setTarget] = useState(initial);
  if (!target.designId) return <div data-testid="went-home" />;
  return (
    <DesignScreen
      seam={seam}
      spaceId={SPACE}
      nodeKey="fixture"
      source={source}
      designId={target.designId}
      pageId={target.pageId}
      nestedPageId={target.nestedPageId}
      onNavigate={(next) => {
        onTarget?.(next);
        setTarget(next);
      }}
    />
  );
}

async function mountDesign(setup?: (seam: Seam, source: Source) => Promise<void>, initial: DesignTarget = { designId: DESIGN }) {
  const seam = createFixtureSeam();
  await seam.openSpace(SPACE);
  const source = fixtureDesignSource(seam, SPACE, [{ id: DESIGN, title: 'Launch plan' }]);
  await setup?.(seam, source);
  const targets: DesignTarget[] = [];
  const view = render(<Harness seam={seam} source={source} initial={initial} onTarget={(t) => targets.push(t)} />);
  await waitFor(() => view.getByTestId('design-screen'));
  return { seam, source, view, targets };
}

async function createGraph(seam: Seam, title: string, content: Record<string, unknown> = { graphType: 'entity' }) {
  const created = await seam.commands.createEntity({ clientMutationId: `t-${title}`, spaceId: SPACE, kind: 'graph', title, content });
  return created.entity!.id as EntityId;
}

async function createDoc(seam: Seam, title: string) {
  const created = await seam.commands.createEntity({ clientMutationId: `t-${title}`, spaceId: SPACE, kind: 'doc', title });
  return created.entity!.id as EntityId;
}

const tabTitles = (view: ReturnType<typeof render>) =>
  within(view.getByTestId('dsn-pages')).getAllByRole('tab').map((tab) => tab.textContent);

describe('the craft routes', () => {
  it('mounts the Designs home at bare #/s/{s}/craft', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/craft`)} />);
    await waitFor(() => view.getByTestId('designs-home'));
    expect(view.queryByTestId('design-screen')).toBeNull();
    view.unmount();
  });

  it('mounts the design screen at #/s/{s}/craft/{id}', async () => {
    const view = render(
      <GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/craft/019f98a0-aaaa-bbbb-cccc-000000000041`)} />,
    );
    await waitFor(() => view.getByTestId('design-screen'));
    expect(view.queryByTestId('designs-home')).toBeNull();
    expect(view.queryByTestId('craft-screen')).toBeNull();
    view.unmount();
  });
});

describe('the design screen', () => {
  it('heads the screen ‹ Designs · Title, and ‹ goes home', async () => {
    const { view } = await mountDesign();
    await waitFor(() => expect(view.getByTestId('dsn-title').textContent).toBe('Launch plan'));
    const head = view.getByTestId('dsn-head');
    expect(head.textContent).toContain('Designs');
    fireEvent.click(view.getByTestId('dsn-back'));
    await waitFor(() => view.getByTestId('went-home'));
  });

  it('draws no Orchestrate, no graph picker and no header chat picker (D4)', async () => {
    const { view } = await mountDesign();
    await waitFor(() => view.getByTestId('dsn-no-pages'));
    for (const gone of ['crf-orchestrate', 'crf-picker', 'crf-chat-picker', 'crf-no-graph']) {
      expect(view.queryByTestId(gone)).toBeNull();
    }
  });

  it('says a design has no pages ONCE, and [+ page] → Graph makes and opens one', async () => {
    const { view, source, targets } = await mountDesign();
    await waitFor(() => view.getByTestId('dsn-no-pages'));
    fireEvent.click(view.getByTestId('dsn-add-page'));
    const menu = view.getByTestId('dsn-add-menu');
    /* The five kinds and the existing-entity door. */
    for (const kind of ['graph', 'doc', 'artifact', 'drawing', 'design']) {
      expect(within(menu).getByTestId(`dsn-new-${kind}`)).toBeTruthy();
    }
    expect(within(menu).getByTestId('membership-add').textContent).toBe('Add existing entity…');
    fireEvent.click(within(menu).getByTestId('dsn-new-graph'));
    await waitFor(() => view.getByTestId('crf-empty'));
    expect(tabTitles(view)).toEqual(['Untitled graph']);
    const pageId = source.designs.get(DESIGN)!.pages[0]!.id;
    expect(targets.at(-1)).toEqual({ designId: DESIGN, pageId });
  });

  it('Artifact asks the agent in the chat, which is the one door an artifact has', async () => {
    const { view } = await mountDesign();
    await waitFor(() => view.getByTestId('dsn-no-pages'));
    await waitFor(() => view.getByLabelText('Message the chat agent'));
    fireEvent.click(view.getByTestId('dsn-add-page'));
    fireEvent.click(view.getByTestId('dsn-new-artifact'));
    const area = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toContain('artifact page'));
  });
});

describe('a graph page', () => {
  it('renders the ROW on the canvas and re-renders on its patch event (R1)', async () => {
    let graphId = '' as EntityId;
    const { seam, view } = await mountDesign(async (s, source) => {
      graphId = await createGraph(s, 'Launch flow');
      await source.placePage(DESIGN, graphId, 1);
    });
    await waitFor(() => view.getByTestId('crf-empty'));

    /* The agent's move: ONE guarded patch to the row, picked up from the
       durable event — there is no other channel. */
    await seam.commands.patchEntity(graphId, {
      clientMutationId: 'crf-test-2',
      expectedVersion: 1,
      content: {
        graphType: 'entity',
        nodes: [
          { key: 'a', spec: { kind: 'task', title: 'Ship API', hint: 'REST' } },
          { key: 'b', spec: { kind: 'task', title: 'Ship UI' } },
        ],
        edges: [
          { src: 'b', dst: 'a', type: 'depends_on' },
          { src: 'b', dst: 'ghost', type: 'relates_to' },
        ],
      },
    });

    await waitFor(() => view.getByTestId('crf-canvas'));
    const canvas = view.getByTestId('crf-canvas');
    expect(canvas.textContent).toContain('Ship API');
    expect(canvas.querySelectorAll('.crf-node--spec')).toHaveLength(2);
    expect(canvas.textContent).toContain('blocks');
    /* The dangling edge is a FINDING, and its chip is a page control. */
    await waitFor(() => view.getByTestId('crf-issues'));
    expect(view.getByTestId('crf-issues').getAttribute('aria-label')).toContain('1 error');

    await seam.commands.patchEntity(graphId, {
      clientMutationId: 'crf-test-2b',
      expectedVersion: 2,
      content: {
        graphType: 'entity',
        nodes: [
          { key: 'a', spec: { kind: 'task', title: 'Ship API', hint: 'REST' } },
          { key: 'b', spec: { kind: 'task', title: 'Ship UI' } },
          { key: 'c', spec: { kind: 'task', title: 'Ship docs' } },
        ],
        edges: [{ src: 'b', dst: 'a', type: 'depends_on' }],
      },
    });
    await waitFor(() => expect(view.getByTestId('crf-canvas').textContent).toContain('Ship docs'));
    /* Wait for the glow, not just the card: the fresh set is an effect after the fold. */
    const freshCells = await waitFor(() => {
      const cells = view.getByTestId('crf-canvas').querySelectorAll('.crf-node--marked');
      expect(cells).toHaveLength(1);
      return cells;
    });
    expect(freshCells[0]!.textContent).toContain('Ship docs');
    expect(view.getByTestId('crf-diff-summary').textContent).toContain('+1 node');
  });

  it('renders a mermaid row through the Mermaid path, not the card canvas', async () => {
    const { view } = await mountDesign(async (seam, source) => {
      await source.placePage(DESIGN, await createGraph(seam, 'Auth sketch', { graphType: 'mermaid', source: 'flowchart TD; login-->token' }), 1);
    });
    await waitFor(() => view.getByTestId('crf-mermaid'));
    expect(view.queryByTestId('crf-canvas')).toBeNull();
  });

  it('says so honestly for a graphType this build cannot draw (R3 forward-compat)', async () => {
    const { view } = await mountDesign(async (seam, source) => {
      await source.placePage(DESIGN, await createGraph(seam, 'State machine', { graphType: 'statechart' }), 1);
    });
    await waitFor(() => view.getByTestId('crf-unknown-type'));
    expect(view.getByTestId('crf-unknown-type').textContent).toContain('statechart');
  });
});

describe('the page row', () => {
  async function threePages() {
    const ids: EntityId[] = [];
    const mounted = await mountDesign(async (seam, source) => {
      ids.push(await createGraph(seam, 'Plan'), await createDoc(seam, 'Brief'), await createGraph(seam, 'Rollout'));
      for (const [index, id] of ids.entries()) await source.placePage(DESIGN, id, index + 1);
    });
    await waitFor(() => expect(tabTitles(mounted.view)).toEqual(['Plan', 'Brief', 'Rollout']));
    return { ...mounted, ids };
  }

  it('is the design’s pages in order, the first active, and a tab press navigates', async () => {
    const { view, ids, targets } = await threePages();
    const tabs = within(view.getByTestId('dsn-pages')).getAllByRole('tab');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tabs[2]!);
    await waitFor(() => expect(targets.at(-1)).toEqual({ designId: DESIGN, pageId: ids[2] }));
    await waitFor(() =>
      expect(within(view.getByTestId('dsn-pages')).getAllByRole('tab')[2]!.getAttribute('aria-selected')).toBe('true'),
    );
  });

  it('a page outside a Workspace host says what it is and offers Open', async () => {
    const { view, ids } = await threePages();
    fireEvent.click(within(view.getByTestId('dsn-pages')).getAllByRole('tab')[1]!);
    const plain = await waitFor(() => view.getByTestId('dsn-plain-page'));
    expect(plain.textContent).toContain('Brief');
    expect(ids[1]).toBeTruthy();
  });

  it('Alt+→ moves a page one place and writes ONE position between its new neighbours', async () => {
    const { view, source, ids } = await threePages();
    const first = within(view.getByTestId('dsn-pages')).getAllByRole('tab')[0]!;
    fireEvent.keyDown(first, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(tabTitles(view)).toEqual(['Brief', 'Plan', 'Rollout']));
    const moved = source.designs.get(DESIGN)!.pages.find((page) => page.id === ids[0])!;
    expect(moved.position).toBe(2.5);
  });

  it('"Remove from design" takes the page out and keeps the entity', async () => {
    const { seam, view, ids } = await threePages();
    fireEvent.click(within(view.getByTestId('dsn-pages')).getAllByTestId('dsn-tab-more')[1]!);
    fireEvent.click(view.getByTestId('dsn-remove-page'));
    await waitFor(() => expect(tabTitles(view)).toEqual(['Plan', 'Rollout']));
    /* Never a delete: the doc still reads. */
    await expect(seam.entity(ids[1]!)).resolves.toMatchObject({ title: 'Brief' });
  });

  it('marks a page changed while not active, and the mark clears when it is opened', async () => {
    const { seam, view, ids } = await threePages();
    expect(view.queryByTestId('dsn-updated')).toBeNull();
    await seam.commands.patchEntity(ids[2]!, {
      clientMutationId: 'crf-upd',
      expectedVersion: 1,
      content: { graphType: 'entity', nodes: [{ key: 'x', spec: { kind: 'task', title: 'Flip flag' } }], edges: [] },
    });
    const dot = await waitFor(() => view.getByTestId('dsn-updated'));
    expect(dot.closest('[data-page]')?.getAttribute('data-page')).toBe(ids[2]);
    /* The page the viewer is on did not move: agents never switch pages. */
    expect(within(view.getByTestId('dsn-pages')).getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(view.getByTestId('dsn-pages')).getAllByRole('tab')[2]!);
    await waitFor(() => expect(view.queryByTestId('dsn-updated')).toBeNull());
  });

  it('"Add existing entity…" puts a recent entity in as a page', async () => {
    const { view, seam } = await threePages();
    const extra = await createDoc(seam, 'Pricing notes');
    fireEvent.click(view.getByTestId('dsn-add-page'));
    fireEvent.click(view.getByTestId('membership-add'));
    const option = await waitFor(() =>
      view.getAllByTestId('membership-option').find((button) => button.textContent?.includes('Pricing notes'))!,
    );
    fireEvent.click(option);
    await waitFor(() => expect(tabTitles(view)).toEqual(['Plan', 'Brief', 'Rollout', 'Pricing notes']));
    expect(extra).toBeTruthy();
  });
});

describe('a nested design page (D7)', () => {
  it('draws its own smaller row in place, and a design one level deeper is cards plus Open', async () => {
    const { view, targets } = await mountDesign(async (seam, source) => {
      const plan = await createGraph(seam, 'Plan');
      await source.placePage(DESIGN, plan, 1);
      const nested = await source.createPage(DESIGN, 'design', 2);
      source.designs.get(nested)!.title = 'Backend';
      await source.placePage(nested, await createGraph(seam, 'API flow'), 1);
      const deeper = await source.createPage(nested, 'design', 2);
      source.designs.get(deeper)!.title = 'Storage';
      await source.placePage(deeper, await createDoc(seam, 'Schema'), 1);
    });
    await waitFor(() => expect(tabTitles(view)).toEqual(['Plan', 'Backend']));
    fireEvent.click(within(view.getByTestId('dsn-pages')).getAllByRole('tab')[1]!);

    /* Two rows on screen: the parent's stays, the nested one sits under it. */
    const nestedRow = await waitFor(() => view.getByTestId('dsn-nested-pages'));
    expect(view.getByTestId('dsn-pages')).toBeTruthy();
    await waitFor(() =>
      expect(within(nestedRow).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['API flow', 'Storage']),
    );
    await waitFor(() => view.getByTestId('crf-empty'));

    /* The design inside the nested one: no third row — cards and Open. */
    fireEvent.click(within(view.getByTestId('dsn-nested-pages')).getAllByRole('tab')[1]!);
    const cards = await waitFor(() => view.getByTestId('dsn-design-cards'));
    expect(view.queryAllByTestId('dsn-nested-pages')).toHaveLength(1);
    await waitFor(() => expect(within(cards).getAllByTestId('dsn-page-card').map((c) => c.textContent)).toEqual([expect.stringContaining('Schema')]));
    fireEvent.click(within(cards).getByTestId('dsn-open-design'));
    await waitFor(() => expect(targets.at(-1)?.designId).toMatch(/^fixture-design-page-/));
    expect(targets.at(-1)?.pageId).toBeUndefined();
  });
});

describe('the chat pane', () => {
  it('hosts the conversation SOLO — no thread sidebar inside the chat pane', async () => {
    const { view } = await mountDesign();
    await waitFor(() => view.container.querySelector('.tch-root'));
    expect(view.container.querySelector('.tch-root--solo')).toBeTruthy();
    expect(view.container.querySelector('.tch-sidebar')).toBeNull();
    expect(view.queryByRole('tablist', { name: 'Home roots' })).toBeNull();
    /* The divider between chat and pages is a real separator. */
    expect(view.getByTestId('panel-resizer-left')).toBeTruthy();
  });

  it('lists only the chats about this design, and says so when there are none', async () => {
    const { view } = await mountDesign();
    fireEvent.click(await waitFor(() => view.getByTestId('dsn-thread-picker')));
    /* The fixture's threads are about other things and not craft-mode. */
    await waitFor(() => view.getByTestId('dsn-thread-empty'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('dsn-thread-pop')).toBeNull());
  });

  it('returns to the composer when ＋ New chat is pressed after a send created a thread', async () => {
    const { view } = await mountDesign();
    const picker = await waitFor(() => view.getByTestId('dsn-thread-picker'));
    await waitFor(() => expect(picker.textContent).toContain('New chat'));
    fireEvent.change(await waitFor(() => view.getByLabelText('Message the chat agent')), {
      target: { value: 'Draft the plan.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByTestId('dsn-thread-picker').textContent).not.toContain('New chat'));
    fireEvent.click(view.getByTestId('dsn-new-chat'));
    await waitFor(() => expect(view.getByTestId('dsn-thread-picker').textContent).toContain('New chat'));
  });
});

describe('positionAt', () => {
  it('lands between neighbours, past the ends, or on the index without positions', () => {
    const rows = [{ position: 1 }, { position: 2 }, { position: 4 }];
    expect(positionAt(rows, 0)).toBe(0);
    expect(positionAt(rows, 1)).toBe(1.5);
    expect(positionAt(rows, 3)).toBe(5);
    expect(positionAt([{ position: null }, { position: null }], 1)).toBe(2);
  });
});
