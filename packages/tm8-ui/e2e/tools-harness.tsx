import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type EntityDetail, type ToolRun } from '@tm8/contract';
import { ToolBody } from '../src/tools/ToolBody';
import { ToolRunChip } from '../src/tools/ToolRunChip';
import { createToolFixture, fixtureTool } from '../src/tools/fixture';
import { fixtureDetails, sessionStale } from '../src/fixtures';
import '../src/styles/tokens.css';
import '../src/styles/fonts.css';
import '../src/panels/panels.css';
import '../src/kit/kit.css';
const fixture = createToolFixture();
function App() {
  const [run, setRun] = useState<ToolRun | null>(null);
  const detail = { ...fixtureDetails[sessionStale.id]!, id: fixtureTool.id, version: 1, content: { kind: 'tool', definition: fixtureTool.definition } } as EntityDetail;
  return <main className="cv2-root" style={{ minHeight: '100vh' }}>
    {!run ? <ToolBody detail={detail} port={fixture.port} onOpenSession={id => { void fixture.port.runGet(id).then(setRun); }} /> : <section aria-label="Tool session fixture"><ToolRunChip run={run} /><pre>Simulated output: URL responded.</pre><label>Simulated interactive shell<input aria-label="Shell command" /></label><button onClick={() => { fixture.finish(run.id, 'exited', 0); void fixture.port.runGet(run.id).then(setRun); }}>Finish run</button><button onClick={() => setRun(null)}>Close terminal</button></section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
