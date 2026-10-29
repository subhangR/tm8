/**
 * The review-thread window. The 50-thread bound counts resolved threads too, so
 * it must be the NEWEST 50: with the oldest, a long-lived PR whose first fifty
 * conversations were all resolved never announced a new one.
 */
import { describe, expect, it } from 'vitest';

import { GithubClient } from '../../src/tracking/github.js';

describe('GithubClient.reviewThreads', () => {
  it('asks for the newest threads, not the oldest', async () => {
    let query = '';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      query = (JSON.parse(String(init?.body)) as { query: string }).query;
      return new Response(JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { id: 'T_new', isResolved: false, isOutdated: false, path: 'a.ts', line: 3, comments: { nodes: [] } },
        ] } } } },
      }));
    }) as typeof fetch;

    const result = await new GithubClient({ token: 't', fetchImpl }).reviewThreads('o/r', 7);

    expect(query).toMatch(/reviewThreads\(last: 50\)/);
    expect(result.ok && result.value?.map((t) => t.threadKey)).toEqual(['T_new']);
  });
});
