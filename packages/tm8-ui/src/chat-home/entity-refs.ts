/**
 * Entity reference extraction for chat tool cards.
 *
 * MCP tool payloads (@tm8/mcp `tm8_*`) are JSON-ish blobs: structuredContent
 * objects, `content: [{ type: 'text', text: '<json>' }]` envelopes, or plain
 * strings that themselves contain JSON. The walk that unpicks those lives in
 * `payload-walk.ts` and is SHARED with the ledger tally, so the two folds can
 * never disagree about what a payload means (they differ only in what they
 * accumulate — see that module's docblock).
 *
 * This module keeps the BOUNDED question: which few entities should a surface
 * DRAW? Chips, graph seeds and the sticky tree all want a small first-seen set,
 * and `MAX_REFS` is a feature of that question, not a limitation of it.
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
import { walkPayload } from './payload-walk';

export { isEntityIdLike } from './payload-walk';

export interface ChatEntityRef {
  id: string;
  kind?: string;
  title?: string;
}

const MAX_REFS = 8;

/**
 * The walk budget for REF EXTRACTION.
 *
 * Raised from 500 (measured 2026-08-21): a single `collections.query` page of
 * 50 entity rows, each carrying nested actor summaries, exhausts 500 nodes long
 * before the walk reaches the end of the page — so a busy read silently
 * returned fewer refs than it had found, and the graph under-seeded.
 *
 * Raising it is STRICTLY SAFE for what is already on screen: `MAX_REFS` still
 * caps the output at eight and first-seen order is preserved, so a larger
 * budget can only ADD refs in payloads where the walk previously ran dry before
 * finding eight. It cannot reorder or replace what the graph and tray show.
 */
const MAX_NODES = 6000;
const MAX_DEPTH = 8;

/** Pull entity references out of a tool call's args and result, deduped by id
 *  (richer fields win), in first-seen order, capped at MAX_REFS. */
export function extractEntityRefs(...payloads: readonly unknown[]): ChatEntityRef[] {
  const found = new Map<string, ChatEntityRef>();

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

  for (const payload of payloads) {
    walkPayload(
      payload,
      {
        onEntityObject: (id, fields) => add({ id, ...fields }),
        onBareId: (id) => add({ id }),
      },
      { maxNodes: MAX_NODES, maxDepth: MAX_DEPTH },
    );
  }
  return [...found.values()];
}

/** A UUID is unreadable; show enough of both ends to be recognisable. */
export function truncateEntityId(id: string): string {
  return id.length <= 13 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
