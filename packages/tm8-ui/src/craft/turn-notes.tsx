/**
 * TURN NOTES — the chat side of chat ↔ canvas: a turn that changed the
 * blueprint SAYS so, in the transcript, and names the nodes it touched as
 * buttons that select them on the canvas.
 *
 * Without this the two panes only met through the canvas's diff strip, which
 * shows the LATEST patch and forgets the rest. Here every patching turn keeps
 * its own line, so reading back the conversation reads back the plan's
 * history: "Blueprint v4 — +2 nodes · 1 changed  [Draft API spec] [Review]".
 *
 * HOW A CALL IS RECOGNISED. Chat's write path is the group tool (`tm8_act`),
 * whose `args.operation` carries the real verb (`write-classifier.ts` says why
 * the tool NAME must never be trusted for this). A call is a blueprint write
 * when it is `entities.patch` on THIS graph's id, or `entities.create` whose
 * result is this graph. The version the write produced is read from the
 * result, and the diff for that version comes from the studio's own live
 * record — so a thread reopened later still says "updated the blueprint" and
 * names what the patch carried, just without the before/after it never saw.
 */
import { graphNodeKey } from '@tm8/contract';
import type { ToolNoteInput } from '../chat-home/TurnParts';
import type { BlueprintView } from './blueprint-types';
import { summarizeDiff, type BlueprintDiff } from './blueprint-diff';
import { titleOf } from './canvas-nav';

/** What the chat surface hands a host for one tool call (`TurnPartsProps.toolNote`). */
export type ToolNoteCall = ToolNoteInput;

export interface GraphWrite {
  op: 'create' | 'patch';
  /** The row version this write produced, when the result says. */
  version: number | null;
  /** Node ids the written content carried (a full `nodes` array, usually). */
  nodeIds: string[];
  /** Node ids a `content.link` write-back materialized. */
  linked: string[];
  settled: boolean;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Walk a tool result the way results actually arrive — an object, an MCP
 * `{content:[{type:'text', text:'<json>'}]}` envelope, or a JSON string —
 * bounded, and never throwing.
 */
function walk(value: unknown, visit: (node: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    try {
      return walk(JSON.parse(t), visit, depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((item) => walk(item, visit, depth + 1));
  const node = obj(value);
  if (!node) return false;
  if (visit(node)) return true;
  return Object.values(node).some((child) => walk(child, visit, depth + 1));
}

function resultEntity(result: unknown, id: string | null): { id: string; version: number | null; kind: string | null } | null {
  let found: { id: string; version: number | null; kind: string | null } | null = null;
  walk(result, (node) => {
    const nodeId = str(node['id']);
    if (!nodeId || (id !== null && nodeId !== id)) return false;
    if (id === null && str(node['kind']) !== 'graph') return false;
    found = {
      id: nodeId,
      version: typeof node['version'] === 'number' ? (node['version'] as number) : null,
      kind: str(node['kind']),
    };
    return true;
  });
  return found;
}

/** Is this call a write to the blueprint `graphId`? Null when it is not. */
export function graphWriteOf(call: ToolNoteCall, graphId: string | null): GraphWrite | null {
  if (!graphId) return null;
  const args = obj(call.args);
  if (!args) return null;
  const operation = str(args['operation']);
  const body = obj(args['body']) ?? {};
  const params = obj(args['params']) ?? {};
  let op: GraphWrite['op'] | null = null;
  if (operation === 'entities.patch') {
    const target = str(params['id']) ?? str(body['id']) ?? str(args['id']);
    if (target !== graphId) return null;
    op = 'patch';
  } else if (operation === 'entities.create') {
    if (str(body['kind']) !== 'graph') return null;
    const made = resultEntity(call.result, graphId);
    if (!made) return null;
    op = 'create';
  } else {
    return null;
  }
  const content = obj(body['content']) ?? {};
  const nodes = Array.isArray(content['nodes']) ? content['nodes'] : [];
  const link = obj(content['link']);
  const made = call.state === 'completed' ? resultEntity(call.result, graphId) : null;
  return {
    op,
    version: made?.version ?? null,
    nodeIds: nodes.map((node, index) => graphNodeKey((obj(node) ?? {}) as never, index)),
    linked: link ? Object.keys(link) : [],
    settled: call.state !== 'running',
  };
}

const MAX_CHIPS = 5;

/**
 * The line itself. With a recorded diff: what changed, by name. Without one
 * (a thread reopened later): that the blueprint was written, and — for a
 * `link` write-back — which nodes became real entities.
 */
export function BlueprintTurnNote({
  write,
  diff,
  view,
  onSelect,
}: {
  write: GraphWrite;
  diff: BlueprintDiff | null;
  view: BlueprintView | null;
  onSelect(key: string): void;
}) {
  const verb = write.op === 'create' ? 'Started the blueprint' : 'Updated the blueprint';
  const onCanvas = (key: string) => !!view && (view.cards.some((c) => c.key === key) || view.attached.some((a) => a.key === key));
  const chips = diff
    ? [...diff.added.map((key) => ({ key, verb: 'added' })), ...diff.changed.map((key) => ({ key, verb: 'changed' }))]
    : write.linked.map((key) => ({ key, verb: 'built' }));
  const live = chips.filter((chip) => onCanvas(chip.key));
  const shown = live.slice(0, MAX_CHIPS);
  return (
    <div className="crf-turnnote" data-testid="crf-turn-note" data-settled={write.settled || undefined}>
      <span className="crf-turnnote__mark" aria-hidden>✎</span>
      <span className="crf-turnnote__lead">
        {write.settled ? verb : `${verb}…`}
        {write.version !== null ? <span className="crf-turnnote__ver">{` v${write.version}`}</span> : null}
      </span>
      {diff ? <span className="crf-turnnote__sum">{summarizeDiff(diff)}</span> : null}
      {!diff && write.linked.length > 0 ? (
        <span className="crf-turnnote__sum">{`${write.linked.length} node${write.linked.length === 1 ? '' : 's'} now real`}</span>
      ) : null}
      {shown.map(({ key, verb: v }) => (
        <button
          type="button"
          key={key}
          className="crf-turnnote__node"
          data-verb={v}
          title="Show on the canvas"
          onClick={() => onSelect(key)}
        >
          {view ? titleOf(view, key) : key}
        </button>
      ))}
      {live.length > shown.length ? <span className="crf-turnnote__more">{`+${live.length - shown.length}`}</span> : null}
    </div>
  );
}
