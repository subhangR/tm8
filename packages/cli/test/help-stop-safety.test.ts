/**
 * `tm8 help --query` never answers an ENDING query with a write that does anything but end
 * something (follow-up 01a188d3-0526; lead rulings 01a188fa-6dfa, 01a188fd-4c7c, 01a188ff-61a7).
 * Found on main 35e09b7c5 (Loops #1413) by the PR4 Reviewer's probe (doc 01a188d7-7e77): "kill
 * it" answered `credentials.space.delete`, "cancel the recurring task" `loop create`, and the
 * first fix's verb denylist then promoted what it missed ("add a comment saying don't merge yet"
 * answered `pr merge`). This file classifies first answers from the ruling's ALLOWLIST and the
 * catalog's own side effects, and embeds the Reviewer's sets verbatim (doc v4: A-D, the 204).
 */
import { describe, expect, it } from 'vitest';
import { searchHelp } from '../src/discovery/help.js';
import { DISCOVERY, aliasCommands } from '../src/discovery/operations.js';

/** The ruling: a pure stop may lead any ending query; a detach only one that names what it ends. */
const PURE_STOPS = new Set(['stop', 'terminate', 'disable', 'pause', 'interrupt', 'cancel']);
const DETACHES = new Set(['revoke', 'unshare', 'unbind', 'unexpose', 'unset', 'logout', 'complete', 'finish', 'close',
  'abort', 'release', 'withdraw', 'unlink', 'unequip']);
const NEGATED = /^(please )?(i )?(do not|don't|dont|never|not)\b/i;
const FILLER = new Set(['a', 'all', 'the', 'it', 'this', 'that', 'my', 'please', 'do', 'to', 'i', 'can', 'you', 'everything',
  'anything', 'something', 'nothing', 'stuff', 'things', 'whatever', 'now', 'immediately', 'again', 'right', 'away', 'more']);
const SIDE = new Map(DISCOVERY.map((row) => [row.operation, row.sideEffect]));

type First = { command: string | null; operation: string } | undefined;
const first = (q: string): First => searchHelp(q).matches[0] as First;
const name = (m: First): string => (m === undefined ? '-' : (m.command ?? `op:${m.operation}`));
/** Commands are verb-last ("file upload abort"); a row with no command says it in its name. */
function verb(m: NonNullable<First>): string {
  if (m.command) return m.command.split(' ').at(-1)!;
  return /^[a-z]+/.exec(m.operation.slice(m.operation.lastIndexOf('.') + 1))?.[0] ?? '';
}
const singular = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** What the answer acts on: its command's words before the verb, else its name's segments. */
function nouns(m: NonNullable<First>): Set<string> {
  const words = m.command ? m.command.split(' ').slice(0, -1) : m.operation.split('.').slice(0, -1);
  return new Set(words.flatMap((w) => w.split(/-|(?=[A-Z])/)).map((w) => singular(w.toLowerCase())));
}
/** The phrasing's object words: past its verb (and a negated verb, and an off/down). */
function objectWords(q: string): string[] {
  const words = q.toLowerCase().replace(/n't/g, ' not').split(/[^a-z']+/).filter((w) => w !== '' && w !== 'not' && w !== 'never' && w !== 'do');
  const rest = ['turn', 'switch', 'power', 'call', 'shut', 'cut'].includes(words[0] ?? '') && ['off', 'down'].includes(words[1] ?? '')
    ? words.slice(2) : words.slice(1);
  return rest.filter((w) => !FILLER.has(w));
}
/** An ending query's first answer writes something other than its end (`phrasing -> answer`), or ''. */
function wrongEnd(q: string): string {
  const m = first(q);
  if (m === undefined || (SIDE.get(m.operation) ?? 'durable') === 'none') return '';
  const v = verb(m), objects = objectWords(q);
  const ok = !NEGATED.test(q) && (PURE_STOPS.has(v)
    // Leaving ends only "quit the space" itself.
    || (v === 'leave' && /^quit\b/i.test(q) && ['space', 'spaces', 'workspace'].includes(objects[0] ?? ''))
    // A detach must name ITS OWN noun: "call off the deploy" is no token's revoke (lead ruling 01a1890c-a176).
    || (DETACHES.has(v) && objects.some((w) => nouns(m).has(singular(w)))));
  return ok ? '' : `${q} -> ${name(m)}`;
}
const wrongEnds = (qs: readonly string[]): string[] => qs.map(wrongEnd).filter((x) => x !== '');

