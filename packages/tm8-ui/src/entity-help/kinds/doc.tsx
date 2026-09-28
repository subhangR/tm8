/**
 * DOC — Entity Help, wave 2.
 *
 * The signature moment is the index card in the second beat: a doc reaches a
 * later agent as one listing line before anyone opens it, so the beat builds
 * that line field by field (title, when-to-use, summary, load pointer) with
 * `Stagger`. Under reduced motion the card is simply there, whole, in the
 * same order — the order is the meaning, not the movement.
 *
 * Facts are this build's: the `documents` table (001_core_graph), the header
 * resolver and its staleness rule (server/src/headers), the `<context_index>`
 * serializer (@tm8/prompt), and the catalog notes on `entity create`,
 * `entity update` and `entity header set`.
 */
import { Stagger } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

/* The card borrows the filmstrip frame's surface and line tokens, with a brass
   rule down its spine; nothing here is a colour of its own. */
const CARD = {
  margin: 'var(--pn-space-4) 0',
  padding: 'var(--pn-space-4) var(--pn-space-5)',
  background: 'var(--eh-card)',
  border: '1px solid var(--eh-line)',
  borderLeft: '3px solid var(--eh-brass)',
  borderRadius: 'var(--pn-r-sm)',
} as const;
/* Stagger wraps each dt/dd pair in the one div a <dl> allows. */
const VALUE = { margin: '2px 0 var(--pn-space-3)' } as const;

function IndexCard() {
  return (
    <figure style={CARD} aria-label="How a doc first reaches a later agent">
      <span className="eh-eyebrow">What the next session sees</span>
      <Stagger as="dl" step={260} start={420} className="eh-prose">
        <>
          <dt className="eh-eyebrow">Title</dt>
          <dd style={VALUE}>
            <strong>Balance rounding policy</strong>
          </dd>
        </>
        <>
          <dt className="eh-eyebrow">When to use · shown whole, never cut</dt>
          <dd style={VALUE}>
            <em>Open when changing how balances are rounded.</em>
          </dd>
        </>
        <>
          <dt className="eh-eyebrow">Summary · the first thing a tight prompt drops</dt>
          <dd style={VALUE}>Half-even at the ledger, half-up on invoices, and why the two differ.</dd>
        </>
        <>
          <dt className="eh-eyebrow">Load pointer · only now does the body arrive</dt>
          <dd style={VALUE}>
            <code>tm8 entity context &lt;doc-id&gt;</code>
          </dd>
        </>
      </Stagger>
    </figure>
  );
}

