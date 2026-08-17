import { useRef, useState, type ReactNode } from 'react';
import type {
  ActivityItem,
  Connections,
  EdgeGroup,
  EntityDetail,
  EntityId,
  Mention,
  MessageView,
} from '@tm8/contract';
import { Avatar, Chip, Eyebrow, Markdown, type MarkdownComponents } from '../../kit';
import { KindIcon, getKind } from '../../domain';
import type { FileUploadTask } from '../../files/upload';
import { ChooseFilesControl } from '../../files/ChooseFilesControl';
import { DisabledIconControl } from '../honesty/DisabledWithReason';
import {
  AttachmentChips,
  TriggerPopover,
  skillReference,
  useRichInput,
  type TriggerOption,
} from '../../rich-input';
/* Module-deep into the chat lane's PURE half — `feed-model` is plain functions
   with no React and no DOM. A message body is a message body wherever it is
   drawn, so the Discussion tab shares the channel's source preparation instead
   of growing a second copy that could drift from it. */
import { chatMarkdownSource, mentionIdInHref } from '../../channel-screen/feed-model';
import { EmptyBody } from './PanelStates';

/**
 * THE THREE SHARED TABS — designed once, rendered for every kind.
 *
 * Discussion, Connections and Activity are KIND-AGNOSTIC BY CONSTRUCTION:
 * they render `messages.list`, `EdgeGroup`s and `entities.activity` rows, none
 * of which vary by kind. That is why the four-tab law (D3) costs nothing —
 * three of the four tabs are the same component everywhere, so "every kind
 * gets four tabs" is one implementation, not fifteen.
 */

// ---------------------------------------------------------------------------
// Discussion
// ---------------------------------------------------------------------------

/**
 * WHAT A DISCUSSION REPLY CARRIES TO THE WIRE.
 *
 * The body was always the whole message this composer could express, which is
 * why its placeholder advertised an `@` it did not have. `PostMessageInput`
 * has accepted `mentionIds` and `attachmentIds` since the batch write landed;
 * the tab simply never sent them. Widening the dispatcher (rather than adding
 * side-channel props) keeps the message ONE object at every call site — the
 * same shape the channel composer's `onPost` already takes.
 */
export interface DiscussionPostInput {
  body: string;
  /** Ids the `@` picker committed — members and team members only. */
  mentionIds?: EntityId[];
  /** Entity ids of finished uploads, staged order. */
  attachmentIds?: EntityId[];
}