describe('help --query: an ending query never gets a write that does not end something (01a188d3-0526)', () => {
  it('the bare stops lead with a pure stop or answer nothing (lead ruling 01a188ff-61a7)', () => {
    for (const q of ['kill it', 'end it', 'stop it', 'stop everything', 'end everything', 'cancel all', 'halt', 'abort it', 'kill', 'kill this', 'kill all']) {
      const m = first(q);
      expect(m === undefined || (SIDE.get(m.operation) ?? 'durable') === 'none' || PURE_STOPS.has(verb(m)), `${q} -> ${name(m)}`).toBe(true);
    }
  });

  it('the first review\'s findings stay fixed', () => {
    expect(wrongEnds(['kill the job', 'kill the bot', 'kill that', 'kill the agent', 'end the agent', 'kill everything',
      'stop the tool session from spawning', "don't spawn a session", 'halt the agent', 'shut down the agent'])).toEqual([]);
    for (const q of ['stop the recurring task', 'cancel the recurring task', 'end the recurring task', 'kill the recurring task',
      'abort the recurring task', 'halt the recurring task', 'terminate the recurring task', 'quit the recurring task',
      'turn off the recurring task', 'cancel the recurring job', 'end the recurring job', 'cancel my recurring task', 'disable the recurring task']) {
      expect(name(first(q)), q).toBe('loop disable');
    }
    for (const q of ['drop the recurring task', 'remove the recurring task', 'delete the recurring task']) expect(name(first(q)), q).toBe('entity delete');
    expect(name(first('cancel the recurring run'))).toBe('loop stop');
    expect(name(first('remove the subject from the recurring task'))).not.toBe('entity delete');
  });

  it('a named end is still answered by it', () => {
    expect(name(first('quit the space'))).toBe('space leave');
    expect(name(first('cancel the upload now'))).toBe('file upload abort');
    expect(name(first('revoke the invite'))).toBe('space invite revoke');
  });

  it('a negation is never routed or ranked to the write it rejects', () => {
    expect(wrongEnds(NEGATIONS)).toEqual([]);
  });

  it('local git and other client-side writes are writes: never a "don\'t" answer (review of e975ddd3f)', () => {
    expect(wrongEnds(GIT_PHRASINGS)).toEqual([]);
    // A detach answers only for its own noun.
    expect(name(first('call off the deploy'))).not.toBe('mcp tokens revoke');
    for (const q of ['stop sharing the space']) expect(['credential unshare', 'space leave'], q).not.toContain(name(first(q)));
    expect(name(first('stop sharing the credential'))).toBe('credential unshare');
    expect(name(first('stop the token'))).toBe('mcp tokens revoke');
  });

  it('every alias whose name or summary says it merges, commits, stashes, rolls back, stages, pushes, applies, branches, checkpoints or restores declares a write', () => {
    const VERBS = /\b(merge|merges|commit|commits|stash|stashes|rollback|roll back|rolls back|stage|stages|push|pushes|apply|applies|branch|branches|checkpoint|checkpoints|restore|restores)\b/i;
    // Reads that use those words as nouns ("with branch, status", "the push history").
    const READS = new Set(['worktree list', 'worktree status', 'style versions']);
    const unmarked = aliasCommands().map((a) => a.command)
      .filter((c) => (VERBS.test(c.command) || VERBS.test(c.summary)) && c.sideEffect === 'none' && !READS.has(c.command))
      .map((c) => `${c.command}: ${c.summary}`);
    expect(unmarked).toEqual([]);
    for (const read of READS) expect(aliasCommands().find((a) => a.command.command === read)?.command.sideEffect, read).toBe('none');
  });

  it('set A: 52 create/add/start requests with an ending word in their object keep main 35e09b7c5\'s first answer', () => {
    expect(SET_A.length).toBe(52);
    expect(SET_A.filter(([q, main]) => name(first(q)) !== main).map(([q, main]) => `${q} -> ${name(first(q))} (main: ${main})`)).toEqual([]);
  }, 30_000);

  it('set B: 80 stops and preventions aimed at write verbs get no write that does not end something', () => {
    expect(SET_B.length).toBe(80);
    expect(wrongEnds(SET_B)).toEqual([]);
  }, 30_000);

  it('set C: 8 recurring-task setups keep main\'s first answer, never loop disable', () => {
    expect(SET_C.length).toBe(8);
    expect(SET_C.filter(([q, main]) => name(first(q)) !== main || name(first(q)) === 'loop disable')).toEqual([]);
  });

  it('set D: 23 phrasal ends, auxiliary negations and bare stops', () => {
    expect(SET_D.length).toBe(23);
    expect(wrongEnds(SET_D)).toEqual([]);
  });

  it('a generated grid: every stop, phrasal end and negation x 34 objects', () => {
    const verbs = ['stop', 'cancel', 'end', 'kill', 'abort', 'halt', 'terminate', 'quit', 'close', 'interrupt', 'shut down', 'turn off',
      'switch off', 'power off', 'call off', "don't run", "don't start", 'never run', "don't merge", "don't create", "don't delete",
      "don't send", "don't enable", 'do not resume', 'please never share'];
    const objects = ['', 'it', 'this', 'that', 'everything', 'all', 'the job', 'the bot', 'the agent', 'the worker', 'the process',
      'the session', 'the run', 'the tool', 'the task', 'the recurring task', 'the recurring job', 'the loop', 'the schedule',
      'the automation', 'the spawn', 'the launch', 'the chat', 'the container', 'the token', 'the server', 'the link', 'the upload',
      'the message', 'the form', 'the artifact', 'the project', 'the credential', 'the teammate'];
    const grid = verbs.flatMap((v) => objects.map((o) => `${v} ${o}`.trim()));
    expect(grid.length).toBe(850);
    expect(wrongEnds(grid)).toEqual([]);
  }, 120_000);

  it("the Reviewer's 204: no first answer in the doc's flag classes that pre-Loops main a8858c2f9 did not give", () => {
    const DESTRUCTIVE = /delete|revoke|leave|purge|destroy/, CREATE = /(create|spawn|launch|invoke)$/, RUN = /run-now$|^tool run$|runNow$/;
    const flagged = (a: string) => a !== '-' && (DESTRUCTIVE.test(a) || CREATE.test(a) || a === 'chat start' || RUN.test(a));
    const accepted: Record<string, string> = {
      // A read the doc's name classes flag by its name: "Read what a session was TOLD at spawn".
      'stop the tool session from spawning': 'session launch',
      "don't spawn a session": 'session launch',
      // A delete phrasing answered by the recurring task's own loop delete.
      'drop the recurring task': 'entity delete',
      'remove the recurring task': 'entity delete',
      'delete the recurring task': 'entity delete',
    };
    expect(BASELINE_204.length).toBe(204);
    const introduced = BASELINE_204.flatMap(([q, pre]) => {
      const a = name(first(q));
      return flagged(a) && a !== pre && accepted[q] !== a ? [`${q} -> ${a} (a8858c2f9: ${pre})`] : [];
    });
    expect(introduced).toEqual([]);
  }, 60_000);
});

