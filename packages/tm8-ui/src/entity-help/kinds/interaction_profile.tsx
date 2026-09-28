/**
 * INTERACTION PROFILE — the Entity Help page (wave 4).
 *
 * Facts are read from `db/migrations/027_w2_entity_kinds_profiles.sql`
 * (propose / update / validate / activate / retire, the launch resolver and
 * the pin recorder), `015_w1_foundations.sql` (the append-only pin guard) and
 * the contract's `InteractionProfile*` schemas.
 *
 * The signature moment is the RESOLUTION LADDER inside the "pin" beat: the
 * four places a launch looks for a profile, in the resolver's own order,
 * arriving rung by rung, then the seal the session keeps. Under reduced
 * motion the ladder is simply all there: the order is carried by the list
 * numbering and the words, never by the timing.
 */
import type { CSSProperties } from 'react';
import { Reveal } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

const RUNGS: readonly { readonly source: string; readonly title: string; readonly note: string }[] = [
  {
    source: 'spawn_override',
    title: 'The launch names one',
    note: 'A human space admin passes an active profile to this one spawn. Nothing else is asked.',
  },
  {
    source: 'teammate_default',
    title: 'The teammate has a default',
    note: 'The teammate the session runs as points at a profile it always starts in.',
  },
  {
    source: 'space_default',
    title: 'The space has a default',
    note: "The space's own default, for any launch that reached this rung.",
  },
  {
    source: 'core_default',
    title: 'The core frame',
    note: 'No profile at all: the shipped core template, which always resolves.',
  },
];

const LADDER_START = 120;
const LADDER_STEP = 180;

const ladder: CSSProperties = {
  listStyle: 'none',
  margin: 'var(--pn-space-5) 0 0',
  padding: 0,
  display: 'grid',
  gap: 'var(--pn-space-2)',
};

const rung: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 'var(--pn-space-3)',
  alignItems: 'baseline',
  padding: 'var(--pn-space-3) var(--pn-space-4)',
  border: '1px solid var(--pn-line-2)',
  borderRadius: 'var(--pn-r-sm)',
  background: 'var(--pn-card)',
};

const rungNumber: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-micro)',
  color: 'var(--pn-ink-3)',
};

const rungSource: CSSProperties = {
  display: 'block',
  marginTop: 'var(--pn-space-2)',
};

const seal: CSSProperties = {
  marginTop: 'var(--pn-space-4)',
  padding: 'var(--pn-space-3) var(--pn-space-4)',
  borderLeft: '2px solid var(--pn-brand)',
  background: 'var(--pn-brand-soft)',
  borderRadius: 'var(--pn-r-xs)',
};

/** The signature moment: four rungs in resolver order, then the seal. */
function ResolutionLadder() {
  const sealAt = LADDER_START + RUNGS.length * LADDER_STEP + 240;
  return (
    <div role="group" aria-label="How a launch picks its profile">
      <ol style={ladder}>
        {RUNGS.map((step, index) => (
          <Reveal key={step.source} as="li" delay={LADDER_START + index * LADDER_STEP}>
            <div style={rung}>
              <span style={rungNumber} aria-hidden="true">
                0{index + 1}
              </span>
              <span>
                <strong>{step.title}.</strong> {step.note}
                <code style={rungSource}>{step.source}</code>
              </span>
            </div>
          </Reveal>
        ))}
      </ol>
      <Reveal delay={sealAt}>
        <p style={seal}>
          <span className="eh-eyebrow">Sealed</span>
          <br />
          The first rung that holds an <strong>active</strong> profile wins, and its exact version is hashed into a{' '}
          <code>sha256:</code> pin on the session. A default that is no longer active is skipped, so the ladder
          always reaches the ground.
        </p>
      </Reveal>
    </div>
  );
}

