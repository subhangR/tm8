// @tm8/jev — the tier ladder and the rate table.
//
// Both are DATA, deliberately. Changing a weight, a threshold or a rate must
// re-route and re-price without re-running a single inference and without
// touching the policy code — the docs make that point about judgements, and it
// holds twice over for a ladder that changes every time a model ships.

import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';

export type TierName = 'economy' | 'standard' | 'premium' | 'frontier';

export const TIER_ORDER: readonly TierName[] = ['economy', 'standard', 'premium', 'frontier'];

export interface TierRung {
  readonly tier: TierName;
  /** Anthropic model, run on claude-code. */
  readonly claude: string;
  /** OpenAI counterpart at the same rung, run on codex. */
  readonly codex: string;
  /** Reasoning-effort stop for this rung. Validated against the model catalog. */
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * The ladder.
 *
 * `frontier` is the 1M-context variant rather than a different family: what
 * separates it from `premium` is a capability (holding the whole thing at
 * once), not more intelligence, which is why only `needs_long_context` promotes
 * into it.
 */
/*
 * WHY KIMI IS IN THE CATALOG BUT NOT ON THIS LADDER.
 *
 * Every rung here is a model Jev may route to on its own. Kimi is reachable
 * only while a member has connected the Moonshot key, and that connection is
 * ACCOUNT-WIDE and DISPLACES anthropic — so routing a session to Kimi is not a
 * per-session choice the router can make, and a session routed there on an
 * account without the key would fail at boot reading as a Jev outage. Manual
 * selection stays available (LAUNCH_MODEL_CATALOG carries the rows, and
 * DEFAULT_MODEL_RATES below prices them); automatic routing waits for the
 * router to be able to SEE credential state, which today it cannot.
 *
 * The same holds for every Groq row, in the other direction: that key
 * displaces `openai`, so it would take the whole codex half of this ladder
 * with it.
 */
export const TIER_LADDER: readonly TierRung[] = [
  { tier: 'economy', claude: 'claude-haiku-4-5-20251001', codex: 'gpt-5.6-luna', effort: 'medium' },
  { tier: 'standard', claude: 'claude-sonnet-5', codex: 'gpt-5.6-terra', effort: 'high' },
  { tier: 'premium', claude: 'claude-opus-5', codex: 'gpt-6-astra', effort: 'high' },
  { tier: 'frontier', claude: 'claude-opus-5[1m]', codex: 'gpt-6-astra', effort: 'max' },
];

export function rung(tier: TierName): TierRung {
  const found = TIER_LADDER.find((r) => r.tier === tier);
  // The ladder is exhaustive over TierName; this keeps the return non-optional
  // under noUncheckedIndexedAccess rather than pushing a `!` onto every caller.
  if (!found) throw new Error(`jev: no ladder rung for tier '${tier}'`);
  return found;
}

export function tierIndex(tier: TierName): number {
  return TIER_ORDER.indexOf(tier);
}

/** Which tier a model sits on, or null for a model the ladder does not name. */
export function tierOfModel(model: string | null | undefined): TierName | null {
  if (!model) return null;
  const hit = TIER_LADDER.find((r) => r.claude === model || r.codex === model);
  return hit?.tier ?? null;
}

/**
 * Dollars per million tokens, by rate line.
 *
 * PROVENANCE, because a savings figure is only as honest as its rate table.
 * These are the relative per-token rates observed on this node's own
 * session-usage report, normalised to $/Mtok. They are DEFAULTS and are meant
 * to be overridden by an operator with current list prices — every consumer
 * takes a `rates` argument.
 *
 * `cacheRead` is the line that matters. On the measured node it was 60.1% of a
 * $7,983 bill, because tm8 sessions carry long stable prefixes that are re-read
 * on every turn and re-charged at the cache-read rate. A model change moves
 * this line more than it moves fresh input.
 */
export interface ModelRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const DEFAULT_TIER_RATES: Readonly<Record<TierName, ModelRates>> = {
  economy: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  standard: { input: 3.0, output: 15.0, cacheRead: 0.2, cacheWrite: 3.75 },
  premium: { input: 15.0, output: 75.0, cacheRead: 0.5, cacheWrite: 18.75 },
  frontier: { input: 15.0, output: 75.0, cacheRead: 0.5, cacheWrite: 18.75 },
};

/**
 * Per-MODEL overrides, because this router is cross-provider.
 *
 * Pricing a Codex session at Anthropic's rates would make every cross-provider
 * route report a saving it did not make — and the whole point of asking
 * `harness_fit` is that the cheaper answer is sometimes the other vendor. A
 * model absent from this table falls back to its tier's rates, so adding a
 * model to the ladder never silently prices it wrong: it prices it as its tier,
 * which is the honest default for a model whose rate nobody has entered.
 *
 * DEFAULTS, again to be overridden by an operator with current list prices.
 */
export const DEFAULT_MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  'gpt-5.6-luna': { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.5 },
  'gpt-5.6-terra': { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 },
  'gpt-6-astra': { input: 10.0, output: 40.0, cacheRead: 1.0, cacheWrite: 10.0 },

