/**
 * THE TRANSCRIPT, READ ONCE FOR EVERY SURFACE THAT SHOWS IT.
 *
 * `execution.transcript` is now rendered in two places — the Debug surface's
 * "what this agent said" section and the session panel's Transcript surface —
 * and there is exactly ONE reader and ONE turn renderer behind both. The
 * alternative was tried elsewhere in this codebase and is what the
 * `graphSurfaceFor` comment is about: a second copy drifts, and the copy that
 * drifts is always the one nobody is looking at.
 *
 * WHAT THIS FILE DOES NOT DO: it does not interpret the transcript. The
 * `stuck` heuristic, the tail boundary and the token stats stay where they are
 * read, because they are claims about the DATA, and each surface is
 * responsible for which claims it is honest enough to make. Debug makes all of
 * them. The Transcript surface makes the ones a reader of prose needs.
 */
import type { SessionTranscriptPage } from '@tm8/contract';

/** Independent of the journal and the launch record: three reads, three fates. */
export type TranscriptState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; page: SessionTranscriptPage };

export interface UnavailableReason {
  cause: string;
  remedy: string;
}

/**
 * WHY THERE IS NOTHING TO SHOW, in the node's own words.
 *
 * Every arm names a cause the reader can act on or stop worrying about. The
 * default arm is not a fallback for a bug — the contract permits a page with
 * `available:false` and no reason, and saying "the node reported no reason" is
 * the honest rendering of that, rather than inventing one.
 */
export function transcriptUnavailableReason(page: SessionTranscriptPage): UnavailableReason {
  switch (page.unavailableReason) {
    case 'no_native_session_id':
      return {
        cause: 'This session’s agent transcript cannot be identified',
        remedy:
          'it was spawned before tm8 recorded the agent’s own session id — unrecoverable, not an error',
      };
    case 'unsupported_agent_tool':
      return {
        cause: 'This agent writes no transcript tm8 can read',
        remedy:
          'only Claude Code and Codex keep a native transcript; other tools leave nothing behind',
      };
    case 'no_transcript_file':
      return {
        cause: 'No transcript file exists for this session',
        remedy: 'the agent has not written its first turn yet, or the file has since been cleaned up',
      };
    case 'unreadable':
      return {
        cause: 'The transcript file could not be read',
        remedy: 'the file exists but the node could not open it',
      };
    default:
      return {
        cause: 'No transcript is available for this session',
        remedy: 'the node reported no reason',
      };
  }
}

/**
 * WHO SAID IT — and, just as importantly, who this does NOT claim said it.
 *
 * `SessionTranscriptEntry.source` is a bare `'user' | 'assistant'` binary with
 * no author entity and no message id (contract.ts). Two different humans
 * injecting into the same session BOTH land as `'user'` and are
 * indistinguishable here. So the label is the role, never a person: this
 * surface may say "user", and must never say "you" or a display name, because
 * it does not know and cannot find out.
 */
export function transcriptRoleLabel(source: 'user' | 'assistant'): string {
  return source === 'assistant' ? 'agent' : 'user';
}
