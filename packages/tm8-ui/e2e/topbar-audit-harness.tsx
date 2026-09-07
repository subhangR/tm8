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
import { SpaceTabBar, SpaceTabBarLegacy, SpaceSwitcher, topBarVersion } from '../src/shell';
import type { ServerRailItem } from '../src/shell/MenuRail';
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

/* THE SAME FORK `GateApp` MAKES, from the same module — so the round trip
   demonstrated here exercises the shipped flag and the shipped legacy bar,
   not a stand-in for them. */
function Harness({ proposed }: { proposed: boolean }) {
  const Bar = topBarVersion() === 'legacy' ? SpaceTabBarLegacy : SpaceTabBar;
  return (
    <div className="cv2-root shell-scope">
      <div className="shell-root">
        <Bar
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
          {...(proposed ? {} : { onOpenInbox: () => undefined })}
          onOpenPalette={() => undefined}
          {...(proposed ? {} : { onOpenPrompts: () => undefined })}
          onOpenAccount={() => undefined}
          accountInitial="A"
          {...(proposed
            ? {}
            : {
                shareSlot: (
                  <CopyLinkControl spaceId={ACTIVE_SPACE} target={{ type: 'view', ref: 'workspace' }} />
                ),
              })}
          accountSlot={
            <AuthActionsContext.Provider value={AUTH}>
              {/* Wired exactly as `GateApp` wires it, so the card measured here
                  is the card that ships — including the three rows the bar
                  handed over. A harness that mounted a barer menu would report
                  a width nobody sees. */}
              <AccountMenu
                actor={ACTOR}
                theme="light"
                onThemeChange={() => undefined}
                onOpenInbox={() => undefined}
                onOpenPrompts={() => undefined}
                onOpenAgentTools={() => undefined}
                utilityRows={
                  <CopyLinkControl
                    className="auth-menu__row auth-menu__row--live"
                    spaceId={ACTIVE_SPACE}
                    target={{ type: 'view', ref: 'workspace' }}
                  />
                }
              />
            </AuthActionsContext.Provider>
          }
        />
      </div>
    </div>
  );
}

/* VARIANT — `?variant=proposed` drops the four controls the redesign moves out
   of the bar, so the SAME harness measures the before and the after in one
   regime. Removing them by not mounting them, rather than by arithmetic on
   max-content widths, is the whole point: a flex row's minimum intrinsic width
   is not the sum of its children's natural widths, and the first version of
   this document made exactly that mistake. */
const VARIANT = new URLSearchParams(window.location.search).get('variant') ?? 'today';

createRoot(document.getElementById('root')!).render(<Harness proposed={VARIANT === 'proposed'} />);

declare global {
  interface Window {
    __topbarAudit: () => unknown;
  }
}

/* THE MEASUREMENT — ONE REGIME, ONE UNIT, AND IT SAYS SO.
 *
 * The first version of this harness mixed two APIs and the numbers it produced
 * were 1.1x apart without saying which was which: `clientWidth`/`scrollWidth`
 * report UNZOOMED CSS px, while `getBoundingClientRect()` reports px AFTER
 * `.cv2-root`'s `zoom: 1.1`. The same account-menu box came back as 310 by one
 * and 280 by the other, and a width budget built from both was not comparable
 * with itself.
 *
 * So: `scale` is DERIVED here rather than read from the stylesheet — the ratio
 * of the bar's own rect to its own clientWidth — and every rect is divided by
 * it. Everything reported below is CSS px inside the zoom scope. `scale` is in
 * the output so a reader can check the conversion rather than trust it.
 *
 * `minIntrinsic` is the number that actually matters and the one the earlier
 * budget table got wrong by summing max-content widths: a nowrap flex row's
 * minimum is not the sum of its children's natural widths. It is read at a
 * width narrow enough that every child is already at its minimum, which is
 * what `scrollWidth` reports once `clientWidth` is below it.
 */
window.__topbarAudit = () => {
  const bar = document.querySelector('.shell-tabbar') as HTMLElement | null;
  if (!bar) return { error: 'no bar' };
  const barRect = bar.getBoundingClientRect();
  const scale = barRect.width / bar.clientWidth;
  const css = (n: number) => Math.round((n / scale) * 10) / 10;
  const kids = Array.from(bar.children).map((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return {
      cls: (el as HTMLElement).className || el.tagName.toLowerCase(),
      text: ((el as HTMLElement).innerText || '').slice(0, 40).replace(/\s+/g, ' '),
      widthCss: css(r.width),
      leftCss: css(r.left - barRect.left),
      rightCss: css(r.right - barRect.left),
      /* Vertical escape: the refusal's reason sentence wraps out of the bar at
         every width, which no horizontal number reports. */
      heightCss: css(r.height),
      overflowsBar: r.height > barRect.height + 0.5,
      clipped: r.right > barRect.right + 0.5,
    };
  });
  return {
    unit: 'CSS px inside the .cv2-root zoom scope',
    scale: Math.round(scale * 1000) / 1000,
    variant: VARIANT,
    viewport: { w: window.innerWidth },
    bar: {
      clientWidth: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
      minIntrinsic: bar.scrollWidth > bar.clientWidth ? bar.scrollWidth : null,
      overflowPx: bar.scrollWidth - bar.clientWidth,
      heightCss: css(barRect.height),
    },
    clippedCount: kids.filter((k) => k.clipped).length,
    verticalEscapes: kids.filter((k) => k.overflowsBar).map((k) => k.cls),
    children: kids,
  };
};
