/**
 * THE REGISTRY — the sole dispatch point for agent-tool differences.
 *
 * Everything that used to be `if (agentTool === '…')` or `if (raw === '…')`
 * resolves through one of the three lookups below. Adding a harness is adding a
 * row here and a descriptor module; it is never editing a conditional.
 *
 * TWO KEYS, AND THE SECOND ONE IS NOT AN ACCIDENT. Harnesses are keyed by
 * `agentTool` id for every capability question, and ALSO by resolved BINARY for
 * command building. That mirrors what the pre-registry code actually did — the
 * old `buildAgentCommand` dispatched on `raw`, the resolved binary, not on
 * `launch.agentTool` — and it is load-bearing rather than incidental:
 * `TM8_AGENT_CMD=codex` is an operator override that must still reach Codex's
 * argument builder, while `TM8_AGENT_CMD=/opt/wrap/agent` must reach nobody's.
 * Keying only by tool id would silently break the first case.
 */
import { SpawnError } from '../spawn/types.js';
import { claudeCodeHarness } from './claude-code.js';
import { codexHarness } from './codex.js';
import { echoAgentHarness } from './echo-agent.js';
import type { Harness } from './types.js';

/**
 * Every harness tm8 can launch, by `agentTool` id.
 *
 * Frozen, and a plain record rather than a class hierarchy — tm8's house style
 * for an open set of named things with per-name behaviour, the same move as
 * `OPERATIONS` (T-L12) and `AGENT_TOOL_CREDENTIAL_PROVIDER`.
 */
export const HARNESSES: Readonly<Record<string, Harness>> = Object.freeze({
  'claude-code': claudeCodeHarness,
  codex: codexHarness,
  'echo-agent': echoAgentHarness,
});

/**
 * Per-`agentTool` binary name, selected when the operator has not forced one
 * via `TM8_AGENT_CMD`.
 *
 * DERIVED from the registry rather than maintained beside it, because the last
 * time a tool selection failed to reach the dispatch point the result was
 * measured in production: on 2026-07-28 a spawn with `agentTool: 'codex'`
 * produced a work_session row and a manifest that both said `codex`, while the
 * live PTY's argv (`ps -p <pid> -o args=`) was the bare `claude` command. The
 * table that fixed it is now generated, so it cannot drift from the harnesses
 * it names.
 */
export const AGENT_TOOL_BINARIES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.values(HARNESSES).map((harness) => [harness.id, harness.binary])),
);

/** Reverse index: resolved binary → harness. Also derived, same reason. */
const HARNESSES_BY_BINARY: Readonly<Record<string, Harness>> = Object.freeze(
  Object.fromEntries(Object.values(HARNESSES).map((harness) => [harness.binary, harness])),
);

/** Every registered harness id, for callers that need to enumerate rather than assume. */
export function harnessIds(): string[] {
  return Object.keys(HARNESSES).sort();
}

/**
 * Resolve a harness by `agentTool`, or REFUSE.
 *
 * The error shape is preserved exactly from the pre-registry
 * `buildAgentCommand`: unsupported tools are rejected instead of being routed
 * through another CLI.
 */
export function resolveHarness(agentTool: string): Harness {
  const harness = HARNESSES[agentTool];
  if (!harness) {
    throw new SpawnError(`unsupported agent tool: ${agentTool}`, 'invalid_input', { agentTool });
  }
  return harness;
}

/** Resolve without throwing, for callers deciding whether to offer something. */
export function tryResolveHarness(agentTool: string): Harness | null {
  return HARNESSES[agentTool] ?? null;
}

/**
 * Resolve the harness that owns a RESOLVED BINARY.
 *
 * `null` means the binary belongs to no registered harness — i.e. an operator
 * wrapper supplied through `TM8_AGENT_CMD`. That is not an error: it is a
 * complete, operator-owned command whose private flag vocabulary tm8 must not
 * guess at, so it is used verbatim and refuses resume and prompt injection.
 */
export function harnessForBinary(binary: string): Harness | null {
  return HARNESSES_BY_BINARY[binary] ?? null;
}
