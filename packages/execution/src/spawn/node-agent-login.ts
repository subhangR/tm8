// The pre-spawn check of the NODE's own agent login, and the PTY backstop for
// Claude Code's first-run onboarding screen (setup-journeys audit 1.16 / 2.3).
//
// A session whose credential resolves to `node` runs the host's `claude` or
// `codex` under the server's OS user. With no login there, Claude Code boots
// into its first-run flow — "Choose the text style that looks best with your
// terminal", then "Select login method" — and waits forever: liveness reads
// live, the transcript is empty, and nothing anywhere says why. tm8 cannot
// seed its way past that: `completeClaudeOnboarding` only marks a home that
// already holds a login, because skipping the flow on a home without one
// leaves the lane at "please run /login" instead. So:
//
//   1. Before exec, ask the injected probe (the server's `probeNodeAgentLogin`,
//      the same answer Node admin shows) and REFUSE on a definite "no login",
//      naming the user and the command that fixes it. A doubt never refuses.
//   2. After exec, if the onboarding screen is up anyway (a login that expired
//      between probe and boot, or no probe wired), fail the lane by name.

import { SpawnError } from './types.js';

export type NodeAgentLoginProvider = 'anthropic' | 'openai';

/** The probe's answer, narrowed to what the gate reads. */
export interface NodeAgentLoginAnswer {
  verdict: 'usable' | 'missing' | 'unknown';
  runAs: string;
  detail: string | null;
  fix: string;
}

/** Injected by the server (credential-probe.ts `probeNodeAgentLogin`). */
export type NodeAgentLoginProbe = (input: {
  provider: NodeAgentLoginProvider;
  env: Record<string, string>;
  cwd: string;
}) => Promise<NodeAgentLoginAnswer>;

/** The provider whose `node` credential an agent tool runs on, if any. */
export function nodeAgentLoginProvider(agentTool: string): NodeAgentLoginProvider | null {
  if (agentTool === 'claude-code') return 'anthropic';
  if (agentTool === 'codex') return 'openai';
  return null;
}

/** A confirmed login is trusted this long before it is asked again. */
export const NODE_AGENT_LOGIN_CACHE_MS = 5 * 60_000;

/**
 * Wraps the probe with a short positive cache: a fleet spawning many lanes
 * should not pay one `claude auth status` per lane, and a login that was
 * there a minute ago is still the best evidence. Negative and unknown
 * answers are never cached, so a fix is seen on the very next spawn.
 */
export class NodeAgentLoginGate {
  private readonly confirmed = new Map<string, number>();

  constructor(
    private readonly probe: NodeAgentLoginProbe,
    private readonly now: () => number = Date.now,
  ) {}

  async assertUsable(input: {
    provider: NodeAgentLoginProvider;
    env: NodeJS.ProcessEnv;
    cwd: string;
  }): Promise<void> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    const key = [
      input.provider,
      env['HOME'] ?? '',
      input.provider === 'anthropic' ? env['CLAUDE_CONFIG_DIR'] ?? '' : env['CODEX_HOME'] ?? '',
    ].join('\0');
    const until = this.confirmed.get(key);
    if (until !== undefined && until > this.now()) return;

    const answer = await this.probe({ provider: input.provider, env, cwd: input.cwd });
    if (answer.verdict === 'usable') {
      this.confirmed.set(key, this.now() + NODE_AGENT_LOGIN_CACHE_MS);
      return;
    }
    this.confirmed.delete(key);
    if (answer.verdict === 'unknown') return;

    const cli = input.provider === 'anthropic' ? 'claude' : 'codex';
    throw new SpawnError(
      `this session runs on the node's own ${cli} login, and the node has none: ` +
        `${answer.detail ?? `${cli} is not logged in`} (OS user ${answer.runAs}). ` +
        `Log in on the server as that user (${answer.fix}), or launch on a member or space ` +
        `credential instead.`,
      'invalid_input',
      { reason: 'node_agent_login_missing', provider: input.provider, runAs: answer.runAs },
    );
  }
}

/** The named `error` a lane is failed with when it boots into onboarding. */
export const AGENT_ONBOARDING_SCREEN = 'agent_onboarding_screen';

/** Consecutive onboarding reads before the lane is failed (debounces a redraw). */
export const ONBOARDING_FAIL_READS = 3;

/**
 * How long after Claude's banner the watchdog keeps looking for onboarding.
 * The theme picker is drawn UNDER the same "Welcome to Claude Code vX" header
 * the trust watchdog reads as "booted", one frame after it (measured on
 * 2.1.280: banner-only, then the picker). Standing down on the banner alone
 * missed every onboarding hang; a short grace catches the picker and is far too
 * early for a working agent to print its words.
 */
export const ONBOARDING_GRACE_MS = 15_000;

// Matched on whitespace-flattened text, like the trust dialog: the screen is a
// rendered viewport whose wrapping depends on the PTY width. Only consulted
// during boot (the first-prompt wait, then ONBOARDING_GRACE_MS past the banner),
// so a working agent that prints these words is not failed for it.
const ONBOARDING_MARKERS = [
  'Choosethetextstylethatlooksbestwithyourterminal',
  'Selectloginmethod',
] as const;

/** Is Claude Code's first-run onboarding (theme picker / login method) on screen? */
export function readClaudeOnboarding(screen: string): boolean {
  const flat = screen.replace(/\s+/g, '');
  return ONBOARDING_MARKERS.some((marker) => flat.includes(marker));
}
