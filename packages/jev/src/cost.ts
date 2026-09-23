// @tm8/jev — what asking Jev costs.
//
// Jev bills input tokens only: $42 per billion, output free. That is the whole
// price list, so a call's cost is one multiplication and needs no table.

/** $42 per billion input tokens. */
export const JEV_INPUT_USD_PER_TOKEN = 42 / 1e9;

/**
 * Dollars for one call's usage. Takes either the wire's `usage` block or a
 * call record, so a caller never has to reshape one into the other. Output
 * tokens are accepted and ignored: they are free. A missing, negative or
 * non-finite count prices as zero rather than as NaN.
 */
export function costOf(usage: { input_tokens?: number } | { inputTokens?: number }): number {
  const raw = 'inputTokens' in usage ? usage.inputTokens : (usage as { input_tokens?: number }).input_tokens;
  const tokens = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
  return tokens * JEV_INPUT_USD_PER_TOKEN;
}
