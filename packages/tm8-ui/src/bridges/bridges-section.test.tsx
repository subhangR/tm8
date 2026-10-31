// @vitest-environment jsdom
/**
 * Settings → Bridges (BRIDGE-ENTITY-DESIGN §4.2, v2 §1.3, §1.6).
 *
 * Held here, each with a control that goes red without it:
 * - every bridge lists with provider, conversation, target, people, and a
 *   status that is colour AND word (a degraded row says why)
 * - accounts are read off the bridges, titled Accounts & secrets, with the
 *   secrets slot
 * - Add bridge / Link a new account are disabled WITH the unserved operation's
 *   name until `bridges.connections.begin` is served, and live once it is
 * - Pause and Resume call the port and say what pausing means
 * - Remove needs the typed name, then calls `remove`
 * - a refusal is drawn on its row, as a refusal
 * - every enabled control names the operation that makes it live (the
 *   section's own LIVE_VERBS sweep)
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import { BridgesSection, connectionRowsOf } from './BridgesSection';
import { testPort } from './test-port';

afterEach(() => cleanup());

const SPACE = 'sp-atelier';

async function renderSection(opts: Parameters<typeof testPort>[0] = {}) {
  const t = testPort(opts);
  const opened: string[] = [];
  render(<BridgesSection port={t.port} spaceId={SPACE} onOpen={(id) => opened.push(id)} />);
  await screen.findByTestId('bridges-table');
  return { ...t, opened };
}

/**
 * The section's LIVE_VERBS: each enabled control and the operation that makes
 * it live. Anything enabled and not matched here fails the sweep.
 */
const LIVE_VERBS: readonly RegExp[] = [
  /^Open .+ bridge$/,        // opens the panel: browser navigation, asks the seam nothing
  /^More for .+$/,           // opens the row menu, browser-local
  /^Pause .+$/,              // bridges.pause
  /^Resume .+$/,             // bridges.resume
  /^Remove .+…$/,            // opens the typed-name confirm; bridges.remove runs from it
];

function nameOf(el: HTMLElement): string {
  return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '';
}

describe('Settings → Bridges', () => {
  it('lists each bridge with its target, people and a status in colour and word', async () => {
    await renderSection();
    const infra = screen.getByTestId('bridge-row-ent-bridge-infra');
    expect(infra.textContent).toContain('WhatsApp');
    expect(infra.textContent).toContain('Infra (group, 14)');
    expect(infra.textContent).toContain('Infra main');
    expect(infra.textContent).toContain('9 · 3 linked');
    expect(within(infra).getByText('live').className).toContain('kit-pill--run');

    const paused = screen.getByTestId('bridge-row-ent-bridge-deploys');
    expect(within(paused).getByText('paused').className).toContain('kit-pill--wait');
    const degraded = screen.getByTestId('bridge-row-ent-bridge-rahul');
    expect(degraded.textContent).toContain('degraded: The runtime has not checked in for 4 minutes');
  });

  it('reads the accounts off the bridges, under Accounts & secrets, with the secrets slot', async () => {
    const { views } = await renderSection();
    expect(screen.getByText('Accounts & secrets')).toBeTruthy();
    const rows = connectionRowsOf(views);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.provider === 'whatsapp')?.bridges).toBe(2);
    expect(within(screen.getByTestId('bridges-connections')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('coming soon — tracked in the Resources task')).toBeTruthy();
  });

  it('draws Add bridge disabled with the unserved operation, and live once it is served', async () => {
    await renderSection();
    const add = screen.getByTestId('bridges-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain('bridges.connections.begin');
    expect((screen.getByRole('button', { name: '+ Link a new account' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await renderSection({ served: ['bridges.connections.begin'] });
    expect((screen.getByTestId('bridges-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('pauses and resumes through the port, and says what pausing means', async () => {
    const { port } = await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'More for Infra' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause Infra' }));
    await waitFor(() => expect(port.pause).toHaveBeenCalledWith('ent-bridge-infra', 1));
    expect((await screen.findByTestId('bridges-notice')).textContent).toContain('Messages are still logged');
    await waitFor(() => expect(within(screen.getByTestId('bridge-row-ent-bridge-infra')).getByText('paused')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'More for #deploys' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume #deploys' }));
    await waitFor(() => expect(port.resume).toHaveBeenCalledWith('ent-bridge-deploys', 1));
  });

  it('closes the row menu on Escape', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'More for Infra' }));
    expect(screen.getByRole('menu', { name: 'Infra actions' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Infra actions' })).toBeNull();
  });

  it('removes only after the typed name, and lists what happens first', async () => {
    const { port } = await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'More for Infra' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Infra…' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove the Infra bridge' });
    expect(dialog.textContent).toContain('The WhatsApp group is not touched');
    const remove = within(dialog).getByRole('button', { name: 'Remove' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type Infra to confirm'), { target: { value: 'Infr' } });
    expect(remove.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type Infra to confirm'), { target: { value: 'Infra' } });
    fireEvent.click(remove);
    await waitFor(() => expect(port.remove).toHaveBeenCalledWith('ent-bridge-infra', 1));
    await waitFor(() => expect(screen.queryByTestId('bridge-row-ent-bridge-infra')).toBeNull());
    expect(screen.getByTestId('bridges-notice').textContent).toContain('is not touched');
  });

  it('draws a refusal on its row, as a refusal', async () => {
    const { port } = await renderSection();
    port.pause.mockRejectedValueOnce(new CollabError('forbidden', 'only a space admin may pause a bridge'));
    fireEvent.click(screen.getByRole('button', { name: 'More for Infra' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause Infra' }));
    const alert = await within(screen.getByTestId('bridge-row-ent-bridge-infra')).findByRole('alert');
    expect(alert.textContent).toBe('Refused: only a space admin may pause a bridge');
    expect(screen.queryByTestId('bridges-notice')).toBeNull();
  });

  it('opens a bridge panel from its row', async () => {
    const { opened } = await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Open Infra bridge' }));
    expect(opened).toEqual(['ent-bridge-infra']);
  });

  it('offers no enabled control that is not on its LIVE_VERBS list', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'More for Infra' }));
    const enabled = [...document.querySelectorAll<HTMLElement>('button, input, select')]
      .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true');
    const offenders = enabled.map(nameOf).filter((name) => !LIVE_VERBS.some((re) => re.test(name)));
    expect(offenders).toEqual([]);
  });

  it('says it could not read, instead of a blank pane', async () => {
    const { port } = testPort();
    port.list.mockRejectedValueOnce(new CollabError('forbidden', 'not a member'));
    render(<BridgesSection port={port} spaceId={SPACE} />);
    expect((await screen.findByTestId('bridges-load-error')).textContent).toContain('Refused: not a member');
  });
});
