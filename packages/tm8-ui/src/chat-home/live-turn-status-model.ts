/**
 * THE LIVE STATUS ROW'S WORDS — what the agent is doing now, since when, and
 * how long it has been quiet, as plain strings a view renders verbatim.
 *
 * Reported by Subhang: "the agent does a lot of background work and nothing is
 * shown on screen for long periods, only the composer button changes". The
 * row under the conversation answers that, and this module is everything it
 * says — pure, so every phase can be pinned without a DOM.
 *
 * THREE SOURCES, NONE OF THEM OWNED HERE:
 *   - the turn's PHASE and CLOCK — lane 1's `TurnInProgress`;
 *   - the step WORDS — lane 3's `describeToolStep` / `toolStepState`
 *     (`turn-steps.ts`), the one classifier the transcript's step lines use
 *     too, so the row and the transcript cannot name one step two ways;
 *   - the in-flight message's PARTS, projected by `projectTurnParts`.
 * What this module adds is only formatting: the clock, the step count, the
 * per-phase copy (advisor rulings D2/D3/D16 on task 01a0dc86-911e).
 *
 * WHY SILENCE READS "Thinking…" AND NOT THE LAST STEP. Measured by lane 1 on
 * the live node: tools run in ~0.4s, then the model is silent for 12s on
 * average (74s max) before its next whole block. So the USUAL state of a turn
 * is "the last step finished a while ago". Keeping that step in the present
 * tense ("Creating task …") would say something false for most of the turn;
 * the row says `Thinking…` and shows the settled step muted beside it.
 *
 * TOOL NAMES NEVER REACH THE SURFACE (R8). Nothing here reads a tool name;
 * that is the classifier's job, and it returns human words.
 */
import type { EntityId } from '@tm8/contract';
import { projectTurnParts, type ProjectedTurnPart } from './turn-model';
import {
  describeToolStep,
  groupDone,
  toolStepState,
  turnEndSeq,
  type StepLabels,
  type ToolStepWords,
} from './turn-steps';
import type { ChatTurnPart } from './types';

/**
 * OWNER: lane 1, `turn-in-progress.ts`. A STRUCTURAL COPY of the pinned
 * contract, declared here only until that file is on main (merge order is
 * lane 1 first). On the rebase this interface is deleted and
 * `import type { TurnInProgress } from './turn-in-progress'` takes its place —
 * one line, because the shapes are identical field for field.
 */
export interface TurnInProgress {
  phase: 'sending' | 'waiting' | 'streaming' | 'stopping' | 'stopped' | 'failed';
  chatId: EntityId | null;
  messageId: EntityId | null;
  startedAt: number;
  lastFrameAt: number | null;
  error?: string;
  endedAt?: number;
}

/** Under this, `last step Ns ago` is noise — a stream that is plainly alive. */
export const QUIET_SHOW_MS = 5_000;
/**
 * Past this, silence changes TONE (ink → `--pn-wait`) and wording
 * (`still working · … since last step`). Never an error colour: 74s of silence
 * was measured as normal, so silence is not a fault (advisor ruling 3).
 */
export const QUIET_LONG_MS = 90_000;

type ToolPart = Extract<ProjectedTurnPart, { kind: 'tool' }>;

export interface LiveTurnView {
  phase: TurnInProgress['phase'];
  /** The bold sentence: what the agent is doing now. */
  now: string;
  /** Muted beside it: the settled step during a silence, or the frozen
   *  `after 7 steps · 1m 12s` of a stopped / failed turn. */
  aside: string | null;
  /** Mono, `aria-hidden`: `step 7 · 1m 12s · last step 40s ago`. */
  meta: string;
  /** `long` once silence passes `QUIET_LONG_MS` — a tone, not an alarm. */
  quiet: 'calm' | 'long';
  /** The clock is live, so the view re-renders every second. */
  ticking: boolean;
  /** The glyph slot: a turning spinner, or the frozen end state's mark. */
  glyph: 'spinner' | 'stopped' | 'failed';
  /** What the status region may say. It never carries the ticking clock. */
  announcement: string;
  /** Tool steps so far. */
  steps: number;
}

const TICKING: ReadonlySet<TurnInProgress['phase']> = new Set([
  'sending',
  'waiting',
  'streaming',
  'stopping',
]);

export function isTicking(phase: TurnInProgress['phase']): boolean {
  return TICKING.has(phase);
}

