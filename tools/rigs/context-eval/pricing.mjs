// The ONE pricing table the eval uses. $ per million tokens, by model-id prefix.
// VERIFY these against the vendor's current price list before quoting a $ figure
// in a decision: they are the public list prices known when the rig was written
// (2026-09-25). A row's `costUsd` is an ESTIMATE either way, and the report
// says so.
//
// `CHARS_PER_TOKEN` converts measured prompt chars into the token share each
// component gets of the first request; it is an average for English prose +
// XML and is the only estimate in the size-by-component table.

export const CHARS_PER_TOKEN = 3.6;

export const PRICING = [
  // [model-id prefix, input, cache write (5m), cache read, output]
  ['claude-haiku-4-5', 1.0, 1.25, 0.1, 5.0],
  ['claude-sonnet-5', 3.0, 3.75, 0.3, 15.0], // VERIFY
  ['claude-sonnet-4-5', 3.0, 3.75, 0.3, 15.0],
  ['claude-opus-5-5', 5.0, 6.25, 0.5, 25.0], // VERIFY
  ['claude-opus-5', 5.0, 6.25, 0.5, 25.0], // VERIFY
  ['claude-opus-4-5', 5.0, 6.25, 0.5, 25.0],
  ['claude-fable-5-1', 5.0, 6.25, 0.5, 25.0], // VERIFY
];

export function priceFor(modelId) {
  const id = String(modelId ?? '').replace(/\[.*\]$/, '');
  const row = PRICING.find(([prefix]) => id.startsWith(prefix));
  if (!row) return null;
  const [prefix, input, cacheWrite, cacheRead, output] = row;
  return { prefix, input, cacheWrite, cacheRead, output };
}

/** Estimated $ for one lane from its usage totals; null when the model is not priced. */
export function laneCostUsd(modelId, usage) {
  const p = priceFor(modelId);
  if (!p || !usage) return null;
  const m = 1_000_000;
  return ((usage.input ?? 0) * p.input + (usage.cacheCreation ?? 0) * p.cacheWrite + (usage.cacheRead ?? 0) * p.cacheRead + (usage.output ?? 0) * p.output) / m;
}
