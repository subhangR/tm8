/**
 * TOP BAR AUDIT HARNESS — the REAL `SpaceTabBar`, with the real slots the
 * shipped app mounts into it, measured at a range of viewport widths.
 *
 * WHY THIS EXISTS. The owner's report (task 01a07a56) is "in different screens
 * of windows chrome, macbook chrome … the UI is not adjusting". jsdom loads no
 * stylesheets and has no layout engine, so nothing in the vitest suite can see
 * whether this row fits. `shell.css` contains ZERO `@media` rules for the bar,
 * and `app.css` puts `zoom: 1.1` on `.cv2-root`, so the bar's real width budget
 * is `viewportWidth / 1.1`. Both facts are only visible with a layout engine.
 *
 * FIXTURES, NOT THE REAL SEAM — same reason as `category-tabs-harness`: what is
 * under test is GEOMETRY, and fixtures put the shipped shape on screen
 * deterministically with no server and no sign-in. The fixture values are read
 * off the owner's own screenshots so the measurement is of the bar they filed.
 *
 * `window.__topbarAudit()` returns the measurement Playwright reads.
 */
import { createRoot } from 'react-dom/client';
import type { SpaceId, SpaceSummary } from '@tm8/contract';
import { SpaceTabBar, SpaceSwitcher } from '../src/shell';
import type { ServerRailItem } from '../src/shell/MenuRail';
import { UiVersionSwitch } from '../src/ui-version';
import { CopyLinkControl } from '../src/share/CopyLinkControl';
import { AccountMenu } from '../src/auth/AccountMenu';
import { AuthActionsContext, type AuthActions } from '../src/auth/gate-context';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/auth/auth.css';
import '../src/prompts/prompts.css';
import '../src/share/copy-link.css';

/* The owner's screenshot, as data. The switcher reads "Utho Prod" (the SPACE)
   over "local · this machine" (the SERVER); the popover lists the local
   server's five other spaces. */
const SERVERS: readonly ServerRailItem[] = [
  { id: 'local', label: 'local · this machine', local: true, reachability: 'online' },
];
const SPACE_NAMES = ['Northlake demo', 'abhi', 'Office_Space', 'Tharak', 'Utho Prod'];
const SPACES = SPACE_NAMES.map((name, i) => ({
  id: `0000000${i}-0000-7000-8000-00000000000${i}` as SpaceId,
  name,
})) as unknown as readonly SpaceSummary[];
const ACTIVE_SPACE = SPACES[4]!.id;

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'work', label: 'Work' },
  { id: 'board', label: 'Board' },
  { id: 'craft', label: 'Craft' },
  { id: 'graph', label: 'Graph' },
  { id: 'codebrain', label: 'CodeBrain' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
];

/* The stub gate. `AccountMenu` renders NOTHING without one (deliberately: a
   menu with no account and no sign-out verb is the enabled-inert defect), so a
   harness that omitted it would measure a bar the owner has never seen. */
const AUTH: AuthActions = {
  account: { handle: 'tarkesh', isOwner: false } as AuthActions['account'],
  accounts: [],
  createAccount: async () => undefined,
  claimNode: async () => undefined,
  signIn: async () => undefined,
  signOut: async () => undefined,
  clearFailure: () => undefined,
  failure: null,
  busy: false,
  nodeClaim: null,
} as unknown as AuthActions;

const ACTOR = {
  id: '019fd18d-1a1c-7542-943a-2a0861eb39c0',
  kind: 'member',
  displayName: 'Tarkesh',
  avatar: null,
  isAgent: false,
} as never;

/* The probe the shipped control makes. Prod answers "no 2.0 bundle here", which
   is the state in the screenshot — the refusal whose reason sentence overflows
   into its neighbours. */
const absentFetcher = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

function Harness() {
  return (
    <div className="cv2-root shell-scope">
      <div className="shell-root">
        <SpaceTabBar
          switcherSlot={
            <SpaceSwitcher
              servers={SERVERS}
              activeServerId="local"
              spaces={SPACES}
              activeSpaceId={ACTIVE_SPACE}
              collapsed={false}
              onSelectServer={() => undefined}
              onSelectSpace={() => undefined}
              onAddServer={() => undefined}
              onAddSpace={() => undefined}
            />
          }
          tabs={TABS}
          activeTabId="home"
          onSelectTab={() => undefined}
          onGoHome={() => undefined}
          onOpenInbox={() => undefined}
          onOpenPalette={() => undefined}
          onOpenPrompts={() => undefined}
          onOpenAccount={() => undefined}
          accountInitial="A"
          uiSwitchSlot={<UiVersionSwitch fetcher={absentFetcher} />}
          shareSlot={
            <CopyLinkControl spaceId={ACTIVE_SPACE} target={{ type: 'view', ref: 'workspace' }} />
          }
          accountSlot={
            <AuthActionsContext.Provider value={AUTH}>
              <AccountMenu actor={ACTOR} theme="light" onThemeChange={() => undefined} />
            </AuthActionsContext.Provider>
          }
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);

declare global {
  interface Window {
    __topbarAudit: () => unknown;
  }
}

/* THE MEASUREMENT. `scrollWidth > clientWidth` on the header is the overflow
   itself; `worstRightEdge` beyond the header's right edge names WHICH control
   is off-screen, which a single boolean cannot. Reported in CSS px INSIDE the
   zoom scope — the numbers a `getBoundingClientRect` in the app would give. */
window.__topbarAudit = () => {
  const bar = document.querySelector('.shell-tabbar') as HTMLElement | null;
  if (!bar) return { error: 'no bar' };
  const barRect = bar.getBoundingClientRect();
  const kids = Array.from(bar.children).map((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return {
      cls: (el as HTMLElement).className || el.tagName.toLowerCase(),
      text: ((el as HTMLElement).innerText || '').slice(0, 40).replace(/\s+/g, ' '),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
      clipped: r.right > barRect.right + 0.5,
    };
  });
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    zoom: getComputedStyle(document.querySelector('.cv2-root')!).zoom,
    bar: {
      clientWidth: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
      overflowPx: bar.scrollWidth - bar.clientWidth,
      height: Math.round(barRect.height),
      right: Math.round(barRect.right),
    },
    clippedCount: kids.filter((k) => k.clipped).length,
    worstRightEdge: Math.max(...kids.map((k) => k.right)),
    children: kids,
  };
};
