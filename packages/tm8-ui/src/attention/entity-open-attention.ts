import type { AttentionRequest } from '@tm8/contract';
import type { Seam } from '../data/seam';

/**
 * One entity's OPEN attention items, for a surface that reads its own state
 * out of them rather than showing them as attention (the bridge page's open
 * hand-over offer, D56: the offer IS an attention item on the bridge, and
 * there is no list op). The status is omitted, which the server reads as open
 * (plus legacy acknowledged) — the same "pending" the rest of this module uses.
 *
 * It lives here because `src/attention/` is the only UI module that calls the
 * attention API (attention-api-ban.test).
 */
export async function readEntityOpenAttention(
  seam: Pick<Seam, 'attentionRequests'>,
  spaceId: string,
  entityId: string,
  limit = 50,
): Promise<AttentionRequest[]> {
  return (await seam.attentionRequests({ spaceId, entityId, limit })).items;
}
