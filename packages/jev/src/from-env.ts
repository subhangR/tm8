// @tm8/jev — the one place a node decides whether it routes at all.
//
// TWO SWITCHES, AND BOTH MUST BE ON. A node routes only when it has a key AND
// a policy that is not `off`. Either missing yields `undefined`, the caller
// injects nothing, and every spawn resolves its model through the precedence
// chain it always did. That is the whole rollout story: shipping this to a
// fleet that has set no environment variables changes no behaviour anywhere,
// which is why it needs no feature flag and no migration.
//
// THE KEY IS READ FROM THE SERVER'S ENVIRONMENT AND NEVER LEAVES IT. It is not
// put on the manifest, not composed into a prompt, not passed to the agent
// process, and not returned by any RPC — the router runs inside tm8-server and
// only its verdict travels. The manifest's redaction pass would catch a leak,
// but the design is to have nothing to catch.

import { JevClient, jevKeyFromEnv } from './client.js';
import type { JevLogger } from './primitives.js';
import {
  DEFAULT_ROUTING_POLICY,
  JevRoutingAdvisor,
  type RoutingAdvisorPort,
  type RoutingPolicy,
} from './advisor.js';
import {
  JevContextAdvisor,
  type ContextAdvisorPort,
  type ContextBudget,
} from './context.js';
import { JevRosterAdvisor, type RosterAdvisorPort } from './roster.js';

export const ROUTING_POLICY_ENV = 'TM8_ROUTING_POLICY';

export function routingPolicyFromEnv(env: NodeJS.ProcessEnv): RoutingPolicy {
  const raw = env[ROUTING_POLICY_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'advise' || raw === 'auto') return raw;
  // An unset policy is the default; a MISSPELLED one is not. `TM8_ROUTING_POLICY=Auto`
  // silently falling back to `advise` would be a four-hour debugging session,
  // so anything unrecognised is refused loudly at startup instead.
  if (raw) {
    throw new Error(
      `${ROUTING_POLICY_ENV}='${raw}' is not a routing policy — use off, advise or auto`,
    );
  }
  return DEFAULT_ROUTING_POLICY;
}

export interface RoutingAdvisorFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  logger?: JevLogger;
  /** tm8's own fallback, so the counterfactual baseline matches DEFAULT_MODEL. */
  defaultModel?: string;
}

/**
 * Build the advisor a node should inject, or `undefined` for "this node does
 * not route".
 *
 * Returning `undefined` rather than {@link nullRoutingAdvisor} is deliberate:
 * the caller spreads it conditionally, so an unrouted node holds no object, logs
 * no line and constructs no HTTP client. "Configured off" and "never configured"
 * end up in the same place, which is the place tm8 was before this existed.
 */
