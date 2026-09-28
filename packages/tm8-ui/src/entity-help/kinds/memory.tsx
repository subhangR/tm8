/**
 * MEMORY — the Entity Help page for a scoped, challengeable claim.
 *
 * Every sentence below was checked against this build: the 056 table and its
 * mark-edge vocabulary (db/migrations/056_entity_memory.sql), the create and
 * update doors (facade/services/w2/entities-commands-tracking.ts), the
 * staleness derivation (facade/entity-read.ts `stalenessOf`) and spawn
 * injection (facade/execution-handlers.ts `renderMemories`).
 *
 * THE SIGNATURE MOMENT is the slate: a second filmstrip inside the first beat,
 * where the three required scope lines arrive one take at a time like a clapperboard
 * and `Does not establish` lands last and bold, because it is the line that
 * stops a true claim being over-applied. Under reduced motion the strip is
 * simply whole: same order, same emphasis.
 */
import type { KindHelpModule } from '../types';

const SLATE: readonly { readonly line: string; readonly take: string }[] = [
  { line: 'Ranges over', take: 'The subject scope. Where the claim holds, and the line a later session reads to decide whether to load it.' },
  { line: 'Measured by', take: 'The mechanism. How you know, so the next reader can judge how hard to lean on it.' },
  { line: 'Does not establish', take: 'The edge of the claim. What a careless reader would stretch it to cover, ruled out in writing.' },
];

