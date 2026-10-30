// @vitest-environment jsdom
/**
 * The bridge People tab (§4.4, D50-D52). A few high-signal tests:
 *
 * - the trust word is the server's: `asserted` is never drawn as verified,
 *   and a member sees masked ids and no row actions;
 * - an admin's row actions send exactly the patch they say (mute, assert,
 *   revoke), and a refusal is shown as the server worded it;
 * - the filter splits linked (verified + asserted) from guests.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgePeopleTab } from './BridgePeopleTab';
import { FIXTURE_BRIDGE_ID, FIXTURE_MEMBERS, fixturePort } from './fixtures';

afterEach(cleanup);

const rowOf = (name: string) => screen.getAllByTestId('bridge-participant')
  .find((li) => li.querySelector('.brp__name')?.textContent === name) as HTMLElement;

describe('BridgePeopleTab', () => {
  it('shows a member the masked roster with the server\'s trust words and no actions', async () => {
    render(<BridgePeopleTab bridgeId={FIXTURE_BRIDGE_ID} port={fixturePort({ admin: false })} />);
    await screen.findByText('Rahul');
    expect(screen.getByText('5 people · 2 linked · 3 guests')).toBeTruthy();
    expect(within(rowOf('Rahul')).getByText('…9494')).toBeTruthy();
    expect(within(rowOf('Priya')).getByText('asserted')).toBeTruthy();
    expect(within(rowOf('Priya')).queryByText('linked ✓')).toBeNull();
    expect(within(rowOf('Subhang')).getByText('linked ✓')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'This is…' })).toBeNull();
    expect(screen.queryByText(/919811109494/)).toBeNull();
  });

  it('sends an admin\'s mute, assert and revoke as exactly those patches', async () => {
    const port = fixturePort();
    const update = vi.spyOn(port, 'update');
    render(<BridgePeopleTab bridgeId={FIXTURE_BRIDGE_ID} port={port} />);
    await screen.findByText('Rahul');

    fireEvent.click(within(rowOf('Rahul')).getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(within(rowOf('Rahul')).getByText('muted')).toBeTruthy());
    expect(update).toHaveBeenLastCalledWith(FIXTURE_BRIDGE_ID, '919811109494@s.whatsapp.net', { muted: true });

    fireEvent.click(within(rowOf('Rahul')).getByRole('button', { name: 'This is…' }));
    const select = await screen.findByRole('combobox', { name: 'Member Rahul is' });
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(FIXTURE_MEMBERS.length + 1));
    fireEvent.change(select, { target: { value: FIXTURE_MEMBERS[2]!.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Assert' }));
    await waitFor(() => expect(within(rowOf('Rahul')).getByText('asserted')).toBeTruthy());
    expect(update).toHaveBeenLastCalledWith(FIXTURE_BRIDGE_ID, '919811109494@s.whatsapp.net', { memberId: FIXTURE_MEMBERS[2]!.id });

    fireEvent.click(within(rowOf('Rahul')).getByRole('button', { name: 'Revoke assertion' }));
    await waitFor(() => expect(within(rowOf('Rahul')).getByText('guest')).toBeTruthy());
    expect(update).toHaveBeenLastCalledWith(FIXTURE_BRIDGE_ID, '919811109494@s.whatsapp.net', { memberId: null });
    // A verified link is the person's own: no admin action touches it.
    expect(within(rowOf('Subhang')).queryByRole('button', { name: 'Revoke assertion' })).toBeNull();
    expect(within(rowOf('Subhang')).queryByRole('button', { name: 'This is…' })).toBeNull();
  });

  it('shows a refusal as the server worded it', async () => {
    const port = fixturePort();
    port.update = vi.fn(async () => { throw Object.assign(new Error('this address is verified as someone else; they must unlink it first'), { code: 'conflict' }); });
    render(<BridgePeopleTab bridgeId={FIXTURE_BRIDGE_ID} port={port} />);
    await screen.findByText('Rahul');
    fireEvent.click(within(rowOf('Rahul')).getByRole('button', { name: 'Mute' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Refused: this address is verified as someone else; they must unlink it first');
  });

  it('filters linked from guests, and offers the host\'s invite on guest rows only', async () => {
    render(<BridgePeopleTab bridgeId={FIXTURE_BRIDGE_ID} port={fixturePort()} renderInvite={(p) => <button type="button">Invite {p.displayName}</button>} />);
    await screen.findByText('Rahul');
    expect(screen.getByRole('button', { name: 'Invite Rahul' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite Priya' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Linked' }));
    expect(screen.getAllByTestId('bridge-participant').map((li) => li.dataset.trust)).toEqual(['linked', 'asserted']);
    fireEvent.click(screen.getByRole('radio', { name: 'Guests' }));
    expect(screen.getAllByTestId('bridge-participant').every((li) => li.dataset.trust === 'guest')).toBe(true);
  });
});
