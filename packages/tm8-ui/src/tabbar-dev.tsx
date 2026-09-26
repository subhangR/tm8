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
import { StatusSegment } from './status-strip/StatusSegment';
import './status-strip/status-strip.css';

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
/* THE ONE-ROW BAR (owner, 2026-09-26): the status strip in the bar's right
   zone, built from the REAL segment component and the values in the owner's
   screenshot, so the shed rungs are measured against the widths prod draws. */
const STATUS = (
  <div className="status-strip status-strip--in-bar" role="region" aria-label="System status">
    <StatusSegment label="Attention" value="28" onClick={() => {}} />
    <StatusSegment label="CPU" value="32%" shed={5} />
    <StatusSegment label="Mem" value="10.9 / 16 GB" shed={4} />
    <StatusSegment label="Load" value="10.67" tone="warn" shed={3} />
    <StatusSegment label="Disk" value="97%" tone="alert" shed={2} />
    <StatusSegment label="tm8" value="175 MB" shed={1} />
    <StatusSegment label="Sessions" value="1" shed={7} />
    <StatusSegment label="Chats" value="1" shed={6} />
  </div>
);
const STATUS_WIDTHS = [1700, 1641, 1551, 1471, 1381, 1241, 1191, 1111, 1061, 981, 911, 800, 691, 611, 560];

function Row({ width, status = false }: { width: number; status?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('board-v2');
  const [report, setReport] = useState('');
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      const bar = el.querySelector<HTMLElement>('.shell-tabbar')!;
      const over =
        [bar, ...bar.querySelectorAll<HTMLElement>('.shell-tabbar__zone, .status-strip')].some(
          (n) => n.scrollWidth > n.clientWidth + 1,
        ) ||
        [...bar.querySelectorAll<HTMLElement>('.shell-tabbar__zone--trail > *')].some(
          (n) => n.getBoundingClientRect().height > 30,
        );
      const pill = el.querySelector<HTMLElement>('.shell-tabbar__views')!;
      const form = getComputedStyle(pill).display === 'none' ? 'SELECT' : 'pill';
      const tabs = el.querySelector<HTMLElement>('.shell-tabbar__tabs')!;
      const shown = [...el.querySelectorAll<HTMLElement>('.status-strip__segment')]
        .filter((n) => getComputedStyle(n).display !== 'none')
        .map((n) => n.querySelector('.status-strip__label')?.textContent)
        .join(',');
      setReport(
        `${over ? 'OVERFLOW' : 'fits'} · ${form} · centre ${Math.round(tabs.getBoundingClientRect().width)}px` +
          (status ? ` · strip [${shown}]` : ''),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return (
    <div style={{ margin: '0 0 14px' }}>
      <div style={{ font: '11px monospace', color: '#666', margin: '0 0 3px' }}>
        {width}px{status ? ' +status' : ''} — <b data-testid={`report-${status ? 's' : ''}${width}`}>{report}</b>
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
          accountSlot={<span style={{ font: '12px system-ui', whiteSpace: 'nowrap' }}>◯ Subhang</span>}
          {...(status ? { statusSlot: STATUS } : {})}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" style={{ padding: 16, overflow: 'auto', height: '100vh' }}>
    {STATUS_WIDTHS.map((w) => (
      <Row key={`s${w}`} width={w} status />
    ))}
    {WIDTHS.map((w) => (
      <Row key={w} width={w} />
    ))}
  </div>,
);
