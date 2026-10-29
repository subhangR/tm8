/**
 * `tm8 help --query` never answers a STOP or STEER phrasing with an operation that starts, creates,
 * adds or destroys something (follow-up 01a188d3-0526). The PR4 Reviewer's probe found these on main
 * 35e09b7c5 (Loops #1413, doc 01a188d7-7e77): with `execution.terminate` ranked last, "kill it"
 * answered `credentials.space.delete`, "kill the agent" `spaceLinks.invoke`, "kill everything"
 * `space create`, and "cancel the recurring task" `loop create`. `rankedLast` now holds such
 * operations back for any query that ends, prevents or steers something (search.ts), and a recurring
 * task or job routes to its loop.
 */
import { describe, expect, it } from 'vitest';
import { searchHelp } from '../src/discovery/help.js';

/** The probe's flag classes, over the first answer's command (`op:<operation>` when it has none). */
const DESTRUCTIVE = /delete|revoke|leave|purge|destroy/;
const CREATE = /(create|spawn|launch|invoke)$/;
const RUN = /run-now$|^tool run$|runNow$/;

function first(query: string): string {
  const m = searchHelp(query).matches[0];
  return m === undefined ? '-' : (m.command ?? `op:${m.operation}`);
}
function flagged(answer: string): boolean {
  return answer !== '-' && (DESTRUCTIVE.test(answer) || CREATE.test(answer) || answer === 'chat start' || RUN.test(answer));
}
/** Every phrasing whose first answer is flagged and not in `accepted`, as `phrasing -> answer`. */
function violations(queries: readonly string[], accepted: Readonly<Record<string, string>> = {}): string[] {
  return queries.flatMap((q) => {
    const a = first(q);
    return flagged(a) && accepted[q] !== a ? [`${q} -> ${a}`] : [];
  });
}

describe('help --query: a stop or steer never answers a start, create, add or destroy first (01a188d3-0526)', () => {
  it('the bare kills answer nothing destructive (finding 1: credentials.space.delete)', () => {
    expect(violations(['kill it', 'kill this', 'kill that', 'kill all', 'kill', 'kill the job', 'kill the bot'])).toEqual([]);
  });

  it('nor spaceLinks.invoke, space create or session spawn (finding 2)', () => {
    expect(violations(['kill the agent', 'end the agent', 'kill everything', 'end everything', 'stop the tool session from spawning',
      'halt the agent', 'shut down the agent', "don't spawn a session"])).toEqual([]);
  });

  it.each([
    'stop the recurring task', 'cancel the recurring task', 'end the recurring task', 'kill the recurring task', 'abort the recurring task',
    'halt the recurring task', 'terminate the recurring task', 'quit the recurring task', 'turn off the recurring task',
    'cancel the recurring job', 'end the recurring job', 'cancel my recurring task', 'disable the recurring task',
  ])('a recurring task is a loop: "%s" disables it, never loop create (finding 3)', (q) => {
    expect(first(q)).toBe('loop disable');
  });

  it.each(['drop the recurring task', 'remove the recurring task', 'delete the recurring task'])(
    'deleting a recurring task deletes its loop: "%s"', (q) => {
      expect(first(q)).toBe('entity delete');
    });

  it('a run named stays the run stop, and a removal FROM the recurring task is no delete', () => {
    expect(first('cancel the recurring run')).toBe('loop stop');
    expect(first('remove the subject from the recurring task')).not.toBe('entity delete');
  });

  it('leaving a NAMED space and revoking access are still the answers that end them', () => {
    expect(first('quit the space')).toBe('space leave');
    expect(first('stop the token')).toBe('mcp tokens revoke');
    expect(first('revoke the invite')).toBe('space invite revoke');
  });

  it('a generated stop/steer verb x object grid gets no flagged first answer, except the accepted revokes', () => {
    const verbs = ['stop', 'cancel', 'end', 'kill', 'abort', 'halt', 'terminate', 'quit', 'close', 'shut down', 'turn off', 'interrupt',
      "don't run", "don't start", 'never run', 'steer', 'redirect', 'nudge', 'postpone', 'delay', 'pause', 'change'];
    const objects = ['', 'it', 'this', 'that', 'everything', 'all', 'the job', 'the bot', 'the agent', 'the worker', 'the process',
      'the session', 'the run', 'the tool', 'the task', 'the recurring task', 'the recurring job', 'the loop', 'the schedule',
      'the automation', 'the spawn', 'the launch', 'the chat', 'the container', 'the token', 'the server', 'the link', 'the upload',
      'the message', 'the form', 'the artifact', 'the project', 'the credential', 'the teammate'];
    const grid = verbs.flatMap((v) => objects.map((o) => `${v} ${o}`.trim()));
    expect(grid.length).toBe(748);
    // Ending a token's access IS its revoke.
    expect(violations(grid, { 'stop the token': 'mcp tokens revoke', 'close the token': 'auth sessions revoke' })).toEqual([]);
  }, 60_000);

  it("the PR4 Reviewer's 204 stop/steer phrasings get none, except delete phrasings (doc 01a188d7-7e77)", () => {
    expect(REVIEWER_PHRASINGS.length).toBe(204);
    expect(violations(REVIEWER_PHRASINGS, {
      // A delete phrasing answered by a delete: what it asks for.
      'remove the task': 'space task-axis delete',
      'drop the recurring task': 'entity delete',
      'remove the recurring task': 'entity delete',
      'delete the recurring task': 'entity delete',
      // Main's own (a8858c2f9) and a delete, not a stop: for the Tools lane to rule on (01a187ed-d432).
      'remove the tool': 'tool create',
      'delete the tool': 'tool create',
      'uninstall the tool': 'tool create',
    })).toEqual([]);
  }, 30_000);
});

