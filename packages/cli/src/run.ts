/**
 * The kernel router. Kept out of index.ts so tests can drive it without the
 * process-exiting entry wrapper.
 *
 * This file owns GRAMMAR RESOLUTION and the single exit funnel. It owns no
 * command list: `COMMANDS` is composed in `./commands/registry.ts` from
 * per-noun modules, so a domain slot adds one file it exclusively owns and
 * never edits this one.
 *
 * THREE OUTCOMES FOR A PATH, AND THE DIFFERENCE BETWEEN THEM MATTERS:
 *
 *   registered in the registry      → dispatch it.
 *   in the GRAMMAR, no handler yet  → exit 8, "documented, not built on this
 *                                     node", with a pointer at its help.
 *   in neither                      → exit 2, "unknown command".
 *
 * Collapsing the middle case into "unknown command" is how an agent concludes a
 * capability does not exist when it simply has not landed yet — and exit 8 is
 * precisely the code the frozen table reserves for "catalogued but not
 * implemented here" (DEV-13). The closed-registry property Slot A built is
 * preserved: both lookups are against CLOSED sets and an unmatched path is
 * still a usage error, never a passthrough.
 *
 * Rejected vocabulary (`whoami`, `report`, `progress`, public `session
 * prompt`) does not merely not-exist: it FAILS with a discovery hint. An agent
 * that learned the prototype's grammar must be told where the capability went,
 * not left to infer it from "unknown command".
 */
import {
  parseInvocation,
  splitCommandPath,
  type OptionBag,
  type ParsedInvocation,
} from './args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv, type CliContext } from './context.js';
import { ApiError, errorLines, exitCodeFor, RetiredCommandError } from './errors.js';
import {
  CliError,
  EXIT_MEANING,
  EXIT_NOT_IMPLEMENTED,
  EXIT_OK,
  EXIT_USAGE,
  type ExitCode,
} from './exit.js';
import { createOutput, processStreams, type Output } from './output.js';
import { journal } from './journal.js';
import { CLI_VERSION } from './discovery/help.js';
import { isCommandPath } from './discovery/operations.js';

export const VERSION = CLI_VERSION;

/**
 * What a domain command receives. Everything a command needs is here, so no
 * command re-reads argv, re-resolves context, or writes to a stream directly.
 */
export interface CommandContext {
  /** noun [subnoun] verb */
  path: readonly string[];
  /** Ordered arguments after the command path. */
  args: readonly string[];
  options: OptionBag;
  passthrough: readonly string[];
  ctx: CliContext;
  out: Output;
}

export interface CommandModule {
  /** noun [subnoun] verb — matched exactly. */
  path: readonly string[];
  run(cmd: CommandContext): Promise<ExitCode> | ExitCode;
}

export const USAGE = `tm8 — the graph-native CLI for a tm8 Server

  tm8 <noun> [<subnoun>] <verb> [arguments] [options]

global options
  --server <name>           target a named Server registered on the local Server
  --space <space-id>        the Space this command acts in
  --as <actor-id>           author as an authorized Member or Teammate
  --format human|json|jsonl stdout shape; human renders the same DTO as json
  --timeout <seconds>       per-request timeout, in SECONDS
  --no-color  --quiet

discovery
  tm8 help [<noun> [<verb>]]
  tm8 help --query <intent>
  tm8 help --operation <OperationName>
  tm8 <command> --help
  tm8 completion bash|zsh|fish

exit codes
${Object.entries(EXIT_MEANING)
  .map(([code, meaning]) => `  ${code.padStart(3)}  ${meaning}`)
  .join('\n')}`;

interface Retired {
  matches(positionals: readonly string[]): boolean;
  command: string;
  replacement: string;
}

/**
 * Rejected vocabulary (§1 of the grammar redesign). Each entry says where the
 * capability WENT, because "unknown command" for a verb that worked last week
 * is the least useful thing a CLI can say — and each now also names the intent
 * search, so a caller whose habit was something ELSE we retired has one more
 * move rather than a dead end.
 */
