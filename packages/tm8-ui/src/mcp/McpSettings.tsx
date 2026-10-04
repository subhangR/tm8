import { McpUiError, testFailure } from './errors';
import { useEffect, useState, type FormEvent } from 'react';
import { useMcpCatalog } from './context';
import { readiness } from './McpPicker';
import type { McpAccount, McpDefinition, McpPort, McpServer } from './port';
import './mcp.css';

function DefinitionForm({ server, busy, onSave }: { server?: McpServer; busy: boolean; onSave(input: McpDefinition): Promise<void> }) {
  const [transport, setTransport] = useState<'http' | 'stdio'>(server?.transport ?? 'http');
  const [auth, setAuth] = useState<McpDefinition['auth']>(server?.auth ?? 'none');
  const [trusted, setTrusted] = useState(server?.source?.stdioTrusted ?? false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    let args: string[] = [];
    try {
      if (transport === 'stdio') {
        args = JSON.parse(String(form.get('args') || '[]'));
        if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error();
      }
    } catch { setError('Arguments must be a JSON array of strings.'); return; }
    await onSave({ secretSlot: String(form.get('secretSlot') || (transport === 'http' ? 'Authorization' : 'API_KEY')), prefix: String(form.get('prefix') || 'Bearer') as 'Bearer' | 'none', authorizationUrl: String(form.get('authorizationUrl') || ''), tokenUrl: String(form.get('tokenUrl') || ''), clientId: String(form.get('clientId') || ''), scopes: String(form.get('scopes') || '').split(/\s+/).filter(Boolean), allowPrivateNetwork: form.get('privateNetwork') === 'on', title: String(form.get('title')).trim(), description: String(form.get('description') ?? ''), transport, auth,
      ...(transport === 'http' ? { url: String(form.get('url')).trim() } : { command: String(form.get('command')).trim(), args, trustedCode: trusted }),
    });
  }
  return <form className="mcp-form" onSubmit={e => { void submit(e); }}>
    <label>Name<input name="title" required maxLength={80} pattern="[A-Za-z]([A-Za-z0-9_]|-)*" title="Start with a letter; use letters, numbers, hyphens and underscores." defaultValue={server?.title} /></label>
    <label>Source or notes<textarea name="description" defaultValue={server?.description} /></label>
    <label>Connection<select value={transport} onChange={e => { setTransport(e.target.value as 'http' | 'stdio'); if (e.target.value === 'stdio' && auth === 'oauth') setAuth('none'); }}><option value="http">Remote URL</option><option value="stdio">Local command (stdio)</option></select></label>
    {transport === 'http' ? <label>Server URL<input name="url" type="url" required placeholder="https://example.com/mcp" defaultValue={server?.url} /></label> : <>
      <label>Command<input name="command" required defaultValue={server?.command} /></label>
      <label>Arguments (JSON array)<textarea name="args" defaultValue={JSON.stringify(server?.args ?? [])} /></label>
      <p>This command runs code on the execution machine. Its subprocess can access its environment and files. Only register code you trust.</p>
      <label><span><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} /> I trust this command to run code.</span></label>
    </>}
    <label>Authentication<select value={auth} onChange={e => setAuth(e.target.value as McpDefinition['auth'])}><option value="none">No authentication</option><option value="api_key">API key</option>{transport === "http" && <option value="oauth">OAuth</option>}</select></label>
    {auth === 'api_key' && <><label>{transport === 'http' ? 'Header name' : 'Environment variable'}<input name="secretSlot" required defaultValue={server?.source?.auth.type === 'api_key' ? server.source.auth.headerName ?? server.source.auth.envKey : transport === 'http' ? 'Authorization' : 'API_KEY'} /></label>{transport === 'http' && <label>Header prefix<select name="prefix" defaultValue={server?.source?.auth.type === 'api_key' ? server.source.auth.prefix ?? 'Bearer' : 'Bearer'}><option value="Bearer">Bearer</option><option value="none">None</option></select></label>}</>}
    {auth === 'oauth' && <details><summary>OAuth settings (optional)</summary><p>Leave these blank to use server discovery and registration.</p><label>Client ID<input name="clientId" defaultValue={server?.source?.auth.type === 'oauth2' ? server.source.auth.clientId : ''} /></label><label>Authorization URL<input type="url" name="authorizationUrl" defaultValue={server?.source?.auth.type === 'oauth2' ? server.source.auth.authorizationUrl : ''} /></label><label>Token URL<input type="url" name="tokenUrl" defaultValue={server?.source?.auth.type === 'oauth2' ? server.source.auth.tokenUrl : ''} /></label><label>Scopes (space separated)<input name="scopes" defaultValue={server?.source?.auth.type === 'oauth2' ? server.source.auth.scopes?.join(' ') : ''} /></label></details>}
    {transport === 'http' && <label><span><input type="checkbox" name="privateNetwork" defaultChecked={server?.source?.allowPrivateNetwork ?? false} /> Allow this connector to access private networks (administrator policy)</span></label>}
    <p>Keep API keys and tokens out of URLs, commands and arguments. Add them as a private account after registration. Private network access requires administrator policy.</p>
    {error && <p role="alert" className="mcp-error">{error}</p>}
    <button type="submit" disabled={busy || (transport === 'stdio' && !trusted)}>{server ? 'Save connector' : 'Register connector'}</button>
  </form>;
}

