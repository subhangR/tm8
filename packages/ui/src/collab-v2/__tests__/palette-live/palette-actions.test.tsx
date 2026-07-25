/**
 * L2.4 gate — EVERY action category executed keyboard-only:
 * navigate · create (in a context) · link A→B with the edge-type picker ·
 * pull · status · complete · panel ops. Plus the context-awareness contract
 * (`facade.getActions`) and code-based error surfacing (DEV-8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { createSimulation, type MockFacade } from '../../mock';
import { useGraphStore } from '../../stores/graph';
import { useNavStore } from '../../stores/nav';
import { CollabError } from '../../types/contract';
import { CommandPalette, openPaletteWith } from '../../subsystems/palette';
import type { PaletteExecution, PaletteNotice } from '../../subsystems/palette';
import {
  createFacade, paletteInput, press, renderWith, resetAll, rowLabels,
  seedKnown, selectAndActivate, typeInto,
} from './helpers';

const nav = () => useNavStore.getState();

let facade: MockFacade;
let executed: PaletteExecution[];
let notices: PaletteNotice[];

async function openPalette(contextId?: string | null): Promise<void> {
  await act(async () => { nav().setSpace(facade.ids.space); });
  await seedKnown(facade);
  renderWith(facade, (
    <CommandPalette
      facade={facade}
      onExecuted={(e) => executed.push(e)}
      onNotice={(n) => notices.push(n)}
    />
  ));
  await act(async () => { openPaletteWith(contextId ?? null); });
  await screen.findByTestId('command-palette');
  await waitFor(() => expect(rowLabels().length).toBeGreaterThan(2));
}

function titleOf(id: string): string {
  const e = useGraphStore.getState().entities[id];
  if (!e) throw new Error(`entity ${id} not in the store`);
  return e.title;
}

beforeEach(() => {
  resetAll();
  facade = createFacade();
  executed = [];
  notices = [];
});

describe('navigate', () => {
  it('“Go to Docs” moves the primary view and closes the palette', async () => {
    await openPalette();
    typeInto(paletteInput(), 'go to docs');
    selectAndActivate((l) => l === 'Go to Docs');

    await waitFor(() => expect(nav().view).toBe('docs'));
    expect(nav().paletteOpen).toBe(false);
    expect(executed.at(-1)).toMatchObject({ category: 'navigate', detail: { view: 'docs' } });
  });

  it('the Go to… step lists every primary view', async () => {
    await openPalette();
    typeInto(paletteInput(), 'go to…');
    selectAndActivate((l) => l === 'Go to…');
    await screen.findByTestId('palette-step');

    const labels = rowLabels();
    for (const v of ['Home', 'Tasks', 'Docs', 'Team', 'Tracking', 'Graph', 'Leaderboard', 'Inbox', 'Settings']) {
      expect(labels).toContain(v);
    }
  });
});

describe('create', () => {
  it('creates a task from the palette and opens it as a panel', async () => {
    await openPalette();
    typeInto(paletteInput(), 'create task');
    selectAndActivate((l) => /create task/i.test(l));
    await screen.findByTestId('palette-step');

    typeInto(paletteInput(), 'Palette-made task');
    await waitFor(() => expect(rowLabels().some((l) => l.includes('Palette-made task'))).toBe(true));
    press(paletteInput(), 'Enter');

    await waitFor(() => expect(executed.some((e) => e.category === 'create')).toBe(true));
    const created = executed.find((e) => e.category === 'create');
    expect(created?.detail).toMatchObject({ kind: 'task', title: 'Palette-made task' });

    const detail = await facade.getEntity(created?.entityId as string);
    expect(detail.title).toBe('Palette-made task');
    await waitFor(() => expect(nav().stack.at(-1)?.entityId).toBe(created?.entityId));
  });

  it('“Create in {context}…” attaches the new entity to the context entity', async () => {
    await openPalette(facade.ids.chBuild);
    typeInto(paletteInput(), 'create in');
    selectAndActivate((l) => /^Create in /.test(l));
    await screen.findByTestId('palette-step');

    typeInto(paletteInput(), 'Task inside the channel');
    press(paletteInput(), 'Enter');

    await waitFor(() => expect(executed.some((e) => e.category === 'create')).toBe(true));
    const created = executed.find((e) => e.category === 'create');
    expect(created?.detail).toMatchObject({ parentId: facade.ids.chBuild });

    const connections = await facade.getConnections(created?.entityId as string);
    const attached = connections.outgoing.find((g) => g.type === 'attached_to');
    expect(attached?.edges.some((e) => e.target.id === facade.ids.chBuild)).toBe(true);
  });

  it('refuses an empty title instead of creating a nameless entity', async () => {
    await openPalette();
    typeInto(paletteInput(), 'create doc');
    selectAndActivate((l) => /create doc/i.test(l));
    await screen.findByTestId('palette-step');

    press(paletteInput(), 'Enter');
    await waitFor(() => expect(notices.at(-1)?.kind).toBe('error'));
    expect(executed.some((e) => e.category === 'create')).toBe(false);
  });
});

describe('link A→B with the edge-type picker', () => {
  it('walks source → target → edge type entirely on the keyboard', async () => {
    await openPalette(facade.ids.t105);
    typeInto(paletteInput(), 'link');
    selectAndActivate((l) => /^Link .* to…$/.test(l));
    await screen.findByTestId('palette-step');

    const target = titleOf(facade.ids.docSpec);
    typeInto(paletteInput(), target.slice(0, 12));
    selectAndActivate((l) => l === target);

    await waitFor(() => expect(screen.getByTestId('palette-step').textContent).toMatch(/edge/i));
    typeInto(paletteInput(), 'related');
    selectAndActivate((l) => l === 'Related to');

    await waitFor(() => expect(executed.some((e) => e.category === 'link')).toBe(true));
    expect(executed.at(-1)?.detail).toMatchObject({
      sourceId: facade.ids.t105, targetId: facade.ids.docSpec, type: 'relates_to',
    });

    const connections = await facade.getConnections(facade.ids.t105);
    const group = connections.outgoing.find((g) => g.type === 'relates_to');
    expect(group?.edges.some((e) => e.target.id === facade.ids.docSpec)).toBe(true);
  });

  it('offers a namespaced custom edge type for anything the grammar lacks', async () => {
    await openPalette(facade.ids.t105);
    typeInto(paletteInput(), 'link');
    selectAndActivate((l) => /^Link .* to…$/.test(l));

    const target = titleOf(facade.ids.t107);
    typeInto(paletteInput(), target.slice(0, 12));
    selectAndActivate((l) => l === target);

    typeInto(paletteInput(), 'inspired by');
    selectAndActivate((l) => /Custom edge/.test(l));

    await waitFor(() => expect(executed.some((e) => e.category === 'link')).toBe(true));
    expect(executed.at(-1)?.detail).toMatchObject({ type: 'x:inspired_by' });
  });

  it('surfaces an invalid link by CODE, keeping the palette open', async () => {
    await openPalette(facade.ids.docSpec);
    typeInto(paletteInput(), 'link');
    selectAndActivate((l) => /^Link .* to…$/.test(l));

    const target = titleOf(facade.ids.subhang);
    typeInto(paletteInput(), target.slice(0, 8));
    selectAndActivate((l) => l === target);

    typeInto(paletteInput(), 'tracks');
    selectAndActivate((l) => l === 'Tracks');

    await waitFor(() => expect(notices.at(-1)?.kind).toBe('error'));
    expect(nav().paletteOpen).toBe(true);
  });
});

describe('pull and status', () => {
  it('pulls the context entity at its current version', async () => {
    const before = await facade.getEntity(facade.ids.docSpec);
    await openPalette(facade.ids.docSpec);

    typeInto(paletteInput(), 'pull');
    selectAndActivate((l) => /^Pull /.test(l));

    await waitFor(() => expect(executed.some((e) => e.category === 'pull')).toBe(true));
    const after = await facade.getEntity(facade.ids.docSpec);
    expect((after.badges.pulls ?? []).length).toBeGreaterThan((before.badges.pulls ?? []).length);
    expect(executed.at(-1)?.detail).toMatchObject({ pinnedVersion: before.version });
  });

  it('sets a work status through the status step', async () => {
    await openPalette(facade.ids.t103);
    typeInto(paletteInput(), 'status');
    selectAndActivate((l) => /status/i.test(l));
    await screen.findByTestId('palette-step');

    typeInto(paletteInput(), 'in review');
    selectAndActivate((l) => l === 'In review');

    await waitFor(() => expect(executed.some((e) => e.category === 'status')).toBe(true));
    const after = await facade.getEntity(facade.ids.t103);
    expect(after.state.kind === 'task' && after.state.workStatus).toBe('in_review');
  });

  it('completes a task once its acceptance criteria are done', async () => {
    const simulation = createSimulation(facade);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await simulation.step();
    });

    await openPalette(facade.ids.t104);
    typeInto(paletteInput(), 'complete');
    selectAndActivate((l) => /^Complete /.test(l));

    await waitFor(() => expect(executed.some((e) => e.itemId === 'complete')).toBe(true));
    const after = await facade.getEntity(facade.ids.t104);
    expect(after.state.kind === 'task' && after.state.workStatus).toBe('done');
  });
});

describe('panel operations have keyboard parity', () => {
  it('opens, pins and promotes the context entity from the palette', async () => {
    await openPalette(facade.ids.t103);

    typeInto(paletteInput(), 'pin');
    selectAndActivate((l) => /^Pin /.test(l));
    await waitFor(() => expect(nav().pinned.some((r) => r.entityId === facade.ids.t103)).toBe(true));

    await act(async () => { openPaletteWith(facade.ids.t103); });
    typeInto(paletteInput(), 'full view');
    selectAndActivate((l) => /full view$/.test(l));
    await waitFor(() => expect(nav().view).toBe('entity'));
    expect(nav().entityId).toBe(facade.ids.t103);
  });
});

describe('context awareness', () => {
  it('shows the facade’s context actions only when a context entity is set', async () => {
    await openPalette();
    expect(screen.queryByTestId('palette-context')).toBeNull();
    expect(rowLabels().some((l) => /^Link .* to…$/.test(l))).toBe(false);

    await act(async () => { openPaletteWith(facade.ids.t105); });
    await waitFor(() => expect(screen.queryByTestId('palette-context')).not.toBeNull());
    await waitFor(() => expect(rowLabels().some((l) => /^Link .* to…$/.test(l))).toBe(true));
  });

  it('translates a rejected command into a code-derived message (DEV-8)', async () => {
    await openPalette(facade.ids.t103);
    facade.failNextWith(new CollabError('forbidden', 'raw server text nobody should read'));

    typeInto(paletteInput(), 'status');
    selectAndActivate((l) => /status/i.test(l));
    typeInto(paletteInput(), 'blocked');
    selectAndActivate((l) => l === 'Blocked');

    await waitFor(() => expect(notices.at(-1)?.kind).toBe('error'));
    expect(notices.at(-1)?.message).toBe('You do not have permission for that.');
  });
});

describe('mouse and keyboard share ONE path', () => {
  it('clicking a row runs the same `run()` Enter does', async () => {
    await openPalette();
    typeInto(paletteInput(), 'go to tasks');
    await waitFor(() => expect(rowLabels()).toContain('Go to Tasks'));

    const row = [...document.querySelectorAll('.cv2-palette__row')]
      .find((r) => r.querySelector('.cv2-palette__label')?.textContent === 'Go to Tasks') as HTMLElement;
    const spy = vi.spyOn(useNavStore.getState(), 'setView');
    await act(async () => { row.click(); });

    await waitFor(() => expect(nav().view).toBe('tasks'));
    spy.mockRestore();
  });
});
