/**
 * FILE — the Entity Help page for the `file` kind (Wave 3).
 *
 * Every claim here was checked against this build: the upload composition
 * (`cli/src/commands/file.ts`), the files service
 * (`server/src/facade/services/w2/files.ts`), the contract's file DTOs, the
 * upload and attachment SQL (migrations 019, 022, 152) and the edge-type
 * registry (`domain/edge-kinds.ts`).
 */
import { Stagger } from '../motion/Reveal';
import { TypedTerminal } from '../motion/TypedTerminal';
import type { KindHelpModule } from '../types';

export const FILE_HELP: KindHelpModule = {
  kind: 'file',

  story: {
    logline: 'Bytes from one machine, sealed under a checksum and given a place every session can reach.',

    opening: (
      <>
        <p>
          A file is a blob that became an entity. It has a name, a MIME type, a size and a SHA-256, and it stands in
          the graph beside the task that needed the screenshot and the message that carried the log.
        </p>
        <p>
          Without it, a trace is a path on somebody&apos;s disk. Another session cannot open it, a human in the
          browser cannot preview it, and nothing records which bytes the conversation was actually about.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The journey',
        title: 'Bytes in, an entity out, a message carries it',
        body: (
          <>
            <Stagger step={140} className="eh-prose">
              <p>
                <span className="eh-eyebrow">01 Declare</span> The caller names the bytes before sending them: name,
                MIME type, size and checksum. The server reserves an upload slot and hands back a grant.
              </p>
              <p>
                <span className="eh-eyebrow">02 Seal</span> The bytes land in the slot. On completion the server
                checks them against what was declared, and only then does the file entity exist.
              </p>
              <p>
                <span className="eh-eyebrow">03 Carry</span> The new file hangs on the things that need it, a task
                or a message, through <code>attached_to</code> edges.
              </p>
            </Stagger>
            <TypedTerminal
              title="one upload, one attachment"
              lines={[
                '# declare, stage, verify and attach in one command',
                'tm8 file upload ./repro.har --attach-to <task-id>',
                '# the new file id rides the next message',
                'tm8 message send --to <task-id> "Repro trace" --attach <file-id>',
              ]}
            />
          </>
        ),
      },
      {
        eyebrow: 'Why it declares first',
        title: 'The checksum is agreed before a byte moves',
        body: (
          <p>
            A slot is reserved against a declared size and SHA-256 and lives for fifteen minutes. Completion re-reads
            the staged bytes and refuses a mismatch, so a half-sent or corrupted upload never becomes a file. The size
            ceiling is a deployment setting, 512 MiB by default, and every grant carries the effective value.
          </p>
        ),
      },
      {
        eyebrow: 'Why it is born done',
        title: 'A file is a fact, not a job',
        body: (
          <p>
            Nobody works a file. It records that these bytes arrived, so it enters the graph already in the done
            category, like a commit or a message. That is why the list shows a gallery and no board: there is no
            status to move it through.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'The bytes never change under one id',
        body: (
          <p>
            A download is served with its checksum as the ETag, so a reader can revalidate for free and resume a
            partial copy with a byte range. There is no edit for content. New bytes are a new upload, and a new
            file.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Deleted softly, attached no longer',
        body: (
          <p>
            <code>tm8 entity delete</code> soft-deletes a file and <code>tm8 entity restore</code> brings it back.
            While it is deleted, downloads answer not found and no message will accept it as an attachment. An upload
            that never completes is swept once its slot expires, and its staged bytes are removed.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Reserved', note: 'A slot holds the declared name, size and checksum for fifteen minutes.' },
      { name: 'Staged', note: 'The bytes sit in the slot, not yet trusted.' },
      { name: 'Sealed', note: 'Size and checksum verified; the file entity is born done.' },
      { name: 'Attached', note: 'Tasks and messages carry it through attached_to edges.' },
      { name: 'Deleted', note: 'Soft-deleted: unreadable and unattachable until restored.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal a file is two motions: hand bytes to the server, and take them back out. Everything between
        is the graph. You attach the file to the work it belongs to, and you reference it by its entity id, never by
        the path it came from.
      </p>
    ),

    scenes: [
      {
        title: 'Hand it over',
        narrative: (
          <p>
            <code>tm8 file upload</code> is a composition: it reserves the slot, sends the bytes and completes the
            upload, each stage under its own mutation id derived from one root. Pass <code>--attach-to</code> and the
            edges are written in the same transaction that creates the file. Reading from stdin needs a{' '}
            <code>--name</code>. If a stage fails, the CLI aborts the slot for you.
          </p>
        ),
        commands: ['file upload', 'file upload abort'],
        demo: [
          '# a path names itself',
          'tm8 file upload ./crash.log --attach-to <task-id>',
          '# stdin must be named',
          'tm8 file upload - --name build.log --mime text/plain < build.out',
        ],
      },
      {
        title: 'Put it in the conversation',
        narrative: (
          <p>
            A message carries up to sixteen files. Attach them as you send, or let the author add and remove them
            later under the message&apos;s version. The server refuses a file that is not finalized, is deleted, lives
            in another space, or has a narrower audience than the message it would ride.
          </p>
        ),
        commands: ['message send', 'message attachment add', 'message attachment remove'],
        demo: [
          'tm8 message send --to <task-id> "Log from the failing run" --attach <file-id>',
          '# forgot one; carry the version you read',
          'tm8 message attachment add <message-id> <file-id> --expect-version 1',
        ],
      },
      {
        title: 'Take it back out',
        narrative: (
          <p>
            <code>tm8 file download</code> answers with raw bytes, to a path or to stdout. Stdout is refused under a
            structured format, because bytes and JSON cannot share a stream, and an existing path is refused unless
            you pass <code>--overwrite</code>. Both are checked before a byte is fetched. When you only need to know
            what the file is, a context call is enough.
          </p>
        ),
        commands: ['file download', 'entity context'],
        demo: [
          'tm8 entity context <file-id>',
          'tm8 file download <file-id> --output ./crash.log',
        ],
      },
    ],

    commands: ['entity delete', 'entity restore'],
  },

  constellation: {
    intro: (
      <p>
        A file points outward. Its one defining wire is <code>attached_to</code>, and it runs from the file to
        whatever needs it: a task, a message, a doc. Follow that edge first; everything else is the web every kind
        shares.
      </p>
    ),

    notes: {
      'attached_to:outgoing':
        'The file hangs on its target. Uploads write these at completion, and message attachments are the same edge.',
      'contains:incoming': 'A collection gathers the file among others, in a curated order.',
      'pulled:incoming': 'A member or teammate adopted the file into a local projection.',
    },

    spotlight: ['message', 'task', 'collection', 'member'],
  },
};
