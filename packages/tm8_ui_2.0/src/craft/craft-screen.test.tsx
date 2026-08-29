// @vitest-environment jsdom
/**
 * THE CRAFT STUDIO, MOUNTED — CraftScreen over the fixture seam, plus the
 * GateApp router mount at `#/s/{s}/craft` (the board-screen harness, reused).
 *
 * What these cases pin:
 *  · the route mounts the studio (tab wiring end to end);
 *  · the empty space says so, and “+ New graph” creates + selects a real row
 *    (entities.create through the seam — zero new catalog ops);
 *  · the canvas renders the ROW: a patched content lands as cards/lines after
 *    the durable entity.upsert event, with NO other read path (R1);
 *  · spec cards are marked, dangling edges are counted, an unknown graphType
 *    says so honestly.
 *
 * jsdom loads no stylesheets (the recurring law), so nothing here claims
 * colour or geometry — presence, structure and text only; pixels are the
 * e2e path's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { createFixtureSeam } from '../data';
import { CraftScreen } from './CraftScreen';

const SPACE = FIXTURE_SPACE_ID;

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

async function mountStudio() {
  const seam = createFixtureSeam();
  await seam.openSpace(SPACE);
  const view = render(
    <CraftScreen seam={seam} spaceId={SPACE} nodeKey="fixture" />,
  );
  await waitFor(() => view.getByTestId('craft-screen'));
  return { seam, view };
}

describe('the craft route', () => {
  it('mounts the studio at #/s/{s}/craft', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/craft`)} />);
    await waitFor(() => view.getByTestId('craft-screen'));
    view.unmount();
  });
});

describe('the craft studio', () => {
  it('says the space has no graphs, then creates and selects one', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-no-graph'));

    fireEvent.click(view.getByTestId('crf-new'));
    /* The create is a real seam write: the picker gains the row and the
       canvas flips from “no graph” to the empty-blueprint invitation. */
    await waitFor(() => view.getByTestId('crf-empty'));
    const picker = view.getByTestId('crf-picker') as HTMLSelectElement;
    expect(picker.options[picker.selectedIndex]?.text).toBe('Untitled graph');
    view.unmount();
  });

  it('renders the ROW on the canvas and re-renders on its patch event (R1)', async () => {
    const { seam, view } = await mountStudio();
    const created = await seam.commands.createEntity({
      clientMutationId: 'crf-test-1',
      spaceId: SPACE,
      kind: 'graph',
      title: 'Launch flow',
      content: { graphType: 'entity' },
    });
    const id = created.entity!.id as EntityId;
    await waitFor(() => view.getByTestId('crf-empty'));

    /* The agent's move: ONE guarded patch to the row. The canvas must pick it
       up from the durable event — there is no other channel. */
    await seam.commands.patchEntity(id, {
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
    expect(canvas.textContent).toContain('Ship UI');
    /* Specs are flagged as intent; the relation label is humanised. */
    expect(canvas.textContent).toContain('REST');
    expect(canvas.textContent?.toLowerCase()).toContain('depends');
    /* The edge naming a key no node carries is COUNTED, never silently gone. */
    await waitFor(() => view.getByTestId('crf-dangling'));
    expect(view.getByTestId('crf-dangling').textContent).toContain('1 edge');

    /* LIVE CONSTRUCTION READS AS MOTION: the NEXT patch's additions carry the
       fresh marker (class only — jsdom sees no styles; the glow itself is the
       pixel path's claim), and the settled cards do not. */
    await seam.commands.patchEntity(id, {
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
    /* CONVERGE INSIDE waitFor: the fresh-glow is set by an effect AFTER the
       commit that draws 'Ship docs', so the first frame containing the new
       card can still glow the PREVIOUS patch's additions. React 19 keeps
       those two commits distinct where 18 often flushed them together —
       reading the classes at first sight of the text was reading one commit
       too early. The glow then holds for 2600ms, so the converged state is
       comfortably observable. */
    await waitFor(() => {
      const freshCells = view.getByTestId('crf-canvas').querySelectorAll('.crf-cell--fresh');
      expect(freshCells).toHaveLength(1);
      expect(freshCells[0]!.textContent).toContain('Ship docs');
    });
    view.unmount();
  });

  it('renders a mermaid row through the Mermaid path, not the card canvas', async () => {
    const { seam, view } = await mountStudio();
    await seam.commands.createEntity({
      clientMutationId: 'crf-test-3',
      spaceId: SPACE,
      kind: 'graph',
      title: 'Auth sketch',
      content: { graphType: 'mermaid', source: 'flowchart TD; login-->token' },
    });
    await waitFor(() => view.getByTestId('crf-mermaid'));
    expect(view.queryByTestId('crf-canvas')).toBeNull();
    view.unmount();
  });

  it('says so honestly for a graphType this build cannot draw (R3 forward-compat)', async () => {
    const { seam, view } = await mountStudio();
    await seam.commands.createEntity({
      clientMutationId: 'crf-test-4',
      spaceId: SPACE,
      kind: 'graph',
      title: 'State machine',
      content: { graphType: 'statechart' },
    });
    await waitFor(() => view.getByTestId('crf-unknown-type'));
    expect(view.getByTestId('crf-unknown-type').textContent).toContain('statechart');
    view.unmount();
  });
});

/**
 * TWO PANES (task 01a00b4e). The studio used to READ as three columns, and
 * only one of them was Craft's: the chat surface brought its own thread
 * sidebar, so `CraftScreen`'s two panes plus that column made three.
 *
 * jsdom sees no widths, so nothing here claims geometry — the columns, their
 * order and the resizer's arithmetic are the pixel harness's to prove
 * (`e2e/craft-harness.html`). What IS testable here is the structure: which
 * regions exist, and that the chat surface's own selector is gone rather than
 * merely hidden.
 */
describe('the two-pane studio', () => {
  it('hosts the conversation SOLO — no thread sidebar inside the chat pane', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.container.querySelector('.tch-root'));
    /* The chat surface renders its conversation and nothing else. */
    expect(view.container.querySelector('.tch-root--solo')).toBeTruthy();
    expect(view.container.querySelector('.tch-sidebar')).toBeNull();
    /* Not merely display:none — a hidden tablist and a second searchbox would
       still be in the a11y tree, offering a selector the screen won't honour. */
    expect(view.queryByRole('complementary', { name: 'Tasks, chats and sessions' })).toBeNull();
    expect(view.queryByRole('tablist', { name: 'Home roots' })).toBeNull();
    view.unmount();
  });

  it('puts the conversation picker and ＋ on the chat pane, and the graph picker on the canvas', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-chat-picker'));
    /* Both panes carry a header, each naming the pane beneath it. */
    expect(view.getByTestId('crf-chat-picker')).toBeTruthy();
    expect(view.getByTestId('crf-new-chat')).toBeTruthy();
    expect(view.getByTestId('crf-picker')).toBeTruthy();
    expect(view.getByTestId('crf-new')).toBeTruthy();
    /* And the divider between them is a real separator, not a border. */
    expect(view.getByTestId('panel-resizer-left')).toBeTruthy();
    view.unmount();
  });

  /**
   * THE ESCAPE QUEUE IS ONLY ORDERED IF EVERY RUNG REPORTS.
   *
   * `CraftScreen`'s region-C rung skips on `defaultPrevented` so the popover
   * can come first. That guard is worth nothing unless the popover actually
   * marks the event, and it did not: one press closed the popover AND the
   * entity column. This asserts the CONTRACT rather than the collision,
   * because the collision needs a `panelHost` this mount has no `GateData`
   * to build — and a test that can only run in prod is how the bug survived.
   */
  it('marks Escape as handled, so a host rung registered EARLIER does not also fire', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-chat-picker'));

    /* Stands in for `CraftScreen`'s region-C rung — a bubble listener on
       `document`, guarded on `defaultPrevented`, ATTACHED BEFORE the popover
       exists. That order is the whole point: region C's listener goes on the
       moment the column opens, so a popover that merely marks the event still
       loses the bubble queue to it. Registering this first is what makes the
       case honest; registering it last passes against a broken picker. */
    let hostWouldClose = false;
    const hostRung = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) hostWouldClose = true;
    };
    document.addEventListener('keydown', hostRung);
    try {
      fireEvent.click(view.getByTestId('crf-chat-picker'));
      await waitFor(() => view.getByTestId('crf-chat-pop'));

      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(view.queryByTestId('crf-chat-pop')).toBeNull());
      expect(hostWouldClose).toBe(false);
    } finally {
      document.removeEventListener('keydown', hostRung);
    }
    view.unmount();
  });

  it('opens the conversation popover with its search, and closes it on Escape', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-chat-picker'));
    expect(view.queryByTestId('crf-chat-pop')).toBeNull();

    fireEvent.click(view.getByTestId('crf-chat-picker'));
    await waitFor(() => view.getByTestId('crf-chat-pop'));
    /* The find box came WITH the list — it is what makes a space-wide
       population usable from a header control. */
    expect(view.getByRole('searchbox')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('crf-chat-pop')).toBeNull());
    view.unmount();
  });

  it('scopes the picker to THIS blueprint, and says what it is hiding', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-chat-picker'));
    fireEvent.click(view.getByTestId('crf-chat-picker'));
    await waitFor(() => view.getByTestId('crf-chat-pop'));

    /* The fixture's threads are anchored elsewhere and are not craft-mode, so
       the scoped list is legitimately empty — and the escape hatch is the
       difference between an empty state and a dead end. */
    expect(view.getByTestId('crf-chat-empty')).toBeTruthy();
    const scope = view.getByTestId('crf-chat-scope');
    expect(scope.textContent).toContain('on this blueprint');

    fireEvent.click(scope);
    await waitFor(() => expect(view.getByTestId('crf-chat-scope').textContent).toContain('Showing all'));
    view.unmount();
  });

  /**
   * ＋ KEEPS WORKING AFTER A SEND, which it did not.
   *
   * `routeThreadId` is compared BY VALUE, and the chat screen moves its own
   * selection when a send turns the composer into a real thread. Craft was
   * not told, so its request stayed on `null` while the screen sat in the new
   * conversation — and re-asking for `null` was a no-op React dropped before
   * the adoption effect could see it. ＋ was dead for the rest of the session.
   * The fix is that the request ADOPTS the resolved selection; this is the
   * case that says so.
   */
  it('returns to the composer when ＋ is pressed after a send created a thread', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-chat-picker'));
    /* A blueprint has to exist for the conversation to be resolved AGAINST —
       with none selected the resolve stands aside and the chat keeps its own
       cold-start, which is a different case from the one under test. */
    fireEvent.click(view.getByTestId('crf-new'));
    await waitFor(() => view.getByTestId('crf-empty'));
    /* Resolved to the composer: the fixture's threads are anchored elsewhere
       and are not craft-mode, so this blueprint has none of its own.

       READ OFF THE PICKER, not the conversation header. Solo mode no longer
       draws `.tch-conversation__head` — it restated the title the picker
       already shows one row above — so the picker's own empty label IS the
       "no thread selected" signal now, and it is the honest place to read it
       from: it is the surface that names the conversation. */
    await waitFor(() => expect(view.getByText('New craft conversation')).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Draft the blueprint.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    /* The send created a thread and the chat screen selected it ITSELF. */
    await waitFor(() => expect(view.queryByText('New craft conversation')).toBeNull());

    fireEvent.click(view.getByTestId('crf-new-chat'));
    await waitFor(() => expect(view.getByText('New craft conversation')).toBeTruthy());
    view.unmount();
  });

  /*
   * THE HEADER COLLAPSE. The studio used to stack three bands before the
   * first message — a screen bar saying "Craft", the pane picker, and the
   * chat's own header restating the picker's title — so the cases below pin
   * the two that went and the one that stayed, by ROLE rather than by pixel
   * (jsdom loads no stylesheets, the recurring law).
   */
  it('spends no row on a screen bar, and names the conversation exactly once', async () => {
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('crf-chat-picker'));

    /* The screen bar is gone entirely — not merely restyled. */
    expect(view.container.querySelector('.crf-bar')).toBeNull();

    /* And the chat pane names the open conversation ONCE. Before this, the
       picker and `.tch-conversation__head` both printed it, one row apart.
       Read the name OFF THE PICKER rather than hard-coding it, so the case
       pins "said once" — the actual claim — and not whichever conversation
       the fixture happened to resolve to. */
    expect(view.container.querySelector('.tch-conversation__head')).toBeNull();
    const named = view.container.querySelector('.crf-pick__title')?.textContent ?? '';
    expect(named).not.toBe('');
    expect(view.getAllByText(named)).toHaveLength(1);
    view.unmount();
  });

  it('puts Orchestrate on the blueprint row, beside the graph it acts on', async () => {
    const { view } = await mountStudio();
    const orchestrate = await waitFor(() => view.getByTestId('crf-orchestrate'));

    /* Not on a banner above both panes: it rides the CANVAS pane's header,
       which is the row naming the very blueprint `selectedId` refers to. */
    const head = orchestrate.closest('.crf-pane-head');
    expect(head).not.toBeNull();
    expect(head?.querySelector('[data-testid="crf-picker"]')).not.toBeNull();
    view.unmount();
  });

  it('draws NO entity column until a chip is pressed, and none at all without a shell to build one', async () => {
    /* Absent the shell bundle there is no region C to open into, and the
       screen says so by rendering nothing rather than an empty aside. */
    const { view } = await mountStudio();
    await waitFor(() => view.getByTestId('craft-screen'));
    expect(view.queryByTestId('crf-detail')).toBeNull();
    expect(view.queryByTestId('panel-resizer-right')).toBeNull();
    view.unmount();
  });
});
