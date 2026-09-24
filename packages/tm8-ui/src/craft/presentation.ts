/**
 * CRAFT PRESENTATION — the small, pure decisions the studio's views share:
 * which views a blueprint offers, what a status looks like, how a title wraps
 * into a card, what the legend says.
 *
 * THE WORDS ARE THE VOCABULARY'S. Legend rows and role names are read from
 * `ORCHESTRATION_EDGE_TYPES` (`@tm8/contract`), never typed here, so the
 * canvas can never teach a different edge language from the one the craft
 * prompt teaches the agent.
 */
import { ORCHESTRATION_EDGE_TYPES, type OrchestrationEdgeRole } from '@tm8/contract';
import type { BlueprintView } from './blueprint-types';

export type CraftViewId = 'flow' | 'lanes' | 'outline' | 'table';

export interface CraftViewOption {
  id: CraftViewId;
  label: string;
  hint: string;
}

const VIEW_OPTIONS: Record<CraftViewId, CraftViewOption> = {
  flow: { id: 'flow', label: 'Flow', hint: 'The plan as a left-to-right flowchart' },
  lanes: { id: 'lanes', label: 'Lanes', hint: 'One swimlane per teammate' },
  outline: { id: 'outline', label: 'Outline', hint: 'Each teammate’s tasks with what they need and make' },
  table: { id: 'table', label: 'Table', hint: 'Every node as a row' },
};

/**
 * The views that FIT this blueprint. Lanes only when someone is assigned —
 * one "Unassigned" lane is a flowchart with a heading, not a view. Outline
 * only when there are tasks to hang things off. Flow and Table always.
 */
export function availableViews(view: BlueprintView): readonly CraftViewOption[] {
  const hasAssignee = view.attached.length > 0 || view.cards.some((card) => card.assignees.length > 0);
  const hasTask = view.cards.some((card) => card.kind === 'task');
  return [
    VIEW_OPTIONS.flow,
    ...(hasAssignee ? [VIEW_OPTIONS.lanes] : []),
    ...(hasTask ? [VIEW_OPTIONS.outline] : []),
    VIEW_OPTIONS.table,
  ];
}

/** A requested view the blueprint cannot show falls back to Flow, never to nothing. */
export function resolveView(requested: CraftViewId, view: BlueprintView): CraftViewId {
  return availableViews(view).some((option) => option.id === requested) ? requested : 'flow';
}

export type StatusTone = 'run' | 'wait' | 'block' | 'done' | 'idle' | 'none';

/**
 * A live status → one of five tones (the tokens `--pn-run/wait/block/idle`).
 * Tolerant by design: the status strings are the entity's own, and an unknown
 * one reads as idle rather than as nothing.
 */
export function statusTone(status: string | null, live = false): StatusTone {
  if (live) return 'run';
  if (!status) return 'none';
  const s = status.toLowerCase();
  if (['working', 'running', 'in_progress', 'active', 'live'].includes(s)) return 'run';
  if (['blocked', 'failed', 'error', 'cancelled', 'canceled'].includes(s)) return 'block';
  if (['review', 'in_review', 'waiting', 'waiting_input', 'paused', 'pending'].includes(s)) return 'wait';
  if (['done', 'complete', 'completed', 'merged', 'closed', 'resolved', 'published'].includes(s)) return 'done';
  return 'idle';
}

export function humanStatus(status: string | null): string {
  return status ? status.replace(/[_-]+/g, ' ') : '';
}

/** Two letters for an avatar: first letters of the first two words, else the first two characters. */
export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Greedy word wrap into at most `maxLines` lines of `maxChars`, the last one
 * ellipsised. SVG text does not wrap, and a card title cut mid-word at a
 * fixed character count ("Collapse to two …") is the unreadable thing this
 * redesign exists to remove.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index]!;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      index += 1;
      continue;
    }
    if (!current) {
      /* One word longer than the line: hard-cut it. */
      current = word.slice(0, maxChars);
      words[index] = word.slice(maxChars);
      if (!words[index]) index += 1;
    }
    lines.push(current);
    current = '';
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (index < words.length && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines.length > 0 ? lines : [''];
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface LegendRow {
  role: OrchestrationEdgeRole | 'unknown';
  /** "Flow", "Order", "Context" — the role, as a reader names it. */
  name: string;
  /** The canonical edge labels drawn in this style, from the vocabulary. */
  labels: readonly string[];
}

const ROLE_NAMES: Record<Exclude<OrchestrationEdgeRole, 'assignment'>, string> = {
  flow: 'Flow',
  dependency: 'Order',
  context: 'Context',
};

/**
 * The legend, from the vocabulary. Assignment has no line (it is the avatar
 * docked on a task) so it is not a line row. For the reversed types the row
 * uses the label that reads ALONG the drawn arrow — `consumes` is drawn from
 * the input to the task, so the arrow says "consumed by", and the legend must
 * say what the arrow says.
 */
export function legendRows(): readonly LegendRow[] {
  const rows: LegendRow[] = [];
  for (const role of ['flow', 'dependency', 'context'] as const) {
    const labels = ORCHESTRATION_EDGE_TYPES
      .filter((type) => type.role === role && type.type !== 'relates_to')
      .map((type) => (type.order === 'dst-first' ? type.inverseLabel : type.label));
    rows.push({ role, name: ROLE_NAMES[role], labels });
  }
  return rows;
}

/** The assignment edge's own words, for the avatar's tooltip ("assigned to"). */
export function assignmentLabel(): string {
  return ORCHESTRATION_EDGE_TYPES.find((type) => type.role === 'assignment')?.label ?? 'assigned to';
}
