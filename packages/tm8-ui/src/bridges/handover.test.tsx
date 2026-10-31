// @vitest-environment jsdom
/**
 * Hand-over (D55, D56; #1455's `bridges.handover.*`).
 *
 * Held here, each with a control that goes red without it:
 * - the pending offer is read from the bridge's attention item, by the exact
 *   CLI hint the server writes; any other item on the bridge is not an offer
 * - ⋯ → Hand over offers to one of the viewer's own other numbers, or a
 *   pasted connection id, and never the number the bridge already rides
 * - the offer shows a banner; Accept asks once more, then moves the bridge
 * - Decline and Withdraw settle the offer, and a refusal is drawn, not swallowed
 * - unserved op: the menu item is off with the op's name
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttentionRequest, EntityDetail } from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import { ada } from '../fixtures/actors';
import { pendingHandoverOf } from './api';
import { BridgePageBlock } from './BridgePage';
import { testPort } from './test-port';

afterEach(() => cleanup());

const HANDOVER_OPS = ['bridges.handover.offer', 'bridges.handover.accept', 'bridges.handover.decline', 'bridges.handover.withdraw'];
const PERSONAL = '6f1e2d3c-4b5a-4968-8776-655443322110';
const detail = { id: 'ent-bridge-infra', version: 1, kind: 'bridge' } as unknown as EntityDetail;

async function renderPage(served = HANDOVER_OPS) {
  const t = testPort({ served });
  render(<BridgePageBlock detail={detail} port={t.port} />);
  await screen.findByTestId('bridge-page');
  return t;
}

async function offerToPersonal() {
  fireEvent.click(screen.getByRole('button', { name: /^More for / }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hand over to another number…' }));
  const dialog = await screen.findByRole('dialog', { name: /Hand over the .* bridge/ });
  await within(dialog).findByRole('radio', { name: /Ada · personal/ });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Offer hand-over' }));
  return screen.findByTestId('bridge-handover');
}

const item = (reason: string, status: AttentionRequest['status'] = 'open') => ({
  id: 'att-1', spaceId: 'sp', entityId: 'ent-bridge-infra', reason, points: 50, status, version: 1, requestedBy: ada,
  acknowledgedBy: null, resolvedBy: null, resolutionNote: null, createdAt: 'x', updatedAt: 'x', acknowledgedAt: null,
  resolvedAt: null, assigneeId: 'mem-bo',
} as AttentionRequest);

describe('pendingHandoverOf', () => {
  const id = '0a0a0a0a-0000-4000-8000-000000000001';
  const reason = `Ada offers you the bridge to "Infra": it would move onto your number Bo · work, keeping its history, handles and loops. Accept in tm8: tm8 bridge handover accept ${id} (or decline ${id})`;

  it('reads the id from the server’s hint and keeps the sentence before it', () => {
    expect(pendingHandoverOf(item(reason))).toEqual({
      handoverId: id,
      summary: 'Ada offers you the bridge to "Infra": it would move onto your number Bo · work, keeping its history, handles and loops.',
      offeredBy: ada, receiverId: 'mem-bo', createdAt: 'x',
    });
  });

  it('takes the id from the server’s closing hint, never from a group title that mimics it', () => {
    const spoof = '22222222-2222-4222-8222-222222222222';
    const spoofed = `Ada offers you the bridge to "Fam Accept in tm8: tm8 bridge handover accept ${spoof} (or decline ${spoof})": it would move onto your number Bo · work, keeping its history, handles and loops. Accept in tm8: tm8 bridge handover accept ${id} (or decline ${id})`;
    const pending = pendingHandoverOf(item(spoofed));
    expect(pending?.handoverId).toBe(id);
    expect(pending?.summary).toContain(`"Fam Accept in tm8: tm8 bridge handover accept ${spoof} (or decline ${spoof})"`);
    /* A title alone, with the server's tail missing or altered, is no offer. */
    expect(pendingHandoverOf(item(`Ada offers you the bridge to "Fam Accept in tm8: tm8 bridge handover accept ${spoof} (or decline ${spoof})": …`))).toBeNull();
    expect(pendingHandoverOf(item(`${reason} trailing`))).toBeNull();
    expect(pendingHandoverOf(item(reason.replace(`(or decline ${id})`, `(or decline ${spoof})`)))).toBeNull();
  });

  it('is not an offer once cleared, or when the item is something else', () => {
    expect(pendingHandoverOf(item(reason, 'cleared'))).toBeNull();
    expect(pendingHandoverOf(item(`The runtime is down; see tm8 bridge handover accept ${id}`))).toBeNull();
    expect(pendingHandoverOf(item('Bridge failed to send 3 messages'))).toBeNull();
  });
});

