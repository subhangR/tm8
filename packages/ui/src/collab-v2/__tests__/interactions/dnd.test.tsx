/**
 * The dnd runtime, driven through the NATIVE HTML5 path (what EntityChip and
 * the collection cards actually emit): ghost label previews the meaning
 * before the drop, ambiguity opens the ≤3-option menu, a drop commits ONE
 * placements command, the undo pill redeems the token.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { targetRef, useDropSurface } from '../../interactions';
import type { DropTargetRef } from '../../interactions';
import type { EntitySummary } from '../../types/contract';
import {
  createRig, dragPayloadFor, renderWithProviders, resetStores, summaryOf,
  type InteractionRig,
} from './helpers';

let rig: InteractionRig;

beforeEach(() => {
  resetStores();
  rig = createRig();
});

function Surface({ target, label }: { target: DropTargetRef; label: string }) {
  const { domProps, setNodeRef, isOver, options } = useDropSurface(target);
  return (
    <div ref={setNodeRef} data-testid={`surface-${label}`} {...domProps}>
      {label}
      {isOver && <span data-testid={`over-${label}`}>{options[0]?.ghost}</span>}
    </div>
  );
}

async function setup(surfaces: Array<{ entity: EntitySummary; surface: DropTargetRef['surface']; label: string }>) {
  renderWithProviders(
    rig,
    <>{surfaces.map((s) => <Surface key={s.label} target={targetRef(s.entity, s.surface)} label={s.label} />)}</>,
  );
}

/** Native drag: dragstart on the document (chip does this), then over/drop. */
function dragOnto(source: EntitySummary, surfaceLabel: string): DataTransfer {
  const dt = dragPayloadFor(source);
  fireEvent.dragStart(document.body, { dataTransfer: dt });
  const surface = screen.getByTestId(`surface-${surfaceLabel}`);
  fireEvent.dragOver(surface, { dataTransfer: dt, clientX: 120, clientY: 80 });
  return dt;
}

describe('ghost label previews the meaning before the drop', () => {
  it('unambiguous drop shows the row ghost on hover', async () => {
    const doc = await summaryOf(rig, rig.ids.docRollout);
    const task = await summaryOf(rig, rig.ids.t104);
    await setup([{ entity: task, surface: 'task', label: 'task' }]);

    dragOnto(doc, 'task');
    expect(screen.getByTestId('over-task').textContent).toBe(`Attach to ${task.title}`);
    expect(screen.getByTestId('ghost-label').textContent).toBe(`Attach to ${task.title}`);
  });

  it('a rejected source shows no highlight and no ghost', async () => {
    const commit = await summaryOf(rig, rig.ids.commitA1);
    const task = await summaryOf(rig, rig.ids.t104);
    await setup([{ entity: task, surface: 'task', label: 'task' }]);

    dragOnto(commit, 'task');
    expect(screen.queryByTestId('over-task')).toBeNull();
    expect(screen.queryByTestId('ghost-label')).toBeNull();
  });
});

describe('drops commit one placements command', () => {
  it('single-meaning drop calls placements immediately (no menu)', async () => {
    const doc = await summaryOf(rig, rig.ids.docRollout);
    const task = await summaryOf(rig, rig.ids.t104);
    await setup([{ entity: task, surface: 'task', label: 'task' }]);
    const spy = vi.spyOn(rig.facade, 'placements');

    const dt = dragOnto(doc, 'task');
    fireEvent.drop(screen.getByTestId('surface-task'), { dataTransfer: dt, clientX: 120, clientY: 80 });

    expect(screen.queryByTestId('drop-menu')).toBeNull();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      sourceId: doc.id, targetId: task.id, intent: 'attach',
    });
  });

  it('ambiguous drop opens the ≤3-option menu; choosing commits that option', async () => {
    const t106 = await summaryOf(rig, rig.ids.t106);
    const t104 = await summaryOf(rig, rig.ids.t104);
    await setup([{ entity: t104, surface: 'task', label: 'task' }]);
    const spy = vi.spyOn(rig.facade, 'placements');

    const dt = dragOnto(t106, 'task');
    fireEvent.drop(screen.getByTestId('surface-task'), { dataTransfer: dt, clientX: 100, clientY: 60 });

    const menu = screen.getByTestId('drop-menu');
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBeLessThanOrEqual(3);
    expect(Array.from(items).map((b) => b.querySelector('.cv2-dropmenu__label')?.textContent))
      .toEqual(['Attach', 'Depend', 'Subtask']);
    expect(spy).not.toHaveBeenCalled(); // nothing commits until a choice

    fireEvent.click(items[1]); // Depend
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      sourceId: t106.id, targetId: t104.id, intent: 'depend',
    });
    expect(screen.queryByTestId('drop-menu')).toBeNull();
  });

  it('the menu is keyboard-drivable (arrows + Enter) and Escape cancels', async () => {
    const t106 = await summaryOf(rig, rig.ids.t106);
    const t104 = await summaryOf(rig, rig.ids.t104);
    await setup([{ entity: t104, surface: 'task', label: 'task' }]);
    const spy = vi.spyOn(rig.facade, 'placements');

    let dt = dragOnto(t106, 'task');
    fireEvent.drop(screen.getByTestId('surface-task'), { dataTransfer: dt });
    fireEvent.keyDown(screen.getByTestId('drop-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('drop-menu')).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    dt = dragOnto(t106, 'task');
    fireEvent.drop(screen.getByTestId('surface-task'), { dataTransfer: dt });
    const menu = screen.getByTestId('drop-menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({ intent: 'subtask' });
  });
});

describe('undo pill', () => {
  it('appears after a drop and redeems the token on click', async () => {
    const doc = await summaryOf(rig, rig.ids.docRollout);
    const channel = await summaryOf(rig, rig.ids.chDesign);
    await setup([{ entity: channel, surface: 'channel', label: 'channel' }]);
    const undoSpy = vi.spyOn(rig.facade, 'undo');

    const dt = dragOnto(doc, 'channel');
    fireEvent.drop(screen.getByTestId('surface-channel'), { dataTransfer: dt });
    // channel row is ambiguous (attach vs attach+embed) — take plain attach
    fireEvent.click(screen.getByTestId('drop-menu').querySelectorAll('[role="menuitem"]')[0]);

    const pill = await screen.findByTestId('undo-pill');
    expect(pill.textContent).toContain('Attached');
    fireEvent.click(pill.querySelector('button')!);
    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('undo-pill')).toBeNull());
  });

  it('⌘Z redeems the held token too', async () => {
    const doc = await summaryOf(rig, rig.ids.docRollout);
    const task = await summaryOf(rig, rig.ids.t104);
    await setup([{ entity: task, surface: 'task', label: 'task' }]);
    const undoSpy = vi.spyOn(rig.facade, 'undo');

    const dt = dragOnto(doc, 'task');
    fireEvent.drop(screen.getByTestId('surface-task'), { dataTransfer: dt });
    await screen.findByTestId('undo-pill');

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1));
  });
});
