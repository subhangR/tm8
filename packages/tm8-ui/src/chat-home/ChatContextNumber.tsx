/**
 * THE CONTEXT NUMBER for a chat — the session strip's chip, on the
 * conversation header.
 *
 * The reading is the chat's own (231): the runtime measures every main-thread
 * request, the server stores the latest on the chat and publishes it as a
 * `chat.context` frame. So there is no tail to poll — the header draws what
 * the entity read carried, replaced by each live frame.
 *
 * A reading from a runtime that is not running is LAST KNOWN, and says so:
 * the conversation it describes has not moved, but nothing is measuring it
 * any more, so it cannot be told apart from a stale one by looking.
 */
import type { SessionTranscriptContext } from '@tm8/contract';
import { useNow, useNowSeconds } from '../kit/time';
import { formatContext } from '../transcript/context-reading';
import { ContextChip } from '../transcript/SessionContextNumber';

/** As on the strip: past a minute the age reads in minutes, and the per-second clock rests. */
const SECONDS_MATTER_MS = 60_000;

export interface ChatContextNumberProps {
  context: SessionTranscriptContext;
  /** Why the reading is no longer updating, or null while the runtime runs. */
  stale: string | null;
}

export function ChatContextNumber({ context, stale }: ChatContextNumberProps) {
  const coarse = useNow();
  const observed = Date.parse(context.observedAt ?? '');
  const young = stale === null && Number.isFinite(observed) && coarse - observed < SECONDS_MATTER_MS;
  const fine = useNowSeconds(young);
  const reading = formatContext(context, Math.max(coarse, fine), { stale });
  return (
    <span className="tch-context">
      <ContextChip reading={reading} fit="medium" testId="chat-context" />
    </span>
  );
}

/** What the header says about a runtime that is not measuring. */
export function staleReason(runtimeState: 'cold' | 'live' | 'stopped' | undefined): string | null {
  if (runtimeState === 'stopped') return "the chat's runtime is stopped; it resumes on the next message";
  if (runtimeState === 'cold') return "the chat's runtime is not running; it starts on the next message";
  return null;
}
