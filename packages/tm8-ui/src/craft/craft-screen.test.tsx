// @vitest-environment jsdom
/**
 * ONE CRAFT, MOUNTED — `CraftScreen` over the fixture seam and a fixture
 * craft source, plus the GateApp router mounts at `#/s/{s}/craft[/{id}]`
 * (Craft → Crafts, change list items 10–13).
 *
 * What these cases pin:
 *  · the routes: bare `/craft` is the Crafts home, `/craft/{id}` the craft;
 *  · the header `‹ Crafts · Title`, and ‹ going home;
 *  · ONE empty state for a craft with no pages, and Pages ▾ → + New page making one;
 *  · a graph page renders the ROW and re-renders on its patch event (R1),
 *    mermaid and unknown graph types included;
 *  · the tab strip (doc §3): [pages ▾] left-most and no scope picker, the
 *    pinned overview first and never closable, a page opening (or focusing)
 *    its tab, closing a tab keeping the page, Alt+→ reordering the person's
 *    tabs, "Remove from craft" dropping the tab and keeping the entity, the
 *    "updated" dot, "Add existing…", and a `craft.workspace` push redrawing
 *    the strip; the route mirrors the selected tab;
 *  · a page that is a craft opens inline as a tab with that craft's overview;
 *  · the chat pane: hosted SOLO, a thread picker over the craft's chats, and
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
import { CraftScreen, type CraftTarget } from './CraftScreen';
import { fixtureCraftSource, positionAt } from './craft-source';
import { memoryCraftWorkspacesPort } from '../data/craft-workspace';
import type { CraftWorkspacesPort } from '../data/seam';

const SPACE = FIXTURE_SPACE_ID;
const CRAFT = 'craft-1' as EntityId;

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
type Source = ReturnType<typeof fixtureCraftSource>;

/** The host's URL, held in state, so the screen's navigation is observable. */
function Harness({ seam, source, initial, onTarget }: { seam: Seam; source: Source; initial: CraftTarget; onTarget?: (t: CraftTarget) => void }) {
  const [target, setTarget] = useState(initial);
  if (!target.craftId) return <div data-testid="went-home" />;
  return (
    <CraftScreen
      seam={seam}
      spaceId={SPACE}
      nodeKey="fixture"
      source={source}
      craftId={target.craftId}
      pageId={target.pageId}
      onNavigate={(next) => {
        onTarget?.(next);
        setTarget(next);
      }}
    />
  );
}

