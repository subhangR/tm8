// Jev is fail-open: existing ask() callers still get null on failure. The detailed
// method carries a reason for activations and writes one usage row per logical ask.
import type { JevQuestionSet, JevResponse, JevLogger } from './primitives.js';
import { jevCallCostUsd } from './tiers.js';
import {
  concreteJevModel, fileUsageSink, jevUsagePath,
  type JevFailureReason, type JevUsageContext, type JevUsageSink,
} from './usage.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
/** 1629ms measured maximum exceeded the old 1500ms limit; it did not justify it. */
export const JEV_DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;
export const JEV_DEFAULT_BUDGET_MS = 5_000;
/** @deprecated Use JEV_DEFAULT_ATTEMPT_TIMEOUT_MS. */
export const JEV_DEFAULT_TIMEOUT_MS = JEV_DEFAULT_ATTEMPT_TIMEOUT_MS;

export interface JevAskOptions {
  budgetMs?: number;
  attemptTimeoutMs?: number;
  /** Attempts after the first. Default 1. */
  retries?: number;
  usage?: JevUsageContext;
  /** Advisor-specific parsing participates in the deadline and ledger outcome. */
  validateResponse?: (response: JevResponse) => boolean;
}
export interface JevClientOptions extends JevAskOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  /** @deprecated Alias for attemptTimeoutMs. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: JevLogger;
  /** Millisecond clock for elapsed time and the usage timestamp. */
  now?: () => number;
  usageSink?: JevUsageSink;
  dataDir?: string;
}
export interface JevCallResult {
  response: JevResponse;
  latencyMs: number;
  jevModel: string | null;
}
export interface JevCallFailure {
  ok: false;
  reason: JevFailureReason;
  latencyMs: number;
  jevModel: string | null;
  inputTokens: number;
}
export type JevDetailedCallResult = (JevCallResult & { ok: true }) | JevCallFailure;

type AttemptResult = { response: JevResponse } | { reason: JevFailureReason; retryable: boolean };

export class JevClient {
  private readonly options: JevClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly usageSink: JevUsageSink;
  private readonly writes = new Set<Promise<void>>();

  constructor(options: JevClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.usageSink = options.usageSink ?? fileUsageSink(jevUsagePath(options.dataDir));
  }

  async ask(state: unknown, questions: JevQuestionSet, options: JevAskOptions = {}): Promise<JevCallResult | null> {
    const result = await this.askDetailed(state, questions, options);
    return result.ok ? { response: result.response, latencyMs: result.latencyMs, jevModel: result.jevModel } : null;
  }

