// @tm8/jev — the TypeSafe System One wire contract.
//
// Jev is a DECISIONING model, not a coding-agent LLM. It generates no text: it
// takes one `state` and a bag of questions, and returns a typed, calibrated
// answer per question. That is the whole reason it can sit on the spawn path —
// one call answers every question in parallel against state ingested once, so
// eight judgements cost one round trip and one copy of the input tokens.
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
// harmless preference is not a reason to distrust the call. §5.1 of the design
// doc records the bug this caused when we first gated on it.
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
  distribution?: Record<string, number>;
}
export interface JevScoreAnswer {
  score: number;
  confidence: number;
  distribution?: Record<string, number>;
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
 * these two" even if neither individually looks confident — which is exactly
 * the situation a spread-but-agreeing distribution produces. Measured on 60 real
 * tm8 tasks: top-2 mass ran 0.69-0.98 where argmax confidence ran 0.28-0.49.
 */
export function topTwoMass(a: JevChoiceAnswer | JevScoreAnswer): number {
  const dist = a.distribution;
  if (!dist) return a.confidence;
  const sorted = Object.values(dist).sort((x, y) => y - x);
  return (sorted[0] ?? 0) + (sorted[1] ?? 0);
}

/**
 * The narrowest logger this package can take, shaped to accept tm8's `Logger`
 * without an adapter. `meta` is a record rather than `unknown` on purpose:
 * `unknown` is contravariantly WIDER than the host's signature, so a host that
 * types its meta properly could not satisfy it.
 */
export interface JevLogger {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
}
