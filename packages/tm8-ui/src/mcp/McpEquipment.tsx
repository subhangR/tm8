import { ConnectorsLink } from './ConnectorsLink';
import { useState } from 'react';
import { useMcpCatalog } from './context';
import './mcp.css';
/** Attachment grants tools to a target; credentials are chosen separately at launch. */
export function McpEquipment({ targetId }: { targetId: string }) {
  const { catalog, port, error, refresh } = useMcpCatalog(targetId);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!port || !catalog?.canAttach) return error ? <p role="alert">{error}</p> : null;
  async function change(serverId: string, attached: boolean) {
    if (!port || pending) return;
    setPending(true); setFailure(null);
    try { if (attached) await port.detach(targetId, serverId); else await port.attach(targetId, serverId); }
    catch { setFailure('Connector attachment could not be saved. Try again.'); }
    finally { refresh(); setPending(false); }
  }
  return <section className="mcp-equipment" aria-label="Task and teammate connectors">
    <h3>Connectors</h3><p>Attach tools here. Choose an authorized account when starting a session.</p>
    {catalog.servers.filter(s => (catalog.attachedServerIds ?? []).includes(s.id) || (s.canAttach && s.approved && s.enabled)).map(server => {
      const attached = (catalog.attachedServerIds ?? []).includes(server.id);
      return <label className="mcp-row" key={server.id}><span><input type="checkbox" checked={attached} disabled={pending} onChange={() => void change(server.id, attached)} /> {server.title}{!server.enabled ? " · Disabled" : !server.approved ? " · Awaiting approval" : ""}</span></label>;
    })}
    {failure && <p role="alert" className="mcp-error">{failure}</p>}
    <ConnectorsLink>Manage connectors and accounts</ConnectorsLink>
  </section>;
}
