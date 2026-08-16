import { createRoot } from 'react-dom/client';
import { MenuRail, type KindPresenter, type RefPresentation } from '../src/shell/MenuRail';
import { SHIPPED_DEFAULT_MENU } from '../src/domain';
import { MENU_COLLAPSED, MENU_EXPANDED } from '../src/shell/geometry';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR THE COLLAPSED RAIL.
 *
 * The deliverable is "icon rail WITH TEXT BELOW THE ICONS" — a claim about
 * pixels: that every caption is legible at 72px, that the longest one
 * (`Pull requests`) wraps to a second line instead of being clipped, and that
 * the column reads as a column in both themes. jsdom loads no stylesheet and
 * measures no box, so the vitest suite can only prove the WORD IS RENDERED;
 * whether it can be READ is only answerable here.
 *
 * The three panes are the comparison the ruling is about: collapsed beside
 * expanded, and collapsed again in dark.
 */
const presentKind: KindPresenter = (ref) => {
  const table: Record<string, RefPresentation> = {
    task: { label: 'Tasks', icon: '◔', badge: 18, unseen: 4 },
    work_session: { label: 'Sessions', icon: '▣', live: 3 },
    doc: { label: 'Docs', icon: '▤' },
    channel: { label: 'Channels', icon: '#' },
    team_member: { label: 'Teammates', icon: '◯' },
    memory: { label: 'Memories', icon: '◈' },
    artifact: { label: 'Artifacts', icon: '❖' },
    loop: { label: 'Loops', icon: '↻' },
    file: { label: 'Files', icon: '▥' },
    project: { label: 'Projects', icon: '⬒' },
    pull_request: { label: 'Pull requests', icon: '⑂', unseen: 2 },
    worktree: { label: 'Worktrees', icon: '⑂' },
    member: { label: 'Members', icon: '◯' },
  };
  return table[ref] ?? null;
};

function Pane({
  caption,
  collapsed,
  theme,
}: {
  caption: string;
  collapsed: boolean;
  theme?: 'dark';
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ font: '11px ui-monospace, monospace', color: '#666' }}>{caption}</div>
      <div
        className="cv2-root"
        data-theme={theme}
        data-pane={caption}
        style={{
          width: collapsed ? MENU_COLLAPSED : MENU_EXPANDED,
          height: 760,
          display: 'flex',
          background: 'var(--pn-bg)',
        }}
      >
        <MenuRail
          config={SHIPPED_DEFAULT_MENU}
          collapsed={collapsed}
          onToggle={() => {}}
          onNavigate={() => {}}
          presentKind={presentKind}
        />
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div style={{ display: 'flex', gap: 28, padding: 16, alignItems: 'flex-start' }}>
      <Pane caption={`collapsed ${MENU_COLLAPSED}px`} collapsed />
      <Pane caption={`expanded ${MENU_EXPANDED}px`} collapsed={false} />
      <Pane caption="collapsed dark" collapsed theme="dark" />
      <span data-testid="harness-ready" />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
