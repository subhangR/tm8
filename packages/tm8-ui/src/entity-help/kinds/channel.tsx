/**
 * CHANNEL — Entity Help, wave 4.
 *
 * Facts this page leans on, and where they are true:
 *   name/topic only, no status  domain/registry.ts (channel row, editFields)
 *   name grammar, unique/space  db/migrations/001_core_graph.sql (public.channels)
 *   roots in the feed           db/migrations/097_channel_threads_feed_scope.sql
 *   has_member, not an ACL      db/migrations/080_channel_members.sql
 *   default-channel guard       db/migrations/029_w2_menu_default_channel.sql
 *   topic rides content.topic   server …/w2/entities-commands-tracking.ts
 *
 * THE SIGNATURE is `ChannelRoom`: a channel drawn as it reads — thread roots
 * arriving one after another like a room talking, one root carrying a reply
 * count, and its branch opening in a thread pane beside it. Built from Reveal
 * only, with `--pn-*` tokens inline, so under reduced motion it is
 * the same picture with nothing moving: every message, the count and the pane
 * are present on first paint.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Reveal } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

/* ── The signature: a channel, read as thread roots ────────────────────── */

interface RoomLine {
  readonly who: string;
  /** A teammate (agent) rather than a person — drawn with a diamond. */
  readonly agent?: boolean;
  readonly text: string;
  readonly replies?: number;
}

const ROOTS: readonly RoomLine[] = [
  { who: 'rhea', text: 'Moving the release cut to Thursday. Objections here, please.' },
  { who: 'build-agent', agent: true, text: 'Nightly is red on the migrations suite.', replies: 3 },
  { who: 'jon', text: 'Pinned the rollout checklist to this channel.' },
];

const BRANCH: readonly RoomLine[] = [
  { who: 'rhea', text: 'The feed-scope test again?' },
  { who: 'build-agent', agent: true, text: 'Yes. Re-running once the fix lands.' },
  { who: 'jon', text: 'Fixed on main. Green.' },
];

const S = {
  room: {
    margin: 'var(--pn-space-4) 0 0',
    border: '1px solid var(--pn-line-2)',
    borderRadius: 'var(--pn-r-md)',
    background: 'var(--pn-card)',
    overflow: 'hidden',
  },
  bar: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 'var(--pn-space-3)',
    padding: 'var(--pn-space-2) var(--pn-space-4)',
    borderBottom: '1px solid var(--pn-line)',
    background: 'var(--pn-surface)',
  },
  name: { fontFamily: 'var(--pn-mono)', color: 'var(--pn-ink)', fontWeight: 600 },
  topic: { color: 'var(--pn-ink-3)', fontSize: 'var(--pn-fs-sm)' },
  split: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)' },
  column: { padding: 'var(--pn-space-3) var(--pn-space-4)', display: 'grid', gap: 'var(--pn-space-3)' },
  pane: {
    padding: 'var(--pn-space-3) var(--pn-space-4)',
    borderLeft: '1px solid var(--pn-line)',
    background: 'rgba(var(--pn-brand-rgb), 0.06)',
  },
  line: { display: 'grid', gap: 2 },
  who: { fontFamily: 'var(--pn-mono)', fontSize: 'var(--pn-fs-fine)', color: 'var(--pn-ink-2)' },
  text: { color: 'var(--pn-ink)', fontSize: 'var(--pn-fs-sm)', lineHeight: 'var(--pn-lh-snug)' },
  focused: {
    marginLeft: 'calc(-1 * var(--pn-space-2))',
    paddingLeft: 'calc(var(--pn-space-2) - 2px)',
    borderLeft: '2px solid var(--pn-brand)',
  },
  count: {
    justifySelf: 'start',
    marginTop: 2,
    fontFamily: 'var(--pn-mono)',
    fontSize: 'var(--pn-fs-fine)',
    color: 'var(--pn-brand)',
    border: '1px solid rgba(var(--pn-brand-rgb), 0.4)',
    borderRadius: 'var(--pn-r-pill)',
    padding: '0 var(--pn-space-2)',
  },
  branch: { display: 'grid', gap: 'var(--pn-space-3)', marginTop: 'var(--pn-space-3)' },
  caption: {
    padding: 'var(--pn-space-2) var(--pn-space-4)',
    borderTop: '1px solid var(--pn-line)',
    color: 'var(--pn-ink-3)',
    fontSize: 'var(--pn-fs-fine)',
  },
} satisfies Record<string, CSSProperties>;

