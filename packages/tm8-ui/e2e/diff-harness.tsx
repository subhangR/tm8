import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { DiffView } from '../src/kit/DiffView';
import { SAMPLE_DIFF, makeLargeDiff } from '../src/fixtures/diff';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';

/**
 * A PIXEL harness for the diff renderer, over fixtures.
 *
 * WHY A HARNESS RATHER THAN THE JSDOM SUITE. The vitest tests prove the CAP
 * arithmetic — how many rows are built, what the expander says, that nothing
 * is hidden once it is pressed. They cannot prove the two claims that are
 * purely about layout, because jsdom has no layout engine and reports every
 * box as 0x0:
 *
 *   1. that a capped diff is SHORT — the cap has to bound the rendered HEIGHT,
 *      not just a row count in a test's head;
 *   2. that a 600-character line scrolls INSIDE its file box rather than
 *      stretching the panel and pushing the whole page sideways.
 *
 * (2) is this package's recurring layout defect and is invisible to every
 * instrument except a browser: there is no global border-box reset here, so a
 * padded box measures wider than its content box and overflows by exactly the
 * padding.
 *
 * The diff is mounted inside a FIXED-WIDTH panel, because that is where it
 * ships — a component that only behaves at desk width has not been verified.
 *
 *   /e2e/diff-harness.html
 */

/** One file, one absurdly long line — the horizontal-overflow probe. */
const LONG_LINE_DIFF = [
  'diff --git a/src/wide.ts b/src/wide.ts',
  '--- a/src/wide.ts',
  '+++ b/src/wide.ts',
  '@@ -1,2 +1,2 @@',
  ' const short = 1;',
  `-const wide = '${'x'.repeat(600)}';`,
  `+const wide = '${'y'.repeat(600)}';`,
  '',
].join('\n');

function Panel({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <div className="harness-col">
      <div className="harness-cap">{label}</div>
      <div className="harness-panel" data-testid={testid}>
        <div className="cv2-root">{children}</div>
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div className="harness-grid">
      <Panel label="4,000-line file · capped at 200" testid="panel-capped">
        <DiffView diff={makeLargeDiff(4000)} maxLinesPerFile={200} maxTotalLines={200} />
      </Panel>
      <Panel label="600-char line · must scroll inside the file box" testid="panel-wide">
        <DiffView diff={LONG_LINE_DIFF} />
      </Panel>
      <Panel label="review-sized diff · uncapped" testid="panel-sample">
        <DiffView diff={SAMPLE_DIFF} />
      </Panel>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; align-items: flex-start; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; }
  .harness-cap { font: 700 11px/1.4 ui-monospace, monospace; color: #fff; letter-spacing: 0.03em; }
  /* 460px — a docked review panel, not a desk-width page. */
  .harness-panel { width: 460px; padding: 10px; box-sizing: border-box;
    background: var(--pn-paper, #f4f2ec); border-radius: 8px; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
