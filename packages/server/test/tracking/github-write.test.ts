/**
 * The forge write client, against a scripted fetch — every typed outcome, and
 * the refusals that must happen BEFORE any network: repo shape, empty token,
 * non-integer PR number. The client's whole contract is that a caller can
 * switch on `reason` and render the truth; these tests pin that vocabulary.
 */
import { describe, expect, it } from 'vitest';
import { GithubWriteClient } from '../../src/tracking/github-write.js';

function fetchAnswering(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { impl: typeof fetch; seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: unknown) => {
    seen.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { impl, seen };
}

const REQUEST = { repo: 'octo/widgets', number: 7, token: 'ghp_x' };

describe('refusals before any network', () => {
  it('refuses a repo that is not owner/name', async () => {
    const { impl, seen } = fetchAnswering(200, {});
    const client = new GithubWriteClient({ fetchImpl: impl });
    const out = await client.mergePullRequest({ ...REQUEST, repo: '../evil' });
    expect(out).toMatchObject({ ok: false, reason: 'invalid_repo' });
    expect(seen).toHaveLength(0);
  });

  it('refuses an empty token — a write NEVER degrades to anonymous', async () => {
    const { impl, seen } = fetchAnswering(200, {});
    const client = new GithubWriteClient({ fetchImpl: impl });
    const out = await client.mergePullRequest({ ...REQUEST, token: '  ' });
    expect(out).toMatchObject({ ok: false, reason: 'no_credential' });
    expect(seen).toHaveLength(0);
  });

  it('refuses a non-positive or fractional PR number', async () => {
    const { impl, seen } = fetchAnswering(200, {});
    const client = new GithubWriteClient({ fetchImpl: impl });
    expect(await client.mergePullRequest({ ...REQUEST, number: 0 })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await client.mergePullRequest({ ...REQUEST, number: 1.5 })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(seen).toHaveLength(0);
  });
});

describe('the wire call', () => {
  it('PUTs merge_method=merge with the member token, and reports the merge sha', async () => {
    const { impl, seen } = fetchAnswering(200, { merged: true, sha: 'abc123', message: 'Pull Request successfully merged' });
    const client = new GithubWriteClient({ fetchImpl: impl });
    const out = await client.mergePullRequest({ ...REQUEST, expectedHeadSha: 'head9', commitTitle: 'Land it' });
    expect(out).toMatchObject({ ok: true, value: { sha: 'abc123', merged: true } });

    const call = seen[0]!;
    expect(call.url).toBe('https://api.github.com/repos/octo/widgets/pulls/7/merge');
    expect(call.init.method).toBe('PUT');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ghp_x');
    expect(headers['user-agent']).toBe('tm8-forge-write');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ merge_method: 'merge', sha: 'head9', commit_title: 'Land it' });
  });

  it('a 200 without merged:true is contract drift, never a success', async () => {
    const { impl } = fetchAnswering(200, { merged: false, message: 'weird' });
    const out = await new GithubWriteClient({ fetchImpl: impl }).mergePullRequest(REQUEST);
    expect(out).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('the write-only refusal vocabulary', () => {
  it('405 is method_blocked — the forge said no (protection/checks), verbatim detail', async () => {
    const { impl } = fetchAnswering(405, { message: 'Required status check "ci" is failing.' });
    const out = await new GithubWriteClient({ fetchImpl: impl }).mergePullRequest(REQUEST);
    expect(out).toMatchObject({ ok: false, reason: 'method_blocked', detail: 'Required status check "ci" is failing.' });
  });

  it('409 is head_moved — the branch changed after review', async () => {
    const { impl } = fetchAnswering(409, { message: 'Head branch was modified.' });
    const out = await new GithubWriteClient({ fetchImpl: impl }).mergePullRequest({ ...REQUEST, expectedHeadSha: 'stale' });
    expect(out).toMatchObject({ ok: false, reason: 'head_moved' });
  });

  it('404 / 401 keep the reader vocabulary', async () => {
    expect(await new GithubWriteClient({ fetchImpl: fetchAnswering(404, { message: 'Not Found' }).impl }).mergePullRequest(REQUEST))
      .toMatchObject({ ok: false, reason: 'not_found' });
    expect(await new GithubWriteClient({ fetchImpl: fetchAnswering(401, { message: 'Bad credentials' }).impl }).mergePullRequest(REQUEST))
      .toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('403 splits on the rate-limit header, like the reader', async () => {
    const limited = fetchAnswering(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    expect(await new GithubWriteClient({ fetchImpl: limited.impl }).mergePullRequest(REQUEST))
      .toMatchObject({ ok: false, reason: 'rate_limited' });
    const forbidden = fetchAnswering(403, { message: 'Resource not accessible' }, { 'x-ratelimit-remaining': '99' });
    expect(await new GithubWriteClient({ fetchImpl: forbidden.impl }).mergePullRequest(REQUEST))
      .toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('a network failure is unavailable with the error text', async () => {
    const impl = (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch;
    const out = await new GithubWriteClient({ fetchImpl: impl }).mergePullRequest(REQUEST);
    expect(out).toMatchObject({ ok: false, reason: 'unavailable', detail: 'socket hang up' });
  });
});
