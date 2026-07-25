/**
 * `tm8 session report {progress,complete,blocked} "<text>"`
 *
 * All three are messages anchored to the agent's OWN work_session entity —
 * "session timeline is retired in favour of anchored messages + activity"
 * (04-EXECUTION-TRANSPLANT §1.2, inherited law: one message shape).
 *
 * None of them touches work_session *status*, and that is not an omission.
 * R29 makes the execution block's transition function the single writer of
 * session status; the old system had 3+ writers (create route, PTY-exit hook,
 * stop route, agent-side REST flips) and the resulting races are exactly what
 * the single-writer rule exists to kill. An agent declaring itself complete is
 * a statement in the thread; the PTY exiting is the state change.
 */
import { flagBool, type ParsedArgs } from '../args.js';
import { Tm8Client } from '../client.js';
import { readEnv } from '../env.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { readManifest } from '../manifest.js';
import { emit } from '../output.js';

type Kind = 'progress' | 'complete' | 'blocked';
const KINDS: readonly Kind[] = ['progress', 'complete', 'blocked'];

export async function sessionReport(args: ParsedArgs): Promise<number> {
  // positionals: ['session', 'report', <kind>, <text>]
  const kindRaw = args.positionals[2];
  const text = args.positionals[3];

  if (kindRaw === undefined || !(KINDS as readonly string[]).includes(kindRaw)) {
    throw new CliError('usage: tm8 session report {progress|complete|blocked} "<message>"', EXIT_USAGE);
  }
  const kind = kindRaw as Kind;
  if (!text) throw new CliError(`tm8 session report ${kind}: missing the message argument`, EXIT_USAGE);

  const env = readEnv();
  const sessionId = env.sessionId ?? manifestSessionId(env.manifestPath);
  if (!sessionId) {
    throw new CliError(
      'no session to report on: TM8_SESSION_ID is unset and the manifest has no sessionId. ' +
        'This command only makes sense inside a spawned session.',
      EXIT_USAGE,
    );
  }

  const client = new Tm8Client({ baseUrl: env.baseUrl, token: env.agentToken });
  const message = await client.invoke<unknown>('messages.post', {
    body: { anchorId: sessionId, body: renderBody(kind, text) },
  });

  emit(
    flagBool(args, 'json'),
    { ok: true, kind, sessionId, message },
    `session ${kind} reported on ${sessionId}`,
  );
  return EXIT_OK;
}

function renderBody(kind: Kind, text: string): string {
  if (kind === 'complete') return `**Session complete** — ${text}`;
  if (kind === 'blocked') return `**Session blocked** — ${text}`;
  return text;
}

function manifestSessionId(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readManifest(path).sessionId;
  } catch {
    return undefined;
  }
}
