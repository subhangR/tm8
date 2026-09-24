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

/**
 * The hard ceilings — a validated Interaction Profile may choose smaller,
 * never larger — plus the `<context_index>` sub-caps (`referenceIndex`,
 * `rosterIndex`, `memoryInjection`). Those are node DEFAULTS: a profile's
 * `contextBudgets` may reallocate them up or down inside
 * `combinedInitialInjection`, and the save-time fit check (§10 Q5.6) bounds it.
 */
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
  /**
   * Sub-caps INSIDE `combinedInitialInjection` for `<context_index>` groups
   * (design 01a0d348 §2.3, §10 Q3 — Subhang's numbers, tuned from the I10
   * data, not here). References (with a worker's linked teammates) and a
   * dispatcher's roster each trim to their own cap, header text first, so
   * neither can push every skill out; skills take what remains.
   */
  referenceIndex: 8192,
  rosterIndex: 8192,
  /**
   * Memories injected WHOLE, before the lowest-ranked collapse into the
   * index (§10 Q1, Q3). Critical memories never collapse: past this they
   * borrow from `combinedInitialInjection`, and a prompt that then overflows
   * is refused naming this budget. A profile's `contextBudgets.memories`
   * replaces it.
   */
  memoryInjection: 12288,
} as const;

export type BudgetName = keyof typeof BYTE_BUDGETS;

/**
 * UTF-8 byte length. `'🛠'.length` is 2 JS code units and 4 UTF-8 bytes.
 *
 * `Buffer` is preferred where it exists (it is the faster path and the one the
 * spawn/CLI callers hit), but this package is also imported by the browser
 * bundle — the prompt catalog screen renders these same prompts and reports
 * their sizes — and `Buffer` is not defined there. `TextEncoder` is the
 * standard fallback and agrees byte-for-byte.
 */
const textEncoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

export function utf8Bytes(text: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
  if (textEncoder) return textEncoder.encode(text).length;
  throw new Error('utf8Bytes: neither Buffer nor TextEncoder is available');
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

/** The per-kind budgets a profile may set (`contextBudgets`, design 01a0d348 §10 Q5). */
export interface ContextBudgetSettings {
  memories?: number | undefined;
  skills?: number | undefined;
  references?: number | undefined;
  teammates?: number | undefined;
}

/**
 * The frame a profile's context budgets must fit beside (§10 Q5.6): the
 * kernel and manifest ceilings the profile allows. The assignment snapshot
 * ceiling is NOT part of it, because an assignment too large for the prompt is
 * delivered by reference rather than crowding the budgets. PENDING Subhang's
 * call (task 01a0d3b0-339e, option a); switching baselines is this one line.
 */
export function contextBudgetBaseline(policy: { kernelMaxBytes: number; manifestMaxBytes: number }): number {
  return policy.kernelMaxBytes + policy.manifestMaxBytes;
}

/**
 * Bytes a profile's budgets promise, with each absent key at its node
 * default: memories, references (a worker's teammates share that cap unless
 * the profile gives them their own) and, when set, skills (otherwise skills
 * take what remains and promise nothing).
 */
export function promisedContextBytes(budgets: ContextBudgetSettings): number {
  return (budgets.memories ?? BYTE_BUDGETS.memoryInjection)
    + (budgets.references ?? BYTE_BUDGETS.referenceIndex)
    + (budgets.teammates ?? 0)
    + (budgets.skills ?? 0);
}

/**
 * Null when a profile's `contextBudgets` fit the prompt, else the overrun:
 * baseline + promised bytes against the profile's initial-context ceiling
 * (never above `combinedInitialInjection`). A profile that sets no budgets is
 * not checked: it promises only the node defaults.
 */
export function contextBudgetOverrun(draft: {
  promptPolicy: { kernelMaxBytes: number; manifestMaxBytes: number; initialContextMaxBytes: number };
  contextBudgets?: ContextBudgetSettings | undefined;
}): { baseline: number; promised: number; cap: number; over: number } | null {
  if (!draft.contextBudgets) return null;
  const baseline = contextBudgetBaseline(draft.promptPolicy);
  const promised = promisedContextBytes(draft.contextBudgets);
  const cap = Math.min(draft.promptPolicy.initialContextMaxBytes, BYTE_BUDGETS.combinedInitialInjection);
  const over = baseline + promised - cap;
  return over > 0 ? { baseline, promised, cap, over } : null;
}
