/**
 * THE TURN LIST — the only place a transcript entry becomes pixels.
 *
 * Both surfaces that show `execution.transcript` render through this component:
 * the session panel's Transcript surface and the Debug surface's "what this
 * agent said" section. Debug keeps its own stats, tail-boundary and `stuck`
 * blocks around this list, because those are claims about the data rather than
 * the turns themselves — but the turns are drawn once, so the two can never
 * disagree about what the agent said.
 *
 * IT LOOKS EXACTLY LIKE CHAT BECAUSE IT IS CHAT'S TURN (Subhang, 2026-10-18).
 * Each entry is mapped onto the chat thread's own `ChatTurn` shape and drawn
 * by `chat-home/ChatTurn` — the component Chat Home's thread uses — so the
 * byline, the bubble, the markdown, the reading column and the spacing are the
 * chat's by construction, in both themes. This used to be a lifted COPY of
 * `.tch-turn`'s geometry (`.tr-turn`), and the copy had drifted: smaller type,
 * a full-width column, its own byline.
 *
 * WHAT THE MAPPING CAN AND CANNOT CLAIM. A `SessionTranscriptEntry` is
 * `{at, source, text, truncated}`:
 *   - `user` → a user turn with the text as its body. It lands on the input
 *     side the way the viewer's own message does in chat — but the byline says
 *     `user`, never "You" or a name: two humans typing into one session are
 *     indistinguishable here (`transcriptRoleLabel`).
 *   - `assistant` → an agent turn whose text is one `text` PART, which is how
 *     chat draws an answer (the reading column, not a bubble).
 *   - No tool calls, thinking, usage or errors are drawn, because the contract
 *     does not carry them (`SessionTranscriptEntry`: tool arguments and output
 *     are deliberately not read). Those parts would render through the same
 *     `TurnParts` the moment the transcript reader supplied them.
 *   - `truncated` is said in the turn's own text, under what was kept, since a
 *     chat turn has no byline slot for it.
 */
import { useMemo, type ReactNode } from 'react';
import type { ActorSummary, EntityId, SessionTranscriptEntry } from '@tm8/contract';
import { ChatTurn } from '../chat-home/ChatTurn';
import type { ChatTurn as ChatTurnModel } from '../chat-home/types';
import { transcriptRoleLabel } from './transcript-model';
import './transcript.css';

export interface TranscriptTurnsProps {
  entries: readonly SessionTranscriptEntry[];
  /**
   * What sits above the first turn — the top boundary.
   *
   * A SLOT rather than a `partial` flag, because the two surfaces owe the
   * reader different things there and only one of them can act. The Transcript
   * surface renders a boundary that WALKS: it holds the page-back control, the
   * sentinel that trips it, and the earned "this is the beginning" claim when
   * there is nothing older. Debug renders nothing here and states its tail
   * boundary in prose above the list, beside the stats that boundary qualifies.
   * Neither claim belongs to the turn list itself.
   */
  head?: ReactNode;
  testId?: string;
}

/** Said under a turn the READ cut short — not the agent. */
export const TRUNCATED_NOTE = '_… cut short by the transcript read, not by the agent._';

/**
 * One author per ROLE, never per person: there is no person to key on. The ids
 * are stable so the avatar colour is too, which is what keeps the list
 * scannable.
 */
const ROLE_AUTHORS: Record<SessionTranscriptEntry['source'], ActorSummary> = {
  user: {
    id: 'transcript-user' as EntityId,
    kind: 'member',
    displayName: transcriptRoleLabel('user'),
    isAgent: false,
  } as ActorSummary,
  assistant: {
    id: 'transcript-assistant' as EntityId,
    kind: 'team_member',
    displayName: transcriptRoleLabel('assistant'),
    isAgent: true,
  } as ActorSummary,
};

/** A transcript entry as the chat thread's turn shape. Exported for tests. */
export function transcriptEntryToTurn(entry: SessionTranscriptEntry, index: number): ChatTurnModel {
  const text = entry.truncated ? `${entry.text}\n\n${TRUNCATED_NOTE}` : entry.text;
  const isAgent = entry.source === 'assistant';
  return {
    // No message id exists; position + time is unique within one accumulation
    // and stable across a poll that only appends.
    messageId: `transcript:${entry.at ?? 'no-time'}:${String(index)}` as EntityId,
    role: isAgent ? 'assistant' : 'user',
    author: ROLE_AUTHORS[entry.source],
    // `Timestamp` renders an empty string as no time, which is the truth for
    // a record that carried none.
    createdAt: entry.at ?? '',
    body: isAgent ? '' : text,
    parts: isAgent ? [{ seq: 0, kind: 'text', text }] : [],
  };
}

export function TranscriptTurns({ entries, head, testId }: TranscriptTurnsProps) {
  const turns = useMemo(() => entries.map(transcriptEntryToTurn), [entries]);
  return (
    <div className="tr-turns" data-testid={testId ?? 'transcript-turns'}>
      {head}
      {/* Oldest-first, exactly as the server sends it. A tail read backwards is
          unreadable, and reversing here would fight the contract. */}
      {turns.map((turn, i) => (
        <ChatTurn key={`${turn.messageId}`} turn={turn} testId={`transcript-turn-${entries[i]!.source}`} />
      ))}
    </div>
  );
}