export const MEMORY_HELP: KindHelpModule = {
  kind: 'memory',

  story: {
    logline: 'A memory is a claim that arrives with its own fine print, and that anyone can take back to court.',

    opening: (
      <>
        <p>
          A memory is one thing somebody found out, written down with the conditions it was found under. It is not a
          note and not a doc. It is a single statement plus three required lines of scope, and when a teammate is
          launched, the memories it holds are handed to it as context in its launch prompt.
        </p>
        <p>
          It exists because agents forget between sessions and humans forget between weeks, and the cheap fix of a
          shared scratchpad fails the moment a fact goes stale. Nobody can tell a checked finding from a guess, or a
          current one from a replaced one. A memory carries its standing with it, so the reader sees what is disputed
          and what was superseded instead of trusting everything equally.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The slate',
        title: 'Every claim is shot with its conditions',
        body: (
          <>
            <p>
              The claim itself is one statement of up to 4,000 characters, and the title is derived from it. It cannot
              be recorded without three more lines, and blank or whitespace-only text is refused at the database, not
              by a form, so no client can skip them.
            </p>
            {/* Zero width, full min-width: the strip scrolls sideways inside the
                beat instead of widening the beats grid to its own length. */}
            <div className="eh-film" data-testid="memory-slate" style={{ width: 0, minWidth: '100%' }}>
              <span className="eh-eyebrow">The slate, three takes</span>
              <ol className="eh-film__strip" aria-label="The three required scope lines of a memory">
                {SLATE.map((row, index) => (
                  <li
                    key={row.line}
                    className="eh-film__frame"
                    style={{ ['--eh-delay' as string]: `${String(400 + index * 260)}ms` }}
                  >
                    <span className="eh-film__number" aria-hidden>
                      {`TAKE ${String(index + 1)}`}
                    </span>
                    <span className="eh-film__name">{row.line}</span>
                    <span className="eh-film__note">
                      {row.line === 'Does not establish' ? <strong>{row.take}</strong> : row.take}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <p>
              An optional <em>measured at</em> timestamp says when the observation was taken. The scope lines travel
              with every summary read, so a list row can show the conditions without fetching the claim.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'Why it has no status',
        title: 'A fact about the past was never to-do',
        body: (
          <p>
            Tasks move through a workflow. A memory does not: it is a recorded observation, born resolved so that a
            task depending on it is never blocked. That is why its list has no status tabs. What changes over its
            life is its <em>standing</em>, and standing is derived from edges, not from a field anyone sets.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Doubt is cheap, clearance is expensive',
        body: (
          <>
            <p>
              A <code>disputes</code> edge must come from a message or another memory, and must carry the quote, what
              was expected, what was observed, and the version it read. A dispute without evidence cannot be written.
            </p>
            <p>
              A <code>verifies</code> edge costs more. It names the mechanism, lists the disputes it answers, pins the
              claim&rsquo;s <strong>current</strong> version, and must come from a different session, or a different
              author, than the one that wrote the claim. You cannot mark your own homework. Edit the claim and the old
              clearance no longer covers it.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'The record',
        title: 'Corrections are new evidence, never erasures',
        body: (
          <p>
            The mark edges <code>disputes</code>, <code>verifies</code>, <code>based_on</code> and{' '}
            <code>supersedes</code> are append-only. They cannot be edited or deleted by hand; a wrong mark is answered
            by a new one. When a claim is replaced, a successor memory <code>supersedes</code> it, and reads resolve
            to the head of that chain. The old claim stays, visibly superseded, so you can see what used to be
            believed and why it changed.
          </p>
        ),
      },
      {
        eyebrow: 'Who is told',
        title: 'Holding a memory is not the same as hearing it',
        body: (
          <p>
            A <code>remembers</code> edge puts a memory in a working set, and anything can hold one: a teammate, a
            task, a session. At launch, the teammate&rsquo;s set and its tasks&rsquo; sets are injected with their
            marks spelled out, so the agent reads <code>[disputed]</code> or <code>[verified]</code> beside the claim.
            Superseded memories are skipped, even if the edge still points at them. Move the edge to the successor, or
            the working set quietly shrinks.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Measured', note: 'Someone observes a thing, by a mechanism they can name.' },
      { name: 'Recorded', note: 'Statement and scope are written. Written inside a session, that session is kept as provenance.' },
      { name: 'Remembered', note: 'A teammate or task holds it, and from the next launch it is injected.' },
      { name: 'Challenged', note: 'Evidence disputes it. It is still injected, carrying its [disputed] mark.' },
      { name: 'Cleared', note: 'An independent verification answers the disputes at the current version.' },
      { name: 'Superseded', note: 'A successor replaces it. Reads resolve to the successor; spawn drops the original.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal, a memory is one create call and a handful of edges. There is no memory noun: you write it
        with <code>tm8 entity create</code>, and everything that gives it standing, from who holds it to who doubts
        it, is an <code>edge create</code>. The server derives the rest, so there is no flag that sets a memory to
        verified.
      </p>
    ),
    scenes: [
      {
        title: 'Record a claim',
        narrative: (
          <p>
            Put the statement and the three scope lines in the content, all required. When you create it from inside a
            work session, the server checks that you really take part in that session before recording it as the
            memory&rsquo;s provenance. Memories take no parent and no selection header: their subject scope already
            is the line a later session reads to decide whether to load them.
          </p>
        ),
        commands: ['entity create', 'edge create'],
        demo: [
          '# statement, mechanism, subjectScope, doesNotEstablish in claim.json',
          'tm8 entity create memory "Retries double-post invoices" --content @claim.json',
          '# hand it to the teammate who will need it next launch',
          'tm8 edge create <teammate-id> remembers <memory-id>',
        ],
      },
      {
        title: 'Doubt it, then clear it',
        narrative: (
          <p>
            A dispute is a message or memory that carries the evidence. Read the claim&rsquo;s current version first,
            because both the dispute and the verification pin it. A verification from the claim&rsquo;s own session is
            refused.
          </p>
        ),
        commands: ['entity context', 'edge create', 'edge list'],
        demo: [
          'tm8 entity context <memory-id>',
          'tm8 edge create <evidence-id> disputes <memory-id> --props @dispute.json',
          '# later, from a different session, answering that dispute',
          'tm8 edge create <check-id> verifies <memory-id> --props @verify.json',
          'tm8 edge list --target <memory-id>',
        ],
      },
      {
        title: 'Replace it without erasing it',
        narrative: (
          <p>
            A small fix can be an <code>entity update</code> under a version guard, and every version stays in the
            history. When the claim itself was wrong, write a successor and let it <code>supersede</code> the old one,
            with a reason. Then move the working-set edges, because spawn will not follow the chain for you.
          </p>
        ),
        commands: ['entity update', 'entity versions', 'edge create'],
        demo: [
          'tm8 entity versions <memory-id>',
          'tm8 edge create <successor-id> supersedes <memory-id> --props @reason.json',
          'tm8 edge create <teammate-id> remembers <successor-id>',
        ],
      },
    ],
    commands: ['edge list', 'entity versions', 'entity context'],
  },

  constellation: {
    intro: (
      <p>
        A memory&rsquo;s whole standing lives in its edges. Look first at <strong>who remembers it</strong>, because
        that decides who is told, then at the marks: what it is based on, what disputes or verifies it, and whether a
        successor supersedes it. The work session it was written in sits apart, so moving working sets never rewrites
        who wrote what.
      </p>
    ),
    notes: {
      'remembers:incoming':
        'The working set. Anything can hold a memory; teammates and tasks are the holders injected at launch.',
      'supersedes:outgoing': 'This claim replaces an older one. Reads of the old one resolve here.',
      'supersedes:incoming': 'A newer claim replaced this one. Spawn skips it; the record keeps it.',
      'based_on:outgoing':
        'Pins the version it rests on. If that entity changes, the memory reads as basis moved; if deleted, basis deleted.',
      'disputes:incoming': 'Evidence against this claim, pinned to a version. Open until a verification answers it.',
      'verifies:incoming': 'An independent clear of the current version. An edit makes it stop counting.',
      'disputes:outgoing': 'This memory is itself the evidence against something else.',
      'verifies:outgoing': 'This memory is the independent check that clears something else.',
      'authored_from:outgoing': 'The session or chat it was written in. Recorded by the server, never drawn by a client.',
      'about:outgoing': 'What the claim concerns. Unpinned and correctable, because filing mistakes happen.',
      'consumes:incoming': 'A task that reads this memory as an input.',
      'produces:incoming': 'A task that produced this memory as its output.',
    },
    spotlight: ['task', 'work_session', 'chat'],
  },
};
