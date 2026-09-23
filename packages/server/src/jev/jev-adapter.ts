/**
 * THE one file on the server that imports `@tm8/jev` (design 01a0cb80 §7.1):
 * it maps `JevAdvisorPort` onto the pure client. Everything else codes
 * against the port, which is why candidates, rules and persistence are
 * testable with a fake and the client package never learns about the graph.
 *
 * Which key a request spends is decided per request by `advisor.ts` (the
 * caller's own, else the node's); this file only turns a key into an advisor.
 */
import { createHash } from 'node:crypto';

import { adviseModel, createJevClient, jevClientFromEnv, rankByRelevance, type JevClient } from '@tm8/jev';

import type { JevAdvisorPort } from './port.js';

function advisorOf(client: JevClient): JevAdvisorPort {
  return {
    rank: ({ task, candidates, noun }) => rankByRelevance(client, { task, candidates, noun }),
    model: (subject) => adviseModel(client, subject),
  };
}

export function jevAdvisorFromEnv(env: Readonly<Record<string, string | undefined>>): JevAdvisorPort | null {
  const client = jevClientFromEnv(env);
  return client ? advisorOf(client) : null;
}

/** How many distinct keys keep a built advisor. Beyond it the oldest is rebuilt on next use. */
export const JEV_ADVISOR_CACHE_LIMIT = 64;
const cache = new Map<string, JevAdvisorPort>();

/**
 * An advisor bound to exactly `apiKey`, cached per key. The cache is indexed by
 * the key's SHA-256, never the key, and an entry can only ever hold the client
 * its own key built — so a cached advisor cannot carry another member's key.
 */
export function jevAdvisorForKey(apiKey: string): JevAdvisorPort {
  const id = createHash('sha256').update(apiKey).digest('hex');
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const advisor = advisorOf(createJevClient({ apiKey }));
  cache.set(id, advisor);
  if (cache.size > JEV_ADVISOR_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return advisor;
}

/** Test seam only. */
export function resetJevAdvisorCache(): void {
  cache.clear();
}
