/**
 * DRAWING — the Excalidraw canvas as an entity (migration 194).
 *
 * The signature moment is a SECOND filmstrip, inside the "one stroke, one
 * save" beat: the three steps between a pen lifting and a version
 * landing. It reuses the Story tab's own `eh-film` markup, so it is sprocketed,
 * staggered and still under reduced motion exactly as the lifecycle strip is —
 * the frames are numbered, so the order survives when nothing moves.
 *
 * Every fact here was checked against 194_drawing_kind.sql, the create/patch
 * arms in the server's entities-commands-tracking.ts, and the panel's
 * DrawingBlock / drawing-scene pair.
 */
import type { KindHelpModule } from '../types';

/** What happens to one stroke, in order. Drawn as a second strip. */
const ONE_STROKE: readonly { name: string; note: string }[] = [
  { name: 'Sifted', note: 'Hundreds of signals per drag. Only shapes and durable settings count; where you look never does.' },
  { name: 'Idle', note: 'Nothing is written until you pause for 900 ms, so a stroke is one save.' },
  { name: 'Kept', note: 'The write carries the version it read and lands as a new version, whole. A stale one loses cleanly.' },
];

export const DRAWING_HELP: KindHelpModule = {
  kind: 'drawing',

  story: {
    logline: 'The whiteboard sketch that used to vanish when the call ended, kept as an entity with a history.',

    opening: (
      <>
        <p>
          A drawing is a canvas you open in the detail panel and draw on. Boxes, arrows, a wireframe, the shape of a
          system scribbled while you explain it. There is no separate studio and no export step. The panel is the
          editor, and what you draw is saved as you go.
        </p>
        <p>
          Before it, a sketch lived in a screenshot pasted into a message, or on a board in some other tab that nobody
          could find a week later. A drawing gives the sketch the same standing as a task or a doc. It has a title, a
          version history, a thread, and it can hang off the work it explains.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it is its own kind',
        title: 'Not a doc format, not a graph',
        body: (
          <p>
            Both of those cheaper homes were offered and declined. A drawing gets its own row, its own panel and its
            own list, so a sketch is something you can find by what it is. The scene is stored in Excalidraw&rsquo;s own
            three parts rather than as one opaque blob, which is what lets the server count a drawing&rsquo;s shapes
            without opening it.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'One stroke, one save',
        body: (
          <>
            <p>
              A canvas is a noisy thing. If every signal it gave off were saved, moving your mouse would cost a version
              and a second viewer would conflict with your scroll. So a stroke passes through three steps before it is kept.
            </p>
            {/* `contain: inline-size` keeps the strip's fixed-width frames from
                widening the beats grid; the strip scrolls sideways instead, as
                the lifecycle strip does. Layout only, no colour. */}
            <div className="eh-film" style={{ contain: 'inline-size' }}>
              <span className="eh-eyebrow">The life of one stroke</span>
              <ol className="eh-film__strip" aria-label="What happens between a stroke and a saved version">
                {ONE_STROKE.map((frame, index) => (
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
        eyebrow: 'One pen at a time',
        title: 'Two editors, one winner',
        body: (
          <p>
            There is no live multiplayer here. A drawing has one writer at a time, under the same version guard as
            every other entity. If someone saves the canvas before you do, your write is refused and the panel says so
            plainly: someone else saved this drawing, reopen it to keep editing. You lose a few seconds of strokes,
            never their whole board.
          </p>
        ),
      },
      {
        eyebrow: 'The honest limit',
        title: 'Images are refused, out loud',
        body: (
          <p>
            A pasted image would be stored inside the scene as base64, and one paste could write tens of megabytes
            into a row with nothing behind it to manage images. So the server refuses a scene that carries one, by name.
            The canvas notices first: the moment an image appears it pauses saving and tells you, before you keep
            drawing on something that cannot be kept. Attach the picture as a <em>file</em> instead.
          </p>
        ),
      },
      {
        eyebrow: 'Where it hangs',
        title: 'Attached, never parented',
        body: (
          <p>
            A drawing that explains a task belongs beside that task, but it cannot be the task&rsquo;s child: a parent
            and its children always share one kind. It hangs off the task through an <code>attached_to</code> edge
            instead, which is why the task panel&rsquo;s attach palette can make a new drawing in place. The same edge
            works for any entity, since its far end admits every kind.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Blank', note: 'A title and an empty canvas. That alone is a real drawing.' },
      { name: 'Drawn', note: 'Each settled stroke is a guarded save and a new version.' },
      { name: 'Attached', note: 'Hung off a task or filed in a collection, where people will look.' },
      { name: 'Deleted', note: 'A soft delete. The row and its versions wait for a restore.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal a drawing is an ordinary entity with an unusual body. You create it with a title, and you can
        seed its scene with Excalidraw JSON if you already have one. Most drawing happens in the panel. The terminal is
        for making the canvas, putting it where people will find it, and reading back what changed.
      </p>
    ),
    scenes: [
      {
        title: 'Open a canvas beside the work',
        narrative: (
          <p>
            Create the drawing and hang it off its task in the same call, so it is never born orphaned. Give it a
            when-to-use line while you are there. A drawing carries a selection header, and that is how a later agent
            knows to open a sketch it cannot read.
          </p>
        ),
        commands: ['entity create', 'entity header set'],
        demo: [
          '# a sketch for the login task, attached as it is born',
          'tm8 entity create drawing "Login wireframe" --attach-to <task-id> --when-to-use "Open when changing the login screen layout"',
          '# the panel draws; the terminal just made the room',
        ],
      },
      {
        title: 'Save a scene you already have',
        narrative: (
          <p>
            A scene written by a script goes in through <code>entity update</code> with the version you last read.
            Name only the parts you change: a patch that carries elements leaves the title and settings alone. If the
            panel saved in between, the version guard refuses you, which is the same single-writer rule the canvas
            lives under.
          </p>
        ),
        commands: ['entity get', 'entity update'],
        demo: [
          '# read the version, then write under it',
          'tm8 entity get <drawing-id>',
          'tm8 entity update <drawing-id> --expect-version 7 --content @scene.json',
          '# someone saved first? read again, merge, retry',
        ],
      },
      {
        title: 'Rewind the board',
        narrative: (
          <p>
            Every saved revision of the canvas is a snapshot of the whole scene, not a diff. The history is the answer
            to &ldquo;what did this diagram look like before the redesign&rdquo;, and a deleted drawing comes back with
            that history intact.
          </p>
        ),
        commands: ['entity versions', 'entity delete', 'entity restore'],
        demo: [
          '# every settled stroke left a version behind',
          'tm8 entity versions <drawing-id> --limit 10',
          '# deleted by mistake? it was only ever soft',
          'tm8 entity restore <drawing-id>',
        ],
      },
      {
        title: 'Hang it where people look',
        narrative: (
          <p>
            A drawing made first and placed later needs an edge. File it in a collection with the other diagrams, or
            attach it to a second piece of work it also explains.
          </p>
        ),
        commands: ['collection add', 'edge create'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A drawing is mostly a leaf. It points outward at the work it explains and is pulled into the places that
        collect it. Start with <code>attached_to</code>: that one edge is how a sketch stops being a loose picture and
        becomes part of a task.
      </p>
    ),
    notes: {
      'attached_to:outgoing': 'The drawing hangs off a task or anything else it explains. The only way to sit beside work, since a drawing can only be parented by another drawing.',
      'contains:incoming': 'A collection files the drawing with its peers. Taking it out deletes the edge, never the drawing.',
      'anchored_to:incoming': 'Messages hang on the drawing, so the argument about the diagram lives next to the diagram.',
      'created_in:outgoing': 'The work session the drawing was made in, as the client reported it.',
      relates_to: 'The general link, when a sketch touches something it neither explains nor belongs to.',
    },
    spotlight: ['task', 'collection', 'message', 'work_session'],
  },
};
