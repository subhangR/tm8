/**
 * BLUEPRINT DIFF — what one agent patch changed, in words and in keys.
 *
 * The studio used to glow new keys for 2.6s and forget them, which is motion
 * nobody can read back: look away during the patch and the canvas gives no
 * hint anything moved. This fold compares two consecutive views of the SAME
 * row and answers "what changed" durably — the diff strip names it, and the
 * canvas keeps the changed nodes marked until the next patch or a dismiss.
 *
 * Keys are the row's own (node ids, the model's edge keys), so a rename is a
 * CHANGE, not a remove + add. Assignees count as nodes too: docking a new
 * teammate on a task is a change the reader should see.
 */
import type { BlueprintView } from './blueprint-types';

export interface BlueprintDiff {
  added: readonly string[];
  /** Removed node keys, with the title they had — they are no longer drawable. */
  removed: readonly { key: string; title: string }[];
  /** Nodes whose title, kind, hint or spec/ref state changed. */
  changed: readonly string[];
  addedLines: readonly string[];
  removedLines: number;
  /** Keys to mark on the canvas: added + changed nodes (and task cards gaining an assignee). */
  marked: ReadonlySet<string>;
  markedLines: ReadonlySet<string>;
}

interface NodeSig { title: string; sig: string }

function nodeSigs(view: BlueprintView): Map<string, NodeSig> {
  const out = new Map<string, NodeSig>();
  for (const card of view.cards) {
    out.set(card.key, {
      title: card.title,
      sig: [card.kind, card.title, card.hint ?? '', card.isSpec, card.materialized, card.status ?? '',
        card.assignees.map((a) => a.key).join(',')].join('\u0001'),
    });
  }
  for (const node of view.attached) {
    out.set(node.key, {
      title: node.title,
      sig: [node.kind, node.title, node.isSpec, node.materialized].join('\u0001'),
    });
  }
  return out;
}

export function diffBlueprintViews(prev: BlueprintView, next: BlueprintView): BlueprintDiff {
  const before = nodeSigs(prev);
  const after = nodeSigs(next);
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, sig] of after) {
    const was = before.get(key);
    if (!was) added.push(key);
    else if (was.sig !== sig.sig) changed.push(key);
  }
  const removed = [...before].filter(([key]) => !after.has(key)).map(([key, sig]) => ({ key, title: sig.title }));
  const prevLines = new Set(prev.lines.map((line) => line.key));
  const nextLines = new Set(next.lines.map((line) => line.key));
  const addedLines = [...nextLines].filter((key) => !prevLines.has(key));
  const removedLines = [...prevLines].filter((key) => !nextLines.has(key)).length;
  return {
    added,
    removed,
    changed,
    addedLines,
    removedLines,
    marked: new Set([...added, ...changed]),
    markedLines: new Set(addedLines),
  };
}

export function isEmptyDiff(diff: BlueprintDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
    && diff.addedLines.length === 0 && diff.removedLines === 0;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "+2 nodes · 1 changed · +3 edges · −1 edge" — the strip's one-line summary. */
export function summarizeDiff(diff: BlueprintDiff): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`+${plural(diff.added.length, 'node', 'nodes')}`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  if (diff.removed.length) parts.push(`−${plural(diff.removed.length, 'node', 'nodes')}`);
  if (diff.addedLines.length) parts.push(`+${plural(diff.addedLines.length, 'edge', 'edges')}`);
  if (diff.removedLines) parts.push(`−${plural(diff.removedLines, 'edge', 'edges')}`);
  return parts.join(' · ');
}
