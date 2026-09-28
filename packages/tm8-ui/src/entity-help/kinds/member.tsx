/**
 * MEMBER — the Entity Help page for a human's membership of a space (wave 3).
 *
 * Every claim below is read off this build:
 *   roles, invites      db/migrations/118_member_roles_and_invite_roles.sql
 *   the owner floor,
 *   the tombstone and
 *   coming back         db/migrations/232_member_tombstone.sql
 *   the public door     db/migrations/248_member_tombstone_restore_join_and_enter.sql
 *   the first owner     db/migrations/015_w1_foundations.sql (create_space)
 *   relations           domain/edge-kinds.ts
 *
 * The signature moment is THE LADDER: a second filmstrip, inside its beat,
 * that climbs member → admin → owner with what each rung may do.
 */
import type { CSSProperties } from 'react';
import type { KindHelpModule } from '../types';

interface Rung {
  readonly role: string;
  readonly may: string;
}

const LADDER: readonly Rung[] = [
  { role: 'Member', may: 'Works the space: tasks, channels, reactions. The role every invite gives by default.' },
  { role: 'Admin', may: 'Mints and revokes invites, moves people between member and admin, removes members.' },
  { role: 'Owner', may: 'Everything an admin may, plus the one power nobody else has: granting or revoking owner.' },
];

function RoleLadder() {
  return (
    <ol className="eh-film__strip" aria-label="Roles in a space, lowest to highest">
      {LADDER.map((rung, index) => (
        <li key={rung.role} className="eh-film__frame" style={{ ['--eh-delay' as string]: `${index * 160}ms` } as CSSProperties}>
          <span className="eh-film__number" aria-hidden>
            RUNG {String(index + 1).padStart(2, '0')}
          </span>
          <span className="eh-film__name">{rung.role}</span>
          <span className="eh-film__note">{rung.may}</span>
        </li>
      ))}
    </ol>
  );
}

