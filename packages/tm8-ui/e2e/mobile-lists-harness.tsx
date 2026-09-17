import { createRoot } from 'react-dom/client';
import type { EntitySummary } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import { MobileSurfaceProvider } from '../src/mobile';
import { fixtureSummaries, FIXTURE_SPACE_ID } from '../src/fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/mobile/mobile.css';
import '../src/mobile/mobile-chrome.css';
import '../src/mobile/mobile-screens.css';

// Real list components, with crowded, deterministic fixtures and no server writes.
const params = new URLSearchParams(location.search);
const kind = params.get('kind') === 'session' ? 'work_session' : 'task';
const base = fixtureSummaries.find((row) => row.kind === kind)!;
const rows = [
  'TM8 Terminal Streaming',
  'Integrate multiple Model Context Protocol servers and fix mobile navigation',
  'Task List — Organize Look and Feel of it',
].map((title, index): EntitySummary => ({
  ...base,
  id: `mobile-row-${index}` as EntitySummary['id'],
  title, parentId: null, category: 'in_progress', deletedAt: null,
  state: { ...base.state, status: 'working', dueDate: null, startDate: null,
    checkoutBranch: 'tm8/01a0af27-8fd5-7019-8c8b-5d0d02850272', workdirMode: 'worktree',
  } as EntitySummary['state'],
  counters: { ...base.counters, messages: 20 },
}));
const list = <EntityListPanel
  kind={kind} rowsFor={() => rows} ctx={{ spaceId: FIXTURE_SPACE_ID }}
  capabilitiesOf={() => ({ canEdit: true, canDelete: true, canAddChild: true,
    canLink: true, canPull: true, canReact: true, canGrantPoints: true, canComplete: true })}
  linkedPullRequestsOf={() => [624, 625].map((number) => ({
    id: `pr-${number}`, title: 'Mobile list repair', repository: 'tm8', number,
    lifecycle: 'open', url: null, ciStatus: 'passing', mergeState: 'clean',
    headRef: null, attribution: 'tracked',
  }))}
  livenessOf={() => 'live'} onSetState={() => {}} onSetValue={() => {}}
  onComplete={() => {}} onArchive={() => {}} onAction={() => {}} onTerminate={() => {}}
  onMembership={() => {}} onAssign={() => {}}
  membershipSets={[]} assignableActors={[]}
  connectionsOf={() => ({ incoming: [], outgoing: [], unresolvedHardDependencyCount: 0 })}
/>;
const mobile = params.get('desktop') !== '1';
createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" data-shell={mobile ? 'mobile' : 'desktop'} data-theme={params.get('theme') ?? 'light'}>
    <div className={mobile ? 'mobile-frame' : ''} style={{ height: '100dvh', maxWidth: mobile ? undefined : 560 }}>
      {mobile ? <MobileSurfaceProvider sheetHost={null}>{list}</MobileSurfaceProvider> : list}
    </div>
  </div>,
);
