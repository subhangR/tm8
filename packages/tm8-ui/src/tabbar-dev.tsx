import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import { SpaceTabBar, type ShellTab } from './shell';
import { VectorIcon } from './kit';
import { VIEW_ART } from './domain';

/**
 * TOP BAR SCRATCH HARNESS (task 01a0dc6d) — a gate-free mount of the real
 * `SpaceTabBar` at fixed widths, because the View switcher's fold is a
 * CONTAINER QUERY and jsdom loads no stylesheet: no vitest can say at which
 * width the pill folds or whether the row overflows before it does.
 *
 * Each row prints its width, whether its content overflows (scrollWidth >
 * clientWidth on any zone), and which switcher form is visible. Widths are
 * the bar's own CSS width; `app.css`'s `zoom: 1.1` applies on top, as in prod.
 */
const glyph = (paths: readonly string[]) => <VectorIcon paths={paths} size={13} />;
const VIEWS: ShellTab[] = [
  { id: 'chats', label: 'Home', glyph: glyph(VIEW_ART.dashboard) },
  { id: 'work', label: 'Work', glyph: glyph(VIEW_ART.workspace) },
  { id: 'board-v2', label: 'Board', glyph: glyph(VIEW_ART.board) },
  { id: 'graph', label: 'Graph', glyph: glyph(VIEW_ART.graph) },
];
const TABS: ShellTab[] = [
  { id: 'craft', label: 'Craft' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
];
/* A static stand-in for `SpaceSwitcher`'s trigger, carrying its REAL class
   names so rung 4 (monogram-only at 820) fires here as it does in the app. A
   bare span would leave the lead zone wider than production at narrow widths
   and understate the fold margin. */
const SWITCHER = (
  <div className="shell-switcher">
    <button type="button" className="shell-switcher__trigger">
      <span className="shell-switcher__monogram" aria-hidden="true">M</span>
      <span className="shell-switcher__names">
        <span className="shell-switcher__space">My space</span>
        <span className="shell-switcher__server-line">tm8</span>
      </span>
      <span className="shell-switcher__caret" aria-hidden="true">▸</span>
    </button>
  </div>
);
const WIDTHS = [1400, 1100, 900, 800, 760, 720, 680, 640, 600, 560];

function Row({ width }: { width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('board-v2');
  const [report, setReport] = useState('');
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      const bar = el.querySelector<HTMLElement>('.shell-tabbar')!;
      const over = [bar, ...bar.querySelectorAll<HTMLElement>('.shell-tabbar__zone')].some(
        (n) => n.scrollWidth > n.clientWidth + 1,
      );
      const pill = el.querySelector<HTMLElement>('.shell-tabbar__views')!;
      const form = getComputedStyle(pill).display === 'none' ? 'SELECT' : 'pill';
      const tabs = el.querySelector<HTMLElement>('.shell-tabbar__tabs')!;
      setReport(`${over ? 'OVERFLOW' : 'fits'} · ${form} · centre ${Math.round(tabs.getBoundingClientRect().width)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return (
    <div style={{ margin: '0 0 14px' }}>
      <div style={{ font: '11px monospace', color: '#666', margin: '0 0 3px' }}>
        {width}px — <b data-testid={`report-${width}`}>{report}</b>
      </div>
      <div ref={ref} style={{ width, border: '1px dashed #bbb' }}>
        <SpaceTabBar
          switcherSlot={SWITCHER}
          viewTabs={VIEWS}
          tabs={TABS}
          activeTabId={active}
          onSelectTab={setActive}
          onGoHome={() => {}}
          onOpenPalette={() => {}}
          accountSlot={<span style={{ font: '12px system-ui' }}>◯ Subhang</span>}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" style={{ padding: 16, overflow: 'auto', height: '100vh' }}>
    {WIDTHS.map((w) => (
      <Row key={w} width={w} />
    ))}
  </div>,
);
