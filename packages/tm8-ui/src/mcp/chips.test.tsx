// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { McpProvider } from './context';
import { McpPicker } from './McpPicker';
import type { McpAccount, McpCatalog, McpPort, McpSelection, McpServer } from './port';
afterEach(cleanup);

const mine: McpAccount = { id: 'work', label: 'Work', ownerId: 'me', canUse: true, canManage: true, status: 'connected', sharing: 'private' };
const server = (over: Partial<McpServer> & { id: string; title: string }): McpServer => ({
  version: 1, description: '', transport: 'http', url: `https://${over.id}.example/mcp`, auth: 'oauth',
  approved: true, enabled: true, canManage: false, canAttach: true, accounts: [], ...over,
});
/** Notion is on by default with the viewer's own account; Docs needs none; Figma is not connected. */
const catalog = (): McpCatalog => ({ canRegister: false, canAttach: true, defaults: [{ serverId: 'notion' }], servers: [
  server({ id: 'notion', title: 'Notion', source: { catalogId: 'notion' } as McpServer['source'], accounts: [mine] }),
  server({ id: 'docs', title: 'Docs', auth: 'none' }),
  server({ id: 'figma', title: 'Figma' }),
] });
const portFor = (read: McpPort['catalog']): McpPort => ({ catalog: vi.fn(read) } as unknown as McpPort);

function Launch({ port, targetId = 'task', onReady = vi.fn(), onCount = vi.fn(), onChange = vi.fn(), initial }: {
  port: McpPort; targetId?: string; onReady?(ready: boolean): void; onCount?(count: number): void;
  onChange?(value: McpSelection[] | undefined): void; initial?: McpSelection[];
}) {
  const [value, setValue] = useState<McpSelection[] | undefined>(initial);
  return <McpProvider port={port}>
    <McpPicker layout="compact" targetId={targetId} value={value} onReady={onReady} onCount={onCount}
      onChange={next => { onChange(next); setValue(next); }} />
  </McpProvider>;
}

