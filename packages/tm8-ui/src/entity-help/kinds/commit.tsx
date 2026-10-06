/**
 * COMMIT — Entity Help, wave 4.
 *
 * A commit is a FACT KIND: born `done` (migration 152), with no status to
 * walk. What it does have is a life in the graph: two doors that make the
 * same row (`record_session_commit`, 082, from the commit recorder; and
 * `link_commit`, 017, from `tm8 task link-commit`), one observer that fills
 * it in (`apply_commit_facts`, 081), and one reader that turns it back into a
 * name (`project blame`, via the `authored_from` edge). The story is told along
 * that life, not along a status column it does not have.
 *
 * SIGNATURE MOMENT — THE STITCH. One SHA sits alone; then the three threads
 * that make it proof of work arrive one after another: the session that
 * wrote it, the task that claims it, the project it belongs to. Under reduced
 * motion the threads are simply all there, which says the same thing: the
 * hash is only a fact once it is tied to something.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Reveal, Stagger } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

/* An illustrative short SHA. It stands for any commit; it is not a real one. */
const SHA = '4c1e9a7';

const stitchFrame: CSSProperties = {
  display: 'grid',
  gap: 'var(--pn-space-3)',
  margin: 'var(--pn-space-5) 0',
  padding: 'var(--pn-space-5)',
  border: '1px solid var(--pn-line-2)',
  borderRadius: 'var(--pn-r-md)',
  background: 'var(--pn-card)',
};

const shaChip: CSSProperties = {
  justifySelf: 'start',
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-h3)',
  letterSpacing: 'var(--pn-track-label)',
  color: 'var(--pn-ink)',
  padding: 'var(--pn-space-2) var(--pn-space-4)',
  borderRadius: 'var(--pn-r-pill)',
  border: '1px solid var(--pn-brand)',
  background: 'var(--pn-brand-soft)',
};

const threadRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(7.5rem, auto) 1fr',
  alignItems: 'baseline',
  gap: 'var(--pn-space-4)',
  margin: 'var(--pn-space-2) 0',
  padding: 'var(--pn-space-2) 0 var(--pn-space-2) var(--pn-space-4)',
  borderLeft: '2px solid var(--pn-brand)',
};

const threadEdge: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-mono)',
  color: 'var(--pn-brand)',
};

const threadText: CSSProperties = {
  color: 'var(--pn-ink-2)',
  fontSize: 'var(--pn-fs-sm)',
  lineHeight: 'var(--pn-lh-snug)',
};

function Thread({ edge, children }: { edge: string; children: ReactNode }) {
  return (
    <div style={threadRow}>
      <code style={threadEdge}>{edge}</code>
      <span style={threadText}>{children}</span>
    </div>
  );
}

/** The signature moment: a bare hash, then the three threads that make it evidence. */
function Stitch() {
  return (
    <figure style={stitchFrame} aria-label={`Commit ${SHA} and the three edges that tie it into the graph`}>
      <Reveal>
        <span className="eh-eyebrow">A hash, alone</span>
      </Reveal>
      <Reveal delay={120}>
        <code style={shaChip}>{SHA}</code>
      </Reveal>
      <Stagger start={700} step={520} className="eh-prose" itemClassName="eh-prose">
        <Thread edge="authored_from →">
          the work session whose lane produced it, recorded without anyone asking
        </Thread>
        <Thread edge="← tracks">the task that says this is the work it asked for</Thread>
        <Thread edge="in_project →">the project the repository belongs to, when the link names one</Thread>
      </Stagger>
      <Reveal delay={2400}>
        <figcaption className="eh-eyebrow">Stitched: now it is proof of work</figcaption>
      </Reveal>
    </figure>
  );
}

