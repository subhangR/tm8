import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TurnParts } from '../src/chat-home/TurnParts';
import type { ChatTurnPart } from '../src/chat-home/types';
import { blueprintView } from '../src/craft/blueprint-model';
import { diffBlueprintViews } from '../src/craft/blueprint-diff';
import { BlueprintTurnNote, graphWriteOf } from '../src/craft/turn-notes';
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/chat-home/chat-home.css';
import '../src/craft/craft.css';

/**
 * PIXEL harness for PR 2 (chat turn → blueprint nodes): three real agent
 * turns rendered through the shipping `TurnParts`, with Craft's `toolNote`.
 * Turn 1 starts the blueprint, turn 2 patches it (a recorded diff names the
 * nodes), turn 3 is a `content.link` write-back after Orchestrate with no
 * recorded diff (a reopened thread) — the three shapes the note takes.
 */
const GRAPH = '01a0d3c5-0000-7000-8000-00000000beef';
const V1 = { graphType: 'entity', nodes: [
  { id: 't-research', spec: { kind: 'task', title: 'Research competitor pricing' } },
  { id: 'd-brief', spec: { kind: 'doc', title: 'Pricing brief' } },
], edges: [{ src: 't-research', dst: 'd-brief', type: 'produces' }] };
const V2 = { ...V1, nodes: [...V1.nodes,
  { id: 't-copy', spec: { kind: 'task', title: 'Write the pricing page copy' } },
  { id: 'd-copy', spec: { kind: 'doc', title: 'Page copy' } },
], edges: [...V1.edges, { src: 't-copy', dst: 'd-brief', type: 'consumes' }, { src: 't-copy', dst: 'd-copy', type: 'produces' }] };
const view1 = blueprintView(V1);
const view2 = blueprintView(V2);
const diffs = new Map([[2, diffBlueprintViews(blueprintView({ graphType: 'entity' }), view1)], [3, diffBlueprintViews(view1, view2)]]);

let seq = 0;
const turn = (text: string, args: unknown, result: unknown): ChatTurnPart[] => {
  const id = `c${(seq += 1)}`;
  return [
    { seq: (seq += 1), kind: 'text', text },
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'mcp__tm8__tm8_act', args, state: 'completed' },
    { seq: (seq += 1), kind: 'tool_result', toolCallId: id, content: { content: [{ type: 'text', text: JSON.stringify(result) }] } },
  ];
};
const TURNS: ChatTurnPart[][] = [
  turn('I sketched the first stage: a research task that produces the pricing brief.',
    { operation: 'entities.patch', params: { id: GRAPH }, body: { expectedVersion: 1, content: V1 } }, { entity: { id: GRAPH, kind: 'graph', version: 2 } }),
  turn('Added the copy step: it consumes the brief and produces the page copy.',
    { operation: 'entities.patch', params: { id: GRAPH }, body: { expectedVersion: 2, content: V2 } }, { entity: { id: GRAPH, kind: 'graph', version: 3 } }),
  turn('Orchestrated: the two tasks now exist; I linked them back to the blueprint.',
    { operation: 'entities.patch', params: { id: GRAPH }, body: { expectedVersion: 3, content: { link: { 't-research': '01a0d3c5-0000-7000-8000-000000000001', 't-copy': '01a0d3c5-0000-7000-8000-000000000002' } } } },
    { entity: { id: GRAPH, kind: 'graph', version: 4 } }),
];

function Harness() {
  const [dark, setDark] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="cv2-root" data-theme={dark ? 'dark' : undefined} style={{ position: 'fixed', inset: 0, background: 'var(--pn-paper)', padding: 24, overflow: 'auto' }}>
      <button type="button" data-testid="harness-theme" style={{ position: 'fixed', bottom: 8, left: 8 }} onClick={() => setDark((d) => !d)}>theme</button>
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'grid', gap: 18 }}>
        {TURNS.map((parts, index) => (
          <article key={index} className="tch-turn" data-testid="harness-turn">
            <TurnParts
              parts={parts}
              toolNote={(call) => {
                const write = graphWriteOf(call, GRAPH);
                if (!write) return null;
                /* Turn 3 plays a reopened thread: no recorded diff for v4. */
                const diff = write.version !== null ? diffs.get(write.version) ?? null : null;
                return <BlueprintTurnNote write={write} diff={diff} view={view2} onSelect={setPicked} />;
              }}
            />
          </article>
        ))}
        <p data-testid="harness-picked" style={{ color: 'var(--pn-ink-3)', fontSize: 12 }}>{picked ? `selected on the canvas: ${picked}` : 'press a node chip'}</p>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
