// @tm8/jev — the HTTP client.
//
// ONE CALL, BOUNDED, NEVER THROWS. `ask()` resolves to either an answer or a
// named failure, and both carry exactly one `JevCallRecord`: what the call
// cost, how long it took, which concrete Jev version answered, and how it
// ended. A caller cannot forget to catch what is never raised, and cannot lose
// the cost of a call that failed — the record is on both branches.
//
// THE BOUNDS (design 01a0cb80 §8). 5000 ms total, which covers serialisation,
// every attempt, the wait between them and parsing the body; 2000 ms per
// attempt; one retry. Only a transient failure is retried — 429, 529, any 5xx,
// an attempt timeout or a network error. A 4xx, a missing key and a malformed
// answer stop at once: repeating them would pay twice for the same refusal.
//
// NOTHING IS WRITTEN HERE. No logging, no usage file, no request or response
// body kept anywhere. The record is returned; persisting it is the server's job.
//
// The deadline and retry logic is PR #644's (`stack/jev-client-budget-and-usage`,
// 9db40270 + 344ce90b + 80551ee4), kept as written and moved onto this result
// shape.

import type { JevFailure } from '@tm8/contract';

import { costOf } from './cost.js';
import type { JevQuestionSet, JevResponse } from './wire.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** `jev-latest` resolves server-side; the response echoes the concrete version. */
export const JEV_DEFAULT_MODEL = 'jev-latest';
/** The whole call, retries and body parsing included. */
export const JEV_DEFAULT_TOTAL_BUDGET_MS = 5_000;
/**
 * One attempt. Measured 2026-09-22 (jev-1.13.0, 114 live calls): median 341 ms,
 * p90 412 ms, max 1629 ms. 2 s clears the observed maximum; the old 1.5 s did
 * not.
 */
export const JEV_DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;
export const JEV_DEFAULT_RETRIES = 1;

/** One logical Jev call — every attempt it took — as the server persists it. */
export interface JevCallRecord {
  /** The concrete version that answered. Never an alias such as `jev-latest`; null when unknown. */
  jevModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall time of the whole call, all attempts included. */
  latencyMs: number;
  outcome: 'ok' | JevFailure;
}

export type JevAskResult =
  | { ok: true; response: JevResponse; call: JevCallRecord }
  | { ok: false; reason: JevFailure; call: JevCallRecord };

export interface JevClient {
  ask(state: unknown, questions: JevQuestionSet): Promise<JevAskResult>;
}

export interface JevClientOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  totalBudgetMs?: number;
  attemptTimeoutMs?: number;
  /** Attempts after the first. */
  retries?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Millisecond clock for latency and the deadline. */
  now?: () => number;
}

/** The failures worth one more attempt. Everything else would fail the same way again. */
const RETRYABLE: ReadonlySet<JevFailure> = new Set<JevFailure>([
  'rate_limited',
  'overloaded',
  'server_error',
  'timeout',
  'network',
]);

