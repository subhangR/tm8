/**
 * What the attach palette has already linked, read off the anchor's own
 * connections. Pure: the panel builds the strip's entity tiles from it, the
 * picker hides what is already there, and the subtree body keeps those same
 * edges out of LINKED and RUNS so one link is drawn once.
 *
 * Kind-blind like the rest of `files/`: every kind and edge type comes from
 * the registry row (`PanelConfig.attachPalette`), never from a literal here.
 */
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import type { AttachPaletteRow, ContentBlockRef } from '../domain';

export interface PaletteLink {
  edgeId: string;
  row: AttachPaletteRow;
  peer: EntitySummary;
}

/**
 * The title as a collision key: NFC, trimmed, lower-cased. This is the same
 * name key a spawn uses for skills (execution `skillIdentityKey`, when a skill
 * has no file path).
 */
export function titleKey(title: string): string {
  return title.normalize('NFC').trim().toLowerCase();
}

/** Every existing link that matches a palette row: edge type, direction and peer kind. */
export function paletteLinks(
  detail: EntityDetail,
  rows: readonly AttachPaletteRow[],
): PaletteLink[] {
  const out: PaletteLink[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const groups = row.direction === 'outgoing'
      ? detail.connections.outgoing
      : detail.connections.incoming;
    for (const group of groups) {
      if (group.type !== row.edgeType) continue;
      for (const edge of group.edges) {
        const peer = edge.source.id === detail.id ? edge.target : edge.source;
        if (peer.id === detail.id || peer.kind !== row.kind || seen.has(edge.id)) continue;
        seen.add(edge.id);
        out.push({ edgeId: edge.id, row, peer });
      }
    }
  }
  return out;
}

/**
 * The links the STRIP draws as tiles: all of them except those whose edge type
 * a panel block already draws as its own section. The task's MEMORIES block
 * owns `remembers`, with Forget and the composer, so a remembered memory is
 * shown there and not a second time as a tile.
 */
export function stripLinks(
  links: readonly PaletteLink[],
  blocks: readonly ContentBlockRef[] | undefined,
): PaletteLink[] {
  const owned = new Set(
    (blocks ?? []).flatMap((block) =>
      typeof block.params?.edgeType === 'string' ? [block.params.edgeType] : []),
  );
  return links.filter((link) => !owned.has(link.row.edgeType));
}
