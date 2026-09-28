/**
 * Entity Help — `credential` (Wave 5).
 *
 * Fact-checked against db/migrations 206 (space_credentials), 239 (the
 * credential kind, ownership, visibility, member_defaults), 271 (typesafe),
 * 272 (readiness), 273 (session_credential_binding, `runs_on`) and the live
 * catalog (`tm8 help credential`, `tm8 help session spawn`).
 *
 * SIGNATURE MOMENT: "The ladder" beat draws the auto-pick order as a second
 * filmstrip, one rung per frame, in the order credentials.space.myDefault.set
 * states it. It reuses the theme's `eh-film` classes (the guide allows a
 * second strip) and reads identically when nothing moves.
 */
import type { KindHelpModule } from '../types';

const LADDER: readonly { readonly name: string; readonly note: string }[] = [
  {
    name: 'My default',
    note: 'A credential you own and marked as yours for this provider, in this space.',
  },
  {
    name: 'Member key',
    note: 'The legacy key on your own account, from before space credentials.',
  },
  {
    name: 'Space default',
    note: 'The one public credential the space runs on when nobody says otherwise.',
  },
  {
    name: 'Node',
    note: 'The server’s own login, the last rung, when the space policy allows it.',
  },
];

function Ladder() {
  return (
    <div className="eh-film" data-testid="credential-ladder">
      <span className="eh-eyebrow">Auto, top to bottom</span>
      <ol className="eh-film__strip" aria-label="The order a launch picks a credential in">
        {LADDER.map((rung, index) => (
          <li key={rung.name} className="eh-film__frame" style={{ ['--eh-delay' as string]: `${index * 140}ms` }}>
            <span className="eh-film__number" aria-hidden>
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="eh-film__name">{rung.name}</span>
            <span className="eh-film__note">{rung.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export const CREDENTIAL_HELP: KindHelpModule = {
  kind: 'credential',

  story: {
    logline: 'The key a session is let in with, shown to the whole space and handed to nobody.',

    opening: (
      <>
        <p>
          A credential is a card in your space that stands for one vendor login or key: a Claude or Codex sign-in, an
          Anthropic or OpenAI API key, a GitHub token, a server-side service key. You see its name, its provider, who
          owns it and whether it is healthy. You never see the secret. That stays sealed under the node key in a side
          table the card cannot reach.
        </p>
        <p>
          Before credentials were entities, every agent quietly ran on whatever login the server happened to hold.
          Nobody could say whose account paid for a session, or stop one person’s key from serving everyone. The card
          makes the answer visible: every session now points at the credential it ran on.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it is a card',
        title: 'Visible to the space, sealed from it',
        body: (
          <p>
            The card is all the graph carries: title, provider, shape, visibility, status and owner. The key hint and
            the vendor login are masked by visibility, and the key itself is never echoed back, not even to its owner.
            The vendor is asked first, so a key it refuses is never stored at all.
          </p>
        ),
      },
      {
        eyebrow: 'Who holds it',
        title: 'Yours, or the space’s',
        body: (
          <p>
            A credential is either <strong>owned</strong> by a member or <strong>space-owned</strong>. An owned one can
            be private, and then only its owner’s launches may use it. Turning a credential private is not a soft
            request: it clears its default flags and kills every live session its owner did not launch. A space-owned
            one is always public.
          </p>
        ),
      },
      {
        eyebrow: 'The ladder',
        title: 'How a launch picks one',
        body: (
          <>
            <p>
              Launch on <em>auto</em> and tm8 walks down four rungs and stops at the first that answers. A space admin
              can switch a whole source off per provider, and <code>tm8 session spawn</code> can skip the walk and pin
              one credential outright. A child session with no instruction inherits its spawner’s exact credential.
            </p>
            <Ladder />
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Stale fails loudly',
        body: (
          <p>
            When the vendor stops accepting a credential it turns <strong>stale</strong>, and a stale credential is
            never used. The launch fails and names it, rather than slipping onto somebody else’s identity. That is the
            whole point of the kind: the honest answer at the moment you are least likely to notice.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Revoked, with its sessions',
        body: (
          <p>
            Deleting a credential revokes the row first, forgets its sealed bytes, then kills every live session and
            login terminal on it, whoever launched them. The card cannot be moved, deleted or restored through the
            generic entity doors; its life belongs to the credential commands. Re-keying is gentler: live sessions keep
            the old key and the next spawn gets the new one.
          </p>
        ),
      },
    ],

    lifecycle: [
      {
        name: 'Pending',
        note: 'A vendor login has started in a short-lived terminal. Only logins wait here.',
      },
      {
        name: 'Active',
        note: 'The vendor accepted it. Launches can run on it and the readiness read counts it.',
      },
      {
        name: 'Stale',
        note: 'The vendor refused it. Never used, never counted; the fix is a fresh login or key.',
      },
      {
        name: 'Revoked',
        note: 'Deleted. The secret is gone and every session on it has been killed.',
      },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal you mostly <em>use</em> credentials rather than manage them. Every write that touches a secret,
        its owner or its visibility is human-only by design and lives in Settings, never in an agent’s hands. What the
        CLI gives you is the read that says whether a launch would work, and the switch that says what a launch runs on.
      </p>
    ),

    scenes: [
      {
        title: 'Will it launch?',
        narrative: (
          <p>
            <code>tm8 space credential-readiness get</code> answers two questions apart, never as one tick.{' '}
            <strong>Can launch</strong> is per provider and counts your own default. <strong>Can poll</strong> needs a
            space-owned public GitHub credential, because background readers never borrow a member’s private one. Only
            active credentials count; a stale one is reported as the reason. It is a human session’s read, like every
            credential operation.
          </p>
        ),
        commands: ['space credential-readiness get'],
        demo: ['# green to launch can still mean dead tracking', 'tm8 space credential-readiness get'],
      },
      {
        title: 'Choose what it runs on',
        narrative: (
          <p>
            <code>tm8 session spawn</code> carries the choice in <code>--credential-source</code>, once per provider.{' '}
            <code>space</code> means the space default, <code>space:</code> followed by an id pins one card, and{' '}
            <code>member</code> or <code>node</code> name the other rungs. Leave it out and a child inherits exactly
            what its spawner ran on, which is usually what you want inside a team.
          </p>
        ),
        commands: ['session spawn'],
        demo: [
          '# pin one card for the anthropic side of this run',
          'tm8 session spawn --teammate <team-member-id> --credential-source anthropic=space:<credential-id>',
        ],
      },
      {
        title: 'Read the card',
        narrative: (
          <p>
            The card is an entity like any other, so <code>tm8 entity context</code> shows its title, provider, status
            and owner, and its connections name the sessions that point at it. It will not show the key, the hint or the
            login: those columns are not in the card at all.
          </p>
        ),
        commands: ['entity context'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A credential sits at the end of one edge that matters: <strong>runs_on</strong>, drawn from a work session to
        the card it ran on. The edge is written by the database itself, from the same row that records the binding, so
        it cannot be forged or forgotten. Follow it backwards from a card to see every session that has spent its key.
      </p>
    ),

    notes: {
      runs_on:
        'This session ran on this credential. Written only by the binding trigger, one edge per provider the session used.',
      'runs_on:incoming':
        'A session that ran on this card. Written only by the binding trigger, one edge per provider the session used.',
    },

    spotlight: ['work_session'],
  },
};