  // Kimi, entered for a reason that is not routing: these models are NOT on
  // the ladder (see the note there), but they ARE in the launch catalog, so a
  // member can select one by hand. Without a line here `ratesFor` would find
  // no tier for them and fall back to `premium` — pricing a Moonshot session
  // at $15/Mtok input, roughly twenty-five times its actual rate, and making
  // every saving measured against one a fabrication. A wrong rate is worse
  // than an absent model, and this is the whole reason the fallback is
  // documented as "honest default" rather than "correct".
  'kimi-k2-thinking': { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
  'kimi-k2-thinking-turbo': { input: 1.15, output: 8.0, cacheRead: 0.15, cacheWrite: 1.15 },
  'kimi-k2-turbo-preview': { input: 1.15, output: 8.0, cacheRead: 0.15, cacheWrite: 1.15 },
  'kimi-k2-0905-preview': { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },

  // Groq, entered for the same reason. NOTE `cacheRead === input` on every
  // line: Groq bills a re-read prompt at the ordinary input rate, so the one
  // line that dominates a tm8 bill gets NO discount here. That is not a
  // rounding choice — copying Anthropic's 10x cache discount onto these rows
  // would make a Groq route look like the cheapest thing on the node by a
  // factor the vendor does not actually offer.
  'openai/gpt-oss-120b': { input: 0.15, output: 0.75, cacheRead: 0.15, cacheWrite: 0.15 },
  'openai/gpt-oss-20b': { input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.1 },
  'moonshotai/kimi-k2-instruct-0905': { input: 1.0, output: 3.0, cacheRead: 1.0, cacheWrite: 1.0 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79, cacheRead: 0.59, cacheWrite: 0.59 },
  'qwen/qwen3-32b': { input: 0.29, output: 0.59, cacheRead: 0.29, cacheWrite: 0.29 },
  'deepseek-r1-distill-llama-70b': { input: 0.75, output: 0.99, cacheRead: 0.75, cacheWrite: 0.75 },
};

/** Rates for a model: its own entry, else its tier's, else `premium`. */
export function ratesFor(
  model: string | null | undefined,
  tierRates: Readonly<Record<TierName, ModelRates>> = DEFAULT_TIER_RATES,
  modelRates: Readonly<Record<string, ModelRates>> = DEFAULT_MODEL_RATES,
): ModelRates {
  const direct = model ? modelRates[model] : undefined;
  if (direct) return direct;
  const tier = tierOfModel(model) ?? 'premium';
  return tierRates[tier];
}

/** What Jev itself costs: $42 per billion input tokens, output free. */
export const JEV_INPUT_USD_PER_TOKEN = 42 / 1e9;

export function jevCallCostUsd(inputTokens: number): number {
  return inputTokens * JEV_INPUT_USD_PER_TOKEN;
}

/**
 * Guard: every model the ladder names must exist in the launch catalog.
 *
 * Without this, a ladder typo routes a session to a model the CLI builder will
 * reject at boot — a spawn failure that reads as a Jev outage rather than a
 * one-character mistake. Exported so the package's own tests assert it, and so
 * an operator editing the ladder finds out at startup rather than at 3am.
 */
export function assertLadderIsLaunchable(): void {
  const known = new Set<string>(LAUNCH_MODEL_CATALOG.map((e) => e.model));
  for (const r of TIER_LADDER) {
    for (const model of [r.claude, r.codex]) {
      if (!known.has(model)) {
        throw new Error(`jev: tier '${r.tier}' names model '${model}', which is not in LAUNCH_MODEL_CATALOG`);
      }
    }
    const entry = LAUNCH_MODEL_CATALOG.find((e) => e.model === r.claude);
    const efforts: readonly string[] = entry?.efforts ?? [];
    if (entry && !efforts.includes(r.effort)) {
      throw new Error(`jev: tier '${r.tier}' uses effort '${r.effort}', which '${r.claude}' does not accept`);
    }
  }
}
