import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntitySummary } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../src/fixtures';
import type { ActionContext, QueryFilter } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

/**
 * A BROWSER HARNESS FOR THE COLLAPSED-BY-DEFAULT TREE (user ruling 2026-08-17).
 *
 * WHY THIS EXISTS RATHER THAN ANOTHER VITEST FILE. Two of the claims cannot be
 * made in jsdom at all:
 *
 *   1. THE CARET IS DRAWN AND HITTABLE. jsdom loads no stylesheets, so it can
 *      prove the control is in the DOM and structurally cannot prove it has a
 *      box, sits in the row, or is reachable — the whole affordance for a
 *      default that now hides content behind it.
 *   2. THE STATE ACTUALLY SURVIVES A RELOAD. `vite.config.ts` records that this
 *      runner's `localStorage` is an object with no `setItem`, so the vitest
 *      persistence test necessarily runs against a STUB. Only a real browser
 *      exercises the real storage round-trip, which is the "user can expand and
 *      it maintains that" half of the ruling.
 *
 * WHY THE ROWS ARE SYNTHESISED. The fixture seam has no same-kind hierarchy —
 * its sessions are parented to TASKS, so in a sessions list every parent is
 * off-page and every row roots itself. A tree harness over stock fixtures
 * measures a flat list and passes silently. These rows are real fixture
 * summaries re-parented into a three-deep chain, exactly as the vitest tree
 * tests build theirs.
 */
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const tasks = fixtureSummaries.filter((row) => row.state.kind === 'task');
const [root, mid, leaf, aunt] = tasks;

const chain: readonly EntitySummary[] = [
  { ...root!, id: 'h-root', title: 'Root task', parentId: null },
  { ...mid!, id: 'h-mid', title: 'Mid task', parentId: 'h-root' },
  { ...leaf!, id: 'h-leaf', title: 'Leaf task', parentId: 'h-mid' },
  { ...aunt!, id: 'h-aunt', title: 'Aunt task', parentId: 'h-root' },
];

const rowsFor = (_filter?: QueryFilter): readonly EntitySummary[] => chain;

function Harness() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  // `?selected=h-leaf` exercises the reveal path: the selection's ancestors
  // must be open on arrival without ever being recorded as gestures.
  const [selectedId, setSelectedId] = useState<string | null>(params.get('selected'));

  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      style={{ position: 'fixed', inset: 0, width: 380, display: 'flex' }}
    >
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor}
        ctx={ctx}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
