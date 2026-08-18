import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardV2Screen } from '../src/board-v2/BoardV2Screen';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import { useGateData } from '../src/views/useGateData';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR BOARD V2 — same shape as the v1 board
 * harness beside it, because it verifies the same class of claims jsdom
 * structurally cannot: real layout (one-row chrome, banded workflow columns)
 * and REAL DRAG interactions, which need a real input pipeline. The vitest
 * suite fires synthetic dragstart/drop events; only a browser proves the
 * draggable card actually enters the HTML5 drag loop and lands.
 *
 * Mounts the shipping component over the fixture seam under the shipping
 * stylesheet — not a mock of either.
 */
function Harness() {
  const seam = useMemo(() => createFixtureSeam(), []);
  const data = useGateData({ leftKind: 'task', rightKind: 'task', seam });

  if (!data.ready) {
    return <div data-testid="harness-booting">booting…</div>;
  }

  return (
    <div className="cv2-root" data-testid="harness-ready" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <BoardV2Screen
        data={data}
        viewerMemberId="ada"
        onNotice={() => undefined}
        onOpenEntity={() => undefined}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
