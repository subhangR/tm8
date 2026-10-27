/**
 * PROJECT — Entity Help, Wave 1 (task 01a0e7d6).
 *
 * Fact sources, so a later edit can re-check them rather than trust the prose:
 *   folder (node, path, trust) vs the Space's project entity   migration 234 space_owned_projects; contract ProjectResource
 *   one folder, one Space; decision 29 the loopback exception  migration 234; catalog notes on `project link` / `add`
 *   workingDir only for node admins                            contract ProjectResource.workingDir
 *   new projects untrusted; spawn needs --confirm-untrusted    contract; migration 267; execution containers/policy
 *   lanes get the agent tool's trust bit only when trusted     execution spawn/workspace-trust.ts
 *   worktree = <root>/<project>/<worktree>, cut per session    execution WorktreeManager; migration 267
 *   contention = overlapping touched paths across lanes        server services/contention.ts
 *   blame / file-history join commits to sessions (authored_from) catalog notes on `project blame` / `file-history`
 *
 * NOT CLAIMED, on purpose: that the panel shows the path or the trust state,
 * or that Untrust and Unlink work from the panel. The governed body draws
 * those blocks, but this build does not feed them, so the CLI is the truth.
 *
 * THE SIGNATURE is the lane map: one folder, cut into many isolated lanes,
 * with contention showing where two of them touch the same file.
 */
import type { KindHelpModule } from '../types';
import { SignatureStage, at } from './SignatureStage';

function LaneMap() {
  return (
    <SignatureStage caption="One folder, many lanes" label="A project folder granted to a Space and cut into worktree lanes" className="ehs-proj">
      <ol className="ehs-proj__chain" aria-label="How a folder becomes a project">
        <li className="ehs-proj__link ehs-in" style={at(0)}>
          <span className="ehs-proj__tag">On the node</span>
          <code className="ehs-proj__path">/srv/repos/billing</code>
          <span className="ehs-proj__small">a folder, seen by node admins only</span>
        </li>
        <li className="ehs-proj__link ehs-in" style={at(450)}>
          <span className="ehs-proj__tag">Granted</span>
          <span className="ehs-chip ehs-chip--brass">one Space</span>
          <span className="ehs-proj__small">a folder belongs to one Space</span>
        </li>
        <li className="ehs-proj__link ehs-in" style={at(900)}>
          <span className="ehs-proj__tag">In the Space</span>
          <span className="ehs-proj__name">⬢ Billing</span>
          <span className="ehs-proj__small">the project: a name, never a path</span>
        </li>
      </ol>

      <div className="ehs-proj__lanes">
        <svg className="ehs-proj__svg" viewBox="0 0 600 150" preserveAspectRatio="none" aria-hidden>
          <path className="ehs-proj__main ehs-draw" d="M10 20 L590 20" pathLength={1000} style={at(1300)} />
          <path className="ehs-proj__lane ehs-proj__lane--merged ehs-draw" d="M60 20 C85 20 85 60 110 60 L200 60 C225 60 225 20 250 20" pathLength={1000} style={at(1700)} />
          <path className="ehs-proj__lane ehs-draw" d="M330 20 C355 20 355 100 380 100 L410 100" pathLength={1000} style={at(2000)} />
          <path className="ehs-proj__lane ehs-draw" d="M270 20 C295 20 295 140 320 140 L410 140" pathLength={1000} style={at(2300)} />
          <circle className="ehs-proj__head ehs-pop" cx="410" cy="100" r="4" style={at(2600)} />
          <circle className="ehs-proj__head ehs-pop" cx="410" cy="140" r="4" style={at(2900)} />
        </svg>
        <span className="ehs-proj__label ehs-proj__label--main ehs-in" style={at(1400)}>
          default branch
        </span>
        <span className="ehs-proj__label ehs-proj__label--a ehs-in" style={at(2000)}>
          <span className="ehs-chip">tm8/&lt;lane&gt;</span> merged back
        </span>
        <span className="ehs-proj__label ehs-proj__label--b ehs-in" style={at(2400)}>
          <span className="ehs-chip ehs-chip--run">session · worktree lane</span>
        </span>
        <span className="ehs-proj__label ehs-proj__label--c ehs-in" style={at(2700)}>
          <span className="ehs-chip ehs-chip--run">session · worktree lane</span>
        </span>
        <span className="ehs-proj__clash ehs-pop" style={at(3300)}>
          contention · both lanes touch <code>invoice.ts</code>
        </span>
      </div>
      <p className="ehs-note">
        Each session that asks for a worktree gets its own checkout on its own <code>tm8/</code> branch, cut from the
        default branch. <code>tm8 project contention</code> reports where active lanes have touched the same paths,
        before anyone tries to merge.
      </p>
    </SignatureStage>
  );
}