export const MEMBER_HELP: KindHelpModule = {
  kind: 'member',

  story: {
    logline: 'Your seat in one space, kept for you even after you walk out.',

    opening: (
      <>
        <p>
          A member is a person inside a space. Your account belongs to you; your membership belongs to the space, and
          there is exactly one of them for each space you are in. It carries your role, your points and the tasks you
          finished, and every message and edit you make there is attributed to it.
        </p>
        <p>
          Before members could end, the only way out was a hand-written delete, and the database refused it the moment
          someone had used the space. Their name was tied to too much history to cut. So a membership was redesigned to
          close without ever being erased.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it exists',
        title: 'People, not agents',
        body: (
          <p>
            Members are the humans. The agents that work beside them are teammates, a separate kind, and each teammate
            is owned by a member. Some acts are reserved for people: only a member can <em>like</em>, <em>star</em> or{' '}
            <em>dislike</em> something, so a reaction always means somebody felt it.
          </p>
        ),
      },
      {
        eyebrow: 'The ladder',
        title: 'Three rungs, and the top one is handed over',
        body: (
          <>
            <p>
              Whoever creates a space is its first member and its first owner. Everyone after them arrives on an invite,
              and an invite can confer admin or member, never owner. Ownership is handed over by another owner, not
              handed out at the door.
            </p>
            <RoleLadder />
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Never fewer than one owner',
        body: (
          <p>
            Demoting, removing and leaving all lock the space&apos;s owners before they touch anyone, then count. If
            the change would leave no owner, it is refused, however the requests interleave. The last owner who wants
            out promotes a successor first.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'A tombstone, not a hole',
        body: (
          <>
            <p>
              A membership ends as <strong>left</strong>, when you go, or <strong>removed</strong>, when an admin sends
              you. Nothing is deleted. What you wrote still renders under your name, marked as no longer a member.
            </p>
            <p>
              The same transaction closes every door you held: tokens pinned to the space are revoked, your agent
              sessions there stop, your teammates are deactivated and your task assignments are cleared, each one noted
              on its task.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'Coming back',
        title: 'The same seat, not a new one',
        body: (
          <p>
            A new invite brings back the very same member, with the same id, so your history rejoins you and your
            teammates wake up. The role is whatever the new invite grants. Someone who left may also walk back into a
            public space. Someone who was removed may not: for them, only an admin&apos;s invite opens the door.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Invited', note: 'An admin mints a code for admin or member. One use unless they say otherwise.' },
      { name: 'Active', note: 'The code is redeemed; the member exists and the space records that they joined.' },
      { name: 'Promoted', note: 'Admins move people between member and admin. Only an owner touches owner.' },
      { name: 'Left or removed', note: 'Access ends in one transaction. The row and everything it wrote stay.' },
      { name: 'Back', note: 'A later invite reactivates the same member, history and teammates intact.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Members are not made with a create command. They are let in, moved and let go, and every verb that changes one
        lives under <code>tm8 space</code>. The ones that end or reshape a membership ask for <code>--yes</code> before they
        act, because each one changes what a person can reach.
      </p>
    ),

    scenes: [
      {
        title: 'Read the room',
        narrative: (
          <p>
            Start with who is here and in which role. The member list is the roster of humans; the leaderboard ranks
            members and teammates together by the points they have earned.
          </p>
        ),
        commands: ['space member list', 'space leaderboard get'],
        demo: ['# the humans, with their roles', 'tm8 space member list', '# members and teammates, by points', 'tm8 space leaderboard get --limit 5'],
      },
      {
        title: 'Open the door',
        narrative: (
          <p>
            An admin mints the code and chooses the rung it lands on. The person receiving it can read what it opens
            before committing, then redeem it. An outstanding code can be listed, and revoked before its uses run out.
          </p>
        ),
        commands: ['space invite create', 'space invite list', 'space invite revoke', 'space invite resolve', 'space invite redeem'],
        demo: [
          '# an admin, minting a one-use member invite',
          'tm8 space invite create --role member',
          '# the invitee, reading it and then joining',
          'tm8 space invite resolve <code>',
          'tm8 space invite redeem <code>',
        ],
      },
      {
        title: 'Move a rung',
        narrative: (
          <p>
            A role change takes the member id from the list. Admins move people between member and admin; only an
            owner can make or unmake another owner, and the space refuses to lose its last one.
          </p>
        ),
        commands: ['space member role'],
        demo: ['# make a member an admin', 'tm8 space member role <member-id> --role admin --yes'],
      },
      {
        title: 'Show the way out',
        narrative: (
          <p>
            Removing someone else and leaving yourself are two commands with one effect: the membership is kept as a
            tombstone, and everything it could reach is closed at once.
          </p>
        ),
        commands: ['space member remove', 'space leave'],
        demo: ['# an admin ends another membership', 'tm8 space member remove <member-id> --yes', '# or you end your own', 'tm8 space leave --yes'],
      },
    ],

    commands: ['space leaderboard get', 'space invite revoke', 'space invite resolve', 'space invite redeem'],
  },

  constellation: {
    intro: (
      <p>
        A member mostly sits at the receiving end: tasks are assigned to them and channels list them. The lines that
        start from a member are the personal ones, the work they have picked up and the reactions only a human can
        leave.
      </p>
    ),

    notes: {
      assigned_to: 'Who a task is for. Cleared, with a note on the task, when the member leaves or is removed.',
      working_on: 'What the member has picked up right now.',
      completed_by: 'Who finished a task.',
      has_member: 'A channel’s roster. It says who belongs there, not who may read it.',
      likes: 'A reaction. Only members can leave one, never an agent.',
      stars: 'A bookmark a person keeps.',
      dislikes: 'A reaction. Only members can leave one, never an agent.',
      controls: 'Input access to a container, granted by whoever created it.',
    },

    spotlight: ['task', 'channel', 'container'],
  },
};
