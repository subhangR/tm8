// @vitest-environment jsdom
/**
 * The catalog read's phases, as each kind of reader must see them: a launch
 * picker keeps what it showed when a re-read fails; a management surface shows
 * the error and holds no stale catalog; an explicit pick is never judged
 * against a last-known photograph; and an older read never overwrites a newer
 * one's last-known copy.
 */
import { useState } from 'react';
import { CollabError } from '@tm8/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { ChatConnectorsSheet } from '../chat-home/composer/ChatConnectors';
import { McpProvider } from './context';
import { McpEquipment } from './McpEquipment';
import { McpPicker } from './McpPicker';
import { McpSettings } from './McpSettings';
import type { McpCatalog, McpPort, McpSelection, McpServer } from './port';
afterEach(cleanup);

const server = (over: Partial<McpServer> & { id: string; title: string }): McpServer => ({
  version: 1, description: '', transport: 'http', url: `https://${over.id}.example/mcp`, auth: 'none',
  approved: true, enabled: true, canManage: true, canAttach: true, accounts: [], ...over,
});
const catalog = (): McpCatalog => ({ canRegister: true, canAttach: true, defaults: [], attachedServerIds: [],
  servers: [server({ id: 'docs', title: 'Docs' })] });
/** Answers once, then fails every read after. */
function failingAfterFirst(): McpPort {
  let reads = 0;
  return { catalog: vi.fn(async () => { reads += 1; if (reads > 1) throw new Error('down'); return catalog(); }),
    catalogEntries: vi.fn(async () => []) } as unknown as McpPort;
}
const refocus = () => act(async () => { window.dispatchEvent(new Event('focus')); });

