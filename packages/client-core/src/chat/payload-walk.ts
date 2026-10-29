/**
 * THE ONE PAYLOAD WALKER — how a tool payload is PARSED, for every fold that
 * reads one.
 *
 * Two folds now walk the same MCP payloads and ask different questions of them.
 * `extractEntityRefs` wants a BOUNDED set of references to draw (chips, graph
 * seeds, the sticky tree): eight is plenty, and more would be worse. The ledger
 * tally wants an EXACT count of what a turn touched, where a cap is not a
 * kindness but a lie — "Read 8 tasks" when fifty came back.
 *
 * THOSE ARE DIFFERENT QUESTIONS AND THEY MUST STAY DIFFERENT. What they must
 * NOT differ in is the parsing: which shapes count as an entity, which id-keys
 * are bookkeeping, how an edge row is recognised, how a JSON-in-a-string
 * envelope is unwrapped. Two hand-written walkers agreeing on that today is how
 * `write-classifier.ts` describes its own origin story — two answers to one
 * question, drifting until the disagreement became visible to users.
 *
 * So the walk lives here once and takes a VISITOR plus a BUDGET. Callers differ
 * in what they accumulate and how far they are willing to walk; they cannot
 * differ in what the payload means.
 *
 * THE BUDGET IS A PARAMETER BECAUSE ITS RIGHT VALUE DIFFERS. A bounded ref
 * extraction stops early by design. A tally over a 50-row `collections.query`
 * page must not — see `MAX_NODES` in `entity-refs.ts` and `TALLY_MAX_NODES` in
 * `ledger.ts`, both of which record how their number was arrived at.
 */

/** Graph entity ids are UUIDv7 — version nibble 7, RFC variant. */
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isEntityIdLike(value: unknown): boolean {
  return typeof value === 'string' && UUIDV7.test(value);
}

/** Id-bearing keys that never name an openable graph entity — singular and
 *  plural forms both, since batch tool args use the plurals. */
const SKIP_KEYS = new Set([
  'spaceId',
  'spaceIds',
  'clientMutationId',
  'clientMutationIds',
  'edgeId',
  'edgeIds',
  'toolCallId',
  'toolCallIds',
  'requestId',
  'requestIds',
  'cursorId',
  'cursorIds',
]);

export function isIdKey(key: string): boolean {
  return key === 'id' || key === 'ids' || key.endsWith('Id') || key.endsWith('Ids');
}

/**
 * What the walk found. Both arms are reported; a caller ignores the one it does
 * not care about.
 *
 * `onEntityObject` is the FULL-SUMMARY arm — an object carrying a UUIDv7 `id`,
 * with whatever `kind`/`title` rode along. This is the arm the ledger's "read"
 * count is defined over (ruling 2: *distinct entities appearing as full
 * summaries in a result*).
 *
 * `onBareId` is the ARGUMENT arm — a UUIDv7 under an id-ish key with no
 * surrounding object. These are how a call NAMES its subject, not evidence that
 * anything was learned about it, which is exactly why the read count excludes
 * them.
 */
export interface PayloadVisitor {
  onEntityObject?: (
    id: string,
    fields: { kind?: string | undefined; title?: string | undefined },
    record: Record<string, unknown>,
  ) => void;
  onBareId?: (id: string, key: string) => void;
}

export interface WalkBudget {
  maxNodes: number;
  maxDepth: number;
}

/**
 * Walk a tool payload defensively. Never throws: a malformed payload yields
 * fewer callbacks, never a torn render.
 *
 * Returns the number of nodes actually visited, so a caller can MEASURE its
 * budget against real payloads instead of guessing one.
 */
export function walkPayload(
  value: unknown,
  visitor: PayloadVisitor,
  budget: WalkBudget,
): number {
  let remaining = budget.maxNodes;
  let visited = 0;

  const walk = (node: unknown, depth: number, key?: string): void => {
    if (remaining-- <= 0 || depth > budget.maxDepth || node === null || node === undefined) {
      return;
    }
    visited += 1;

    if (typeof node === 'string') {
      if (isEntityIdLike(node)) {
        if (key !== undefined && isIdKey(key) && !SKIP_KEYS.has(key)) {
          visitor.onBareId?.(node, key);
        }
        return;
      }
      const trimmed = node.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          walk(JSON.parse(trimmed), depth + 1);
        } catch {
          // Not JSON after all — a text blob stays a text blob.
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, key);
      return;
    }

    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      // An edge row's own id is a UUIDv7 but not an openable entity — its
      // endpoints (srcId/dstId) still surface through the key heuristic below.
      const edgeShaped =
        ('srcId' in record && 'dstId' in record) || ('src' in record && 'dst' in record);
      if (!edgeShaped && typeof record.id === 'string' && isEntityIdLike(record.id)) {
        visitor.onEntityObject?.(
          record.id,
          {
            ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
            ...(typeof record.title === 'string' ? { title: record.title } : {}),
          },
          record,
        );
      }
      for (const [childKey, child] of Object.entries(record)) {
        if (childKey === 'id') continue; // consumed by the shape above
        walk(child, depth + 1, childKey);
      }
    }
  };

  walk(value, 0);
  return visited;
}