/**
 * `8s`, `1m 12s`, `1m 05s`, `1h 02m` — D3's clock. Seconds are floored, and a
 * negative span (a client clock that ran behind a server `createdAt`) reads
 * as `0s` rather than as nonsense.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function stepsWord(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`;
}

/** Present tense always ends in `…` (D14); the classifier's may not. */
function inProgress(words: string): string {
  return words.endsWith('…') ? words : `${words}…`;
}

const wordsOf = (part: ToolPart, labels: StepLabels | undefined): ToolStepWords =>
  describeToolStep(part.name, part.args, part.result, labels);

/** A step's one human fact (a created title, a file's basename, the agent's
 *  own description of a command), joined to its words. A quoted title or a
 *  `→ status` reads as part of the sentence; anything else is set apart. */
function withDetail(words: string, detail: string | null): string {
  if (!detail) return words;
  return /^[“→]/.test(detail) ? `${words} ${detail}` : `${words} · ${detail}`;
}

/**
 * The live phases' sentence while parts are arriving (D2 as amended by D16):
 *   - a step is RUNNING → its present tense, `Creating a task…`, with the
 *     step's detail (`“Provider interface”`) muted beside it;
 *   - the newest block is TEXT → `Writing…`;
 *   - otherwise the model is between blocks → `Thinking…`.
 * Several running at once (parallel reads) name the newest and say how many
 * more — the classifier's `counted` is past tense, a settled count, and would
 * claim the reads had finished.
 */
function streamingNow(
  running: readonly ToolPart[],
  newest: ProjectedTurnPart | null,
  labels: StepLabels | undefined,
): { now: string; detail: string | null } {
  const last = running[running.length - 1];
  if (last) {
    const words = wordsOf(last, labels);
    return {
      now: inProgress(words.active),
      detail: running.length > 1 ? `+${running.length - 1} more` : words.detail,
    };
  }
  return { now: newest?.kind === 'text' ? 'Writing…' : 'Thinking…', detail: null };
}

/**
 * The newest settled step, past tense — and when it closes a run of steps
 * that fold together (reads, commands: the classifier's `merges`), the run as
 * one counted line, `Read 3 tasks, 1 doc`, exactly as the transcript's step
 * list counts it.
 */
function settledStep(settled: readonly ToolPart[], labels: StepLabels | undefined): string | null {
  const last = settled[settled.length - 1];
  if (!last) return null;
  const lastWords = wordsOf(last, labels);
  if (!lastWords.merges) return withDetail(lastWords.done, lastWords.detail);
  const run: ToolStepWords[] = [lastWords];
  for (let index = settled.length - 2; index >= 0; index -= 1) {
    const words = wordsOf(settled[index]!, labels);
    if (words.category !== lastWords.category) break;
    run.unshift(words);
  }
  return run.length === 1 ? withDetail(lastWords.done, lastWords.detail) : groupDone(run);
}

/**
 * The whole row, for one instant.
 *
 * `parts` are the in-flight agent message's stored parts (looked up by
 * `turn.messageId`); `null` before that message exists. `now` is the view's
 * ticker — only the clock segments read it. `labels` (the thread ledger's)
 * lets a write name its target — `Moving “Ship it” to done` — instead of
 * `an entity`.
 */
