/**
 * The three command builders, rebuilt over the registry.
 *
 * These carry the same signatures and the same error shapes as the
 * pre-registry versions in `manifest.ts`, which re-exports them so no caller
 * of `@tm8/execution` moves. What changed is that every per-tool decision is
 * now a capability READ rather than a string comparison.
 */
import { SpawnError } from '../spawn/types.js';
import type { ResolvedLaunchConfig } from '../spawn/manifest.js';
import { AGENT_TOOL_BINARIES, harnessForBinary } from './registry.js';
import { appendRendered, renderCommand, spliceSubcommand } from './render.js';
import { quoted, type ArgToken, type BuildArgvOptions, type Harness, type Prompts } from './types.js';

/**
 * The system prompt as argv tokens, per the harness's declared delivery.
 *
 * Shared by prompt-append and resume because both re-send it, and for the same
 * reason: `--resume` / `codex resume` restore conversation HISTORY, not the
 * invocation's own configuration — an agent resumed without it comes back with
 * its memory and no identity.
 */
function systemPromptTokens(harness: Harness, system: string): ArgToken[] {
  if (system === '') return [];
  const delivery = harness.capabilities.systemPromptDelivery;
  switch (delivery.kind) {
    case 'flag':
      return [delivery.flag, quoted(system)];
    case 'config-kv':
      return [delivery.flag, quoted(`${delivery.key}=${JSON.stringify(system)}`)];
    case 'none':
      return [];
  }
}

/**
 * Build the shell command line the PTY runs.
 *
 * `TM8_AGENT_CMD` is an OPERATOR OVERRIDE and wins over everything — it forces
 * one binary for the whole node, whatever any session's resolved `agentTool`
 * says. Absent it, the resolved tool picks its own default binary via the
 * registry-derived {@link AGENT_TOOL_BINARIES}. Unrecognised tool names are
 * rejected rather than routed through another CLI.
 *
 * An override naming a registered binary (`TM8_AGENT_CMD=codex`) still reaches
 * that harness's argument builder — which is why the registry is keyed by
 * binary here and not by `agentTool`. An override naming anything else is a
 * complete operator-owned wrapper and is used VERBATIM: tm8 must not guess
 * flags into a command it does not own.
 */
export function buildAgentCommand(
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
  opts: BuildArgvOptions = {},
): string {
  const override = env.TM8_AGENT_CMD?.trim();
  const raw = override || AGENT_TOOL_BINARIES[launch.agentTool];

  if (!raw) {
    throw new SpawnError(`unsupported agent tool: ${launch.agentTool}`, 'invalid_input', {
      agentTool: launch.agentTool,
    });
  }

  const harness = harnessForBinary(raw);
  if (!harness) return raw;

  return renderCommand(harness.exec, [
    ...(harness.preludeArgv?.() ?? []),
    ...harness.buildArgv(launch, opts),
  ]);
}

/**
 * Append the composed prompts to an agent command line.
 *
 * SEPARATE from {@link buildAgentCommand} because of an ordering constraint that
 * looks circular and is not: the prompt is composed FROM the manifest, and the
 * manifest records the command. Splitting the two unties it — the base command
 * is built and recorded, the manifest is composed, the prompt is derived from
 * it, and only then is the prompt appended to produce the line the PTY runs.
 *
 * THIS IS THE STEP THAT WAS ONCE MISSING. Before it, tm8 composed a complete
 * manifest AND a complete system prompt, wrote the manifest to disk, exported
 * `TM8_MANIFEST_PATH` — then launched a bare `claude` that read none of it.
 * Every real agent booted with no identity and no task. It went unnoticed
 * because the smoke stub (`echo-agent`) DOES read the manifest, so the loop
 * passed on a path the product never takes.
 *
 * THE TWO PROMPTS TRAVEL ON DIFFERENT CHANNELS, and conflating them was the
 * second half of the same bug. The system prompt configures the agent; the task
 * prompt is the agent's FIRST USER TURN — the thing that makes it start working.
 * This function used to take one string, and its only caller passed
 * `${envelope.system}\n\n${envelope.task}`, so the task block landed inside
 * `--append-system-prompt` and no positional argument was emitted at all.
 * Measured 2026-07-30 on a live spawn (`ps -p <pid> -o command=`): the argv
 * ended `...</tm8_system_prompt>\n\n<tm8_task_prompt count="0">...`, with
 * nothing after it. Both CLIs treat an invocation with no positional prompt as
 * an INTERACTIVE session, so every tm8-launched agent booted to an idle REPL
 * with its assignment buried in its own configuration, reported `running`, and
 * never emitted a token. A session row that exists is not an agent that started.
 *
 * Delivery is PER-HARNESS and is now read from `capabilities` rather than
 * branched on, matching maestro's proven spawners flag for flag:
 *   - Claude: `--append-system-prompt <system>` then `<task>` positional
 *   - Codex:  `-c developer_instructions=<json>` then `<task>` positional
 *     (`instructions` is reserved by Codex and silently ignored)
 * The manifest-reading smoke agent needs neither: it declares `none` for both
 * and receives the command unchanged. Operator wrappers (`TM8_AGENT_CMD`) are
 * likewise returned unchanged because tm8 cannot know their private flag
 * vocabulary — including whether a bare positional would be read as a prompt or
 * as a path.
 *
 * The positional goes LAST, after every flag, because both CLIs stop parsing
 * options at the first non-option argument.
 *
 * PRODUCTION NOTE (2026-08-16): SpawnService passes an empty `task` when its
 * PromptSettlementWaiter is wired, launches the interactive provider with this
 * function's system configuration, then submits the task through the PTY
 * closed loop and waits for its outcome before recording `running`. Positional
 * task delivery remains the compatibility path for legacy embedders without a
 * settlement callback, and the focused unit surface for provider argv.
 */