/** Git and noun-mismatch phrasings (the Reviewer's round-3 set, msg 01a18912-2a6f, and their variants). */
const GIT_PHRASINGS: readonly string[] = [
  "abort it",
  "abort this",
  "abort",
  "don't merge",
  "do not merge",
  "don't merge the branch",
  "don't restore it",
  "don't roll back the session",
  "don't commit",
  "don't stage the files",
  "don't cherry-pick it",
  "don't stash it",
  "never drop the stash",
  "don't checkpoint the session",
  "don't rollback",
  "never commit it",
  "do not stage it",
  "don't push",
  "don't push the branch",
  "don't apply the patch",
  "don't apply the stash",
  "don't create a branch",
  "don't delete the branch",
  "don't rename the branch",
  "don't checkpoint it",
  "stop the merge",
  "cancel the merge",
  "abort the merge",
  "abort the cherry-pick",
  "stop the rollback",
  "cancel the commit",
  "kill the stash",
  "call off the deploy",
  "stop sharing the space",
  "stop sharing the credential",
  "stop the token",
  "close the token",
  "cancel the claim",
  "cancel the upload now",
  "end my session",
];

/** Negations that hit a write route before (`don't enable the loop` answered `loop enable`). */
const NEGATIONS: readonly string[] = [
  "don't enable the loop",
  "don't start the loop",
  "don't delete the loop",
  "don't run the loop now",
  "never run the loop again",
  "don't create a loop",
  "don't edit the loop",
  "don't resume the loop",
  "don't pause the loop",
  "don't disable the loop",
  "do not delete the task",
  "never delete the task",
  "don't schedule a loop",
  "don't terminate the session",
  "don't stop the loop",
  "don't tick the criteria",
  "don't create a task",
  "don't spawn a teammate",
  "don't run the tool",
  "don't merge the pr",
];

