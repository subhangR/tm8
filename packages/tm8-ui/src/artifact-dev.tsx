import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import { REASONS } from './domain';
import { FIXTURE_SPACE_ID, artifactPulseBoard, fixtureDetails, presenceHollowReason } from './fixtures';
import { createFixtureSeam } from './data/fixtures/seam-fixture';
import { EntityDetailPanel } from './panels';
import type { DetailReasons } from './panels/EntityDetailPanel';

const DETAIL_REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'Sharing is not wired in this harness.',
  withdrawUnavailable: 'Withdrawing is not wired in this harness.',
};

/**
 * ARTIFACT VIEWER SCRATCH HARNESS — same spirit as terminal-dev.tsx: a
 * gate-free mount for pixel-verifying ONE surface, here the artifact detail
 * panel rendering the fixture seam's data:-URL bundle. Not product code and
 * never imported by anything else; the fixture seam means no node, no
 * credentials, no network.
 *
 * Usage: /artifact-dev.html
 */
const seam = createFixtureSeam();

function Harness() {
  return (
    <div className="cv2-root" style={{ minHeight: '100vh', background: 'var(--pn-paper)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <EntityDetailPanel
          detail={fixtureDetails[artifactPulseBoard.id]!}
          reasons={DETAIL_REASONS}
          ctx={{ spaceId: FIXTURE_SPACE_ID }}
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
