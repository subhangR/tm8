import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import { getKind } from './domain';
import { artifactPulseBoard, fixtureDetails } from './fixtures';
import { createFixtureSeam } from './data/fixtures/seam-fixture';
import { GenericBody } from './panels/bodies/GenericBody';

/**
 * ARTIFACT VIEWER SCRATCH HARNESS — same spirit as terminal-dev.tsx: a
 * gate-free mount for pixel-verifying ONE surface, here the artifact viewer
 * block rendering the fixture seam's data:-URL bundle. Not product code and
 * never imported by anything else; the fixture seam means no node, no
 * credentials, no network.
 *
 * It mounts `GenericBody` with the registry's own artifact blocks — NOT
 * `EntityDetailPanel` — for the same reason terminal-dev mounts LiveTerminal
 * bare: the harness's subject is the viewer, and a full panel mount would
 * (rightly) owe the mount-conformance sweeps every host surface
 * (`panel-host-wiring.test.ts` / `panel-primaries-wired.test.tsx`). Those
 * locks exist to keep REAL hosts complete; a dev harness neither needs the
 * surfaces nor deserves an exemption.
 *
 * Usage: /artifact-dev.html
 */
const seam = createFixtureSeam();

function Harness() {
  return (
    <div className="cv2-root" style={{ minHeight: '100vh', background: 'var(--pn-paper)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <GenericBody
          detail={fixtureDetails[artifactPulseBoard.id]!}
          blocks={getKind(artifactPulseBoard.kind).panel?.blocks ?? []}
          commands={seam.commands}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
