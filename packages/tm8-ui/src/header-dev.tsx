import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityDetail, SpaceId } from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import './authoring/authoring.css';
import './panels/honesty/honesty.css';
import { EntityDetailPanel } from './panels';
import { EntityCreateControl } from './authoring';
import { createFixtureSeam } from './data/fixtures/seam-fixture';
import { FIXTURE_SPACE_ID, docLayoutSpec, presenceHollowReason } from './fixtures';
import { getKind, REASONS } from './domain';

/**
 * SELECTION HEADER SCRATCH HARNESS (I9a) — a gate-free mount of the panel's
 * HEADER section and the doc create's "with header…", over the FIXTURE seam,
 * for pixel verification (jsdom loads no stylesheets). Not product code.
 *
 * Usage: /header-dev.html
 */

const seam = createFixtureSeam();
const SPACE = FIXTURE_SPACE_ID as SpaceId;
const reasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: REASONS.versionHistoryDeferred,
  provenanceHollow: 'n/a',
  shareUnavailable: 'n/a',
  withdrawUnavailable: 'n/a',
};

function Harness() {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [id, setId] = useState<string>(docLayoutSpec.id);
  React.useEffect(() => {
    void seam.entity(id).then(setDetail);
  }, [id]);
  const refresh = () => void seam.entity(id).then(setDetail);
  return (
    <div className="cv2-root" style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start', minHeight: '100vh', background: 'var(--pn-paper)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <EntityCreateControl
          config={getKind('doc')}
          immediate={{ state: { phase: 'idle' }, unavailable: null, unavailableFor: () => null, create: async () => {}, dismiss: () => {} }}
          spaceId={SPACE}
          commands={seam.commands}
          files={seam.files}
          onCreated={(newId) => setId(newId)}
        />
        <button type="button" className="pn-btn" onClick={() => void seam.commands.patchEntity(id, { title: `${detail?.title ?? ''}.`, expectedVersion: detail?.version ?? 0 }).then(refresh)}>
          bump body version
        </button>
      </div>
      <div style={{ width: 560, height: 720, display: 'flex' }}>
        {detail ? (
          <EntityDetailPanel
            detail={detail}
            reasons={reasons}
            ctx={{ spaceId: SPACE }}
            activeTab="connections"
            commands={seam.commands}
            onSaved={(result) => { if (result.entity) setDetail(result.entity); }}
          />
        ) : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
