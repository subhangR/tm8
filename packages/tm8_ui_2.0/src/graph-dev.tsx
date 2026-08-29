import { useState } from 'react';
import { createRoot } from 'react-dom/client';
/* The same stylesheet set, in the same order, as main.tsx — the graph inherits
   kit and app type scales, and graph.css is imported by the ENTRY, not by
   GraphView itself, so a harness that forgets it renders a correct DOM with no
   styling at all and looks like a layout bug. */
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import './graph/graph.css';
import { GraphView } from './graph';
import {
  GRAPH_FIXTURE_NOW,
  graphFixtureEdges,
  graphFixtureNodes,
} from './fixtures';
import type { EntityId } from '@tm8/contract';

/**
 * THE GRAPH GROUPING SCRATCH HARNESS — the contextual bands, on fixture data,
 * in a real browser.
 *
 * Same spirit as crew-dev.tsx and needed for the same reason: jsdom loads no
 * stylesheets and rasterizes nothing, so 63 green model tests prove the
 * PARTITION is right and prove nothing at all about whether it READS. The
 * questions only a browser answers here:
 *
 *   1. does a band frame sit BEHIND its cards without stealing their clicks,
 *      and does the header stay legible against the frame?
 *   2. is the residual band ("Unassigned", "No status") visibly quieter than a
 *      band that means something, without becoming unreadable?
 *   3. does a collapsed band still look like a control you can open?
 *   4. do cross-band edges read as informative rather than as a mistake?
 *   5. does all of it survive the dark ground, where the frame tint inverts?
 *
 * Usage: /graph-dev.html   (add ?theme=dark for the dark ground)
 *
 * The fixture is small on purpose — every band is countable by eye, so a wrong
 * count is visible rather than plausible.
 */
if (new URLSearchParams(location.search).get('theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

function GraphDev() {
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [windowId, setWindowId] = useState('all');

  // EVERY design token is scoped under `.cv2-root` so the module never leaks
  // into a host app — a harness that omits the class gets unstyled markup, not
  // a broken graph. `data-astryx-theme` matches what GateApp mounts.
  return (
    <div
      className="cv2-root"
      data-astryx-theme="neutral"
      data-theme={
        new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : undefined
      }
      style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}
    >
      <GraphView
        nodes={graphFixtureNodes}
        edges={graphFixtureEdges}
        now={GRAPH_FIXTURE_NOW}
        onSelect={(id) => setSelectedId((prior) => (prior === id ? null : id))}
        selectedId={selectedId}
        // The fixture has no liveness snapshot; 'unknown' is the honest answer
        // and keeps every live treatment off, which is what R-UI-5 requires of
        // a host that cannot actually vouch for a session.
        livenessOf={() => 'unknown'}
        viewerId={graphFixtureNodes[0]?.createdBy.id ?? null}
        window={windowId}
        onChooseWindow={setWindowId}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<GraphDev />);
