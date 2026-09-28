/**
 * WORKTREE — Entity Help, wave 4.
 *
 * Facts are read from the shipped code, not the design doc:
 *   db/migrations/057_worktrees.sql            the two tables, the one status door,
 *                                              the transition rules, the delete preflight
 *   packages/execution/src/spawn/worktree-provisioning.ts
 *                                              base ref resolved to an OID, branch `tm8/<id>`
 *   packages/execution/src/spawn/worktree-reconcile.ts
 *                                              never infers merged/abandoned, never deletes
 *                                              an unrecognised Git worktree
 *   packages/server/src/tracking/commit-recorder.ts
 *                                              commits beyond the base, recorded per session
 *   packages/server/src/facade/services/w2/entities-commands-tracking.ts
 *                                              the patch door accepts a status and nothing else
 *
 * THE SIGNATURE MOMENT is `TheFork`: the base ref's trunk, a lane cut from one
 * pinned commit, the lane's own commits arriving, and then the trunk moving on
 * while the pin stays where it was. Under reduced motion it is one still
 * diagram with the same labels, and the caption carries the whole meaning.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Reveal } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

/** One point on the fork, placed in % of the figure; the Reveal inside it arrives. */
function Mark({ x, y, delay, children }: { x: number; y: number; delay: number; children: ReactNode }) {
  const place: CSSProperties = { position: 'absolute', left: `${x}%`, top: `${y}%`, width: 0, height: 0 };
  return (
    <div style={place}>
      <Reveal delay={delay}>{children}</Reveal>
    </div>
  );
}

function Dot({ tone }: { tone: 'trunk' | 'lane' | 'pin' }) {
  const size = tone === 'pin' ? 14 : 9;
  const style: CSSProperties = {
    width: size,
    height: size,
    marginLeft: -size / 2,
    marginTop: -size / 2,
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: tone === 'lane' ? 'var(--pn-brand)' : tone === 'pin' ? 'var(--pn-card)' : 'var(--pn-ink-3)',
    border: tone === 'pin' ? '3px solid var(--pn-brand)' : 'none',
    boxShadow: tone === 'pin' ? '0 0 0 4px rgba(var(--pn-brand-rgb), 0.18)' : 'none',
  };
  return <div style={style} />;
}

function Label({
  children,
  align = 'start',
  below = false,
  literal = false,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  below?: boolean;
  /** A real name (a branch), kept in its own case rather than the eyebrow's capitals. */
  literal?: boolean;
}) {
  const shift = align === 'end' ? '-100%' : align === 'center' ? '-50%' : '0';
  const style: CSSProperties = {
    position: 'absolute',
    whiteSpace: 'nowrap',
    ...(literal ? { textTransform: 'none', letterSpacing: 0 } : {}),
    transform: `translate(${shift}, ${below ? '14px' : 'calc(-100% - 12px)'})`,
  };
  return (
    <span className="eh-eyebrow" style={style}>
      {children}
    </span>
  );
}

const TRUNK_Y = 74;
const LANE_Y = 24;
const FORK_X = 22;

/**
 * The fork. Coordinates are shared by the SVG (viewBox 0..100 x 0..40, drawn
 * at the figure's own aspect so nothing stretches) and the HTML marks (%).
 */