export const PROJECT_HELP: KindHelpModule = {
  kind: 'project',

  story: {
    logline: 'A Space’s name for a folder of code on the server, and the ground every agent’s lane is cut from.',
    opening: (
      <>
        <p>
          A <strong>project</strong> is how a Space refers to a codebase. Behind it is a folder on the server,
          registered by a node admin and granted to one Space. The Space gives it a name, and from then on sessions,
          tasks, pull requests and commits can say which project they belong to.
        </p>
        <p>
          Agents need a real directory to work in. A Space, though, should not hand out disk paths, and one Space
          should not reach into another Space&rsquo;s code. The project splits the two concerns. The node owns the
          folder, its path and its trust. The Space owns the name, and ordinary members never see a path at all.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'Why there are two ids',
        title: 'The folder and the project are not the same thing',
        body: (
          <p>
            The node keeps a record for the folder, with its path, its trust and its repository URL. The Space keeps
            its own project entity over that folder, with its own name and no path. Renaming the folder does not
            rename the project. <code>tm8 project link</code> returns both ids, and they are never interchangeable.
            That is also why editing, deleting or moving a project from the Space is refused by design. The folder is
            managed on the node, and the Space can only let go of it.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'One folder, one Space',
        body: (
          <p>
            A folder is granted to at most one Space. A second Space that asks is refused with &ldquo;this folder
            belongs to another space&rdquo;. The single exception is a single node that listens only on loopback,
            where node policy may let several Spaces share a folder. Node admins register folders,
            and only inside the roots the server was configured with.
          </p>
        ),
      },
      {
        eyebrow: 'Trust is a grant',
        title: 'Untrusted until someone says otherwise',
        body: (
          <p>
            A new project is untrusted. Spawning a session or a terminal into it needs an explicit{' '}
            <code>--confirm-untrusted</code>, and a container will not mount it without the same confirmation. Only a
            trusted project gives its worktree lanes the agent tool&rsquo;s own trust bit. Trust is stated once, on
            the folder, rather than by every caller that touches it.
          </p>
        ),
      },
      {
        eyebrow: 'The signature',
        title: 'Many lanes, one ground',
        body: (
          <>
            <p>
              A project is where parallel work happens. Every session launched with a worktree gets its own isolated
              checkout of the project, so ten agents can change one repository at once without sharing a working
              tree. The project remembers who did what. <code>tm8 project blame</code> and{' '}
              <code>file-history</code> join each commit to the session that produced it, and they say plainly when
              no session was recorded.
            </p>
            <LaneMap />
          </>
        ),
      },
    ],
    lifecycle: [
      { name: 'Registered', note: 'A node admin adds the folder, inside the server’s configured roots. Untrusted by default.' },
      { name: 'Granted', note: 'The folder is granted to one Space. No other Space can have it.' },
      { name: 'Named', note: 'The Space names its project on the folder. Members see the name, never the path.' },
      { name: 'Worked', note: 'Sessions, lanes, tasks, pull requests and commits attach to it as they happen.' },
      { name: 'Unlinked', note: 'The Space lets go. The folder stays on the node, and so does its history.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Most project commands split cleanly by who is asking. Members read the Space&rsquo;s projects and their
        history. Node admins register folders and grant them. The git reads are all argv-only: they check out,
        fetch and write nothing, so reading a project never changes it.
      </p>
    ),
    scenes: [
      {
        title: 'Which projects does this Space have?',
        narrative: (
          <p>
            <code>tm8 project space-list</code> lists the Space&rsquo;s own project entities, each over a folder
            granted to it, and never prints a path. Use <code>tm8 entity context</code> on one to see the sessions,
            tasks and pull requests attached to it.
          </p>
        ),
        commands: ['project space-list', 'entity context'],
        demo: ['tm8 project space-list', 'tm8 entity context <project-id>'],
      },
      {
        title: 'Bring a folder in (node admins)',
        narrative: (
          <p>
            A node admin registers the folder, optionally granting it to a Space in the same call. The Space&rsquo;s
            owner or admin then names the Space&rsquo;s project on it. <code>tm8 project folders</code> is the one view
            that shows every folder with its Space, and only node admins can run it.
          </p>
        ),
        commands: ['project folders', 'project folder-add', 'project add', 'project link', 'project unlink'],
        demo: [
          'tm8 project folder-add billing --working-dir /srv/repos/billing --grant-space <space-id> --trust trusted',
          'tm8 project add <folder-id> --name "Billing"',
        ],
      },
      {
        title: 'Read its history',
        narrative: (
          <p>
            Branches come with ahead and behind counts against the default branch, and the answer says where that
            default came from. <code>main</code> is a convention, not a rule. Blame and file history join each commit
            to the session that made it, and only through a recorded <em>created in</em> edge. Absent facts stay
            absent.
          </p>
        ),
        commands: ['project branches', 'project file-history', 'project blame'],
        demo: [
          'tm8 project branches <project-resource-id> --stale-after-days 14',
          'tm8 project blame <project-resource-id> src/invoice.ts --max-lines 80',
        ],
      },
      {
        title: 'Lanes and collisions',
        narrative: (
          <p>
            Every worktree lane in the Space is listed with its branch, status and base commit. Before two lanes
            collide at merge time, <code>tm8 project contention</code> intersects the files each active lane has
            touched and names the overlapping pairs. A lane it could not read is listed as skipped, never silently
            dropped.
          </p>
        ),
        commands: ['worktree list', 'project contention', 'session spawn'],
        demo: [
          'tm8 worktree list --space <space-id> --status active',
          'tm8 project contention <project-resource-id>',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A project is mostly a destination. Its one named inbound edge, <strong>in this project</strong>, is how
        tasks, sessions, pull requests, commits and artifacts say which codebase they belong to. The other edge is{' '}
        <strong>mounted in</strong>, for containers that bind-mount the project&rsquo;s folder. Everything else is the
        general-purpose wiring every entity shares.
      </p>
    ),
    notes: {
      in_project:
        'Space-local association to this project. Sessions and tasks carry it for the work, and pull requests and commits for attribution, which tm8 project association correct can fix.',
      mounts: 'A container that bind-mounts the project folder. An untrusted project needs explicit confirmation first.',
    },
    spotlight: ['work_session', 'task', 'pull_request', 'commit'],
  },
};