describe('a re-read that fails, on a management surface', () => {
  it('McpEquipment drops the stale rows and says so', async () => {
    render(<McpProvider port={failingAfterFirst()}><McpEquipment targetId="task" /></McpProvider>);
    await screen.findByText(/Docs/);
    await refocus();
    expect((await screen.findByRole('alert')).textContent).toContain('Connectors could not be loaded');
    expect(screen.queryByText(/Docs/)).toBeNull();
  });
  it('the chat sheet shows its error instead of stale switches', async () => {
    const state = { value: undefined, change: vi.fn(), busy: false, error: null, unreadable: false, available: true };
    render(<McpProvider port={failingAfterFirst()}><ChatConnectorsSheet state={state} teamMemberId="teammate" /></McpProvider>);
    await screen.findByTestId('tch-connectors');
    await refocus();
    await screen.findByTestId('tch-connectors-error');
    expect(screen.queryByTestId('tch-connectors')).toBeNull();
  });
  it('the Connectors table shows its error and holds no stale server version to act on', async () => {
    render(<McpProvider port={failingAfterFirst()}><McpSettings /></McpProvider>);
    await screen.findByRole('button', { name: 'Open Docs' });
    await refocus();
    await waitFor(() => expect(screen.getAllByRole('alert').some(a => a.textContent?.includes('Couldn’t load connectors'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Open Docs' })).toBeNull();
  });
});

describe('a launch picker over the last-known photograph', () => {
  function Launch({ port, initial, onReady }: { port: McpPort; initial?: McpSelection[]; onReady(ready: boolean, problem: string | null): void }) {
    const [value, setValue] = useState<McpSelection[] | undefined>(initial);
    return <McpProvider port={port}><McpPicker layout="compact" targetId="task" value={value} onChange={setValue} onReady={onReady} /></McpProvider>;
  }
  it('holds an EXPLICIT pick with "Checking connectors…" until its own read answers; an untouched one never waits', async () => {
    let release: (value: McpCatalog) => void = () => {};
    const port = { catalog: vi.fn(() => new Promise<McpCatalog>(resolve => { release = resolve; })) } as unknown as McpPort;
    const first = render(<Launch port={port} onReady={vi.fn()} />);
    await act(async () => { release(catalog()); });
    first.unmount();

    const untouched = vi.fn();
    const second = render(<Launch port={port} onReady={untouched} />);
    expect(untouched).toHaveBeenLastCalledWith(true, null);
    second.unmount();

    const explicit = vi.fn();
    render(<Launch port={port} initial={[{ serverId: 'docs' }]} onReady={explicit} />);
    expect(screen.getByTestId('mcp-chip-toggle-docs')).toBeTruthy();
    expect(explicit).toHaveBeenLastCalledWith(false, 'Checking connectors…');
    await act(async () => { release(catalog()); });
    expect(explicit).toHaveBeenLastCalledWith(true, null);
  });

  it('never lets an older read overwrite a newer one’s last-known copy', async () => {
    const releases: ((value: McpCatalog) => void)[] = [];
    const port = { catalog: vi.fn(() => new Promise<McpCatalog>(resolve => { releases.push(resolve); })) } as unknown as McpPort;
    const old = render(<Launch port={port} onReady={vi.fn()} />);
    old.unmount();
    const newer = render(<Launch port={port} onReady={vi.fn()} />);
    newer.unmount();
    const fresh = catalog(); fresh.servers = [server({ id: 'fresh', title: 'Fresh' })];
    await act(async () => { releases[1]!(fresh); });
    await act(async () => { releases[0]!(catalog()); });
    render(<Launch port={port} onReady={vi.fn()} />);
    expect(screen.getByTestId('mcp-chip-toggle-fresh')).toBeTruthy();
    expect(screen.queryByTestId('mcp-chip-toggle-docs')).toBeNull();
  });
});

describe('round 3: failures over a seed, and what they forget', () => {
  function Launch({ port, initial, onReady = vi.fn(), onCount = vi.fn() }: { port: McpPort; initial?: McpSelection[]; onReady?(ready: boolean, problem: string | null): void; onCount?(n: number): void }) {
    const [value, setValue] = useState<McpSelection[] | undefined>(initial);
    return <McpProvider port={port}><McpPicker layout="compact" targetId="task" value={value} onChange={setValue} onReady={onReady} onCount={onCount} /></McpProvider>;
  }
  /** Answers the first read, then does what `next` says for every read after. */
  function scripted(next: () => Promise<McpCatalog>): McpPort {
    let reads = 0;
    return { catalog: vi.fn(() => (++reads === 1 ? Promise.resolve(catalog()) : next())) } as unknown as McpPort;
  }

  it('a seeded explicit pick whose read FAILS is judged on the kept catalog, with Retry — not stuck on Checking', async () => {
    const port = scripted(() => Promise.reject(new Error('down')));
    const first = render(<Launch port={port} />);
    await screen.findByTestId('mcp-chip-toggle-docs');
    first.unmount();
    const onReady = vi.fn();
    render(<Launch port={port} initial={[{ serverId: 'docs' }]} onReady={onReady} />);
    expect(onReady).toHaveBeenLastCalledWith(false, 'Checking connectors…');
    await screen.findByTestId('mcp-picker-error');
    expect(onReady).toHaveBeenLastCalledWith(true, null);
    expect(screen.getByRole('button', { name: 'Retry connectors' })).toBeTruthy();
  });

  it('forgets a copy no mount confirmed when its read fails, so a dead target stops seeding', async () => {
    const port = scripted(() => Promise.reject(new CollabError('forbidden', 'MCP defaults target is unavailable')));
    const first = render(<Launch port={port} />);
    await screen.findByTestId('mcp-chip-toggle-docs');
    first.unmount();
    const second = render(<Launch port={port} />);
    expect(screen.getByTestId('mcp-chip-toggle-docs')).toBeTruthy();   // seeded
    await screen.findByTestId('mcp-picker-error');                       // never confirmed: forgotten
    second.unmount();
    render(<Launch port={port} />);
    expect(screen.getByTestId('mcp-compact-loading')).toBeTruthy();
  });

  it('keeps a copy this mount confirmed when a RE-read fails', async () => {
    const port = scripted(() => Promise.reject(new Error('blip')));
    const first = render(<Launch port={port} />);
    await screen.findByTestId('mcp-chip-toggle-docs');
    await refocus();
    await screen.findByTestId('mcp-picker-error');
    first.unmount();
    render(<Launch port={port} />);
    expect(screen.getByTestId('mcp-chip-toggle-docs')).toBeTruthy();
  });

  it('draws and counts the error line even when the kept catalog draws nothing', async () => {
    let reads = 0;
    const empty = catalog(); empty.servers = [];
    const port = { catalog: vi.fn(() => (++reads === 1 ? Promise.resolve(empty) : Promise.reject(new Error('down')))) } as unknown as McpPort;
    const onCount = vi.fn();
    render(<Launch port={port} onCount={onCount} />);
    await waitFor(() => expect(port.catalog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0));
    await refocus();
    await screen.findByTestId('mcp-picker-error');
    expect(onCount).toHaveBeenLastCalledWith(1);
  });
});

describe('round 4', () => {
  function Launch({ port, initial, onReady = vi.fn(), disabled = false }: { port: McpPort; initial?: McpSelection[]; onReady?(ready: boolean, problem: string | null): void; disabled?: boolean }) {
    const [value, setValue] = useState<McpSelection[] | undefined>(initial);
    return <McpProvider port={port}><McpPicker layout="compact" targetId="task" value={value} onChange={setValue} onReady={onReady} disabled={disabled} /></McpProvider>;
  }
  function seededPort(after: () => Promise<McpCatalog>, first: McpCatalog = catalog()): McpPort {
    let reads = 0;
    return { catalog: vi.fn(() => (++reads === 1 ? Promise.resolve(first) : after())) } as unknown as McpPort;
  }
  async function seed(port: McpPort) {
    const first = render(<Launch port={port} />);
    await waitFor(() => expect(port.catalog).toHaveBeenCalledTimes(1));
    await act(async () => {});
    first.unmount();
  }

  it('keeps an earlier mount’s copy when a reopen’s read only blips (5xx, network)', async () => {
    const port = seededPort(() => Promise.reject(new Error('502')));
    await seed(port);
    const second = render(<Launch port={port} />);
    await screen.findByTestId('mcp-picker-error');
    second.unmount();
    render(<Launch port={port} />);
    expect(screen.getByTestId('mcp-chip-toggle-docs')).toBeTruthy();
  });

  it('never holds [] on Checking — bind cannot refuse "no connectors"', async () => {
    const port = seededPort(() => new Promise<McpCatalog>(() => {}));
    await seed(port);
    const onReady = vi.fn();
    render(<Launch port={port} initial={[]} onReady={onReady} />);
    expect(onReady).toHaveBeenLastCalledWith(true, null);
  });

  it('says Checking as a quiet status, never as an alert', async () => {
    const port = seededPort(() => new Promise<McpCatalog>(() => {}));
    await seed(port);
    render(<Launch port={port} initial={[{ serverId: 'docs' }]} />);
    expect(screen.getByTestId('mcp-compact-checking').getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the gate for a viewer who may not attach — there is no switch to name', async () => {
    const closed = catalog(); closed.canAttach = false;
    const onReady = vi.fn();
    render(<Launch port={{ catalog: vi.fn(async () => closed) } as unknown as McpPort} initial={[{ serverId: 'gone' }]} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    await act(async () => {});
    expect(onReady).toHaveBeenLastCalledWith(true, null);
  });

  it('does not navigate away from a launch in flight through a Connect chip', async () => {
    const data = catalog(); data.servers.push(server({ id: 'figma', title: 'Figma', auth: 'oauth' }));
    render(<Launch port={{ catalog: vi.fn(async () => data) } as unknown as McpPort} disabled />);
    const chip = await screen.findByTestId('mcp-chip-figma');
    expect(chip.querySelector('a')).toBeNull();
    expect(within(chip).getByLabelText('Connect Figma').getAttribute('aria-disabled')).toBe('true');
  });
});
