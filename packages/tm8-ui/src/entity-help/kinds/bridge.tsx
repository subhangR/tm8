/**
 * Entity Help — `bridge` (BRIDGE-ENTITY-DESIGN §4.7).
 *
 * Fact-checked against db/migrations 395 (the kind, `bridges`, the outbox,
 * participants and handles, the human-only doors), packages/contract
 * `bridges.ts`, packages/cli `commands/bridge.ts` and the design's §2 (model),
 * §2.7 (workers on the bridge, D21/D23) and §6 (what never crosses).
 *
 * SIGNATURE MOMENT: "How agents answer" types a `tm8 bridge log` read and a
 * `tm8 message reply` that lands in the group signed with the session's handle.
 */
import { TypedTerminal } from '../motion/TypedTerminal';
import type { KindHelpModule } from '../types';

export const BRIDGE_HELP: KindHelpModule = {
  kind: 'bridge',

  story: {
    logline: 'A conversation from another network, living here as a first-class thing you can read, answer and manage.',

    opening: (
      <>
        <p>
          A bridge binds one conversation somewhere else (a WhatsApp group, a Slack channel, a DM) to one chat, work
          session or channel in this space. Messages from the group arrive here with the sender's name. Answers from
          here go back, signed with whoever wrote them.
        </p>
        <p>
          Before bridges, that wiring lived in a config file on one machine, outside the graph. Nobody in the space
          could see which group went where, pause it, or tell who was speaking. A bridge is an entity, so all of that is
          on screen and every change leaves a version.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why one per conversation',
        title: 'One group, one bridge, one target',
        body: (
          <p>
            Each bridge is one conversation, and one account reads and replies for it in a space. A second member
            connecting the same group from their own number is refused with who already connected it. A chat carries
            at most one bridge, so it is always clear which group a chat is talking to.
          </p>
        ),
      },
      {
        eyebrow: 'How it is born',
        title: 'A human, in Settings',
        body: (
          <p>
            A bridge is created, moved and removed by a person at a keyboard: the number's owner, in Settings → Bridges.
            Agents are refused those doors. They can read the bridge and speak on it, but they cannot open one, point it
            somewhere else, or remove it.
          </p>
        ),
      },
      {
        eyebrow: 'Who is speaking',
        title: 'Linked, asserted, or a guest',
        body: (
          <p>
            Someone who sent <code>/link</code> from their own phone is <em>linked</em>: their messages count as them,
            in every space. An admin can also say "this number is Rahul", which shows as <em>asserted</em>, never as
            verified. Everyone else is a guest. Guests are logged and named, but by default they cannot start agents.
          </p>
        ),
      },
      {
        eyebrow: 'How agents answer',
        title: 'Read the room, reply by handle',
        body: (
          <>
            <p>
              The bridge's chat answers <code>@tm8</code>. Any session in the space may also read the group and reply,
              and its words cross signed with its title and handle. A worker is woken only when someone addresses it.
            </p>
            <TypedTerminal
              title="on the bridge"
              lines={[
                '# what was said while I was busy',
                'tm8 bridge log <bridge-id> --unread',
                '# answer the question, quoting it in the group',
                'tm8 message reply <message-id> "1.4.2 is live since 10:30."',
              ]}
            />
          </>
        ),
      },
      {
        eyebrow: 'What never crosses',
        title: 'Approvals and secrets stay here',
        body: (
          <p>
            An approval, a credential or a pairing code is never posted into the group. When an agent working for the
            group needs permission, the request goes to a person in tm8. No read of a bridge returns the account's
            session, a token or a QR code.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Paused, or removed',
        body: (
          <p>
            Pausing keeps logging and stops everything else: nobody is answered and nothing is sent. Removing stops
            reading and writing the group, leaves the logged messages here read-only, and never touches the group
            itself. Workers started from it keep running; they just cannot post there any more.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Live', note: 'Messages flow both ways, as the routing says.' },
      { name: 'Degraded', note: 'The account or the runtime is not answering. The reason is on Health.' },
      { name: 'Paused', note: 'Messages are logged. Nobody is answered and nothing is sent.' },
      { name: 'Removed', note: 'A read-only record. The group is untouched.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Every <code>tm8 bridge</code> verb is one operation on the server. Status and health are worked out there and
        the CLI only prints them. Speaking needs no bridge verb: <code>tm8 message reply</code> and{' '}
        <code>tm8 message send</code> cross.
      </p>
    ),

    scenes: [
      {
        title: 'See what is bridged',
        narrative: (
          <p>
            <code>tm8 bridge list</code> shows every bridge in the space with its target and status.{' '}
            <code>tm8 bridge show</code> adds the policy, health and who has been posting.
          </p>
        ),
        commands: ['bridge list', 'bridge show'],
      },
      {
        title: 'Read the room',
        narrative: (
          <p>
            <code>tm8 bridge log</code> reads the conversation oldest first. With <code>--unread</code>, it reads from
            your session's own cursor and moves it, so the next read starts where this one stopped.
          </p>
        ),
        commands: ['bridge log'],
      },
      {
        title: 'Change how it behaves',
        narrative: (
          <p>
            <code>tm8 bridge update</code> takes the version you read and only the fields you change. Pause and resume
            take the version too. Retarget and remove are for a human.
          </p>
        ),
        commands: ['bridge update', 'bridge pause', 'bridge resume'],
        demo: ['tm8 bridge update <bridge-id> --trigger mention --expect-version 7'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A bridge points at its target with <code>bridged_to</code>. Everything an agent makes because of the group
        points back at it with <code>authored_from</code>, so you can ask what came out of a group. The bridge's
        memories hang off it with <code>remembers</code>.
      </p>
    ),

    notes: {
      remembers: 'The memories every agent working for this group carries.',
    },

    spotlight: ['chat', 'memory'],
  },
};
