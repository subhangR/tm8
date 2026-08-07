/**
 * The smallest honest GitHub client — plain `fetch` against api.github.com.
 *
 * No octokit. The observer needs two read endpoints and nothing else, and a
 * dependency that ships a plugin system, a pagination framework and a throttling
 * layer to deliver them would be a large surface bought for a small need.
 *
 * Three things this file is deliberate about:
 *
 *   * IT DISTINGUISHES "I DID NOT LEARN ANYTHING" FROM "I LEARNED IT IS GONE."
 *     Every failure mode returns a typed outcome rather than throwing or
 *     returning nulls that a caller could mistake for facts. A rate limit and a
 *     deleted PR are different answers, and writing `state = null` for both
 *     would let a 403 quietly erase a merge.
 *   * THE TOKEN IS OPTIONAL AND NEVER LOGGED. S15 keeps provider credentials
 *     out of Postgres; they arrive from the environment. Unauthenticated
 *     requests still work against public repositories at a much lower rate
 *     limit, which is the right default for a node that was never given one.
 *   * `repo` IS VALIDATED BEFORE IT REACHES A URL. It comes from a stored row
 *     that a client's link-pr call put there, so it is attacker-influenced
 *     text; `owner/name` shape-checking is what stops it from walking the API
 *     path.
 */

const GITHUB_API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type GithubOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'unauthorized' | 'rate_limited' | 'unavailable'; detail: string };

export interface PullRequestFacts {
  title: string;
  /** Mapped onto the four states `public.pull_requests` allows. */
  state: 'open' | 'merged' | 'closed' | 'draft';
  headSha: string | null;
}

export interface CommitFacts {
  message: string;
  author: string | null;
  committedAt: string | null;
  url: string | null;
}

export interface GithubClientOptions {
  token?: string | undefined;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request budget. A slow provider must not hold a scheduler slot open. */
  timeoutMs?: number;
}

export class GithubClient {
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GithubClientOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** True when this node was given a credential. Used only for reporting. */
  get authenticated(): boolean {
    return this.token !== undefined;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<GithubOutcome<T>> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub refuses requests with no User-Agent outright, and the refusal is
      // a 403 that reads exactly like a permissions problem.
      'user-agent': 'tm8-tracking-observer',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(`${GITHUB_API}${path}`, { headers, signal: composed });
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.ok) {
      try {
        return { ok: true, value: (await response.json()) as T };
      } catch (error) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: `unreadable body: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (response.status === 404) return { ok: false, reason: 'not_found', detail: '404' };
    if (response.status === 401) return { ok: false, reason: 'unauthorized', detail: '401' };
    if (response.status === 403 || response.status === 429) {
      // GitHub answers a spent rate limit with 403 and `x-ratelimit-remaining:
      // 0`, which is otherwise indistinguishable from a genuine permission
      // refusal. Telling them apart is what lets the observer back off instead
      // of marking a request permanently failed.
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 429 || remaining === '0') {
        return {
          ok: false,
          reason: 'rate_limited',
          detail: `reset at ${response.headers.get('x-ratelimit-reset') ?? 'unknown'}`,
        };
      }
      return { ok: false, reason: 'unauthorized', detail: '403' };
    }
    return { ok: false, reason: 'unavailable', detail: `http ${String(response.status)}` };
  }

  async pullRequest(
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GithubOutcome<PullRequestFacts>> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, reason: 'not_found', detail: `unroutable repo: ${repo}` };
    }
    const res = await this.get<{
      title?: string;
      state?: string;
      draft?: boolean;
      merged_at?: string | null;
      head?: { sha?: string };
    }>(`/repos/${repo}/pulls/${String(number)}`, signal);
    if (!res.ok) return res;

    const raw = res.value;
    // The four states the column allows, from three GitHub fields. Order
    // matters: a merged PR reports `state: 'closed'`, so asking about
    // `merged_at` first is the difference between recording a merge and
    // recording that someone gave up.
    const state: PullRequestFacts['state'] = raw.merged_at
      ? 'merged'
      : raw.state === 'closed'
        ? 'closed'
        : raw.draft === true
          ? 'draft'
          : 'open';
    return {
      ok: true,
      value: { title: raw.title ?? '', state, headSha: raw.head?.sha ?? null },
    };
  }

  async commit(repo: string, sha: string, signal?: AbortSignal): Promise<GithubOutcome<CommitFacts>> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, reason: 'not_found', detail: `unroutable repo: ${repo}` };
    }
    if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
      return { ok: false, reason: 'not_found', detail: `unroutable sha: ${sha}` };
    }
    const res = await this.get<{
      html_url?: string;
      commit?: { message?: string; author?: { name?: string; date?: string } };
    }>(`/repos/${repo}/commits/${sha}`, signal);
    if (!res.ok) return res;

    const raw = res.value;
    return {
      ok: true,
      value: {
        message: raw.commit?.message ?? '',
        author: raw.commit?.author?.name ?? null,
        committedAt: raw.commit?.author?.date ?? null,
        url: raw.html_url ?? null,
      },
    };
  }
}

/**
 * `TM8_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`.
 *
 * The tm8-prefixed name is checked first so an operator can point this one
 * subsystem at a narrowly-scoped read token without disturbing whatever else on
 * the box reads the conventional names.
 */
export function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.TM8_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined
  );
}
