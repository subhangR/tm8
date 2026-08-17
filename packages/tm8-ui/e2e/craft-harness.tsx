import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityId } from '@tm8/contract';
import { CraftScreen } from '../src/craft/CraftScreen';
import { createFixtureSeam } from '../src/data';
import { FIXTURE_SPACE_ID } from '../src/fixtures';
import type { DetailReasons } from '../src/panels';
import { useGateData } from '../src/views/useGateData';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';

/**
 * PIXEL harness for the Craft studio (task 01a00b4e).
 *
 * EVERY CLAIM THIS CHANGE MAKES IS A LAYOUT CLAIM, which is exactly the class
 * jsdom is constitutionally unable to report: that the studio is TWO columns
 * and not three, that a chip press opens a THIRD, that both dividers drag,
 * that the blueprint is CENTRED in its pane rather than parked in the
 * top-left, and that the conversation popover sits over the chat rather than
 * under it. The vitest suite proves structure and arithmetic; only a browser
 * proves any of the above.
 *
 * It mounts the REAL `CraftScreen` over the fixture seam, with the same
 * `useGateData` injection port `EntityView`'s harness uses — so the entity
 * column here is the shipping `AuxEntityPanel`, not a stand-in for it.
 *
 * TWO SCENARIOS, because one of them would lie.
 *  · `?scenario=awkward` (default) — a row whose `layout` puts one card far
 *    right and another at a NEGATIVE coordinate. That is not padding, it is
 *    the regression: the old viewBox was pinned at `0 0 width height`, so an
 *    outlier inflated the box and shrank the rest into the corner, and a
 *    negative coordinate was clipped off-screen entirely. A tidy fixture
 *    would have hidden the very bug the harness exists to show.
 *  · `?scenario=typical` — no `layout` at all, the fallback grid, which is
 *    what the craft agent actually writes. Judging the DEFAULT zoom off the
 *    awkward row would tune it against a case that barely occurs.
 *
 *   /e2e/craft-harness.html?scenario=typical
 */
const SPACE = FIXTURE_SPACE_ID;

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

const NODES = [
  { key: 'ui', spec: { kind: 'team_member', title: 'tm8 UI Builder', hint: 'owns the surface' } },
  { key: 'ge', spec: { kind: 'team_member', title: 'Graph Engineer', hint: 'owns the plumbing' } },
  { key: 'panes', spec: { kind: 'task', title: 'Collapse to two panes', hint: 'chat + blueprint' } },
  { key: 'picker', spec: { kind: 'task', title: 'Conversation picker', hint: 'on the pane header' } },
  { key: 'resize', spec: { kind: 'task', title: 'Draggable dividers', hint: 'kit/PanelResizer' } },
  { key: 'fit', spec: { kind: 'task', title: 'Fit and centre the canvas', hint: 'true bounding box' } },
  { key: 'panel', spec: { kind: 'task', title: 'Chip opens region C', hint: 'shared AuxEntityPanel' } },
  { key: 'verify', spec: { kind: 'task', title: 'Verify with pixels', hint: 'jsdom cannot see this' } },
];

const EDGES = [
  { src: 'panes', dst: 'ui', type: 'assigned_to' },
  { src: 'picker', dst: 'panes', type: 'depends_on', note: 'the column has to go first' },
  { src: 'resize', dst: 'panes', type: 'depends_on' },
  { src: 'fit', dst: 'ge', type: 'assigned_to' },
  { src: 'panel', dst: 'picker', type: 'depends_on' },
  { src: 'verify', dst: 'fit', type: 'depends_on' },
  { src: 'verify', dst: 'panel', type: 'depends_on' },
  { src: 'verify', dst: 'nowhere', type: 'relates_to' },
];

const SCENARIO = new URLSearchParams(window.location.search).get('scenario') ?? 'awkward';

const BLUEPRINT = {
  graphType: 'entity',
  nodes: NODES,
  edges: EDGES,
  ...(SCENARIO === 'typical' ? {} : { layout: { verify: { x: 1400, y: 640 }, ui: { x: -320, y: -160 } } }),
};

function Harness() {
  const seam = useMemo(() => createFixtureSeam(), []);
  const data = useGateData({ leftKind: 'task', rightKind: 'task', seam });
  const [seeded, setSeeded] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    let alive = true;
    void (async () => {
      await seam.openSpace(SPACE);
      /* Seeded FIRST so it is the OLDER row: the studio adopts the most
         recent graph on cold start, and the harness wants to open on the
         drawn one. */
      await seam.commands.createEntity({
        clientMutationId: 'craft-harness-0',
        spaceId: SPACE,
        kind: 'graph',
        title: 'Terminal rendering — blueprint',
        content: { graphType: 'entity' },
      });
      const created = await seam.commands.createEntity({
        clientMutationId: 'craft-harness-1',
        spaceId: SPACE,
        kind: 'graph',
        title: 'Craft UI fixes — blueprint',
        content: { graphType: 'entity' },
      });
      const id = created.entity?.id as EntityId | undefined;
      if (id) {
        /* REFERENCE nodes need REAL entities behind them, or every card is a
           spec and nothing on the canvas is pressable — which would make the
           "a card opens region C" claim untestable here. Two live tasks from
           the fixture space stand in for what the craft agent materialises. */
        const tasks = await seam.query({ spaceId: SPACE, kinds: ['task'], limit: 2 });
        const refs = tasks.page.items.slice(0, 2).map((item, index) => ({
          key: `ref${index}`,
          ref: item.id,
        }));
        /* One guarded patch, exactly as the craft agent writes it — the canvas
           picks it up from the durable event and nowhere else (R1). */
        await seam.commands.patchEntity(id, {
          clientMutationId: 'craft-harness-2',
          expectedVersion: 1,
          content: {
            ...BLUEPRINT,
            nodes: [...BLUEPRINT.nodes, ...refs],
            edges: [
              ...BLUEPRINT.edges,
              ...(refs[0] ? [{ src: 'verify', dst: refs[0].key, type: 'relates_to' }] : []),
              ...(refs[1] ? [{ src: refs[1].key, dst: 'panel', type: 'depends_on' }] : []),
            ],
          },
        });
      }
      if (alive) setSeeded(true);
    })();
    return () => {
      alive = false;
    };
  }, [seam]);

  return (
    <div
      className="cv2-root"
      data-theme={theme === 'dark' ? 'dark' : undefined}
      style={{ position: 'fixed', inset: 0, display: 'flex' }}
    >
      <button
        type="button"
        data-testid="harness-theme"
        style={{ position: 'fixed', bottom: 8, left: 8, zIndex: 999 }}
        onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      >
        theme
      </button>
      {seeded && data.ready ? (
        <CraftScreen
          seam={seam}
          spaceId={SPACE}
          nodeKey="fixture"
          panelHost={{ data, reasons: REASONS, viewerMemberId: 'ada' }}
        />
      ) : (
        <p data-testid="harness-booting">Seeding the studio…</p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
