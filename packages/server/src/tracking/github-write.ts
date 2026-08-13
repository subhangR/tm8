/**
 * The forge WRITE client — deliberately a SEPARATE module from the reader.
 *
 * `github.ts` polls facts and can run forever on a node-level token against
 * public repositories. THIS file changes real repositories, and everything
 * about it is scoped down accordingly:
 *
 *   * ONE VERB. Merge a pull request. No branch deletion, no force paths, no
 *     review submission, no PR creation. Each future write verb is a fresh
 *     decision with its own guards, not a parameter on this one.
 *   * THE TOKEN IS REQUIRED AND PER-MEMBER. The reader degrades to anonymous;
 *     a write never may. Callers hand this client the ACTING member's own
 *     credential (DbGitHubCredentialStore.resolve), so every merge on the
 *     forge is attributable to the human whose credential performed it —
 *     never to a shared node token.
 *   * SAME TYPED-OUTCOME HONESTY AS THE READER, plus the write-only answers:
 *     `method_blocked` is GitHub's 405 (branch protection / checks refuse the
 *     merge — the forge said no, and that is a fact, not an error to retry),
 *     and `head_moved` is the 409 answered when `expectedHeadSha` no longer
 *     matches — the branch changed after it was reviewed, and merging anyway
 *     would land commits nobody looked at.
 *   * `repo` IS SHAPE-CHECKED before it reaches a URL, exactly like the
 *     reader: it originates from a stored row a link-pr call wrote, which
 *     makes it attacker-influenced text.
 */

const GITHUB_API = 'https://api.github.com';
/** Parity with the reader's `REPO_RE` — one shape, two files, both strict. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export interface MergeResult {
  /** The merge commit GitHub created. */
  sha: string;
  merged: true;
  message: string;
}

export type GithubWriteOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | 'invalid_repo'
        | 'no_credential'
        | 'not_found'
        | 'unauthorized'
        | 'rate_limited'
        | 'method_blocked'
        | 'head_moved'
        | 'unavailable';
      detail: string;
    };

export interface GithubWriteClientOptions {
  /**
   * The acting member's credential. REQUIRED at call time, not construction —
   * a client instance is cheap and holding a token longer than one call is a
   * lifetime nobody asked for.
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface MergeRequest {
  /** `owner/name`, shape-checked here. */
  repo: string;
  number: number;
  /** The acting member's token — never a node-level fallback. */
  token: string;
  /**
   * When present, GitHub refuses the merge (409) if the branch head moved
   * past this sha — the "merge exactly what was reviewed" guard. Callers
   * should pass the head sha the observer last recorded.
   */
  expectedHeadSha?: string | undefined;
  /** The commit title GitHub uses; optional, GitHub composes one otherwise. */
  commitTitle?: string | undefined;
  signal?: AbortSignal | undefined;
}

export class GithubWriteClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GithubWriteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * PUT /repos/{repo}/pulls/{number}/merge with `merge_method: 'merge'` —
   * fixed, not a parameter: squash and rebase rewrite history that tm8's
   * commit records and checkpoint accounting already point at.
   */
  async mergePullRequest(request: MergeRequest): Promise<GithubWriteOutcome<MergeResult>> {
    // `.` and `..` match the character class but are path segments, not
    // GitHub names — `/repos/../pulls` would walk the API path. Same refusal
    // as `task import-issue`'s.
    const traversal = request.repo.split('/').some((part) => part === '.' || part === '..');
    if (!REPO_RE.test(request.repo) || traversal) {
      return { ok: false, reason: 'invalid_repo', detail: `${request.repo} is not owner/name` };
    }
    const token = request.token.trim();
    if (token === '') {
      return { ok: false, reason: 'no_credential', detail: 'a merge requires the acting member’s GitHub credential' };
    }
    if (!Number.isInteger(request.number) || request.number <= 0) {
      return { ok: false, reason: 'not_found', detail: `${String(request.number)} is not a PR number` };
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${GITHUB_API}/repos/${request.repo}/pulls/${String(request.number)}/merge`,
        {
          method: 'PUT',
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'content-type': 'application/json',
            // Same rule as the reader: no User-Agent is a 403 in disguise.
            'user-agent': 'tm8-forge-write',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            merge_method: 'merge',
            ...(request.expectedHeadSha === undefined ? {} : { sha: request.expectedHeadSha }),
            ...(request.commitTitle === undefined ? {} : { commit_title: request.commitTitle }),
          }),
          signal,
        },
      );
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const body = (await response.json().catch(() => ({}))) as {
      sha?: unknown;
      merged?: unknown;
      message?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message : `http ${String(response.status)}`;

    if (response.ok) {
      if (body.merged === true && typeof body.sha === 'string') {
        return { ok: true, value: { sha: body.sha, merged: true, message } };
      }
      // A 200 that does not say merged:true is a contract drift, not a success.
      return { ok: false, reason: 'unavailable', detail: `200 without merged:true — ${message}` };
    }
    if (response.status === 405) {
      // Branch protection, failing checks, or a draft: the forge REFUSED. This
      // is the answer the disabled-with-reason UI renders verbatim.
      return { ok: false, reason: 'method_blocked', detail: message };
    }
    if (response.status === 409) {
      return { ok: false, reason: 'head_moved', detail: message };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', detail: message };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', detail: message };
    }
    if (response.status === 403 || response.status === 429) {
      // GitHub reports rate limiting as 403 with a header; a plain 403 without
      // the header is a permissions refusal — distinguish them the same way
      // the reader does.
      const remaining = response.headers.get('x-ratelimit-remaining');
      return remaining === '0'
        ? { ok: false, reason: 'rate_limited', detail: message }
        : { ok: false, reason: 'unauthorized', detail: message };
    }
    return { ok: false, reason: 'unavailable', detail: message };
  }
}