const DISCOVERY_POINTER = 'or search by intent: `tm8 help --query "<what you were trying to do>"`';

const RETIRED_COMMANDS: readonly Retired[] = [
  {
    matches: (p) => p[0] === 'whoami',
    command: 'whoami',
    replacement: `read your identity with \`tm8 identity get\` — ${DISCOVERY_POINTER}`,
  },
  {
    matches: (p) => p[1] === 'report' || p[0] === 'report',
    command: 'report',
    replacement:
      'state changes are explicit domain commands and durable communication is always a message: ' +
      '`tm8 task transition <task-id> working`, `tm8 task complete <task-id>`, `tm8 message send --to <anchor-id> "<body>"`' +
      ` — ${DISCOVERY_POINTER}`,
  },
  {
    matches: (p) => p[0] === 'progress' || p[2] === 'progress',
    command: 'progress',
    replacement: `post a message: \`tm8 message send --to <anchor-id> "<body>"\` — ${DISCOVERY_POINTER}`,
  },
  {
    matches: (p) => p[0] === 'prompt' || (p[0] === 'session' && p[1] === 'prompt'),
    command: 'session prompt',
    replacement:
      'there is no prompt command — a work session is addressed like any other anchor: ' +
      `\`tm8 message send --to <work-session-id> "<body>"\` — ${DISCOVERY_POINTER}`,
  },
];

