// @vitest-environment jsdom
/**
 * The bridge panel (BRIDGE-ENTITY-DESIGN §4.4; v2 §1.1–§1.5, §2.1).
 *
 * Held here, each with a control that goes red without it:
 * - the six tabs in the design's order, over one `bridges.get` read
 * - the status pill IS Pause/Resume, and the header's ⋯ holds Move, test,
 *   copy and Remove (test disabled with the unserved op's name)
 * - Conversation draws inbound with the participant and outbound as sent,
 *   with the worker's handle
 * - Routing: a narrowing change saves at once with Undo (the same patch back);
 *   a widening one shows its consequence in numbers and needs a second click;
 *   Move always confirms and calls `retarget`
 * - Memory links and unlinks the `remembers` edge, and says where it reaches
 * - People draws the counts and posters until the roster lands
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityDetail } from '@tm8/contract';
import { memoryTokens } from '../fixtures/entities';
import { BRIDGE_TABS, BridgePageBlock } from './BridgePage';
import { memoryEdge, testPort } from './test-port';

afterEach(() => cleanup());

const detail = (id = 'ent-bridge-infra', version = 1) => ({ id, version, kind: 'bridge' } as unknown as EntityDetail);

async function renderPage(opts: Parameters<typeof testPort>[0] = {}, id = 'ent-bridge-infra') {
  const t = testPort(opts);
  const opened: string[] = [];
  render(<BridgePageBlock detail={detail(id)} port={t.port} onOpenEntity={(x) => opened.push(x)} />);
  await screen.findByTestId('bridge-page');
  return { ...t, opened };
}

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('the bridge panel', () => {
  it('draws the six tabs in order, Conversation first', async () => {
    await renderPage();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
      ['Conversation', 'People', 'Routing', 'Memory', 'Loops', 'Health'],
    );
    expect(BRIDGE_TABS).toHaveLength(6);
    expect(screen.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
  });

  it('pauses from the status pill and says what pausing does', async () => {
    const { port } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Status: live/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pause bridge/ }));
    await waitFor(() => expect(port.pause).toHaveBeenCalledWith('ent-bridge-infra', 1));
    expect((await screen.findByRole('button', { name: /^Status: paused/ }))).toBeTruthy();
    expect(screen.getByTestId('bridge-header').textContent).toContain('Messages are still logged');
    expect((screen.queryByRole('menuitem', { name: /Pause for/ }))).toBeNull();
  });

  it('closes its menus on Escape without letting Escape reach the panel', async () => {
    await renderPage();
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    fireEvent.click(screen.getByRole('button', { name: /^Status: live/ }));
    expect(screen.getByRole('menu', { name: 'Pause or resume' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Pause or resume' })).toBeNull();
    expect(panelEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', panelEscape);
  });

  it('keeps Send a test message disabled with the unserved operation, and removes after the typed name', async () => {
    const { port } = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'More for Infra' }));
    const test = screen.getByRole('menuitem', { name: 'Send a test message' }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(test.title).toContain('bridges.test');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove bridge…' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove the Infra bridge' });
    fireEvent.change(within(dialog).getByLabelText('Type Infra to confirm'), { target: { value: 'Infra' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(port.remove).toHaveBeenCalledWith('ent-bridge-infra', 1));
    expect(await screen.findByRole('button', { name: /^Status: removed/ })).toBeTruthy();
  });

  it('draws the conversation: participants inbound, sends outbound with the handle', async () => {
    await renderPage();
    const conv = await screen.findByTestId('bridge-conversation');
    // B2-ticks' shared marks (#1434): BridgeVia inbound, BridgeDeliveryTick outbound.
    expect(within(conv).getAllByTestId('bridge-via')).toHaveLength(2);
    expect(within(conv).getAllByTestId('bridge-via')[0]!.textContent).toContain('via WhatsApp');
    expect(conv.textContent).toContain('@tm8 is the deploy done?');
    expect(conv.textContent).toContain('Release notes (keen-otter)');
    const ticks = within(conv).getAllByTestId('bridge-tick');
    expect(ticks.map((t) => t.getAttribute('data-status'))).toEqual(['sent', 'sent']);
    expect(ticks[0]!.textContent).toContain('sent to WhatsApp');
    expect(screen.getByTestId('bridge-conversation-where').textContent).toContain('reply in WhatsApp');
    // bridges.log.read reads oldest first; the tab says so (review #1445 r1).
    expect(screen.getByTestId('bridge-conversation-order').textContent).toContain('Oldest first');
  });

  it('saves a narrowing change at once and offers Undo with the same patch back', async () => {
    const { port } = await renderPage();
    tab('Routing');
    fireEvent.click(screen.getByLabelText('Never — log only'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledWith('ent-bridge-infra', 1, { policy: { trigger: 'none' } }));
    expect(screen.queryByTestId('bridge-consequences')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(port.update).toHaveBeenLastCalledWith('ent-bridge-infra', 2, { policy: { trigger: 'mention' } }));
  });

  it('asks first, in numbers, before letting anyone start agents', async () => {
    const { port } = await renderPage();
    tab('Routing');
    fireEvent.click(screen.getByLabelText(/^Anyone in the group/));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByTestId('bridge-consequences');
    expect(dialog.textContent).toContain('9 people in Infra, 6 of them not linked, will be able to start agents');
    expect(port.update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, change it' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledWith('ent-bridge-infra', 1, { policy: { whoMayTrigger: 'anyone' } }));
  });

  it('asks first when Undo would widen again (review #1445 r1)', async () => {
    const { port } = await renderPage();
    tab('Routing');
    fireEvent.click(screen.getByLabelText(/^Anyone in the group/));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.click(within(await screen.findByTestId('bridge-consequences')).getByRole('button', { name: 'Yes, change it' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledTimes(1));
    // Narrow back: saves at once, offers Undo.
    fireEvent.click(await screen.findByLabelText('Linked people only'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    // The undo widens to anyone again, so it confirms instead of running.
    const dialog = await screen.findByTestId('bridge-consequences');
    expect(dialog.textContent).toContain('will be able to start agents');
    expect(port.update).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, undo it' }));
    await waitFor(() => expect(port.update).toHaveBeenLastCalledWith('ent-bridge-infra', 3, { policy: { whoMayTrigger: 'anyone' } }));
  });

  it('keeps unsaved Routing edits when the bridge changes underneath (review #1445 r1)', async () => {
    const { port } = await renderPage();
    tab('Routing');
    fireEvent.click(screen.getByLabelText('Never — log only'));
    // Pause from the header: a new version arrives while the form is dirty.
    fireEvent.click(screen.getByRole('button', { name: /^Status: live/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pause bridge/ }));
    await waitFor(() => expect(port.pause).toHaveBeenCalled());
    expect(await screen.findByText(/your unsaved changes are kept/)).toBeTruthy();
    expect((screen.getByLabelText('Never — log only') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledWith('ent-bridge-infra', 2, { policy: { trigger: 'none' } }));
  });

  it('confirms shortening retention with what it deletes', async () => {
    await renderPage();
    tab('Routing');
    fireEvent.click(screen.getByLabelText(/^For a number of days, then delete them here/));
    fireEvent.change(screen.getByLabelText('Keep messages for days'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByTestId('bridge-consequences')).textContent)
      .toContain('This deletes messages older than 30 days from tm8');
  });

  it('moves the bridge only after a confirm, through retarget', async () => {
    const { port } = await renderPage({}, 'ent-bridge-deploys');
    tab('Routing');
    const select = await screen.findByLabelText('Move to');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'ent-chat-launch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const dialog = await screen.findByTestId('bridge-consequences');
    expect(dialog.textContent).toContain('deploys (channel) stops getting #deploys');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move it' }));
    await waitFor(() => expect(port.retarget).toHaveBeenCalledWith('ent-bridge-deploys', 1, 'ent-chat-launch'));
  });

  it('lists the handles that have spoken, in Routing', async () => {
    await renderPage();
    tab('Routing');
    const handles = await screen.findByTestId('bridge-handles');
    await waitFor(() => expect(handles.textContent).toContain('keen-otter'));
  });

  it('links and unlinks a memory, and says where memories reach', async () => {
    const { port } = await renderPage();
    tab('Memory');
    expect(await screen.findByTestId('bridge-memory-empty')).toBeTruthy();
    expect(screen.getByTestId('bridge-memory').textContent).toContain('each turn in Infra main');
    await waitFor(() => expect(within(screen.getByLabelText('Memory to link')).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Memory to link'), { target: { value: memoryTokens.id } });
    fireEvent.click(screen.getByRole('button', { name: '+ Link' }));
    await waitFor(() => expect(port.linkMemory).toHaveBeenCalledWith('ent-bridge-infra', memoryTokens.id));
    fireEvent.click(await screen.findByRole('button', { name: `Unlink ${memoryTokens.title}` }));
    await waitFor(() => expect(port.unlinkMemory).toHaveBeenCalledWith('edge-new'));
  });

  it('says a session target carries no memory on delivered messages', async () => {
    await renderPage({ memories: [memoryEdge('e1', memoryTokens)] }, 'ent-bridge-rahul');
    tab('Memory');
    expect((await screen.findByTestId('bridge-memory')).textContent).toContain("a running session's working set is fixed");
  });

  it('draws people counts and posters until the roster lands', async () => {
    await renderPage();
    tab('People');
    const people = screen.getByTestId('bridge-people');
    expect(people.textContent).toContain('Participants seen9');
    expect(people.textContent).toContain('keen-otter');
    expect(screen.getByTestId('bridge-people-roster-note').textContent).toContain('bridges.participants.list');
  });

  it('draws health as the server derived it, with Send test disabled and why', async () => {
    await renderPage({}, 'ent-bridge-rahul');
    tab('Health');
    const health = screen.getByTestId('bridge-health');
    expect(health.textContent).toContain('offline');
    expect(health.textContent).toContain('The runtime has not checked in for 4 minutes');
    const send = screen.getByRole('button', { name: 'Send test' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toContain('bridges.test');
  });

  it('says it is unwired without a client', () => {
    render(<BridgePageBlock detail={detail()} port={null} />);
    expect(screen.getByRole('status').textContent).toContain('not wired');
  });
});
