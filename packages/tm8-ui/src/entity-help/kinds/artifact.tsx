/**
 * Entity Help — the artifact kind (wave 3).
 *
 * Every sentence below is checked against this build:
 *   · publish / revisions / preview / export / restore — `packages/cli/src/commands/artifact.ts`
 *     and `packages/server/src/facade/services/w2/artifacts.ts`
 *   · manifest rules and limits — `packages/contract/src/artifact-manifest.ts`
 *   · append-only revisions, preview revocation on delete, authored_from — `db/migrations/055_artifacts.sql`
 *   · sandboxed frame and revision picker — `panels/bodies/GenericBody.tsx`, `domain/registry.ts` (artifact entry)
 *
 * The signature moment is the publish itself: a typed `tm8 artifact publish`
 * followed by a second filmstrip that walks the bytes from a build directory
 * to an immutable revision. Under reduced motion both stand whole.
 */
import { Reveal } from '../motion/Reveal';
import { TypedTerminal } from '../motion/TypedTerminal';
import type { KindHelpModule } from '../types';

const PUBLISH_DEMO = [
  '# a folder of HTML, JS and CSS becomes an entity',
  'tm8 artifact publish ./site --name "Launch dashboard" --summary "Weekly launch metrics"',
  '# later, the same artifact gets its next revision',
  'tm8 artifact publish ./site --artifact <artifact-id> --expect-version <n>',
];

const JOURNEY = [
  { name: './site', note: 'Files on disk. Dot-prefixed and symlinked entries stay behind.' },
  { name: 'Manifest', note: 'Paths sorted, every file hashed, one entrypoint named.' },
  { name: 'Server check', note: 'The hash is recomputed from the bytes, never taken on trust.' },
  { name: 'Revision 1', note: 'Frozen. From here on it can be read, never rewritten.' },
];

