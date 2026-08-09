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

/**
 * `notModified` is a THIRD answer, and it is not a failure.
 *
 * A watcher polls. Without conditional requests it re-downloads every pull
 * request it is watching on every tick and spends its whole hourly budget
 * learning nothing; a 304 costs zero against the rate limit, which is the only
 * reason the interval can be short enough for a closed loop to feel closed.
 *
 * Modelled as `ok: true, value: null` rather than a failure reason because the
 * distinction the whole file is built on — "I did not learn anything" vs "I
 * learned it is gone" — puts a 304 firmly in a third category: I learned that
 * NOTHING CHANGED, which is a fact, and the strongest possible instruction to
 * leave the stored row exactly as it is.
 */
export type GithubOutcome<T> =
  | { ok: true; value: T; etag: string | null; notModified?: false }
  | { ok: true; value: null; etag: string | null; notModified: true }
  | { ok: false; reason: 'not_found' | 'unauthorized' | 'rate_limited' | 'unavailable'; detail: string };

export interface PullRequestFacts {
  title: string;
  /** Mapped onto the four states `public.pull_requests` allows. */
  state: 'open' | 'merged' | 'closed' | 'draft';
  headSha: string | null;
  /** 084 §A: the branch, which is also how the owning session is resolved. */
  headRef: string | null;
  /** 084 §G: a base that is another open PR's head means STACKED. */
  baseRef: string | null;
  /** GitHub's own word. `dirty` is the conflict; `unknown` is "still computing". */
  mergeableState: MergeableState | null;
}

export type MergeableState =
  | 'clean' | 'dirty' | 'unknown' | 'blocked' | 'behind' | 'unstable' | 'draft' | 'has_hooks';

const MERGEABLE_STATES: readonly string[] = [
  'clean', 'dirty', 'unknown', 'blocked', 'behind', 'unstable', 'draft', 'has_hooks',
];