/** Doc 01a188d7-7e77 v4, set A: phrasing and main 35e09b7c5's first answer. */
const SET_A: readonly (readonly [string, string])[] = [
  ["create a task to change the logo", "entity update"],
  ["create a task to change the onboarding copy", "entity update"],
  ["add a criterion to change the API", "entity create"],
  ["add a criterion: do not break the API", "link add"],
  ["create a task to turn off the feature flag", "task create"],
  ["create a task to close the issue", "space task-axis create"],
  ["create a task to close stale pull requests", "task create"],
  ["create a task to stop the memory leak", "task create"],
  ["create a task for the end of the sprint", "task create"],
  ["create a task that never expires", "task create"],
  ["add a comment saying don't merge yet", "link add"],
  ["create a doc about how to change the schedule", "entity update"],
  ["create a doc to explain the change", "entity update"],
  ["create a loop that never runs on weekends", "loop create"],
  ["create a loop that skips weekends", "loop create"],
  ["set up a loop that runs at the end of each day", "loop stop"],
  ["set up a loop with a 5 minute delay", "loop create"],
  ["schedule a loop that pauses on holidays", "loop create"],
  ["create a recurring task that ends each day with a summary", "task create"],
  ["set up a recurring task to end the day with a summary", "loop create"],
  ["schedule a recurring job that changes the banner daily", "loop create"],
  ["create a recurring task to close stale tasks", "task create"],
  ["create a loop to close stale tasks every night", "task create"],
  ["create a loop to turn off idle containers nightly", "loop create"],
  ["spawn a session to change the readme", "session spawn"],
  ["spawn a teammate to close stale PRs", "session launch"],
  ["start a session to change the readme", "op:execution.terminal.start"],
  ["launch a session to shut down the old server", "session dispatch"],
  ["run the tool to change the config", "tool config set"],
  ["invoke the linked space to change its settings", "link list"],
  ["add a tag for blocking issues", "link add"],
  ["create a blocking task", "task create"],
  ["create an artifact showing the change log", "artifact publish"],
  ["upload a file with the changes", "op:projects.folderUploads.init"],
  ["create a chat to discuss the change", "chat model"],
  ["start a chat about the delay", "chat start"],
  ["create a story for the redirect work", "entity create"],
  ["create a task to redirect old urls", "task create"],
  ["create a task to nudge the reviewers", "task create"],
  ["create a task to postpone the launch", "task create"],
  ["create a space for the off-site", "space create"],
  ["add a criterion: not slower than main", "collection add"],
  ["create a task: avoid data loss on restart", "task create"],
  ["create a task to prevent duplicate runs", "task create"],
  ["delete the task about the change", "entity update"],
  ["delete the old change log doc", "entity update"],
  ["remove the off-site space", "space member remove"],
  ["create a credential that never expires", "op:credentials.space.create"],
  ["create a token that doesn't expire", "mcp tokens create"],
  ["create an mcp server to change files", "mcp server create"],
  ["add a member to the space to stop the bottleneck", "link add"],
  ["create a form to change the address", "form create"],
];