export function liveTurnView(
  turn: TurnInProgress,
  parts: readonly ChatTurnPart[] | null | undefined,
  now: number,
  labels?: StepLabels,
): LiveTurnView {
  const projected = parts ? projectTurnParts(parts) : [];
  const ended = turn.phase === 'stopped' || turn.phase === 'failed';
  /* A continued turn appends to the SAME message after its first `done`, so a
     call that began before the last terminal record can no longer be running
     even when its own terminal record never arrived (lane 3's stuck-call
     guard) — otherwise the row would name it as "now" forever. */
  const endSeq = parts ? turnEndSeq(parts) : -1;
  const tools = projected.filter((part): part is ToolPart => part.kind === 'tool');
  const running: ToolPart[] = [];
  const settled: ToolPart[] = [];
  for (const tool of tools) {
    (toolStepState(tool, ended || tool.seq < endSeq) === 'running' ? running : settled).push(tool);
  }
  const newest = [...projected].reverse().find((part) => part.kind !== 'usage') ?? null;
  const steps = tools.length;

  const ticking = isTicking(turn.phase);
  /* A dead turn's clock stops where it ended: `endedAt` from lane 1, else the
     last thing it did — never the ticker, which would keep counting. */
  const end = ticking ? now : (turn.endedAt ?? turn.lastFrameAt ?? turn.startedAt);
  const elapsed = Math.max(0, end - turn.startedAt);
  const silence = Math.max(0, now - (turn.lastFrameAt ?? turn.startedAt));
  const quiet = ticking && silence >= QUIET_LONG_MS ? 'long' : 'calm';

  let nowText: string;
  let aside: string | null = null;
  switch (turn.phase) {
    case 'sending':
      nowText = 'Sending your message…';
      break;
    case 'waiting':
      nowText = 'Thinking…';
      break;
    case 'streaming': {
      const live = streamingNow(running, newest, labels);
      nowText = live.now;
      aside = running.length > 0 ? live.detail : settledStep(settled, labels);
      break;
    }
    case 'stopping':
      nowText = 'Stopping…';
      aside = settledStep(settled, labels);
      break;
    case 'stopped':
    case 'failed':
      nowText = turn.phase === 'stopped' ? 'Stopped' : 'Turn failed';
      /* The error text is NOT repeated (D16): the transcript already renders
         it as the turn's own `role=alert`. */
      aside = steps > 0 ? `after ${stepsWord(steps)} · ${formatClock(elapsed)}` : `after ${formatClock(elapsed)}`;
      break;
  }

  return {
    phase: turn.phase,
    now: nowText,
    aside,
    meta: ticking ? metaLine(turn.phase, steps, elapsed, silence) : '',
    quiet,
    ticking,
    glyph: turn.phase === 'stopped' ? 'stopped' : turn.phase === 'failed' ? 'failed' : 'spinner',
    announcement: announcementFor(turn.phase, nowText, aside, quiet),
    steps,
  };
}

/**
 * D3: `step 7 · 1m 12s · last step 40s ago`, with `step N` omitted while N is
 * 0 and the silence segment omitted under `QUIET_SHOW_MS`. Past
 * `QUIET_LONG_MS` the silence segment reads `still working · 1m 40s since last
 * step`. While sending there is nothing to time yet.
 */
function metaLine(
  phase: TurnInProgress['phase'],
  steps: number,
  elapsed: number,
  silence: number,
): string {
  if (phase === 'sending') return '';
  const segments: string[] = [];
  if (steps > 0) segments.push(`step ${steps}`);
  segments.push(formatClock(elapsed));
  if (phase === 'waiting') {
    // Nothing has arrived yet, so there is no "last step" to be quiet since.
    if (silence >= QUIET_LONG_MS) segments.push('still working');
  } else if (silence >= QUIET_LONG_MS) {
    segments.push(`still working · ${formatClock(silence)} since last step`);
  } else if (silence >= QUIET_SHOW_MS) {
    segments.push(`last step ${formatClock(silence)} ago`);
  }
  return segments.join(' · ');
}

/**
 * The status region's sentence — the `now` words, never the clock. The 90s
 * escalation is the one exception: it is announced ONCE, as its own
 * sentence, which is how a screen-reader user learns a long silence is still
 * a live turn (D16.5). The throttle that keeps this from being chatty lives
 * in the view; this only decides the words.
 */
function announcementFor(
  phase: TurnInProgress['phase'],
  nowText: string,
  aside: string | null,
  quiet: 'calm' | 'long',
): string {
  /* The THRESHOLD, not the live figure: a sentence that carried the ticking
     number would change every second and be re-announced every time the
     throttle let it through. This one is constant for the whole silence, so
     it is said exactly once. */
  if (quiet === 'long') {
    const threshold = formatClock(QUIET_LONG_MS);
    return phase === 'waiting'
      ? `Still working, ${threshold} with no reply yet`
      : `Still working, ${threshold} since the last step`;
  }
  if (phase === 'stopped' || phase === 'failed') return aside ? `${nowText} ${aside}` : nowText;
  return nowText;
}

/**
 * The announcement's THROTTLE KEY: a change of this is announced at once,
 * anything else waits its turn. Phase changes and the 90s escalation are the
 * events a listener needs; a new step every few seconds is not.
 */
export function announcementKey(view: LiveTurnView): string {
  return `${view.phase}:${view.quiet}`;
}
