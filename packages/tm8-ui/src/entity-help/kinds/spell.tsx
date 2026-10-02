/**
 * SPELL — Entity Help, wave 5.
 *
 * Fact-checked against db/migrations/001_core_graph.sql (`public.spells`:
 * name, description, rule jsonb object; `equips` task|team_member|work_session
 * → spell|skill), 017 (`create_spell_entity`), 007 (`entities.commands.pull`:
 * one `pulled` edge per puller, pinnedVersion ≤ current, re-pull moves the
 * pin), server/skills/mutations.ts (`skills.equip` refuses anything that is not
 * a skill), server/skills/equipment.ts (launch equipment reads SKILLS only) and
 * the entity read/projector (`equipped` = any inbound `equips` edge). No code
 * in server, execution or prompt reads a spell's rule. The page says so in the
 * present tense and promises nothing further.
 *
 * SIGNATURE MOMENT: the unlit sigil. Three `equips` threads and one `pulled`
 * thread draw themselves in toward the spell, and the sigil at the centre stays
 * unlit inside a dashed ring. Everything a spell is today, bound and pinned
 * and not cast, in one picture. Reduced motion shows the finished drawing.
 */
import type { CSSProperties } from 'react';
import type { KindHelpModule } from '../types';

interface Thread {
  readonly from: string;
  readonly edge: string;
  readonly x: number;
  readonly y: number;
}

const CX = 170;
const CY = 104;

const THREADS: readonly Thread[] = [
  { from: 'teammate', edge: 'equips', x: 34, y: 34 },
  { from: 'task', edge: 'equips', x: 34, y: 104 },
  { from: 'session', edge: 'equips', x: 34, y: 174 },
  { from: 'you', edge: 'pulled · v3', x: 306, y: 104 },
];

const mono: CSSProperties = { fontFamily: 'var(--pn-mono)', fontSize: 9, letterSpacing: '0.04em' };

function wire(index: number, hot: boolean): CSSProperties {
  return {
    fill: 'none',
    stroke: hot ? 'var(--eh-brass)' : 'var(--eh-ink-3)',
    strokeWidth: 1.1,
    strokeDasharray: 100,
    strokeDashoffset: 0,
    animation: 'eh-wire-in 1100ms var(--eh-ease) both',
    animationDelay: `${240 + index * 260}ms`,
  };
}

function arrive(delay: number): CSSProperties {
  return { animation: 'eh-reveal 700ms var(--eh-ease) both', animationDelay: `${delay}ms` };
}

/** The unlit sigil: a spell bound three ways, pinned once, and not cast. */
function Sigil() {
  return (
    <figure style={{ margin: 'var(--pn-space-4) 0 0' }} data-testid="spell-sigil">
      <svg
        viewBox="0 0 340 212"
        role="img"
        aria-label="A spell at the centre. A teammate, a task and a session each point at it with an equips edge; you point at it with a pulled edge pinned at version 3. The spell itself stays unlit: nothing casts it."
        style={{
          display: 'block',
          width: '100%',
          maxWidth: 520,
          margin: '0 auto',
          borderRadius: 'var(--pn-r-md)',
          border: '1px solid var(--eh-line)',
          background: 'var(--eh-card)',
        }}
      >
        {THREADS.map((t, i) => {
          const left = t.x < CX;
          const endX = left ? CX - 40 : CX + 40;
          const midX = (t.x + endX) / 2;
          const d = `M ${t.x + (left ? 26 : -26)} ${t.y} C ${midX} ${t.y}, ${midX} ${CY}, ${endX} ${CY}`;
          /* Labels sit on the far side of each pill from the wires, so no thread crosses one. */
          const labelY = t.from === 'session' ? t.y + 25 : t.y - 16;
          return (
            <g key={t.from}>
              <path d={d} pathLength={100} style={wire(i, t.edge === 'equips')} />
              <g style={arrive(120 + i * 260)}>
                <rect
                  x={t.x - 26}
                  y={t.y - 11}
                  width={52}
                  height={22}
                  rx={11}
                  style={{ fill: 'var(--eh-surface)', stroke: 'var(--eh-line)' }}
                />
                <text x={t.x} y={t.y + 3.2} textAnchor="middle" style={{ ...mono, fill: 'var(--eh-ink)' }}>
                  {t.from}
                </text>
                <text
                  x={t.x}
                  y={labelY}
                  textAnchor="middle"
                  style={{ ...mono, fill: t.edge === 'equips' ? 'var(--eh-brass)' : 'var(--eh-ink-2)' }}
                >
                  {t.edge}
                </text>
              </g>
            </g>
          );
        })}
        <g style={arrive(40)}>
          <circle
            cx={CX}
            cy={CY}
            r={38}
            style={{ fill: 'none', stroke: 'var(--eh-ink-3)', strokeDasharray: '2 4', strokeWidth: 1 }}
          />
          <circle cx={CX} cy={CY} r={27} style={{ fill: 'var(--eh-surface)', stroke: 'var(--eh-line)' }} />
          <text
            x={CX}
            y={CY + 8}
            textAnchor="middle"
            style={{ fontFamily: 'var(--pn-serif)', fontSize: 24, fill: 'var(--eh-ink-3)' }}
          >
            ✧
          </text>
          <text x={CX} y={CY + 56} textAnchor="middle" style={{ ...mono, fill: 'var(--eh-ink-2)' }}>
            rule · stored as written
          </text>
        </g>
      </svg>
      <figcaption className="eh-eyebrow" style={{ display: 'block', marginTop: 'var(--pn-space-2)', textAlign: 'center' }}>
        bound three ways · pinned once · not cast
      </figcaption>
    </figure>
  );
}

