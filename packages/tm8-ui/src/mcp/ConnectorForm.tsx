/**
 * THE CUSTOM-CONNECTOR FORM (§10.1 "+ Add → Custom connector…"), lifted out of
 * `McpSettings.tsx` unchanged in behaviour so the table could replace that
 * file's body without also rewriting the one form in the module that already
 * carries every contract refinement's wording.
 *
 * TWO THINGS ARE NEW HERE, both from the catalog moving server-side:
 *  - a template is now an `McpCatalogEntry` (`mcp.catalog.list`), not the
 *    deleted `ui/mcp/directory.ts` row. Its `clientSecretEnv` lives on the
 *    ENTRY rather than in `definition`, because a definition naming a server
 *    secret with no client id is not a valid definition at all (B13) — so the
 *    prefill reads it from the entry and the admin's own Client ID completes it.
 *  - `mode='request'` is a MEMBER asking (B13). OAuth client settings and the
 *    private-network policy are not drawn at all, because the request schema
 *    refuses every one of them: drawing an input whose value the server will
 *    reject is the form equivalent of an enabled control that cannot act.
 */
import { useState, type FormEvent } from 'react';
import type { McpCatalogEntry } from '@tm8/contract';
import type { McpDefinition, McpServer } from './port';
import { isPrivateHost } from './private-host';
import './mcp.css';
import './connectors.css';

