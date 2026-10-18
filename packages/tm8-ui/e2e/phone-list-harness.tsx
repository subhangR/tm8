import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { MobileSurfaceProvider } from '../src/mobile';
import { PhoneEntityList } from '../src/mobile-lists';
import { getKind } from '../src/domain';
import { fixtureSummaries, FIXTURE_SPACE_ID } from '../src/fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/mobile/mobile.css';
import '../src/mobile/mobile-chrome.css';
import '../src/mobile/mobile-screens.css';

/* The phone list with crowded, deterministic rows and no server: every kind,
   every state, at whatever viewport the checker sets. ?kind=&state=&theme= */
const params = new URLSearchParams(location.search);
const kind = params.get('kind') ?? 'task';
const state = params.get('state') ?? 'ok';
const config = getKind(kind);
const base = fixtureSummaries.find((row) => row.kind === kind) ?? fixtureSummaries[0]!;
const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const long = 'Integrate multiple Model Context Protocol servers and fix mobile navigation at 360px';
const titles = [long, 'Composer: Return inserts newline on phone', 'Drawer: top 3 chats, sessions, docs',
  'Sheet focus return after dismiss', 'Kill sideways scroll in tool-call chips', 'Readability floor',
  'Scroll restoration on Up', 'Pin kinds sheet mirrors desktop rail', 'Graph view: virtualise edges',
  'Billing rounding question', 'Release notes — October', 'Voice channel echo on Android'];
const owner = { id: 'a1', kind: 'member', displayName: 'Subhang Supercalifragilistic', isAgent: false } as const;
function stateFor(i: number): EntitySummary['state'] {
  switch (kind) {
    case 'work_session':
      return { ...(base.state as object), kind, status: (['running', 'idle', 'exited', 'failed'] as const)[i % 4] } as never;
    case 'task':
      return { ...(base.state as object), kind, status: (['working', 'in_review', 'open', 'blocked'] as const)[i % 4],
        priority: (['urgent', 'high', 'medium', 'low'] as const)[i % 4],
        assignees: i % 3 === 2 ? [] : [{ ...owner, displayName: 'Worker With A Very Long Name' }] } as never;
    case 'channel':
      return { ...(base.state as object), kind, topic: 't', members: [], unreadCount: i < 2 ? 3 : 0, workingAgentCount: 0 } as never;
    default:
      return { ...(base.state as object), kind } as never;
  }
}
const rows: EntitySummary[] = state === 'empty' ? [] : titles.map((title, i) => ({
  ...base, kind: kind as never, id: `row-${i}` as EntitySummary['id'], title,
  parentId: kind === 'work_session' && i >= 1 && i <= 3 ? ('row-0' as never) : null,
  excerpt: kind === 'doc' || kind === 'chat' || kind === 'channel'
    ? 'Chat, top bar and drawer issues ranked by severity, with screenshots at 360, 390 and 430 — and a very long unbroken tail_without_spaces_that_must_not_push_sideways'
    : undefined,
  activityAt: minutes(i * 97), updatedAt: minutes(i * 97), createdBy: owner, deletedAt: null,
  category: 'in_progress', state: stateFor(i),
}));

function App() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const loading = state === 'loading';
  const paging = state === 'paging';
  return (
    <div className="cv2-root" data-shell="mobile" data-theme={params.get('theme') ?? 'dark'}>
      <div className="mobile-frame" style={{ height: '100dvh', position: 'relative' }}>
        <MobileSurfaceProvider sheetHost={host}>
          <PhoneEntityList
            config={config}
            spaceId={FIXTURE_SPACE_ID as never}
            rowsFor={() => (loading ? [] : rows)}
            pageStateOf={() => ({ hasMore: paging, loading: loading || paging })}
            loadMore={() => {}}
            onOpen={(id) => { document.title = `open ${id}`; }}
            {...(config.list.quickCreate ? { onCreate: () => {} } : {})}
            onArchive={() => {}}
          />
        </MobileSurfaceProvider>
        <div className="msheet-host" ref={setHost} />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
