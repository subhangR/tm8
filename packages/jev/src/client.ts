// @tm8/jev — the HTTP client.
//
// ONE RULE GOVERNS THIS FILE: a routing service that is down must never stop a
// spawn. Jev is a third-party network dependency with documented 429 and 529
// responses, and tm8's spawn path is how work happens at all. So every failure
// here — timeout, rate limit, bad key, malformed body, unparseable answer —
// resolves to `null`, and `null` means "no opinion": the caller falls through
// to the precedence chain tm8 has always had.
//
// There is deliberately no error thrown out of `ask()`. A caller cannot forget
// to catch what is never raised.

import type { JevQuestionSet, JevResponse, JevLogger } from './primitives.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** `jev-latest` resolves server-side; the response echoes the concrete version. */
export const JEV_DEFAULT_MODEL = 'jev-latest';

/**
 * 1.5s, one retry.
 *
 * MEASURED, not guessed. 2026-09-22, jev-1.13.0, 114 live calls over two passes
 * of 57 real tm8 tasks pulled from the graph: median 341ms, p90 412ms, max
 * 1629ms, zero failures. The budget is a backstop for a wedged connection, not
 * a target: a spawn already spends seconds on worktree provisioning, PTY boot
 * and credential injection, so 341ms is noise — but 30s of a hung socket is
 * not. The max is the one that matters for the 1.5s choice; it sat inside it.
 */
export const JEV_DEFAULT_TIMEOUT_MS = 1_500;

export interface JevClientOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  /** Attempts after the first. Default 1. */
  retries?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: JevLogger;
  /** Injected for tests so latency assertions are not wall-clock dependent. */
  now?: () => number;
}

export interface JevCallResult {
  response: JevResponse;
  /** Round-trip latency, milliseconds. Recorded on the verdict for observability. */
  latencyMs: number;
}

export class JevClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: JevClientOptions['logger'];
  private readonly now: () => number;

  constructor(options: JevClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? JEV_ENDPOINT;
    this.model = options.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? 1;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Ask every question against one state. Returns `null` on ANY failure.
   *
   * State is ingested once and all questions are evaluated in parallel, so
   * asking eight questions costs one copy of the input tokens rather than
   * eight. That is why the question set below is generous rather than minimal.
   */
  async ask(state: unknown, questions: JevQuestionSet): Promise<JevCallResult | null> {
    const body = JSON.stringify({ state, model: this.model, questions });
    const started = this.now();

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          // 429/529 are the documented retryable pair; everything else is a
          // request we should not repeat (bad key, bad question shape).
          const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
          this.logger?.warn?.('jev: non-ok response', { status: res.status, attempt, retryable });
          if (!retryable) return null;
          continue;
        }
        const parsed = (await res.json()) as JevResponse;
        if (!parsed || typeof parsed !== 'object' || !parsed.answers) {
          this.logger?.warn?.('jev: response carried no answers', { attempt });
          return null;
        }
        return { response: parsed, latencyMs: Math.max(0, this.now() - started) };
      } catch (err) {
        // AbortError (our timeout) and any transport failure land here alike.
        this.logger?.warn?.('jev: call failed', {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}

/**
 * Read the key from the environment.
 *
 * Server-side only, by the vendor's own instruction: "Keep API credentials
 * server-side in web apps." Nothing in this package ever puts the key on a
 * manifest, a prompt, a message or an artifact — see `redactSecretsDeep` in
 * execution for the same rule at the manifest seam.
 */
export function jevKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim();
  return key ? key : null;
}
