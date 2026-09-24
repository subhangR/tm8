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
import type { SettingsSectionId } from './settings-space';
import { CredentialsSection, credentialsPortFromSeam, serviceKeysPortFromSeam, sharesPortFromSeam } from './settings-credentials';

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
 * Usage: /settings-dev.html  (?section=credentials opens Agent credentials,
 * with the fixture's TypeSafe service key block; ?theme=light for light)
 */
const seam = createFixtureSeam();
const port = settingsPortFromSeam(seam, FIXTURE_SPACE_ID);
const params = new URLSearchParams(window.location.search);
const section = (params.get('section') ?? 'members') as SettingsSectionId;
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const credentials = (
  <CredentialsSection
    port={credentialsPortFromSeam(seam, FIXTURE_SPACE_ID)}
    serviceKeysPort={serviceKeysPortFromSeam(seam)}
    sharesPort={sharesPortFromSeam(seam, FIXTURE_SPACE_ID)}
  />
);

function Harness() {
  return (
    <div className="cv2-root shell-scope" data-theme={theme}>
      <div className="shell-root">
        <div className="shell-body">
          <SettingsShell port={port} initialSection={section} sections={{ credentials }} />
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
