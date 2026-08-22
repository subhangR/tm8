/**
 * The harness port — one adapter per agent CLI.
 *
 * TERMINOLOGY. "Harness" here means *an adapter for one agent CLI*
 * (`claude-code`, `codex`, `echo-agent`). `HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md`
 * uses the same word for *the prompt composition an agent boots with*
 * (Cartographer / Navigator / Conductor). The two are orthogonal — any flavor
 * can run on any harness. They share a word and nothing else.
 *
 * WHY THIS EXISTS. `buildAgentCommand` used to be a three-entry lookup table
 * followed by a chain of string-equality tests, with one provider's entire flag
 * vocabulary inlined into the tail of the function. tm8 law T-L4 forbids that
 * shape — behaviour keyed on a string literal makes the set of legal values a
 * property of the CODE rather than of a REGISTRY, so every such site must then
 * be found and edited in lockstep. This module is the registry that ends it.
 *
 * SHAPED TO TM8, NOT TRANSLITERATED. This is deliberately not a port of AO's Go
 * adapter interface. A Go `interface` with N implementations is the right answer
 * in a language with no discriminated unions and no structural typing of
 * capabilities. tm8 has both, and it already has a house style for exactly this:
 * a frozen record of typed descriptors with a lookup, like `OPERATIONS` (T-L12)
 * and `AGENT_TOOL_CREDENTIAL_PROVIDER`. So the vocabulary here is tm8's own —
 * `ResolvedLaunchConfig`, `SpawnError`, `PermissionMode`.
 *
 * CAPABILITIES ARE DATA, NOT OPTIONAL METHODS. A missing method is discovered by
 * calling it. A `capabilities` record is discovered by ASKING, which is what
 * lets a caller refuse BEFORE spawning rather than after. That distinction is
 * the whole point: every field below is a question the caller must ask rather
 * than assume.
 */
import type { PermissionMode } from '../spawn/types.js';
import type { ResolvedLaunchConfig } from '../spawn/manifest.js';
import type { AgentCredentialProvider } from '../spawn/agent-credentials.js';

/**
 * One rendered argv token.
 *
 * A bare `string` is FIXED CLI VOCABULARY and is emitted verbatim — flag names,
 * subcommands, and the enum-valued arguments of flags (`--sandbox
 * workspace-write`). A `{ value }` wrapper is CONTENT and is shell-quoted at the
 * render seam — model names, session ids, prompts, config assignments.
 *
 * WHY A TAGGED TOKEN RATHER THAN A QUOTE-THE-NEXT-ONE RULE. The pre-registry
 * code carried two incompatible rules: the Claude branch quoted inline while
 * building, and `renderCodexCommand` quoted positionally ("quote iff the
 * previous token was `--model` or `-c`"). Neither generalises — codex's resume
 * rollout id is a positional that must be quoted but follows no flag at all, so
 * a positional rule renders it bare and a quote-everything rule corrupts
 * `--sandbox workspace-write`. Tagging each token at the point it is BUILT, by
 * the code that knows whether it is vocabulary or content, is the only rule that
 * reproduces every existing case — and it is checkable by reading one line
 * instead of simulating a lookbehind.
 */
export type ArgToken = string | { readonly value: string };

/** Mark a token as CONTENT: shell-quoted when the argv is rendered. */
export function quoted(value: string): ArgToken {
  return { value };
}

