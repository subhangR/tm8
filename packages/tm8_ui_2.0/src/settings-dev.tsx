import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import './panels/panels.css';
import { createFixtureSeam, FIXTURE_SPACE_ID } from './data/fixtures/seam-fixture';
import { SettingsShell, settingsPortFromSeam } from './settings-space';

/**
 * SETTINGS SHELL SCRATCH HARNESS — same spirit as `artifact-dev.tsx`: a
 * gate-free mount for pixel-verifying ONE surface, here the settings card's
 * placement inside the shell's own body row.
 *
 * The nesting below is NOT decoration. `GateApp` renders `<SettingsShell>` as a
 * direct child of `.shell-body` (through a Fragment-only error boundary), and
 * `.shell-body` is `display: flex` — so how wide `.set-root` gets is decided by
 * that flex row, not by anything inside `settings.css`. A harness that mounted
 * the shell in a plain full-width div would reproduce nothing.
 *
 * Usage: /settings-dev.html
 */
const seam = createFixtureSeam();
const port = settingsPortFromSeam(seam, FIXTURE_SPACE_ID);

function Harness() {
  return (
    <div className="cv2-root shell-scope" data-theme="dark">
      <div className="shell-root">
        <div className="shell-body">
          <SettingsShell port={port} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
