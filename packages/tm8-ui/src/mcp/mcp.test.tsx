// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { McpProvider } from './context';
import { McpPicker } from './McpPicker';
import { McpSettings } from './McpSettings';
import { McpEquipment } from './McpEquipment';
import type { McpCatalog, McpPort, McpSelection } from './port';
afterEach(cleanup);
/** The row drawer. Its Connect/Reconnect buttons share a name with the table row's, by design: §10.0 gives one status one verb wherever it is drawn. */
const drawer = () => within(screen.getByLabelText('Calendar connector'));
const catalog = (): McpCatalog => ({ canRegister: true, canAttach: true, defaults: [], servers: [{
  id: 'server', version: 1, title: 'Calendar', description: 'Read events', transport: 'http', url: 'https://calendar.example/mcp',
  auth: 'api_key', approved: true, enabled: true, canManage: true, canAttach: true,
  accounts: [{ id: 'account', label: 'Work account', canUse: true, canManage: true, status: 'connected', sharing: 'private' }],
}] });
function fixture(data = catalog()): McpPort {
  return { catalog: vi.fn(async () => data), register: vi.fn(), update: vi.fn(), remove: vi.fn(), importConfig: vi.fn(), importMany: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    catalogEntries: vi.fn(async () => []), addFromCatalog: vi.fn(async () => ({ serverId: 'server', adopted: false })), request: vi.fn(), patch: vi.fn(),
    test: vi.fn(async () => ({ ok: true, message: 'Connected', tools: [{ name: 'list_events' }] })),
    createKey: vi.fn(), rotateKey: vi.fn(), startOAuth: vi.fn(async () => ({ authorizationUrl: 'https://identity.example/authorize' })),
    share: vi.fn(), revoke: vi.fn(), members: vi.fn(async () => [{ id: 'member', label: 'Ada' }]),
  };
}
function Picker({ port, onReady = vi.fn(), onChange = vi.fn() }: { port: McpPort; onReady?: (value: boolean) => void; onChange?: (value: McpSelection[] | undefined) => void }) {
  const [value, setValue] = useState<McpSelection[] | undefined>();
  return <McpProvider port={port}><McpPicker value={value} onChange={next => { onChange(next); setValue(next); }} onReady={onReady} /></McpProvider>;
}
describe('native MCP picker', () => {
  /*
   * An explicit pick with NO pin is sendable when the viewer has their own
   * connection: `bind` opens it by §3's order (`resolve_mcp_account`). This
   * cell used to expect `onReady(false)` here, which held a launch the server
   * would have run until the person pinned the only account there was.
   */
  it('sends an unpinned pick the viewer has an account for, pins one on request, and distinguishes defaults from none', async () => {
    const onReady = vi.fn(), onChange = vi.fn(); render(<Picker port={fixture()} onReady={onReady} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Calendar/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ serverId: 'server' }]); expect(onReady).toHaveBeenLastCalledWith(true, null);
    fireEvent.change(screen.getByRole('combobox', { name: 'Account for Calendar' }), { target: { value: 'account' } });
    expect(onChange).toHaveBeenLastCalledWith([{ serverId: 'server', credentialId: 'account' }]); expect(onReady).toHaveBeenLastCalledWith(true, null);
    fireEvent.click(screen.getByRole('button', { name: 'Turn all off' })); expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' })); expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
  it('shows unconnected servers unavailable with a connection route', async () => {
    const data = catalog(); data.servers[0]!.accounts[0]!.canUse = false; render(<Picker port={fixture(data)} />);
    expect((await screen.findByRole('switch', { name: /Calendar/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Connect Calendar' }).getAttribute('href')).toContain('/settings/connectors');
  });
  it('hides controls without attachment permission', async () => {
    const data = catalog(); data.canAttach = false; const port = fixture(data); render(<Picker port={port} />);
    await waitFor(() => expect(port.catalog).toHaveBeenCalled()); expect(screen.queryByRole('switch')).toBeNull();
  });
  /*
   * G15 / §5.3 (S22). An UNRESOLVED DEFAULT IS THE SERVER'S TO SKIP.
   *
   * This cell used to assert the opposite: `onChange([])`, the picker rewriting
   * "the user chose nothing" into an explicit empty list because the browser
   * could see no connected account. The rule is that the field is sent only
   * when the user changed something, so the launch omits it and the server
   * resolves defaults under the provenance root's own claims and reports the
   * ones it cannot open as `skipped: not connected`. A connector connected
   * between page load and launch was silently lost to the old behaviour.
   *
   * The default here names the connector and no ACCOUNT, which the old
   * `readiness` read as a problem. It is not one: §3's order resolves the
   * account server-side (the pin, then the root's own connection, then the
   * Space's shared one), so there is nothing for the launch to block on and
   * nothing for the picker to warn about.
   */
  it('leaves an unresolved default to the server instead of sending a trimmed list', async () => {
    const data = catalog(); data.defaults = [{ serverId: 'server' }]; const onReady = vi.fn(), onChange = vi.fn();
    render(<Picker port={fixture(data)} onReady={onReady} onChange={onChange} />);
    await screen.findByRole('switch', { name: /Calendar/ });
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true, null));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('mcp-picker-toggles-using').textContent).toBe('Using: Space defaults');
    expect(screen.queryByRole('alert')).toBeNull();
    // Shown as on and awaiting an account, not hidden and not warned about.
    expect((screen.getByRole('switch', { name: /Calendar/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('combobox', { name: /Account for Calendar/ }) as HTMLSelectElement).value).toBe('');
  });
  it('sends nothing at all when only some defaults are connected', async () => {
    const data = catalog(); data.servers.push({ ...data.servers[0]!, id: 'open', title: 'Docs', auth: 'none', accounts: [] });
    data.defaults = [{ serverId: 'server' }, { serverId: 'open' }]; const onChange = vi.fn(), onReady = vi.fn();
    render(<Picker port={fixture(data)} onReady={onReady} onChange={onChange} />);
    await screen.findByRole('switch', { name: /Docs/ });
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true, null));
    // The old behaviour sent `[{serverId:'open'}]` — a list the user never
    // chose, which would ALSO have pinned the thread or session to it.
    expect(onChange).not.toHaveBeenCalled();
  });
  it('renders nothing and stays ready when no connectors are registered', async () => {
    const data = catalog(); data.servers = []; const port = fixture(data), onReady = vi.fn(); render(<Picker port={port} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true, null));
    expect(document.body.textContent).toBe(''); expect(screen.queryByRole('group')).toBeNull();
  });
  it('does not show a loading placeholder', async () => {
    const port = fixture(); port.catalog = vi.fn(() => new Promise<McpCatalog>(() => {})); render(<Picker port={port} />);
    await waitFor(() => expect(port.catalog).toHaveBeenCalled()); expect(document.body.textContent).toBe('');
  });
  it('does not expose an upstream secret-bearing error or block the launch on it', async () => {
    const port = fixture(); port.catalog = vi.fn().mockRejectedValue(new Error('token=secret-value')); const onReady = vi.fn(); render(<Picker port={port} onReady={onReady} />);
    await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('secret-value'); expect(onReady).toHaveBeenLastCalledWith(true, null);
  });
});
describe('native MCP management', () => {
  it('uses the shared settings scroller so account actions remain reachable', async () => {
    const data = catalog();
    data.servers[0]!.auth = 'oauth';
    data.servers[0]!.accounts = [];
    const { container } = render(<McpProvider port={fixture(data)}><McpSettings /></McpProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Calendar' }));
    fireEvent.click(drawer().getByRole('button', { name: 'Connect' }));

    const scroll = screen.getByTestId('connectors-body');
    expect(container.querySelectorAll('.set-section')).toHaveLength(1);
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
    expect(scroll.contains(screen.getByRole('button', { name: 'Continue to sign-in' }))).toBe(true);
    expect(screen.getAllByText('Connectors')).toHaveLength(1);
  });

  it('tests with the connection it would use and displays discovered tools', async () => {
    const port = fixture(); render(<McpProvider port={port}><McpSettings /></McpProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' })); await screen.findByText('list_events');
    expect(port.test).toHaveBeenCalledWith({ serverId: 'server', credentialId: 'account' });
  });
  it('cannot test a connector that needs an account and has no usable one', async () => {
    const data = catalog(); data.servers[0]!.accounts[0]!.canUse = false;
    render(<McpProvider port={fixture(data)}><McpSettings /></McpProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Calendar' }));
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('clears passwords before sending and renders errors without secret text', async () => {
    const port = fixture(); port.createKey = vi.fn().mockRejectedValue(new Error('never-display-secret'));
    render(<McpProvider port={port}><McpSettings /></McpProvider>); fireEvent.click(await screen.findByRole('button', { name: 'Open Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add another account' }));
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } });
    const secret = screen.getByLabelText('API key') as HTMLInputElement; fireEvent.change(secret, { target: { value: 'fixture-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' })); expect(secret.value).toBe('');
    expect(port.createKey).toHaveBeenCalledWith('server', 'Personal', 'fixture-secret', 'member'); await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('never-display-secret');
  });
  it('requires confirmation for a disconnect', async () => {
    const port = fixture(); render(<McpProvider port={port}><McpSettings /></McpProvider>); fireEvent.click(await screen.findByRole('button', { name: 'Open Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); expect(port.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' })); await waitFor(() => expect(port.revoke).toHaveBeenCalledWith('server', 'account'));
  });
  it('requires code trust before local command registration', async () => {
    render(<McpProvider port={fixture()}><McpSettings /></McpProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Custom connector…' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Connection' }), { target: { value: 'stdio' } });
    expect((screen.getByRole('button', { name: 'Register connector' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I trust this command/ }));
    expect((screen.getByRole('button', { name: 'Register connector' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('does not claim an attachment succeeded after rejection', async () => {
    const port = fixture(); port.attach = vi.fn().mockRejectedValue(new Error('denied'));
    render(<McpProvider port={port}><McpEquipment targetId="task" /></McpProvider>); fireEvent.click(await screen.findByRole('checkbox', { name: 'Calendar' }));
    await screen.findByRole('alert'); expect(port.attach).toHaveBeenCalledWith('task', 'server');
    expect((screen.getByRole('checkbox', { name: 'Calendar' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('MCP readiness and recovery', () => {
  it('does not block the launch on a revoked default account (the server skips it)', async () => {
    const data = catalog(); data.defaults = [{serverId:'server',credentialId:'account'}];
    data.servers[0]!.accounts[0]!.status='revoked'; data.servers[0]!.accounts[0]!.canUse=false;
    const onReady=vi.fn(), onChange=vi.fn(); render(<Picker port={fixture(data)} onReady={onReady} onChange={onChange}/>);
    // §10.0: a revoked connection reads [Reconnect].
    await screen.findByRole('link',{name:'Reconnect Calendar'});
    await waitFor(()=>expect(onReady).toHaveBeenLastCalledWith(true, null));
    // S22: the revoked default is dropped by the SERVER's resolution, not by
    // the browser sending a shorter list.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('option',{name:'Work account'})).toBeNull();
  });
  it('still blocks an explicitly ticked connector until an account is chosen, when only a pin can open one', async () => {
    // The one account is ANOTHER member's, shared with the viewer: §3 never
    // picks a share by itself, so the server would refuse the unpinned pick.
    const data = catalog(); data.servers[0]!.accounts[0] = { ...data.servers[0]!.accounts[0]!, ownerId: 'someone', canManage: false, sharing: 'members' };
    const onReady = vi.fn(); render(<Picker port={fixture(data)} onReady={onReady} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Calendar/ }));
    expect(onReady).toHaveBeenLastCalledWith(false, 'Choose an account for Calendar: a connection shared with you is used only when you pick it.');
    expect(screen.getByRole('alert').textContent).toBe('Choose an account for Calendar: a connection shared with you is used only when you pick it.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Account for Calendar' }), { target: { value: 'account' } });
    expect(onReady).toHaveBeenLastCalledWith(true, null); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('preserves sharing selection and offers the named member after loading', async () => {
    const port=fixture(); render(<McpProvider port={port}><McpSettings/></McpProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Open Calendar'}));
    fireEvent.change(screen.getByRole('combobox',{name:'Account sharing'}),{target:{value:'members'}});
    fireEvent.click(await screen.findByRole('checkbox',{name:'Ada'}));
    fireEvent.click(screen.getByRole('button',{name:'Save sharing'}));
    await waitFor(()=>expect(port.share).toHaveBeenCalledWith('server','account','members',['member']));
  });
  it('offers recovery when a previously ready account expires during testing', async () => {
    const port=fixture(); port.test=vi.fn(async()=>({ok:false,message:'credential_expired',tools:[]}));
    render(<McpProvider port={port}><McpSettings/></McpProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Open Calendar'}));
    fireEvent.click(screen.getByRole('button',{name:'Test connection'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Reconnect an account');
    expect(screen.queryByText('Connection tested.')).toBeNull();
  });
});

it('refreshes a mounted launch picker immediately after revocation elsewhere in the provider', async () => {
  const data=catalog(); data.defaults=[{serverId:'server',credentialId:'account'}];
  const port=fixture(data); port.revoke=vi.fn(async()=>{data.servers[0]!.accounts[0]!.canUse=false;data.servers[0]!.accounts[0]!.status='revoked';});
  const onReady=vi.fn();
  render(<McpProvider port={port}><McpSettings/><McpPicker value={undefined} onChange={()=>{}} onReady={onReady}/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Open Calendar'}));
  await waitFor(()=>expect(onReady).toHaveBeenLastCalledWith(true, null));
  fireEvent.click(screen.getByRole('button',{name:'Disconnect'}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm disconnect'}));
  // S22: a DEFAULT losing its account does not block the launch — the server
  // skips it and reports "not connected". What must still happen immediately is
  // the picker reflecting the revocation, which is the reconnect link below
  // (§10.0: a revoked connection reads Reconnect, not Connect).
  await screen.findByRole('link',{name:'Reconnect Calendar'});
  await waitFor(()=>expect(onReady).toHaveBeenLastCalledWith(true, null));
  expect(screen.queryByRole('button',{name:'Confirm disconnect'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Rotate key'})).toBeNull();
  expect(screen.getByText(/You haven.t connected an account here/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'Connect'})).toBeTruthy();
});
it('loads already shared member names when an account is reopened', async()=>{
  const data=catalog(); data.servers[0]!.accounts[0]!.sharing='members'; data.servers[0]!.accounts[0]!.memberIds=['member'];
  render(<McpProvider port={fixture(data)}><McpSettings/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Open Calendar'}));
  expect((await screen.findByRole('checkbox',{name:'Ada'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Close connector details'}));
  fireEvent.click(screen.getByRole('button',{name:'Open Calendar'}));
  expect((await screen.findByRole('checkbox',{name:'Ada'}) as HTMLInputElement).checked).toBe(true);
});
it('shows owner and use-only access without management controls',async()=>{
  const data=catalog(); data.servers[0]!.accounts[0]!.canManage=false; data.servers[0]!.accounts[0]!.ownerId='owner'; data.servers[0]!.accounts[0]!.ownerLabel='Pat';
  render(<McpProvider port={fixture(data)}><McpSettings/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Open Calendar'}));
  expect(screen.getByText(/shared with you by Pat/)).toBeTruthy();
  expect(screen.getByText(/Its owner manages it/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Disconnect'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Rotate key'})).toBeNull();
});

it('allows removing a disabled connector from task defaults',async()=>{
  const data=catalog();data.attachedServerIds=['server'];data.servers[0]!.enabled=false;data.servers[0]!.canAttach=false;
  const port=fixture(data);render(<McpProvider port={port}><McpEquipment targetId="task"/></McpProvider>);
  fireEvent.click(await screen.findByRole('checkbox',{name:'Calendar · Disabled'}));
  await waitFor(()=>expect(port.detach).toHaveBeenCalledWith('task','server'));
});

it('blocks a changed connector account and offers reconnect without key rotation', async () => {
  const data=catalog(); data.defaults=[{serverId:'server',credentialId:'account'}];
  data.servers[0]!.accounts[0]!.status='credential_definition_changed';
  data.servers[0]!.accounts[0]!.canUse=false;
  const onReady=vi.fn();
  render(<McpProvider port={fixture(data)}><McpSettings/><McpPicker value={undefined} onChange={()=>{}} onReady={onReady}/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Open Calendar'}));
  expect(screen.getAllByText(/Connector settings changed by an admin/).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button',{name:'Rotate key'})).toBeNull();
  // §10.0: a changed definition offers RECONNECT, not a key rotation.
  expect(drawer().getByRole('button',{name:'Reconnect'}).hasAttribute('disabled')).toBe(false);
  // S22, as above: a default whose account changed under it is the server's to
  // skip, so the launch stays ready and the UI offers the reconnect.
  await waitFor(()=>expect(onReady).toHaveBeenLastCalledWith(true, null));
  expect(screen.getByRole('link',{name:'Reconnect Calendar'})).toBeTruthy();
});
