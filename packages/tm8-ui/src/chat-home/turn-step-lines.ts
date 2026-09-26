/**
 * THE STEP LIST'S MODEL — a turn cut into RUNS, a run cut into LINES. Pure.
 *
 * A real turn interleaves: the agent narrates, calls three tools, narrates
 * again, calls five more (measured live: text between nearly every batch). So
 * the step list is per RUN, not per turn (advisor D15): each maximal stretch of
 * consecutive tool calls and thinking, between the content around it (text, an
 * explain card, a turn error), is one list, in `seq` order. The live step is
 * therefore always the last thing on screen, never stranded above newer text.
 *
 * Inside a run, lines fold for scanning (D15 §4): consecutive SETTLED steps of
 * one read-class category, or shell commands, become one counted line — `Read
 * 12 files`, `Ran 8 commands`. Writes never fold, so the list matches the
 * outcomes drawn above it one to one. A running, failed or stopped step always
 * stands alone. Consecutive thinking parts fold into one quiet `Thought` line,
 * which is not a step and does not count.
 */
import { explanationToolName } from './explanation-tools';
import type { ProjectedTurnPart } from './turn-model';
import {
  describeToolStep,
  groupDone,
  toolStepError,
  toolStepState,
  type StepLabels,
  type ToolStepPart,
  type ToolStepState,
  type ToolStepWords,
} from './turn-steps';
import { bareToolName, operationOf } from './write-classifier';

export type RunItem =
  | { kind: 'thinking'; seq: number; text: string }
  | { kind: 'step'; part: ToolStepPart };

export type TurnSegment =
  | { kind: 'part'; part: ProjectedTurnPart }
  | { kind: 'run'; key: string; items: readonly RunItem[] };

/**
 * A tool call that is a STEP: every call except the `explain_*` family, whose
 * payload IS the content (a diagram, a code excerpt) and keeps its card. The
 * doc / artifact create card is retired (D17): those creates are steps, and
 * their outcome is the ledger's create card like any other creation.
 */
export function isStepTool(part: ProjectedTurnPart): part is ToolStepPart {
  return part.kind === 'tool' && !explanationToolName(part.name);
}

