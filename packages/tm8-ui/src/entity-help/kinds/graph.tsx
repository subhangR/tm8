/**
 * GRAPH — the Craft blueprint (Craft P1, rulings R1-R3), a PAGE of a design
 * since Craft → Designs (D1, D4: no in-thread approval; Run on the design
 * creates what its graph pages describe).
 *
 * Fact sources, so a later edit can re-check them:
 *   - one row holds vertices AND edges, `graphType` discriminates:
 *     contract/src/contract.ts (CoreEntityKind `graph`, content arm `graph`)
 *   - node `{id, ref?, spec?}`, `content.link` write-back:
 *     contract/src/schemas.ts (GraphNodeInputSchema, GraphContentInputSchema)
 *   - create defaults `graphType` to 'entity'; a patch MERGES:
 *     server/src/facade/services/w2/entities-commands-tracking.ts (`case 'graph'`)
 *   - findings derived on read, never stored: contract.ts content arm;
 *     codes in contract/src/orchestration.ts (checkGraphCoherence)
 *   - the craft protocol (edit the design's pages, create nothing; Run on the
 *     design materializes 1:1 with edges.create and writes back `content.link`):
 *     server/src/chat/compose.ts craft mode
 *   - a graph is a page of a design (`contains`, design → graph), crafted in a
 *     chat `about` the design: tm8-ui/src/craft/DesignScreen.tsx, DesignChatPane.tsx
 *   - the panel block is read-only: tm8-ui/src/panels/bodies/BlueprintBlock.tsx
 *   - no edge type names `graph`; it is reached only through `*` endpoints:
 *     tm8-ui/src/domain/edge-kinds.ts
 *   - `graph query` and `saved-view` are the Space's graph, not this kind:
 *     `tm8 help graph`, `tm8 help saved-view`
 */
import type { KindHelpModule } from '../types';
import { Stagger } from '../motion/Reveal';