describe('the compact launch row', () => {
  it('draws nothing and counts 0 when the Space has no connectors', async () => {
    const data = catalog(); data.servers = []; data.defaults = [];
    const onCount = vi.fn(), onReady = vi.fn(); const port = portFor(async () => data);
    render(<Launch port={port} onCount={onCount} onReady={onReady} />);
    await waitFor(() => expect(screen.queryByTestId('mcp-compact-loading')).toBeNull());
    expect(document.body.textContent).toBe('');
    expect(onCount).toHaveBeenLastCalledWith(0); expect(onReady).toHaveBeenLastCalledWith(true);
  });

  it('is one quiet line while the first read is in flight, and never holds the launch', () => {
    const onCount = vi.fn(), onReady = vi.fn();
    render(<Launch port={portFor(() => new Promise<McpCatalog>(() => {}))} onCount={onCount} onReady={onReady} />);
    expect(screen.getByTestId('mcp-compact-loading').textContent).toBe('Loading connectors…');
    expect(onReady).toHaveBeenLastCalledWith(true); expect(onCount).toHaveBeenLastCalledWith(0);
  });

  it('is one error line with a retry, and never holds the launch', async () => {
    const onReady = vi.fn(); const port = portFor(() => Promise.reject(new Error('token=secret-value')));
    render(<Launch port={port} onReady={onReady} />);
    const line = await screen.findByTestId('mcp-compact-error');
    expect(line.textContent).not.toContain('secret-value');
    expect(onReady).toHaveBeenLastCalledWith(true);
    fireEvent.click(within(line).getByRole('button', { name: 'Retry connectors' }));
    await waitFor(() => expect(port.catalog).toHaveBeenCalledTimes(2));
  });

  it('draws a chip per connector with its logo, name and the account a launch would open', async () => {
    const onCount = vi.fn(); render(<Launch port={portFor(async () => catalog())} onCount={onCount} />);
    const notion = await screen.findByTestId('mcp-chip-toggle-notion');
    // On by default, so pressed, and the account is the viewer's own.
    expect(notion.getAttribute('aria-pressed')).toBe('true');
    expect(notion.textContent).toBe('NNotionWork');
    expect(screen.getByTestId('mcp-chip-toggle-docs').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('mcp-chip-toggle-docs').textContent).toBe('⧉Docs');
    // Not connected: the chip is the way to connect, not a dead switch.
    expect(within(screen.getByTestId('mcp-chip-figma')).getByRole('link', { name: 'Connect Figma' }).getAttribute('href')).toContain('/settings/connectors');
    expect(onCount).toHaveBeenLastCalledWith(3);
    expect(screen.getByTestId('mcp-compact').dataset.using).toBe('defaults');
  });

  it('switches from the effective set and resets to the Space defaults, never to a list', async () => {
    const onChange = vi.fn(); render(<Launch port={portFor(async () => catalog())} onChange={onChange} />);
    fireEvent.click(await screen.findByTestId('mcp-chip-toggle-docs'));
    expect(onChange).toHaveBeenLastCalledWith([{ serverId: 'notion' }, { serverId: 'docs' }]);
    fireEvent.click(screen.getByTestId('mcp-chip-toggle-notion'));
    expect(onChange).toHaveBeenLastCalledWith([{ serverId: 'docs' }]);
    fireEvent.click(screen.getByTestId('mcp-chip-toggle-docs'));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByTestId('mcp-compact-reset'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByTestId('mcp-compact-reset')).toBeNull();
  });

  it('sends nothing until the person changes something', async () => {
    const onChange = vi.fn(); render(<Launch port={portFor(async () => catalog())} onChange={onChange} />);
    await screen.findByTestId('mcp-chip-toggle-notion');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps what waits on an admin, and every option of the full list, one press away', async () => {
    const data = catalog(); data.servers.push(server({ id: 'linear', title: 'Linear', approved: false }));
    const onCount = vi.fn(); render(<Launch port={portFor(async () => data)} onCount={onCount} />);
    await screen.findByTestId('mcp-chip-toggle-notion');
    expect(screen.queryByTestId('mcp-chip-linear')).toBeNull();
    // Counted all the same: the picker offers it, behind the disclosure.
    expect(onCount).toHaveBeenLastCalledWith(4);
    const summary = screen.getByTestId('mcp-picker-summary');
    expect(summary.textContent).toBe('+1 more');
    fireEvent.click(summary);
    const list = screen.getByTestId('mcp-picker-toggles');
    expect(within(list).getAllByTestId('mcp-picker-toggles-row')).toHaveLength(4);
    expect(within(list).getByText('Awaiting approval')).toBeTruthy();
    expect(within(list).getByTestId('mcp-picker-toggles-none').textContent).toBe('Turn all off');
    expect(within(list).getByRole('link', { name: 'Manage connectors' })).toBeTruthy();
  });

  it('holds the launch only for a pick with no account the server will open', async () => {
    const data = catalog();
    data.servers[2]!.accounts = [{ id: 'shared', label: 'Team Figma', ownerId: 'them', canUse: true, canManage: false, status: 'connected', sharing: 'members' }];
    const onReady = vi.fn(); render(<Launch port={portFor(async () => data)} onReady={onReady} />);
    fireEvent.click(await screen.findByTestId('mcp-chip-toggle-figma'));
    expect(onReady).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('alert').textContent).toBe('Choose an account for Figma: a connection shared with you is used only when you pick it.');
    expect(screen.getByTestId('mcp-chip-toggle-figma').textContent).toContain('Choose account');
    fireEvent.change(screen.getByTestId('mcp-chip-account-figma'), { target: { value: 'shared' } });
    expect(onReady).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('mcp-chip-toggle-figma').textContent).toContain('Team Figma');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says on the chip that an ON default with a broken account will not reach the session', async () => {
    const data = catalog(); data.servers[0]!.accounts = [{ ...mine, status: 'needs_reconnect', canUse: false }];
    const onReady = vi.fn(); render(<Launch port={portFor(async () => data)} onReady={onReady} />);
    const notion = await screen.findByTestId('mcp-chip-toggle-notion');
    expect(notion.textContent).toContain('Reconnect');
    expect(notion.getAttribute('title')).toBe('Needs reconnect. On, but it will not reach this session until this is fixed.');
    // A default is the server's to skip (§7.3): the launch is not held.
    expect(onReady).toHaveBeenLastCalledWith(true);
  });

  it('draws a reopened card from the scope’s last-known catalog on the first frame, then revalidates', async () => {
    let answer = catalog();
    let release: (value: McpCatalog) => void = () => {};
    const port = portFor(() => new Promise<McpCatalog>(resolve => { release = resolve; }));
    const first = render(<Launch port={port} />);
    await act(async () => { release(answer); });
    await screen.findByTestId('mcp-chip-toggle-notion');
    first.unmount();

    const onCount = vi.fn();
    render(<Launch port={port} onCount={onCount} />);
    // First frame: the chips, not the loading line, while the second read is in flight.
    expect(screen.getByTestId('mcp-chip-toggle-notion')).toBeTruthy();
    expect(screen.queryByTestId('mcp-compact-loading')).toBeNull();
    expect(onCount).toHaveBeenCalledWith(3);
    expect(port.catalog).toHaveBeenCalledTimes(2);
    answer = catalog(); answer.servers = answer.servers.filter(s => s.id !== 'docs');
    await act(async () => { release(answer); });
    await waitFor(() => expect(screen.queryByTestId('mcp-chip-docs')).toBeNull());
    expect(onCount).toHaveBeenLastCalledWith(2);
    cleanup();

    // Another task is another scope: its defaults are not this one's.
    render(<Launch port={port} targetId="other-task" />);
    expect(screen.getByTestId('mcp-compact-loading')).toBeTruthy();
  });
});