export function withAgentPrompt(
  command: string,
  prompts: Prompts,
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const system = prompts.system.trim();
  const task = prompts.task.trim();
  if (system === '' && task === '') return command;

  const raw = env.TM8_AGENT_CMD?.trim() || AGENT_TOOL_BINARIES[launch.agentTool];
  if (!raw) return command;
  const harness = harnessForBinary(raw);
  if (!harness) return command;

  const tokens = systemPromptTokens(harness, system);
  if (task !== '' && harness.capabilities.taskPromptDelivery === 'positional') {
    tokens.push(quoted(task));
  }
  return appendRendered(command, tokens);
}

/**
 * Turn a base agent command into the RESUME invocation for `nativeSessionId`.
 *
 * Ported from maestro's proven resume builders (claude-spawner/codex-spawner
 * buildResumeArgs), including the two facts that make resume correct:
 *   - The SYSTEM prompt is re-appended. `--resume` / `codex resume` restore
 *     conversation HISTORY, not the invocation's own configuration — an agent
 *     resumed without it comes back with its memory and no identity.
 *   - The TASK prompt is NOT re-sent. It is already the first user turn of the
 *     restored conversation; sending it again duplicates the assignment. No
 *     positional argument also happens to be what keeps both CLIs in the
 *     interactive session the PTY needs.
 * Exact-id only: no `--continue`, no `--last` — both mean "most recent", which
 * resumes the WRONG conversation the moment two sessions share a cwd. On a
 * shared server two sessions sharing a cwd is the normal case, not the edge.
 *
 * Refusals are loud and typed. An operator wrapper (`TM8_AGENT_CMD`) has a
 * private flag vocabulary tm8 must not guess a resume flag into, and a harness
 * declaring `resume: null` (echo-agent, and every future tool with no
 * resume-by-id contract) must never be silently restarted fresh and presented
 * as resumed. The registry is what makes that second refusal automatic rather
 * than something each new harness has to remember to ask for.
 */
export function withAgentResume(
  command: string,
  systemPrompt: string,
  launch: ResolvedLaunchConfig,
  nativeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.TM8_AGENT_CMD?.trim();
  if (override) {
    throw new SpawnError(
      'resume is not supported under a TM8_AGENT_CMD operator wrapper — tm8 cannot know its resume flags',
      'not_implemented',
      { override },
    );
  }

  // Deliberately reads the DEFAULT binary, not the override: the override path
  // has already refused above.
  const raw = AGENT_TOOL_BINARIES[launch.agentTool];
  const harness = raw ? harnessForBinary(raw) : null;
  const resume = harness?.capabilities.resume ?? null;
  if (!harness || !resume) {
    throw new SpawnError(
      `agent tool '${launch.agentTool}' has no resume-by-id contract`,
      'invalid_input',
      { agentTool: launch.agentTool },
    );
  }

  const system = systemPrompt.trim();
  // `codex resume` is a SUBCOMMAND and must come before the flags; Claude's
  // `--resume` is a flag and needs no splice.
  const head = resume.subcommand ? spliceSubcommand(command, resume.subcommand) : command;

  const tokens = systemPromptTokens(harness, system);
  // The id is a flag value for Claude and a bare positional for Codex, which
  // must come after every flag.
  if (resume.idFlag) tokens.push(resume.idFlag, quoted(nativeSessionId));
  else tokens.push(quoted(nativeSessionId));

  return appendRendered(head, tokens);
}
