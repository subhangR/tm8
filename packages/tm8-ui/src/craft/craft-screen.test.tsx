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
    await waitFor(() => expect(view.getByTestId('crf-canvas').textContent).toContain('Ship docs'));
    const freshCells = view.getByTestId('crf-canvas').querySelectorAll('.crf-cell--fresh');
    expect(freshCells).toHaveLength(1);
    expect(freshCells[0]!.textContent).toContain('Ship docs');
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