/** Cut a projected turn into content parts and step runs, in `seq` order. */
export function segmentTurn(projected: readonly ProjectedTurnPart[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let run: RunItem[] = [];
  const flush = (): void => {
    if (run.some((item) => item.kind === 'step')) {
      out.push({ kind: 'run', key: `run:${itemSeq(run[0]!)}`, items: run });
    } else {
      // Thinking with no step beside it stays the standalone disclosure it
      // always was — there is no list for it to be a line of.
      for (const item of run) {
        if (item.kind === 'thinking') {
          out.push({ kind: 'part', part: { kind: 'thinking', seq: item.seq, text: item.text } });
        }
      }
    }
    run = [];
  };
  for (const part of projected) {
    if (part.kind === 'thinking') {
      run.push({ kind: 'thinking', seq: part.seq, text: part.text });
    } else if (isStepTool(part)) {
      run.push({ kind: 'step', part });
    } else {
      flush();
      out.push({ kind: 'part', part });
    }
  }
  flush();
  return out;
}

/** One tool call as the step list shows it. */
export interface StepView {
  seq: number;
  state: ToolStepState;
  words: ToolStepWords;
  /** A failed step's one-line reason (`Exit code 1`), else null. */
  reason: string | null;
  /** A LATER call with the same operation and target succeeded (D13). */
  retried: boolean;
}

/**
 * Every step of a turn, keyed by seq. `endSeq` is the turn's last terminal
 * record (`turnEndSeq`): a call that began before it can no longer be
 * running. `settled` is the host saying the whole turn is over.
 */
export function buildStepViews(
  steps: readonly ToolStepPart[],
  options: { settled: boolean; endSeq: number; labels?: StepLabels | undefined },
): ReadonlyMap<number, StepView> {
  const views = new Map<number, StepView>();
  const signatures = steps.map(signature);
  steps.forEach((part, index) => {
    const state = toolStepState(part, options.settled || part.seq < options.endSeq);
    const own = signatures[index];
    // FAILS CLOSED: a call whose target cannot be named never claims a retry.
    // "The agent retried" over a different target would hide a real failure.
    const retried =
      state === 'error' &&
      own !== null &&
      steps.some(
        (later, j) =>
          j > index &&
          signatures[j] === own &&
          toolStepState(later, true) === 'completed',
      );
    views.set(part.seq, {
      seq: part.seq,
      state,
      words: describeToolStep(part.name, part.args, part.result, options.labels),
      reason: state === 'error' ? toolStepError(part.result) : null,
      retried,
    });
  });
  return views;
}

/**
 * "Same operation and target" (D13): the tool, its operation, and what it
 * acted on — or NULL when the call names no target, which never matches.
 * A create's target is the thing it tried to make (kind + title); a search's
 * is what it searched for.
 */
function signature(part: ToolStepPart): string | null {
  const args = record(part.args);
  const params = record(args?.params);
  const body = record(args?.body);
  const operation = operationOf(part.args);
  const created =
    operation === 'entities.create' && str(body?.title) ? `${str(body?.kind) ?? ''}:${str(body?.title)}` : null;
  const target =
    str(params?.id) ??
    str(args?.docId) ??
    created ??
    str(args?.file_path) ??
    str(args?.path) ??
    str(args?.command) ??
    str(args?.url) ??
    str(args?.pattern) ??
    str(args?.query) ??
    (operation === null ? str(args?.title) : null);
  if (target === null) return null;
  return `${bareToolName(part.name)}|${operation ?? ''}|${target}`;
}

export type StepLine =
  | {
      kind: 'step';
      /** Keyed by the LAST step it holds: when a running call settles and
       *  folds into the line above, its own node survives (D7: a result
       *  resolves its call in place) and the older node is the one removed. */
      key: string;
      state: ToolStepState;
      /** Steps folded into this line. */
      count: number;
      text: string;
      detail: string | null;
    }
  | { kind: 'thought'; key: string; text: string };

export function buildStepLines(
  items: readonly RunItem[],
  views: ReadonlyMap<number, StepView>,
): StepLine[] {
  const lines: StepLine[] = [];
  let group: StepView[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const last = group[group.length - 1]!;
    lines.push({
      kind: 'step',
      key: `s${last.seq}`,
      state: 'completed',
      count: group.length,
      text: groupDone(group.map((view) => view.words)),
      detail: group.length === 1 ? last.words.detail : null,
    });
    group = [];
  };
  for (const item of items) {
    if (item.kind === 'thinking') {
      flush();
      const previous = lines[lines.length - 1];
      if (previous?.kind === 'thought') {
        lines[lines.length - 1] = { ...previous, text: `${previous.text}\n\n${item.text}` };
      } else {
        lines.push({ kind: 'thought', key: `t${item.seq}`, text: item.text });
      }
      continue;
    }
    const view = views.get(item.part.seq);
    if (!view) continue;
    if (view.state === 'completed' && view.words.merges) {
      if (group.length > 0 && group[0]!.words.category !== view.words.category) flush();
      group.push(view);
      continue;
    }
    flush();
    lines.push(singleLine(view));
  }
  flush();
  return lines;
}

function singleLine(view: StepView): StepLine {
  const { words, state } = view;
  const text =
    state === 'running'
      ? `${words.active}…`
      : state === 'error'
        ? `${words.active} failed`
        : state === 'stopped'
          ? `Stopped while ${lowerFirst(words.active)}`
          : words.done;
  return {
    kind: 'step',
    key: `s${view.seq}`,
    state,
    count: 1,
    text,
    detail: state === 'error' ? view.reason : words.detail,
  };
}

export interface RunSummary {
  /** Tool calls in the run. Thinking is not a step. */
  steps: number;
  failed: number;
  running: boolean;
  /** `read 12 files, ran 8 commands` — the top two verb groups (D15 §1). */
  groups: string;
}

export function summarizeRun(
  items: readonly RunItem[],
  views: ReadonlyMap<number, StepView>,
): RunSummary {
  const byCategory = new Map<string, ToolStepWords[]>();
  let steps = 0;
  let failed = 0;
  let running = false;
  for (const item of items) {
    if (item.kind !== 'step') continue;
    const view = views.get(item.part.seq);
    if (!view) continue;
    steps += 1;
    if (view.state === 'error') failed += 1;
    if (view.state === 'running') running = true;
    const bucket = byCategory.get(view.words.category);
    if (bucket) bucket.push(view.words);
    else byCategory.set(view.words.category, [view.words]);
  }
  // Largest first; a tie keeps first appearance (Map order, stable sort).
  const groups = [...byCategory.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, 2)
    .map((words) => lowerFirst(groupDone(words)))
    .join(', ');
  return { steps, failed, running, groups };
}

/** Steps held by lines — what an "earlier steps" button is counting. */
export function stepsIn(lines: readonly StepLine[]): number {
  return lines.reduce((sum, line) => sum + (line.kind === 'step' ? line.count : 0), 0);
}

function itemSeq(item: RunItem): number {
  return item.kind === 'thinking' ? item.seq : item.part.seq;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
