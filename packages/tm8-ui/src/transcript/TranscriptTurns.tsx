/**
 * THE TURN LIST — the only place a transcript entry becomes pixels.
 *
 * Both surfaces that show `execution.transcript` render through this component:
 * the session panel's Transcript surface and the Debug surface's "what this
 * agent said" section. That is the whole point of it existing. Debug keeps its
 * own stats, tail-boundary and `stuck` blocks around this list, because those
 * are claims about the data rather than the turns themselves — but the turns
 * are drawn once, so the two can never disagree about what the agent said.
 *
 * VISUAL PARITY WITH CHAT IS A REQUIREMENT, NOT A FLOURISH (Subhang, direct):
 * this reads as a conversation because it IS one. The bubble geometry is lifted
 * from Chat Home's `.tch-turn` block rather than imported, following the
 * precedent set when the Work tab adopted Chat Home's list header
 * (`panels/list-root-header.css:4`) — importing `chat-home.css` would drag in a
 * full-screen grid, a sidebar, a composer and a graph pane for three rules.
 *
 * WHAT SIDEDNESS MEANS HERE, AND WHAT IT CANNOT MEAN. Chat Home puts the
 * VIEWER's turns on the right and decides that by author identity. A transcript
 * entry has no author — `source` is a bare `'user' | 'assistant'` binary, so
 * two humans injecting into one session are indistinguishable. The right-hand
 * side therefore means "came in as user input", NOT "was you", and the label
 * says `user`, never a display name. Same geometry, weaker and honest claim.
 *
 * ONLY THE INPUT SIDE IS A BUBBLE, which is what Chat Home does too: its
 * assistant turns render as a left reading column, because an answer is
 * something you read rather than a remark you exchange. A session agent's turn
 * routinely runs to hundreds of lines, and boxing that produces a wall of card.
 * The byline keeps the avatar and the timestamp on both sides, which is what
 * makes it read as a conversation.
 */
import type { SessionTranscriptEntry } from '@tm8/contract';
import { Avatar } from '../kit/Avatar';
import { Markdown } from '../kit/Markdown';
import { Timestamp } from '../kit/Timestamp';
import { chatMarkdownSource } from '../channel-screen/feed-model';
import { transcriptRoleLabel } from './transcript-model';
import './transcript.css';

export interface TranscriptTurnsProps {
  entries: readonly SessionTranscriptEntry[];
  /** Marks the top of the list as a tail boundary rather than a beginning. The
   *  server reads backwards from the end and there is no cursor, so an
   *  unmarked first turn reads as "this is where the session started" — which
   *  is false whenever the window is partial. */
  partial?: boolean;
  testId?: string;
}

export function TranscriptTurns({ entries, partial = false, testId }: TranscriptTurnsProps) {
  return (
    <div className="tr-turns" data-testid={testId ?? 'transcript-turns'}>
      {partial ? (
        <p className="tr-turns__boundary" data-testid="transcript-tail-boundary">
          Showing the most recent turns. The transcript is read as a tail, so earlier turns exist
          above this line and cannot be paged back to.
        </p>
      ) : null}
      {/* Oldest-first, exactly as the server sends it. A tail read backwards is
          unreadable, and reversing here would fight the contract. */}
      {entries.map((entry, i) => (
        <TranscriptTurn key={`${entry.at ?? 'no-time'}-${String(i)}`} entry={entry} />
      ))}
    </div>
  );
}

function TranscriptTurn({ entry }: { entry: SessionTranscriptEntry }) {
  const label = transcriptRoleLabel(entry.source);
  const isInput = entry.source === 'user';
  return (
    <article
      className="tr-turn"
      data-source={entry.source}
      // Purely visual, and named `data-input` rather than `data-self` because
      // this side does NOT identify a person — see the docblock.
      data-input={isInput ? 'true' : 'false'}
    >
      <header className="tr-turn__byline">
        <Avatar
          // Deterministic per ROLE, not per person: there is no person to key
          // on, and a stable two-colour scheme is what makes the list scannable.
          actorId={`transcript-${entry.source}`}
          provenance={entry.source === 'assistant' ? 'agent' : 'human'}
          label={label}
          size={20}
        />
        <strong>{label}</strong>
        <Timestamp at={entry.at} />
        {entry.truncated ? (
          <span className="tr-turn__truncated" title="This turn was cut short by the read, not by the agent">
            truncated
          </span>
        ) : null}
      </header>
      {/* The same markdown path the chat surfaces use, called with no mentions:
          a transcript carries no mention list, and passing `[]` gets the one
          thing that matters here — a lone newline stays a line break. */}
      <Markdown
        source={chatMarkdownSource(entry.text, []).source}
        className="tr-turn__body"
        testId="transcript-turn-body"
      />
    </article>
  );
}
