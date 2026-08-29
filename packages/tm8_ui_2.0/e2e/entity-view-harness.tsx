import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import type { DetailReasons } from '../src/panels';
import { EntityView } from '../src/views/EntityView';
import { useGateData } from '../src/views/useGateData';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR `EntityView`, and the reason it exists:
 * the 2026-07-31 three-region layout is a claim about WIDTHS, and jsdom has no
 * layout engine — `getBoundingClientRect` there returns zeros, so the vitest
 * suite can assert that the regions EXIST and structurally cannot assert that
 * the list is 320px, that the detail actually takes the remaining width, or
 * that opening the aux column does not crush the centre.
 *
 * This mounts the REAL component over the fixture seam (same injection port
 * `useGateData` already exposes for tests), so what Playwright measures is the
 * shipping component under the shipping stylesheet — not a mock of either.
 *
 * `?kind=` selects the screen; it defaults to `doc`, the kind this layout was
 * ruled for and verified against.
 */
const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

function Harness() {
  const kind = new URLSearchParams(window.location.search).get('kind') ?? 'doc';
  // One seam for the harness's lifetime, for the same reason the app holds
  // one: two would mean two event streams and a divided cache.
  const seam = useMemo(() => createFixtureSeam(), []);
  const data = useGateData({ leftKind: kind, rightKind: 'task', seam });

  if (!data.ready) {
    return <div data-testid="harness-booting">booting…</div>;
  }

  return (
    <div className="cv2-root" data-testid="harness-ready" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <EntityView
        data={data}
        kind={kind}
        reasons={REASONS}
        viewerMemberId="ada"
        onNotice={() => undefined}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