function TheFork() {
  const trunkY = (TRUNK_Y / 100) * 40;
  const laneY = (LANE_Y / 100) * 40;
  const wire = (delay: number, width: number): CSSProperties =>
    ({ '--eh-delay': `${delay}ms`, strokeWidth: width }) as CSSProperties;
  return (
    <figure style={{ margin: 'var(--pn-space-4) 0 0' }} data-testid="worktree-fork">
      <div style={{ position: 'relative', width: '100%', aspectRatio: '100 / 40' }} aria-hidden>
        <svg
          viewBox="0 0 100 40"
          preserveAspectRatio="xMidYMid meet"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
        >
          <path className="eh-wire" pathLength={100} d={`M2 ${trunkY} L98 ${trunkY}`} style={wire(0, 0.45)} />
          <path
            className="eh-wire eh-wire--hot"
            pathLength={100}
            d={`M${FORK_X} ${trunkY} C ${FORK_X + 9} ${trunkY}, ${FORK_X + 9} ${laneY}, ${FORK_X + 20} ${laneY} L 94 ${laneY}`}
            style={wire(520, 0.6)}
          />
        </svg>

        <Mark x={9} y={TRUNK_Y} delay={80}>
          <Dot tone="trunk" />
        </Mark>
        <Mark x={FORK_X} y={TRUNK_Y} delay={220}>
          <Dot tone="pin" />
          <Label below>base commit · pinned</Label>
        </Mark>
        <Mark x={FORK_X + 20} y={LANE_Y} delay={900}>
          <Label literal>tm8/&lt;worktree-id&gt;</Label>
        </Mark>
        <Mark x={56} y={LANE_Y} delay={1150}>
          <Dot tone="lane" />
        </Mark>
        <Mark x={70} y={LANE_Y} delay={1350}>
          <Dot tone="lane" />
        </Mark>
        <Mark x={84} y={LANE_Y} delay={1550}>
          <Dot tone="lane" />
          <Label align="end" below>
            commits recorded
          </Label>
        </Mark>
        <Mark x={54} y={TRUNK_Y} delay={1900}>
          <Dot tone="trunk" />
        </Mark>
        <Mark x={76} y={TRUNK_Y} delay={2050}>
          <Dot tone="trunk" />
        </Mark>
        <Mark x={96} y={TRUNK_Y} delay={2200}>
          <Label align="end" below>
            the base ref moves on
          </Label>
        </Mark>
      </div>
      <figcaption className="eh-prose" style={{ marginTop: 'var(--pn-space-5)' }}>
        <p>
          The lane forks from one commit, not from a name. The trunk keeps moving; the pin does not, so what the
          session got is always answerable.
        </p>
      </figcaption>
    </figure>
  );
}

