/**
 * "Tell" — after the page makes something (a task, a session, a child story),
 * ONE message per chosen anchor says it exists: its kind, its title, its id
 * and a link. A teammate's live session hears it on its terminal; a member or
 * an idle teammate finds it on their own anchor.
 *
 * Each post is its own `messages.post`, so one refused anchor never takes the
 * others down — and a failed tell NEVER undoes the create. Results come back
 * per target for the caller to show.
 */
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { uuidV7 } from '../../channel-screen/chat-mutations';
import { entityLinkUrl } from '../../share/CopyLinkControl';
import type { StoryView } from '../model';

export interface TellNewEntity {
  id: EntityId;
  kind: string;
  title: string;
  spaceId: SpaceId;
}

export interface TellTarget {
  /** The anchor the message is posted on (a session, a teammate, a member). */
  anchorId: EntityId;
  /** What the caller asked for, when it resolved to a different anchor. */
  requestedId?: EntityId;
}

export type TellResult =
  | { anchorId: EntityId; requestedId: EntityId; ok: true; messageId: string | null }
  | { anchorId: EntityId; requestedId: EntityId; ok: false; error: string };

export interface TellInput {
  newEntity: TellNewEntity;
  targets: ReadonlyArray<TellTarget | EntityId>;
  /** The story it was made on, named in the message. */
  story?: { id: EntityId; title: string } | null;
  /** Optional free words from the person who made it. */
  note?: string | null;
}

export function tellBody(input: Omit<TellInput, 'targets'>, link: string | null): string {
  const { newEntity, story, note } = input;
  const kind = newEntity.kind.replace(/_/g, ' ');
  const lines = [`New ${kind}: "${newEntity.title}" (${newEntity.id})${story ? ` in story "${story.title}"` : ''}.`];
  if (link) lines.push(link);
  if (note && note.trim()) lines.push('', note.trim());
  return lines.join('\n');
}

export async function tellAbout(seam: Seam, input: TellInput): Promise<TellResult[]> {
  const link = entityLinkUrl({ spaceId: input.newEntity.spaceId, entityId: input.newEntity.id });
  const body = tellBody(input, link);
  const targets = dedupe(input.targets.map((t) => (typeof t === 'string' ? { anchorId: t } : t)));
  return Promise.all(
    targets.map(async (t): Promise<TellResult> => {
      const requestedId = t.requestedId ?? t.anchorId;
      try {
        const result = await seam.commands.postMessage({
          clientMutationId: uuidV7(),
          anchorIds: [t.anchorId],
          body,
        });
        const messageId = 'messages' in result ? (result.messages[0]?.id ?? null) : (result.entity?.id ?? null);
        return { anchorId: t.anchorId, requestedId, ok: true, messageId };
      } catch (e) {
        return { anchorId: t.anchorId, requestedId, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

function dedupe(targets: TellTarget[]): TellTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => (seen.has(t.anchorId) ? false : (seen.add(t.anchorId), true)));
}

/**
 * The page's `tellIds` are people (teammates, members) or sessions. A teammate
 * with a LIVE session in the story is told on that session — that is where it
 * will actually read it; anyone else is told on their own anchor.
 */
export function resolveTellTargets(view: StoryView | null, ids: readonly EntityId[]): TellTarget[] {
  return ids.map((id) => {
    const live = view?.page.sessions.find((s) => s.live && s.teamMemberId === id);
    return live ? { anchorId: live.id, requestedId: id } : { anchorId: id };
  });
}