  /** Hard total deadline includes serialization, all retries, fetch and body parsing. */
  async askDetailed(state: unknown, questions: JevQuestionSet, options: JevAskOptions = {}): Promise<JevDetailedCallResult> {
    const started = this.now();
    const config = { ...this.options, ...options };
    const budget = duration(config.budgetMs, JEV_DEFAULT_BUDGET_MS);
    const attemptTimeout = duration(config.attemptTimeoutMs ?? this.options.timeoutMs, JEV_DEFAULT_ATTEMPT_TIMEOUT_MS);
    const retries = Number.isFinite(config.retries) ? Math.max(0, Math.floor(config.retries!)) : 1;
    const deadline = started + budget;
    let model: string | null = null;
    let inputTokens = 0;
    const fail = (reason: JevFailureReason): JevCallFailure => ({
      ok: false, reason, latencyMs: Math.max(0, this.now() - started), jevModel: model, inputTokens,
    });
    let result: JevDetailedCallResult = fail('network');
    try {
      if (!config.apiKey.trim()) result = fail('no_key');
      else if (budget === 0) result = fail('budget');
      else {
        const body = JSON.stringify({ state, model: config.model ?? JEV_DEFAULT_MODEL, questions });
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          const attemptStarted = this.now();
          const remaining = deadline - attemptStarted;
          if (remaining <= 0) { result = fail('budget'); break; }
          const controller = new AbortController();
          const timeoutReason = remaining <= attemptTimeout ? 'budget' : 'timeout';
          let timer: ReturnType<typeof setTimeout> | undefined;
          // Give an already-resolved HTTP response a microtask-sized grace
          // window when the remaining logical budget is shorter than the
          // per-attempt bound. This keeps a fast definitive/retryable response
          // observable before the hard budget closes the attempt; a stalled
          // body still resolves on the same bounded timer below.
          const timerDelay = remaining <= attemptTimeout ? remaining + 10 : attemptTimeout;
          const timedOut = new Promise<AttemptResult>((resolve) => {
            timer = setTimeout(() => {
              // Resolve the race before abort listeners can reject fetch.
              resolve({ reason: timeoutReason, retryable: timeoutReason !== 'budget' });
              controller.abort();
            }, timerDelay);
          });
          const request = async (): Promise<AttemptResult> => {
            let response: Response;
            try {
              response = await this.fetchImpl(config.endpoint ?? JEV_ENDPOINT, {
                method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
                body, signal: controller.signal,
              });
            } catch { return { reason: 'network', retryable: true }; }
            if (!response.ok) {
              const status = response.status;
              const reason = status === 429 ? '429' : status === 529 ? '529' : status >= 500 ? '5xx' : 'http_error';
              // Release error bodies without waiting for a potentially stalled stream.
              void response.body?.cancel().catch(() => {});
              return { reason, retryable: reason !== 'http_error' };
            }
            let parsed: JevResponse;
            try { parsed = await response.json() as JevResponse; }
            catch { return { reason: 'unparsed', retryable: false }; }
            // A timed-out body may finish later; it must not affect this call's row.
            if (controller.signal.aborted) return { reason: timeoutReason, retryable: false };
            model = concreteJevModel(parsed?.model);
            const tokens = parsed?.usage?.input_tokens;
            const measuredTokens = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
            inputTokens += measuredTokens;
            try {
              if (!parsed || typeof parsed !== 'object' || !parsed.answers || typeof parsed.answers !== 'object'
                || Array.isArray(parsed.answers) || !validAnswers(parsed, questions)
                || (config.validateResponse && !config.validateResponse(parsed))) {
                return { reason: 'unparsed', retryable: false };
              }
            } catch { return { reason: 'unparsed', retryable: false }; }
            return { response: {
              ...parsed, usage: { input_tokens: measuredTokens, output_tokens: Number.isFinite(parsed.usage?.output_tokens) ? Math.max(0, parsed.usage.output_tokens) : 0 },
            } };
          };
          let outcome: AttemptResult;
          try { outcome = await Promise.race([timedOut, request()]); }
          finally { clearTimeout(timer); }
          // Also catches synchronous parsing/validation that overran the clock.
          if (this.now() >= deadline) { controller.abort(); result = fail('budget'); break; }
          if (this.now() - attemptStarted >= attemptTimeout) outcome = { reason: 'timeout', retryable: true };
          if ('response' in outcome) {
            result = { ok: true, response: outcome.response, jevModel: model, latencyMs: Math.max(0, this.now() - started) };
            break;
          }
          result = fail(outcome.reason);
          if (!outcome.retryable) break;
        }
      }
    } catch {
      // Includes non-serializable caller input. No request content is logged.
      result = fail(this.now() >= deadline ? 'budget' : 'unparsed');
    }
    const usage = {
      caller: options.usage?.caller ?? this.options.usage?.caller,
      spaceId: options.usage?.spaceId === undefined ? this.options.usage?.spaceId : options.usage.spaceId,
      subjectId: options.usage?.subjectId === undefined ? this.options.usage?.subjectId : options.usage.subjectId,
    };
    this.record({
      at: new Date(started).toISOString(), caller: usage.caller ?? 'advise',
      spaceId: usage.spaceId ?? null, subjectId: usage.subjectId ?? null,
      jevModel: model, inputTokens, costUsd: jevCallCostUsd(inputTokens),
      latencyMs: result.latencyMs, outcome: result.ok ? 'ok' : result.reason,
    });
    return result;
  }

  /** Optional drain for tests/shutdown. Launch never waits on disk or a remote sink. */
  async flushUsage(): Promise<void> { await Promise.all([...this.writes]); }

  private record(entry: Parameters<JevUsageSink>[0]): void {
    try {
      const write = Promise.resolve(this.usageSink(entry)).catch(() => {}).finally(() => this.writes.delete(write));
      this.writes.add(write);
    } catch { /* A broken usage sink must not prevent launch. */ }
  }
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function validAnswers(response: JevResponse, questions: JevQuestionSet): boolean {
  return Object.entries(questions).every(([id, question]) => {
    const answer = response.answers[id];
    if (!answer || typeof answer !== 'object') return false;
    if (question.type === 'noul') return 'noul' in answer && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
    if (!('confidence' in answer) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return false;
    if (question.type === 'score') return 'score' in answer && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1;
    return 'choice' in answer && Object.hasOwn(question.criteria, answer.choice);
  });
}

/** Read only; key values never enter activations, logs or the ledger. */
export function jevKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim();
  return key ? key : null;
}