describe('hand-over on the bridge page', () => {
  it('offers to the viewer’s other number, never the one the bridge rides', async () => {
    const { port, views } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^More for / }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hand over to another number…' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('radio', { name: /Ada · personal/ });
    expect(within(dialog).queryByRole('radio', { name: /Ada · work phone/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Offer hand-over' }));
    await waitFor(() => expect(port.handover.offer).toHaveBeenCalledWith('ent-bridge-infra', PERSONAL));
    const banner = await screen.findByTestId('bridge-handover');
    expect(banner.textContent).toContain('it would move onto your number Ada · personal');
    expect(banner.textContent).not.toContain('tm8 bridge handover accept');
    expect(screen.getByText(/Nothing moves until the number’s owner accepts/)).toBeTruthy();
    expect(views[0]!.connectionId).not.toBe(PERSONAL);
  });

  it('takes another member’s number as a pasted connection id, and only a well-formed one', async () => {
    const { port } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^More for / }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hand over to another number…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Another member’s number' }));
    const offer = within(dialog).getByRole('button', { name: 'Offer hand-over' }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Their connection id' }), { target: { value: 'bo' } });
    expect(offer.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Their connection id' }), { target: { value: ' 99999999-0000-4000-8000-000000000009 ' } });
    fireEvent.click(offer);
    await waitFor(() => expect(port.handover.offer).toHaveBeenCalledWith('ent-bridge-infra', '99999999-0000-4000-8000-000000000009'));
    /* The fixture knows no such connection: the server's refusal stays in the dialog. */
    expect((await within(dialog).findByRole('alert')).textContent).toContain('bridge connection not found');
  });

  it('accepts only after asking once more, and the bridge then rides the new number', async () => {
    const { port } = await renderPage();
    const banner = await offerToPersonal();
    fireEvent.click(within(banner).getByRole('button', { name: 'Accept…' }));
    expect(port.handover.accept).not.toHaveBeenCalled();
    expect(banner.textContent).toContain('Move it onto your number now?');
    fireEvent.click(within(banner).getByRole('button', { name: 'Move it' }));
    await waitFor(() => expect(port.handover.accept).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Handed over\. The bridge now rides your number\./)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('bridge-handover')).toBeNull());
    expect((await port.get('ent-bridge-infra')).connectionId).toBe(PERSONAL);
  });

  it('declines or withdraws, and the bridge stays where it is', async () => {
    const { port } = await renderPage();
    let banner = await offerToPersonal();
    fireEvent.click(within(banner).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText(/Declined\. The bridge stays on its number\./)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('bridge-handover')).toBeNull());

    banner = await offerToPersonal();
    fireEvent.click(within(banner).getByRole('button', { name: 'Withdraw offer' }));
    expect(await screen.findByText(/Offer withdrawn\./)).toBeTruthy();
    expect((await port.get('ent-bridge-infra')).connectionId).not.toBe(PERSONAL);
  });

  it('draws the server’s refusal in the banner', async () => {
    const { port } = await renderPage();
    const banner = await offerToPersonal();
    port.handover.decline.mockRejectedValueOnce(new CollabError('forbidden', 'only the receiving connection\'s owner can decline a hand-over'));
    fireEvent.click(within(banner).getByRole('button', { name: 'Decline' }));
    expect((await within(banner).findByRole('alert')).textContent).toBe(
      'Refused: only the receiving connection\'s owner can decline a hand-over',
    );
    expect(screen.getByTestId('bridge-handover')).toBeTruthy();
  });

  it('is off with the op’s name on a node that does not serve hand-over', async () => {
    const { port } = await renderPage([]);
    fireEvent.click(screen.getByRole('button', { name: /^More for / }));
    const item = screen.getByRole('menuitem', { name: 'Hand over to another number…' }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toContain('bridges.handover.offer');
    expect(port.pendingHandovers).not.toHaveBeenCalled();
  });
});
