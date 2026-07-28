/**
 * The §8.1 byte budgets.
 *
 * WHY BYTES AND NOT TOKENS. Every provider tokenizes differently, so a token
 * count is a provider-specific observation, not a contract. The harness spec
 * makes bytes authoritative for exactly that reason: "Token counts may be
 * observed but never used as the only enforcement."
 *
 * WHY THROWING AND NOT TRUNCATING. §8.1 again: "Silent truncation is a
 * contract failure." A kernel that quietly loses its last paragraph — the one
 * about untrusted data, as it happens, because it is last — produces an agent
 * that looks fine and is not. A refused launch is loud, attributable, and
 * fixable; a clipped prompt is none of those. Material that is legitimately
 * larger than its budget (a task body, a message) is not truncated here at all:
 * it is excerpted with a cursor by its own caller and declares `truncated`.
 */

/** The hard ceilings. A validated Interaction Profile may choose smaller. */
export const BYTE_BUDGETS = {
  /** Agent-facing bootstrap manifest (§5.1). */
  manifest: 4096,
  /** Trusted kernel prompt (§5.2). */
  kernel: 6144,
  /** Initial assignment snapshot across all assigned tasks (§5.3). */
  assignmentSnapshot: 16384,
  /** Everything injected before the agent's first turn (§5.2, B2). */
  combinedInitialInjection: 32768,
  /** The frozen entity-handoff envelope (§14.6) — exact, not a default. */
  handoffEnvelope: 32768,
  /** One incoming-message injection: excerpt plus fetch reference (§8.1). */
  incomingMessageInjection: 16384,
} as const;

export type BudgetName = keyof typeof BYTE_BUDGETS;

/** UTF-8 byte length. `'🛠'.length` is 2 JS code units and 4 UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export class BudgetExceededError extends Error {
  readonly material: BudgetName;
  readonly bytes: number;
  readonly cap: number;

  constructor(material: BudgetName, bytes: number, cap: number) {
    super(`${material} is ${bytes} UTF-8 bytes, over its ${cap}-byte hard cap`);
    this.name = 'BudgetExceededError';
    this.material = material;
    this.bytes = bytes;
    this.cap = cap;
  }
}

/** Returns `text` unchanged, or throws. The boundary is inclusive. */
export function assertWithinBudget(material: BudgetName, text: string): string {
  const bytes = utf8Bytes(text);
  const cap = BYTE_BUDGETS[material];
  if (bytes > cap) throw new BudgetExceededError(material, bytes, cap);
  return text;
}
