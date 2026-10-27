import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { McpProvider } from '../src/mcp/context';
import { McpSettings } from '../src/mcp/McpSettings';
import { McpPicker } from '../src/mcp/McpPicker';
import { McpEquipment } from '../src/mcp/McpEquipment';
import type { McpSelection } from '../src/mcp/port';
import { createRealSeam } from '../src/data/real/seam-real';
import { browserWebSocketFactory } from '../src/data/real/socket';
import { buildSpawnInput, defaultConfigFor } from '../src/domain/launch';
import { createdIdOf } from '../src/authoring/commands';
import { resetNav } from '../src/stores/navStore';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/kit/kit.css';

/** Test-owned, ephemeral human session supplied by Playwright before navigation.
 * Every request uses the production seam/facade. No fixture port or response interception.
 * Run Vite with TM8_SERVER_ORIGIN pointing at a freshly bootstrapped scratch backend.
 */
declare global { interface Window { __MCP_JOURNEY__?: { token: string; spaceId: string; taskId: string; teamMemberId: string; model: string; agentTool: string } } }
const setup = window.__MCP_JOURNEY__;
delete window.__MCP_JOURNEY__;
if (!setup) throw new Error('This harness requires an isolated backend test session.');
resetNav(setup.spaceId);
const seam = createRealSeam({ fetch: globalThis.fetch, origin: location.origin, webSocketFactory: browserWebSocketFactory(WebSocket), getAuthToken: () => setup.token });
const port = seam.mcp!(setup.spaceId);
function Journey() {
  const [selections,setSelections] = useState<McpSelection[] | undefined>();
  const [ready,setReady] = useState(false);
  const [pending,setPending] = useState(false);
  const [sessionId,setSessionId] = useState<string | null>(null);
  const [error,setError] = useState(false);
  async function launch() {
    if (!ready || pending) return;
    setPending(true); setError(false);
    try {
      const config = { ...defaultConfigFor({ id: setup!.teamMemberId, agentTool: setup!.agentTool, model: setup!.model }), mcpSelections: selections };
      const result = await seam.commands.spawn(buildSpawnInput({ clientMutationId: crypto.randomUUID(), spaceId: setup!.spaceId, taskIds: [setup!.taskId], config }));
      const id = createdIdOf(result);
      if (!id) throw new Error('No session returned');
      setSessionId(id);
    } catch { setError(true); }
    finally { setPending(false); }
  }
  return <main className="cv2-root" style={{maxWidth:960,margin:'0 auto',padding:20}}><h1>MCP real backend journey</h1><McpProvider port={port}>
    <McpSettings/><McpEquipment targetId={setup!.taskId}/>
    <section aria-label="Launch"><McpPicker targetId={setup!.taskId} teamMemberId={setup!.teamMemberId} value={selections} onChange={setSelections} onReady={setReady} disabled={pending}/>
      <button disabled={!ready || pending} onClick={()=>void launch()}>Launch fixture session</button>
      {sessionId && <p role="status" data-testid="mcp-session-id">{sessionId}</p>}
      {error && <p role="alert">Session launch failed. Inspect the isolated backend response.</p>}
    </section>
  </McpProvider></main>;
}
createRoot(document.getElementById('root')!).render(<Journey/>);