export const COMMIT_HELP: KindHelpModule = {
  kind: 'commit',

  story: {
    logline: 'The receipt the graph keeps when code actually changed, tied to whoever made it and whatever asked for it.',

    opening: (
      <>
        <p>
          A commit here is a mirror of a real git commit: a repository, a SHA, a message, an author and a time. You do
          not write one by hand. It appears when an agent&rsquo;s lane commits, or when someone links a commit URL to a
          task, and from then on it sits in the graph as a small, settled fact.
        </p>
        <p>
          Before it existed, the only record of who wrote what was the git log, and the git log does not know about
          tasks, sessions or teammates. A task could say it was finished and nothing in the graph could point at the
          code. The commit entity is the pointer: the place where a hash meets the work that produced it.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The signature',
        title: 'A hash becomes evidence when it is stitched in',
        body: (
          <>
            <p>
              On its own a SHA is a string of hex and nothing more. What makes a commit worth an entity is the edges that
              arrive after it. Watch them land.
            </p>
            <Stitch />
          </>
        ),
      },
      {
        eyebrow: 'Two doors, one row',
        title: 'Recorded from the lane, linked from the task',
        body: (
          <>
            <p>
              The commit recorder walks every active worktree that has a session, about once a minute, and records
              each commit the lane has made beyond its base. That is how a commit gets its <code>authored_from</code>{' '}
              edge to the session that wrote it, before anything is pushed.
            </p>
            <p>
              <code>tm8 task link-commit</code> is the other door: a task names a commit URL and a{' '}
              <code>tracks</code> edge is drawn from the task to it. Both doors look the commit up by space, provider,
              repository and SHA first, so when they name the same commit they meet at the same entity instead of
              making two.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Born done, because the past does not change',
        body: (
          <p>
            A commit has no board, no status column and nothing to assign. It is created already resolved: a commit
            exists because it was made, and no later edit can make it less made. Ask whether a commit is resolved and
            the answer is yes, whenever it was recorded. What does change is how much the graph knows about it.
          </p>
        ),
      },
      {
        eyebrow: 'Filling in',
        title: 'The observer fetches what the link did not say',
        body: (
          <p>
            A commit linked by URL starts thin: its title is the SHA itself. <code>tm8 tracking refresh</code> queues
            a re-read, and the tracking observer asks GitHub for the real message, author and time and writes them
            back. It only overwrites what it actually learned, so a fact the provider did not return is kept, never
            blanked.
          </p>
        ),
      },
      {
        eyebrow: 'Read back',
        title: 'Blame that names a session, not a guess',
        body: (
          <p>
            <code>tm8 project blame</code> runs git blame on one file and joins each line&rsquo;s commit to the session
            that produced it through <code>authored_from</code>. A commit with no recorded session gets no name at all.
            Absent provenance is shown as absent, never filled in from a similar-looking author or a nearby timestamp.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Committed', note: 'Code is committed in a lane. Git knows; the graph does not yet.' },
      { name: 'Recorded', note: 'The recorder finds it past the lane’s base and ties it to the session.' },
      { name: 'Linked', note: 'A task links its URL and draws a tracks edge to it.' },
      { name: 'Filled in', note: 'A tracking refresh brings back message, author and time.' },
      { name: 'Read back', note: 'Project blame names the session behind each line.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        You rarely touch a commit directly. You make one in your lane, you point a task at it, and you ask the graph who
        made it. Every verb below acts on the thing next to the commit: the worktree, the task, the tracking queue, the
        file.
      </p>
    ),

    scenes: [
      {
        title: 'Make it, on the record',
        narrative: (
          <p>
            Stage what you mean and commit exactly that. <code>tm8 worktree commit</code> refuses an empty index
            rather than making an empty commit, and posts a receipt message naming the new SHA and branch. Within
            about a minute the recorder mirrors it into the graph with its session attached.
          </p>
        ),
        commands: ['worktree stage', 'worktree commit'],
        demo: [
          '# stage what you mean, then commit only that',
          'tm8 worktree stage <session-id> packages/ui/src/panel.tsx',
          "tm8 worktree commit <session-id> --message 'fix(ui): panel keeps focus'",
        ],
      },
      {
        title: 'Stitch it to the task',
        narrative: (
          <p>
            Once the commit is pushed, link its URL to the task it answers. The link draws the <code>tracks</code>{' '}
            edge and records a <em>linked</em> activity on the task. Pass a project and the commit is associated
            with it too. Then ask for a refresh so the observer fills in the message and author.
          </p>
        ),
        commands: ['task link-commit', 'tracking refresh'],
        demo: [
          '# point the task at the code that did the work',
          'tm8 task link-commit <task-id> https://github.com/<owner>/<repo>/commit/<sha>',
          '# then have the observer read GitHub for the real message and author',
          'tm8 tracking refresh <commit-id>',
        ],
      },
      {
        title: 'Ask who wrote this',
        narrative: (
          <p>
            Blame a file and every hunk arrives with the session behind its commit, where one was recorded. To walk
            the other way, from a commit to its session, read its <code>authored_from</code> edge.
          </p>
        ),
        commands: ['project blame', 'edge list'],
        demo: [
          '# which session produced each line of this file',
          'tm8 project blame <project-id> packages/ui/src/panel.tsx',
          '# and from one commit, straight to its session',
          'tm8 edge list --source <commit-id> --type authored_from',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A commit is small and well connected. Look for <code>authored_from</code> first: it is the edge that turns a hash
        into authorship. Then <code>tracks</code>, which is a task saying this is the work it asked for. The rest place
        the commit in a project and a lane.
      </p>
    ),

    notes: {
      'authored_from:outgoing':
        'The session this commit was made during, recorded by the server when the commit recorder stamps it. Project blame reads this edge and nothing else.',
      'tracks:incoming': 'A task that claims this commit as its implementation, drawn by task link-commit.',
      'in_project:outgoing': 'The project this commit belongs to, set when a link names one.',
      'in_worktree:outgoing': 'A lane this commit is filed under, when someone draws the edge. The recorder ties commits to sessions, not to worktrees.',
      'attached_to:outgoing': 'Context a commit is pinned to, such as a channel shelf.',
    },

    spotlight: ['work_session', 'task', 'project', 'worktree'],
  },
};