export function routingAdvisorFromEnv(
  options: RoutingAdvisorFromEnvOptions = {},
): RoutingAdvisorPort | undefined {
  const env = options.env ?? process.env;
  const policy = routingPolicyFromEnv(env);
  if (policy === 'off') return undefined;

  const apiKey = jevKeyFromEnv(env);
  if (!apiKey) {
    // Not an error. A fleet can set the policy centrally and roll the key out
    // node by node; the ones without it route nothing and say so once.
    options.logger?.info?.(
      'jev: routing policy is set but no TYPESAFE_API_KEY is present — launching unrouted',
      { policy },
    );
    return undefined;
  }

  options.logger?.info?.('jev: model routing is active', { policy });
  return new JevRoutingAdvisor({
    client: new JevClient({ apiKey }),
    policy,
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

export const CONTEXT_POLICY_ENV = 'TM8_CONTEXT_POLICY';
export const CONTEXT_BYTES_ENV = 'TM8_CONTEXT_BYTES';

export type ContextPolicy = 'off' | 'on';
/**
 * Default OFF, where routing defaults to `advise`.
 *
 * The asymmetry is deliberate and is about what each one risks. A mis-routed
 * model produces the same work at the wrong price; a mis-selected memory
 * produces an agent that does not know something its operator believed it
 * knew, and that failure is silent and looks like the agent being bad at its
 * job. So this one is opted INTO per fleet, after someone has read a few
 * plans on real personas, rather than arriving switched on.
 */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = 'off';

export function contextPolicyFromEnv(env: NodeJS.ProcessEnv): ContextPolicy {
  const raw = env[CONTEXT_POLICY_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'on') return raw;
  if (raw) {
    throw new Error(`${CONTEXT_POLICY_ENV}='${raw}' is not a context policy — use off or on`);
  }
  return DEFAULT_CONTEXT_POLICY;
}

export interface ContextAdvisorFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  logger?: JevLogger;
  budget?: ContextBudget;
}

/**
 * Build the context engineer a node should inject, or `undefined`.
 *
 * Same two-switch rule as {@link routingAdvisorFromEnv}: policy on AND a key
 * present, or nothing is injected and every spawn carries every memory and
 * every skill exactly as it always has.
 */
export function contextAdvisorFromEnv(
  options: ContextAdvisorFromEnvOptions = {},
): ContextAdvisorPort | undefined {
  const env = options.env ?? process.env;
  if (contextPolicyFromEnv(env) === 'off') return undefined;

  const apiKey = jevKeyFromEnv(env);
  if (!apiKey) {
    options.logger?.info?.(
      'jev: context policy is on but no TYPESAFE_API_KEY is present — injecting everything',
    );
    return undefined;
  }

  // A budget of 0 would silently mean "keep only the floor", which is not a
  // thing anyone types on purpose, so it is refused like a misspelt policy.
  const rawBytes = env[CONTEXT_BYTES_ENV]?.trim();
  let bytes: number | undefined;
  if (rawBytes) {
    bytes = Number(rawBytes);
    if (!Number.isInteger(bytes) || bytes < 1024) {
      throw new Error(`${CONTEXT_BYTES_ENV}='${rawBytes}' is not a byte budget — use an integer >= 1024`);
    }
  }

  options.logger?.info?.('jev: context engineering is active', { bytes: bytes ?? 'default' });
  return new JevContextAdvisor({
    client: new JevClient({ apiKey }),
    budget: { ...options.budget, ...(bytes ? { bytes } : {}) },
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

// -- teammate selection -------------------------------------------------------

export const ROSTER_POLICY_ENV = 'TM8_ROSTER_POLICY';

export type RosterPolicy = 'off' | 'on';

/**
 * Default OFF, for the same reason context engineering is.
 *
 * Choosing a teammate is the most VISIBLE of the three decisions: a model swap
 * shows up on a bill, a trimmed memory shows up in a plan, but a task landing
 * on the wrong person's queue is something a human sees and has an opinion
 * about. A fleet opts in once its roster personas actually describe what their
 * owners do.
 */
export const DEFAULT_ROSTER_POLICY: RosterPolicy = 'off';

export function rosterPolicyFromEnv(env: NodeJS.ProcessEnv): RosterPolicy {
  const raw = env[ROSTER_POLICY_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'on') return raw;
  if (raw) {
    throw new Error(`${ROSTER_POLICY_ENV}='${raw}' is not a roster policy — use off or on`);
  }
  return DEFAULT_ROSTER_POLICY;
}

export interface RosterAdvisorFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  logger?: JevLogger;
}

/**
 * Build the teammate selector a node should inject, or `undefined`.
 *
 * Same two-switch rule as the other two: policy on AND a key present, or the
 * caller names whoever it would have named without asking anyone.
 */
export function rosterAdvisorFromEnv(
  options: RosterAdvisorFromEnvOptions = {},
): RosterAdvisorPort | undefined {
  const env = options.env ?? process.env;
  if (rosterPolicyFromEnv(env) === 'off') return undefined;

  const apiKey = jevKeyFromEnv(env);
  if (!apiKey) {
    options.logger?.info?.(
      'jev: roster policy is on but no TYPESAFE_API_KEY is present — not selecting teammates',
    );
    return undefined;
  }

  options.logger?.info?.('jev: teammate selection is active');
  return new JevRosterAdvisor({
    client: new JevClient({ apiKey }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
