// Bridges B3 (§4.6, D60) for the browser check: Account → Linked identities
// through the real SettingsShell, port and fixture seam (?view=settings), and
// the Invite to space action as P's renderInvite slot draws it (?view=invite).
import { createRoot } from 'react-dom/client';
import { createFixtureSeam } from '../src/data';
import { settingsPortFromSeam } from '../src/settings-space/port';
import { SettingsShell } from '../src/settings-space/SettingsShell';
import { InviteToSpace } from '../src/bridges/invite';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/settings-space/settings.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'settings';
const theme = params.get('theme') ?? 'light';
const stacked = params.get('stacked') === '1';
const root = createRoot(document.getElementById('root')!);
const frame = (child: React.ReactNode) => (
  <div className={`cv2-root${stacked ? ' set-root--stacked' : ''}`} data-theme={theme}
    style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--pn-surface)' }}>{child}</div>
);

void (async () => {
  const seam = createFixtureSeam();
  const spaceId = (await seam.spaces())[0]!.id;
  if (view === 'invite') {
    const refuse = params.get('refuse') === '1';
    root.render(frame(
      <div style={{ maxWidth: 760, margin: '16px auto', border: '1px solid var(--pn-line)', borderRadius: 8, background: 'var(--pn-card)', padding: 14, fontSize: 12, color: 'var(--pn-ink)' }}>
        <div style={{ color: 'var(--pn-ink-2)', marginBottom: 10 }}>◍ Infra · WhatsApp — People (harness: the row is P&apos;s; the action is B3&apos;s)</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', borderTop: '1px solid var(--pn-line)', padding: '10px 0' }}>
          <b>Rahul</b><span style={{ fontFamily: 'var(--pn-mono)', color: 'var(--pn-ink-2)' }}>+91 9190 0000 0002</span>
          <span style={{ color: 'var(--pn-ink-3)' }}>guest · 14 messages</span>
          <span style={{ marginLeft: 'auto' }} />
        </div>
        <InviteToSpace spaceId={spaceId} bridgeId="11111111-1111-7111-8111-111111111111"
          participant={{ externalId: '919000000002@s.whatsapp.net', displayName: 'Rahul' }}
          createInvite={refuse
            ? async () => { throw new Error('this participant is already linked to a tm8 account'); }
            : (s, input) => seam.commands.createInvite(s, input)} />
      </div>,
    ));
    return;
  }
  root.render(frame(
    <SettingsShell port={settingsPortFromSeam(seam, spaceId)} initialSection="linked-identities" stacked={stacked} />,
  ));
})();
