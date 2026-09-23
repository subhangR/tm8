/**
 * Which wire shape a read asks for while a factored (v2) shape rolls out.
 *
 * The rollout rule, one release long:
 *   - an AGENT-class caller gets v2 now, minified — it pays for every byte;
 *   - a human reading the human view gets v2 too: the render is the same text;
 *   - a non-agent `--format json|jsonl` caller keeps v1 for this release and is
 *     told on stderr that the default is moving, because a script parsing
 *     stdout is the one reader a silent shape change would break;
 *   - an explicit `--schema v1|v2` (or the command's own spelling of it) wins.
 */
import { isAgentContext } from './credentials.js';
import { CliError, EXIT_USAGE } from './exit.js';
import { JOURNAL_CLASSES, resolveJournalClass, type JournalClass } from './journal-stats.js';
import type { CommandContext } from './run.js';

export type WireSchema = 'v1' | 'v2';

/**
 * Agent-class: `TM8_JOURNAL_CLASS` when it names a class, otherwise a
 * tm8-spawned session (the spawn env `isAgentContext` reads) that the journal
 * classifier also calls an agent. A human at their own terminal has no spawn
 * env, so is never guessed to be an agent here.
 */
export function isAgentCaller(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  const explicit = env.TM8_JOURNAL_CLASS;
  if ((JOURNAL_CLASSES as readonly string[]).includes(explicit ?? '')) {
    return (explicit as JournalClass) === 'agent';
  }
  return isAgentContext(env) && resolveJournalClass(env, [], cwd) === 'agent';
}

/** Read `--<flag> v1|v2`; undefined when absent. */
export function schemaOption(cmd: CommandContext, flag: string): WireSchema | undefined {
  const raw = cmd.options.value(flag);
  if (raw === undefined) return undefined;
  if (raw === 'v1' || raw === 'v2') return raw;
  throw new CliError(`--${flag} expects v1 or v2, got ${JSON.stringify(raw)}`, EXIT_USAGE);
}

/**
 * Resolve the shape for this invocation, emitting the rollout notice when a
 * non-agent structured caller is kept on v1 by default. `forceV2` is for a
 * request only v2 can express (paging).
 */
export function resolveWireSchema(
  cmd: CommandContext,
  options: { flag: string; subject: string; v2Name: string; forceV2?: boolean },
): WireSchema {
  const explicit = schemaOption(cmd, options.flag);
  if (explicit) return explicit;
  if (options.forceV2 || cmd.out.format === 'human' || isAgentCaller()) return 'v2';
  cmd.out.note(
    `note: ${options.subject} --format ${cmd.out.format} still emits the v1 shape this release; ` +
      `the next release defaults to ${options.v2Name}. ` +
      `Pass --${options.flag} v2 to adopt it now, or --${options.flag} v1 to keep this shape.`,
  );
  return 'v1';
}
