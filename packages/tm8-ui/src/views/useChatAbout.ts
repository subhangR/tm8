/**
 * THE "CHAT ABOUT THIS" DISPATCHER — the executor behind `chat-about`.
 *
 * ITS OWN HOOK, beside `useSessionStart` and `usePanelPrimaries`, for the
 * reason those two are separate from each other: a dispatcher is defined by
 * what it can PERFORM, and each of these three performs a different kind of
 * thing. `usePanelPrimaries` binds to one entity and sends commands about it;
 * `useSessionStart` takes a space and a project and starts a process. This one
 * sends nothing at all — it NAVIGATES, and its whole input is an optional
 * subject. Folding it into either would have put a `navigate` into a hook
 * whose docblock says it is a command executor, and its verb would have landed
 * in that hook's `wiredActions` where a reader looks for commands.
 *
 * WHY A NAVIGATION AND NOT A COMMAND. `chat.start` needs a teammate, a model
 * and a mode. A tile's action cluster is a row of 16px icons and a list header
 * is one line — neither can ask for three choices, and picking them on the
 * member's behalf is exactly the "a spawn's configuration must be visible when
 * it is committed" rule this codebase already follows for `launch-session`. So
 * the verb opens the composer with the subject bound (`/home/chat?about={id}`)
 * and the human commits it there.
 *
 * THE SUBJECT RIDES THE ADDRESS, not component state, and that is load-bearing
 * in three ways a local variable could not be: a reload keeps it, Back
 * abandons it, and the link can be sent to someone else.
 */
import { useCallback, useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ActionRef } from '../domain';
import type { Route } from '../routes/types';

/**
 * Exactly what this dispatcher performs, exported as a CONSTANT for the same
 * reason `PANEL_PRIMARY_ACTIONS` and `SESSION_START_ACTIONS` are: a host
 * cannot hand a surface a list that has drifted from the switch below, and a
 * verb outside the list keeps its honest disabled-with-reason instead of
 * lighting up and doing nothing.
 */
export const CHAT_ABOUT_ACTIONS: readonly ActionRef[] = ['chat-about'];

export interface ChatAboutHost {
  /**
   * The shell's route verb, already bound to Home's composer. OPTIONAL, and
   * absence is meaningful: `onAction` is then `undefined`, so `HeaderActions`
   * and `RowActionCluster` draw the verb REFUSED with a reason rather than a
   * button that does nothing. That is the same gate `useSessionStart` puts on
   * `canStart`, and for the same measured reason — an enabled-inert control is
   * the failure mode all three of these hooks exist to end.
   *
   * SUPPLIED BY THE SHELL rather than taken from the nav store here, because
   * two of the three hosts (`WorkspaceView`, `EntityView`) take navigation as
   * a PORT (`nav: NavPort`) and importing the global store into them would be
   * a second, unmockable route out of screens whose charter is that they have
   * exactly one.
   */
  open?: ((aboutId: EntityId | null) => void) | undefined;
}

export interface ChatAbout {
  /** The list panel's `onAction` prop — `(ref, entityId)`. Undefined when the
   *  host wired no route verb, so the control refuses out loud. */
  onAction?: ((ref: ActionRef, entityId: string) => void) | undefined;
  /** The detail panel's `onAction` prop, bound to one entity. */
  forEntity(entityId: string): ((ref: ActionRef) => void) | undefined;
  /** Both panels' `wiredActions` prop. */
  wiredActions: readonly ActionRef[];
  /** The verb unwrapped, for a host with its own affordance. */
  open(aboutId: EntityId | null): void;
}

/**
 * The route "Chat about this" lands on, built once so the three hosts and the
 * shell cannot disagree about where the verb goes.
 *
 * `threadId: null` IS THE COMPOSER, not merely a bare address. In solo mode
 * the screen reads a null route thread as the new-conversation composer; on
 * Home it coexists with the screen's own column, which is the surface this
 * lands on. Either way "no thread, and a subject" is unambiguous: nothing is
 * open, and this is what the next one is about.
 */
export function chatAboutTarget(aboutId: EntityId | null): Route['target'] {
  return {
    view: 'home',
    root: { type: 'chats', threadId: null, ...(aboutId ? { aboutId } : {}) },
  };
}

export function useChatAbout(host: ChatAboutHost): ChatAbout {
  const hostOpen = host.open;

  const open = useCallback(
    (aboutId: EntityId | null) => {
      /* Unreachable through `onAction`, which is undefined without a host
         verb — see the prop's docblock. A host calling `open` directly without
         one has wired a control it cannot perform, and absorbing that as a
         no-op is how a dead button survives review. */
      if (!hostOpen) {
        throw new Error(
          'useChatAbout.open was called with no host verb: the surface rendered a control it cannot '
            + 'perform. Gate the affordance on `onAction != null`, which is undefined precisely so this '
            + 'cannot happen.',
        );
      }
      hostOpen(aboutId);
    },
    [hostOpen],
  );

  const onAction = useCallback(
    (ref: ActionRef, entityId: string) => {
      /*
       * A SWITCH, not a lookup with a default: an unhandled verb must be
       * unreachable rather than silently absorbed. `CHAT_ABOUT_ACTIONS` is
       * what keeps it unreachable, and the two are edited together or the
       * guard is decorative. (`useSessionStart` states the same rule.)
       */
      switch (ref) {
        case 'chat-about':
          /* An EMPTY id is the list HEADER, which has no row — the panel
             passes `ctx.entityId ?? ''`. That is a chat about nothing, which
             is bare Home's new conversation and exactly what pressing it from
             a list of chats should mean. Not an error to swallow. */
          open(entityId ? (entityId as EntityId) : null);
          return;
        default:
          return;
      }
    },
    [open],
  );

  const forEntity = useCallback(
    (entityId: string) => (hostOpen ? (ref: ActionRef) => onAction(ref, entityId) : undefined),
    [hostOpen, onAction],
  );

  return useMemo(
    () => ({
      ...(hostOpen ? { onAction } : {}),
      forEntity,
      wiredActions: CHAT_ABOUT_ACTIONS,
      open,
    }),
    [hostOpen, onAction, forEntity, open],
  );
}

/**
 * Compose a LIST's dispatchers — the `(ref, entityId)` shape.
 *
 * `composePanelActions` (usePanelPrimaries) does this for the panel's
 * `(ref)` shape and cannot be reused: a list dispatcher takes the row's id,
 * and a wrapper that dropped it would send every verb to whichever entity the
 * panel happened to be holding. Same routing rule as its twin — the FIRST
 * part that names the verb performs it — so two dispatchers can never both
 * fire on one press.
 */
export function composeListActions(
  parts: readonly {
    onAction?: ((ref: ActionRef, entityId: string) => void) | undefined;
    wiredActions: readonly ActionRef[];
  }[],
): { onAction: (ref: ActionRef, entityId: string) => void; wiredActions: readonly ActionRef[] } {
  const live = parts.filter((part) => part.onAction);
  return {
    onAction: (ref, entityId) => {
      live.find((part) => part.wiredActions.includes(ref))?.onAction?.(ref, entityId);
    },
    wiredActions: live.flatMap((part) => [...part.wiredActions]),
  };
}
