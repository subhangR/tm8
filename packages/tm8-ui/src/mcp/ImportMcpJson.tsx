/**
 * IMPORT FROM `.mcp.json` (D1's helper, D3's reason it exists).
 *
 * Every tm8 launcher passes `--strict-mcp-config`, so a connector in
 * `~/.claude.json` or a repo's `.mcp.json` is NOT loaded into a tm8 session,
 * whatever the harness surface (D3/D4). This screen is the migration path: it
 * reads the file people already have, previews what tm8 can take from it, and
 * leaves the secrets behind.
 *
 * THE PREVIEW IS THE POINT. Secrets are dropped, not imported, so the row says
 * so and the person connects an account afterwards; an entry tm8 cannot read is
 * a red row naming the reason rather than a sentence that rejects the whole
 * file. The parsing itself is `previewMcpConfig` in `adapter.ts`, which is pure
 * and holds no React.
 */
import { useState } from 'react';
import { previewMcpConfig, type McpImportRow } from './adapter';
import { McpUiError } from './errors';
import './connectors.css';

export function ImportMcpJson({ busy, onImport }: {
  busy: boolean;
  onImport(rows: McpImportRow[], trustLocal: boolean): Promise<void>;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<McpImportRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [trustLocal, setTrustLocal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function preview(source: string) {
    setText(source);
    setError(null);
    if (!source.trim()) { setRows(null); return; }
    try {
      const parsed = previewMcpConfig(source);
      setRows(parsed);
      // Pre-tick what can actually be imported; a red row is never ticked.
      setPicked(new Set(parsed.filter(row => row.definition).map(row => row.key)));
    } catch (failure) {
      setRows(null);
      setError(failure instanceof McpUiError ? failure.message : 'This file could not be read.');
    }
  }

  const importable = (rows ?? []).filter(row => row.definition && picked.has(row.key));
  const needsTrust = importable.some(row => row.transport === 'stdio');
  return <div className="mcp-import">
    <p>Connectors in the Claude app or a <code>.mcp.json</code> file aren&rsquo;t used by tm8 chats or sessions, whatever the harness. Import them here, then connect an account to each one.</p>
    <label className="mcp-import__field">MCP configuration JSON
      <textarea value={text} onChange={e => preview(e.target.value)} placeholder={'{"mcpServers": {}}'} spellCheck={false} />
    </label>
    <label className="mcp-import__file"><span>Or choose a file</span>
      <input type="file" accept=".json,application/json" onChange={async e => {
        const file = e.target.files?.[0];
        // The file is read in the browser and never uploaded: `mcp.servers.import`
        // takes the parsed definitions, so the secrets in it never leave the tab.
        if (file) preview(await file.text());
      }} />
    </label>
    {error && <p role="alert" className="mcp-error">{error}</p>}
    {rows && rows.length === 0 && <p role="status">This file lists no servers.</p>}
    {rows && rows.length > 0 && <>
      <table className="mcp-table mcp-table--import">
        <thead><tr><th scope="col"><span className="mcp-sr">Import</span></th><th scope="col">Server</th><th scope="col">Type</th><th scope="col">Address</th><th scope="col">Notes</th></tr></thead>
        <tbody>
          {rows.map(row => <tr key={row.key} className={row.error ? 'mcp-row--invalid' : undefined}>
            <td>{row.definition
              ? <input type="checkbox" aria-label={`Import ${row.name}`} checked={picked.has(row.key)} onChange={e => {
                const next = new Set(picked);
                if (e.target.checked) next.add(row.key); else next.delete(row.key);
                setPicked(next);
              }} />
              : <span aria-hidden="true">⛔</span>}</td>
            <td>{row.name}</td>
            <td>{row.transport === 'stdio' ? 'Local' : row.transport === 'http' ? 'Remote' : '—'}</td>
            <td className="mcp-cell--address">{row.target || '—'}</td>
            <td>{row.error
              ? <span className="mcp-error">{row.error}</span>
              : <>
                {row.transport === 'stdio' && <span className="mcp-note">Local command — needs admin trust</span>}
                {row.droppedSecrets && <span className="mcp-note">Secrets not imported</span>}
              </>}</td>
          </tr>)}
        </tbody>
      </table>
      {needsTrust && <label><span><input type="checkbox" checked={trustLocal} onChange={e => setTrustLocal(e.target.checked)} /> I trust the local commands I ticked to run code on the tm8 host.</span></label>}
      <p className="mcp-note">Imported connectors arrive unapproved and with no account. Keys and tokens in the file are left behind.</p>
      <div className="mcp-actions">
        <button type="button" disabled={busy || importable.length === 0 || (needsTrust && !trustLocal)}
          onClick={() => void onImport(importable, trustLocal)}>
          Import {importable.length} connector{importable.length === 1 ? '' : 's'}
        </button>
      </div>
    </>}
  </div>;
}
