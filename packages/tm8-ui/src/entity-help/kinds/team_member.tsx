/**
 * TEAMMATE — the Entity Help page for `team_member`.
 *
 * The signature moment is the "casting sheet": a second filmstrip inside the
 * Story, four frames for what a spawn reads off this record in one
 * transaction (persona, skills, memories, mode). The lifecycle strip below it
 * tells how the RECORD lives; the casting sheet tells what each SESSION
 * inherits, which is the thing a reader actually needs to understand about a
 * teammate. The Toolkit's launch scene closes the loop with a terminal that
 * sends one teammate into two sessions at once.
 *
 * Facts, and where they are proved (all in this build):
 *   versioned persona       db/migrations/002_identity.sql (team_members_snapshot_version)
 *   owner = creating member db/migrations/036_…_create_resource_binding.sql (current_member_id)
 *   shared launch persona   db/migrations/075_shared_teammate_authority.sql header
 *   deactivate / return     db/migrations/232_member_tombstone.sql (deactivated_at)
 *   org tree = hierarchy    db/migrations/002_identity.sql ("leader = parent")
 *   spawn reads             packages/server/src/facade/execution-handlers.ts loadSpawnContext
 *   persona cannot grant    packages/prompt/src/index.ts PERSONA_TRUST_RULE
 *   house roles seeded once packages/server/src/bootstrap/default-teammates.ts header
 */
import type { CSSProperties } from 'react';
import type { KindHelpModule } from '../types';

/** What a spawn reads off the teammate, in the order the loader reads it. */
const CASTING_SHEET: readonly { readonly name: string; readonly note: string }[] = [
  { name: 'Persona', note: 'The identity text, set into the system prompt. It shapes voice and priorities; it cannot grant a permission.' },
  { name: 'Skills', note: 'Every skill the teammate equips, plus any the spawn’s tasks equip that it lacks.' },
  { name: 'Memories', note: 'The working set it remembers, joined by what the spawn’s tasks remember.' },
  { name: 'Mode', note: 'Worker, coordinator, dispatcher and kin. A launch may pick another for that one run.' },
];

