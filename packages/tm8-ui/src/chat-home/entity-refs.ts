/**
 * Entity reference extraction for chat tool cards.
 *
 * MCP tool payloads (@tm8/mcp `tm8_*`) are JSON-ish blobs: structuredContent
 * objects, `content: [{ type: 'text', text: '<json>' }]` envelopes, or plain
 * strings that themselves contain JSON. This module walks those defensively
 * and pulls out graph entity references so the transcript can render them as
 * first-class chips instead of leaving them buried in a <pre>.
 *
 * Heuristics (deliberately conservative — a false chip is worse than none):
 * - An object carrying a UUIDv7 `id` string is an entity reference; its
 *   sibling `kind`/`title` strings ride along when present.
 * - A UUIDv7 string under `id` or a key ending in `Id`/`Ids` is a bare
 *   reference (title resolved lazily by the chip). Bookkeeping keys that are
 *   ids but never entities to open (spaceId, clientMutationId, …) are skipped.
 * - Strings that look like JSON are parsed once and walked; parse failures
 *   are silently ignored. Depth, node and ref counts are bounded.
 */

export interface ChatEntityRef {
  id: string;
  kind?: string;
  title?: string;
}

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

const MAX_REFS = 8;
const MAX_NODES = 500;
const MAX_DEPTH = 8;

/** Pull entity references out of a tool call's args and result, deduped by id
 *  (richer fields win), in first-seen order, capped at MAX_REFS. */
export function extractEntityRefs(...payloads: readonly unknown[]): ChatEntityRef[] {
  const found = new Map<string, ChatEntityRef>();
  let budget = MAX_NODES;

  const add = (ref: ChatEntityRef) => {
    const existing = found.get(ref.id);
    if (existing) {
      found.set(ref.id, {
        id: ref.id,
        ...(existing.kind ?? ref.kind ? { kind: existing.kind ?? ref.kind } : {}),
        ...(existing.title ?? ref.title ? { title: existing.title ?? ref.title } : {}),
      });
      return;
    }
    if (found.size < MAX_REFS) found.set(ref.id, ref);
  };

  const walk = (value: unknown, depth: number, key?: string): void => {
    if (budget-- <= 0 || depth > MAX_DEPTH || value === null || value === undefined) return;

    if (typeof value === 'string') {
      if (isEntityIdLike(value)) {
        if (key !== undefined && idKey(key) && !SKIP_KEYS.has(key)) add({ id: value });
        return;
      }
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          walk(JSON.parse(trimmed), depth + 1);
        } catch {
          // Not JSON after all — a text blob stays a text blob.
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, key);
      return;
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // An edge row's own id is a UUIDv7 but not an openable entity — its
      // endpoints (srcId/dstId) still chip via the key heuristic below.
      const edgeShaped =
        ('srcId' in record && 'dstId' in record) || ('src' in record && 'dst' in record);
      if (!edgeShaped && typeof record.id === 'string' && isEntityIdLike(record.id)) {
        add({
          id: record.id,
          ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
          ...(typeof record.title === 'string' ? { title: record.title } : {}),
        });
      }
      for (const [childKey, child] of Object.entries(record)) {
        if (childKey === 'id') continue; // consumed by the shape above
        walk(child, depth + 1, childKey);
      }
    }
  };

  for (const payload of payloads) walk(payload, 0);
  return [...found.values()];
}

function idKey(key: string): boolean {
  return key === 'id' || key === 'ids' || key.endsWith('Id') || key.endsWith('Ids');
}

/** A UUID is unreadable; show enough of both ends to be recognisable. */
export function truncateEntityId(id: string): string {
  return id.length <= 13 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