/** The confinement story a harness declares, and how it was established. */
export type ConfinementStory =
  /**
   * The agent enforces its own permission posture in-process; there is no
   * OS-level sandbox tm8 drives through flags, so there is nothing to probe and
   * nothing that can silently fail. `claude-code`.
   */
  | 'enforced-in-agent'
  /**
   * The harness runs no arbitrary commands at all, so confinement is not a
   * question that applies to it. `echo-agent` reads a manifest and echoes.
   * DISTINCT from `unconfined`: there is no hazard to report, rather than a
   * hazard tm8 has decided to tolerate.
   */
  | 'no-command-execution'
  /**
   * The provider ships an OS-level sandbox tm8 drives through flags, and
   * whether this node can actually run it MUST be established by RUNNING it.
   *
   * See `sandbox-probe.ts`: inference was tried and was wrong. Codex ships its
   * own bwrap, so "is bwrap installed?" answers yes while the sandbox cannot
   * work; the real blocker was AppArmor, and the two sandbox shapes failed
   * differently and at different depths. "No amount of inspecting paths,
   * capability masks or `systemd-detect-virt` predicts that pair. Only running
   * it does."
   */
  | { readonly probe: SandboxProbeId }
  /**
   * Genuinely no confinement, and that is a legitimate honest answer that must
   * be SURFACED as one rather than hidden.
   */
  | 'unconfined'
  /**
   * Not measured. A harness may declare this, and the sandbox resolver REFUSES
   * rather than guessing.
   *
   * THIS IS THE VARIANT THE OLD CODE LACKED, and lacking it was the defect. The
   * predicate was `if (launch.agentTool !== 'codex') return CONFINED` — correct
   * for exactly two tools, and any third harness fell through and was reported
   * CONFINED with zero evidence. `unknown` must NEVER silently resolve to
   * confined.
   */
  | 'unknown';

/** The probes `sandbox-probe.ts` can actually run. A probe id with no runnable
 *  probe behind it is a registry error, not a runtime surprise. */
export type SandboxProbeId = 'codex-bwrap';

/** The transcript dialect a tool writes, if tm8 can read it at all. */
export type TranscriptDialect = 'claude-code' | 'codex';

/** How the SYSTEM prompt reaches the child. */
export type SystemPromptDelivery =
  /** A CLI flag whose value is the prompt: `--append-system-prompt <text>`. */
  | { readonly kind: 'flag'; readonly flag: string }
  /**
   * A config key/value pair: `-c developer_instructions=<json>`.
   *
   * The KEY IS LOAD-BEARING and was found by running the thing: `instructions`
   * is reserved by Codex and SILENTLY IGNORED. A silently-ignored key is the
   * worst available failure — the flag is accepted, the session starts, and the
   * agent has no identity.
   */
  | { readonly kind: 'config-kv'; readonly flag: string; readonly key: string }
  /** The harness reads the typed manifest, or tm8 must not guess its flags. */
  | { readonly kind: 'none' };

/** How the TASK prompt reaches the child. */
export type TaskPromptDelivery =
  /**
   * A bare positional argument, emitted LAST after every flag, because both
   * CLIs stop parsing options at the first non-option argument.
   */
  | 'positional'
  /** The harness reads the manifest, or its flag vocabulary is unknown. */
  | 'none';

/**
 * The exact-id resume contract.
 *
 * EXACT-ID ONLY: no `--continue`, no `--last` — both mean "most recent", which
 * resumes the WRONG conversation the moment two sessions share a cwd. On a
 * shared server two sessions sharing a cwd is the normal case, not the edge
 * case. A harness that "supports resume" via `--continue` is a data-crossing bug
 * wearing a feature's clothes.
 */
export interface HarnessResume {
  /**
   * A subcommand inserted immediately after the executable, when the CLI models
   * resume that way (`codex resume …`). Null when resume is a flag instead.
   */
  readonly subcommand: string | null;
  /**
   * The flag carrying the native id, or null when the id is POSITIONAL and must
   * come after every flag (codex's rollout id).
   */
  readonly idFlag: string | null;
}

/**
 * What a harness can be ASKED to do.
 *
 * NEVER default a field here. A default is exactly the silent assumption the
 * registry exists to prevent — the whole value of this record is that a
 * capability tm8 has not established is a compile error at registration rather
 * than a wrong answer at spawn time.
 */