export const GRAPH_HELP: KindHelpModule = {
  kind: 'graph',

  story: {
    logline: 'A plan you can draw and argue with before a single real task exists.',

    opening: (
      <>
        <p>
          A graph is a blueprint. Tasks, the teammates who own them, the docs they write and the memories they lean
          on, drawn as cards with the edges between them, all inside one entity. It lives as a page of a design, you
          sketch it with a teammate in that design&rsquo;s chat, and the canvas redraws every time the row changes.
        </p>
        <p>
          Before it, planning happened straight onto the Board. Every idea became a real task the moment it was
          spoken, every guess became a real edge, and throwing a plan away meant cleaning up after it. A graph lets
          the plan be wrong for free.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The rule',
        title: 'Its edges live inside it',
        body: (
          <>
            <p>
              The nodes and the edges of a blueprint are data in its own row, not rows of the Space. Drawing{' '}
              <code>t-ui depends_on t-api</code> on the canvas writes nothing to the Space&rsquo;s edges and puts
              nothing on the Board. That is why crafting is safe: the whole plan moves under one version guard, and
              a plan thrown away before its design is Run leaves nothing behind.
            </p>
            <p>
              It is also why the Constellation for this kind is so quiet. No edge type names a graph. Everything it
              connects to, it connects to through relations that admit any entity.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'Sketch, then real',
        title: 'A node is a sketch until it has a ref',
        body: (
          <>
            <p>
              Every node has a local <code>id</code> that edges name. A node that points at something which already
              exists carries a <code>ref</code>, the real entity id. A node that does not exist yet carries a{' '}
              <code>spec</code> instead: a kind, a short title, a one-line hint. Watch one node cross over.
            </p>
            <Stagger step={420} start={200} className="eh-prose" itemClassName="eh-prose">
              <p>
                <span className="eh-eyebrow">Sketched</span>{' '}
                <code>t-api</code> holds a spec, a task titled &ldquo;API design&rdquo;. It is drawn as a spec.
              </p>
              <p>
                <span className="eh-eyebrow">Run</span> Someone presses Run on the design that holds this page. The
                row itself does not change.
              </p>
              <p>
                <span className="eh-eyebrow">Materialized</span> The run&rsquo;s agent creates a real task, patches
                the row with a link, and <code>t-api</code> now carries a <code>ref</code> and keeps its spec.
              </p>
            </Stagger>
          </>
        ),
      },
      {
        eyebrow: 'Why it argues back',
        title: 'Findings on every read',
        body: (
          <p>
            An <code>entity</code> blueprint is checked every time it is read. A dependency cycle, a task with no
            owner, an input nobody produces, a spec wired to nothing: each comes back as a finding pinned to the nodes
            it is about. Findings are never stored, so they can never go stale. The craft teammate re-reads them after
            every patch and fixes them or says why one stands.
          </p>
        ),
      },
      {
        eyebrow: 'After Run',
        title: 'The drawing becomes the progress map',
        body: (
          <p>
            Materializing turns each spec into a real entity and each blueprint edge into one real edge of the same
            type, in the same direction. Run creates only what the graph pages describe and starts nothing. The
            blueprint stays, its nodes pointing at live work, so the row reads as the map of what is done and what is
            ready next.
          </p>
        ),
      },
      {
        eyebrow: 'Not the other graph',
        title: 'One word, two things',
        body: (
          <p>
            The Space itself is a graph too: every entity and every real edge, drawn by the Graph view and walked by{' '}
            <code>tm8 graph query</code>. Saved views are reusable queries over that. A graph entity is neither. It is
            a plan you own, with a title, a thread and a version, sitting beside the work rather than being it.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Sketched', note: 'Born with a title. The type defaults to entity, the nodes to none.' },
      { name: 'Crafted', note: 'Grown one guarded patch per turn, findings re-read after each.' },
      { name: 'Run', note: 'Run on the design that holds it. Nothing real exists before it.' },
      { name: 'Materialized', note: 'Specs become entities, blueprint edges become real edges, nodes gain refs.' },
      { name: 'Progress map', note: 'The row stays as the plan, each node pointing at the live work.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal, a graph is an ordinary entity whose content is a small JSON document. You create it, read
        it with its version and its findings, and patch it under that version. A design&rsquo;s chat is the same
        doors with a teammate holding the pen. The real world only changes when the design is Run, and then through
        the ordinary entity and edge commands.
      </p>
    ),

    scenes: [
      {
        title: 'Sketch the row',
        narrative: (
          <p>
            A patch carries only what it changes, so send the nodes without the layout and the layout survives. Every
            patch names the version you read. If a teammate patched in between, yours is refused rather than
            silently clobbering theirs. Read the row back and its <code>findings</code> tell you what is still
            incoherent.
          </p>
        ),
        commands: ['entity create', 'entity update', 'entity get'],
        demo: [
          'tm8 entity create graph "CSV export" --content @blueprint.json',
          '# patch under the version you read',
          'tm8 entity update <graph-id> --expect-version <v> --content @nodes.json',
          '# findings are derived on every read',
          'tm8 entity get <graph-id>',
        ],
      },
      {
        title: 'Craft it with a teammate',
        narrative: (
          <p>
            Put the graph on a design as a page, then start a craft-mode chat about the design. The teammate edits the
            design&rsquo;s pages and creates nothing real; Run on the design does that, from the graph pages.
          </p>
        ),
        commands: ['collection add', 'chat start'],
        demo: [
          'tm8 collection add <design-id> <graph-id> --position 1',
          'tm8 chat start --teammate <id> --model <model> --mode craft --workdir scratch --about <design-id> "Plan CSV export"',
          '# when the findings are clean, press Run on the design',
        ],
      },
      {
        title: 'Materialize by hand',
        narrative: (
          <p>
            What Run&rsquo;s agent does is ordinary commands in a strict order: create entities prerequisites first, one real edge
            per blueprint edge, then write the mapping back with a <code>link</code> patch so each node gains its{' '}
            <code>ref</code> without restating the rest.
          </p>
        ),
        commands: ['entity create', 'edge create', 'entity update'],
        demo: [
          'tm8 entity create task "API design" --content @t-api.json',
          'tm8 edge create <ui-task> depends_on <api-task>',
          '# write the node to entity map back into the row',
          'tm8 entity update <graph-id> --expect-version <v> --content \'{"link":{"t-api":"<api-task>"}}\'',
        ],
      },
      {
        title: 'The graph that is not this one',
        narrative: (
          <p>
            These commands work on the Space&rsquo;s own graph of real entities and edges, not on a blueprint. Reach
            for them to see what a materialized plan actually connected to, or to keep a query over the Space you
            return to.
          </p>
        ),
        commands: ['graph query', 'saved-view list'],
        demo: [
          '# walk real edges outward from a materialized task',
          'tm8 graph query --focus <api-task> --hops 2 --mode dependency',
          'tm8 saved-view list',
        ],
      },
    ],

    commands: ['chat start', 'chat send', 'edge create'],
  },

  constellation: {
    intro: (
      <p>
        A graph keeps its most important relations to itself: the edges on its canvas are content, not rows, so they
        never appear here. What does appear is how the Space holds the blueprint. Look first for the design that{' '}
        <em>contains</em> it: the graph is one of its pages, and the design&rsquo;s chat is where it was crafted.
      </p>
    ),

    notes: {
      'about:incoming': 'A chat about this graph itself. Craft chats are about the design that holds it.',
      'contains:incoming': 'The design this graph is a page of, or a collection gathering plans side by side. The blueprint is shared, not moved.',
      'relates_to': 'The loose link, for a plan that belongs near something without depending on it.',
      'depends_on': 'Rare on a blueprint itself. The depends_on edges you draw on the canvas stay inside the row until the design is Run.',
    },

    spotlight: ['chat', 'collection', 'task', 'memory'],
  },
};
