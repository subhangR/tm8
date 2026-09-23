/**
 * THE one file on the server that imports `@tm8/jev` (design 01a0cb80 §7.1):
 * it maps `JevAdvisorPort` onto the pure client. Everything else codes
 * against the port, which is why candidates, rules and persistence are
 * testable with a fake and the client package never learns about the graph.
 *
 * Built ONCE at startup (main.ts). No `TYPESAFE_API_KEY`, no advisor: the
 * handler stays mounted and answers every group `failed: no_key`.
 */
import { adviseModel, jevClientFromEnv, rankByRelevance } from '@tm8/jev';

import type { JevAdvisorPort } from './port.js';

export function jevAdvisorFromEnv(env: Readonly<Record<string, string | undefined>>): JevAdvisorPort | null {
  const client = jevClientFromEnv(env);
  if (!client) return null;
  return {
    rank: ({ task, candidates, noun }) => rankByRelevance(client, { task, candidates, noun }),
    model: (subject) => adviseModel(client, subject),
  };
}
