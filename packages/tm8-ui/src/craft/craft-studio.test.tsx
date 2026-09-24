// @vitest-environment jsdom
/**
 * THE STUDIO'S INTERACTIONS — chat ↔ canvas as one tool.
 *
 *  · a node selected on the canvas opens the INSPECTOR (what it is, what
 *    flows in and out, its findings), and Escape closes it;
 *  · "Ask about this" seeds the composer with the node link in the one
 *    spelling the craft prompt teaches (`blueprintNodeRef`);
 *  · Outline and Table are real views over the same selection — and the
 *    accessible fallback for the SVG;
 *  · Orchestrate opens a PRE-FLIGHT: errors block the approval, a coherent
 *    plan posts it into the thread;
 *  · the canvas is keyboard-navigable.
 *
 * jsdom draws no pixels (the recurring law): structure, text and wiring only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { blueprintNodeRef, type EntityId } from '@tm8/contract';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { createFixtureSeam } from '../data';
import { CraftScreen } from './CraftScreen';
import { BlueprintCanvas } from './BlueprintCanvas';
import { blueprintView } from './blueprint-model';

const SPACE = FIXTURE_SPACE_ID;

const PLAN = {
  graphType: 'entity',
  nodes: [
    { id: 'tm-a', spec: { kind: 'team_member', title: 'Ada Writer' } },
    { id: 't-research', spec: { kind: 'task', title: 'Research pricing' } },
    { id: 'd-brief', spec: { kind: 'doc', title: 'Pricing brief' } },
    { id: 't-copy', spec: { kind: 'task', title: 'Write the copy' } },
  ],
  edges: [
    { src: 't-research', dst: 'tm-a', type: 'assigned_to' },
    { src: 't-copy', dst: 'tm-a', type: 'assigned_to' },
    { src: 't-research', dst: 'd-brief', type: 'produces' },
    { src: 't-copy', dst: 'd-brief', type: 'consumes' },
  ],
};

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
afterEach(cleanup);

async function mountWithPlan(content: unknown = PLAN, ready = 'crf-canvas') {
  const seam = createFixtureSeam();
  await seam.openSpace(SPACE);
  const created = await seam.commands.createEntity({
    clientMutationId: 'crf-studio-1',
    spaceId: SPACE,
    kind: 'graph',
    title: 'Pricing launch',
    content: { graphType: 'entity' },
  });
  const graphId = created.entity!.id as EntityId;
  await seam.commands.patchEntity(graphId, { clientMutationId: 'crf-studio-2', expectedVersion: 1, content });
  const view = render(<CraftScreen seam={seam} spaceId={SPACE} nodeKey="fixture" />);
  await waitFor(() => view.getByTestId(ready));
  /* The chat surface is a lazy chunk; the composer is part of "mounted". */
  await waitFor(() => view.getByLabelText('Message the chat agent'));
  return { seam, view, graphId };
}

const nodeEl = (view: ReturnType<typeof render>, key: string) =>
  view.getByTestId('crf-canvas').querySelector<SVGGElement>(`[data-key="${key}"]`)!;

describe('select → inspect → ask', () => {
  it('selecting a node opens its inspector with what flows in and out, and dims the rest', async () => {
    const { view } = await mountWithPlan();
    expect(view.queryByTestId('crf-inspector')).toBeNull();
    fireEvent.click(nodeEl(view, 't-copy'));

    const inspector = await waitFor(() => view.getByTestId('crf-inspector'));
    expect(within(inspector).getByRole('heading', { name: 'Write the copy' })).toBeTruthy();
    expect(inspector.textContent).toContain('Spec — not created yet');
    /* "t-copy consumes d-brief" arrives from the brief: it is an INPUT. */
    const incoming = within(inspector).getByRole('region', { name: 'Incoming' });
    expect(incoming.textContent).toContain('consumed by');
    expect(incoming.textContent).toContain('Pricing brief');
    /* The teammate is docked, and listed under the assignment's own words. */
    expect(within(inspector).getByRole('region', { name: 'assigned to' }).textContent).toContain('Ada Writer');

    /* The canvas emphasises the neighbourhood and dims the rest. */
    expect(nodeEl(view, 't-copy').getAttribute('data-emphasis')).toBe('selected');
    expect(nodeEl(view, 'd-brief').getAttribute('data-emphasis')).toBe('neighbour');
    expect(nodeEl(view, 't-research').getAttribute('data-emphasis')).toBe('dim');

    /* Walking from the inspector moves the selection. */
    fireEvent.click(within(incoming).getByRole('button', { name: 'Pricing brief' }));
    await waitFor(() => expect(within(view.getByTestId('crf-inspector')).getByRole('heading', { name: 'Pricing brief' })).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('crf-inspector')).toBeNull());
  });

  it('"Ask about this" seeds the composer with the node link the craft prompt reads', async () => {
    const { view, graphId } = await mountWithPlan();
    fireEvent.click(nodeEl(view, 'd-brief'));
    fireEvent.click(await waitFor(() => view.getByTestId('crf-ask')));
    const area = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(blueprintNodeRef(graphId, 'd-brief', 'Pricing brief')));
  });

  it('an example prompt from the empty state lands in the composer, unsent', async () => {
    const { view } = await mountWithPlan({ graphType: 'entity' }, 'crf-empty');
    const example = within(view.getByTestId('crf-empty')).getAllByTestId('crf-example')[0]!;
    fireEvent.click(example);
    const area = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe(example.textContent));
  });
});

