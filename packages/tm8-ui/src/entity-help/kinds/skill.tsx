/**
 * SKILL — Entity Help, wave 2.
 *
 * Facts are the server's: a skill is a reference to a SKILL.md on disk
 * (`server/src/skills`), its body read from the file on each detail read,
 * equipped through `equips`, resolved per spawn by
 * `execution/src/spawn/effective-skills.ts`. The signature moment is the
 * second filmstrip in "Who gets it first": the load order a spawn walks.
 */
import { Fragment } from 'react';
import type { KindHelpModule } from '../types';
import { Stagger } from '../motion/Reveal';

/** The load order a spawn walks: nearest ask first. */
const LOAD_ORDER = [
  { name: 'The task', note: 'A skill equipped on the task being run. The most specific ask, so it wins a name clash.' },
  { name: 'The teammate', note: 'What the persona carries into every session it runs.' },
  { name: 'Its parents', note: 'Inherited from teammates above it, nearest parent first.' },
] as const;

export const SKILL_HELP: KindHelpModule = {
  kind: 'skill',

  story: {
    logline: 'A know-how file on disk that the right agent finds at the right moment, without anyone pasting it in.',

    opening: (
      <>
        <p>
          A skill is a <code>SKILL.md</code> file: a name, a line on when to use it, and a body of instructions. It lives
          where agents already look for it, under a project&rsquo;s <code>.claude/skills</code> or{' '}
          <code>.agents/skills</code>, or in a home directory. tm8 does not keep the body. It keeps a reference to the
          file, so the file stays the one source of truth.
        </p>
        <p>
          Before skills, the way to teach an agent a procedure was to paste it into the prompt, again, every session. A
          skill is written once, equipped to the teammates who need it, and handed to each session they run.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why a reference',
        title: 'The file stays the truth',
        body: (
          <p>
            A scan stores a skill&rsquo;s name, description, frontmatter and content hash, but never its body.{' '}
            <code>tm8 skill show</code> reads the body from disk each time, and flags the skill when the file no longer
            matches the hash it last saw. So an edit in your editor and an edit through tm8 land in the same file. When
            they disagree, <code>tm8 skill edit</code> refuses to overwrite and tells you to reload first.
          </p>
        ),
      },
      {
        eyebrow: 'How one is born',
        title: 'Found, not filed',
        body: (
          <p>
            Most skills are not created in tm8 at all. They are found. A scan walks the project roots linked to the
            space and the configured home directories, and every <code>SKILL.md</code> it finds becomes a reference,
            one per space per file path. Spawns run a scan before loading context, so a file added this morning is
            there for this afternoon&rsquo;s run. <code>tm8 skill create</code> writes a new file first, then scans it
            in, the same as any other.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Who gets it first',
        body: (
          <>
            <p>
              Equipping draws an <code>equips</code> edge. Nothing loads until a session starts. Then the spawn
              collects every equipped skill in this order. When two share a name, the nearer one wins. Two at the same
              distance stop the spawn until you rename one.
            </p>
            <section className="eh-film" aria-label="Skill load order">
              <span className="eh-eyebrow">Load order</span>
              <Stagger as="ol" itemAs="li" className="eh-film__strip" itemClassName="eh-film__frame" step={140} start={120}>
                {LOAD_ORDER.map((stage, index) => (
                  <Fragment key={stage.name}>
                    <span className="eh-film__number" aria-hidden>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="eh-film__name">{stage.name}</span>
                    <span className="eh-film__note">{stage.note}</span>
                  </Fragment>
                ))}
              </Stagger>
            </section>
          </>
        ),
      },
      {
        eyebrow: 'At launch',
        title: 'Native, indexed or skipped',
        body: (
          <p>
            Each equipped skill then gets one of three verdicts. <strong>Native</strong> means the agent&rsquo;s own
            harness would load the file from where it sits, so the session gets the harness&rsquo;s own pointer, such as{' '}
            <code>/name</code> in Claude Code. <strong>Indexed</strong> means it would not, so the skill appears in the
            session&rsquo;s context index with a path to read. <strong>Skipped</strong> means it cannot be used: its
            file is missing, or it is disabled for that tool. The launch preview shows the verdict for every equipped
            skill before you start.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'A missing file is not a lost skill',
        body: (
          <p>
            Delete or move the file and the next scan marks the reference missing. It keeps its identity and every
            teammate that equips it, and spawns skip it with the reason <code>missing</code>. Put the file back at the
            same path and the next scan clears the mark on the same entity, with the equipment still attached.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Discovered', note: 'A scan found the file and recorded its metadata and hash, but not its body.' },
      { name: 'Equipped', note: 'A teammate or task points at it with an equips edge. Nothing loads yet.' },
      { name: 'Loaded', note: 'A spawn hands it to the session, natively or through the context index.' },
      { name: 'Changed on disk', note: 'The file no longer matches its hash. Edits wait until you reload.' },
      { name: 'Missing', note: 'The file is gone. The reference keeps its id and its equips; spawns skip it.' },
      { name: 'Found again', note: 'A later scan sees the path and clears the mark on the same entity.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal, work a skill in two layers. The file is the content: create it, edit it and read it through the
        skill commands, which write the real <code>SKILL.md</code>. The graph is the reach: scan to bring files in and
        equip to decide who carries them. An edit carries both the entity version and the file hash, so a stale write
        fails instead of landing.
      </p>
    ),
    scenes: [
      {
        title: 'Bring the files in',
        narrative: (
          <p>
            A scan is how the space learns what is on disk. Name one linked project, or scan every authorized root. A
            manual scan always rescans, even inside the 30 seconds when a recent scan would otherwise be reused. Then
            list what came in.
          </p>
        ),
        commands: ['skill scan', 'skill list'],
        demo: [
          '# a teammate just merged a new SKILL.md',
          'tm8 skill scan --root <project-id>',
          'tm8 skill list --limit 20',
        ],
      },
      {
        title: 'Write one',
        narrative: (
          <p>
            <code>skill create</code> writes the file under the project&rsquo;s <code>.agents</code> or{' '}
            <code>.claude</code> directory and scans it in. <code>skill edit</code> rewrites it in place, keeping
            frontmatter keys it does not recognise. It carries the entity version and the file hash, and it refuses to
            touch plugin, system, admin, synced or session skills, which belong to their installer.
          </p>
        ),
        commands: ['skill create', 'skill edit', 'skill show'],
        demo: [
          '# write the file, then read it back from disk',
          'tm8 skill create --root <project-id> --name release-notes --description "Draft notes from merged PRs"',
          'tm8 skill show <skill-id>',
          'tm8 skill edit <skill-id> --expected-version <version> --body @notes.md',
        ],
      },
      {
        title: 'Hand it to a teammate',
        narrative: (
          <p>
            Equip a teammate and every session it runs from then on carries the skill. The skill and the teammate must
            share a space. Unequip removes the edge and leaves the file alone. To check what a session will actually
            get, open its context from the entity side.
          </p>
        ),
        commands: ['skill equip', 'skill unequip', 'entity context'],
        demo: [
          'tm8 skill equip <skill-id> --teammate <teammate-id>',
          '# the next session this teammate runs carries it',
          'tm8 entity context <skill-id>',
          'tm8 skill unequip <skill-id> --teammate <teammate-id>',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A skill sits at the end of other kinds&rsquo; edges. It rarely points outward. Look first at the incoming{' '}
        <code>equips</code> edges: they are who will be handed this skill, and they decide in what order.
      </p>
    ),
    notes: {
      'equips:incoming':
        'Who carries it. A teammate passes it to every session it runs and to teammates below it; a task passes it to the run that works it.',
      'attached_to:outgoing': 'Pinned as context on another entity, for a reader, not a loader.',
      contains: 'A collection that gathers it with related skills.',
    },
    spotlight: ['team_member', 'task', 'collection'],
  },
};