function AccountCard({ account, server, port, run, busy }: { account: McpAccount; server: McpServer; port: McpPort; busy: boolean; run(action: () => Promise<unknown>, success: string): Promise<void> }) {
  const [sharing, setSharing] = useState(account.sharing);
  const [members, setMembers] = useState<{ id: string; label: string }[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>(account.memberIds ?? []);
  const [revoke, setRevoke] = useState(false);
  const [memberError, setMemberError] = useState(false);
  useEffect(() => {
    let active = true;
    if (sharing === 'members') void port.members().then(rows => { if (active) { setMembers(rows); setMemberError(false); } }, () => { if (active) setMemberError(true); });
    return () => { active = false; };
  }, [port, sharing]);
  return <div className="mcp-account-card">
    <strong>{account.label}</strong>
    <p>Owner: {account.ownerLabel ?? (account.canManage ? "You" : "Another member")}</p>
    {!account.canManage && <p>{account.canUse ? "You can use this account. Its owner manages sharing, rotation and revocation." : "This account is unavailable to you. Ask its owner for access."}</p>}
    <p>{account.status} · {account.sharing === 'private' ? 'Private' : account.sharing === 'space' ? 'Shared with space' : 'Shared with selected members'}{account.canUse ? ' · Available to you' : ''}</p>
    {account.canManage && <>
      <div className="mcp-form">
        <label>Account sharing<select value={sharing} onChange={e => { const next = e.target.value as McpAccount['sharing']; setSharing(next);  }}>
          <option value="private">Only me</option><option value="members">Selected members</option><option value="space">Everyone in this space</option>
        </select></label>
        {memberError && <p role="alert">Members could not be loaded. Reopen this account to retry.</p>}
        {sharing === 'members' && <fieldset><legend>Members who may use this account</legend>{members.map(m => <label key={m.id}><span><input type="checkbox" checked={memberIds.includes(m.id)} onChange={e => setMemberIds(e.target.checked ? [...memberIds, m.id] : memberIds.filter(id => id !== m.id))} /> {m.label}</span></label>)}</fieldset>}
        <button type="button" disabled={busy} onClick={() => void run(() => port.share(server.id, account.id, sharing, sharing === 'members' ? memberIds : []), 'Account sharing updated.')}>Save sharing</button>
      </div>
      {server.auth === 'api_key' && <form className="mcp-form" onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const secret = String(new FormData(form).get('secret') ?? ''); form.reset(); void run(() => port.rotateKey(server.id, account.id, secret), 'Key rotated.'); }}>
        <label>Replacement API key<input name="secret" type="password" required autoComplete="off" /></label>
        <button disabled={busy}>Rotate key</button>
      </form>}
      {revoke ? <div className="mcp-card"><p>Revoke {account.label}? Sessions using this account will lose access on their next tool call.</p><div className="mcp-actions"><button disabled={busy} onClick={() => void run(() => port.revoke(server.id, account.id), 'Account revoked.')}>Confirm revoke</button><button onClick={() => setRevoke(false)}>Cancel</button></div></div> : <button onClick={() => setRevoke(true)}>Revoke account</button>}
    </>}
  </div>;
}

