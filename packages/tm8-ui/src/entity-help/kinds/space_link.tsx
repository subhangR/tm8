/**
 * Entity Help — `space_link` (Wave 5).
 *
 * Fact-checked against db/migrations 250 (the kind, `space_links`), 251
 * (`space_link_tokens`, the spaceLinks.* RPCs, stale handling, the
 * command-owned lifecycle), 260 (spaceLinks.invoke's resolve + audit), 261
 * (remote forwarding ships disabled, so nothing here claims a remote link),
 * packages/cli/src/space-link-route.ts, SPACE_LINK_REFUSED in @tm8/contract
 * and the live catalog (`tm8 help space-link`, `tm8 help --operation
 * spaceLinks.invoke`).
 *
 * SIGNATURE MOMENT: "One flag, one door" types a single routed call and the
 * audit row it leaves at home, inside the Story reel. Under reduced motion the
 * terminal is whole from the first frame and reads as a block.
 */
import { TypedTerminal } from '../motion/TypedTerminal';
import type { KindHelpModule } from '../types';

export const SPACE_LINK_HELP: KindHelpModule = {
  kind: 'space_link',

  story: {
    logline: 'A door from this space into another one you belong to, that your agents may walk through as you.',

    opening: (
      <>
        <p>
          A space link is a card in your home space that points at a second space on this server. Everyone in the home
          space can see that the door exists. Behind it, each member keeps their own sealed sign-in for the other side,
          and only the agents that member launches may use it.
        </p>
        <p>
          Without it, an agent lives and dies inside the space it was spawned in. Work that spans two spaces meant a
          human copying things across by hand, or handing an agent a login it should never hold. The link lets the agent
          reach across while the key never leaves the server.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it is shared',
        title: 'One door, a key per member',
        body: (
          <p>
            There is one link per pair of spaces. The second member who links the same target joins the existing card
            instead of making another. What belongs to you is your own row on it: your alias, your sign-in status, your
            sealed session. Nobody else can read that row, not a space admin and not a node admin.
          </p>
        ),
      },
      {
        eyebrow: 'How it is born',
        title: 'A human opens it, then signs in',
        body: (
          <p>
            <code>tm8 link add</code> needs you to already be a member of the target, and it answers the same way for a
            space that does not exist and one you are not in, so it cannot be used to probe. The new row is{' '}
            <em>signed out</em>. <code>tm8 link login</code> mints a 90-day session in the target, seals it under the
            node key, and shows it on the target’s Sessions page where it can be revoked. Both are refused to agents: an
            agent asks its human.
          </p>
        ),
      },
      {
        eyebrow: 'One flag, one door',
        title: 'How an agent walks through',
        body: (
          <>
            <p>
              A session names the other space with <code>--space</code> and the CLI does the rest. Every call becomes
              one request to home, which checks it, forwards it as the launching member, and writes one audit row
              whatever the outcome. Nothing in the CLI calls the target directly, so there is no second path around the
              checks.
            </p>
            <TypedTerminal
              title="through the link"
              lines={[
                '# from a session in home; design is a link alias',
                'tm8 task list --space design',
                '# home forwards it as you, and keeps the receipt',
                'tm8 link audit design --limit 1',
              ]}
            />
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'What never crosses',
        body: (
          <p>
            Some things stay home no matter who asks. Credential management, link management, minting sessions, starting
            processes and handing out grants are refused on the home server before anything is forwarded. So are
            commands that open their own connection, like <code>tm8 event watch</code> or a file upload. The audit keeps
            the operation, the outcome and a reason, never the token or the request body.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Signed out, or closed on you',
        body: (
          <p>
            A link does not retry. A rejected session marks your row signed out; leaving the target marks it left.
            Either way the sealed bytes are forgotten, the session is revoked and the link asks for your attention. A
            target that does not answer marks it unreachable and asks too, keeping the session. Leaving the home space
            deletes your rows outright. The card itself cannot be deleted through the generic entity doors, so its
            tokens can never outlive it quietly.
          </p>
        ),
      },
    ],

    lifecycle: [
      {
        name: 'Added',
        note: 'The shared card exists, or you joined it. Your row is signed out.',
      },
      {
        name: 'Signed in',
        note: 'A sealed 90-day session in the target. Your agents may route through it.',
      },
      {
        name: 'Signed out',
        note: 'You logged out, or the target refused the session. Sign in again to reopen it.',
      },
      {
        name: 'Left',
        note: 'You are no longer in the target. The session is revoked and the key forgotten.',
      },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Two people use a link from a terminal. The human opens and signs in, because only a human session may. The agent
        reads, routes and reads the receipt. Every <code>tm8 link</code> verb takes an alias or a link id, and none of
        them ever returns a secret.
      </p>
    ),

    scenes: [
      {
        title: 'Open the door',
        narrative: (
          <p>
            <code>tm8 link add</code> takes the target space id and an optional alias, which is yours alone and is what
            you and your agents will type afterwards. Then <code>tm8 link login</code> with that alias stores your
            sealed session. Run it again after a sign-out; there is no silent refresh.
          </p>
        ),
        commands: ['link add', 'link login'],
        demo: ['# human session only', 'tm8 link add <target-space-id> --alias design', 'tm8 link login design'],
      },
      {
        title: 'See where you can go',
        narrative: (
          <p>
            <code>tm8 link list</code> is open to every member, agents included. It shows each link from this space with
            your own sign-in status on it. A target’s name only shows when you are a member of it, so the list never
            leaks a space you cannot see.
          </p>
        ),
        commands: ['link list'],
      },
      {
        title: 'Read the receipt',
        narrative: (
          <p>
            <code>tm8 link audit</code> reads the calls made through a link: your own rows, or every member’s if you are
            an admin of the home space. It pages backwards with a limit and a timestamp, and it is the first place to
            look when an agent says it did something in the other space.
          </p>
        ),
        commands: ['link audit'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A space link carries no typed edge of its own. Its real relations live off the graph, in the per-member rows
        behind it and in the audit it writes at home. On the map it takes the general links every entity can have, which
        is the right place to tie a link to the task or the doc that explains why two spaces talk.
      </p>
    ),

    notes: {
      relates_to: 'Tie the link to the work that needs it, so a reader can see why the door was opened.',
    },

    spotlight: ['task', 'doc'],
  },
};