describe('views over one selection', () => {
  it('Outline and Table list the same plan, and selecting there opens the inspector', async () => {
    const { view } = await mountWithPlan();
    fireEvent.click(view.getByTestId('crf-view-outline'));
    const outline = await waitFor(() => view.getByTestId('crf-outline'));
    /* Grouped by teammate; each task says what it needs and makes. */
    expect(within(outline).getByRole('button', { name: /Ada Writer/ })).toBeTruthy();
    expect(outline.textContent).toContain('Needs');
    expect(outline.textContent).toContain('Makes');
    fireEvent.click(within(outline).getAllByRole('button', { name: /Write the copy/ })[0]!);
    await waitFor(() => view.getByTestId('crf-inspector'));

    fireEvent.click(view.getByTestId('crf-view-table'));
    const table = await waitFor(() => view.getByTestId('crf-table'));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3);
    /* The selection survived the view switch. */
    expect(within(table).getByRole('button', { name: 'Write the copy' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Lanes is offered only when someone is assigned', async () => {
    const { view } = await mountWithPlan({ ...PLAN, edges: PLAN.edges.filter((edge) => edge.type !== 'assigned_to') });
    await waitFor(() => view.getByTestId('crf-views'));
    expect(view.queryByTestId('crf-view-lanes')).toBeNull();
    expect(view.getByTestId('crf-view-table')).toBeTruthy();
  });
});

describe('Orchestrate pre-flight', () => {
  async function withThread(content: unknown) {
    const mounted = await mountWithPlan(content);
    const { view } = mounted;
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Draft it.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect((view.getByTestId('crf-orchestrate') as HTMLButtonElement).disabled).toBe(false));
    return mounted;
  }

  it('lists the findings and BLOCKS the approval while there is an error', async () => {
    const { view } = await withThread({ ...PLAN, edges: [...PLAN.edges, { src: 't-copy', dst: 'ghost', type: 'depends_on' }] });
    fireEvent.click(view.getByTestId('crf-orchestrate'));
    const pre = await waitFor(() => view.getByTestId('crf-preflight'));
    expect(pre.textContent).toContain('Errors');
    expect((within(pre).getByTestId('crf-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a coherent plan posts the approval into the craft thread', async () => {
    const { view, seam } = await withThread(PLAN);
    const post = vi.spyOn(seam.commands, 'postMessage');
    fireEvent.click(view.getByTestId('crf-orchestrate'));
    const pre = await waitFor(() => view.getByTestId('crf-preflight'));
    expect(pre.textContent).toContain('Will create');
    const approve = within(pre).getByTestId('crf-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0].body).toContain('orchestrate');
  });
});

describe('the canvas keyboard', () => {
  it('arrows select in reading order, Enter activates, Escape clears', () => {
    const view = blueprintView(PLAN);
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const r = render(<BlueprintCanvas view={view} ariaLabel="plan" selectedKey={null} onSelect={onSelect} onActivate={onActivate} />);
    const viewport = r.getByTestId('crf-viewport');
    fireEvent.keyDown(viewport, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith(view.cards.slice().sort((a, b) => a.rank - b.rank || a.y - b.y)[0]!.key);

    r.rerender(<BlueprintCanvas view={view} ariaLabel="plan" selectedKey="d-brief" onSelect={onSelect} onActivate={onActivate} />);
    fireEvent.keyDown(viewport, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('t-copy');
    fireEvent.keyDown(viewport, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith('d-brief');
    fireEvent.keyDown(viewport, { key: 'Escape' });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('points screen readers at the text views', async () => {
    const { view } = await mountWithPlan();
    const viewport = view.getByTestId('crf-viewport');
    const describedBy = viewport.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toContain('Outline and Table');
  });
});
