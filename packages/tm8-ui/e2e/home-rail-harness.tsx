import { createRoot } from 'react-dom/client';
import { HomeRail } from '../src/views/HomeRail';
import { homeRailGroups } from '../src/domain';
import { HOME_RAIL_COLLAPSED, HOME_RAIL_EXPANDED } from '../src/views/HomeView';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/home-page/home-page.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR HOME'S ICON RAIL — the sibling of
 * `menu-rail-harness.tsx`, and it exists for the same reason that one does.
 *
 * Task 01a0ada5 re-cut the rail into seven labelled groups and made the group
 * eyebrow draw at BOTH widths, on the argument that a heading the default
 * (collapsed, 72px) state hides is a heading that does not exist. That is a
 * claim about PIXELS: that every one of the seven labels sets inside 72px
 * without ellipsis, that adding six group separators did not push the rail
 * into a horizontal scroll, and that the rows still read as a column. jsdom
 * loads no stylesheet and measures no box, so `home-rail.test.ts` can only
 * prove the heading is RENDERED; whether it can be READ is answerable here.
 */
function Pane({ caption, collapsed, theme }: { caption: string; collapsed: boolean; theme?: 'dark' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ font: '11px ui-monospace, monospace', color: '#666' }}>{caption}</div>
      <div
        className="cv2-root"
        data-theme={theme}
        data-pane={caption}
        style={{
          ['--hp-rail' as string]: `${collapsed ? HOME_RAIL_COLLAPSED : HOME_RAIL_EXPANDED}px`,
          height: 980,
          display: 'flex',
          background: 'var(--pn-paper)',
        }}
      >
        <HomeRail
          groups={homeRailGroups()}
          activeKind="task"
          onSelect={() => {}}
          collapsed={collapsed}
          onToggleCollapsed={() => {}}
        />
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div style={{ display: 'flex', gap: 28, padding: 16, alignItems: 'flex-start' }}>
      <Pane caption={`collapsed ${HOME_RAIL_COLLAPSED}px`} collapsed />
      <Pane caption={`expanded ${HOME_RAIL_EXPANDED}px`} collapsed={false} />
      <Pane caption="collapsed dark" collapsed theme="dark" />
      <span data-testid="harness-ready" />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
