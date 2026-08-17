/**
 * Resume, for every host that renders `EntityDetailPanel` — not just one.
 *
 * WHY THIS IS A HOOK AND NOT FOUR COPIES. Resume was written inline in
 * `WorkspaceView`, so the other four call sites of `EntityDetailPanel`
 * (`EntityView`'s detail and aux panels, `ChannelView`, `GraphScreen`) rendered
 * the same exited-session card with no `onResume` — and `ExitedFallback`
 * correctly reported "Resume is not wired on this surface yet." The same exited
 * session therefore offered a live button on one screen and a dead one on the
 * next, which reads as a fact about the SESSION and is a fact about the SCREEN.
 *
 * Copying the handler into each view would have shipped four in-flight guards
 * and four error-notice dialects that drift apart. There is one resume verb, so
 * there is one executor, and each host only says where its seam is.
 *
 * THE IN-FLIGHT GUARD IS NOT COSMETIC. Resume boots a real agent process, and a
 * double-fire races two spawns onto one session id. The server refuses the
 * second with `conflict`, but the honest UI is to not send it.
 *
 * ABSENT SEAM ⇒ A REASON, NEVER SILENCE. A host that cannot resume returns
 * `unavailableReason` instead of a callback, so the button still renders —
 * disabled, carrying why. Hiding it would claim the session is unresumable,
 * which is a different statement about a different subject.
 */
import { useCallback, useState } from 'react';
import type { CommandResult, EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { Notice } from '../shell/notices';

export interface SessionResume {
  /** Bound to `EntityDetailPanel.onResumeSession`. Absent ⇒ no seam here. */
  resume?: (entityId: string) => void;
  /** The session currently resuming, or null. Bound to `resumingSession`. */
  resumingId: string | null;
  /**
   * Set iff `resume` is absent. Bound to `resumeSessionDisabledReason` so the
   * card states the host's true limitation rather than the generic unwired copy.
   */
  unavailableReason?: string;
}

export interface SessionResumeOptions {
  /** Optional because `GraphScreenData.seam` is: without it, Debug and resume
      both render their explained absence rather than a broken control. */
  seam?: Pick<Seam, 'commands'> | undefined;
  /** Folds the command's authoritative detail back into the store. */
  reconcile?: ((result: CommandResult) => void) | undefined;
  onNotice: (notice: Notice) => void;
}

export function useSessionResume({ seam, reconcile, onNotice }: SessionResumeOptions): SessionResume {
  const [resumingId, setResumingId] = useState<string | null>(null);

  const resume = useCallback(
    (entityId: string) => {
      if (!seam) return;
      setResumingId(entityId);
      void seam.commands
        .resume(entityId as EntityId, { clientMutationId: `resume:${entityId}:${Date.now()}` })
        .then((result) => reconcile?.(result))
        .catch((error: unknown) => {
          onNotice({
            id: 'session-resume-failed',
            tone: 'error',
            title: 'Session could not be resumed',
            // The server's refusal, verbatim. Resume fails for REASONS a user
            // can act on — no native id recorded, the concurrency cap, an
            // ambiguous Codex rollout — and paraphrasing them discards the
            // remedy along with the wording.
            body: String((error as { message?: string })?.message ?? error),
            ttlMs: 8_000,
          });
        })
        .finally(() => setResumingId(null));
    },
    [seam, reconcile, onNotice],
  );

  if (!seam) {
    return {
      resumingId: null,
      unavailableReason: 'This screen has no connection to the node that owns the session.',
    };
  }
  return { resume, resumingId };
}