export const DOC_HELP: KindHelpModule = {
  kind: 'doc',

  story: {
    logline: 'The page a stranger opens months later, and the one line that tells them to.',

    opening: (
      <>
        <p>
          A doc is long-form writing that lives in the Space beside the work it explains: a design, a runbook, a
          decision and its reasons. You write it in markdown, it nests under other docs, and the reader who opens it may be a
          person or an agent launched next week.
        </p>
        <p>
          Without a doc, knowledge lives in chat scrollback and in the head of whichever session happened to learn it.
          The next session starts cold. A doc is the place that learning is written down once, and the header on it
          is how the next reader finds it without reading everything else first.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it exists',
        title: 'Written once, read by strangers',
        body: (
          <p>
            The reader you are writing for is rarely in the room. It is an agent a coordinator spawns on Thursday, or a
            teammate who inherits your task. That is why New doc offers the header in the same step as the title: a doc
            is what a launch most often reads, and a doc nobody knows to open is a doc nobody reads.
          </p>
        ),
      },
      {
        eyebrow: 'The first line',
        title: 'Read before it is opened',
        body: (
          <>
            <p>
              When a doc is selected into a session&apos;s launch, the agent does not get the body. It gets a card, and
              decides from the card alone whether to spend the tokens.
            </p>
            <IndexCard />
            <p>
              So write the when-to-use as a situation, not a label. <em>Open when changing how balances are rounded</em>{' '}
              routes a reader. <em>Rounding doc</em> only repeats the title. Leave the header blank and the server
              derives a summary from your first paragraph and your headings, which is why a good first paragraph pays
              twice.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'No blind overwrites',
        body: (
          <p>
            Every edit carries the version it was made against. If someone else saved in between, yours is refused with
            a version conflict instead of silently erasing theirs. You re-read, merge, and save again. Nothing is lost
            to a race, and <code>tm8 entity versions</code> pages the history of what changed.
          </p>
        ),
      },
      {
        eyebrow: 'Honesty',
        title: 'A header that knows when it is out of date',
        body: (
          <p>
            The header is pinned to the version of the doc it was written for. Edit the doc and the header is marked
            stale, and every later agent sees that mark beside it. Rewrite the header, or re-save it unchanged to say it
            still holds, and it is pinned to the current version again. Writing a header never moves the doc&apos;s own
            version, so fixing the card never collides with someone editing the page.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Drafted', note: 'A title and a body, markdown by default, up to 200,000 characters.' },
      { name: 'Headed', note: 'A when-to-use and a summary, or a summary derived from the opening.' },
      { name: 'Revised', note: 'Each save carries its version. The header now reads stale.' },
      { name: 'Marked current', note: 'The header is re-saved and pinned to the new version.' },
      { name: 'Deleted', note: 'Soft. Restore brings it back.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal a doc is an entity like any other: the generic <code>entity</code> family creates it, reads it
        and edits it. What is particular is the order. You orient with a bounded context read, you edit with the
        version in hand, and you treat the header as part of the writing rather than something to add later.
      </p>
    ),

    scenes: [
      {
        title: 'Born with its routing line',
        narrative: (
          <p>
            Create the doc and its header in one call. The content is a small JSON body naming the format; the
            when-to-use says when a later session should open it. If you only learn the right line afterwards,{' '}
            <code>entity header set</code> writes the whole header again.
          </p>
        ),
        commands: ['entity create', 'entity header set'],
        demo: [
          '# the body and the reason to read it, in one write',
          'tm8 entity create doc "Rounding policy" --content @body.json --when-to-use "Open when changing rounding"',
          '# a sharper line later replaces the whole header',
          'tm8 entity header set <doc-id> --when-to-use "Open when changing rounding" --summary "Ledger vs invoices"',
        ],
      },
      {
        title: 'Edit with the version in hand',
        narrative: (
          <p>
            Read with <code>entity context</code>, which returns the version alongside a bounded body. Pass that
            version back on <code>entity update</code>. A conflict is not an error to retry blindly; it means the page
            moved under you, so read it again first.
          </p>
        ),
        commands: ['entity context', 'entity update', 'entity versions'],
        demo: [
          '# version 7 is what you read',
          'tm8 entity context <doc-id>',
          'tm8 entity update <doc-id> --expect-version 7 --content @body.json',
          '# refused with version_conflict? someone saved first; see what changed',
          'tm8 entity versions <doc-id> --limit 5',
        ],
      },
      {
        title: 'Mark the card current',
        narrative: (
          <p>
            After a real revision, check the header. If <code>header.stale</code> is true and the words still hold,
            re-save them as they are; the header is pinned to the new version and the stale mark clears for every
            later reader.
          </p>
        ),
        commands: ['entity context', 'entity header set'],
        demo: [
          '# the body moved; the card still says it was written for version 7',
          'tm8 entity context <doc-id>',
          '# same words, re-saved, now pinned to version 8',
          'tm8 entity header set <doc-id> --when-to-use "Open when changing rounding" --summary "Ledger vs invoices"',
        ],
      },
      {
        title: 'Shelve it, find it, retire it',
        narrative: (
          <p>
            A collection is a curated shelf; adding a doc there does not move it in its own tree.{' '}
            <code>entity query</code> finds docs across the Space. Deleting is soft, so a mistaken delete is one{' '}
            <code>entity restore</code> away.
          </p>
        ),
        commands: ['collection add', 'entity query', 'entity delete', 'entity restore'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A doc sits at the end of the arrows more often than the start. Tasks read it and write it, collections shelve
        it, memories lean on it, teammates pin it. Its one outgoing habit is attaching itself to the work it explains,
        which is how a doc shows up in a task&apos;s attach palette.
      </p>
    ),

    notes: {
      'attached_to:outgoing': 'Attach the doc to a task or any other entity it explains; the task lists it under Docs.',
      consumes: 'A task reads this doc as an input. Written when a blueprint is materialized into tasks.',
      produces: 'A task writes this doc as its output. Written when a blueprint is materialized into tasks.',
      'contains:incoming': 'A collection shelves the doc. Membership is curated and ordered; the doc does not move.',
      based_on: 'A memory rests on this doc at a pinned version, and drifts when the doc moves past it.',
      pulled: 'A person or teammate pinned a version of the doc into a local working copy.',
    },

    spotlight: ['task', 'collection', 'memory', 'team_member'],
  },
};
