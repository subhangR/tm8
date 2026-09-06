import { createRoot } from 'react-dom/client';
import type { SpaceId, SpaceSummary } from '@tm8/contract';
import { SpaceTabBar } from '../src/shell/SpaceTabBar';
import { SpaceSwitcher } from '../src/shell/SpaceSwitcher';
import type { ServerRailItem } from '../src/shell/MenuRail';
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/auth/auth.css';
import '../src/shell/shell.css';

const tabs = [
  ['home', 'Home'],
  ['work', 'Work'],
  ['board', 'Board'],
  ['craft', 'Craft'],
  ['graph', 'Graph'],
  ['codebrain', 'CodeBrain'],
  ['settings', 'Settings'],
  ['help', 'Help'],
].map(([id, label]) => ({ id: id!, label: label! }));

const servers: readonly ServerRailItem[] = [
  { id: 'utho', label: 'utho production server', local: false, reachability: 'online' },
];

const spaces: readonly SpaceSummary[] = [
  { id: 'space-befree' as SpaceId, name: 'Subhang · BeFree production workspace' },
];

function Harness() {
  return (
    <div className="cv2-root" data-shell="desktop" data-testid="harness-ready">
      <SpaceTabBar
        tabs={tabs}
        activeTabId="work"
        onGoHome={() => {}}
        onOpenPalette={() => {}}
        onOpenInbox={() => {}}
        accountSlot={(
          <button type="button" className="auth-accountmenu__trigger" aria-label="Account: Subhang">
            <span className="auth-avatar auth-avatar--sm" aria-hidden>S</span>
            <span className="auth-accountmenu__name">Subhang</span>
            <span className="auth-accountmenu__caret" aria-hidden>▾</span>
          </button>
        )}
        switcherSlot={(
          <SpaceSwitcher
            servers={servers}
            activeServerId="utho"
            spaces={spaces}
            activeSpaceId={'space-befree' as SpaceId}
            collapsed={false}
            onSelectServer={() => {}}
            onSelectSpace={() => {}}
          />
        )}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
