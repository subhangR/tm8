import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import { createFixtureSeam, FIXTURE_SPACE_ID } from './data/fixtures/seam-fixture';
import { CredentialsSetupDialog, credentialsPortFromSeam } from './settings-credentials';

/**
 * CREDENTIAL SETUP SCRATCH HARNESS — the `settings-dev` pattern, for the one
 * thing no vitest in this repo can settle: what the dialog LOOKS like.
 *
 * jsdom loads no stylesheets, so the suite cannot see the scrim, the card's
 * max-height, whether the body scrolls instead of pushing the footer off the
 * viewport, or whether the terminal disclosure fits. Those are exactly the
 * failures the surface this replaces shipped. This mounts the real dialog over
 * a stand-in canvas so they can be looked at.
 *
 * The theme toggle is here because the tokens swap under [data-theme] and a
 * dialog verified in one theme is verified in one theme.
 *
 * Usage: /credsetup-dev.html
 */
const seam = createFixtureSeam();
const port = credentialsPortFromSeam(seam, FIXTURE_SPACE_ID);

function Harness() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [open, setOpen] = useState(true);

  return (
    <div className="cv2-root shell-scope" data-theme={theme} style={{ height: '100vh' }}>
      <div className="shell-root" style={{ height: '100%' }}>
        <div className="shell-body" style={{ padding: 20 }}>
          <button type="button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
            theme: {theme}
          </button>
          <button type="button" onClick={() => setOpen(true)} style={{ marginLeft: 8 }}>
            reopen
          </button>
        </div>
      </div>
      <CredentialsSetupDialog
        open={open}
        port={port}
        onDismiss={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