export const SPELL_HELP: KindHelpModule = {
  kind: 'spell',

  story: {
    logline: 'A spell is a standing rule with a name, kept in the graph where teammates, tasks and sessions can take it up.',

    opening: (
      <>
        <p>
          A spell is a small definition: a name, a description in plain words, and a <em>rule</em>, a JSON object whose
          shape is yours to decide. It lives in the space like any other entity, versioned and addressable. A teammate,
          a task or a work session can equip it; a person or a teammate can pull it and pin the version they adopted.
        </p>
        <p>
          It exists because a team&rsquo;s standing rules (review the green build before merging, never hand-edit the
          production schema) deserve better than a paragraph buried in one persona. A spell makes the rule a thing: one
          place to write it, one id to point at, one version history to argue over.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The honest part',
        title: 'Bound, pinned, never cast',
        body: (
          <>
            <p>
              In this build nothing executes a spell. No hook fires it, a session&rsquo;s launch equipment does not
              read it, and the rule is carried exactly as written. What a spell gives you is the record: who equips
              it, who pinned which version, what changed between versions. Read it as a declared intent that the graph
              keeps in plain sight.
            </p>
            <Sigil />
          </>
        ),
      },
      {
        eyebrow: 'Not a skill',
        title: 'Its neighbour on the shelf works differently',
        body: (
          <p>
            A skill is a file on disk that tm8 indexes and hands to an agent at spawn, and <code>tm8 skill equip</code>{' '}
            is its verb. That verb refuses a spell. A spell is born in the graph with no file behind it, so you equip it
            by writing the <code>equips</code> edge yourself.
          </p>
        ),
      },
      {
        eyebrow: 'The glow',
        title: 'Equipped is one edge away',
        body: (
          <p>
            The ✧ chip on the Spells list glows when anything equips the spell and goes idle when nothing does. One
            inbound <code>equips</code> edge is enough to light it. The panel&rsquo;s EQUIPPED BY block is where you see
            who.
          </p>
        ),
      },
      {
        eyebrow: 'Pinning',
        title: 'Pull holds a version still',
        body: (
          <p>
            <code>tm8 entity pull</code> records that you adopted the spell at a named version, as a{' '}
            <code>pulled</code> edge carrying the pin. Pull again and that same edge moves to the new pin. Later edits to
            the spell leave your pin where it is, so a team can see who is still on version 3.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Written', note: 'A title is enough. The description starts empty and the rule starts as {}.' },
      { name: 'Revised', note: 'Each edit is a new version. The history is the argument, kept.' },
      { name: 'Equipped', note: 'A teammate, task or session points equips at it. The chip lights.' },
      { name: 'Pinned', note: 'Pulled at a version. The pin stays put while the spell moves on.' },
      { name: 'Deleted', note: 'Soft-deleted and restorable. The rule reads as empty while it is gone.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Spells have no noun of their own, and they need none. Their whole life runs on generic verbs: create and update
        for the words, <code>edge create</code> for equipping, <code>entity pull</code> for pinning, and the reads for
        finding out who holds what.
      </p>
    ),

    scenes: [
      {
        title: 'Write the rule',
        narrative: (
          <p>
            The title is the name. <code>description</code> and <code>rule</code> ride in the content; the rule must be
            a JSON object, and past that its shape is yours. Every later edit carries the version you read.
          </p>
        ),
        commands: ['entity create', 'entity update'],
        demo: [
          '# the rule is an object whose shape you choose',
          'tm8 entity create spell "Review the green build" --content @spell.json',
          '# spell.json: {"description": "…", "rule": {…}}',
        ],
      },
      {
        title: 'Equip it',
        narrative: (
          <p>
            Equipping is an edge from the one taking it up to the spell. Teammates, tasks and work sessions can all
            hold one. To unequip, find that edge and delete it.
          </p>
        ),
        commands: ['edge create', 'edge list', 'edge delete'],
        demo: [
          'tm8 edge create <teammate-id> equips <spell-id>',
          'tm8 edge create <task-id> equips <spell-id>',
          '# who holds it now',
          'tm8 edge list --target <spell-id> --type equips',
        ],
      },
      {
        title: 'Pin a version',
        narrative: (
          <p>
            Pull names a version that exists: the current one or any earlier one. The version list shows what changed
            between the pin you hold and the spell as it stands.
          </p>
        ),
        commands: ['entity pull', 'entity versions'],
        demo: ['tm8 entity pull <spell-id> --pinned-version 3', 'tm8 entity versions <spell-id>'],
      },
      {
        title: 'Open the spellbook',
        narrative: <p>Every spell in the space, as one filtered read.</p>,
        commands: ['entity query'],
        demo: ['tm8 entity query --kind spell'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A spell sits at the end of arrows. Teammates, tasks and sessions reach it through <code>equips</code>; people and
        teammates reach it through <code>pulled</code>. The one arrow of its own is <code>attached_to</code>, which pins
        the spell as context onto something else.
      </p>
    ),
    notes: {
      equips: 'A teammate, task or session takes the spell up. Written with edge create; skill equip refuses spells.',
      pulled: 'A person or teammate adopted it at a pinned version. One edge per puller; pulling again moves the pin.',
      'attached_to:outgoing': 'The spell pinned as context onto another entity.',
    },
    spotlight: ['team_member', 'task', 'work_session', 'member'],
  },
};
