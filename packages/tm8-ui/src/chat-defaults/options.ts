/**
 * What the Chat defaults section offers per row: the kinds (registry + the
 * space's custom kinds) and the space's teammates. Models are the node's
 * launch catalog, read by the section itself (`modelCatalog(nodeKey)`), the
 * same list the chat composer offers.
 */
import type { SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { chatDefaultKindRows, type ChatDefaultKindRow } from './kinds';

export interface ChatDefaultsTeammate {
  id: string;
  label: string;
}

export interface ChatDefaultsOptions {
  kinds: ChatDefaultKindRow[];
  teammates: ChatDefaultsTeammate[];
}

/**
 * The same teammate read the chat composer's picker makes
 * (`chat-home/real-port.ts` `listTeammates`). A failed custom-kind read still
 * lists every registry kind: the rows that exist are not held hostage to the
 * ones that might.
 */
export async function loadChatDefaultsOptions(
  seam: Pick<Seam, 'entityKinds' | 'query'>,
  spaceId: SpaceId,
): Promise<ChatDefaultsOptions> {
  const [kinds, teammates] = await Promise.all([
    seam.entityKinds(spaceId).catch(() => []),
    seam.query({ spaceId, kinds: ['team_member'], sort: 'activityAt_desc', limit: 100 }),
  ]);
  return {
    kinds: chatDefaultKindRows(kinds),
    teammates: teammates.page.items.map((item) => ({ id: item.id, label: item.title })),
  };
}
