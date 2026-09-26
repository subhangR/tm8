import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import { projectTurnParts } from './turn-model';
import type { ChatThreadDetail, ChatTurn } from './types';

/**
 * ── THE TURN IN PROGRESS, AS ONE VALUE ─────────────────────────────────────
 *
 * Reported by Subhang: "sending a message should immediately show the agent's
 * turn; the agent does a lot of background work and nothing is shown on screen
 * for long periods, only the composer button changes". The composer's phase
 * was the ONLY record that a turn was running, and it cannot say since when,
 * or when the turn last did anything.
 *
 * Measured on the live node (tm8_stable, last 40 chat turns, 2026-09-26): the
 * claim lands in <0.1s, but the first part arrives 3–90s later (avg 14s), and
 * after a tool completes the model is silent for avg 12s (max 74s) before its
 * next block. Tools themselves run in ~0.4s. The silence is MODEL time between
 * whole content blocks, so what a viewer needs during it is "still working,
 * N s since the last step" — two timestamps that no frame carries.
 *
 * THE CONTRACT between the turn pipeline (lane 1: the clock and the phase
 * machine in `ChatHomeScreen`) and the live status row (lane 2, which only
 * reads it). Pinned by the coordinator 2026-09-26; the step words and the step
 * count are NOT here on purpose — the row projects them from the in-flight
 * message's parts, looked up by `messageId`. `null` means nothing is in flight.
 */
export interface TurnInProgress {
  phase:
    /** Our own post / chat.start is in flight — the server has not acked it. */
    | 'sending'
    /** Acked or claimed; no part has arrived yet (queue, claim, runtime spawn,
     *  the model's first block). */
    | 'waiting'
    /** At least one part has arrived for the in-flight agent message. */
    | 'streaming'
    /** Stop was pressed and the interrupt is in flight. */
    | 'stopping'
    /** The viewer stopped the turn; the thread is continuable. Only for a stop
     *  THIS view watched — a thread stopped yesterday is `null` here, and the
     *  composer's own "Stopped · continuable" label covers it. */
    | 'stopped'
    /** The turn ended with an error part. Held until the next send or a thread
     *  switch, so a failure does not vanish the moment it lands. */
    | 'failed';
  /** The chat the turn runs in; `null` only while a NEW chat is being born. */
  chatId: EntityId | null;
  /** The agent message once known — the in-flight marker on a read, or the
   *  first delta. `null` before. */
  messageId: EntityId | null;
  /** ms epoch: the Send press, or — first seen on a reload or thread switch —
   *  the claimed agent message's `createdAt`. */
  startedAt: number;
  /** ms epoch at which the newest delta for this turn merged; `null` until one
   *  has. `now - (lastFrameAt ?? startedAt)` is the "since last step" figure. */
  lastFrameAt: number | null;
  /** The error part's message, when `failed`. */
  error?: string;
  /** ms epoch the turn ended, on `stopped` / `failed` — the row's clock
   *  freezes here rather than counting a dead turn. */
  endedAt?: number;
}

/**
 * The pipeline's own bookkeeping — what no frame and no snapshot carries.
 * Written ONLY by `ChatHomeScreen` (send, the frame handler, the thread load,
 * Stop); everything else reads the derived `TurnInProgress`.
 */
export interface TurnClock {
  /** `null` while a new chat is being born (chat.start not yet acked). */
  chatId: EntityId | null;
  startedAt: number;
  lastFrameAt: number | null;
  /** The in-flight agent message, once a delta or a read named it. */
  messageId: EntityId | null;
  /** Stop pressed, interrupt not yet resolved. */
  stopping: boolean;
  /** The turn ended with this error; held until the next send / switch. */
  error: string | null;
  /** Stamped when the turn is stopped or fails. */
  endedAt: number | null;
}

/** The composer's phase, as `ChatHomeScreen` spells it. */
export type TurnComposerPhase =
  | 'idle'
  | 'posting-root'
  | 'configuring'
  | 'posting-turn'
  | 'streaming'
  | 'stopped-continuable';

export interface TurnInProgressInput {
  phase: TurnComposerPhase;
  detail: ChatThreadDetail | null;
  clock: TurnClock | null;
}

export function startTurnClock(
  chatId: EntityId | null,
  startedAt: number,
  messageId: EntityId | null = null,
): TurnClock {
  return { chatId, startedAt, lastFrameAt: null, messageId, stopping: false, error: null, endedAt: null };
}

/** The claimed agent message on a read: the server's own in-flight marker. */
export function inFlightAgentTurn(detail: ChatThreadDetail | null): ChatTurn | null {
  if (!detail) return null;
  for (let index = detail.turns.length - 1; index >= 0; index -= 1) {
    const turn = detail.turns[index]!;
    if (turn.role === 'assistant' && turn.turnInFlight === true) return turn;
  }
  return null;
}

/** Pure: the turn in progress, or `null` when nothing is in flight. */
export function deriveTurnInProgress({ phase, detail, clock }: TurnInProgressInput): TurnInProgress | null {
  if (!clock) return null;
  // A clock for another conversation never describes this one.
  if (clock.chatId !== null && detail && clock.chatId !== detail.summary.rootId) return null;

  const agent =
    (clock.messageId !== null
      ? detail?.turns.find((turn) => turn.messageId === clock.messageId) ?? null
      : null) ?? inFlightAgentTurn(detail);

  let next: TurnInProgress['phase'];
  if (phase === 'posting-root' || phase === 'configuring' || phase === 'posting-turn') {
    next = 'sending';
  } else if (clock.error !== null) {
    next = 'failed';
  } else if (clock.stopping) {
    next = 'stopping';
  } else if (phase === 'stopped-continuable') {
    next = 'stopped';
  } else if (phase === 'streaming') {
    next = agent && projectTurnParts(agent.parts).length > 0 ? 'streaming' : 'waiting';
  } else {
    return null;
  }

  return {
    phase: next,
    chatId: clock.chatId,
    messageId: agent?.messageId ?? clock.messageId,
    startedAt: clock.startedAt,
    lastFrameAt: clock.lastFrameAt,
    ...(next === 'failed' ? { error: clock.error ?? 'The turn failed.' } : {}),
    ...((next === 'failed' || next === 'stopped') && clock.endedAt !== null
      ? { endedAt: clock.endedAt }
      : {}),
  };
}

/** `deriveTurnInProgress`, memoized on its three inputs. */
export function useTurnInProgress({ phase, detail, clock }: TurnInProgressInput): TurnInProgress | null {
  return useMemo(() => deriveTurnInProgress({ phase, detail, clock }), [phase, detail, clock]);
}
