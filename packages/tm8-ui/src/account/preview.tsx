/**
 * DEV-ONLY REVIEW SURFACE for T3-3 — never product, never imported by the app.
 *
 * It exists because of the brief's hardest law: "the screen is verified by
 * LOOKING at it". jsdom cannot see a clipped label, an unresolved height or a
 * popover that lands off-screen — every defect that reached HEAD on this build
 * was found by rendering the thing. This lane may not edit any existing file,
 * so it cannot mount the menu into the app to look at it; a standalone page
 * inside the lane is the only way to satisfy the law without crossing a
 * boundary. Precedent: `auth/AuthBoard.tsx`, the same idea for T3.
 *
 * Serve: the running dev server already hosts it —
 *   http://127.0.0.1:4612/src/account/preview.html
 *
 * The toggles are the states that matter for honesty review: every control
 * refused (the build's TRUE default today) vs every control wired (what the
 * menu becomes as executors land), plus the worst-case identity the oracle
 * itself tests with, and the 320 floor.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { IdentityView } from '../data/seam';
import { AccountMenu, type AccountTheme } from './index';

const SPACE = 'spc-atelier';

const NICE: IdentityView = {
  identityId: 'idn-ada',
  accountId: 'acct-ada',
  username: 'ada',
  displayName: 'ada',
  avatar: null,
  email: 'ada@loopback',
  globalId: null,
  isNodeAdmin: true,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: SPACE, memberId: 'ent-member-ada', role: 'owner' }],
};

/** The oracle's own worst case — long name, long address, both must ellipsize. */
const WORST: IdentityView = {
  ...NICE,
  displayName: 'Adelaide Konstantina Lovelace-Kowalczyk',
  email: 'adelaide.konstantina.lovelace-kowalczyk@loopback',
};

function Preview() {
  const [theme, setThemeState] = useState<AccountTheme>('light');
  const [isSystemDefault, setSystem] = useState(false);
  const [wired, setWired] = useState(false);
  const [worst, setWorst] = useState(false);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(true);

  const noop = () => undefined;

  return (
    <div className="cv2-root" data-astryx-theme="neutral" data-theme={theme} style={{ minHeight: '100vh' }}>
      <div style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        <button type="button" onClick={() => setThemeState(theme === 'light' ? 'dark' : 'light')}>
          {`theme: ${theme}`}
        </button>
        <button type="button" onClick={() => setSystem((v) => !v)}>
          {`isSystemDefault: ${isSystemDefault}`}
        </button>
        <button type="button" onClick={() => setWired((v) => !v)}>
          {wired ? 'executors: ALL WIRED' : 'executors: none (today’s truth)'}
        </button>
        <button type="button" onClick={() => setWorst((v) => !v)}>
          {worst ? 'identity: worst case' : 'identity: nice'}
        </button>
        <button type="button" onClick={() => setPending((v) => !v)}>
          {pending ? 'identity: not loaded' : 'identity: loaded'}
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'menu: open' : 'menu: closed'}
        </button>
        <p style={{ width: '100%', margin: 0, opacity: 0.7 }}>
          Narrow the window under 380px to see the 320 floor: the menu clamps to viewport − 16 and
          the theme words compact to glyphs (their accessible names do not).
        </p>
      </div>

      {open ? (
        <AccountMenu
          identity={pending ? null : worst ? WORST : NICE}
          identityError={pending ? 'preview: the identity read has not returned' : undefined}
          spaceId={SPACE}
          theme={{
            theme,
            isSystemDefault,
            setTheme: (t) => {
              setThemeState(t);
              setSystem(false);
            },
            useSystem: wired ? () => setSystem(true) : undefined,
          }}
          onOpenProfile={wired ? noop : undefined}
          onOpenNodeSettings={wired ? noop : undefined}
          onSignOut={wired ? noop : undefined}
          runningLabel={wired ? 'forge and scout' : undefined}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
