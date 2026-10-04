// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpProvider } from './context';
import { McpPicker } from './McpPicker';
import { McpSettings } from './McpSettings';
import { McpEquipment } from './McpEquipment';
import type { McpCatalog, McpPort, McpSelection } from './port';
afterEach(cleanup);
const catalog = (): McpCatalog => ({ canRegister: true, canAttach: true, defaults: [], servers: [{
  id: 'server', version: 1, title: 'Calendar', description: 'Read events', transport: 'http', url: 'https://calendar.example/mcp',
  auth: 'api_key', approved: true, enabled: true, canManage: true, canAttach: true,
  accounts: [{ id: 'account', label: 'Work account', canUse: true, canManage: true, status: 'connected', sharing: 'private' }],
}] });
function fixture(data = catalog()): McpPort {
  return { catalog: vi.fn(async () => data), register: vi.fn(), update: vi.fn(), remove: vi.fn(), importConfig: vi.fn(), attach: vi.fn(), detach: vi.fn(),
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
  it('requires an explicit account and distinguishes defaults from none', async () => {
    const onReady = vi.fn(), onChange = vi.fn(); render(<Picker port={fixture()} onReady={onReady} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Calendar/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ serverId: 'server' }]); expect(onReady).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByRole('combobox', { name: 'Account for Calendar' }), { target: { value: 'account' } });
    expect(onChange).toHaveBeenLastCalledWith([{ serverId: 'server', credentialId: 'account' }]); expect(onReady).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'None' })); expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: 'Use defaults' })); expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
  it('shows unconnected servers unavailable with a connection route', async () => {
    const data = catalog(); data.servers[0]!.accounts[0]!.canUse = false; render(<Picker port={fixture(data)} />);
    expect((await screen.findByRole('checkbox', { name: /Calendar/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Connect Calendar' }).getAttribute('href')).toContain('/settings/connectors');
  });
  it('hides controls without attachment permission', async () => {
    const data = catalog(); data.canAttach = false; const port = fixture(data); render(<Picker port={port} />);
    await waitFor(() => expect(port.catalog).toHaveBeenCalled()); expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('blocks unresolved defaults and allows disabling them', async () => {
    const data = catalog(); data.defaults = [{ serverId: 'server' }]; const onReady = vi.fn(); render(<Picker port={fixture(data)} onReady={onReady} />);
    await screen.findByRole('combobox'); expect(onReady).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'None' })); expect(onReady).toHaveBeenLastCalledWith(true);
  });
  it('does not expose an upstream secret-bearing error', async () => {
    const port = fixture(); port.catalog = vi.fn().mockRejectedValue(new Error('token=secret-value')); render(<Picker port={port} />);
    await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('secret-value');
  });
});
describe('native MCP management', () => {
  it('tests with the selected account and displays discovered tools', async () => {
    const port = fixture(); render(<McpProvider port={port}><McpSettings /></McpProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Calendar' }));
    expect((screen.getByRole('button', { name: 'Test and discover tools' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Test with account' }), { target: { value: 'account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and discover tools' })); await screen.findByText('list_events');
    expect(port.test).toHaveBeenCalledWith({ serverId: 'server', credentialId: 'account' });
  });
  it('clears passwords before sending and renders errors without secret text', async () => {
    const port = fixture(); port.createKey = vi.fn().mockRejectedValue(new Error('never-display-secret'));
    render(<McpProvider port={port}><McpSettings /></McpProvider>); fireEvent.click(await screen.findByRole('button', { name: 'Manage Calendar' }));
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } });
    const secret = screen.getByLabelText('API key') as HTMLInputElement; fireEvent.change(secret, { target: { value: 'fixture-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add private account' })); expect(secret.value).toBe('');
    expect(port.createKey).toHaveBeenCalledWith('server', 'Personal', 'fixture-secret'); await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('never-display-secret');
  });
  it('requires confirmation for revocation', async () => {
    const port = fixture(); render(<McpProvider port={port}><McpSettings /></McpProvider>); fireEvent.click(await screen.findByRole('button', { name: 'Manage Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke account' })); expect(port.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' })); await waitFor(() => expect(port.revoke).toHaveBeenCalledWith('server', 'account'));
  });
  it('requires code trust before local command registration', async () => {
    render(<McpProvider port={fixture()}><McpSettings /></McpProvider>); fireEvent.click(await screen.findByRole('button', { name: 'Add connector' }));
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
  it('blocks a revoked explicitly selected default account', async () => {
    const data = catalog(); data.defaults = [{serverId:'server',credentialId:'account'}];
    data.servers[0]!.accounts[0]!.status='revoked'; data.servers[0]!.accounts[0]!.canUse=false;
    const onReady=vi.fn(); render(<Picker port={fixture(data)} onReady={onReady}/>);
    await screen.findByRole('alert'); expect(onReady).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('option',{name:'Work account'})).toBeNull();
  });
  it('preserves sharing selection and offers the named member after loading', async () => {
    const port=fixture(); render(<McpProvider port={port}><McpSettings/></McpProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Manage Calendar'}));
    fireEvent.change(screen.getByRole('combobox',{name:'Account sharing'}),{target:{value:'members'}});
    fireEvent.click(await screen.findByRole('checkbox',{name:'Ada'}));
    fireEvent.click(screen.getByRole('button',{name:'Save sharing'}));
    await waitFor(()=>expect(port.share).toHaveBeenCalledWith('server','account','members',['member']));
  });
  it('offers recovery when a previously ready account expires during testing', async () => {
    const port=fixture(); port.test=vi.fn(async()=>({ok:false,message:'credential_expired',tools:[]}));
    render(<McpProvider port={port}><McpSettings/></McpProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Manage Calendar'}));
    fireEvent.change(screen.getByRole('combobox',{name:'Test with account'}),{target:{value:'account'}});
    fireEvent.click(screen.getByRole('button',{name:'Test and discover tools'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Reconnect an account');
    expect(screen.queryByText('Connection tested.')).toBeNull();
  });
});

it('refreshes a mounted launch picker immediately after revocation elsewhere in the provider', async () => {
  const data=catalog(); data.defaults=[{serverId:'server',credentialId:'account'}];
  const port=fixture(data); port.revoke=vi.fn(async()=>{data.servers[0]!.accounts[0]!.canUse=false;data.servers[0]!.accounts[0]!.status='revoked';});
  const onReady=vi.fn();
  render(<McpProvider port={port}><McpSettings/><McpPicker value={undefined} onChange={()=>{}} onReady={onReady}/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Manage Calendar'}));
  await waitFor(()=>expect(onReady).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button',{name:'Revoke account'}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm revoke'}));
  await waitFor(()=>expect(onReady).toHaveBeenLastCalledWith(false));
  await screen.findByRole('link',{name:'Connect Calendar'});
});
it('loads already shared member names when an account is reopened', async()=>{
  const data=catalog(); data.servers[0]!.accounts[0]!.sharing='members'; data.servers[0]!.accounts[0]!.memberIds=['member'];
  render(<McpProvider port={fixture(data)}><McpSettings/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Manage Calendar'}));
  expect((await screen.findByRole('checkbox',{name:'Ada'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'All connectors'}));
  fireEvent.click(screen.getByRole('button',{name:'Manage Calendar'}));
  expect((await screen.findByRole('checkbox',{name:'Ada'}) as HTMLInputElement).checked).toBe(true);
});
it('shows owner and use-only access without management controls',async()=>{
  const data=catalog(); data.servers[0]!.accounts[0]!.canManage=false; data.servers[0]!.accounts[0]!.ownerId='owner'; data.servers[0]!.accounts[0]!.ownerLabel='Pat';
  render(<McpProvider port={fixture(data)}><McpSettings/></McpProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Manage Calendar'}));
  expect(screen.getByText('Owner: Pat')).toBeTruthy();
  expect(screen.getByText(/Its owner manages sharing/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Revoke account'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Rotate key'})).toBeNull();
});

it('allows removing a disabled connector from task defaults',async()=>{
  const data=catalog();data.attachedServerIds=['server'];data.servers[0]!.enabled=false;data.servers[0]!.canAttach=false;
  const port=fixture(data);render(<McpProvider port={port}><McpEquipment targetId="task"/></McpProvider>);
  fireEvent.click(await screen.findByRole('checkbox',{name:'Calendar · Disabled'}));
  await waitFor(()=>expect(port.detach).toHaveBeenCalledWith('task','server'));
});
