import { describe, expect, it } from 'vitest';
import {
  OBSERVED_SESSION_PROFILE,
  costUsd,
  formatUsd,
  projectSavings,
  realisedSavings,
  totalSavings,
} from '../src/savings.js';
import { DEFAULT_TIER_RATES, ratesFor, tierOfModel } from '../src/tiers.js';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';

describe('rates', () => {
  it('prices a codex model at codex rates, not at the tier it shares with Opus', () => {
    // The whole point of asking harness_fit is that the other vendor is
    // sometimes cheaper; pricing both at one vendor's card hides that.
    expect(ratesFor('gpt-6-astra')).not.toEqual(DEFAULT_TIER_RATES.premium);
    expect(ratesFor('gpt-6-astra').input).toBeLessThan(DEFAULT_TIER_RATES.premium.input);
  });

  it('falls back to the tier for a ladder model with no rate entry', () => {
    expect(ratesFor('claude-opus-5')).toEqual(DEFAULT_TIER_RATES.premium);
  });

  it('falls back to premium for a model nothing knows, so it is never under-priced', () => {
    expect(ratesFor('some-unreleased-model')).toEqual(DEFAULT_TIER_RATES.premium);
  });
});

describe('the profile that matters', () => {
  it('is dominated by cache reads, which is why a tier change moves the bill', () => {
    const p = OBSERVED_SESSION_PROFILE;
    expect(p.cacheRead).toBeGreaterThan(p.input + p.output);
  });

  it('costs nothing for no tokens', () => {
    expect(costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, DEFAULT_TIER_RATES.premium)).toBe(0);
  });
});

describe('projected savings', () => {
  it('reports a saving when Jev routes down', () => {
    const s = projectSavings({ baselineModel: 'claude-opus-5', chosenModel: 'claude-haiku-4-5-20251001' })!;
    expect(s.savedUsd).toBeGreaterThan(0);
    expect(s.savedPct).toBeGreaterThan(0);
  });

  it('reports a NEGATIVE saving when the policy deliberately spends more', () => {
    // Promoting production work off a cheap tier costs money on purpose. A
    // savings report that hid that would be marketing, not accounting.
    const s = projectSavings({ baselineModel: 'claude-haiku-4-5-20251001', chosenModel: 'claude-opus-5' })!;
    expect(s.savedUsd).toBeLessThan(0);
  });

  it('reports zero when the route did not change anything', () => {
    const s = projectSavings({ baselineModel: 'claude-opus-5', chosenModel: 'claude-opus-5' })!;
    expect(s.savedUsd).toBe(0);
  });

  it('assumes premium as the baseline when nobody named a model', () => {
    expect(projectSavings({ baselineModel: null, chosenModel: 'claude-sonnet-5' })!.baselineTier).toBe('premium');
  });

  it('returns null for a model outside the ladder rather than inventing a number', () => {
    expect(projectSavings({ baselineModel: 'claude-opus-5', chosenModel: 'claude-fable-5' })).toBeNull();
  });

  it('scales with units', () => {
    const one = projectSavings({ baselineModel: 'claude-opus-5', chosenModel: 'claude-haiku-4-5-20251001', units: 1 })!;
    const ten = projectSavings({ baselineModel: 'claude-opus-5', chosenModel: 'claude-haiku-4-5-20251001', units: 10 })!;
    expect(ten.savedUsd).toBeCloseTo(one.savedUsd * 10, 6);
  });
});

describe('realised savings', () => {
  const profile = { input: 10_000, output: 5_000, cacheRead: 2_000_000, cacheWrite: 100_000 };

  it("prefers tm8's own recorded cost over re-pricing the tokens", () => {
    const s = realisedSavings({
      baselineModel: 'claude-opus-5',
      chosenModel: 'claude-sonnet-5',
      profile,
      actualUsd: 0.42,
    })!;
    expect(s.chosenUsd).toBe(0.42);
  });

  it('still refuses to call the saving measured', () => {
    // The chosen side is measured; the baseline side is a counterfactual, so
    // the DIFFERENCE is modelled and must not be quoted as observed.
    const s = realisedSavings({ baselineModel: 'claude-opus-5', chosenModel: 'claude-sonnet-5', profile })!;
    expect(s.measured).toBe(false);
  });
});

describe('the ledger', () => {
  const rows = [
    { baselineModel: 'claude-opus-5', chosenModel: 'claude-haiku-4-5-20251001', savedUsd: 1.2, jevCostUsd: 0.00005 },
    { baselineModel: 'claude-haiku-4-5-20251001', chosenModel: 'claude-opus-5', savedUsd: -3.0, jevCostUsd: 0.00005 },
    { baselineModel: 'claude-opus-5', chosenModel: 'claude-opus-5', savedUsd: 0, jevCostUsd: 0.00005 },
  ];

  it('counts cheaper, dearer and unchanged separately', () => {
    const t = totalSavings(rows);
    expect(t.decisions).toBe(3);
    expect(t.routedCheaper).toBe(1);
    expect(t.routedDearer).toBe(1);
    expect(t.routedSame).toBe(1);
  });

  it('nets Jev spend off the gross', () => {
    const t = totalSavings(rows);
    expect(t.grossSavedUsd).toBeCloseTo(-1.8, 10);
    expect(t.netSavedUsd).toBeCloseTo(-1.8 - 0.00015, 10);
  });

  it('has no return multiple when nothing was spent', () => {
    expect(totalSavings([]).returnMultiple).toBeNull();
  });
});

describe('formatting', () => {
  it('keeps small numbers legible instead of rounding them to zero', () => {
    expect(formatUsd(0.000069)).toBe('$0.000069');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});

describe('every selectable model is priced', () => {
  // The fallback chain is model rate -> tier rate -> premium. That last step is
  // a reasonable default WITHIN a vendor and a wrong one ACROSS vendors: a Groq
  // or Moonshot session priced at Anthropic's $15/Mtok reports a cost roughly
  // twenty-five times what it was, and any saving measured against it is a
  // fabrication. So the rule is drawn at the vendor boundary — a cross-provider
  // model the ladder does not place needs its own rate line.
  //
  // DELIBERATELY NOT ASSERTED: the four `claude-fable-*` rows also fall through
  // to premium, because the ladder names neither. That is an Anthropic model
  // priced at an Anthropic rate on a plausible rung, so it is a default rather
  // than a lie — but it IS a default nobody chose, and it is the reason this
  // block draws its line at `provider` instead of at ladder membership.
  const crossProvider = LAUNCH_MODEL_CATALOG.filter(
    (entry) => entry.provider !== 'anthropic' && entry.provider !== 'openai',
  );

  it('has a rate line for every cross-provider model the catalog offers', () => {
    expect(crossProvider.length).toBeGreaterThan(0);
    for (const entry of crossProvider) {
      expect(tierOfModel(entry.model), `${entry.model} is on the ladder`).toBeNull();
      expect(
        ratesFor(entry.model),
        `${entry.model} falls through to premium rates`,
      ).not.toEqual(DEFAULT_TIER_RATES.premium);
    }
  });

  it('never gives a Groq model a cache discount it does not sell', () => {
    for (const entry of LAUNCH_MODEL_CATALOG.filter((e) => e.provider === 'groq')) {
      const rates = ratesFor(entry.model);
      expect(rates.cacheRead, `${entry.model} discounts cache reads`).toBe(rates.input);
    }
  });
});
