import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardScreen } from '../src/board/BoardScreen';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import { useGateData } from '../src/views/useGateData';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR THE BOARD TAB, and the reason it exists:
 * the whole point of the compact filter chrome is a claim about HEIGHT — that
 * the bar stays one row and the board gets everything else — and jsdom has no
 * layout engine, so the vitest suite can prove the bar renders four triggers
 * and structurally cannot prove any of them is 44px tall.
 *
 * The dropdowns make a second claim jsdom is blind to: the menus are PORTALLED
 * to `.cv2-root` and positioned from a viewport rect, so "does the menu land
 * under its trigger and inside the window" is only answerable in a real engine.
 * `capture-board.mjs` measures both.
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
      <BoardScreen
        data={data}
        viewerMemberId="ada"
        onNotice={() => undefined}
        onOpenEntity={() => undefined}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
