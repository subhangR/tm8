/**
 * Verb dispatch. Kept out of index.ts so tests can drive it without the
 * process-exiting entry wrapper.
 *
 * The surface is deliberately tiny (AM-5 — Phase 1 is the loop, nothing else):
 * boot an agent, and give it a way to say what happened. No graph command
 * tree, no spawn, no spells, no coordinator verbs. Those arrive when the loop
 * they would run inside actually closes.
 */
import { parseArgs, flagBool, type ParsedArgs } from './args.js';
import { ApiError, TransportError } from './client.js';
import { sessionReport } from './commands/session-report.js';
import { taskReport } from './commands/task-report.js';
import { whoami } from './commands/whoami.js';
import { workerInit } from './commands/worker-init.js';
import { CliError, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from './exit.js';
import { note } from './output.js';

export const VERSION = '0.1.0';

export const USAGE = `tm8 — the agent-facing CLI for a tm8 workspace

  tm8 worker init                                        compose this session's system prompt
  tm8 whoami                                             who the server thinks you are
  tm8 task report progress <taskId> "<message>"          note on the task thread
  tm8 task report complete <taskId> "<summary>"          note, then complete the task
  tm8 task report blocked  <taskId> "<reason>"           note, then block the task
  tm8 session report progress "<message>"                note on your own session thread
  tm8 session report complete "<summary>"
  tm8 session report blocked  "<reason>"

flags
  --json                 machine-readable stdout
  --manifest <path>      override TM8_MANIFEST_PATH (worker init)
  --expected-version <n> skip the read-before-complete (task report complete)
  --as <id[,id]>         completer team_member ids (task report complete)

environment (set by the PTY host on spawn)
  TM8_SESSION_ID · TM8_MANIFEST_PATH · TM8_BASE_URL · TM8_AGENT_TOKEN (optional)

exit codes
  0 ok · 2 usage · 3 the server refused · 4 the server could not answer
    (unreachable, 5xx, or a handler that is still 501 not_implemented)`;

async function dispatch(args: ParsedArgs): Promise<number> {
  const [a, b] = args.positionals;

  if (flagBool(args, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (a === undefined || a === 'help' || flagBool(args, 'help')) {
    process.stdout.write(`${USAGE}\n`);
    return a === undefined && !flagBool(args, 'help') ? EXIT_USAGE : EXIT_OK;
  }

  if (a === 'worker' && b === 'init') return workerInit(args);
  if (a === 'whoami') return whoami(args);
  if (a === 'task' && b === 'report') return taskReport(args);
  if (a === 'session' && b === 'report') return sessionReport(args);

  throw new CliError(
    `unknown command: ${[a, b].filter(Boolean).join(' ')}\n\n${USAGE}`,
    EXIT_USAGE,
  );
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    return await dispatch(args);
  } catch (err) {
    if (err instanceof CliError) {
      note(`tm8: ${err.message}`);
      return err.code;
    }
    if (err instanceof ApiError) {
      // Say WHICH failure it is. "not_implemented" during G1A means the
      // handler has not landed yet, not that the agent did anything wrong.
      const hint = err.code === 'not_implemented' ? ' (handler not built yet — DEV-13)' : '';
      note(`tm8: ${err.code}${hint}: ${err.message}${err.requestId ? ` [requestId ${err.requestId}]` : ''}`);
      return err.exitCode;
    }
    if (err instanceof TransportError) {
      note(`tm8: ${err.message}`);
      return err.exitCode;
    }
    note(`tm8: unexpected failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return EXIT_UNAVAILABLE;
  }
}