export interface HarnessCapabilities {
  /**
   * Which vendor credential this tool authenticates with; null = no injection.
   *
   * A harness whose provider is non-null and whose config-home redirect
   * variable is UNVERIFIED must not register: tm8 is a shared server, and the
   * failure that prevents is one member's agent authenticating as another,
   * silently. `null` (echo-agent, an operator wrapper) is exempt because it
   * authenticates with nothing.
   */
  readonly credentialProvider: AgentCredentialProvider | null;

  /** The config directory this tool keeps under a member's home, if any. */
  readonly configDirName: string | null;

  readonly systemPromptDelivery: SystemPromptDelivery;
  readonly taskPromptDelivery: TaskPromptDelivery;

  /**
   * Null means: REFUSE LOUDLY. Never restart fresh and present it as resumed.
   * `withAgentResume` has always done this; the registry makes it universal.
   */
  readonly resume: HarnessResume | null;

  /**
   * Can tm8 pre-mint the child's conversation id (`--session-id <uuid>`)?
   * Claude can, which is what makes resume need no transcript parsing. Codex
   * mints its own rollout id, so this is false and its id is captured lazily.
   */
  readonly acceptsPreMintedSessionId: boolean;

  /** Does this CLI have a first-run workspace-trust dialog to pre-answer? */
  readonly workspaceTrust: 'claude' | 'codex' | 'none';

  readonly confinement: ConfinementStory;

  /** Null ⇒ `SessionTranscriptPage.unavailableReason = 'unsupported_agent_tool'`. */
  readonly transcriptDialect: TranscriptDialect | null;
}

/** What `buildAgentCommand`'s `opts` carries today, named. */
export interface BuildArgvOptions {
  /**
   * The PRE-MINTED native session id. Only meaningful when
   * `capabilities.acceptsPreMintedSessionId`; harnesses that cannot be
   * pre-seeded ignore it.
   */
  readonly claudeSessionId?: string | null;
  /**
   * This node cannot actually confine this command, as established by RUNNING
   * the provider's own sandbox rather than inferring from paths or capability
   * bits. By the time this is true the security decision has already been made
   * in SpawnService; the harness's only job is to emit a command line that
   * tells the truth about it.
   */
  readonly sandboxUnavailable?: boolean;
}

export interface Prompts {
  readonly system: string;
  readonly task: string;
}

/** One agent CLI, as data plus the one function that is genuinely per-tool. */
export interface Harness {
  /** The `agentTool` id — the registry key. Stable, lowercase-kebab. */
  readonly id: string;
  /**
   * The name this harness is SELECTED by — the value in `AGENT_TOOL_BINARIES`
   * and the key `TM8_AGENT_CMD` is matched against. Usually the executable, but
   * for `echo-agent` it is a sentinel (`'echo-agent'` is not a program).
   */
  readonly binary: string;
  /**
   * The executable actually placed at the head of the rendered command line.
   * Equals `binary` for real CLIs; `echo-agent` runs under `node`.
   *
   * Kept SEPARATE from `binary` because the pre-registry code hardcoded the head
   * (`['claude', ...args]`) rather than echoing back whatever `TM8_AGENT_CMD`
   * supplied — so `TM8_AGENT_CMD=claude` and the default path both render
   * `claude`, and collapsing the two fields would change that.
   */
  readonly exec: string;
  /**
   * Argv tokens emitted before any launch-derived argument — `echo-agent`'s
   * script path (`node <path>`).
   *
   * A FUNCTION, not an array, so it is evaluated on first use rather than at
   * module-initialisation time. The registry and `manifest.ts` import each
   * other, and an eagerly-evaluated prelude would run during that cycle.
   */
  preludeArgv?(): readonly ArgToken[];
  readonly capabilities: HarnessCapabilities;
  /**
   * Build the child's LOGICAL argv — no shell quoting, no joining. Content
   * tokens are tagged with {@link quoted}; rendering happens once, at the seam.
   */
  buildArgv(launch: ResolvedLaunchConfig, opts: BuildArgvOptions): ArgToken[];
}

export type { PermissionMode, ResolvedLaunchConfig };