export function failureForStatus(status: number): JevFailure {
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

export function isRetryable(reason: JevFailure): boolean {
  return RETRYABLE.has(reason);
}

type Attempt = { response: JevResponse } | { reason: JevFailure };

export function createJevClient(options: JevClientOptions): JevClient {
  const apiKey = options.apiKey ?? '';
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const model = options.model ?? JEV_DEFAULT_MODEL;
  const totalBudgetMs = duration(options.totalBudgetMs, JEV_DEFAULT_TOTAL_BUDGET_MS);
  const attemptTimeoutMs = duration(options.attemptTimeoutMs, JEV_DEFAULT_ATTEMPT_TIMEOUT_MS);
  const retries =
    options.retries !== undefined && Number.isFinite(options.retries)
      ? Math.max(0, Math.floor(options.retries))
      : JEV_DEFAULT_RETRIES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  async function ask(state: unknown, questions: JevQuestionSet): Promise<JevAskResult> {
    const started = now();
    const deadline = started + totalBudgetMs;
    let jevModel: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    const record = (outcome: JevCallRecord['outcome']): JevCallRecord => ({
      jevModel,
      inputTokens,
      outputTokens,
      costUsd: costOf({ inputTokens }),
      latencyMs: Math.max(0, now() - started),
      outcome,
    });
    const fail = (reason: JevFailure): JevAskResult => ({ ok: false, reason, call: record(reason) });

    const attempt = async (body: string, limitMs: number, onTimeout: JevFailure): Promise<Attempt> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<Attempt>((resolve) => {
        timer = setTimeout(() => {
          // Resolve the race before abort listeners can reject fetch.
          resolve({ reason: onTimeout });
          controller.abort();
        }, limitMs);
      });
      const request = async (): Promise<Attempt> => {
        let res: Response;
        try {
          res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body,
            signal: controller.signal,
          });
        } catch {
          return { reason: 'network' };
        }
        if (!res.ok) {
          // Release the error body without waiting on a stream that may stall.
          void res.body?.cancel().catch(() => {});
          return { reason: failureForStatus(res.status) };
        }
        let parsed: JevResponse;
        try {
          parsed = (await res.json()) as JevResponse;
        } catch {
          return { reason: 'unparsed' };
        }
        // A body that lands after the attempt timed out must not touch this call's record.
        if (controller.signal.aborted) return { reason: onTimeout };
        if (!parsed || typeof parsed !== 'object') return { reason: 'unparsed' };
        // Usage is billed whether or not the answers parse, so it is counted first.
        jevModel = concreteJevModel(parsed.model);
        const inTok = count(parsed.usage?.input_tokens);
        const outTok = count(parsed.usage?.output_tokens);
        inputTokens += inTok;
        outputTokens += outTok;
        try {
          if (!validAnswers(parsed, questions)) return { reason: 'unparsed' };
        } catch {
          return { reason: 'unparsed' };
        }
        return { response: { ...parsed, usage: { input_tokens: inTok, output_tokens: outTok } } };
      };
      try {
        return await Promise.race([timedOut, request()]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      if (!apiKey.trim()) return fail('no_key');
      if (totalBudgetMs <= 0) return fail('budget');
      const body = JSON.stringify({ state, model, questions });

      let last: JevFailure = 'budget';
      for (let n = 0; n <= retries; n += 1) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          last = 'budget';
          break;
        }
        // When the total budget, not the attempt timeout, is what cuts this
        // attempt short, the failure is `budget`, and it is not retried.
        const budgetBound = remaining <= attemptTimeoutMs;
        const outcome = await attempt(body, Math.min(remaining, attemptTimeoutMs), budgetBound ? 'budget' : 'timeout');
        // Also catches synchronous parsing or validation that overran the clock.
        if (now() >= deadline) {
          last = 'budget';
          break;
        }
        if ('response' in outcome) return { ok: true, response: outcome.response, call: record('ok') };
        last = outcome.reason;
        if (!isRetryable(last)) break;
      }
      return fail(last);
    } catch {
      // Non-serialisable state, or anything else unforeseen. Never thrown out.
      return fail(now() >= deadline ? 'budget' : 'unparsed');
    }
  }

  return { ask };
}

/**
 * A client from the environment, or null when there is no key.
 *
 * Reads `TYPESAFE_API_KEY` and nothing else — no policy switch, no fallback
 * key name. The key stays server-side; nothing here puts it anywhere but the
 * Authorization header.
 */
export function jevClientFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<JevClientOptions, 'apiKey'> = {},
): JevClient | null {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  return apiKey ? createJevClient({ ...options, apiKey }) : null;
}

/** A version is positive evidence; a floating alias identifies nothing. */
export function concreteJevModel(model: unknown): string | null {
  if (typeof model !== 'string' || !model.trim()) return null;
  const value = model.trim();
  if (
    /^(?:unknown|unavailable|null|default|latest|auto|jev)$/i.test(value) ||
    /(?:^|[-_:])(?:latest|default|auto)$/i.test(value)
  ) {
    return null;
  }
  return value;
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Every question answered, each in the shape its type promises. */
function validAnswers(response: JevResponse, questions: JevQuestionSet): boolean {
  const answers = response.answers as unknown;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  return Object.entries(questions).every(([id, question]) => {
    const answer = (answers as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    if (!answer || typeof answer !== 'object') return false;
    if (question.type === 'noul') {
      return typeof answer.noul === 'number' && answer.noul >= 0 && answer.noul <= 1;
    }
    const confidence = answer.confidence;
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return false;
    if (question.type === 'score') {
      return typeof answer.score === 'number' && answer.score >= 0 && answer.score <= question.criteria.length - 1;
    }
    return typeof answer.choice === 'string' && Object.hasOwn(question.criteria, answer.choice);
  });
}