async function mountCraft(
  setup?: (seam: Seam, source: Source) => Promise<void>,
  initial: CraftTarget | (() => CraftTarget) = { craftId: CRAFT },
  port?: CraftWorkspacesPort,
) {
  const seam = createFixtureSeam();
  if (port) (seam as { craftWorkspaces?: CraftWorkspacesPort }).craftWorkspaces = port;
  await seam.openSpace(SPACE);
  const source = fixtureCraftSource(seam, SPACE, [{ id: CRAFT, title: 'Launch plan' }]);
  await setup?.(seam, source);
  const targets: CraftTarget[] = [];
  const first = typeof initial === 'function' ? initial() : initial;
  const view = render(<Harness seam={seam} source={source} initial={first} onTarget={(t) => targets.push(t)} />);
  await waitFor(() => view.getByTestId('craft-screen'));
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
  within(view.getByTestId('craft-tab-strip')).getAllByRole('tab').map((tab) => tab.textContent);
const tabAt = (view: ReturnType<typeof render>, index: number) =>
  within(view.getByTestId('craft-tab-strip')).getAllByRole('tab')[index]!;
const pageTitles = (view: ReturnType<typeof render>) =>
  view.getAllByTestId('craft-pages-item').map((item) => item.textContent);

/** Pages ▾ → the page called `title`. */
function openFromPages(view: ReturnType<typeof render>, title: string) {
  fireEvent.click(view.getByTestId('craft-pages-btn'));
  const item = view.getAllByTestId('craft-pages-item').find((row) => row.textContent === title);
  if (!item) throw new Error(`no page ${title}`);
  fireEvent.click(item);
}

describe('the craft routes', () => {
  it('mounts the Crafts home at bare #/s/{s}/craft', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/craft`)} />);
    await waitFor(() => view.getByTestId('crafts-home'));
    expect(view.queryByTestId('craft-screen')).toBeNull();
    view.unmount();
  });

  it('mounts the craft screen at #/s/{s}/craft/{id}', async () => {
    const view = render(
      <GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/craft/019f98a0-aaaa-bbbb-cccc-000000000041`)} />,
    );
    await waitFor(() => view.getByTestId('craft-screen'));
    expect(view.queryByTestId('crafts-home')).toBeNull();
    view.unmount();
  });

  it('puts the craft\'s chats and sessions in the frame\'s 2nd panel, and no chat on the right', async () => {
    const view = render(
      <GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/craft/019f98a0-aaaa-bbbb-cccc-000000000041`)} />,
    );
    await waitFor(() => view.getByTestId('craft-screen'));
    /* Re-queried: the frame's panel host remounts as the app settles. */
    const side = await waitFor(() => within(view.getByTestId('app-frame-panel')).getByTestId('crf-side'));
    expect(within(side).getByTestId('crf-new-chat')).toBeTruthy();
    expect(within(side).getByTestId('crf-new-session')).toBeTruthy();
    /* The crafts list left the panel (reverses 6a022279e). */
    expect(view.queryByRole('navigation', { name: 'Crafts' })).toBeNull();
    expect(view.getByTestId('craft-screen').querySelector('.crf-chat')).toBeNull();
    view.unmount();
  });
});

describe('the craft screen', () => {
  it('heads the screen ‹ Crafts · Title, and ‹ goes home', async () => {
    const { view } = await mountCraft();
    await waitFor(() => expect(view.getByTestId('dsn-title').textContent).toBe('Launch plan'));
    const head = view.getByTestId('dsn-head');
    expect(head.textContent).toContain('Crafts');
    fireEvent.click(view.getByTestId('dsn-back'));
    await waitFor(() => view.getByTestId('went-home'));
  });

  it('draws no Orchestrate, no graph picker and no header chat picker (D4)', async () => {
    const { view } = await mountCraft();
    await waitFor(() => view.getByTestId('dsn-no-pages'));
    for (const gone of ['crf-orchestrate', 'crf-picker', 'crf-chat-picker', 'crf-no-graph']) {
      expect(view.queryByTestId(gone)).toBeNull();
    }
  });

  it('says a craft has no pages ONCE, and Pages ▾ → + New page → Graph makes one and opens its tab', async () => {
    const { view, source, targets } = await mountCraft();
    await waitFor(() => view.getByTestId('dsn-no-pages'));
    expect(tabTitles(view)).toEqual(['Overview']);
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    const menu = view.getByTestId('craft-pages-menu');
    /* The five kinds and the existing-entity door. */
    for (const kind of ['graph', 'doc', 'artifact', 'drawing', 'craft']) {
      expect(within(menu).getByTestId(`craft-new-${kind}`)).toBeTruthy();
    }
    expect(within(menu).getByTestId('craft-new-design').textContent).toContain('Craft');
    expect(within(menu).getByTestId('membership-add').textContent).toBe('Add existing…');
    fireEvent.click(within(menu).getByTestId('craft-new-graph'));
    await waitFor(() => view.getByTestId('crf-empty'));
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Untitled graph']));
    expect(tabAt(view, 1).getAttribute('aria-selected')).toBe('true');
    const pageId = source.crafts.get(CRAFT)!.pages[0]!.id;
    await waitFor(() => expect(targets.at(-1)).toEqual({ craftId: CRAFT, pageId }));
  });

  it('Artifact asks the agent in the chat, which is the one door an artifact has', async () => {
    const { view } = await mountCraft();
    await waitFor(() => view.getByTestId('dsn-no-pages'));
    await waitFor(() => view.getByLabelText('Message the chat agent'));
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    fireEvent.click(view.getByTestId('craft-new-artifact'));
    const area = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toContain('artifact page'));
  });
});

describe('a graph page', () => {
  it('renders the ROW on the canvas and re-renders on its patch event (R1)', async () => {
    let graphId = '' as EntityId;
    const { seam, view } = await mountCraft(async (s, source) => {
      graphId = await createGraph(s, 'Launch flow');
      await source.placePage(CRAFT, graphId, 1);
    });
    await waitFor(() => view.getByTestId('dsn-overview'));
    openFromPages(view, 'Launch flow');
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
    const { view } = await mountCraft(async (seam, source) => {
      await source.placePage(CRAFT, await createGraph(seam, 'Auth sketch', { graphType: 'mermaid', source: 'flowchart TD; login-->token' }), 1);
    });
    await waitFor(() => view.getByTestId('dsn-overview'));
    openFromPages(view, 'Auth sketch');
    await waitFor(() => view.getByTestId('crf-mermaid'));
    expect(view.queryByTestId('crf-canvas')).toBeNull();
  });

  it('says so honestly for a graphType this build cannot draw (R3 forward-compat)', async () => {
    const { view } = await mountCraft(async (seam, source) => {
      await source.placePage(CRAFT, await createGraph(seam, 'State machine', { graphType: 'statechart' }), 1);
    });
    await waitFor(() => view.getByTestId('dsn-overview'));
    openFromPages(view, 'State machine');
    await waitFor(() => view.getByTestId('crf-unknown-type'));
    expect(view.getByTestId('crf-unknown-type').textContent).toContain('statechart');
  });
});

describe('the tab strip', () => {
  async function threePages(port?: CraftWorkspacesPort) {
    const ids: EntityId[] = [];
    const mounted = await mountCraft(
      async (seam, source) => {
        ids.push(await createGraph(seam, 'Plan'), await createDoc(seam, 'Brief'), await createGraph(seam, 'Rollout'));
        for (const [index, id] of ids.entries()) await source.placePage(CRAFT, id, index + 1);
      },
      { craftId: CRAFT },
      port,
    );
    await waitFor(() => mounted.view.getByTestId('dsn-overview'));
    return { ...mounted, ids };
  }
  async function openAll(view: ReturnType<typeof render>) {
    for (const title of ['Plan', 'Brief', 'Rollout']) {
      openFromPages(view, title);
      await waitFor(() => expect(tabTitles(view)).toContain(title));
    }
  }

  it('puts [pages ▾] left-most, draws no scope picker, and opens on the pinned overview', async () => {
    const { view } = await threePages();
    const strip = view.getByTestId('craft-tab-strip');
    expect(strip.firstElementChild?.contains(view.getByTestId('craft-pages-btn'))).toBe(true);
    expect(view.queryByTestId('tws-scope')).toBeNull();
    expect(tabTitles(view)).toEqual(['Overview']);
    const overview = view.getAllByTestId('craft-tab')[0]!;
    expect(overview.hasAttribute('data-pinned')).toBe(true);
    expect(within(overview).queryByTestId('craft-tab-close')).toBeNull();
    expect(view.getByTestId('dsn-overview').textContent).toContain('3 pages');
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    expect(pageTitles(view)).toEqual(['Plan', 'Brief', 'Rollout']);
  });

  it('a page from Pages ▾ opens its tab, and picking it again focuses the one tab', async () => {
    const { view, ids, targets } = await threePages();
    openFromPages(view, 'Rollout');
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Rollout']));
    expect(tabAt(view, 1).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(targets.at(-1)).toEqual({ craftId: CRAFT, pageId: ids[2] }));
    fireEvent.click(tabAt(view, 0));
    await waitFor(() => expect(targets.at(-1)).toEqual({ craftId: CRAFT }));
    openFromPages(view, 'Rollout');
    await waitFor(() => expect(tabAt(view, 1).getAttribute('aria-selected')).toBe('true'));
    expect(tabTitles(view)).toEqual(['Overview', 'Rollout']);
  });

  it('a URL page opens (or focuses) its tab; a URL page that is not a page falls back to the overview', async () => {
    const ids: EntityId[] = [];
    const { view, targets } = await mountCraft(
      async (seam, source) => {
        ids.push(await createDoc(seam, 'Brief'));
        await source.placePage(CRAFT, ids[0]!, 1);
      },
      () => ({ craftId: CRAFT, pageId: ids[0] }),
    );
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Brief']));
    expect(tabAt(view, 1).getAttribute('aria-selected')).toBe('true');
    cleanup();

    const stray = await mountCraft(undefined, { craftId: CRAFT, pageId: 'not-a-page' as EntityId });
    await waitFor(() => expect(stray.targets.at(-1)).toEqual({ craftId: CRAFT }));
    expect(tabTitles(stray.view)).toEqual(['Overview']);
    expect(targets).toEqual([]);
  });

  it('a page outside a Workspace host says what it is and offers Open', async () => {
    const { view } = await threePages();
    openFromPages(view, 'Brief');
    const plain = await waitFor(() => view.getByTestId('dsn-plain-page'));
    expect(plain.textContent).toContain('Brief');
  });

  it('closing a tab never removes the page', async () => {
    const { view, source, targets } = await threePages();
    await openAll(view);
    const brief = view.getAllByTestId('craft-tab').find((tab) => tab.textContent?.includes('Brief'))!;
    fireEvent.click(within(brief).getByTestId('craft-tab-close'));
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Plan', 'Rollout']));
    expect(source.crafts.get(CRAFT)!.pages.map((page) => page.id)).toHaveLength(3);
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    expect(pageTitles(view)).toEqual(['Plan', 'Brief', 'Rollout']);
    /* The active tab closed: its right-hand neighbour is selected, and the route follows. */
    await waitFor(() => expect(targets.at(-1)?.pageId).toBeTruthy());
  });

  it('Alt+→ moves a tab one place, and never past the overview', async () => {
    const { view, source } = await threePages();
    await openAll(view);
    const before = source.crafts.get(CRAFT)!.pages.map((page) => page.position);
    fireEvent.keyDown(tabAt(view, 1), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Brief', 'Plan', 'Rollout']));
    fireEvent.keyDown(tabAt(view, 1), { key: 'ArrowLeft', altKey: true });
    expect(tabTitles(view)).toEqual(['Overview', 'Brief', 'Plan', 'Rollout']);
    /* Tabs are the person's; the craft's page order is untouched. */
    expect(source.crafts.get(CRAFT)!.pages.map((page) => page.position)).toEqual(before);
  });

  it('"Remove from craft" takes the page out, drops its tab and keeps the entity', async () => {
    const { seam, view, ids } = await threePages();
    await openAll(view);
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    fireEvent.click(view.getAllByTestId('craft-remove-page')[1]!);
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Plan', 'Rollout']));
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    expect(pageTitles(view)).toEqual(['Plan', 'Rollout']);
    /* Never a delete: the doc still reads. */
    await expect(seam.entity(ids[1]!)).resolves.toMatchObject({ title: 'Brief' });
  });

  it('marks a tab changed while not active, and the mark clears when it is selected', async () => {
    const { seam, view, ids } = await threePages();
    await openAll(view);
    fireEvent.click(tabAt(view, 0));
    await waitFor(() => expect(tabAt(view, 0).getAttribute('aria-selected')).toBe('true'));
    expect(view.queryByTestId('craft-tab-updated')).toBeNull();
    await seam.commands.patchEntity(ids[2]!, {
      clientMutationId: 'crf-upd',
      expectedVersion: 1,
      content: { graphType: 'entity', nodes: [{ key: 'x', spec: { kind: 'task', title: 'Flip flag' } }], edges: [] },
    });
    const dot = await waitFor(() => view.getByTestId('craft-tab-updated'));
    expect(dot.closest('[data-entity]')?.getAttribute('data-entity')).toBe(ids[2]);
    /* The tab the viewer is on did not move: agents never switch tabs by editing a page. */
    expect(tabAt(view, 0).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tabAt(view, 3));
    await waitFor(() => expect(view.queryByTestId('craft-tab-updated')).toBeNull());
  });

  it('"Add existing…" puts a recent entity in as a page and opens its tab', async () => {
    const { view, seam } = await threePages();
    await createDoc(seam, 'Pricing notes');
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    fireEvent.click(view.getByTestId('membership-add'));
    const option = await waitFor(() =>
      view.getAllByTestId('membership-option').find((button) => button.textContent?.includes('Pricing notes'))!,
    );
    fireEvent.click(option);
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Pricing notes']));
    fireEvent.click(view.getByTestId('craft-pages-btn'));
    expect(pageTitles(view)).toEqual(['Plan', 'Brief', 'Rollout', 'Pricing notes']);
  });

  it('redraws from a craft.workspace push — another window, or the craft agent', async () => {
    const port = memoryCraftWorkspacesPort();
    const { view, ids, targets } = await threePages(port);
    /* Another window opens Brief: the push lands here, the route follows. */
    await port.command(SPACE, CRAFT, { requestId: 'r1', command: 'tabs.open', args: { kind: 'doc', entityId: ids[1]! } });
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Brief']));
    expect(tabAt(view, 1).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(targets.at(-1)).toEqual({ craftId: CRAFT, pageId: ids[1] }));
    /* …and closes it: the strip and the route follow again. */
    await port.command(SPACE, CRAFT, { requestId: 'r2', command: 'tabs.close', args: { entityId: ids[1]! } });
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview']));
    await waitFor(() => expect(targets.at(-1)).toEqual({ craftId: CRAFT }));
  });

  it('the node refuses a tab for an entity that is not a page', async () => {
    const port = memoryCraftWorkspacesPort();
    const refusing: CraftWorkspacesPort = {
      ...port,
      command: async (spaceId, craftId, input) => ({
        requestId: input.requestId,
        status: 'rejected',
        reason: 'not_a_page',
        workspace: await port.get(spaceId, craftId),
      }),
    };
    const { view } = await threePages(refusing);
    openFromPages(view, 'Plan');
    /* Shown at once, then put back by the node's answer. */
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview']));
    expect(tabAt(view, 0).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the craft detail panel (the overview, L4.2)', () => {
  const sections = (view: ReturnType<typeof render>) => within(view.getByTestId('craft-detail-panel')).getAllByTestId('craft-detail-page');

  it('is what a craft shows with no page selected: every page, live, stacked in contains order', async () => {
    let nested = '' as EntityId;
    const { view, ids } = await (async () => {
      const ids: EntityId[] = [];
      const mounted = await mountCraft(async (seam, source) => {
        ids.push(await createGraph(seam, 'Plan'), await createDoc(seam, 'Brief'));
        await source.placePage(CRAFT, ids[0]!, 1);
        await source.placePage(CRAFT, ids[1]!, 2);
        nested = await source.createPage(CRAFT, 'craft', 3);
        source.crafts.get(nested)!.title = 'Backend';
        await source.placePage(nested, await createGraph(seam, 'API flow'), 1);
      });
      return { ...mounted, ids };
    })();
    await waitFor(() => expect(sections(view)).toHaveLength(3));
    expect(sections(view).map((section) => section.getAttribute('data-page-id'))).toEqual([ids[0], ids[1], nested]);
    expect(sections(view).map((section) => section.getAttribute('data-kind'))).toEqual(['graph', 'doc', 'craft']);
    /* The graph is the live blueprint page (empty yet), inside its own section. */
    const [graph, doc, craft] = sections(view);
    await waitFor(() => within(graph!).getByTestId('crf-empty'));
    /* Outside a Workspace host a doc says what it is (the live body needs the host). */
    expect(within(doc!).getByTestId('craft-detail-plain')).toBeTruthy();
    /* A craft page is a compact section of its pages — no nested page row. */
    await waitFor(() =>
      expect(within(craft!).getAllByTestId('craft-detail-chip').map((chip) => chip.textContent)).toEqual(['API flow']),
    );
    expect(view.queryByTestId('dsn-nested-pages')).toBeNull();
  });

  it('stays live: a graph patch redraws its section, and a new page appears in place', async () => {
    let graphId = '' as EntityId;
    const { seam, source, view } = await mountCraft(async (s, src) => {
      graphId = await createGraph(s, 'Plan');
      await src.placePage(CRAFT, graphId, 1);
    });
    await waitFor(() => expect(sections(view)).toHaveLength(1));
    await seam.commands.patchEntity(graphId, {
      clientMutationId: 'cdp-live',
      expectedVersion: 1,
      content: { graphType: 'entity', nodes: [{ key: 'a', spec: { kind: 'task', title: 'Ship API' } }], edges: [] },
    });
    await waitFor(() => expect(within(sections(view)[0]!).getByTestId('crf-canvas').textContent).toContain('Ship API'));
    await source.placePage(CRAFT, await createDoc(seam, 'Brief'), 2);
    await waitFor(() => expect(sections(view)).toHaveLength(2));
  });

  it('Open (or the title) opens that page on its own', async () => {
    let docId = '' as EntityId;
    const { view, targets } = await mountCraft(async (s, src) => {
      docId = await createDoc(s, 'Brief');
      await src.placePage(CRAFT, docId, 1);
    });
    await waitFor(() => expect(sections(view)).toHaveLength(1));
    fireEvent.click(within(sections(view)[0]!).getByTestId('craft-detail-open'));
    await waitFor(() => expect(targets.at(-1)).toEqual({ craftId: CRAFT, pageId: docId }));
    await waitFor(() => view.getByTestId('dsn-plain-page'));
    expect(view.queryByTestId('craft-detail-panel')).toBeNull();
  });
});

describe('a craft page', () => {
  it('opens inline as that craft, with no nested page row', async () => {
    const { view, targets } = await mountCraft(async (seam, source) => {
      await source.placePage(CRAFT, await createGraph(seam, 'Plan'), 1);
      const nested = await source.createPage(CRAFT, 'craft', 2);
      source.crafts.get(nested)!.title = 'Backend';
      await source.placePage(nested, await createGraph(seam, 'API flow'), 1);
    });
    await waitFor(() => view.getByTestId('dsn-overview'));
    openFromPages(view, 'Backend');
    await waitFor(() => expect(tabTitles(view)).toEqual(['Overview', 'Backend']));
    const nested = await waitFor(() => view.getByTestId('dsn-nested'));
    /* Its pages are its own: shown in its overview, never as tabs here. */
    await waitFor(() => expect(within(nested).getByTestId('dsn-overview').textContent).toContain('1 page'));
    expect(tabTitles(view)).toEqual(['Overview', 'Backend']);
    expect(view.getAllByRole('tablist')).toHaveLength(1);
    expect(targets.at(-1)).toEqual({ craftId: CRAFT, pageId: nested.getAttribute('data-craft') });
  });
});

describe('the chat pane', () => {
  it('hosts the conversation SOLO — no thread sidebar inside the chat pane', async () => {
    const { view } = await mountCraft();
    await waitFor(() => view.container.querySelector('.tch-root'));
    expect(view.container.querySelector('.tch-root--solo')).toBeTruthy();
    expect(view.container.querySelector('.tch-sidebar')).toBeNull();
    expect(view.queryByRole('tablist', { name: 'Home roots' })).toBeNull();
    /* The divider between chat and pages is a real separator. */
    expect(view.getByTestId('panel-resizer-left')).toBeTruthy();
  });

  it('lists only the chats and sessions on this craft, and says so when there are none', async () => {
    const { view } = await mountCraft();
    fireEvent.click(await waitFor(() => view.getByTestId('crf-side-picker')));
    /* The fixture's threads are about other things and not craft-mode. */
    await waitFor(() => expect(view.getByTestId('crf-side-empty').textContent).toContain('No chats or sessions'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('crf-side-pop')).toBeNull());
  });

  it('draws the 2nd panel header: title, chats icon, the list, ＋ New chat, ＋ New session', async () => {
    const { view } = await mountCraft();
    const head = await waitFor(() => view.getByTestId('crf-side-head'));
    await waitFor(() => expect(within(head).getByTestId('crf-side-title').textContent).toBe('Launch plan'));
    expect(within(head).getByTestId('crf-side-chats-icon')).toBeTruthy();
    expect(within(head).getByTestId('crf-side-picker')).toBeTruthy();
    expect(within(head).getByTestId('crf-new-chat').textContent).toContain('New chat');
    /* No Workspace host here, so no spawn: the button says why. */
    const newSession = within(head).getByTestId('crf-new-session') as HTMLButtonElement;
    expect(newSession.disabled).toBe(true);
    expect(newSession.title).toBe('Sessions launch from the app.');
  });

  it('returns to the composer when ＋ New chat is pressed after a send created a thread', async () => {
    const { view } = await mountCraft();
    const picker = await waitFor(() => view.getByTestId('crf-side-picker'));
    await waitFor(() => expect(picker.textContent).toContain('New chat'));
    fireEvent.change(await waitFor(() => view.getByLabelText('Message the chat agent')), {
      target: { value: 'Draft the plan.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByTestId('crf-side-picker').textContent).not.toContain('New chat'));
    fireEvent.click(view.getByTestId('crf-new-chat'));
    await waitFor(() => expect(view.getByTestId('crf-side-picker').textContent).toContain('New chat'));
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

/* THE REAL GATE: a Workspace host, so the right strip is the selected tab's
   own entity strip (spec §3) — QA defects 01a125c7 (overview Delete) and
   01a125cb (graph page strip). */
describe('the right strip in a Workspace host', () => {
  const FIXTURE_CRAFT = 'design-checkout' as EntityId;

  async function mountGate(path: string, setup?: (seam: Seam) => Promise<void>) {
    const seam = createFixtureSeam();
    await seam.openSpace(SPACE);
    await setup?.(seam);
    const view = render(<GateApp seam={seam} routerTarget={createMemoryTarget(`#/s/${SPACE}/craft/${path}`)} />);
    await waitFor(() => view.getByTestId('craft-screen'));
    return { seam, view };
  }

  it('the overview strip offers Delete, and deleting the craft goes to the Crafts home', async () => {
    const { view } = await mountGate(FIXTURE_CRAFT);
    await waitFor(() => expect(view.getAllByTestId('tws-action-strip')).toHaveLength(1));
    fireEvent.click(view.getByTestId('tws-more'));
    const danger = await waitFor(() => {
      const button = view.getByTestId('tws-more-menu').querySelector<HTMLButtonElement>('.tws-astrip-danger button');
      expect(button).not.toBeNull();
      return button!;
    });
    fireEvent.click(danger);
    await waitFor(() => view.getByTestId('crafts-home'));
    expect(view.queryByTestId('craft-screen')).toBeNull();
  });

  it('a graph page carries its own strip: Links, Messages and Run, with the canvas as the body', async () => {
    let graphId = '' as EntityId;
    const { view } = await mountGate(`${FIXTURE_CRAFT}`, async (seam) => {
      graphId = await createGraph(seam, 'Flow', {
        graphType: 'entity',
        nodes: [{ key: 'a', spec: { kind: 'task', title: 'Ship it' } }],
        edges: [],
      });
      /* The fixture seam keeps no `contains` edges for a craft: hand its read
         the graph as its one page. */
      const graph = await seam.entity(graphId);
      const read = seam.entity.bind(seam);
      seam.entity = (async (id: EntityId) => {
        const detail = await read(id);
        if (id !== FIXTURE_CRAFT) return detail;
        return { ...detail, content: { ...(detail.content as object), pages: [{ ...graph, pagePosition: 1 }] } };
      }) as typeof seam.entity;
    });
    await waitFor(() => expect(view.getByTestId('craft-pages-btn').textContent).toContain('1'));
    openFromPages(view, 'Flow');
    await waitFor(() => view.getByTestId('dsn-graph-chrome'));
    const strip = view.getByTestId('tws-action-strip');
    expect(view.getAllByTestId('tws-action-strip')).toHaveLength(1);
    await waitFor(() => within(strip).getByTestId('tws-section-connections'));
    within(strip).getByTestId('tws-section-messages');
    await waitFor(() => expect(within(strip).getByTestId('tws-astrip-common').querySelector('button')).not.toBeNull());
    /* The canvas is the visible body; the panel only lends the strip its verbs. */
    expect(view.getByTestId('dsn-graph-chrome').hidden).toBe(true);
    fireEvent.click(within(strip).getByTestId('tws-section-connections'));
    await waitFor(() => expect(within(strip).getByTestId('tws-section-connections').getAttribute('aria-pressed')).toBe('true'));
    expect(view.getByTestId('dsn-graph-chrome').previousElementSibling).not.toBeNull();
  });
});