/** The PR4 Reviewer's probe set, verbatim (doc 01a188d7-7e77, "The 204 phrasings"). */
const REVIEWER_PHRASINGS: readonly string[] = [
  'stop the tool',
  'stop the tool run',
  "stop the tool's run",
  'cancel the tool run',
  'abort the tool run',
  'kill the tool run',
  'halt the tool run',
  'end the tool run',
  "end the tool's run",
  "end the tool's task",
  'end the tool task',
  'end the tool',
  'quit the tool',
  'quit the tool tab',
  'close the tool tab',
  'close the tool',
  'stop running the tool',
  'stop the tool from running',
  "don't run the tool",
  'never run the tool again',
  'stop the tool session',
  'end the tool session',
  'kill the tool session',
  'terminate the tool session',
  'stop the tools',
  'stop all tools',
  'stop all tool runs',
  'cancel all tool runs',
  'stop the task',
  'end the task',
  'cancel the task',
  'quit the task',
  'abort the task',
  'kill the task',
  'halt the task',
  'stop the job',
  'cancel the job',
  'end the job',
  'kill the job',
  'stop the schedule',
  'cancel the schedule',
  'end the schedule',
  'pause the schedule',
  'turn off the schedule',
  'disable the schedule',
  'stop the cron',
  'cancel the cron job',
  'stop the recurring task',
  'cancel the recurring task',
  'end the recurring task',
  'stop repeating the task',
  'stop the nightly job',
  'stop the daily run',
  'stop the automation',
  'cancel the automation',
  'end the automation',
  'turn off the automation',
  'stop the agent',
  'kill the agent',
  'end the agent',
  'stop the teammate',
  'stop the worker',
  'halt the worker',
  'terminate the worker',
  'end the worker',
  'stop the run',
  'end the run',
  'cancel the run',
  'abort the run',
  'kill the run',
  'halt the run',
  'interrupt the run',
  'stop it',
  'cancel it',
  'kill it',
  'end it',
  'quit it',
  'abort it',
  'halt it',
  'stop everything',
  'stop all runs',
  'cancel all runs',
  'stop the scheduled run',
  'cancel the scheduled run',
  'skip the next run',
  'skip the next scheduled run',
  'cancel the next run',
  'stop the next run',
  'postpone the run',
  'delay the run',
  'stop the session',
  'end the session',
  'quit the session',
  'cancel the session',
  'kill the session',
  'close the session',
  'stop the chat',
  'end the chat',
  'stop the turn',
  'cancel the turn',
  'stop sharing the tool session',
  'stop following the running session',
  'stop watching the tool runs',
  'stop showing the tool session transcript',
  'cancel the tool session invite',
  'stop the tool session from spawning',
  'stop sharing the tools',
  'stop the tool from running on a schedule',
  'stop listing the tool runs',
  'stop sharing the running session',
  'stop sharing the session',
  'tell the run to stop',
  'tell the worker to stop',
  'make it stop',
  'ask it to stop',
  'steer the run',
  'redirect the run',
  'nudge the run',
  "change the run's prompt",
  'remove the tool',
  'delete the tool',
  'remove the task',
  'uninstall the tool',
  'stop',
  'cancel',
  'abort',
  'quit',
  'end',
  'halt',
  'kill the recurring task',
  'abort the recurring task',
  'halt the recurring task',
  'terminate the recurring task',
  'quit the recurring task',
  'cancel the recurring job',
  'end the recurring job',
  'cancel the scheduled task',
  'end the scheduled task',
  'cancel the repeating task',
  'cancel the cron task',
  'end the cron job',
  'cancel my recurring task',
  'cancel the weekly task',
  'cancel the nightly task',
  'end the daily task',
  'cancel the recurring run',
  'turn off the recurring task',
  'disable the recurring task',
  'pause the recurring task',
  'drop the recurring task',
  'remove the recurring task',
  'delete the recurring task',
  'cancel the scheduled job',
  'cancel the nightly job',
  'end the nightly job',
  'end the scheduled job',
  'kill the scheduled job',
  'cancel the automated task',
  'end the automated task',
  'cancel the periodic task',
  'end the periodic task',
  'stop spawning sessions',
  'stop sessions from spawning',
  'stop spawning',
  "don't spawn a session",
  'cancel the spawn',
  'stop the spawn',
  'stop launching sessions',
  'cancel the launch',
  'kill this',
  'kill that',
  'kill the process',
  'kill everything',
  'kill all',
  'kill the worker',
  'kill the teammate',
  'kill the bot',
  'kill the container',
  'kill the tool',
  'kill the chat',
  'nuke it',
  'shut it down',
  'shut down the agent',
  'shut down the worker',
  'abort the job',
  'end this',
  'terminate this',
  'terminate it now',
  'cancel the agent',
  'halt the agent',
  'stop the bot',
  'end the bot',
  'cancel everything',
  'end everything',
  'end all runs',
  'kill all runs',
  'stop this',
  'cancel this',
  'abort this',
  'quit this',
  'kill',
  'terminate',
  'shutdown',
  'shut down',
];
