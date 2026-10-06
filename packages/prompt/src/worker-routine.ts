/**
 * THE WORKER ROUTINE — one end-to-end section, owned by task P0g (01a111b2-aaf2):
 * how a session takes a task, keeps its status true, and finishes it.
 *
 * The audit behind it (doc 01a111b7-3ab4, 6 Oct 2026): 211 of 219 working or
 * blocked tasks had no live session on them, 35 finished tasks were still
 * `working`, and 61 never moved after the session that claimed them ended.
 * Agents knew every command; nothing told them the order, so the end of the
 * routine (status, then close-out, then `session complete`) was skipped.
 *
 * One source, three readers: the v1 identity instructions (`index.ts`), the v2
 * role layers (`prompt-v2.ts`) and `tm8 help routine` (the CLI help topic). Rule
 * text from sibling tasks lands in its step here, never in a copy:
 * - P0a (Spec D1 §7, migration 301): claims, `task release`, `session complete`;
 * - P0b (canonical edges): step 5's edge list;
 * - P0f (placement): step 4 is PLACEMENT_RULE itself; P0h (criteria): steps 3 and 6.
 * Owner ruling (6 Oct, form 01a111f3-b612): criteria are optional, and a PR
 * never decides task completion, so no step ties completing to a merge.
 */

import { PLACEMENT_RULE } from './placement-rule.js';

/**
 * One step: its name, the full rule (v1 prompt and `tm8 help routine`), and a
 * short form for the v2 role layer, whose bytes are budgeted (doc 01a0d456).
 */
export interface WorkerRoutineStep {
  readonly name: string;
  readonly short: string;
  readonly rule: string;
}

export const WORKER_ROUTINE_STEPS: readonly WorkerRoutineStep[] = [
  {
    name: 'Claim',
    short: '`tm8 task transition <task-id> working --claim` (your spawn tasks are already claimed)',
    rule:
      'Claim a task when you start on it: `tm8 task transition <task-id> working --claim`. ' +
      'The tasks you were spawned for are already claimed. A task offered to you later ' +
      '(a handoff, an assignment, a message) is not yours until you claim it; decline ' +
      'it with a message instead of leaving it.',
  },
  {
    name: 'Keep the status true',
    short: '`blocked` plus a message the moment you wait; never leave a task `working` you are not on',
    rule:
      'The status says what is happening now. The moment you wait on someone or ' +
      'something outside your control, move the task to `blocked` and post a message ' +
      'naming the blocker and who can clear it; move it back to `working` when it ' +
      'clears. Never leave a task `working` that you are not working on: finish it, ' +
      'move it, or release it.',
  },
  {
    name: 'Tick as you go',
    short: 'when a task has criteria, `tm8 task tick <task-id> <criterion-id>... --expect-version <n>` as each is met, not at the end',
    rule:
      'When a task has acceptance criteria, tick each one the moment it is met, not in a ' +
      'batch at the end: `tm8 task tick <task-id> <criterion-id> --expect-version <n>`. When ' +
      'the last one is ticked, the tick receipt\'s `next` names the step. Add criteria and an ' +
      'estimate when they help: `tm8 entity create task "<title>" --criterion "<testable outcome>" ' +
      '--estimate 3`.',
  },
  {
    name: 'Put what you create in its place',
    short: 'place it by what it is about, under the same-kind entity it is part of (`--parent`), else a root; across kinds an edge',
    rule: PLACEMENT_RULE,
  },
  {
    name: 'Link your work',
    short: 'PR or commit at once (rule 3); a deliverable `produces`, an input `attached_to`, follow-up work `follows_up`',
    rule:
      'Link a PR or commit the moment it exists: `tm8 task link-pr|link-commit <task-id> <url>` ' +
      '(it records the code; it never decides when the task is done). ' +
      'Pick the edge by meaning: a deliverable is ' +
      '`task produces <doc|artifact|file|drawing>`, an input or reference is ' +
      '`<entity> attached_to task`, follow-up work is `<new task> follows_up <origin task>`, ' +
      'a prerequisite is `task depends_on task`. `relates_to` is only a vague see-also. ' +
      'The server records provenance (`authored_from`) and teammate edges; do not write them.',
  },
  {
    name: 'Finish each task',
    short: 'when the work is done (every criterion ticked), `tm8 task complete <task-id> --expect-version <version tick returned> --by <your team_member>`; waiting on a review: `in_review`; stuck: `blocked`, or `tm8 task release <task-id> --note "<hand-off>"`',
    rule:
      'When the work is done and the last criterion is ticked, complete the task: ' +
      '`tm8 task complete <task-id> --expect-version <n> --by <your team_member>`. Never ' +
      'leave a finished task in `working`. Waiting on someone\'s review: move it to ' +
      '`in_review`, and complete it when the review is done. When you cannot go on: ' +
      '`blocked` with a message, or hand it off with ' +
      '`tm8 task release <task-id> --note "<where it stands>"`.',
  },
  {
    name: 'Close out',
    short: 'one message on the task: outcome, each claimed task\'s status, ids, decisions, open questions',
    rule:
      'Post one message on your assignment anchor: outcome, the status of every task you ' +
      'claimed, entity ids touched, decisions and why, open questions, and next-session ' +
      'pointers. This message is your receipt.',
  },
  {
    name: 'Complete the session',
    short: '`tm8 session complete`; never terminate yourself',
    rule:
      'Run `tm8 session complete`. It refuses with `claims_open` while a claim is still ' +
      '`working`, and takes your latest message on the anchor as the receipt (or pass ' +
      '`--receipt <message-id>`). Completing is a status marker, not an exit: you may ' +
      'still answer messages, and claiming a new task reopens the session. Never run ' +
      '`tm8 session terminate` on yourself; terminate is for operators.',
  },
];

/** A process exiting or going idle never moves a task; only these steps do. */
export const WORKER_ROUTINE_LEAD =
  'Exiting or going idle moves no task and completes nothing: a task you leave ' +
  '`working` shows "No live session" to everyone.';

/** Numbered lines, `n. Name: rule`, shared by every rendering below. */
export function workerRoutineLines(): string[] {
  return WORKER_ROUTINE_STEPS.map((s, i) => `${i + 1}. ${s.name}: ${s.rule}`);
}

/**
 * The v1 rendering: one paragraph appended to an identity instruction (v1
 * instructions are flowing prose under one `<instruction>` element). Leading
 * space, as the other v1 rule constants have.
 */
export const WORKER_ROUTINE_V1 =
  ' Work every task through this routine. ' +
  WORKER_ROUTINE_STEPS.map((s, i) => `(${i + 1}) ${s.name}: ${s.rule}`).join(' ') +
  ' ' +
  WORKER_ROUTINE_LEAD;

/**
 * The v2 rendering: one numbered role-layer rule naming every step by its short
 * form, pointing at `tm8 help routine` for the full text.
 */
export function workerRoutineV2Rule(n: number): string {
  const steps = WORKER_ROUTINE_STEPS.map((s, i) => `(${i + 1}) ${s.name}: ${s.short}.`).join(' ');
  return `${n}. Work each task through the routine (\`tm8 help routine\`): ${steps} ${WORKER_ROUTINE_LEAD}`;
}