export function McpSettings() {
  const { catalog, port, error, loading, refresh } = useMcpCatalog();
  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'add' | 'import'>('list');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [tools, setTools] = useState<{ name: string; description?: string }[] | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setFailure(null); setMessage(null);
    try { await action(); setMessage(success); }
    catch (error) { setFailure(error instanceof McpUiError ? error.message : 'The request could not be completed. Check your permissions and connection, then try again.'); }
    finally { refresh(); setBusy(false); }
  }
  if (!port) return <p role="status">Connectors are unavailable on this connection.</p>;
  const server = catalog?.servers.find(s => s.id === active);
  return <section className="mcp-settings" aria-label="Connectors" aria-busy={busy}>
    <h2>Connectors</h2><p>Add tools to chats and tasks. Select the account to use each time you launch.</p>
    {error && <p role="alert">{error} <button onClick={refresh}>Retry</button></p>}
    {failure && <p role="alert" className="mcp-error">{failure}</p>}
    {message && <p role="status">{message}</p>}
    {loading && !catalog && <p role="status">Loading connectors…</p>}
    <div className="mcp-actions">
      <button onClick={() => { setActive(null); setMode('list'); }}>All connectors</button>
      {catalog?.canRegister && <><button onClick={() => { setActive(null); setMode('add'); }}>Add connector</button><button onClick={() => { setActive(null); setMode('import'); }}>Import configuration</button></>}
    </div>
    {mode === 'add' && catalog?.canRegister && <DefinitionForm busy={busy} onSave={input => run(async () => { await port.register(input); setMode('list'); }, 'Connector registered.')} />}
    {mode === 'import' && catalog?.canRegister && <form className="mcp-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run(async () => { await port.importConfig(String(data.get('json')), data.get('trusted') === 'on'); setMode('list'); }, 'Configuration imported.'); }}>
      <label>MCP configuration JSON<textarea required name="json" placeholder={'{"mcpServers": {}}'} /></label>
      <p>Remove secrets before importing. Local commands execute code on the machine.</p>
      <label><span><input type="checkbox" name="trusted" /> I trust any local commands in this configuration.</span></label>
      <button disabled={busy}>Import connectors</button>
    </form>}
    {mode === 'list' && !active && catalog && <>{catalog.servers.length === 0 && <p>No connectors yet.</p>}{catalog.servers.map(s => <article className="mcp-card" key={s.id}><h3>{s.title}</h3><p>{s.description}</p><p>{s.transport === 'http' ? s.url : s.command} · {!s.approved ? 'Awaiting approval' : s.enabled ? 'Enabled' : 'Disabled'}</p><button onClick={() => { setActive(s.id); setCredentialId(''); setTools(null); setOauthUrl(null); setEditing(false); setRemoving(false); }}>Manage {s.title}</button></article>)}</>}
    {server && <article className="mcp-card">
      <h3>{server.title}</h3><p>{server.description}</p>
      <p>{server.approved ? 'Approved' : 'Awaiting approval'} · {server.enabled ? 'Enabled' : 'Disabled'}</p>
      {server.health && <p>Last checked {new Date(server.health.checkedAt).toLocaleString()} · {server.health.ready ? 'Connected' : 'Needs attention'} · {server.health.tools.length} tools</p>}
      {server.canApprove && <button disabled={busy} onClick={() => void run(() => port.update(server, { ...server, approved: !server.approved }), 'Approval updated.')}>{server.approved ? 'Withdraw approval' : 'Approve connector'}</button>}<p>{server.transport === 'http' ? server.url : server.command}</p>
      {server.canManage && <div className="mcp-actions"><button onClick={() => setEditing(!editing)}>Edit configuration</button><button disabled={busy} onClick={() => void run(() => port.update(server, { ...server, enabled: !server.enabled }), 'Connector updated.')}>{server.enabled ? 'Disable connector' : 'Enable connector'}</button></div>}
      {editing && server.canManage && <DefinitionForm server={server} busy={busy} onSave={input => run(async () => { await port.update(server, { ...input, enabled: server.enabled }); setEditing(false); }, 'Connector saved.')} />}
      {server.canManage && <div className="mcp-actions">{removing ? <><p>Remove this connector from the catalog?</p><button disabled={busy} onClick={() => void run(async () => { await port.remove(server); setActive(null); }, 'Connector removed.')}>Confirm removal</button><button onClick={() => setRemoving(false)}>Cancel</button></> : <button onClick={() => setRemoving(true)}>Remove connector</button>}</div>}
      <h4>Test connection and tools</h4>
      {server.auth !== 'none' && <label className="mcp-account">Test with account<select value={credentialId} onChange={e => { setCredentialId(e.target.value); setTools(null); }}><option value="">Choose an account</option>{server.accounts.filter(a => a.canUse && a.status === 'connected').map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
      <button disabled={busy || !!readiness({ ...server, canAttach: true }, { serverId: server.id, ...(credentialId ? { credentialId } : {}) })} onClick={() => void run(async () => { const result = await port.test({ serverId: server.id, ...(credentialId ? { credentialId } : {}) }); if (!result.ok) { setTools(null); throw new McpUiError(testFailure(result.message)); } setTools(result.tools); }, 'Connection tested.')}>Test and discover tools</button>
      {tools && <><p>{tools.length} tools available</p><ul className="mcp-tools">{tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong>{tool.description && <p>{tool.description}</p>}</li>)}</ul></>}
      {server.auth !== 'none' && <><h4>Accounts</h4><p>New accounts are private. Sharing a connector does not share an account.</p>
        {server.accounts.map(a => <AccountCard key={a.id} account={a} server={server} port={port} run={run} busy={busy} />)}
        <form className="mcp-form" onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); const label = String(data.get('label')); const secret = String(data.get('secret') ?? ''); form.reset(); void run(async () => { if (server.auth === 'api_key') await port.createKey(server.id, label, secret); else { const response = await port.startOAuth(server.id, label); const url = new URL(response.authorizationUrl); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(); setOauthUrl(url.href); } }, server.auth === 'api_key' ? 'Private account added.' : 'Authorization is ready.'); }}>
          <label>Account label<input name="label" required autoComplete="off" /></label>
          {server.auth === 'api_key' && <label>API key<input name="secret" type="password" required autoComplete="off" /></label>}
          <button disabled={busy || !server.approved || !server.enabled}>{server.auth === 'api_key' ? 'Add private account' : 'Connect with OAuth'}</button>
        </form>
        {oauthUrl && <div className="mcp-actions"><a href={oauthUrl} rel="noreferrer">Continue authorization</a><button onClick={refresh}>Refresh account status</button></div>}
      </>}
    </article>}
  </section>;
}
