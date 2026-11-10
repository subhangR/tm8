import { AppDetail } from './AppDetail';
import { useMemo, useState } from 'react';
import type { McpCatalogEntry } from '@tm8/contract';
import { ConnectorLogo } from './connector-logos';
import type { McpServer } from './port';

export function AppCatalog({ entries, servers, admin, busy, onAdd, onRequest, onOpen }: {
  entries: McpCatalogEntry[]; servers: McpServer[]; admin: boolean; busy: boolean;
  onAdd(entry: McpCatalogEntry): void; onRequest(entry: McpCatalogEntry): void; onOpen(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All apps');
  const [selected, setSelected] = useState<McpCatalogEntry | null>(null);
  const categories = ['All apps', ...new Set(entries.map(entry => entry.category ?? 'Productivity'))];
  const visible = useMemo(() => entries.filter(entry =>
    (category === 'All apps' || (entry.category ?? 'Productivity') === category)
    && `${entry.title} ${entry.summary} ${entry.publisher ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [entries, query, category]);

  function action(entry: McpCatalogEntry) {
    const approved = entry.added?.find(row => row.approved);
    const pending = entry.added?.find(row => !row.approved);
    if (!entry.available) return <button disabled aria-disabled="true">Coming soon</button>;
    if (approved) return <button onClick={() => { setSelected(null); onOpen(approved.serverId); }}>Manage accounts</button>;
    if (pending && !admin) return <button disabled aria-disabled="true">Requested</button>;
    return <button disabled={busy} onClick={() => admin ? onAdd(entry) : onRequest(entry)}>
      {pending ? 'Approve request' : admin ? 'Add to Space' : 'Request'}
    </button>;
  }

  return <div className="connect-apps">
    <div className="connect-apps__intro"><h3>Your work, connected.</h3><p>Give your teammates the context and tools they need, using your own accounts.</p></div>
    <label className="connect-apps__search"><span aria-hidden="true">⌕</span><span className="mcp-sr">Search apps</span>
      <input type="search" placeholder="Search apps…" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <nav className="connect-apps__categories" aria-label="App categories">{categories.map(value =>
      <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</nav>
    <div className="connect-apps__heading"><h4>{category}</h4><span>{visible.length} {visible.length === 1 ? 'app' : 'apps'}</span></div>
    <div className="connect-apps__grid">{visible.map(entry => {
      const accounts = servers.filter(server => server.source?.catalogId === entry.id).flatMap(server => server.accounts).filter(account => account.canUse && account.status === 'connected');
      return <article className="connect-apps__card" key={entry.id}>
        <button className="connect-apps__card-open" onClick={() => setSelected(entry)} aria-label={`About ${entry.title}`}>
          <ConnectorLogo logo={entry.logo} title={entry.title} /><span><strong>{entry.title}</strong><small>{entry.publisher ?? 'Google'} · {entry.category ?? 'Productivity'}</small></span>
        </button>
        <p>{entry.summary}</p>
        <footer><span className={accounts.length ? 'connect-apps__connected' : 'mcp-note'}>{accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'Official integration'}</span>{action(entry)}</footer>
      </article>;
    })}</div>
    {visible.length === 0 && <div className="mcp-empty"><p>No apps match your search.</p><button onClick={() => { setQuery(''); setCategory('All apps'); }}>Clear filters</button></div>}
    {selected && <AppDetail label={`${selected.title} app details`} onClose={() => setSelected(null)}>
      <header className="mcp-drawer__head"><ConnectorLogo logo={selected.logo} title={selected.title} /><div><h3>{selected.title}</h3><p>{selected.publisher ?? 'Google'}</p></div><button onClick={() => setSelected(null)} aria-label="Close app details">×</button></header>
      <p>{selected.summary}</p><div className="mcp-actions">{action(selected)}</div>
      <section className="mcp-drawer__group"><h4>Accounts</h4><p>Connect your own account. Add more accounts and manage sharing after adding this app to your Space.</p></section>
      <section className="mcp-drawer__group"><h4>Tools</h4><p>Available tools are discovered from the provider when you test a connected account.</p></section>
      {!!selected.scopeLabels?.length && <section className="mcp-drawer__group"><h4>Permissions</h4><ul>{selected.scopeLabels.map(label => <li key={label}>{label}</li>)}</ul></section>}
      <section className="mcp-drawer__group"><h4>Information</h4>{selected.requirement && <p>{selected.requirement}</p>}<a href={selected.docsUrl} target="_blank" rel="noopener noreferrer">Provider documentation ↗</a></section>
    </AppDetail>}
  </div>;
}
