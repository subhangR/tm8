// @vitest-environment jsdom
/**
 * The add-bridge wizard and the link dialog (BRIDGE-ENTITY-DESIGN §4.2, §4.3;
 * v2 §1.2, §1.4, §1.6), on B1b-5/B1b-7's connection and conversation ops.
 *
 * Held here, each with a control that goes red without it:
 * - step 1 lists MY numbers; one not offered here offers first, then is usable
 * - step 2 is the live group list: a conversation already connected in this
 *   space is greyed with where it goes (D20); a read-only group says why and
 *   starts as WhatsApp → tm8 only (D28)
 * - step 3's policy follows §2.2 (chat vs channel); nothing is created before
 *   Create, and widening choices confirm first (§1.5)
 * - step 4 shows the created bridge; Finish hands it back
 * - Link a number: the QR/code arrives on the socket, linked is read back
 *   from connections.list, and the number is offered to the space
 * - Accounts & secrets lists my numbers with Offer / Withdraw / Re-link / Remove
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeView, EntitySummary } from '@tm8/contract';
import { chatLaunchPlan, channelDesign } from '../fixtures/entities';
import { AddBridgeWizard, connectedHere, defaultPolicy } from './AddBridgeWizard';
import { BridgesSection } from './BridgesSection';
import { testPort } from './test-port';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const SPACE = 'sp-atelier';
const WIZARD_OPS = ['bridges.connections.list', 'bridges.connections.begin', 'bridges.conversations.list', 'bridges.create'];

function wizardPort() {
  const t = testPort({ served: WIZARD_OPS });
  const port = {
    ...t.port,
    targets: vi.fn(async (): Promise<EntitySummary[]> => [chatLaunchPlan, channelDesign]),
    create: vi.fn(t.client.create),
    conversations: vi.fn(t.client.conversations),
    connections: {
      list: vi.fn(t.client.connections.list),
      begin: vi.fn(t.client.connections.begin),
      offer: vi.fn(t.client.connections.offer),
      withdraw: vi.fn(t.client.connections.withdraw),
      remove: vi.fn(t.client.connections.remove),
    },
    onConnectionAuth: t.client.onConnectionAuth,
  };
  return { ...t, port };
}

describe('§2.2 defaults', () => {
  it('follow the target and conversation kind', () => {
    expect(defaultPolicy('chat', 'group')).toMatchObject({ trigger: 'mention', outbound: 'replies', whoMayTrigger: 'linked' });
    expect(defaultPolicy('chat', 'dm')).toMatchObject({ trigger: 'every', whoMayTrigger: 'anyone' });
    expect(defaultPolicy('channel', 'group')).toMatchObject({ trigger: 'none', outbound: 'all' });
  });
  it('a conversation connected here is keyed by its provider id, ended bridges excluded', () => {
    const b = { conversation: { externalId: 'g1' }, status: 'live' } as BridgeView;
    const e = { conversation: { externalId: 'g2' }, status: 'ended' } as BridgeView;
    expect([...connectedHere([b, e]).keys()]).toEqual(['g1']);
  });
});

describe('the add-bridge wizard', () => {
  async function open() {
    const t = wizardPort();
    const created: BridgeView[] = [];
    render(<AddBridgeWizard port={t.port} spaceId={SPACE} onClose={() => {}} onCreated={(b) => created.push(b)} />);
    await screen.findByRole('button', { name: 'Use Ada · work phone' });
    return { ...t, created };
  }

  it('walks connection → conversation → target → test, creating only at Create', async () => {
    const { port, created } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Use Ada · work phone' }));
    const step2 = await screen.findByTestId('wizard-step-conversation');
    await waitFor(() => expect(within(step2).getAllByRole('option').length).toBeGreaterThan(2));

    // D20: Infra is already connected here, greyed with where it goes.
    const infra = within(step2).getByRole('option', { name: /Infra/ }) as HTMLButtonElement;
    expect(infra.disabled).toBe(true);
    expect(infra.textContent).toContain('already connected → Infra main');

    fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'gam' } });
    expect(within(step2).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(within(step2).getByRole('option', { name: /Gaming/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: where it lands' }));

    await screen.findByTestId('wizard-step-target');
    expect(port.create).not.toHaveBeenCalled();
    await waitFor(() => expect(within(screen.getByLabelText('Target')).getAllByRole('option').length).toBe(2));
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: chatLaunchPlan.id } });
    expect((screen.getByLabelText('Only when someone writes @tm8 or replies to tm8') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create bridge' }));

    await screen.findByTestId('wizard-step-test');
    expect(port.create).toHaveBeenCalledWith(SPACE, expect.objectContaining({
      connectionId: '0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494',
      conversation: { externalId: '1203631gaming@g.us', kind: 'group', title: 'Gaming', memberCount: 31 },
      targetId: chatLaunchPlan.id,
      policy: expect.objectContaining({ trigger: 'mention', outbound: 'replies', whoMayTrigger: 'linked', style: null }),
      retentionDays: null,
    }));
    expect(screen.getByTestId('wizard-step-test').textContent).toContain('lands in Plan the launch sequence');
    expect(screen.getByTestId('wizard-step-test').textContent).toContain('bridges.test');
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(created.map((b) => b.title)).toEqual(['Gaming']);
  });

  it('starts a read-only group as WhatsApp → tm8 only and says why', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Use Ada · work phone' }));
    const family = await screen.findByRole('option', { name: /Family/ });
    expect(family.textContent).toContain('read-only: only admins can post there');
    fireEvent.click(family);
    fireEvent.click(screen.getByRole('button', { name: 'Next: where it lands' }));
    await screen.findByTestId('wizard-step-target');
    expect((screen.getByLabelText('WhatsApp → tm8 only') as HTMLInputElement).checked).toBe(true);
  });

  it('a channel target pre-selects everything crossing, and widening choices confirm before Create', async () => {
    const { port } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Use Ada · work phone' }));
    fireEvent.click(await screen.findByRole('option', { name: /Release 1.4/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: where it lands' }));
    await screen.findByTestId('wizard-step-target');
    fireEvent.click(screen.getByLabelText(/^# Channel/));
    expect((screen.getByLabelText(/^Everything posted in the target/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Never — log only') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/^💬 Chat/));
    await waitFor(() => expect(within(screen.getByLabelText('Target')).getAllByRole('option').length).toBe(2));
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: chatLaunchPlan.id } });
    fireEvent.click(screen.getByLabelText(/^Anyone in the group/));
    fireEvent.click(screen.getByRole('button', { name: 'Create bridge' }));
    const dialog = await screen.findByTestId('bridge-consequences');
    expect(dialog.textContent).toContain('Anyone in Release 1.4 (6 people), linked or not');
    expect(port.create).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, create it' }));
    await screen.findByTestId('wizard-step-test');
    expect(port.create).toHaveBeenCalledWith(SPACE, expect.objectContaining({ policy: expect.objectContaining({ whoMayTrigger: 'anyone' }) }));
  });

  it('offers a number to the space before it can be used', async () => {
    const { port } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Offer Ada · personal to this space' }));
    await waitFor(() => expect(port.connections.offer).toHaveBeenCalledWith('6f1e2d3c-4b5a-4968-8776-655443322110', SPACE));
    expect(await screen.findByRole('button', { name: 'Use Ada · personal' })).toBeTruthy();
  });

  it('links a new number: the code arrives on the socket, linked is read back, and it is offered here', async () => {
    const { port, client } = await open();
    fireEvent.click(screen.getByRole('button', { name: '+ Link a new number' }));
    const dialog = screen.getByTestId('bridge-link-number');
    fireEvent.click(within(dialog).getByLabelText(/^This phone/));
    fireEvent.change(within(dialog).getByLabelText('Phone number'), { target: { value: '+91 98000 00094' } });
    fireEvent.change(within(dialog).getByLabelText('Number label'), { target: { value: 'Ops phone' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Get a code' }));
    await waitFor(() => expect(port.connections.begin).toHaveBeenCalledWith({
      label: 'Ops phone', authFlow: { kind: 'pairing', phone: '+919800000094' },
    }));
    expect((await screen.findByTestId('bridge-link-code')).textContent).toBe('K7Q2-9MXD');
    // The runtime says linked; the dialog reads it back and offers the number here.
    const id = [...client.connectionsById.keys()].at(-1)!;
    act(() => { client.connectionsById.set(id, { ...client.connectionsById.get(id)!, status: 'linked', externalAccountId: '+91 ···· 0094' }); });
    await waitFor(() => expect(port.connections.offer).toHaveBeenCalledWith(id, SPACE), { timeout: 5000 });
    await screen.findByTestId('wizard-step-conversation', {}, { timeout: 5000 });
  });
});

describe('Settings → Bridges › Accounts & secrets, on connections.list', () => {
  it('lists my numbers with where they are offered, and offers, withdraws and removes', async () => {
    const t = wizardPort();
    render(<BridgesSection port={t.port} spaceId={SPACE} />);
    const row = await screen.findByTestId('connection-0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494');
    expect(row.textContent).toContain('Ada · work phone');
    expect(row.textContent).toContain('2 bridges here');
    expect(screen.getByTestId('connection-6f1e2d3c-4b5a-4968-8776-655443322110').textContent).toContain('not offered here');
    // The Slack bridge rides a number that is not mine: listed, no controls.
    expect(screen.getByTestId('connection-other-5d3e8a10-2f4b-4c7e-8a9d-0c1f2e3d4a5b').textContent).toContain('another member’s number');

    fireEvent.click(screen.getByRole('button', { name: 'More for Ada · personal' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Offer Ada · personal to this space' }));
    await waitFor(() => expect(t.port.connections.offer).toHaveBeenCalled());
    expect((await screen.findByTestId('bridges-notice')).textContent).toContain('offered to this space');

    fireEvent.click(screen.getByRole('button', { name: 'More for Ada · work phone' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Ada · work phone…' }));
    const dialog = await screen.findByTestId('bridge-consequences');
    expect(dialog.textContent).toContain('2 bridge(s) riding it');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove it' }));
    await waitFor(() => expect(t.port.connections.remove).toHaveBeenCalledWith('0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494'));
    expect((await screen.findByTestId('bridges-notice')).textContent).toContain('2 bridge(s) ended');
  });
});
