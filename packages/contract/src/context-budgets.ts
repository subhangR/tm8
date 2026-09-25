/**
 * Per-kind context budgets and score floors on an interaction profile
 * (integrated design 01a0d348 §10 Q5). Each kind's budget is the bytes its
 * entries may take in the prompt: a memory's full `<entry>`, a collapsed
 * entry's `<context_index>` line. Node defaults live in `BYTE_BUDGETS`
 * (`memoryInjection`, `referenceIndex`, `rosterIndex`); skills default to what
 * remains. Floors are Jev score floors (0–3) for the budget fill (I7); spawn
 * has no scores to apply them to (Q5.5).
 */
export interface ContextBudgets {
  memories?: number; // contextBudgets.memories
  skills?: number; // contextBudgets.skills
  references?: number; // contextBudgets.references
  teammates?: number; // contextBudgets.teammates
}

export interface ContextFloors {
  memories?: number; // contextFloors.memories
  skills?: number; // contextFloors.skills
  references?: number; // contextFloors.references
  teammates?: number; // contextFloors.teammates
}

/**
 * The node's score floors, used where a profile sets none (design 01a0d348
 * §10 Q5, msgs 01a0d377-75e7 / 01a0d377-bd37). Memories and skills and
 * references: useful (1.5) — a memory is read whole, and a collapsed header
 * costs little, so a profile may lower skills and references to 1.0.
 * Teammates: 1.0, a fit.
 */
export const CONTEXT_FLOOR_DEFAULTS: Readonly<Required<ContextFloors>> = Object.freeze({
  memories: 1.5,
  skills: 1.5,
  references: 1.5,
  teammates: 1.0,
});
