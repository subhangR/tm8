/**
 * Deterministic local intent retrieval over the operation projection (§7.4).
 *
 * Deterministic, not clever. Two properties matter more than ranking quality:
 *
 *  - REACHABILITY MUST NOT DEPEND ON RANKING. Ranking may improve over time;
 *    an operation that a bad ranking buries is still reachable by exact
 *    `--operation` lookup and by its noun shard, both of which are total. So
 *    this file is allowed to be simple.
 *  - IT NEVER INVENTS AN OPERATION (conformance D5). Every candidate comes from
 *    the projection; there is no fuzzy generation step and no fallback that
 *    manufactures a plausible-looking command.
 *
 * The one judgement encoded here: an operation the caller CANNOT invoke must
 * not outrank one they can. Internal and reserved rows are scored down rather
 * than excluded — hiding them would make `execution.prompt` and `search.query`
 * undiscoverable, which is the failure this whole surface exists to prevent —
 * but recommending them first would be answering a question with a dead end.
 */
import type { OperationDiscovery } from './operations.js';

/**
 * Words that carry no intent. Without this list, "what can I do with all of
 * this" matches on `all` and `this` and returns noise ranked above the answer.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'out',
  'please', 'should', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this',
  'to', 'up', 'want', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'will', 'with',
  'would', 'you', 'your',
]);

export function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

const EXACT_TAG = 40;
const PREFIX_TAG = 12;
const SUMMARY_WORD = 8;
/** Internal and reserved rows stay discoverable but must never be the answer. */
const UNINVOCABLE_FACTOR = 0.25;

export interface Scored {
  row: OperationDiscovery;
  score: number;
  /** The tokens that actually matched — rendered as the match `reason`. */
  hits: string[];
}

function summaryWords(row: OperationDiscovery): Set<string> {
  return new Set(row.summary.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
}

export function score(tokens: readonly string[], row: OperationDiscovery): Scored {
  const tags = new Set(row.intentTags);
  const words = summaryWords(row);
  let total = 0;
  const hits: string[] = [];

  for (const token of tokens) {
    if (tags.has(token)) {
      total += EXACT_TAG;
      hits.push(token);
      continue;
    }
    // A prefix match is worth having ("attach" → "attachment") but only for
    // tokens long enough that the prefix means something.
    if (token.length >= 4 && [...tags].some((t) => t.startsWith(token) || token.startsWith(t))) {
      total += PREFIX_TAG;
      hits.push(token);
      continue;
    }
    if (token.length >= 4 && words.has(token)) {
      total += SUMMARY_WORD;
      hits.push(token);
    }
  }

  if (row.exposure === 'internal' || row.exposure === 'reserved') total *= UNINVOCABLE_FACTOR;
  return { row, score: total, hits };
}

/**
 * Rank and cut. Ties break on catalog order, which is stable across runs and
 * across machines — a ranking that reordered itself between two invocations
 * would make every cached help shard a lie.
 */
export function rank(
  query: string,
  rows: readonly OperationDiscovery[],
  limit: number,
): Scored[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const order = new Map(rows.map((r, i) => [r.operation, i]));
  return rows
    .map((row) => score(tokens, row))
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (order.get(a.row.operation) as number) - (order.get(b.row.operation) as number),
    )
    .slice(0, limit);
}

/** Why this row surfaced, in one clause a reader can act on. */
export function matchReason(scored: Scored): string {
  const hits = [...new Set(scored.hits)].slice(0, 4);
  return hits.length > 0
    ? `matches ${hits.join(', ')} — ${scored.row.summary.toLowerCase()}`
    : scored.row.summary.toLowerCase();
}
