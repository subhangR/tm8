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
 * file. The parsing itself is `previewMcpText` in `adapter.ts`, which is pure
 * and holds no React.
 */
import { useState } from 'react';
import type { McpLocalConfigsResult, McpServerDefinition } from '@tm8/contract';
import { localImportRows, previewMcpText, type McpImportRow } from './adapter';
import { McpUiError } from './errors';
import './connectors.css';

const LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

export function ImportMcpJson({ busy, onImport, local, existing = [] }: {
  busy: boolean;
  onImport(rows: McpImportRow[], trustLocal: boolean, defaultOn: boolean): Promise<void>;
  /** `mcp.servers.local`, offered to Space admins: the tm8 host's own Claude Code and Codex configs. */
  local?: () => Promise<McpLocalConfigsResult>;
  /** The Space's connectors, so a host import marks what is already registered. */
  existing?: readonly { id: string; definition: McpServerDefinition }[];
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<McpImportRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [trustLocal, setTrustLocal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultOn, setDefaultOn] = useState(true);
  const [hostNote, setHostNote] = useState<string | null>(null);

  function show(parsed: McpImportRow[]) {
    setRows(parsed);
    // Pre-tick what can actually be imported; a red row is never ticked.
    setPicked(new Set(parsed.filter(row => row.definition).map(row => row.key)));
  }

  async function fromHost(format: 'claude' | 'codex') {
    setText(''); setError(null); setHostNote(null); setRows(null);
    try {
      const source = (await local!()).sources.find(s => s.format === format);
      if (!source?.found) { setHostNote(`No ${LABEL[format]} config on the tm8 host at ${source?.path ?? 'its default path'}.`); return; }
      if (source.error) { setError(source.error); return; }
      setHostNote(`From ${source.path} on the tm8 host.`);
      show(localImportRows(source, existing));
    } catch (failure) {
      setError(failure instanceof McpUiError ? failure.message : 'The tm8 host\u2019s configs could not be read.');
    }
  }

  function preview(source: string) {
    setText(source);
    setError(null);
    setHostNote(null);
    if (!source.trim()) { setRows(null); return; }
    try {
      show(previewMcpText(source, existing));
    } catch (failure) {
      setRows(null);
      setError(failure instanceof McpUiError ? failure.message : 'This file could not be read.');
    }
  }

  const importable = (rows ?? []).filter(row => row.definition && picked.has(row.key));
  const needsTrust = importable.some(row => row.transport === 'stdio');
  return <div className="mcp-import">
    <p>Connectors in the Claude app or a <code>.mcp.json</code> file aren&rsquo;t used by tm8 chats or sessions, whatever the harness. Import them here, then connect an account to each one.</p>
    {local && <div className="mcp-actions" role="group" aria-label="Import from the tm8 host">
      <span>From this machine:</span>
      <button type="button" disabled={busy} onClick={() => void fromHost('claude')}>Claude Code</button>
      <button type="button" disabled={busy} onClick={() => void fromHost('codex')}>Codex</button>
    </div>}
    {hostNote && <p role="status" className="mcp-note">{hostNote}</p>}
    <label className="mcp-import__field">MCP configuration (JSON, or Codex TOML)
      <textarea value={text} onChange={e => preview(e.target.value)} placeholder={'{"mcpServers": {}}'} spellCheck={false} />
    </label>
    <label className="mcp-import__file"><span>Or choose a file</span>
      <input type="file" accept=".json,.toml,application/json" onChange={async e => {
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
      <label><span><input type="checkbox" checked={defaultOn} onChange={e => setDefaultOn(e.target.checked)} /> Turn on in every chat and session</span></label>
      <p className="mcp-note">Imported connectors arrive with no account. Keys and tokens in the file are left behind. Any chat or session can still turn one off.</p>
      <div className="mcp-actions">
        <button type="button" disabled={busy || importable.length === 0 || (needsTrust && !trustLocal)}
          onClick={() => void onImport(importable, trustLocal, defaultOn)}>
          Import {importable.length} connector{importable.length === 1 ? '' : 's'}
        </button>
      </div>
    </>}
  </div>;
}