/** Doc 01a188d7-7e77 v4, set B. */
const SET_B: readonly string[] = [
  "stop the fork",
  "cancel the fork",
  "don't fork the session",
  "stop forking",
  "stop the dispatch",
  "cancel the dispatch",
  "don't dispatch the task",
  "stop dispatching tasks",
  "stop resuming the session",
  "don't resume the session",
  "cancel the resume",
  "never resume it",
  "don't enable the loop",
  "cancel the enable",
  "stop sharing the space",
  "stop sharing the artifact",
  "stop sharing the doc",
  "don't share it",
  "cancel the share",
  "stop exposing the port",
  "don't expose the server",
  "cancel the expose",
  "stop the endpoint",
  "cancel the snapshot",
  "don't snapshot the container",
  "stop the restore",
  "cancel the restore",
  "don't restore it",
  "cancel the grant",
  "don't grant access",
  "stop granting access",
  "stop the login",
  "cancel the signup",
  "don't log in",
  "stop the computer",
  "end the computer session",
  "kill the computer",
  "end the automation",
  "stop the git push",
  "cancel the git commit",
  "don't push",
  "stop pushing",
  "don't overwrite the file",
  "stop the prompt",
  "cancel the prompt",
  "don't prompt the session",
  "don't reissue the token",
  "cancel the relogin",
  "stop the merge",
  "don't merge",
  "cancel the deploy",
  "stop publishing",
  "don't publish the artifact",
  "cancel the publish",
  "stop the upload",
  "cancel the upload",
  "don't upload it",
  "stop the invite",
  "cancel the invite",
  "don't invite them",
  "cancel the import",
  "stop installing the tool",
  "don't install it",
  "cancel the install",
  "stop the schedule from firing",
  "don't fire the loop",
  "stop triggering it",
  "cancel the trigger",
  "stop sending messages",
  "stop messaging the teammate",
  "cancel the message",
  "don't send it",
  "stop posting",
  "turn off notifications",
  "cancel the reminder",
  "pause the loop",
  "don't run the loop tonight",
  "skip the next run of the loop",
  "stop the loop",
  "disable the loop",
];

/** Doc 01a188d7-7e77 v4, set C: phrasing and main 35e09b7c5's first answer. */
const SET_C: readonly (readonly [string, string])[] = [
  ["set up a recurring task to end the day with a summary", "loop create"],
  ["schedule a recurring job to cancel stale invites", "loop list"],
  ["create a recurring task to kill idle containers", "task create"],
  ["set up a recurring job that turns off idle sessions", "loop create"],
  ["create a recurring task that stops stale sessions", "task create"],
  ["schedule a recurring task to abort stuck runs", "loop stop"],
  ["create a recurring job to terminate idle workers", "loop create"],
  ["create a recurring task", "task create"],
];

/** Doc 01a188d7-7e77 v4, set D. */
const SET_D: readonly string[] = [
  "turn off notifications",
  "turn off the schedule",
  "turn off the automation",
  "switch off the loop",
  "shut off the server",
  "call off the deploy",
  "power off the container",
  "do not merge",
  "please don't publish the artifact",
  "please do not send it",
  "I don't want the loop to run tonight",
  "no more runs",
  "stop merging",
  "quit publishing",
  "never resume it again",
  "kill it",
  "end it",
  "stop it",
  "stop everything",
  "end everything",
  "cancel all",
  "halt",
  "abort it",
];

