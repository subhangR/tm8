/**
 * STORY — everything around one idea, and where it stands (migration 282).
 *
 * The signature moment is the FOLLOW: a second filmstrip inside "Put in by
 * hand, followed by rule" that walks one root out to the page — the root, what
 * follows from it, the tally, the page. It reuses the Story tab's own
 * `eh-film` markup, as the drawing page does.
 *
 * Every fact here was checked against 282_story_kind.sql, the published
 * contract (packages/contract/src/story.ts) and the story page artifact
 * 01a0fc3e rev 4.
 */
import type { KindHelpModule } from '../types';

/** How one root becomes the page, in order. Drawn as a second strip. */
const THE_FOLLOW: readonly { name: string; note: string }[] = [
  { name: 'Put in', note: 'You add a task, a doc, anything, by hand. That is a root: a contains edge from the story.' },
  { name: 'Followed', note: 'Its children, the sessions on it, what it made, its commits and the people on it come along, three steps out.' },
  { name: 'Tallied', note: 'The server counts done, working, blocked and to do over what followed, at read time.' },
  { name: 'Drawn', note: 'One page: the hero, four figures, the graph, the roots, the team and a live feed.' },
];

export const STORY_HELP: KindHelpModule = {
  kind: 'story',

  story: {
    logline: 'One idea, everything happening around it, and where it stands, on one page that keeps itself current.',

    opening: (
      <>
        <p>
          A story is a page for one idea. You put a few things in by hand, usually the root tasks, and the story
          follows everything connected to them: their children, the agents running on them, the docs and drawings
          they produced, the commits and pull requests, the memories made along the way and the people on it.
        </p>
        <p>
          Before it, the answer to &ldquo;where does this stand?&rdquo; lived in someone&rsquo;s head or in a status
          message that was stale by lunch. A story answers it from the work itself. Nothing on the page is typed in:
          progress, the graph, who is on it and what is blocked are all computed when you open it.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The rule',
        title: 'Put in by hand, followed by rule',
        body: (
          <>
            <p>
              Only the roots are chosen. Everything else follows along a fixed set of edges, three steps out from each
              root, under a bound of five hundred rows. Reactions and access never follow; they are not the work.
            </p>
            <div className="eh-film" style={{ contain: 'inline-size' }}>
              <span className="eh-eyebrow">From one root to the page</span>
              <ol className="eh-film__strip" aria-label="How a root becomes the story page">
                {THE_FOLLOW.map((frame, index) => (
                  <li key={frame.name} className="eh-film__frame" style={{ ['--eh-delay' as string]: `${index * 140}ms` }}>
                    <span className="eh-film__number" aria-hidden>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="eh-film__name">{frame.name}</span>
                    <span className="eh-film__note">{frame.note}</span>
                  </li>
                ))}
              </ol>
            </div>
          </>
        ),
      },
      {
        eyebrow: 'Never stored',
        title: 'The figures are read, not kept',
        body: (
          <p>
            &ldquo;12 of 30 tasks done&rdquo; is computed by the server every time the story is read, by the same
            function on the list and on the page, so the two cannot disagree. The bands are disjoint: done, working,
            blocked and to do always add up to the work. Cancelled rows are not work and are not counted.
          </p>
        ),
      },
      {
        eyebrow: 'Live',
        title: 'It moves while you watch',
        body: (
          <p>
            Every message on anything in the story lands in its live feed as it is posted, and a change to any row in
            the trail moves the page: a node flashes, a stat ticks. Pause it when you want to read; events queue until
            you resume.
          </p>
        ),
      },
      {
        eyebrow: 'Stories in stories',
        title: 'Child stories roll up',
        body: (
          <p>
            A story can have child stories, parented like any other kind. Each child keeps its own page, and its tally
            rolls up into the parent&rsquo;s, so a quarter&rsquo;s story reads the sum of the ideas under it.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Empty', note: 'A title and a description. The page says what to put in.' },
      { name: 'Rooted', note: 'The first things are in, and what follows from them fills the page.' },
      { name: 'In motion', note: 'Agents and people work the roots; the figures move on their own.' },
      { name: 'Done', note: 'Its own status, set when the idea has landed. The page stays as the record.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal a story is an ordinary entity whose body is computed. Create it, put its roots in, and read it
        back: the context call renders the same page an agent needs, bounded, so a teammate can pick up the whole idea
        in one read.
      </p>
    ),
    scenes: [
      {
        title: 'Start a story and put its roots in',
        narrative: (
          <p>
            Make the story with a title and a line on what done looks like, then add the root tasks to it. Membership
            is a <code>contains</code> edge, the same door a collection uses.
          </p>
        ),
        commands: ['entity create', 'collection add'],
        demo: [
          '# the idea, then what it is made of',
          'tm8 entity create story "Story as an Entity"',
          'tm8 collection add <story-id> <task-id>',
        ],
      },
      {
        title: 'Read where it stands',
        narrative: (
          <p>
            The context call carries the story&rsquo;s page as a bounded section: roots, progress, who is live and
            what is blocked. It is the read a teammate starts with.
          </p>
        ),
        commands: ['entity context'],
        demo: ['# the whole idea, in one bounded read', 'tm8 entity context <story-id>'],
      },
      {
        title: 'Take a root out',
        narrative: (
          <p>
            Removing a root deletes the edge, never the task. What followed from it leaves the page with it, and the
            figures move on the next read.
          </p>
        ),
        commands: ['collection remove'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A story holds its roots through <code>contains</code> and computes the rest. Start there: every other line on
        the page is something a root reached.
      </p>
    ),
    notes: {
      'contains:outgoing': 'The roots: what was put in by hand. Ordered by position; everything else follows from these.',
      'attached_to:outgoing': 'The story hangs off something it is about, without making it a root.',
      'anchored_to:incoming': 'Messages on the story itself. The live feed also carries every message on everything in it.',
      relates_to: 'The general link, for something nearby that is not part of the work.',
    },
    spotlight: ['task', 'work_session', 'doc', 'message'],
  },
};
