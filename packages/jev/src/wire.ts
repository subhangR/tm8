// @tm8/jev — the TypeSafe System One wire contract.
//
// Jev is a DECISIONING model, not a coding-agent LLM. It generates no text: it
// takes one `state` and a bag of questions, and returns a typed, calibrated
// answer per question. One call answers every question in parallel against
// state ingested once, so eight judgements cost one round trip and one copy of
// the input tokens.
//
// Three primitives, and the distinction between them is what the answer MEANS:
//
//   Noul   — probability that a condition holds. 0..1, and NO confidence field.
//            0.5 means "as likely as not", never "medium intensity".
//   Choice — one option from a defined set, plus the full distribution and a
//            confidence.
//   Score  — a position on ordered levels, returned as a probability-weighted
//            value, plus a confidence.
//
// CONFIDENCE IS NOT CORRECTNESS. For Choice and Score it summarises how
// concentrated the distribution is — nothing more. Several equally acceptable
// options spread probability and drive it down, so a low-confidence answer on a
// harmless preference is not a reason to distrust the call.
//
// Docs: https://docs.typesafe.ai/primitives.md

/** A question as sent on the wire. IDs are for our code; the model never sees them. */
export type JevQuestion =
  | {
      type: 'noul';
      instructions: string;
      /** What true and false each mean. Both sides stated; an unstated side is guessed. */
      criteria: { true: string; false: string };
    }
  | {
      type: 'choice';
      instructions: string;
      /** option key -> what selecting it asserts. */
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      /**
       * Ordered levels, lowest first. Each must describe a CONCRETE situation
       * and stand on its own — "medium" tells the model nothing.
       */
      criteria: readonly string[];
    };

export type JevQuestionSet = Record<string, JevQuestion>;

export interface JevNoulAnswer {
  noul: number;
}
export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
  /**
   * The probability mass per option. Verified against jev-1.13.0 on
   * 2026-09-22: every choice and score answer carries `probabilities`. The
   * `distribution` name the design doc used never appeared on the wire and is
   * no longer read (see `test/live-wire.test.ts`).
   */
  probabilities?: Record<string, number>;
}
export interface JevScoreAnswer {
  score: number;
  confidence: number;
  /** See {@link JevChoiceAnswer.probabilities}. */
  probabilities?: Record<string, number>;
  /** Echoed by the API: the ordered criteria, keyed by their index. */
  legend?: Record<string, string>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

/** Narrowings. The wire is JSON from a network service, so nothing is assumed. */
export function isNoul(a: JevAnswer | undefined): a is JevNoulAnswer {
  return !!a && typeof (a as JevNoulAnswer).noul === 'number';
}
export function isChoice(a: JevAnswer | undefined): a is JevChoiceAnswer {
  return !!a && typeof (a as JevChoiceAnswer).choice === 'string';
}
export function isScore(a: JevAnswer | undefined): a is JevScoreAnswer {
  return !!a && typeof (a as JevScoreAnswer).score === 'number';
}

/**
 * Probability mass held by the two most likely options.
 *
 * THIS is the safety signal for acting on a Choice, not `confidence`. When the
 * top two options between them hold most of the mass, the answer is "one of
 * these two" even if neither individually looks confident. Measured 2026-09-22
 * across 114 live answers: top-2 mass ran 0.75-1.00 (median 0.99) where argmax
 * confidence ran 0.13-1.00 (median 0.77), and on 40 of the 114 the confidence
 * sat at or below the 0.6 harness gate while the top-2 mass sat above it.
 *
 * Reads `probabilities` ONLY. An answer without it has no measurable mass and
 * reads as 0, which keeps every gate on it closed. Falling back to
 * `confidence` is the bug this replaced: 0.29 fails a 0.6 gate that the true
 * mass of 0.89 passes, so the fallback did not make the gate stricter, it made
 * it wrong.
 */
export function topTwoMass(a: JevChoiceAnswer | JevScoreAnswer): number {
  const mass = a.probabilities;
  if (!mass || typeof mass !== 'object') return 0;
  const sorted = Object.values(mass)
    .filter((p) => typeof p === 'number' && Number.isFinite(p))
    .sort((x, y) => y - x);
  return (sorted[0] ?? 0) + (sorted[1] ?? 0);
}
