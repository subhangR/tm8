// @tm8/jev — the port tm8 injects, and the activation record it produces.
//
// SHAPE. `RoutingAdvisorPort.advise()` returns `RoutingAdvice | null`, and
// `null` means "no opinion". The default implementation returns `null` always,
// so a node that wires nothing behaves byte-for-byte as tm8 does today. This is
// the `credentialHome` pattern in SpawnService — optional, unwired is a no-op,
// no feature flag — and it is what lets this land without a migration.
//
// PRECEDENCE is a space-level policy with three settings, and the default is
// the middle one. The ask was "switch the model automatically", which is right
// for the common case and wrong for one: a human who deliberately chose Opus
// and silently got Haiku has been handed exactly the surprise tm8's own
// credential catalog warns about — "a quiet substitution of one vendor for
// another". So `advise` keeps an explicit human choice and flags disagreement;
// `auto` is opt-in and overrides. Loops, dispatched work and API spawns carry
// no human choice at all, so they route under every policy but `off` — which is
// where the majority of sessions, and therefore the majority of the bill, are.

import type { RoutingVerdict } from './policy.js';
import type { JevLogger } from './primitives.js';
import { DEFAULT_WEIGHTS, verdictFrom, type RoutingWeights } from './policy.js';
import { ROUTING_QUESTIONS, routingState, type TaskFacts } from './questions.js';
import { JevClient } from './client.js';
import { projectSavings, type SavingsEstimate } from './savings.js';

export type RoutingPolicy = 'off' | 'advise' | 'auto';
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = 'advise';

export type ActivationMode = 'inline' | 'on-write' | 'swept' | 'on-demand';

/** What the caller was about to do, before Jev saw it. */
export interface LaunchIntent {
  /** Model named on the request by a human or a caller. Null = nobody chose. */
  readonly requestedModel?: string | null;
  /** The persona's default, which is what an unrouted spawn falls back to. */
  readonly memberModel?: string | null;
  readonly requestedAgentTool?: string | null;
}

/**
 * The durable record of one Jev activation.
 *
 * This is the "show me that Jev did something" surface. It is written onto the
 * manifest, rendered by `tm8 task route`, and posted to the task anchor when a
 * route actually changes something — because a routing decision nobody can see
 * did not happen. The dispatcher persona already carries that rule in prose;
 * a machine router inherits it.
 */
export interface RoutingActivation {
  readonly at: string;
  readonly mode: ActivationMode;
  readonly policy: RoutingPolicy;
  /** Jev's concrete version, echoed by the API (e.g. `jev-1.13.0`). */
  readonly jevModel: string;
  readonly latencyMs: number;
  readonly jevInputTokens: number;
  readonly jevCostUsd: number;
  readonly verdict: RoutingVerdict;
  /** What would have run without Jev. */
  readonly baselineModel: string;
  /** What will actually run, after precedence. */
  readonly appliedModel: string;
  readonly appliedAgentTool: 'claude-code' | 'codex';
  /** True when Jev's verdict actually changed the launch. */
  readonly changed: boolean;
  /**
   * Set when the policy kept a human's explicit choice that Jev disagreed with.
   * This is the `advise` case, and the reason it deserves attention rather than
   * silence.
   */
  readonly overriddenByHuman: boolean;
  readonly savings: SavingsEstimate | null;
  readonly summary: string;
}

export interface RoutingAdvice {
  readonly verdict: RoutingVerdict;
  readonly activation: RoutingActivation;
  /** Null when precedence says keep what the caller asked for. */
  readonly model: string | null;
  readonly agentTool: 'claude-code' | 'codex' | null;
  readonly effort: string | null;
}

export interface RoutingAdvisorPort {
  /**
   * `null` means no opinion, for ANY reason: policy off, no task, Jev down,
   * malformed answers, missing key. Callers must treat it as "carry on".
   */
  advise(task: TaskFacts | null, intent: LaunchIntent, mode?: ActivationMode): Promise<RoutingAdvice | null>;
}

/** The default. Wired everywhere, opinionated nowhere. */
export const nullRoutingAdvisor: RoutingAdvisorPort = {
  async advise() {
    return null;
  },
};

