/**
 * Context-seeded creation: channel "+" = create+attach, parent "+" = child,
 * and the modal renders ONLY the registry creation-form schema fields.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreatePlus, CreationModal, createFromSeed, openCreation, seedForChannel,
  seedForParent, useCreationStore,
} from '../../interactions';
import { registryFor } from '../../registry';
import {
  createRig, renderWithProviders, resetStores, toastMessages, type InteractionRig,
} from './helpers';

let rig: InteractionRig;

beforeEach(() => {
  resetStores();
  rig = createRig();
});

describe('createFromSeed', () => {
  it('channel "+" creates AND attaches atomically (one command)', async () => {
    const spy = vi.spyOn(rig.facade, 'createEntity');
    const result = await createFromSeed(
      rig.facade, 'task', seedForChannel(rig.ids.space, rig.ids.chDesign), 'Design QA pass',
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      kind: 'task', title: 'Design QA pass',
      attachTo: { entityId: rig.ids.chDesign, edgeType: 'attached_to' },
    });
    const conns = await rig.facade.getConnections(result.entity!.id);
    expect(JSON.stringify(conns)).toContain(rig.ids.chDesign);
  });

  it('parent "+" creates the entity as a child', async () => {
    const result = await createFromSeed(
      rig.facade, 'task', seedForParent(rig.ids.space, rig.ids.t104), 'Subtask via +',
    );
    expect(result.entity!.parentId).toBe(rig.ids.t104);
  });

  it('refuses non-creatable kinds with the registry reason', async () => {
    await expect(
      createFromSeed(rig.facade, 'member', { spaceId: rig.ids.space }, 'Nope'),
    ).rejects.toThrow(registryFor('member').creationDisabledReason!);
  });
});

describe('CreationModal — registry schema fields ONLY', () => {
  it('renders the task schema (title + description/priority/dueDate) and nothing else', () => {
    renderWithProviders(
      rig,
      <CreationModal
        request={{ kind: 'task', seed: { spaceId: rig.ids.space } }}
        onClose={() => {}}
      />,
    );
    const schema = registryFor('task').creation!;
    // the title field + exactly the schema fields
    expect(screen.getByLabelText(schema.titleLabel)).toBeTruthy();
    for (const field of schema.fields) {
      expect(screen.getByLabelText(field.label)).toBeTruthy();
    }
    const dialog = screen.getByRole('dialog');
    const inputs = dialog.querySelectorAll('input, textarea, select');
    expect(inputs).toHaveLength(1 + schema.fields.length); // no extra fields
  });

  it('renders the doc schema for docs (format select + body)', () => {
    renderWithProviders(
      rig,
      <CreationModal
        request={{ kind: 'doc', seed: { spaceId: rig.ids.space } }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText('Format').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Body').tagName).toBe('TEXTAREA');
  });

  it('submits typed content and toasts + closes', async () => {
    const onClose = vi.fn();
    const spy = vi.spyOn(rig.facade, 'createEntity');
    renderWithProviders(
      rig,
      <CreationModal
        request={{ kind: 'task', seed: seedForChannel(rig.ids.space, rig.ids.chBuild) }}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Ship the grammar' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'All 7 rows.' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.submit(screen.getByRole('dialog'));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      title: 'Ship the grammar',
      content: { description: 'All 7 rows.', priority: 'high' },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastMessages().some((m) => m.includes('Created Ship the grammar'))).toBe(true);
  });
});

describe('the "+" affordance and the host', () => {
  it('single-kind CreatePlus opens the modal directly through the store', () => {
    renderWithProviders(
      rig,
      <CreatePlus kinds={['task']} seed={seedForChannel(rig.ids.space, rig.ids.chBuild)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create here' }));
    expect(useCreationStore.getState().request).toMatchObject({ kind: 'task' });
    // the provider-mounted CreationHost renders it
    expect(screen.getByTestId('creation-modal')).toBeTruthy();
  });

  it('multi-kind CreatePlus offers a picker of registry-creatable kinds', () => {
    renderWithProviders(
      rig,
      <CreatePlus kinds={['task', 'doc']} seed={{ spaceId: rig.ids.space }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create here' }));
    const menu = screen.getByRole('menu', { name: 'What to create' });
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    fireEvent.click(menu.querySelectorAll('[role="menuitem"]')[1]);
    expect(useCreationStore.getState().request?.kind).toBe('doc');
  });

  it('openCreation is the imperative path (palette/menus can call it)', () => {
    renderWithProviders(rig, <div />);
    act(() => { openCreation('doc', seedForParent(rig.ids.space, rig.ids.docSpec)); });
    expect(screen.getByTestId('creation-modal')).toBeTruthy();
    expect(screen.getByLabelText('Doc title')).toBeTruthy();
  });
});