async function dispatch(
  invocation: ParsedInvocation,
  out: Output,
  /** Reports the resolved command path so the journal can record it even when
   *  the command later throws. Purely an observer callback. */
  onResolvePath: (path: readonly string[]) => void = () => {},
): Promise<ExitCode> {
  const { positionals, globals } = invocation;
  // Imported lazily so `registry.ts` can import CommandModule from this file
  // without a load-order cycle: the registry is only needed once argv resolves.
  const { findCommand, isRegisteredPath } = await import('./commands/registry.js');

  if (globals.version) {
    out.data({ version: VERSION }, (dto) => dto.version);
    return EXIT_OK;
  }

  // `tm8` alone is a usage error (exit 2); `tm8 help` and `tm8 x --help` are
  // successful discovery (exit 0).
  if (positionals.length === 0) {
    if (globals.help) {
      const { help } = await import('./commands/help.js');
      return help([], invocation.options, out);
    }
    out.error([USAGE]);
    return EXIT_USAGE;
  }

  for (const retired of RETIRED_COMMANDS) {
    if (retired.matches(positionals)) {
      throw new RetiredCommandError(retired.command, retired.replacement);
    }
  }

  const registered = (path: readonly string[]): boolean => isRegisteredPath(path);
  const match =
    splitCommandPath(positionals, registered) ??
    // Fall back to the GRAMMAR so a documented-but-unbuilt command is told
    // apart from a typo. Longest-match discipline is identical.
    splitCommandPath(positionals, isCommandPath);

  if (!match) {
    if (globals.help) {
      out.data({ usage: USAGE }, (dto) => dto.usage);
      return EXIT_OK;
    }
    throw new CliError(`unknown command: ${positionals.slice(0, 3).join(' ')}`, EXIT_USAGE, {
      hint: 'run `tm8 help` for the current grammar, or `tm8 help --query "<intent>"` to search by intent',
    });
  }

  // `tm8 <command> --help` is answered from the projection, so help works for
  // every documented command whether or not a handler exists yet.
  if (globals.help) {
    if (isCommandPath(match.path)) {
      const { emitCommandHelp } = await import('./commands/help.js');
      return emitCommandHelp(match.path, out);
    }
    out.data({ usage: USAGE }, (dto) => dto.usage);
    return EXIT_OK;
  }

  onResolvePath(match.path);

  const command = findCommand(match.path);
  if (!command) {
    // In the grammar, no handler in this build. An honest 8 (DEV-13's own
    // code), not a 2 — the command is real and the caller did not mistype.
    throw new CliError(
      `\`tm8 ${match.path.join(' ')}\` is in the tm8 grammar but is not implemented in this CLI build`,
      EXIT_NOT_IMPLEMENTED,
      { hint: `read its contract with \`tm8 help ${match.path.join(' ')}\`` },
    );
  }

  let ctx = resolveContext({
    globals,
    session: sessionContextFromEnv(),
    config: loadLocalConfig(),
  });

  // Humans authenticate from the per-server credential store (doc 13 §4.1),
  // keyed by the origin of whichever Server the request actually goes to. The
  // lookup runs TWICE around `--server` on purpose: once for the local node
  // (so the registry lookup itself is authenticated where a credential
  // exists), and again after retargeting — `resolveServerTarget` drops A's
  // token, and only a credential stored under B's OWN origin may replace it.
  // Agent contexts never reach the store (`credentialStoreFor` refuses), and
  // `auth login` must stay claim-free: a stale stored credential presented on
  // the login request itself would 401 before the handler and lock the user
  // out of the one command that fixes it.
  const isLogin = match.path[0] === 'auth' && match.path[1] === 'login';
  let usedStoredCredential = false;
  const applyStoredCredential = async (): Promise<void> => {
    if (isLogin || ctx.token !== undefined) return;
    const { credentialOrigin, credentialStoreFor } = await import('./credentials.js');
    const stored = credentialStoreFor()?.get(credentialOrigin(ctx.baseUrl.value));
    if (stored) {
      ctx = { ...ctx, token: stored };
      usedStoredCredential = true;
    }
  };
  await applyStoredCredential();

  if (globals.server !== undefined) {
    if (match.path[0] === 'server') {
      throw new CliError('server registry commands always act on the local Server; omit --server', EXIT_USAGE);
    }
    const { resolveServerTarget } = await import('./server-target.js');
    ctx = await resolveServerTarget(ctx, globals.server);
    usedStoredCredential = false;
    await applyStoredCredential();
  }

  try {
    return await command.run({
      path: match.path,
      args: match.args,
      options: invocation.options,
      passthrough: invocation.passthrough,
      ctx,
      out,
    });
  } catch (err) {
    // An expired pass must surface as a re-login prompt, never as a silent
    // failure that looks like a bug (doc 13 §4.1).
    if (usedStoredCredential && err instanceof ApiError && err.code === 'unauthenticated') {
      err.hint =
        `the stored credential for ${ctx.baseUrl.value} was refused — it may have expired or been revoked; ` +
        'run `tm8 auth login <username>` against that Server to store a fresh one';
    }
    throw err;
  }
}

/**
 * The single funnel. Every failure — parse, local validation, taxonomy,
 * transport, protocol — leaves through here with a §7.6 code and a stderr
 * diagnostic. Nothing diagnostic ever reaches stdout.
 */
export async function run(argv: readonly string[]): Promise<ExitCode> {
  // The journal observes; it never participates. It is inert unless this
  // process was spawned as a session (see journal.ts), and its `wrapStreams`
  // forwards every chunk before counting it, so nothing here can change what
  // the caller sees or what exit code they get.
  const streams = journal.enabled ? journal.wrapStreams(processStreams) : undefined;
  let commandPath: readonly string[] = [];
  let out = createOutput({ format: 'human', streams });
  try {
    const invocation = parseInvocation(argv);
    out = createOutput({
      format: invocation.globals.format,
      color: invocation.globals.color,
      quiet: invocation.globals.quiet,
      render: invocation.globals.render,
      streams,
    });
    const exit = await dispatch(invocation, out, (path) => {
      commandPath = path;
    });
    journal.finish({ path: commandPath, argv, exitCode: exit });
    return exit;
  } catch (err) {
    out.error(errorLines(err));
    const exit = exitCodeFor(err);
    journal.finish({ path: commandPath, argv, exitCode: exit, error: err });
    return exit;
  }
}
