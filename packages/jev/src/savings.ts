// @tm8/jev — what the routing decision was worth, in dollars.
//
// THE HONEST SHAPE OF THIS NUMBER, because it is the one most likely to be
// quoted without its caveat:
//
//   * The TOKENS are measured. tm8 already records a per-turn `total_cost_usd`
//     and the four usage lines behind it.
//   * The COMPARISON is a counterfactual. "What Opus would have cost for this
//     work" assumes the cheaper model used the SAME token profile, and a
//     cheaper model may well need more turns to finish — and on this node
//     prefix re-read is 60.1% of the bill, so more turns is exactly what hurts.
//
// So every figure this module returns carries `assumption` naming that, and the
// realised path reports `sameProfileAssumed` so a caller cannot quote the
// saving as measured when it is modelled. §11 of the design doc says the same
// thing at more length, and Phase 2 of the rollout is the experiment that
// settles it.

import {
  DEFAULT_TIER_RATES,
  jevCallCostUsd,
  ratesFor,
  tierOfModel,
  type ModelRates,
  type TierName,
} from './tiers.js';

/** The four lines tm8 already records per turn. */
export interface TokenProfile {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const ZERO_PROFILE: TokenProfile = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The shape of a tm8 session's spend, measured across 357 sessions on this node.
 *
 * Used only to PROJECT a saving before a session has run. Once the session has
 * run, its own profile replaces this. Cache-read dominance is the important
 * part and the reason a tier change moves the bill at all.
 */
export const OBSERVED_SESSION_PROFILE: TokenProfile = {
  input: 0.012,
  output: 0.017,
  cacheRead: 0.601,
  cacheWrite: 0.37,
};

export function costUsd(profile: TokenProfile, rates: ModelRates): number {
  return (
    (profile.input * rates.input +
      profile.output * rates.output +
      profile.cacheRead * rates.cacheRead +
      profile.cacheWrite * rates.cacheWrite) /
    1e6
  );
}

export interface SavingsEstimate {
  readonly baselineTier: TierName;
  readonly chosenTier: TierName;
  readonly baselineUsd: number;
  readonly chosenUsd: number;
  /** Positive = cheaper than baseline. Negative = Jev deliberately spent more. */
  readonly savedUsd: number;
  readonly savedPct: number;
  /** What Jev's own call cost. Netted, because a decision is not free. */
  readonly jevCostUsd: number;
  readonly netSavedUsd: number;
  readonly measured: boolean;
  readonly assumption: string;
}

const SAME_PROFILE =
  'Counterfactual. Assumes the chosen model uses the same token profile as the baseline would have; a cheaper model needing more turns would erode or reverse this.';

/**
 * Project a saving at routing time, before the session exists.
 *
 * `units` scales the observed profile; 1 unit is roughly one median tm8
 * session. Deliberately coarse — this number is for an operator deciding
 * whether the policy is worth switching on, not for a finance ledger.
 */
export function projectSavings(input: {
  baselineModel: string | null | undefined;
  chosenModel: string;
  jevInputTokens?: number;
  units?: number;
  profile?: TokenProfile;
  rates?: Readonly<Record<TierName, ModelRates>>;
}): SavingsEstimate | null {
  const rates = input.rates ?? DEFAULT_TIER_RATES;
  const baselineTier = tierOfModel(input.baselineModel) ?? 'premium';
  const chosenTier = tierOfModel(input.chosenModel);
  if (!chosenTier) return null;

  const units = input.units ?? 1;
  const base = input.profile ?? OBSERVED_SESSION_PROFILE;
  // The observed profile is a SHARE vector; scale it to a session's real token
  // count so the dollar figures are per-session rather than per-unit-share.
  const scale = 1_000_000 * units;
  const profile: TokenProfile = {
    input: base.input * scale,
    output: base.output * scale,
    cacheRead: base.cacheRead * scale,
    cacheWrite: base.cacheWrite * scale,
  };

  // Priced per MODEL so a cross-provider route is not costed at the other
  // vendor's rates; `ratesFor` falls back to the tier when a model has no entry.
  const baselineUsd = costUsd(profile, ratesFor(input.baselineModel, rates));
  const chosenUsd = costUsd(profile, ratesFor(input.chosenModel, rates));
  const savedUsd = baselineUsd - chosenUsd;
  const jevCostUsd = jevCallCostUsd(input.jevInputTokens ?? 0);

  return {
    baselineTier,
    chosenTier,
    baselineUsd,
    chosenUsd,
    savedUsd,
    savedPct: baselineUsd > 0 ? (savedUsd / baselineUsd) * 100 : 0,
    jevCostUsd,
    netSavedUsd: savedUsd - jevCostUsd,
    measured: false,
    assumption: SAME_PROFILE,
  };
}

/**
 * Price a session that has actually run.
 *
 * The chosen side is now MEASURED — these are the session's own token counts at
 * the model it actually ran on. The baseline side is still a counterfactual,
 * and `measured: false` stays false because the SAVING is the difference
 * between a measured thing and a modelled one.
 */
export function realisedSavings(input: {
  baselineModel: string | null | undefined;
  chosenModel: string;
  profile: TokenProfile;
  /** tm8's own recorded figure, when present; preferred over re-pricing. */
  actualUsd?: number | null;
  jevInputTokens?: number;
  rates?: Readonly<Record<TierName, ModelRates>>;
}): SavingsEstimate | null {
  const rates = input.rates ?? DEFAULT_TIER_RATES;
  const baselineTier = tierOfModel(input.baselineModel) ?? 'premium';
  const chosenTier = tierOfModel(input.chosenModel);
  if (!chosenTier) return null;

  const baselineUsd = costUsd(input.profile, ratesFor(input.baselineModel, rates));
  const chosenUsd =
    typeof input.actualUsd === 'number'
      ? input.actualUsd
      : costUsd(input.profile, ratesFor(input.chosenModel, rates));
  const savedUsd = baselineUsd - chosenUsd;
  const jevCostUsd = jevCallCostUsd(input.jevInputTokens ?? 0);

  return {
    baselineTier,
    chosenTier,
    baselineUsd,
    chosenUsd,
    savedUsd,
    savedPct: baselineUsd > 0 ? (savedUsd / baselineUsd) * 100 : 0,
    jevCostUsd,
    netSavedUsd: savedUsd - jevCostUsd,
    measured: false,
    assumption: SAME_PROFILE,
  };
}

export interface SavingsLedgerRow {
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly baselineModel: string;
  readonly chosenModel: string;
  readonly savedUsd: number;
  readonly jevCostUsd: number;
}

export interface SavingsTotals {
  readonly decisions: number;
  readonly routedCheaper: number;
  readonly routedDearer: number;
  readonly routedSame: number;
  readonly grossSavedUsd: number;
  readonly jevSpendUsd: number;
  readonly netSavedUsd: number;
  /** Gross saving per dollar spent on Jev. The "is this worth it" number. */
  readonly returnMultiple: number | null;
}

/** Fold a ledger. The only aggregate an operator actually asks for. */
export function totalSavings(rows: readonly SavingsLedgerRow[]): SavingsTotals {
  let gross = 0;
  let jev = 0;
  let cheaper = 0;
  let dearer = 0;
  let same = 0;
  for (const r of rows) {
    gross += r.savedUsd;
    jev += r.jevCostUsd;
    if (r.chosenModel === r.baselineModel) same += 1;
    else if (r.savedUsd > 0) cheaper += 1;
    else dearer += 1;
  }
  return {
    decisions: rows.length,
    routedCheaper: cheaper,
    routedDearer: dearer,
    routedSame: same,
    grossSavedUsd: gross,
    jevSpendUsd: jev,
    netSavedUsd: gross - jev,
    returnMultiple: jev > 0 ? gross / jev : null,
  };
}

export function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}
