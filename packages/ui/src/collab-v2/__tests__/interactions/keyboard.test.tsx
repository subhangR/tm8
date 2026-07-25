/**
 * Keyboard parity (DEF-16): reparent via "Move to…" and linking via "Link…"
 * run WITHOUT a pointer, resolve through the same grammar table, and commit
 * the same single placements command (undo included).
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyboardOptionsFor, openLink, openMoveTo, useUndoStore,
} from '../../interactions';
import { useGraphStore } from '../../stores';
import {
  createRig, ingest, renderWithProviders, resetStores, type InteractionRig,
} from './helpers';

let rig: InteractionRig;

beforeEach(() => {
  resetStores();
  rig = createRig();
});

describe('Move to… (keyboard reparent)', () => {
  it('arrow + Enter reparents through one placements command with undo', async () => {
    const [t103a] = await ingest(rig, rig.ids.t103a, rig.ids.t104, rig.ids.t106);
    renderWithProviders(rig, <div />);
    const spy = vi.spyOn(rig.facade, 'placements');

    act(() => { openMoveTo(t103a); });
    const menu = await screen.findByTestId('interaction-menu');
    const dialog = menu.querySelector('[role="dialog"]')!;

    // candidates are same-kind, minus self and the current parent
    const rows = () => Array.from(menu.querySelectorAll('[role="option"]'));
    expect(rows().length).toBeGreaterThanOrEqual(2);
    expect(rows().every((r) => r.textContent!.includes('Move into'))).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Enter' }); // first candidate
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({ sourceId: t103a.id, intent: 'reparent' });
    expect(screen.queryByTestId('interaction-menu')).toBeNull();
    await waitFor(() => expect(useUndoStore.getState().entry?.label).toContain('Moved'));
  });

  it('filters candidates by typed text', async () => {
    const [t103a] = await ingest(rig, rig.ids.t103a, rig.ids.t104, rig.ids.t106, rig.ids.t107);
    const t104 = useGraphStore.getState().entities[rig.ids.t104];
    renderWithProviders(rig, <div />);

    act(() => { openMoveTo(t103a); });
    const menu = await screen.findByTestId('interaction-menu');
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: t104.title.slice(0, 12) } });
    const rows = Array.from(menu.querySelectorAll('[role="option"]'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].textContent).toContain(t104.title);
  });

  it('explains itself for kinds that cannot reparent', async () => {
    const [pr] = await ingest(rig, rig.ids.pr241, rig.ids.pr248);
    renderWithProviders(rig, <div />);
    act(() => { openMoveTo(pr); });
    const menu = await screen.findByTestId('interaction-menu');
    expect(menu.textContent).toContain('cannot be re-parented');
  });
});

describe('Link… (keyboard drop equivalent)', () => {
  it('pick a target, pick the grammar meaning, one placements command', async () => {
    const [doc] = await ingest(rig, rig.ids.docRollout, rig.ids.t104);
    const t104 = useGraphStore.getState().entities[rig.ids.t104];
    renderWithProviders(rig, <div />);
    const spy = vi.spyOn(rig.facade, 'placements');

    act(() => { openLink(doc); });
    let menu = await screen.findByTestId('interaction-menu');
    const targetRow = Array.from(menu.querySelectorAll('[role="option"]'))
      .find((r) => r.textContent!.includes(t104.title))!;
    fireEvent.click(targetRow);

    // step 2 — the same options a drop on the task surface offers
    menu = screen.getByTestId('interaction-menu');
    const optionRows = Array.from(menu.querySelectorAll('[role="option"]'));
    expect(optionRows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Attach'),
    ]);
    fireEvent.click(optionRows[0]);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      sourceId: doc.id, targetId: t104.id, intent: 'attach',
    });
  });

  it('task→task via keyboard offers the full 3-zone menu', async () => {
    const [t106, t104] = await ingest(rig, rig.ids.t106, rig.ids.t104);
    const pairs = keyboardOptionsFor(t106, t104);
    // task surface (attach|depend|subtask) + parent-zone (reparent)
    expect(pairs.map((p) => p.option.intent)).toEqual(['attach', 'depend', 'subtask', 'reparent']);
    expect(pairs.filter((p) => p.surface === 'task')).toHaveLength(3);
  });
});
