// The bridge People tab (BRIDGE-ENTITY-DESIGN §4.4, D50-D52) on its fixture
// port, for the browser check. ?view=admin|member|empty|error|refuse.
import { createRoot } from 'react-dom/client';
import { BridgePeopleTab } from '../src/bridges/people';
import { FIXTURE_BRIDGE_ID, fixturePort } from '../src/bridges/people/fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'admin';
const theme = params.get('theme') ?? 'light';
const port = view === 'member' ? fixturePort({ admin: false, delayMs: 150 })
  : view === 'empty' ? fixturePort({ items: [], delayMs: 150 })
  : fixturePort({ delayMs: 150 });
if (view === 'error') port.participants = async () => { throw Object.assign(new Error('Bridge is unavailable'), { code: 'not_found' }); };
if (view === 'refuse') {
  port.update = async () => { throw Object.assign(new Error('this participant has linked their own number; only they can unlink it'), { code: 'conflict' }); };
}

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" data-theme={theme} style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--pn-surface)' }}>
    <div className="pn-panel" style={{ maxWidth: 820, margin: '16px auto', border: '1px solid var(--pn-line)', borderRadius: 8, background: 'var(--pn-card)' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--pn-line)', fontSize: 12, color: 'var(--pn-ink-2)' }}>
        ◍ Infra · WhatsApp — <b style={{ color: 'var(--pn-ink)' }}>People</b> <span style={{ color: 'var(--pn-ink-3)' }}>(harness: the panel shell is B2-UI&apos;s)</span>
      </div>
      <BridgePeopleTab
        bridgeId={FIXTURE_BRIDGE_ID}
        port={port}
        onOpenEntity={(id) => { document.title = `open ${id}`; }}
        renderInvite={view === 'admin' ? (p) => <button type="button" className="brp__btn" title="B3's slot">Invite to space</button> : undefined}
      />
    </div>
  </div>,
);