export function ConnectorForm({ server, template, mode = 'manage', busy, onSave, onCancel }: {
  server?: McpServer;
  template?: McpCatalogEntry;
  /** `request` is the member path (B13): HTTPS only, and no admin-only field. */
  mode?: 'manage' | 'request';
  busy: boolean;
  onSave(input: McpDefinition, note?: string): Promise<void>;
  /** Drawn as a quiet Cancel beside the submit, so the form's two exits sit together. */
  onCancel?(): void;
}) {
  // A catalog template prefills a new connector exactly as an existing definition prefills an edit.
  const source = server?.source ?? template?.definition;
  const requesting = mode === 'request';
  const [transport, setTransport] = useState<'http' | 'stdio'>(requesting ? 'http' : server?.transport ?? source?.transport ?? 'http');
  const [auth, setAuth] = useState<McpDefinition['auth']>(server?.auth ?? (source?.auth.type === 'oauth2' ? 'oauth' : source?.auth.type) ?? 'none');
  const oauthSource = source?.auth.type === 'oauth2' ? source.auth : undefined;
  const [trusted, setTrusted] = useState(server?.source?.stdioTrusted ?? false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState(server?.url ?? source?.url ?? '');
  const [privateNetwork, setPrivateNetwork] = useState(server?.source?.allowPrivateNetwork ?? source?.allowPrivateNetwork ?? false);
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
    const note = String(form.get('note') || '').trim();
    await onSave({ issuer: String(form.get('issuer') || ''), secretSlot: String(form.get('secretSlot') || (transport === 'http' ? 'Authorization' : 'API_KEY')), prefix: String(form.get('prefix') || 'Bearer') as 'Bearer' | 'none', authorizationUrl: String(form.get('authorizationUrl') || ''), tokenUrl: String(form.get('tokenUrl') || ''), clientId: String(form.get('clientId') || ''), clientSecretEnv: String(form.get('clientSecretEnv') || ''), scopes: String(form.get('scopes') || '').split(/\s+/).filter(Boolean), allowPrivateNetwork: transport === 'http' && !requesting && privateNetwork, title: String(form.get('title')).trim(), description: String(form.get('description') ?? ''), transport, auth,
      ...(transport === 'http' ? { url: url.trim() } : { command: String(form.get('command')).trim(), args, trustedCode: trusted }),
    }, note || undefined);
  }
  const privateHost = transport === 'http' && isPrivateHost(url);
  const httpsLocal = privateHost && url.startsWith('https://');
  return <form className="mcp-form mcp-cform" onSubmit={e => { void submit(e); }}>
    <label>Name<input name="title" required maxLength={80} pattern="[A-Za-z]([A-Za-z0-9_]|-)*" title="Start with a letter; use letters, numbers, hyphens and underscores." placeholder="e.g. github" defaultValue={server?.title ?? source?.name} /></label>
    {/* Not drawn for a request: `provenance` is a claim about identity and
        the request schema refuses it (B13). The note below carries the
        member's words instead. */}
    {!requesting && <label>Notes<textarea name="description" rows={2} placeholder="Where it comes from, what it is for (optional)" defaultValue={server?.description ?? source?.provenance} /></label>}
    {requesting
      // A member's connector is HTTPS-only by the request schema, so there is
      // no transport to choose and no local-command branch to draw.
      ? <p className="mcp-cform__hint">A request can only name a remote <strong>https</strong> connector. A local command or a localhost server needs someone who can register connectors.</p>
      : <label>Connection<select value={transport} onChange={e => { setTransport(e.target.value as 'http' | 'stdio'); if (e.target.value === 'stdio' && auth === 'oauth') setAuth('none'); }}><option value="http">Remote URL</option><option value="stdio">Local command (stdio)</option></select></label>}
    {transport === 'http' ? <>
      {/* The URL is kept EXACTLY as typed — no scheme is added or changed.
          The placeholder names both shapes, because a localhost server almost
          always speaks plain http and an https-only example sent people to
          save https://127.0.0.1… against a server that never had TLS. */}
      <label>Server URL<input name="url" type="url" required autoComplete="off" spellCheck={false} value={url} onChange={e => setUrl(e.target.value)}
        placeholder={requesting ? 'https://mcp.example.com/mcp' : 'https://mcp.example.com/mcp  or  http://127.0.0.1:8787/mcp'}
        pattern={requesting ? 'https://.*' : undefined} title={requesting ? 'A requested connector needs an https URL.' : undefined} /></label>
      {!requesting && !url && <p className="mcp-cform__hint">Remote servers use <code>https://</code>. A server on this machine or your network (localhost, 127.0.0.1, 192.168.…) usually uses plain <code>http://</code> and needs &ldquo;Allow private networks&rdquo; below.</p>}
      {httpsLocal && <p className="mcp-cform__warn" role="status">
        This is a local address over <code>https</code>. Most local MCP servers speak plain http, and tm8 cannot connect with TLS to a server that has none.
        {!requesting && <> <button type="button" onClick={() => setUrl(url.replace(/^https:/, 'http:'))}>Use {url.replace(/^https:/, 'http:')}</button></>}
      </p>}
      {privateHost && !requesting && !privateNetwork && <p className="mcp-cform__warn" role="status">
        tm8 refuses localhost and LAN addresses unless private networks are allowed. <button type="button" onClick={() => setPrivateNetwork(true)}>Allow private networks</button>
      </p>}
    </> : <>
      <label>Command<input name="command" required spellCheck={false} placeholder="npx" defaultValue={server?.command} /></label>
      <label>Arguments<textarea name="args" rows={2} spellCheck={false} placeholder='["-y", "@scope/server"]' defaultValue={JSON.stringify(server?.args ?? [])} /></label>
      <p className="mcp-cform__warn">This command runs code on the execution machine. Its subprocess can access its environment and files. Only register code you trust.</p>
      <label className="mcp-cform__check"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} /> I trust this command to run code.</label>
    </>}
    {transport === 'http' && !requesting && <label className="mcp-cform__check"><input type="checkbox" name="privateNetwork" checked={privateNetwork} onChange={e => setPrivateNetwork(e.target.checked)} /> Allow private networks (localhost, 127.0.0.1, your LAN)</label>}
    <label>Authentication<select value={auth} onChange={e => setAuth(e.target.value as McpDefinition['auth'])}><option value="none">No authentication</option><option value="api_key">API key</option>{transport === "http" && <option value="oauth">OAuth</option>}</select></label>
    {auth === 'api_key' && <><label>{transport === 'http' ? 'Header name' : 'Environment variable'}<input name="secretSlot" required defaultValue={server?.source?.auth.type === 'api_key' ? server.source.auth.headerName ?? server.source.auth.envKey : transport === 'http' ? 'Authorization' : 'API_KEY'} /></label>{transport === 'http' && <label>Header prefix<select name="prefix" defaultValue={server?.source?.auth.type === 'api_key' ? server.source.auth.prefix ?? 'Bearer' : 'Bearer'}><option value="Bearer">Bearer</option><option value="none">None</option></select></label>}</>}
    {auth === 'oauth' && !requesting && <details open={!!template?.clientSecretEnv || !!oauthSource?.clientSecretEnv}><summary>OAuth settings (optional)</summary><p className="mcp-cform__hint">Leave these blank to use server discovery and registration.</p><label>Authorization server (issuer)<input name="issuer" type="url" defaultValue={oauthSource?.issuer ?? ''} /></label><label>Client ID<input name="clientId" required={!!(template?.clientSecretEnv ?? oauthSource?.clientSecretEnv)} defaultValue={oauthSource?.clientId ?? ''} /></label><label>Client secret environment variable<input name="clientSecretEnv" pattern="TM8_MCP_CLIENT_SECRET_[A-Z0-9_]+" title="TM8_MCP_CLIENT_SECRET_ followed by capitals, digits or underscores." placeholder="TM8_MCP_CLIENT_SECRET_EXAMPLE" defaultValue={oauthSource?.clientSecretEnv ?? template?.clientSecretEnv ?? ''} /></label><p className="mcp-cform__hint">Only for providers that require a preregistered confidential client. The secret is never stored here: set the named variable in the tm8 server environment.</p><label>Authorization URL<input type="url" name="authorizationUrl" defaultValue={oauthSource?.authorizationUrl ?? ''} /></label><label>Token URL<input type="url" name="tokenUrl" defaultValue={oauthSource?.tokenUrl ?? ''} /></label><label>Scopes (space separated)<input name="scopes" defaultValue={oauthSource?.scopes?.join(' ') ?? ''} /></label></details>}
    {requesting && <label>Note for the administrators<textarea name="note" rows={2} maxLength={500} placeholder="Optional" /></label>}
    <p className="mcp-cform__hint">Keep API keys and tokens out of URLs, commands and arguments{auth === 'none' ? '' : ' — add the key as your account once the connector is saved'}.</p>
    {error && <p role="alert" className="mcp-error">{error}</p>}
    <div className="mcp-cform__foot">
      <button type="submit" className="mcp-btn--primary" disabled={busy || (transport === 'stdio' && !trusted)}>{requesting ? 'Send request' : server ? 'Save connector' : 'Add connector'}</button>
      {onCancel && <button type="button" className="mcp-btn--quiet" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}