/** Doc 01a188d7-7e77, the 204 phrasings, with pre-Loops main a8858c2f9's first answer. */
const BASELINE_204: readonly (readonly [string, string])[] = [
  ["stop the tool", "session terminate"],
  ["stop the tool run", "session terminate"],
  ["stop the tool's run", "session terminate"],
  ["cancel the tool run", "session terminate"],
  ["abort the tool run", "session terminate"],
  ["kill the tool run", "session terminate"],
  ["halt the tool run", "session terminate"],
  ["end the tool run", "tool create"],
  ["end the tool's run", "tool create"],
  ["end the tool's task", "tool create"],
  ["end the tool task", "tool create"],
  ["end the tool", "tool create"],
  ["quit the tool", "tool create"],
  ["quit the tool tab", "tool create"],
  ["close the tool tab", "tool create"],
  ["close the tool", "tool create"],
  ["stop running the tool", "session terminate"],
  ["stop the tool from running", "chat stop"],
  ["don't run the tool", "tool create"],
  ["never run the tool again", "artifact preview"],
  ["stop the tool session", "session terminate"],
  ["end the tool session", "session terminate"],
  ["kill the tool session", "session terminate"],
  ["terminate the tool session", "session terminate"],
  ["stop the tools", "session terminate"],
  ["stop all tools", "session terminate"],
  ["stop all tool runs", "session terminate"],
  ["cancel all tool runs", "session terminate"],
  ["stop the task", "space task-axis list"],
  ["end the task", "space task-axis list"],
  ["cancel the task", "space task-axis list"],
  ["quit the task", "space leave"],
  ["abort the task", "space task-axis list"],
  ["kill the task", "space task-axis list"],
  ["halt the task", "space task-axis list"],
  ["stop the job", "chat stop"],
  ["cancel the job", "chat stop"],
  ["end the job", "session terminate"],
  ["kill the job", "session terminate"],
  ["stop the schedule", "chat stop"],
  ["cancel the schedule", "chat stop"],
  ["end the schedule", "session terminate"],
  ["pause the schedule", "container pause"],
  ["turn off the schedule", "chat stop"],
  ["disable the schedule", "node account disable"],
  ["stop the cron", "chat stop"],
  ["cancel the cron job", "chat stop"],
  ["stop the recurring task", "space task-axis list"],
  ["cancel the recurring task", "space task-axis list"],
  ["end the recurring task", "space task-axis list"],
  ["stop repeating the task", "space task-axis list"],
  ["stop the nightly job", "chat stop"],
  ["stop the daily run", "chat stop"],
  ["stop the automation", "chat stop"],
  ["cancel the automation", "chat stop"],
  ["end the automation", "session terminate"],
  ["turn off the automation", "chat stop"],
  ["stop the agent", "chat stop"],
  ["kill the agent", "session terminate"],
  ["end the agent", "session terminate"],
  ["stop the teammate", "teammate list"],
  ["stop the worker", "chat stop"],
  ["halt the worker", "container stop"],
  ["terminate the worker", "session terminate"],
  ["end the worker", "session terminate"],
  ["stop the run", "session terminate"],
  ["end the run", "session terminate"],
  ["cancel the run", "session terminate"],
  ["abort the run", "session terminate"],
  ["kill the run", "session terminate"],
  ["halt the run", "session terminate"],
  ["interrupt the run", "session terminate"],
  ["stop it", "chat stop"],
  ["cancel it", "chat stop"],
  ["kill it", "session terminate"],
  ["end it", "session terminate"],
  ["quit it", "space leave"],
  ["abort it", "op:projects.folderUploads.abort"],
  ["halt it", "container stop"],
  ["stop everything", "chat stop"],
  ["stop all runs", "session terminate"],
  ["cancel all runs", "session terminate"],
  ["stop the scheduled run", "chat stop"],
  ["cancel the scheduled run", "chat stop"],
  ["skip the next run", "artifact preview"],
  ["skip the next scheduled run", "artifact preview"],
  ["cancel the next run", "chat stop"],
  ["stop the next run", "chat stop"],
  ["postpone the run", "tool run"],
  ["delay the run", "tool run"],
  ["stop the session", "session terminate"],
  ["end the session", "session terminate"],
  ["quit the session", "mcp session provenance"],
  ["cancel the session", "session terminate"],
  ["kill the session", "session terminate"],
  ["close the session", "session terminate"],
  ["stop the chat", "chat stop"],
  ["end the chat", "space chat-defaults get"],
  ["stop the turn", "chat stop"],
  ["cancel the turn", "chat stop"],
  ["stop sharing the tool session", "session terminate"],
  ["stop following the running session", "session terminate"],
  ["stop watching the tool runs", "tool runs"],
  ["stop showing the tool session transcript", "session transcript"],
  ["cancel the tool session invite", "session transcript"],
  ["stop the tool session from spawning", "session terminate"],
  ["stop sharing the tools", "tool starters install"],
  ["stop the tool from running on a schedule", "chat stop"],
  ["stop listing the tool runs", "tool runs"],
  ["stop sharing the running session", "session terminate"],
  ["stop sharing the session", "session terminate"],
  ["tell the run to stop", "message send"],
  ["tell the worker to stop", "message send"],
  ["make it stop", "chat stop"],
  ["ask it to stop", "mcp server request"],
  ["steer the run", "tool run"],
  ["redirect the run", "tool run"],
  ["nudge the run", "tool run"],
  ["change the run's prompt", "tool run"],
  ["remove the tool", "tool create"],
  ["delete the tool", "tool create"],
  ["remove the task", "space task-axis delete"],
  ["uninstall the tool", "tool create"],
  ["stop", "chat stop"],
  ["cancel", "chat stop"],
  ["abort", "op:projects.folderUploads.abort"],
  ["quit", "space leave"],
  ["end", "session terminate"],
  ["halt", "container stop"],
  ["kill the recurring task", "space task-axis list"],
  ["abort the recurring task", "space task-axis list"],
  ["halt the recurring task", "space task-axis list"],
  ["terminate the recurring task", "space task-axis list"],
  ["quit the recurring task", "space leave"],
  ["cancel the recurring job", "chat stop"],
  ["end the recurring job", "session terminate"],
  ["cancel the scheduled task", "space task-axis list"],
  ["end the scheduled task", "space task-axis list"],
  ["cancel the repeating task", "space task-axis list"],
  ["cancel the cron task", "space task-axis list"],
  ["end the cron job", "session terminate"],
  ["cancel my recurring task", "space task-axis list"],
  ["cancel the weekly task", "space task-axis list"],
  ["cancel the nightly task", "space task-axis list"],
  ["end the daily task", "space task-axis list"],
  ["cancel the recurring run", "chat stop"],
  ["turn off the recurring task", "space task-axis list"],
  ["disable the recurring task", "node account disable"],
  ["pause the recurring task", "space task-axis list"],
  ["drop the recurring task", "space task-axis list"],
  ["remove the recurring task", "space task-axis delete"],
  ["delete the recurring task", "space task-axis delete"],
  ["cancel the scheduled job", "chat stop"],
  ["cancel the nightly job", "chat stop"],
  ["end the nightly job", "session terminate"],
  ["end the scheduled job", "session terminate"],
  ["kill the scheduled job", "session terminate"],
  ["cancel the automated task", "space task-axis list"],
  ["end the automated task", "space task-axis list"],
  ["cancel the periodic task", "space task-axis list"],
  ["end the periodic task", "space task-axis list"],
  ["stop spawning sessions", "session terminate"],
  ["stop sessions from spawning", "session terminate"],
  ["stop spawning", "chat stop"],
  ["don't spawn a session", "session spawn"],
  ["cancel the spawn", "op:spaceLinks.setSpawn"],
  ["stop the spawn", "op:spaceLinks.setSpawn"],
  ["stop launching sessions", "session terminate"],
  ["cancel the launch", "op:launch.suggest"],
  ["kill this", "session terminate"],
  ["kill that", "session terminate"],
  ["kill the process", "session terminate"],
  ["kill everything", "session terminate"],
  ["kill all", "session terminate"],
  ["kill the worker", "session terminate"],
  ["kill the teammate", "teammate list"],
  ["kill the bot", "session terminate"],
  ["kill the container", "session terminate"],
  ["kill the tool", "session terminate"],
  ["kill the chat", "space chat-defaults get"],
  ["nuke it", "-"],
  ["shut it down", "chat model"],
  ["shut down the agent", "op:spaceLinks.invoke"],
  ["shut down the worker", "task transition"],
  ["abort the job", "op:projects.folderUploads.abort"],
  ["end this", "session terminate"],
  ["terminate this", "session terminate"],
  ["terminate it now", "session terminate"],
  ["cancel the agent", "form cancel"],
  ["halt the agent", "op:spaceLinks.invoke"],
  ["stop the bot", "chat stop"],
  ["end the bot", "session terminate"],
  ["cancel everything", "chat stop"],
  ["end everything", "session terminate"],
  ["end all runs", "session terminate"],
  ["kill all runs", "session terminate"],
  ["stop this", "chat stop"],
  ["cancel this", "chat stop"],
  ["abort this", "op:projects.folderUploads.abort"],
  ["quit this", "space leave"],
  ["kill", "session terminate"],
  ["terminate", "session terminate"],
  ["shutdown", "-"],
  ["shut down", "chat model"],
];
