import type { JevCallFailure } from './client.js';
import type { JevCaller, JevFailureReason } from './usage.js';
import { jevCallCostUsd } from './tiers.js';

/** Failure is a record, never a fabricated routing verdict or selection. */
export interface JevFailureActivation {
  readonly at: string;
  readonly caller: JevCaller;
  readonly outcome: 'failed';
  readonly reason: JevFailureReason;
  readonly jevModel: string | null;
  readonly latencyMs: number;
  readonly jevInputTokens: number;
  readonly jevCostUsd: number;
  readonly summary: string;
}

export interface JevActivationResult<Value, Activation> {
  readonly value: Value | null;
  /** Null means no activation was attempted (off, empty task or candidate pool). */
  readonly activation: Activation | JevFailureActivation | null;
}

export function failureActivation(
  caller: JevCaller, failure: JevCallFailure, at = new Date().toISOString(),
): JevFailureActivation {
  return {
    at, caller, outcome: 'failed', reason: failure.reason,
    jevModel: failure.jevModel, latencyMs: failure.latencyMs,
    jevInputTokens: failure.inputTokens, jevCostUsd: jevCallCostUsd(failure.inputTokens),
    summary: `Jev unavailable: ${failure.reason}; keeping static resolution.`,
  };
}
