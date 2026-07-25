/**
 * Promote message → task/doc: creates the entity via the registry's
 * createVia seam, links it `relates_to` the message, quotes the body, and
 * the affordance rides Thread's reactionsSlot.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROMOTE_TARGETS, promoteMessage, promoteReactionsSlot, quoteExcerpt,
} from '../../interactions';
import { useNavStore } from '../../stores';
import type { MessageView } from '../../types/contract';
import {
  createRig, renderWithProviders, resetStores, toastMessages, type InteractionRig,
} from './helpers';

let rig: InteractionRig;

beforeEach(() => {
  resetStores();
  rig = createRig();
});

async function seedMessage(): Promise<MessageView> {
  const detail = await rig.facade.getEntity(rig.ids.forgeProgressMessage);
  return detail as unknown as MessageView;
}

describe('promoteMessage', () => {
  it('creates a task relates_to the message and quotes it', async () => {
    const message = await seedMessage();
    const { result } = await promoteMessage(rig.facade, message, 'task');

    const created = result.entity;
    expect(created).toBeTruthy();
    expect(created!.kind).toBe('task');
    expect(created!.title).toBe(quoteExcerpt(message.content.body, 80));

    // relates_to edge between the new task and the message
    const conns = await rig.facade.getConnections(created!.id);
    const flat = JSON.stringify(conns);
    expect(flat).toContain('relates_to');
    expect(flat).toContain(message.id);

    // the quote landed in the task description, attributed
    const detail = await rig.facade.getEntity(created!.id);
    const content = detail.content as { kind: string; description?: string };
    expect(content.description).toContain('> ');
    expect(content.description).toContain(message.state.author.displayName);
    expect(content.description).toContain(quoteExcerpt(message.content.body).slice(0, 40));
  });

  it('creates a doc with the quote as markdown body', async () => {
    const message = await seedMessage();
    const { result } = await promoteMessage(rig.facade, message, 'doc');
    const detail = await rig.facade.getEntity(result.entity!.id);
    expect(detail.kind).toBe('doc');
    const content = detail.content as { kind: string; format?: string; body?: string };
    expect(content.format).toBe('markdown');
    expect(content.body).toContain('> ');
  });

  it('rejects kinds outside the promote grammar', async () => {
    const message = await seedMessage();
    await expect(promoteMessage(rig.facade, message, 'channel')).rejects.toThrow(/promote/);
    expect(PROMOTE_TARGETS).toEqual(['task', 'doc']);
  });
});

describe('the affordance on thread message rows (reactionsSlot adapter)', () => {
  it('renders ↗ Promote next to the inner slot and promotes on pick', async () => {
    const message = await seedMessage();
    const inner = vi.fn(() => <span data-testid="inner-slot">reactions</span>);
    const slot = promoteReactionsSlot(inner);
    renderWithProviders(rig, <div>{slot(message)}</div>);

    expect(screen.getByTestId('inner-slot')).toBeTruthy(); // inner slot preserved
    const createSpy = vi.spyOn(rig.facade, 'createEntity');

    fireEvent.click(screen.getByRole('button', { name: /promote/i }));
    const menu = screen.getByTestId('promote-menu');
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(Array.from(items).map((b) => b.textContent)).toEqual([
      expect.stringContaining('task'), expect.stringContaining('doc'),
    ]);

    fireEvent.click(items[0]);
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      kind: 'task',
      attachTo: { entityId: message.id, edgeType: 'relates_to' },
    });
    await waitFor(() => expect(toastMessages().some((m) => m.startsWith('Promoted to task'))).toBe(true));
    // the new entity opens as a panel
    const top = useNavStore.getState().stack.at(-1);
    expect(top?.entityId).toBe(createSpy.mock.results[0] && (await createSpy.mock.results[0].value).entity?.id);
  });

  it('falls back to the default readout when no inner slot is given', async () => {
    const message = await seedMessage();
    const slot = promoteReactionsSlot();
    renderWithProviders(rig, <div>{slot(message)}</div>);
    expect(document.querySelector('[data-slot="reactions"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: /promote/i })).toBeTruthy();
  });
});