export const WORKTREE_HELP: KindHelpModule = {
  kind: 'worktree',

  story: {
    logline: 'Give each agent its own checkout of the code, cut from a commit that never moves, and ten of them can work one repository without touching each other.',

    opening: (
      <>
        <p>
          A worktree is a lane. When a session is spawned with <code>--workdir worktree</code>, tm8 gives it a
          private Git checkout of the project on a fresh branch named <code>tm8/&lt;worktree-id&gt;</code>. The
          session edits, stages and commits there. Your own tree, and every other lane, stays exactly as it was.
        </p>
        <p>
          Without lanes, parallel agents share one working directory. One agent&apos;s half-finished edit is
          another agent&apos;s broken build, and nobody can say which session produced which change. The
          worktree turns that shared floor into separate rooms, and gives each room a record in the graph.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The fork',
        title: 'Cut from a commit, not a name',
        body: (
          <>
            <p>
              <code>--base-ref</code> names where the lane starts, but a ref moves. So the ref is resolved to a
              40-character commit before anything is checked out, and that commit is what the lane gets and what
              the record keeps. Branch, base ref, base commit, path and project are fixed at birth. The patch door
              refuses each of them by name.
            </p>
            <TheFork />
          </>
        ),
      },
      {
        eyebrow: 'One room, one tenant',
        title: 'A lease, never a queue',
        body: (
          <p>
            A live session holds a lease on its checkout, and a leased worktree cannot be handed to a second
            session. That reuse is refused outright rather than queued. Paths are unique and branches are unique
            per project, so a collision is an error, never a quiet share of someone else&apos;s files. When lanes
            touch the same files anyway, <code>tm8 project contention</code> names the overlap before the merge
            does.
          </p>
        ),
      },
      {
        eyebrow: 'Two clocks',
        title: 'What it means, and where it sits',
        body: (
          <p>
            A worktree keeps two records on purpose. The <strong>status</strong> (active, merged, abandoned,
            deleted) is the story, and every change bumps the entity&apos;s version so pinned memories notice. The
            <strong> allocation</strong> (preparing, ready, missing, failed) is disk truth, kept in a table that
            cannot move the version at all. A flapping disk never tells a memory that the work has changed.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Nothing guesses how it ended',
        body: (
          <p>
            Status has exactly one writer, and nothing infers it. A vanished branch is not a merge and a quiet lane
            is not an abandonment. Someone records the ending. Startup reconciliation repairs allocations, and an
            unrecognised Git worktree it finds in the repository is quarantined and left untouched, because the
            repository is shared with your own checkouts.
          </p>
        ),
      },
      {
        eyebrow: 'The receipt',
        title: 'Every commit knows its session',
        body: (
          <p>
            While a lane is active, the server walks the commits it has made beyond its base and records each one
            as a commit entity with a <code>created_in</code> edge to the session. Which session wrote this change
            becomes a graph question with a graph answer, before anything is pushed or linked to a pull request.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Active', note: 'Cut from a pinned commit on its own branch. The only state a lane is born in.' },
      { name: 'Merged', note: 'Recorded by a caller once the work landed. Nothing infers it.' },
      { name: 'Abandoned', note: 'Recorded when the work is set aside. Merged and abandoned never swap.' },
      {
        name: 'Deleted',
        note: 'Terminal. While the checkout is still on disk it needs a fresh preflight and no live lease.',
      },
    ],
  },

  toolkit: {
    intro: (
      <p>
        You rarely create a worktree by name. You spawn a session into one, then drive the lane by session id or
        worktree id: read it, stage and commit inside it, pull other work into it, and finally record how it ended.
        Every Git move that could lose work either refuses or aborts cleanly and says so on the task that owns the
        lane.
      </p>
    ),
    scenes: [
      {
        title: 'Cut a lane',
        narrative: (
          <p>
            <code>tm8 session spawn</code> with the worktree workdir resolves the base, checks out the lane and
            files the session into it through an <code>in_worktree</code> edge. <code>tm8 worktree status</code>{' '}
            then shows the ref beside the commit it resolved to, and the path on disk.
          </p>
        ),
        commands: ['session spawn', 'worktree status', 'worktree list'],
        demo: [
          '# one session, one checkout, one pinned base',
          'tm8 session spawn --teammate <team-member-id> --task <task-id> --workdir worktree --base-ref origin/main',
          'tm8 worktree list --status active',
          'tm8 worktree status <worktree-id>',
        ],
      },
      {
        title: 'Read first, then commit',
        narrative: (
          <p>
            With no paths, <code>tm8 worktree stage</code> only lists what changed and stages nothing. Name the
            paths you mean, then <code>tm8 worktree commit</code> commits exactly the index. An empty index is a
            refusal, never an empty commit.
          </p>
        ),
        commands: ['worktree stage', 'worktree commit'],
        demo: [
          'tm8 worktree stage <session-id>',
          'tm8 worktree stage <session-id> src/a.ts',
          "tm8 worktree commit <session-id> --message 'feat: …'",
        ],
      },
      {
        title: 'Stay current without leaving',
        narrative: (
          <p>
            Other lanes move. <code>tm8 project contention</code> shows where active lanes touch the same paths.
            <code> tm8 worktree merge</code> and <code>tm8 worktree cherry-pick</code> only ever bring work into the
            lane; a conflict aborts, is verified clean, and lands as a message and an attention signal on the owning
            task. <code>tm8 worktree stash</code> keeps unfinished edits aside per lane.
          </p>
        ),
        commands: ['project contention', 'worktree merge', 'worktree cherry-pick', 'worktree stash'],
        demo: [
          '# who else is in these files',
          'tm8 project contention <project-resource-id>',
          'tm8 worktree merge <session-id> --from main',
        ],
      },
      {
        title: 'Record the ending',
        narrative: (
          <p>
            The status is the one field a worktree lets you change, through <code>tm8 entity update</code> with a
            version guard. Merged and abandoned are each final for the story; deleted is final for the record.
          </p>
        ),
        commands: ['entity update', 'worktree list'],
        demo: [
          '# nothing infers a merge; you record it',
          'tm8 entity update <worktree-id> --expect-version <n> --content \'{"status":"merged"}\'',
          'tm8 worktree list --status merged',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        Every piece of work in a lane reaches it through one edge. Sessions, tasks, commits and pull requests can each
        be filed <code>in_worktree</code>, and several sessions may read one lane. Start from the session: its newest{' '}
        <code>in_worktree</code> edge is how tm8 finds the checkout to read status, diff or commit.
      </p>
    ),
    notes: {
      in_worktree:
        'The one association into a lane. Spawn writes it for the session, stamped as system; filed by hand, it stays correctable.',
      based_on:
        'A memory pinned to this worktree. Only a status change moves the version, so a memory drifts when the story does, not when the disk does.',
    },
    spotlight: ['work_session', 'task', 'commit', 'pull_request'],
  },
};
