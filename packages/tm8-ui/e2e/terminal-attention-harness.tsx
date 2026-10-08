import { createRoot } from 'react-dom/client';
import type { AttentionRequest, EntityId } from '@tm8/contract';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import { GateApp } from '../src/views/GateApp';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../src/data/fixtures/seam-fixture';
import { sessionLive, taskGuideLines, taskUuidTitle, docLayoutSpec, ada } from '../src/fixtures';

const seam = createFixtureSeam();
const request = (id: string, entityId: string, reason: string, rest: Partial<AttentionRequest> = {}): AttentionRequest => ({
  id, entityId: entityId as EntityId, spaceId: FIXTURE_SPACE_ID, reason, status: 'open', points: 40,
  version: 1, requestedBy: ada, acknowledgedBy: null, resolvedBy: null, resolutionNote: null,
  createdAt: '2026-10-08T08:00:00Z', updatedAt: '2026-10-08T08:00:00Z', acknowledgedAt: null, resolvedAt: null,
  ...rest,
});
const rows = [
  request('local', sessionLive.id, 'Session-local decision'),
  request('rolled', 'form-a', 'Session request rolled up to task A', { rootId: taskGuideLines.id, sourceWorkSessionId: sessionLive.id }),
  request('sibling', taskGuideLines.id, 'Sibling request affected by Resolve all', { status: 'acknowledged' }),
  request('raised', taskUuidTitle.id, 'Session raised this on task B', { sourceWorkSessionId: sessionLive.id }),
  request('unrelated', docLayoutSpec.id, 'Unrelated document notification'),
];
const quiet = new URLSearchParams(location.search).has('quiet');
seam.attentionRequests = async input => ({ items: quiet ? [] : rows.filter(row => !input.status || row.status === input.status).map(row => ({ ...row })), nextCursor: null });
seam.commands.resolveAttention = async id => {
  let affectedCount = 0;
  for (const row of rows) if ((row.rootId ?? row.entityId) === id) { row.status = 'resolved'; affectedCount++; }
  return { request: null, affectedCount, entity: { ...await seam.entity(id), badges: { attention: null } } };
};
// Opt into the existing v2 root-scoped command path in the attention provider.
seam.commands.attentionV2 = {
  markSeen: async id => ({ request: null, affectedCount: 0, entity: await seam.entity(id) }),
  unresolve: async () => { throw new Error('Undo is outside this layout harness'); },
};
if (!location.hash) location.hash = `#/s/${FIXTURE_SPACE_ID}/work?tab=${sessionLive.id}`;
createRoot(document.getElementById('root')!).render(<GateApp seam={seam} />);