export interface CheckRunFacts {
  name: string;
  status: string;
  conclusion: string | null;
  /**
   * The check-run id. For GitHub Actions it is ALSO the job id, which is what
   * makes the log tail reachable without scraping `details_url`.
   */
  externalId: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ReviewThreadComment {
  id: string;
  author: string | null;
  body: string;
}

export interface ReviewThreadFacts {
  threadKey: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReviewThreadComment[];
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

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub refuses requests with no User-Agent outright, and the refusal is
      // a 403 that reads exactly like a permissions problem.
      'user-agent': 'tm8-tracking-observer',
      ...extra,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async send(
    path: string,
    init: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      redirect?: RequestRedirect;
    },
    signal?: AbortSignal,
  ): Promise<{ ok: true; response: Response } | { ok: false; reason: 'unavailable'; detail: string }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`${GITHUB_API}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(init.headers),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
        signal: composed,
      });
      return { ok: true, response };
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async get<T>(
    path: string,
    signal?: AbortSignal,
    etag?: string | null,
  ): Promise<GithubOutcome<T>> {
    // `if-none-match` only when we actually hold a validator. Sending an empty
    // one is not a no-op — GitHub answers 200 and the byte saving is lost
    // silently, which is the hardest kind of cache bug to notice.
    const sent = await this.send(
      path,
      { headers: etag ? { 'if-none-match': etag } : {} },
      signal,
    );
    if (!sent.ok) return sent;
    const response = sent.response;

    if (response.status === 304) {
      return { ok: true, value: null, notModified: true, etag: etag ?? null };
    }
    if (response.ok) {
      try {
        return {
          ok: true,
          value: (await response.json()) as T,
          etag: response.headers.get('etag'),
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: `unreadable body: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return (
      classifyFailure(response) ?? {
        ok: false,
        reason: 'unavailable',
        detail: `http ${String(response.status)}`,
      }
    );
  }

  async pullRequest(
    repo: string,
    number: number,
    signal?: AbortSignal,
    etag?: string | null,
  ): Promise<GithubOutcome<PullRequestFacts>> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, reason: 'not_found', detail: `unroutable repo: ${repo}` };
    }
    const res = await this.get<{
      title?: string;
      state?: string;
      draft?: boolean;
      merged_at?: string | null;
      mergeable_state?: string;
      head?: { sha?: string; ref?: string };
      base?: { ref?: string };
    }>(`/repos/${repo}/pulls/${String(number)}`, signal, etag);
    if (!res.ok || res.notModified === true) return res;

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
    // An unrecognised mergeable_state becomes `unknown`, never `dirty`. GitHub
    // has added words to this vocabulary before, and guessing that an
    // unfamiliar one means "conflicted" would nudge an agent about a conflict
    // that does not exist.
    const mergeableState =
      typeof raw.mergeable_state === 'string' && MERGEABLE_STATES.includes(raw.mergeable_state)
        ? (raw.mergeable_state as MergeableState)
        : raw.mergeable_state === undefined
          ? null
          : 'unknown';
    return {
      ok: true,
      etag: res.etag,
      value: {
        title: raw.title ?? '',
        state,
        headSha: raw.head?.sha ?? null,
        headRef: raw.head?.ref ?? null,
        baseRef: raw.base?.ref ?? null,
        mergeableState,
      },
    };
  }

  /**
   * Check runs for a commit — the CI fact, at the granularity a nudge needs.
   *
   * Per-COMMIT and not per-PR because that is the axis the answer is true on: a
   * check is red on a sha, and the push that fixes it produces a new sha with
   * its own answer. `/commits/{sha}/check-runs` is also the only endpoint whose
   * ETag is stable enough to be worth sending — the combined status endpoint
   * changes on every unrelated re-run.
   *
   * One page. A PR with more than a hundred check runs has a CI problem this
   * loop is not going to solve, and paginating would let one pathological repo
   * spend the whole tick's budget.
   */
  async checkRuns(
    repo: string,
    sha: string,
    signal?: AbortSignal,
    etag?: string | null,
  ): Promise<GithubOutcome<CheckRunFacts[]>> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, reason: 'not_found', detail: `unroutable repo: ${repo}` };
    }
    if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
      return { ok: false, reason: 'not_found', detail: `unroutable sha: ${sha}` };
    }
    const res = await this.get<{
      check_runs?: {
        id?: number;
        name?: string;
        status?: string;
        conclusion?: string | null;
        details_url?: string | null;
        started_at?: string | null;
        completed_at?: string | null;
      }[];
    }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, signal, etag);
    if (!res.ok || res.notModified === true) return res;

    const runs: CheckRunFacts[] = [];
    for (const run of res.value.check_runs ?? []) {
      const name = typeof run.name === 'string' ? run.name.trim() : '';
      if (name === '') continue;
      runs.push({
        name,
        status: typeof run.status === 'string' ? run.status : 'completed',
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
        externalId: typeof run.id === 'number' ? String(run.id) : null,
        detailsUrl: run.details_url ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
      });
    }
    return { ok: true, value: runs, etag: res.etag };
  }

  /**
   * Review threads, over GraphQL, and NO ETag — deliberately.
   *
   * REST has no endpoint that reports whether a review conversation is
   * RESOLVED. `/pulls/{n}/comments` returns the comments and nothing about the
   * thread they belong to, so a loop built on it would re-nudge about
   * conversations the reviewer closed an hour ago — the precise failure that
   * makes an agent stop reading its inbox. GraphQL's `reviewThreads.isResolved`
   * is the only source of that fact.
   *
   * GraphQL is a POST and its responses carry no usable validator, so this one
   * call is unconditional. That is a real cost (one point of the GraphQL budget
   * per PR per tick) accepted for the one fact REST cannot supply; the PR and
   * check-run reads, which are the bulk of the traffic, stay conditional.
   *
   * It also REQUIRES a token — GitHub's GraphQL API refuses anonymous requests
   * outright — so an unauthenticated node gets `unauthorized` here and simply
   * runs the other two loops.
   *
   * ⚠ BOUNDED AT 50 THREADS AND 10 COMMENTS PER THREAD, WITH NO PAGINATION.
   * A pull request past those bounds is silently truncated, and the review
   * signature (comment count + ids) is computed over the truncated view — so a
   * 51st thread is never announced, and a reply past the 10th does not re-arm
   * the nudge. Accepted for v1: a PR with fifty open conversations has a
   * problem this loop is not going to solve, and paginating would let one
   * pathological PR spend the tick's whole GraphQL budget. Named here rather
   * than discovered later.
   */
  async reviewThreads(
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GithubOutcome<ReviewThreadFacts[]>> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, reason: 'not_found', detail: `unroutable repo: ${repo}` };
    }
    if (!this.token) {
      return { ok: false, reason: 'unauthorized', detail: 'graphql requires a token' };
    }
    const [owner, name] = repo.split('/');
    const sent = await this.send(
      '/graphql',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Variables, never interpolation. `owner`/`name` come from a stored row
        // a client's link-pr call put there.
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: { owner, name, number },
        }),
      },
      signal,
    );
    if (!sent.ok) return sent;
    const failure = classifyFailure(sent.response);
    if (failure) return failure;

    let body: GraphqlReviewThreadsResponse;
    try {
      body = (await sent.response.json()) as GraphqlReviewThreadsResponse;
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `unreadable body: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // GraphQL answers 200 with an `errors` array. Treating that as success
    // would record "zero unresolved threads" for a query that never ran, and a
    // silently-empty diff reads exactly like "the reviewer is happy".
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const detail = body.errors.map((e) => e.message ?? 'error').join('; ').slice(0, 300);
      return { ok: false, reason: 'unavailable', detail: `graphql: ${detail}` };
    }
    const nodes = body.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(nodes)) {
      return { ok: false, reason: 'not_found', detail: 'no review threads in graphql response' };
    }

    const threads: ReviewThreadFacts[] = [];
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string') continue;
      threads.push({
        threadKey: node.id,
        path: typeof node.path === 'string' ? node.path : null,
        line: typeof node.line === 'number' ? node.line : null,
        isResolved: node.isResolved === true,
        isOutdated: node.isOutdated === true,
        comments: (node.comments?.nodes ?? [])
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
          .map((c) => ({
            id: typeof c.id === 'string' ? c.id : '',
            author: c.author?.login ?? null,
            body: typeof c.body === 'string' ? c.body : '',
          })),
      });
    }
    return { ok: true, value: threads, etag: null };
  }

  /**
   * The last `lines` lines of a GitHub Actions job's log.
   *
   * READ AS A BOUNDED TAIL, not `await response.text()`. A failing build can
   * emit hundreds of megabytes, and buffering all of it to keep the last
   * hundred lines would let one verbose job take the server's heap with it.
   * The reader below keeps a rolling window of the trailing bytes and discards
   * everything before it as it streams.
   *
   * ⚠ THE REDIRECT IS FOLLOWED BY HAND, AND THAT IS A SECURITY REQUIREMENT.
   *
   * This endpoint answers 302 to a signed blob on objects.githubusercontent.com.
   * Letting `fetch` auto-follow it means the request to that host is built by
   * undici, and whether undici strips the `authorization` header on a
   * cross-origin redirect is version-dependent. If it does not, this call posts
   * the node's GitHub token to a third-party host on every CI failure — the
   * worst possible place for a credential to leak, because nothing in the logs
   * would ever show it. `redirect: 'manual'` plus an explicit unauthenticated
   * follow makes the answer OURS instead of undici's, and costs nothing: the
   * signed URL carries its own authorization in the query string and REFUSES a
   * request that also presents a bearer token.
   */
  async jobLogTail(
    repo: string,
    jobId: string,
    lines = 100,
    signal?: AbortSignal,
  ): Promise<GithubOutcome<string>> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, reason: 'not_found', detail: `unroutable repo: ${repo}` };
    }
    if (!/^[0-9]{1,20}$/.test(jobId)) {
      return { ok: false, reason: 'not_found', detail: `unroutable job id: ${jobId}` };
    }
    const sent = await this.send(
      `/repos/${repo}/actions/jobs/${jobId}/logs`,
      { headers: { accept: 'application/vnd.github.raw+json' }, redirect: 'manual' },
      signal,
    );
    if (!sent.ok) return sent;

    let response = sent.response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) {
        return { ok: false, reason: 'unavailable', detail: 'log redirect carried no location' };
      }
      const followed = await this.fetchUnauthenticated(location, signal);
      if (!followed.ok) return followed;
      response = followed.response;
    }

    const failure = classifyFailure(response);
    if (failure) return failure;

    try {
      const tail = await readTrailingBytes(response, LOG_TAIL_BYTES);
      return { ok: true, value: lastLines(tail.text, lines, tail.truncated), etag: null };
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `unreadable log: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Follow an absolute URL with NO credential of ours attached.
   *
   * `https:` only, and the scheme check is load-bearing rather than defensive
   * tidiness: the location comes from a response header, so honouring `file:`
   * or a redirect back to a host that would see our headers is exactly the hole
   * the manual follow exists to close.
   */
  private async fetchUnauthenticated(
    location: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; response: Response } | { ok: false; reason: 'unavailable'; detail: string }> {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      return { ok: false, reason: 'unavailable', detail: 'log redirect location is not a url' };
    }
    if (url.protocol !== 'https:') {
      return { ok: false, reason: 'unavailable', detail: `refusing ${url.protocol} log redirect` };
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { 'user-agent': 'tm8-tracking-observer' },
        signal: composed,
      });
      return { ok: true, response };
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
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
    if (!res.ok || res.notModified === true) return res;

    const raw = res.value;
    return {
      ok: true,
      etag: res.etag,
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
 * The failure classification, shared by the JSON reads, the GraphQL POST and
 * the log fetch — because a 403 means the same three things whichever door it
 * arrives at, and three copies of this reasoning would drift.
 *
 * Returns `null` for a response that is not a failure, so the caller keeps
 * ownership of the success path.
 */
function classifyFailure<T>(response: Response): Extract<GithubOutcome<T>, { ok: false }> | null {
  if (response.ok || response.status === 304) return null;
  if (response.status === 404) return { ok: false, reason: 'not_found', detail: '404' };
  if (response.status === 401) return { ok: false, reason: 'unauthorized', detail: '401' };
  if (response.status === 403 || response.status === 429) {
    // Three different things arrive as 403, and telling them apart is the
    // difference between backing off and recording a permanent verdict on a
    // transient throttle.
    //
    //   * PRIMARY rate limit — 403 with `x-ratelimit-remaining: 0`.
    //   * SECONDARY rate limit (abuse detection) — 403 with `retry-after` and
    //     a NON-ZERO `x-ratelimit-remaining`. Checking `remaining === '0'`
    //     alone files this as `unauthorized`, which the observer then records
    //     as a terminal failure for a limit that clears in seconds.
    //   * A genuine permission refusal — neither header.
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 || remaining === '0' || retryAfter !== null) {
      return {
        ok: false,
        reason: 'rate_limited',
        detail: retryAfter !== null
          ? `retry after ${retryAfter}s`
          : `reset at ${response.headers.get('x-ratelimit-reset') ?? 'unknown'}`,
      };
    }
    return { ok: false, reason: 'unauthorized', detail: '403' };
  }
  // Everything else, 5xx included: `unavailable` means "I did not learn
  // anything", which keeps it retryable. A `not_found` here would be a lie
  // about a pull request that is probably fine.
  return { ok: false, reason: 'unavailable', detail: `http ${String(response.status)}` };
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 10) {
            nodes { id body author { login } }
          }
        }
      }
    }
  }
}`;

interface GraphqlReviewThreadsResponse {
  errors?: { message?: string }[];
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: ({
            id?: string;
            isResolved?: boolean;
            isOutdated?: boolean;
            path?: string;
            line?: number | null;
            comments?: { nodes?: ({ id?: string; body?: string; author?: { login?: string } } | null)[] };
          } | null)[];
        };
      };
    };
  };
}

/**
 * 256 KiB of trailing bytes, which is two orders of magnitude more than the
 * hundred lines anybody reads and still a constant.
 */
const LOG_TAIL_BYTES = 256 * 1024;

/**
 * Stream the body, keeping only the last `maxBytes`.
 *
 * The window is maintained by dropping whole leading chunks, so it holds
 * somewhat more than `maxBytes` between reads rather than copying on every
 * chunk. Dropping a chunk can cut a multi-byte character in half; the decoder
 * emits a replacement character for it, and `lastLines` discards the first
 * (partial) line anyway.
 */
async function readTrailingBytes(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const whole = await response.text();
    return { text: whole.slice(-maxBytes), truncated: whole.length > maxBytes };
  }

  const reader = body.getReader();
  const window: Uint8Array[] = [];
  let held = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    window.push(value);
    held += value.byteLength;
    while (window.length > 1 && held - (window[0]?.byteLength ?? 0) >= maxBytes) {
      held -= window.shift()?.byteLength ?? 0;
      truncated = true;
    }
  }

  const joined = new Uint8Array(held);
  let offset = 0;
  for (const chunk of window) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(joined), truncated };
}

/**
 * The last `count` lines. The FIRST line is dropped when the text was truncated
 * mid-stream, because a half-line of a log is worse than no line: it reads like
 * a complete statement that says something the log never said.
 */
export function lastLines(text: string, count: number, truncated = false): string {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const taken = lines.slice(-Math.max(count, 1));
  if (truncated && taken.length > 1 && taken.length === Math.max(count, 1)) taken.shift();
  return taken.join('\n');
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