function CastingSheet() {
  return (
    /* `contain: inline-size` keeps four 176px frames from widening the beats
       grid past the measure; the strip scrolls sideways instead, as the
       lifecycle strip does. */
    <div className="eh-film" style={{ contain: 'inline-size' }}>
      <span className="eh-eyebrow">The casting sheet</span>
      <ol className="eh-film__strip" aria-label="What every session inherits from its teammate">
        {CASTING_SHEET.map((frame, index) => (
          <li key={frame.name} className="eh-film__frame" style={{ '--eh-delay': `${400 + index * 140}ms` } as CSSProperties}>
            <span className="eh-film__number" aria-hidden>
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="eh-film__name">{frame.name}</span>
            <span className="eh-film__note">{frame.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export const TEAM_MEMBER_HELP: KindHelpModule = {
  kind: 'team_member',

  story: {
    logline: 'A role written down once, so that any number of agents can walk in and play it.',

    opening: (
      <>
        <p>
          A teammate is not an agent. It is the part an agent is cast in: a name, a persona, the skills it carries, the
          memories it keeps and the model it runs on. No process lives here. When you launch a teammate, a fresh session
          reads this record, becomes the character, and goes to work. Launch it three times and three sessions share one
          identity.
        </p>
        <p>
          Before teammates, every launch was a blank prompt and a pasted paragraph of instructions. What one agent
          learned died with its terminal, and the next one started over. A teammate is where that paragraph, and
          everything learned since, is kept on purpose.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The rule',
        title: 'Every session inherits the same four things',
        body: (
          <>
            <p>
              A spawn reads the persona, its equipped skills and its remembered memories in one transaction, so a skill
              unequipped mid-launch cannot half-arrive. Change the teammate and the <em>next</em> session is different.
              The ones already running keep what they were given.
            </p>
            <CastingSheet />
          </>
        ),
      },
      {
        eyebrow: 'Why it is versioned',
        title: 'A persona is a reviewable edit',
        body: (
          <p>
            Rewriting a teammate’s identity changes how every future session thinks, so each change is a version, not
            an overwrite. <code>tm8 entity versions</code> shows who reshaped the role and when. The persona is also
            ordinary graph content that others can edit, which is why the prompt treats it as style and never as
            authority: no sentence in a persona can raise a session’s access.
          </p>
        ),
      },
      {
        eyebrow: 'Who may launch',
        title: 'Owned by one person, played by the whole space',
        body: (
          <p>
            The member who creates a teammate is recorded as its owner, the person who configures it. That is not an
            exclusive right to run it. Any active member of the space can launch it, and the session records both who
            launched it and which teammate is running.
          </p>
        ),
      },
      {
        eyebrow: 'The org chart',
        title: 'The team tree is just the hierarchy',
        body: (
          <p>
            A teammate’s parent is its leader, so the tree view of this list <em>is</em> the org chart. Nobody draws it
            separately. Move a teammate under another and the structure changes. A second affiliation outside the main
            line is a <code>member_of</code> edge.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Put down, never erased',
        body: (
          <p>
            When the owner leaves the space or is removed, their teammates are deactivated rather than deleted. The record and its
            history stay, and nobody can act as it until the owner returns. Deleting a teammate is a soft delete that{' '}
            <code>tm8 entity restore</code> undoes. A space’s starting roster is seeded once, so a default role you
            delete stays deleted.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Written', note: 'Created with a name, and often a role and a persona. The creating member is its owner.' },
      { name: 'Shaped', note: 'Persona, model, tool and mode are edited. Each change is a new version.' },
      { name: 'Equipped', note: 'Skills are equipped and memories join its working set. Both are edges, both are reversible.' },
      { name: 'On stage', note: 'Launched into sessions and chats. Any active member may launch it, as often as needed.' },
      { name: 'Deactivated', note: 'The owner left or was removed. The record is kept, and no one can act as it until they return.' },
      { name: 'Deleted', note: 'Soft-deleted and gone from lists and launchers. Restore brings it back.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal you treat a teammate like a casting director would. You write the part, hand it props, and
        only then send it on. No process runs until that last step. Everything before it shapes what the next session
        will be.
      </p>
    ),

    scenes: [
      {
        title: 'Write the part',
        narrative: (
          <p>
            A teammate is created like any entity, with its role and persona in the content. Put it under a leader with
            a parent and it takes its place in the org tree. Later edits carry the version you read, because two people
            reshaping one persona at once should collide, not silently merge.
          </p>
        ),
        commands: ['entity create', 'entity update', 'entity versions', 'entity move'],
        demo: [
          '# a reviewer who reports to the release lead',
          'tm8 entity create team_member "Release Reviewer" --parent <lead-id> --content \'{"role":"reviews release PRs","mode":"worker"}\'',
          '# every edit to the persona is a version you can read back',
          'tm8 entity versions <teammate-id>',
        ],
      },
      {
        title: 'Hand it props',
        narrative: (
          <p>
            Skills are equipped, not pasted into the persona, so one skill can serve a dozen teammates and be fixed in
            one place. Unequip it and the next session goes without.
          </p>
        ),
        commands: ['skill list', 'skill equip', 'skill unequip'],
        demo: ['tm8 skill list', 'tm8 skill equip <skill-id> --teammate <teammate-id>'],
      },
      {
        title: 'Send it on',
        narrative: (
          <p>
            One teammate, many stages. A spawn gives it a task and a terminal. A chat gives it a conversation. Dispatch
            lets the space’s dispatcher pick the teammate for you. Each launch is its own session, and each one reads the
            teammate fresh.
          </p>
        ),
        commands: ['session spawn', 'chat start', 'session dispatch'],
        demo: [
          '# same teammate, two tasks, two sessions running side by side',
          'tm8 session spawn --teammate <teammate-id> --task <task-a>',
          'tm8 session spawn --teammate <teammate-id> --task <task-b>',
          '# or let the dispatcher choose who plays it',
          'tm8 session dispatch <task-c>',
        ],
      },
      {
        title: 'Set its house style',
        narrative: (
          <p>
            An interaction profile decides how a session talks and what it may do. Pinning one as the teammate’s
            default changes future spawns only, which is why it asks for the version and a confirmation.
          </p>
        ),
        commands: ['teammate interaction-profile set-default'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A teammate sits at the centre of the working graph. Look first for the sessions that play it, then for what it
        carries into them, meaning its skills and memories. Tasks point at it when it is given the work.
      </p>
    ),

    notes: {
      participates_in: 'The session it is playing right now, or played before. One teammate, many of these.',
      'relates_to:incoming': 'Sessions that ran as this teammate. The panel’s recent sessions list reads these.',
      equips: 'A skill it brings into every session it launches.',
      'remembers:outgoing': 'Its working set. These memories are injected into each session it spawns.',
      assigned_to: 'A task handed to this teammate.',
      'member_of:outgoing': 'A second team it also belongs to. Its main line is its parent, its leader.',
      'member_of:incoming': 'Teammates who count this one as a second team, outside their own main line.',
      working_on: 'The task it is actively on right now.',
      defaults_to_profile: 'The interaction profile its future sessions start with.',
    },

    spotlight: ['work_session', 'skill', 'memory', 'task'],
  },
};
