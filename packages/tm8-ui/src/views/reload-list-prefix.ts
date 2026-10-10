import type { CollectionQuery, CollectionResult, EntitySummary, Page } from '@tm8/contract';

/** Recover a moved keyset without dropping already-loaded pages. A second
 * placement during recovery restarts the chain; continuous edits fail visibly. */
export async function reloadListPrefix(
  query: (input: CollectionQuery) => Promise<CollectionResult>,
  input: CollectionQuery,
  count: number,
): Promise<Page<EntitySummary>> {
  for (let attempt = 0; ; attempt++) {
    try {
      let cursor: string | null = null;
      const items: EntitySummary[] = [];
      const seen = new Set<string>();
      const cursors = new Set<string>();
      do {
        const result = await query({ ...input, cursor: cursor ?? undefined });
        for (const item of result.page.items) if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
        cursor = result.page.nextCursor;
        if (!cursor || items.length >= count) return { ...result.page, items };
        if (cursors.has(cursor)) throw new Error('The list returned a repeated cursor');
        cursors.add(cursor);
      } while (cursor);
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string })?.code !== 'invalid_cursor') throw error;
    }
  }
}