export interface JevRoutingAdvisorOptions {
  client: JevClient;
  policy?: RoutingPolicy;
  weights?: RoutingWeights;
  /** Default model tm8 falls back to, for the counterfactual baseline. */
  defaultModel?: string;
  logger?: JevLogger;
  now?: () => Date;
}

export class JevRoutingAdvisor implements RoutingAdvisorPort {
  private readonly client: JevClient;
  private readonly policy: RoutingPolicy;
  private readonly weights: RoutingWeights;
  private readonly defaultModel: string;
  private readonly logger: JevRoutingAdvisorOptions['logger'];
  private readonly now: () => Date;

  constructor(options: JevRoutingAdvisorOptions) {
    this.client = options.client;
    this.policy = options.policy ?? DEFAULT_ROUTING_POLICY;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-5';
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async advise(
    task: TaskFacts | null,
    intent: LaunchIntent,
    mode: ActivationMode = 'inline',
  ): Promise<RoutingAdvice | null> {
    if (this.policy === 'off') return null;
    // No task means nothing to route ON. A bare session with no assignment is
    // exactly the case where the persona's default is the best information
    // anyone has, so Jev declines rather than guessing from an empty state.
    if (!task || !(task.title || task.description)) return null;

    const call = await this.client.ask(routingState(task), ROUTING_QUESTIONS);
    if (!call) return null;

    const verdict = verdictFrom(call.response, this.weights);
    if (!verdict) {
      this.logger?.warn?.('jev: answers did not parse into a verdict', { taskId: task.id });
      return null;
    }

    const humanChose = Boolean(intent.requestedModel?.trim());
    const baselineModel =
      intent.requestedModel?.trim() || intent.memberModel?.trim() || this.defaultModel;

    // The precedence rule, in one place.
    const applies = this.policy === 'auto' || !humanChose;
    const appliedModel = applies ? verdict.model : baselineModel;
    const appliedAgentTool = applies
      ? verdict.agentTool
      : ((intent.requestedAgentTool?.trim() as 'claude-code' | 'codex') ?? verdict.agentTool);
    const changed = appliedModel !== baselineModel;
    const overriddenByHuman = humanChose && !applies && verdict.model !== baselineModel;

    const jevInputTokens = call.response.usage?.input_tokens ?? 0;
    const savings = projectSavings({
      baselineModel,
      chosenModel: appliedModel,
      jevInputTokens,
    });

    const activation: RoutingActivation = {
      at: this.now().toISOString(),
      mode,
      policy: this.policy,
      jevModel: call.response.model,
      latencyMs: call.latencyMs,
      jevInputTokens,
      jevCostUsd: (savings?.jevCostUsd ?? 0),
      verdict,
      baselineModel,
      appliedModel,
      appliedAgentTool,
      changed,
      overriddenByHuman,
      savings,
      summary: summarise({ baselineModel, appliedModel, changed, overriddenByHuman, verdict, savings }),
    };

    this.logger?.info?.('jev: routing verdict', {
      taskId: task.id,
      tier: verdict.tier,
      model: appliedModel,
      changed,
      latencyMs: call.latencyMs,
    });

    return {
      verdict,
      activation,
      model: applies ? verdict.model : null,
      agentTool: applies ? verdict.agentTool : null,
      effort: applies ? verdict.effort : null,
    };
  }
}

function summarise(input: {
  baselineModel: string;
  appliedModel: string;
  changed: boolean;
  overriddenByHuman: boolean;
  verdict: RoutingVerdict;
  savings: SavingsEstimate | null;
}): string {
  const { verdict } = input;
  if (input.overriddenByHuman) {
    return `Jev would route this ${verdict.tier} (${verdict.model}); keeping ${input.baselineModel} because a human named it. Policy 'auto' would switch it.`;
  }
  if (!input.changed) {
    return `Jev agrees with ${input.appliedModel} (${verdict.tier}, need ${verdict.need.toFixed(2)}).`;
  }
  const delta = input.savings?.savedUsd ?? 0;
  const direction = delta > 0 ? 'cheaper' : 'dearer, deliberately';
  return `Jev routed ${input.baselineModel} -> ${input.appliedModel} (${verdict.tier}, need ${verdict.need.toFixed(2)}) — ${direction}.`;
}