export function DiscussionTab({
  messages,
  provenanceHollowReason,
  authoredFrom,
  canPost,
  postDisabledReason,
  onPost,
  onOpenEntity,
  attach,
  mentionOptions,
  skillOptions,
}: {
  messages: readonly MessageView[];
  /** D7.3 copy for the hollow "from this session" chip. */
  provenanceHollowReason: string;
  /** entityId → session it was authored from. Null everywhere until S2 lands. */
  authoredFrom?: Readonly<Record<string, string | null>>;
  canPost?: boolean;
  postDisabledReason?: string;
  /** The dispatcher. ABSENT ⇒ the composer renders DISABLED with the true
      reason (Surface Audit 2026-07-29: it rendered enabled and wired to
      nothing — inviting an action it could not perform). R5 #9, structural. */
  onPost?: (input: DiscussionPostInput) => Promise<void> | void;
  /** Opens a mentioned entity. ABSENT ⇒ a mention stays marked-up TEXT, never
      a button that opens nothing. */
  onOpenEntity?: (id: EntityId) => void;
  /**
   * Starts one upload against THIS entity — the host binds the anchor, so the
   * tab never learns which entity it is writing to. Absent ⇒ the attach
   * control is drawn disabled-with-reason and paste/drop stay honestly inert.
   */
  attach?: (file: File) => FileUploadTask;
  /**
   * People `@` can mention. `undefined` ⇒ the capability is absent and `@`
   * types plain text — which is what this composer had all along, while its
   * placeholder said otherwise. An empty array is a measured zero.
   */
  mentionOptions?: readonly TriggerOption[];
  /** Skills `/` can reference (R1). `undefined` ⇒ `/` types plain text. */
  skillOptions?: readonly TriggerOption[];
}) {
  const branches = discussionBranches(messages);
  return (
    <div className="pn-body" id="tabpanel-discussion" role="tabpanel" aria-labelledby="tab-discussion">
      {messages.length === 0 ? (
        /* The invitation names only what is WIRED. It used to read "press /
           and mention someone" on a surface that had neither sigil — the
           defect this migration exists to end, and it would come straight
           back if this sentence were a constant. */
        <EmptyBody
          glyph="❝"
          sentence={`No discussion yet — reply below${sigilInvitation(mentionOptions, skillOptions)}.`}
        />
      ) : (
        <ul className="pn-thread">
          {branches.map(({ root, replies, replyToId }) => (
            <MessageBranch
              key={root.id}
              root={root}
              replies={replies}
              replyToId={replyToId}
              authoredFrom={authoredFrom}
              provenanceHollowReason={provenanceHollowReason}
              onOpenEntity={onOpenEntity}
            />
          ))}
        </ul>
      )}
      <Composer
        canPost={canPost}
        postDisabledReason={postDisabledReason}
        onPost={onPost}
        attach={attach}
        mentionOptions={mentionOptions}
        skillOptions={skillOptions}
      />
    </div>
  );
}

interface DiscussionBranchModel {
  root: MessageView;
  replies: MessageView[];
  /** Present only for a reply whose root was outside this bounded page. */
  replyToId: string | null;
}

function discussionBranches(messages: readonly MessageView[]): DiscussionBranchModel[] {
  const roots = messages.filter((message) => !message.state.rootMessageId);
  const repliesByRoot = new Map<string, Map<string, MessageView>>();

  for (const root of roots) {
    const branch = new Map<string, MessageView>();
    for (const reply of root.replies?.items ?? []) branch.set(reply.id, reply);
    repliesByRoot.set(root.id, branch);
  }
  const orphanReplies: MessageView[] = [];
  for (const message of messages) {
    const rootId = message.state.rootMessageId;
    if (!rootId) continue;
    const branch = repliesByRoot.get(rootId);
    if (branch) branch.set(message.id, message);
    else orphanReplies.push(message);
  }

  const ordered: DiscussionBranchModel[] = roots.map((root) => ({
    root,
    replies: [...(repliesByRoot.get(root.id)?.values() ?? [])]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    replyToId: null,
  }));
  for (const reply of orphanReplies) {
    ordered.push({
      root: reply,
      replies: [],
      replyToId: reply.parentId ?? reply.state.rootMessageId,
    });
  }
  return ordered;
}

