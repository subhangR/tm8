/**
 * FORM — Entity Help, Wave 1 (task 01a0e7d6).
 *
 * Fact sources, so a later edit can re-check them rather than trust the prose:
 *   five question types; choice write-in on by default     contract forms.ts
 *   responses per_member (default) | single | unlimited;   contract forms.ts FormSettings
 *   allowAmend true; respondents humans; delivery resume
 *   agents create open, humans draft                       migration 211 forms_ops (create_form)
 *   attention on open, cleared by answer/close/cancel      migrations 211, 266
 *   structure freezes at the first SUBMITTED response      migration 209 form_structure_frozen
 *   delivery: outbox → form_response session input, once   migration 214; server w2/form-delivery.ts
 *   not live → resume | queue | spawn_new; redeliver       w2/form-delivery-spawn.ts; migration 221
 *   draft → open → closed → open; cancel from draft|open   catalog notes on `form open` / `form cancel`
 *
 * THE SIGNATURE is the round trip: the question leaves a session, raises a
 * human's attention, and the answer comes home into the session that asked.
 */
import type { KindHelpModule } from '../types';
import { SignatureStage, at } from './SignatureStage';

function RoundTrip() {
  return (
    <SignatureStage caption="The round trip" label="A form travelling from an agent to a human and back" className="ehs-form">
      <div className="ehs-form__row">
        <section className="ehs-form__station ehs-in" style={at(0)} aria-label="The asking session">
          <span className="ehs-form__label">Session</span>
          <code className="ehs-form__cmd ehs-in" style={at(350)}>
            tm8 form create …
          </code>
          <span className="ehs-chip ehs-chip--info ehs-pop" style={at(3900)}>
            ⤓ form_response turn
          </span>
        </section>

        <span className="ehs-form__arrow ehs-grow" style={at(850)} aria-hidden />

        <section className="ehs-form__station ehs-form__station--form ehs-in" style={at(1050)} aria-label="The form">
          <span className="ehs-form__label">
            Form <span className="ehs-chip ehs-chip--run">open</span>
          </span>
          <span className="ehs-form__q">Which retry policy should the importer use?</span>
          <ul className="ehs-form__options" aria-label="Choices, Fixed selected">
            <li>
              <span className="ehs-form__radio" aria-hidden />
              Exponential backoff
            </li>
            <li className="ehs-form__picked">
              <span className="ehs-form__radio" aria-hidden>
                <span className="ehs-form__radio-dot ehs-pop" style={at(1950)} />
              </span>
              Fixed, three tries
            </li>
            <li>
              <span className="ehs-form__radio" aria-hidden />
              Other…
            </li>
          </ul>
          <span className="ehs-chip ehs-chip--wait ehs-pop" style={at(1450)}>
            attention raised
          </span>
        </section>

        <span className="ehs-form__arrow ehs-grow" style={at(2250)} aria-hidden />

        <section className="ehs-form__station ehs-in" style={at(2450)} aria-label="The person answering">
          <span className="ehs-form__label">You</span>
          <span className="ehs-form__submit ehs-pop" style={at(2750)}>
            Submit
          </span>
          <span className="ehs-form__small">stored as a response, attention cleared</span>
        </section>
      </div>

      <svg className="ehs-form__return" viewBox="0 0 600 44" preserveAspectRatio="none" aria-hidden>
        <path className="ehs-form__return-line ehs-draw" d="M520 2 L520 30 Q520 40 510 40 L90 40 Q80 40 80 30 L80 6" pathLength={1000} style={at(3050)} />
        <path className="ehs-form__return-head ehs-pop" d="M73 14 L80 4 L87 14" style={at(3800)} />
      </svg>
      <p className="ehs-form__return-label ehs-in" style={at(3300)}>
        delivered once, into the session that asked
      </p>
      <p className="ehs-note">
        If that session has ended, the form&rsquo;s delivery setting decides what happens. By default the session is
        resumed and then handed the answer. The setting can also queue the answer until the session is live again, or
        spawn a fresh session for the same teammate and task. A resume that cannot happen is never quietly turned into
        a spawn.
      </p>
    </SignatureStage>
  );
}

