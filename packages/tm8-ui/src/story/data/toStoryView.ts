/**
 * The real story read → the page's `StoryView` (story/model.ts).
 *
 * Near-identity on purpose: `state` and `page` ARE the contract's StoryState
 * and StoryPage (migration 282), computed by the server. This file adds only
 * what the page cannot get from one read — the live feed merged over the
 * page's backlog, and a `people` map naming every id the page points at. It
 * never recounts a figure.
 *
 * Input: one `entities.get(story)` detail. A row whose state is not a story
 * maps to `null`; a story without a hydrated page (a command echo) maps with
 * `emptyPage()`, as the model requires.
 */
import type {
  ActorSummary,
  EntityDetail,
  MessageView,
  StoryContent,
  StoryPage,
  StoryState,
} from '@tm8/contract';
import { emptyPage, type StoryFeedRow, type StoryPerson, type StoryView } from '../model';

/** The story's summary, when this row is a story. */
export function storyStateOf(entity: { state: unknown }): StoryState | null {
  const s = entity.state as { kind?: string } | null;
  return s && s.kind === 'story' ? (s as StoryState) : null;
}

export function storyPageOf(entity: { content?: unknown }): StoryPage | null {
  const c = entity.content as Partial<StoryContent> | null | undefined;
  return c && c.kind === 'story' && c.page ? c.page : null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const two = parts.length === 1 ? parts[0]!.slice(0, 1) : parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1);
  return two.toUpperCase();
}

/**
 * Everyone the page may name, keyed by id. Built from the page each read and
 * topped up from actors seen on live events (`rememberActor`), so a name, once
 * seen, sticks across re-reads.
 */
export type PeopleBook = Map<string, StoryPerson>;

function person(actor: ActorSummary): StoryPerson {
  return { id: actor.id, name: actor.displayName, initials: initials(actor.displayName), agent: actor.isAgent };
}

/**
 * Remember an actor under its own id and — for a session acting as a
 * teammate (`via`) — under the session id too, since the page may name either.
 */
export function rememberActor(book: PeopleBook, actor: ActorSummary | null | undefined): void {
  if (!actor) return;
  if (!book.has(actor.id)) book.set(actor.id, person(actor));
  const via = actor.via?.sessionId;
  if (via && !book.has(via)) book.set(via, person(actor));
}

function peopleOf(page: StoryPage, seen: PeopleBook): Record<string, StoryPerson> {
  const book: PeopleBook = new Map(seen);
  for (const m of page.recentMessages) rememberActor(book, m.author);
  for (const a of page.activity) rememberActor(book, a.actor);
  // The page's own names win over a remembered actor: they carry the mode.
  // A `member` on the team is a human: not an agent, mode null.
  for (const t of page.team) {
    book.set(t.id, { id: t.id, name: t.name, initials: initials(t.name), agent: t.kind !== 'member', mode: t.mode });
  }
  for (const s of page.sessions) {
    const teammate = s.teamMemberId ? book.get(s.teamMemberId) : undefined;
    // A session is named by its teammate when it has one, else by its call sign.
    if (!book.has(s.id)) {
      book.set(s.id, teammate
        ? { ...teammate, id: s.id }
        : { id: s.id, name: s.callSign, initials: initials(s.callSign), agent: true, mode: s.mode });
    }
  }
  return Object.fromEntries(book);
}

export interface ToStoryViewInput {
  entity: EntityDetail;
  /** Message rows from live events, newest first. */
  liveFeed?: readonly StoryFeedRow[];
  /** Message ids deleted since the read. */
  deleted?: ReadonlySet<string>;
  /** Actors seen on live events. */
  seen?: PeopleBook;
}

export function toStoryView({ entity, liveFeed = [], deleted, seen = new Map() }: ToStoryViewInput): StoryView | null {
  const state = storyStateOf(entity);
  if (!state) return null;
  const content = entity.content as Partial<StoryContent> | undefined;
  const page = storyPageOf(entity) ?? emptyPage();
  const self = page.nodes.find((n) => n.id === entity.id);

  const liveIds = new Set(liveFeed.map((f) => f.id));
  const feed = [...liveFeed, ...page.recentMessages.filter((m) => !liveIds.has(m.id))]
    .filter((f) => !deleted?.has(f.id))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    id: entity.id,
    version: entity.version,
    title: entity.title,
    description: content?.description ?? '',
    status: self?.status ?? '',
    statusCategory: self?.statusCategory ?? null,
    state,
    page,
    feed,
    people: peopleOf(page, seen),
  };
}

/**
 * A live `message.created` → a feed row, its anchor named from the last page
 * (every feed anchor is a page node, or the story itself).
 */
export function feedRowFromMessage(
  page: StoryPage | null,
  story: { id: string; title: string },
  message: MessageView,
): StoryFeedRow {
  const anchorId = message.state.anchorId;
  const node = page?.nodes.find((n) => n.id === anchorId);
  const isStory = anchorId === story.id;
  return {
    id: message.id,
    at: message.createdAt,
    anchorId,
    anchorKind: node?.kind ?? (isStory ? 'story' : ''),
    anchorTitle: node?.title ?? (isStory ? story.title : ''),
    authorId: message.state.author.id,
    author: message.state.author,
    excerpt: message.content.body,
    incoming: true,
  };
}