function Line({ line, focused }: { line: RoomLine; focused?: boolean }) {
  return (
    <div style={focused ? { ...S.line, ...S.focused } : S.line}>
      <span style={S.who}>
        {line.agent ? '◆ ' : ''}
        {line.who}
      </span>
      <span style={S.text}>{line.text}</span>
      {line.replies ? <span style={S.count}>↳ {line.replies} replies</span> : null}
    </div>
  );
}

/** Beats reveal from ~220ms; the room starts talking once its beat is in. */
const ROOM_START = 760;
const ROOM_STEP = 260;

function ChannelRoom(): ReactNode {
  const branchStart = ROOM_START + ROOTS.length * ROOM_STEP + 200;
  return (
    <figure style={S.room} data-testid="channel-room" aria-label="A channel read as thread roots, with one thread open beside it">
      <div style={S.bar}>
        <span style={S.name}># release-train</span>
        <span style={S.topic}>Cut, soak, ship</span>
      </div>
      <div style={S.split}>
        <div style={S.column}>
          {ROOTS.map((line, index) => (
            <Reveal key={line.text} delay={ROOM_START + index * ROOM_STEP}>
              <Line line={line} focused={Boolean(line.replies)} />
            </Reveal>
          ))}
        </div>
        <Reveal delay={branchStart - 120}>
          <div style={S.pane} aria-label="Thread">
            <span className="eh-eyebrow">Thread</span>
            <div style={{ ...S.text, color: 'var(--pn-ink-3)', marginTop: 'var(--pn-space-1)' }}>
              {ROOTS[1]?.text}
            </div>
            <div style={S.branch}>
              {BRANCH.map((line, index) => (
                <Reveal key={line.text} delay={branchStart + index * ROOM_STEP}>
                  <Line line={line} />
                </Reveal>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
      <figcaption style={S.caption}>
        The channel shows roots. The replies are stored and readable like any other message. They live in their
        thread.
      </figcaption>
    </figure>
  );
}

/* ── The module ────────────────────────────────────────────────────────── */

export const CHANNEL_HELP: KindHelpModule = {
  kind: 'channel',

  story: {
    logline: 'The room where the space talks out loud, and where the talk stays.',

    opening: (
      <>
        <p>
          A channel is a named room in a space: <code>#release-train</code>, <code>#design-review</code>. It has a
          lowercase name that no other channel in the space can take, an optional topic, and a feed. People and
          agents post into it with the same verb they use to message anything else, and what they say is kept.
        </p>
        <p>
          Without one, talk has to hang on whatever it is about: a task’s discussion, a session’s inbox. That
          works until the conversation is about no single thing. A release, a design argument or an incident runs
          across a dozen tasks. The channel gives that kind of talk a place of its own.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it exists',
        title: 'An anchor with nothing else on it',
        body: (
          <p>
            Every message lands on an anchor. On a task, the talk sits beside the work: status, assignee, criteria.
            A channel is the anchor that is <em>only</em> conversation. It has a name and a topic and deliberately
            nothing else: no status to move, nobody assigned, nothing to tick. That absence is why the channel is the
            right place for talk that should outlive any one piece of work.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Roots in the room, branches in the thread',
        body: (
          <>
            <p>
              A channel reads as <strong>thread roots</strong>. A reply does not land in the timeline as a peer of
              the message it answers. It hangs under its root, and the root opens its branch in a thread pane. The
              room stays readable at five hundred messages.
            </p>
            <p>
              Nothing is hidden. A reply is stored, visible and reachable with <code>tm8 message list --root</code>.
              Other anchors keep their replies inline on purpose: a task’s discussion reads flat, and a channel reads
              in threads.
            </p>
            <ChannelRoom />
          </>
        ),
      },
      {
        eyebrow: 'Who is in it',
        title: 'A roster, not a lock',
        body: (
          <p>
            Membership is a <code>has_member</code> edge from the channel to a person or a teammate. Agents belong to
            a room the way people do. A member can be seated when the channel is created, or later with the same
            picker that assigns a task. The edge answers <em>who is in this room</em>, never <em>who may read it</em>.
            Its owner-or-member role is advisory, a label and not a permission.
          </p>
        ),
      },
      {
        eyebrow: 'How it nests and ends',
        title: 'Subchannels, and the one you cannot delete',
        body: (
          <p>
            A channel can hold channels. Adding a child from an open channel creates a subchannel beneath it, and the
            list draws the nesting as a tree. Deleting a channel is a soft delete that <code>tm8 entity restore</code>{' '}
            undoes. One channel is protected: the space’s <strong>default channel</strong>, the one the space opens
            into. It refuses to be deleted until the space is pointed at a successor, or at no feed at all.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Named', note: 'A lowercase name, unique in the space. The topic may start empty.' },
      { name: 'Gathered', note: 'has_member edges seat people and teammates. Nobody is locked out.' },
      { name: 'Talking', note: 'Messages land as roots. Replies branch into threads.' },
      { name: 'Default', note: 'Optionally the room the space opens into, and then it cannot be deleted.' },
      { name: 'Deleted', note: 'Soft-deleted with its history. entity restore brings it back.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal a channel is an anchor id. You create it like any entity, seat members with an edge, and
        then almost everything is <code>tm8 message</code>. You send to the channel, reply into a thread and page a
        branch by its root. Keep the channel id close. It is the <code>--to</code> of every conversation you have
        there.
      </p>
    ),

    scenes: [
      {
        title: 'Open a room',
        narrative: (
          <p>
            A channel is born with its name as the title and its topic in the content. Members can be seated in the
            same call with <code>--connect has_member=</code>, which writes the edge inside the create. Later
            arrivals get the same edge with <code>tm8 edge create</code>. A double add is a no-op, because the edge
            is unique per pair.
          </p>
        ),
        commands: ['entity create', 'edge create'],
        demo: [
          '# name it, give it a topic, seat the first member',
          'tm8 entity create channel release-train --content \'{"topic":"Cut, soak, ship"}\' --connect has_member=<member-id>',
          '# a teammate joins later',
          'tm8 edge create <channel-id> has_member <team-member-id>',
        ],
      },
      {
        title: 'Talk, then branch',
        narrative: (
          <p>
            A message with no parent is a root and shows in the room. A message sent with <code>--reply-to</code>{' '}
            joins that root’s thread. To read a branch, page it by its root. Always pass <code>--limit</code>,
            because a busy channel is long.
          </p>
        ),
        commands: ['message send', 'message list'],
        demo: [
          'tm8 message send --to <channel-id> "Nightly is red on the migrations suite."',
          'tm8 message send --to <channel-id> --reply-to <message-id> "Fixed on main. Green."',
          'tm8 message list <channel-id> --root <message-id> --limit 20',
        ],
      },
      {
        title: 'Answer where you were asked',
        narrative: (
          <p>
            When a message was delivered to your session, <code>tm8 message reply</code> answers it by id. The
            server derives the anchor and the parent from the delivered message, so the answer lands in the right
            room and the right thread without you naming either. To follow a room as it happens, watch its events.
          </p>
        ),
        commands: ['message reply', 'event watch'],
        demo: [
          '# reply to the message your session received',
          'tm8 message reply <message-id> "On it. Re-running now."',
          'tm8 event watch --entity <channel-id>',
        ],
      },
      {
        title: 'Choose the front door',
        narrative: (
          <p>
            A space opens into one channel. Setting it is a space setting, not a channel edit, so its guard is the
            space’s settings revision (<code>--expect-revision</code>) and not an entity version. Pointing it at{' '}
            <code>none</code> is how you free the old default for deletion.
          </p>
        ),
        commands: ['space default-channel set'],
        demo: [
          'tm8 space default-channel set <channel-id> --expect-revision <n>',
          '# or open into no feed at all',
          'tm8 space default-channel set none --expect-revision <n>',
        ],
      },
    ],

    commands: ['entity create', 'edge create', 'edge list', 'entity restore', 'event watch'],
  },

  constellation: {
    intro: (
      <p>
        A channel sits at the middle of people and talk. Its own outgoing edge is <code>has_member</code>, the
        roster. Everything else points in: messages hang on it, docs and files are attached to it, and people pull
        and star it. Look for the <code>has_member</code> edges first. They tell you who is in the room.
      </p>
    ),
    notes: {
      has_member: 'The roster: a person or teammate seated in this room. Role is advisory, and it grants no access.',
      anchored_to: 'Every message in the room hangs here, roots and thread replies alike.',
      attached_to: 'Context pinned to the channel. These attachments become the hub’s tabs and pinned shelf.',
      pulled: 'Someone adopted this channel into their own local view.',
      stars: 'A person bookmarked the room.',
      relates_to: 'The general link, for a room that concerns something no sharper edge names.',
    },
    spotlight: ['message', 'team_member', 'member', 'doc'],
  },
};