export const ARTIFACT_HELP: KindHelpModule = {
  kind: 'artifact',

  story: {
    logline: 'A folder of web files that becomes a page everyone in the space can open, and that never forgets a version.',

    opening: (
      <>
        <p>
          An artifact is a small website living inside tm8. Someone, often an agent at the end of a job, points{' '}
          <code>tm8 artifact publish</code> at a directory of HTML, JavaScript and CSS, and what comes back is an
          entity you can open in the panel and watch run.
        </p>
        <p>
          Before it existed, a built report or prototype stayed on the machine that built it, and the only proof was a
          screenshot or a path nobody else could reach. An artifact carries the actual bytes, every version of them, and
          a record of when and in which space they were published.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The publish moment',
        title: 'A directory walks in, an entity walks out',
        body: (
          <>
            <p>
              Publishing is one command. The CLI reads the folder, builds a strict manifest, and sends the bytes with it.
              The entrypoint is <code>index.html</code> unless you name another file in the bundle.
            </p>
            <TypedTerminal title="artifact publish" lines={PUBLISH_DEMO} />
            <Reveal as="section" className="eh-film" delay={180} data-testid="artifact-journey">
              <span className="eh-eyebrow">From build dir to revision</span>
              <ol className="eh-film__strip" aria-label="How a directory becomes an artifact revision">
                {JOURNEY.map((frame, index) => (
                  <li key={frame.name} className="eh-film__frame" style={{ ['--eh-delay' as string]: `${index * 90}ms` }}>
                    <span className="eh-film__number" aria-hidden>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="eh-film__name">{frame.name}</span>
                    <span className="eh-film__note">{frame.note}</span>
                  </li>
                ))}
              </ol>
            </Reveal>
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Revisions are append-only',
        body: (
          <p>
            A published revision cannot be edited or deleted; the database refuses both. A change is a new revision,
            numbered after the last. Even <code>tm8 artifact restore</code> leaves history alone: it republishes an older
            revision&apos;s exact bytes as the newest one, so the timeline only ever grows.
          </p>
        ),
      },
      {
        eyebrow: 'Why it is model-agnostic',
        title: 'Same bytes, same identity',
        body: (
          <p>
            The manifest records paths, sizes, media types and hashes, and nothing about who or what produced them. The
            server recomputes its hash from the bytes rather than trusting the caller, so two tools that emit identical
            files publish an identical manifest.
          </p>
        ),
      },
      {
        eyebrow: 'How you see it',
        title: 'A frame, not a filing cabinet',
        body: (
          <p>
            The panel is the page itself, running in a sandboxed frame that may run scripts but cannot navigate you away,
            open popups or submit forms. A revision picker lets you step back through history. Each view rides a
            short-lived preview session bound to you, and deleting the artifact revokes any preview still open.
          </p>
        ),
      },
      {
        eyebrow: 'Why it has no status',
        title: 'A fact about the past',
        body: (
          <p>
            An artifact is born done. That is not a verdict on its quality; it means a task that depends on it is never
            left waiting. There is no board to drag it across, because what it records has already happened.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Published', note: 'Revision 1 lands with the entity. It is done from its first moment.' },
      { name: 'Revised', note: 'Each publish against the artifact appends the next revision.' },
      { name: 'Viewed', note: 'The panel or a preview session serves any revision, sandboxed.' },
      { name: 'Restored', note: 'An older revision returns as the newest, history untouched.' },
      { name: 'Deleted', note: 'The entity goes and open previews are revoked with it.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal an artifact is a loop of three moves: publish a folder, check what the timeline holds, and hand a
        revision to whoever needs it. A publish or restore against an existing artifact carries its current version, so
        two publishers never silently race each other.
      </p>
    ),

    scenes: [
      {
        title: 'Ship the folder',
        narrative: (
          <p>
            Publish creates the artifact and its first revision in one call. Pass <code>--when-to-use</code> and{' '}
            <code>--summary</code> in the same call so a later session knows when to open it. To ship an update, point at
            the existing artifact with its current version; without those two flags you get a brand new artifact instead.
          </p>
        ),
        commands: ['artifact publish', 'entity header set'],
        demo: [
          '# first publish: a new artifact, revision 1',
          'tm8 artifact publish ./dist --name "Pricing prototype" --when-to-use "Open when reviewing pricing UI"',
          '# next revision of the same artifact',
          'tm8 artifact publish ./dist --artifact <artifact-id> --expect-version <n>',
        ],
      },
      {
        title: 'Read the timeline',
        narrative: (
          <p>
            <code>tm8 artifact revisions</code> lists every revision, newest first. When the latest one is wrong, restore a
            good one: it becomes the newest revision and the bad one stays in the record, where you can still see it.
          </p>
        ),
        commands: ['artifact revisions', 'artifact restore'],
        demo: [
          'tm8 artifact revisions <artifact-id>',
          '# bring revision 2 back as the newest',
          'tm8 artifact restore <artifact-id> --revision 2 --expect-version <n>',
        ],
      },
      {
        title: 'Hand it over',
        narrative: (
          <p>
            <code>tm8 artifact preview</code> mints a ten-minute session bound to you and prints exactly what the server
            returns; it never opens a browser. <code>tm8 artifact export</code> downloads one revision as a zip, the
            current one unless you ask for another.
          </p>
        ),
        commands: ['artifact preview', 'artifact export'],
        demo: [
          'tm8 artifact preview <artifact-id> --revision 3',
          'tm8 artifact export <artifact-id> --out ./pricing.zip',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        An artifact is usually the end of a thread, not its start. Look first for the task that produced it and the work
        session it came from, then for the collections that shelve it alongside the rest of a piece of work.
      </p>
    ),

    notes: {
      produces: 'A task that names this artifact as its output.',
      consumes: 'A task that reads this artifact as an input.',
      authored_from: 'The work session or chat this artifact was published from, when the publisher recorded one.',
      contains: 'A collection that shelves this artifact. Add it from the collection’s own panel.',
      in_project: 'The project this artifact belongs to.',
      attached_to: 'Context pinned in either direction: what this artifact is attached to, or what is attached to it.',
    },

    spotlight: ['task', 'work_session', 'collection', 'project'],
  },
};