export const FORM_HELP: KindHelpModule = {
  kind: 'form',

  story: {
    logline: 'A question an agent puts to a human, with the answer delivered straight back to whoever asked.',
    opening: (
      <>
        <p>
          A <strong>form</strong> is a short set of structured questions (a choice, a scale, a line of text) put to
          the people in a Space. When an agent reaches a decision it should not make alone, it asks with a form rather
          than in prose. The answer comes back as data, into the very session that asked.
        </p>
        <p>
          Asking in a message has two problems. The reply arrives in words that someone has to interpret, and the
          asker has to be alive to hear it. A form fixes both. The question has a shape, the answer is validated
          against it, and delivery is durable. Everyone can see whether the question has been answered.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'The signature',
        title: 'The round trip',
        body: (
          <>
            <p>
              Opening a form raises an attention request, so it rises to the top of someone&rsquo;s list. Submitting
              stores the response, clears the request and writes a delivery to the session that created the form.
              The server turns that into a <code>form_response</code> turn in the session, exactly once per response
              and session. The agent can block on <code>tm8 form wait</code>, but it does not have to, because the
              answer arrives either way.
            </p>
            <RoundTrip />
          </>
        ),
      },
      {
        eyebrow: 'Who asks, who answers',
        title: 'Agents ask, humans answer',
        body: (
          <p>
            By default only humans may respond, and an agent&rsquo;s answer is refused. That is the point of asking.
            An agent&rsquo;s form is born <em>open</em>, because it needs the answer now. A person&rsquo;s form is born
            as a <em>draft</em>, to be shaped before anyone sees it. Forms are made whole, in one call with their
            questions, never from a bare title. That is why the list has no New button. In the panel, people fill a
            form in, adjust its questions while that is still allowed, and read the responses.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Frozen at the first answer',
        body: (
          <p>
            Until the first response is submitted, questions can be added, edited, moved and removed. Saved drafts do
            not count. Once a response is in, the questions, the sections and the response policy freeze, and every
            response keeps a copy of the questions it answered. An answer always means what the question said when
            it was given.
          </p>
        ),
      },
      {
        eyebrow: 'How many answers',
        title: 'One each, one in all, or as many as it takes',
        body: (
          <p>
            By default a form takes one current response per member. A <em>single</em> form holds one current response
            for the whole form, so whoever answers first settles it. An <em>unlimited</em> form keeps collecting. Amending is on by default:
            submitting again makes a new revision and delivers it again, and the history is kept. There are five
            question types (single choice, multiple choice, short text, long text and a scale), and the choice types
            accept a write-in answer unless told not to.
          </p>
        ),
      },
      {
        eyebrow: 'Nobody hangs',
        title: 'Every ending is told',
        body: (
          <p>
            Closing a form stops new responses, and reopening lets them back in. Cancelling, from draft or open only,
            tells the requester, so a waiting agent never waits forever. <code>tm8 form wait</code> exits with its own
            code when the form closes or is cancelled first. If a delivery could not land, the respondent, the author
            or a Space admin can redeliver it to a new session.
          </p>
        ),
      },
    ],
    lifecycle: [
      { name: 'Draft', note: 'A person’s form starts here, and its questions can change freely.' },
      { name: 'Open', note: 'Answers accepted and attention raised. An agent’s form is born here.' },
      { name: 'First answer', note: 'Still open, but the first submission freezes the questions. Each response goes to the asking session.' },
      { name: 'Closed', note: 'No further responses. Reopen puts it back to open.' },
      { name: 'Cancelled', note: 'Only from draft or open. The requester is told, so nothing waits forever.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        A form is the one tool an agent has for asking a person something and getting a structured answer back.
        Questions and answers are validated locally against the form contract first. An invalid one exits before
        anything is sent, with the key, code and message for each problem.
      </p>
    ),
    scenes: [
      {
        title: 'Ask',
        narrative: (
          <p>
            One call creates the form, its questions and its settings, and prints the form id and its URL. Shorthand
            questions read <code>key:type:title:options</code>. From an agent the form is born open and answers come
            back to the calling session. Waiting is optional, and <code>tm8 form wait</code> prints the exact command
            to resume if it times out.
          </p>
        ),
        commands: ['form create', 'form wait'],
        demo: [
          "tm8 form create --title \"Pick the retry policy\" --question 'policy:single_choice:Which retry policy?:Exponential*,Fixed'",
          'tm8 form wait <form-id> --timeout 600',
        ],
      },
      {
        title: 'Shape it before anyone answers',
        narrative: (
          <p>
            Every structural edit carries the form&rsquo;s version and works only until the first submitted response.
            After that the server refuses it, because the answers already given must keep meaning what they meant.
          </p>
        ),
        commands: ['form question add', 'form question update', 'form question move', 'form question remove', 'form update', 'form open'],
        demo: [
          "tm8 form question add <form-id> --expect-version 2 --question 'why:long_text:What drove the choice?' --optional why",
          'tm8 form open <form-id> --expect-version 3',
        ],
      },
      {
        title: 'Answer',
        narrative: (
          <p>
            <code>tm8 form pending</code> lists the open forms that sessions are waiting on you to answer. A draft
            answer can be saved and finished later. It still counts as waiting until you submit. With no{' '}
            <code>--answers</code>, submit sends the draft you saved.
          </p>
        ),
        commands: ['form pending', 'form response save', 'form submit'],
        demo: ['tm8 form pending <work-session-id>', '# submits the draft you saved', 'tm8 form submit <form-id>'],
      },
      {
        title: 'Read, end and recover',
        narrative: (
          <p>
            By default <code>tm8 form response list</code> shows the current revision of each response. Pass{' '}
            <code>--lineage</code> to see one response&rsquo;s whole history. When a delivery was cancelled because
            its session was deleted, could not resume or failed to spawn, redeliver it to a new session.
          </p>
        ),
        commands: ['form response list', 'form response get', 'form response redeliver', 'form close', 'form cancel', 'form reopen'],
        demo: [
          'tm8 form response list <form-id> --limit 20',
          'tm8 form response redeliver <response-id> --to new_session',
          'tm8 form close <form-id> --expect-version 5 --reason "decided in standup"',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A form has one edge that matters above the others: <strong>authored in</strong>, which records the session
        it was asked from. The server writes it when the form is created, and it is how a submitted answer finds its
        way home. Next is <strong>attached to</strong>: the form attaches itself to every task its session is working on, so the
        question shows up where the work is. Everything else is the general-purpose wiring every entity shares.
      </p>
    ),
    notes: {
      'authored_from:outgoing':
        'The session the form was asked from. The server records it at creation, and it is the address every response is delivered to.',
      'attached_to:outgoing':
        'Written at creation. The form is attached to every task the asking session is working on, plus anything named with --attach, so the question shows up where the work is.',
      'anchored_to:incoming': 'The discussion under the form: messages anchored to it.',
    },
    spotlight: ['work_session', 'message', 'collection'],
  },
};