function MessageBranch({
  root,
  replies,
  replyToId,
  authoredFrom,
  provenanceHollowReason,
  onOpenEntity,
}: {
  root: MessageView;
  replies: readonly MessageView[];
  replyToId: string | null;
  authoredFrom?: Readonly<Record<string, string | null>>;
  provenanceHollowReason: string;
  onOpenEntity?: (id: EntityId) => void;
}) {
  const hiddenReplyCount = Math.max(0, root.replyCount - replies.length);
  const branchMessages = new Map([root, ...replies].map((message) => [message.id, message]));
  return (
    <li className="pn-thread__branch">
      <MessageRow
        message={root}
        replyTo={replyToId ? { id: replyToId, message: null } : null}
        provenanceHollowReason={provenanceHollowReason}
        hasProvenanceSlot={root.id in (authoredFrom ?? {})}
        provenance={authoredFrom?.[root.id] ?? null}
        onOpenEntity={onOpenEntity}
      />
      {replies.length > 0 ? (
        <ul className="pn-thread__replies" aria-label={`Replies to ${root.state.author.displayName}`}>
          {replies.map((reply) => {
            const parentId = reply.parentId ?? reply.state.rootMessageId ?? root.id;
            return (
              <li key={reply.id}>
                <MessageRow
                  message={reply}
                  replyTo={{ id: parentId, message: branchMessages.get(parentId) ?? null }}
                  provenanceHollowReason={provenanceHollowReason}
                  hasProvenanceSlot={reply.id in (authoredFrom ?? {})}
                  provenance={authoredFrom?.[reply.id] ?? null}
                  onOpenEntity={onOpenEntity}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
      {hiddenReplyCount > 0 ? (
        <p className="pn-thread__more" aria-label={`${hiddenReplyCount} replies not in this preview`}>
          {`${hiddenReplyCount} more ${hiddenReplyCount === 1 ? 'reply' : 'replies'}`}
        </p>
      ) : null}
    </li>
  );
}

function MessageRow({
  message,
  replyTo,
  provenanceHollowReason,
  hasProvenanceSlot,
  provenance,
  onOpenEntity,
}: {
  message: MessageView;
  replyTo: { id: string; message: MessageView | null } | null;
  provenanceHollowReason: string;
  hasProvenanceSlot: boolean;
  provenance: string | null;
  onOpenEntity?: (id: EntityId) => void;
}) {
  // `MessageView.state` is typed as the message state, so the author is always
  // present — no kind comparison is needed, and §15.2 forbids one anyway.
  const author = message.state.author ?? message.createdBy;
  const isAgent = author.isAgent;
  return (
    <article className={`pn-msg${replyTo ? ' pn-msg--reply' : ''}`} data-message-id={message.id}>
      <Avatar
        actorId={author.id}
        provenance={isAgent ? 'agent' : 'human'}
        label={author.displayName}
        size={22}
        src={author.avatar ?? null}
      />
      <div className="pn-msg__col">
        {replyTo ? <DiscussionReplyContext target={replyTo} /> : null}
        <div className="pn-msg__byline">
          <span className="pn-msg__name">{author.displayName}</span>
          {/* Provenance is never carried by avatar shape alone — the word is
              there too, for anyone who cannot see the corner radius. */}
          <span className="pn-msg__tag">{isAgent ? 'agent' : 'human'}</span>
          {hasProvenanceSlot ? (
            <ProvenanceChip value={provenance} hollowReason={provenanceHollowReason} />
          ) : null}
        </div>
        <MessageBody message={message} onOpenEntity={onOpenEntity} />
      </div>
    </article>
  );
}

/**
 * The body — MARKDOWN, exactly as the channel feed draws it.
 *
 * The SAME message rendered as markdown in a channel and as one flat paragraph
 * here, because the Discussion tab is a different component from `FeedRow` and
 * only the feed was converted. A heading came out as a literal `##`, a table as
 * a row of pipes, a fence as a run-on line.
 *
 * Sharing `chatMarkdownSource` is what keeps the two surfaces honest: a lone
 * newline is a hard break in both, a fenced block keeps its bytes in both, and
 * a display name is escaped rather than obeyed in both.
 */
function MessageBody({
  message,
  onOpenEntity,
}: {
  message: MessageView;
  onOpenEntity?: (id: EntityId) => void;
}) {
  const { body, mentions } = message.content;
  const { source } = chatMarkdownSource(body, mentions);
  return (
    <Markdown
      source={source}
      className="pn-msg__body"
      testId="pn-msg-body"
      components={mentionComponents(mentions, onOpenEntity)}
    />
  );
}

/**
 * A mention is a CONTROL where it can open something, and TEXT where it cannot.
 *
 * `chatMarkdownSource` encodes each canonical mention as a link, so something
 * has to catch that href — left to the kit it would render as an outbound
 * anchor to `#tm8-mention-…`, which navigates nowhere. With a handler it
 * becomes a button, exactly as the channel feed's does. WITHOUT one it stays
 * marked-up text: a control that opens nothing is the dishonesty the panel's
 * own rules forbid, and both halves are structural — the branch reads whether
 * a handler exists, so it cannot drift from what is wired.
 *
 * The id is checked against THIS MESSAGE's mention list first, because a body
 * may legally contain a hand-written look-alike href that nobody vouched for.
 */
function mentionComponents(
  mentions: readonly Mention[],
  onOpenEntity?: (id: EntityId) => void,
): MarkdownComponents {
  return {
    a({ href, children, ...rest }) {
      const id = mentionIdInHref(href);
      if (id) {
        const mention = mentions.find((m) => m.entityId === id);
        if (!mention || !onOpenEntity) {
          return <span className="pn-msg__mention">{children}</span>;
        }
        return (
          <button
            type="button"
            className="pn-msg__mention pn-msg__mention--open"
            aria-label={`Open mention ${mention.display}`}
            onClick={() => onOpenEntity(mention.entityId)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" className="md-link" {...rest}>
          {children}
        </a>
      );
    },
  };
}

function DiscussionReplyContext({
  target,
}: {
  target: { id: string; message: MessageView | null };
}) {
  const author = target.message?.state.author.displayName ?? null;
  const excerpt = target.message?.state.redactedAt
    ? 'redacted message'
    : target.message?.content.body ?? target.id;
  return (
    <p className="pn-msg__reply-context" data-testid="pn-msg-reply-context">
      <span aria-hidden>↩</span>
      <span>in reply to</span>
      {author ? <strong>{author}</strong> : null}
      <span className="pn-msg__reply-excerpt">{excerpt}</span>
    </p>
  );
}

/**
 * D7.3 — "from this session" renders HOLLOW, not absent and not fabricated.
 * `authored_from` is null through every public write until backend S2 lands,
 * so the chip's SHAPE is real and its VALUE is honestly empty. Dropping the
 * chip would hide a gap; inventing a session id would manufacture one.
 */
function ProvenanceChip({ value, hollowReason }: { value: string | null; hollowReason: string }) {
  if (value) return <Chip glyph="▣">{`from ${value}`}</Chip>;
  return (
    <span className="pn-msg__provenance-hollow" title={hollowReason}>
      from — · not recorded
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** One peer entity and every edge type this entity shares with it. */
interface PeerGroup {
  peer: EdgeGroup['edges'][number]['source'];
  /** Edge types, first-appearance order, deduped by direction+type. */
  relations: { key: string; label: string; direction: 'outgoing' | 'incoming'; count: number; unresolvedHard: boolean }[];
  /** Any unresolved HARD dependency anywhere in this peer's relations. */
  unresolvedHard: boolean;
}

/**
 * The seam returns edges grouped BY TYPE. The question a reader actually asks
 * of this tab is "what is this connected to, and how?" — entity first, edge
 * types second — so we invert that grouping here: one row per peer entity,
 * carrying every relation it participates in. The inversion is stable
 * (first-appearance order) so the list does not reshuffle between renders.
 */
function groupByPeer(groups: readonly EdgeGroup[], selfId: string): PeerGroup[] {
  const byPeer = new Map<string, PeerGroup>();
  for (const group of groups) {
    for (const edge of group.edges) {
      // The far end of the edge relative to THIS entity.
      const peer = edge.source.id === selfId ? edge.target : edge.source;
      let entry = byPeer.get(peer.id);
      if (!entry) {
        entry = { peer, relations: [], unresolvedHard: false };
        byPeer.set(peer.id, entry);
      }
      const key = `${group.direction}:${group.type}`;
      const hard = edge.hard === true && edge.resolved === false;
      const existing = entry.relations.find((r) => r.key === key);
      if (existing) {
        existing.count += 1;
        existing.unresolvedHard ||= hard;
      } else {
        entry.relations.push({ key, label: group.label, direction: group.direction, count: 1, unresolvedHard: hard });
      }
      entry.unresolvedHard ||= hard;
    }
  }
  return [...byPeer.values()];
}

/**
 * "Task · Fix the login bug" — the kind NAMED, on the hover of every chip in
 * this tab.
 *
 * The drawn mark (`KindIcon`) is the first-glance answer to "which are what",
 * and the reason this tab was rebuilt: the old marks were near-identical
 * lozenges. The word is the second half of that answer, for the reader who has
 * not yet learned the mark. Both come from the registry, so neither can drift
 * from the other or from the kind.
 */
function peerTitle(kind: string, title: string): string {
  return `${getKind(kind).label} · ${title}`;
}

function ConnectionsViewSwitch({
  view,
  onChange,
}: {
  view: 'list' | 'graph';
  onChange: (next: 'list' | 'graph') => void;
}) {
  return (
    <div className="pn-viewswitch" role="group" aria-label="Connections view">
      {(['list', 'graph'] as const).map((id) => (
        <button
          key={id}
          type="button"
          className={id === view ? 'pn-viewswitch__opt pn-viewswitch__opt--on' : 'pn-viewswitch__opt'}
          aria-pressed={id === view}
          onClick={() => onChange(id)}
        >
          {id === 'list' ? 'List' : 'Graph'}
        </button>
      ))}
    </div>
  );
}

/**
 * "two axes: vertical = where it lives · horizontal = what it connects to."
 * Parent/children come from the hierarchy; LINKED rows are one per connected
 * entity, each showing the edge types it holds with this one.
 */
/**
 * THE GRAPH IS A VIEW OF CONNECTIONS, NOT A FEATURE OF SESSIONS.
 *
 * The ego-network canvas shipped as a fourth chip on `work_session`, so "what
 * is this connected to, drawn" became something only a session could answer —
 * "everything is centered around the session", in code. Nothing in that canvas
 * is session-shaped: it walks `entities.connections` outward from any focus id,
 * and this tab renders the very same edges as a list. They are two readings of
 * one fact, so they belong behind one switch. The list is the PRECISE reading
 * (every peer, every relation type, named); the graph is the SHAPE (what
 * clusters, what sits two hops out, what is a hub).
 *
 * Making it a VIEW rather than a per-kind chip is what makes a task-wise graph
 * cost nothing: `graphSurfaceFor` is already passed to this panel by all five
 * hosts, so every kind gains it in one place instead of fifteen.
 *
 * LIST STAYS THE DEFAULT: it answers a specific question, it needs no seam, and
 * it cannot fail — the graph reads the network, and a host without a seam has
 * no network to read. A host that passes no surface draws no switch, rather
 * than a control that would do nothing.
 */
export function ConnectionsTab({
  detail,
  connections,
  onOpenEntity,
  graph,
}: {
  detail: EntityDetail;
  connections?: Connections;
  onOpenEntity?: (id: string) => void;
  /** The ego-network canvas for THIS entity. Absent ⇒ no switch is drawn. */
  graph?: ReactNode;
}) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const groups: EdgeGroup[] = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  const peers = groupByPeer(groups, detail.id);
  const parent = detail.hierarchy.parent;
  const children = detail.hierarchy.children.items;
  const empty = !parent && children.length === 0 && peers.length === 0;

  if (graph !== undefined && view === 'graph') {
    return (
      <div
        className="pn-body pn-body--graph"
        id="tabpanel-connections"
        role="tabpanel"
        aria-labelledby="tab-connections"
      >
        {/* THE CANVAS GETS THE WHOLE BODY, and the switch floats on it.
            Drawn as a row above the graph, this control cost a full band of
            height plus the body's own padding on the one view that has nothing
            to spare — and it is two words. The graph reserves room for it at
            the leading edge of its own floating bar (`--sg-bar-lead`), so the
            switch and the graph's controls land on one line over the drawing
            instead of two bands above it. */}
        <div className="pn-connections-graph">{graph}</div>
        <div className="pn-graph-lead">
          <ConnectionsViewSwitch view={view} onChange={setView} />
        </div>
      </div>
    );
  }

  return (
    <div className="pn-body" id="tabpanel-connections" role="tabpanel" aria-labelledby="tab-connections">
      {graph === undefined ? null : <ConnectionsViewSwitch view={view} onChange={setView} />}
      {empty ? (
        <EmptyBody
          glyph="⊕"
          sentence="Nothing linked yet — drag an entity here, or press / and type its name."
          actionLabel="⊕ link an entity"
        />
      ) : null}

      {parent ? (
        <section className="pn-section">
          <Eyebrow faint>PARENT</Eyebrow>
          <div className="pn-chiprow">
            <Chip
              glyph={<KindIcon kind={parent.kind} />}
              onClick={() => onOpenEntity?.(parent.id)}
              title={peerTitle(parent.kind, parent.title)}
            >
              {parent.title}
            </Chip>
          </div>
        </section>
      ) : null}

      {peers.length > 0 ? (
        <section className="pn-section">
          <Eyebrow faint>{`LINKED · ${peers.length}`}</Eyebrow>
          <ul className="pn-peers">
            {peers.map((entry) => (
              <li className="pn-peers__row" key={entry.peer.id}>
                <Chip
                  glyph={<KindIcon kind={entry.peer.kind} />}
                  onClick={() => onOpenEntity?.(entry.peer.id)}
                  /* An unresolved HARD dependency is why something is blocked —
                     the chip says so rather than looking like any other link. */
                  title={
                    entry.unresolvedHard
                      ? 'unresolved hard dependency'
                      : peerTitle(entry.peer.kind, entry.peer.title)
                  }
                >
                  {entry.peer.title}
                </Chip>
                <div className="pn-peers__rels">
                  {entry.relations.map((rel) => (
                    <span
                      className={
                        rel.unresolvedHard ? 'pn-peers__rel pn-peers__rel--hard' : 'pn-peers__rel'
                      }
                      key={rel.key}
                      title={
                        rel.unresolvedHard
                          ? 'unresolved hard dependency'
                          : `${rel.direction} · ${rel.label}`
                      }
                    >
                      {/* Direction is part of the relation's meaning: "blocks"
                          and "blocked by" are the same edge type read two ways. */}
                      <span aria-hidden="true">{rel.direction === 'outgoing' ? '→' : '←'}</span>
                      {rel.label}
                      {rel.count > 1 ? ` · ${rel.count}` : ''}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {children.length > 0 ? (
        <section className="pn-section">
          <Eyebrow faint>{`CHILDREN · ${children.length}`}</Eyebrow>
          <div className="pn-chiprow">
            {children.map((c) => (
              <Chip
                key={c.id}
                glyph={<KindIcon kind={c.kind} />}
                onClick={() => onOpenEntity?.(c.id)}
                title={peerTitle(c.kind, c.title)}
              >
                {c.title}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * "actor · verb · object — authorship never buried."
 *
 * The dot is coloured from the status ramp by event type, and one rule is
 * absolute here as everywhere: an `unknown` delivery is styled as a WARNING,
 * never as success.
 */
export function ActivityTab({ items }: { items: readonly ActivityItem[] }) {
  return (
    <div className="pn-body" id="tabpanel-activity" role="tabpanel" aria-labelledby="tab-activity">
      {items.length === 0 ? (
        <EmptyBody glyph="◫" sentence="No activity recorded on this entity yet." />
      ) : (
        <ul className="pn-activity">
          {items.map((item) => (
            <li className="pn-activity__row" key={item.id}>
              <span className={`pn-activity__dot pn-activity__dot--${verbTone(item.verb)}`} aria-hidden />
              {item.actor ? (
                <Avatar
                  actorId={item.actor.id}
                  provenance={item.actor.isAgent ? 'agent' : 'human'}
                  label={item.actor.displayName}
                  size={20}
                  src={item.actor.avatar ?? null}
                />
              ) : null}
              <span className="pn-activity__text">
                {`${item.actor?.displayName ?? 'someone'} ${humanizeVerb(item.verb)}`}
              </span>
              <span className="pn-activity__time">{relativeish(item.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Verb → ramp tone. Keyed on the VERB vocabulary, not on kind. `unknown`
 * anywhere in a delivery verb goes amber — the one mapping that is a rule
 * rather than a preference.
 */
function verbTone(verb: string): 'run' | 'wait' | 'info' | 'block' | 'idle' {
  if (verb.includes('unknown') || verb.includes('stale')) return 'wait';
  if (verb.includes('fail') || verb.includes('delete') || verb.includes('refus')) return 'block';
  if (verb.includes('complete') || verb.includes('deliver')) return 'run';
  if (verb.includes('link') || verb.includes('referenc')) return 'info';
  return 'idle';
}

function humanizeVerb(verb: string): string {
  return verb.replace(/[._]/g, ' ');
}

/**
 * Deliberately coarse: exact relative time needs a clock, and a clock in a
 * render path makes every test time-dependent. The date is shown plainly and
 * the precise timestamp rides on the element for anyone who needs it.
 */
function relativeish(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The clause the placeholder and the empty state both end with, built from
 * what is DECLARED rather than from what a designer once hoped would be here.
 * Returns `''` when neither sigil is live, so the invitation degrades to a
 * plain "reply below" instead of naming a key that does nothing.
 */
function sigilInvitation(
  mentionOptions: readonly TriggerOption[] | undefined,
  skillOptions: readonly TriggerOption[] | undefined,
): string {
  const parts = [
    mentionOptions ? '@ to mention' : null,
    skillOptions ? '/ to reference a skill' : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? '' : ` — ${parts.join(' · ')}`;
}

/**
 * THE DISCUSSION COMPOSER — the shared rich input, on the surface whose
 * placeholder was the defect.
 *
 * It read "Reply — @ to mention" over a bare single-line `<input>` with no
 * mention grammar behind it, beside an empty state that invited "press / and
 * mention someone". Both sigils are real now (`useRichInput`'s trigger
 * grammar), and both sentences are DERIVED from the declared options, so the
 * advertisement cannot come apart from the capability again.
 *
 * ATTACHMENTS ARE CHIPS, NOT CARET INSERTS (R4): this is a chat surface —
 * `attachmentIds` ride the message rather than being spliced into its body.
 * The remaining behaviour is what the Surface Audit built: Enter-or-click
 * submit, in-flight disable, clear-on-success, error held visibly, and no
 * dispatcher ⇒ disabled-with-reason rather than enabled-inert.
 */
function Composer({
  canPost,
  postDisabledReason,
  onPost,
  attach,
  mentionOptions,
  skillOptions,
}: {
  canPost?: boolean;
  postDisabledReason?: string;
  onPost?: (input: DiscussionPostInput) => Promise<void> | void;
  attach?: (file: File) => FileUploadTask;
  mentionOptions?: readonly TriggerOption[];
  skillOptions?: readonly TriggerOption[];
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentioned, setMentioned] = useState<readonly TriggerOption[]>([]);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const blocked = canPost === false || !onPost;
  const reason =
    canPost === false
      ? postDisabledReason
      : !onPost
        ? 'Posting isn’t connected in this surface yet — the composer is real; its dispatcher is not wired here.'
        : undefined;

  const rich = useRichInput({
    value: text,
    onChange: setText,
    areaRef: area,
    triggers: [
      {
        sigil: '@',
        options: mentionOptions,
        onSelect: (option) => {
          /* The id is recorded beside the text, not parsed back out of it:
             a display name is not a key, and two members may share one. */
          setMentioned((current) => current.some((item) => item.id === option.id)
            ? current
            : [...current, option]);
          return { insert: `@${option.display} ` };
        },
      },
      {
        sigil: '/',
        options: skillOptions,
        onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
      },
    ],
    attachments: {
      /* Withheld while the composer is blocked for the same reason Send is:
         an upload that lands against a surface which cannot post leaves a
         file attached to nothing the writer can send. */
      start: blocked ? undefined : attach,
      placement: { mode: 'chip' },
    },
    onKeyDown: (e) => {
      // Shift+Enter is the newline. The single-line `<input>` this replaced
      // had no such key, so nothing is taken away by honouring it.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
  });
  const attachments = rich.attachments!;

  const submit = async () => {
    const body = text.trim();
    if (!body || blocked || busy || !onPost || attachments.blocked) return;
    setBusy(true);
    setError(null);
    try {
      const attachmentIds = attachments.uploadedIds() as EntityId[];
      const mentionIds = [...new Set(mentioned.map((option) => option.id))] as EntityId[];
      await onPost({
        body,
        ...(mentionIds.length ? { mentionIds } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      setText('');
      setMentioned([]);
      // Forget the staged uploads WITHOUT cancelling them: their ids are
      // riding the message that was just posted.
      attachments.clear();
    } catch (e) {
      // The failure is the composer's fact — held HERE beside the text that
      // failed (T5-5's anti-toast law: a refusal never leaves the surface
      // that asked).
      setError(e instanceof Error ? e.message : 'The message was not posted.');
    } finally {
      setBusy(false);
    }
  };

  /* An upload still in flight is a THIRD reason Send is unavailable, and it
     is not the same as "not wired" — sending now would drop the file the
     writer is watching upload. */
  const sendReason = attachments.blocked
    ? 'One or more attachments are not ready — wait for uploads to finish, retry failures, or remove them before sending.'
    : reason;

  return (
    <div className="pn-composer">
      {error ? (
        <p className="pn-composer__error" role="alert">
          {error}
        </p>
      ) : null}
      <AttachmentChips attachments={attachments} testId="pn-composer-attachments" />
      {attach && !blocked ? (
        <ChooseFilesControl
          label="Attach a file"
          title="attach a file — or drop or paste one into the reply"
          className="pn-composer__attach"
          inputClassName="pn-composer__file"
          onChoose={attachments.addFiles}
        />
      ) : (
        <DisabledIconControl
          label="Attach a file"
          glyph="＋"
          reason={{
            cause: 'Attaching isn’t wired on this surface',
            remedy: blocked
              ? 'the composer cannot post here, so an upload would land against a message you could not send'
              : 'this panel was mounted without an attachment port',
          }}
        />
      )}
      <div className="ri-host">
        <textarea
          ref={area}
          className="pn-composer__input"
          rows={1}
          placeholder={`Reply${sigilInvitation(mentionOptions, skillOptions)}`}
          value={text}
          disabled={blocked || busy}
          title={reason}
          aria-label="Reply"
          {...rich.areaProps}
        />
        <TriggerPopover
          popover={rich.popover}
          label={rich.popover?.sigil === '/' ? 'Available skills' : 'People you can mention'}
          renderOption={(option) => (
            <>
              <span className="ri-popover__name">
                {`${rich.popover?.sigil ?? ''}${option.display}`}
              </span>
              {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
            </>
          )}
          emptyText={rich.popover?.sigil === '/' ? 'No matching skills' : 'No matching people'}
          testId="pn-composer-popover"
        />
      </div>
      <button
        type="button"
        className="pn-composer__send"
        aria-label="Send reply"
        disabled={blocked || busy || attachments.blocked || text.trim().length === 0}
        title={sendReason}
        onClick={() => void submit()}
      >
        {busy ? '…' : '↑'}
      </button>
    </div>
  );
}