export const INTERACTION_PROFILE_HELP: KindHelpModule = {
  kind: 'interaction_profile',

  story: {
    logline: 'The house rules a session is born under, sealed at launch so they cannot shift mid-conversation.',

    opening: (
      <>
        <p>
          An interaction profile is the frame around an agent session: how large its prompt may grow, which help
          it preloads, how its chat feed pages, what the composer is allowed to send. You rarely look at one. You
          feel it in every session that starts under it.
        </p>
        <p>
          Without one, every session gets the shipped core frame. A profile lets a space say &ldquo;our agents
          start leaner&rdquo; without a code change, as a versioned thing you propose, check, switch on and point
          at. And because each session records a pin of the exact version it got, you can always say which rules
          a running session was given.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it has its own door',
        title: 'Generic create refuses it',
        body: (
          <p>
            You cannot make one with <code>tm8 entity create</code>, and generic edits cannot move, hide or delete
            it. A profile shapes what every agent it touches is told, so its whole life runs through its own named
            commands, and every change after the first carries a version guard. Anyone can still read it, react
            to it and link it. Only the lifecycle is fenced.
          </p>
        ),
      },
      {
        eyebrow: 'Who writes it',
        title: 'Agents may propose, humans switch on',
        body: (
          <p>
            A space owner or admin can propose a profile, and so can a teammate. A teammate may keep editing only
            the drafts it proposed, and the record remembers which teammate that was. Activation and every default
            are human-only: an agent token is refused at the door, so no agent can rewrite the rules it will next
            be launched under.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Only a validated hash can go live',
        body: (
          <p>
            Every edit appends a new draft version. <code>tm8 interaction-profile validate</code> checks the
            current draft, including against the shipped chat template, and when it passes records a hash of
            exactly what was checked. Activation takes that version and that hash together and refuses any mismatch. Editing
            the draft afterwards leaves the active version untouched until someone validates and activates again.
          </p>
        ),
      },
      {
        eyebrow: 'The pin',
        title: 'Resolved once, held for life',
        body: (
          <>
            <p>
              A session does not follow its profile around. At launch the server walks a ladder, takes the first
              active profile it finds, and records an immutable pin. Pins are append-only: a change appends a new
              revision instead of rewriting the old one. Change the default tomorrow and today&rsquo;s sessions keep
              the rules they started with.
            </p>
            <ResolutionLadder />
          </>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Retired, never erased',
        body: (
          <p>
            Retirement is refused while a teammate or the space still defaults to the profile, so you unhook it
            first. Once retired it can no longer be edited, activated or launched. The pins of every session that
            ran under it still name it by id and version, so the record of what those sessions were told survives.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Draft', note: 'Proposed by an admin or a teammate. Every edit appends a version.' },
      { name: 'Validated', note: 'The current draft checked against the template; its hash recorded.' },
      { name: 'Active', note: 'A human switched on that exact version and hash. Launchable, and eligible as a default.' },
      { name: 'Retired', note: 'Unhooked from every default. Old pins still name it.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal, a profile is a short relay between two kinds of caller. An agent can draft, revise and
        validate. A human reads the preview, flips it on, and decides who starts under it. Every step carries a
        version or a hash, so nobody activates something they did not look at.
      </p>
    ),

    scenes: [
      {
        title: 'Draft and prove it',
        narrative: (
          <p>
            Propose with the full policy document, revise against the version you last saw, then validate. The
            validation answer is the receipt: a status, any issues by path, and the hash that activation will ask
            for.
          </p>
        ),
        commands: ['interaction-profile propose', 'interaction-profile update', 'interaction-profile validate'],
        demo: [
          '# an agent may take a profile this far on its own',
          'tm8 interaction-profile propose --data @lean.json',
          'tm8 interaction-profile update <id> --expect-version 1 --data @lean.json',
          'tm8 interaction-profile validate <id> --expect-version 2',
        ],
      },
      {
        title: 'Look, then switch on',
        narrative: (
          <p>
            <code>tm8 interaction-profile preview</code> is a plain read of one version as a session would see
            it. Activation then names that validated version and its hash, and asks for an explicit yes. It is the
            human step, and it sets no default by itself.
          </p>
        ),
        commands: ['interaction-profile preview', 'interaction-profile activate'],
        demo: [
          'tm8 interaction-profile preview <id> --version 2',
          '# a human, with the hash from validate',
          'tm8 interaction-profile activate <id> --validated-version 2 --validation-hash sha256:… --yes',
        ],
      },
      {
        title: 'Choose who starts under it',
        narrative: (
          <p>
            Defaults are the rungs of the launch ladder. Point a teammate at the profile, or the whole space, or
            hand it to a single spawn. Passing <code>none</code> clears a default and lets launches fall through
            to the next rung.
          </p>
        ),
        commands: [
          'teammate interaction-profile set-default',
          'space interaction-profile set-default',
          'session spawn',
        ],
        demo: [
          'tm8 teammate interaction-profile set-default <teammate-id> <id> --expect-version 4 --yes',
          'tm8 space interaction-profile set-default <id> --expect-settings-revision 7 --yes',
          '# or for one launch only',
          'tm8 session spawn --teammate <teammate-id> --interaction-profile <id>',
        ],
      },
      {
        title: 'Retire it',
        narrative: (
          <p>
            Clear the defaults that still point at it, then retire under a version guard. Sessions already
            running are untouched: their pins were sealed at launch.
          </p>
        ),
        commands: ['interaction-profile retire'],
        demo: [
          'tm8 space interaction-profile set-default none --expect-settings-revision 8 --yes',
          'tm8 interaction-profile retire <id> --expect-version 6 --yes',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A profile sits between the people who choose it and the sessions that run under it. Two edges matter.
        One points in from a teammate that starts in it by default. The other points in from every session whose
        launch resolved to it. Neither is drawn by hand: each is written by the command that owns it.
      </p>
    ),

    notes: {
      defaults_to_profile:
        'The teammate starts in this profile unless a launch overrides it. Written only by the teammate set-default command; retirement is refused while one exists.',
      selected_profile:
        'The session was launched under this profile. Written by the pin recorder at launch and never edited after.',
      relates_to: 'A plain link, for notes or tasks about the profile. It changes nothing at launch.',
    },

    spotlight: ['work_session', 'team_member'],
  },
};
