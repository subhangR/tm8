import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RibbonMark } from '../kit';
import {
  announcementKey,
  isTicking,
  liveTurnView,
  type TurnInProgress,
} from './live-turn-status-model';
import { projectTurnParts } from './turn-model';
import type { StepLabels } from './turn-steps';
import type { ChatThreadDetail, ChatTurnPart } from './types';
import './live-turn-status.css';

/**
 * ── THE LIVE STATUS ROW — what the agent is doing, under the conversation ──
 *
 * Before this, the ONLY sign a turn was running was the composer's Send
 * button turning into Stop. A long multi-tool turn — silent for 12s on
 * average between blocks, 74s at worst (lane 1's measurement) — read as a
 * frozen screen. This row sits directly under the last turn and always says
 * what is happening, since when, and how long it has been quiet:
 *
 *   ◌ Thinking…  Read 3 tasks            step 7 · 1m 12s · last step 40s ago
 *
 * The words come from `live-turn-status-model.ts`; this file only draws them,
 * ticks the clock, and keeps the status region from being chatty.
 *
 * ── A11Y: ONE LIVE REGION, AND IT NEVER READS THE CLOCK ───────────────────
 *
 * The row is `role="status"`, but everything VISIBLE in it is `aria-hidden`.
 * What the region announces is one visually-hidden sentence that changes
 * immediately on a phase change (and on the 90s escalation), and otherwise at
 * most once every `ANNOUNCE_MIN_MS`. A step lands every few seconds and a
 * clock ticks every second; announcing either would talk over the transcript,
 * which is itself a polite live region. (Advisor ruling D16.5.)
 */

/** A new step may be announced at most this often; a phase change, at once. */
export const ANNOUNCE_MIN_MS = 10_000;

/**
 * THE MARK IS tm8's OWN WAIT GLYPH — `WaitMark`'s ribbon, at `WAIT_SEGMENTS`
 * (`ChatHomeScreen.tsx`, measured in `gate-evidence/`), not a generic spinner:
 * a second wait glyph would be a second language (advisor D20, amending D1).
 * Not imported from there because `ChatHomeScreen` imports this file.
 */
const LIVE_MARK_SEGMENTS = 60;

export interface LiveTurnStatusProps {
  turn: TurnInProgress;
  /** The in-flight agent message's stored parts, or null before it exists. */
  parts: readonly ChatTurnPart[] | null;
  /** The thread ledger's labels, so a write names its target. */
  labels?: StepLabels | undefined;
}

export function LiveTurnStatus({ turn, parts, labels }: LiveTurnStatusProps) {
  const ticking = isTicking(turn.phase);
  const now = useSecondTicker(ticking);
  const view = liveTurnView(turn, parts, now, labels);
  const spoken = useCalmAnnouncement(view.announcement, announcementKey(view));
  /* `sending` and `waiting` are the states the old transcript wait row stood
     for, and every test (and lane 1's) that asks for that row asks by this id,
     this role and this class. The other phases are a different fact. */
  const silent = turn.phase === 'sending' || turn.phase === 'waiting';

  return (
    <div
      className={`tch-live${silent ? ' tch-wait' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid={silent ? 'chat-thinking' : 'chat-live-turn'}
      data-phase={turn.phase}
      data-quiet={view.quiet === 'long' ? 'long' : undefined}
    >
      {view.glyph === 'spinner' ? (
        <span className="tch-live__mark" aria-hidden="true">
          <RibbonMark className="tch-live__ribbon" segments={LIVE_MARK_SEGMENTS} />
        </span>
      ) : (
        <span className={`tch-live__glyph tch-live__glyph--${view.glyph}`} aria-hidden="true">
          {view.glyph === 'stopped' ? '■' : '✕'}
        </span>
      )}
      <span className="tch-live__text" aria-hidden="true">
        <span className="tch-live__now" data-testid="chat-live-now">{view.now}</span>
        {view.aside ? (
          <span className="tch-live__aside" data-testid="chat-live-aside">{view.aside}</span>
        ) : null}
      </span>
      {view.meta ? (
        <span className="tch-live__meta" aria-hidden="true" data-testid="chat-live-meta">
          {view.meta}
        </span>
      ) : null}
      <span className="tch-live__sr" data-testid="chat-live-announcement">{spoken}</span>
    </div>
  );
}

/**
 * ── THE DOCK — the row, and the way back to it ────────────────────────────
 *
 * Sticky at the bottom of the transcript's scroll box, so the row is under the
 * last turn when the reader is there and still on screen when they are not.
 * A reader who scrolled up is never moved (`live-turn-status-follow.ts`); they
 * get `↓ Jump to latest` instead — in the row's right slot while a turn runs,
 * a pill of its own otherwise (D16.4). `N new` counts MESSAGES only: steps
 * arrive every few seconds, and a number that climbs on its own reads as a
 * notification rather than a position.
 *
 * `aria-live="off"`: the transcript around it is a polite live region, and
 * without this the pill's label changing would be read out as content. The
 * row inside keeps its own `role="status"`.
 */
export interface TranscriptDockProps {
  /** Lane 1's value; `null` when nothing is in flight. */
  turn: TurnInProgress | null;
  parts: readonly ChatTurnPart[] | null;
  labels?: StepLabels | undefined;
  away: boolean;
  unseen: number;
  onJump: () => void;
}

export function TranscriptDock({ turn, parts, labels, away, unseen, onJump }: TranscriptDockProps) {
  if (!turn && !away) return null;
  const label = unseen > 0 ? `Jump to latest · ${unseen} new` : 'Jump to latest';
  return (
    <div
      className="tch-dock"
      aria-live="off"
      data-testid="chat-dock"
      data-live={turn ? 'true' : undefined}
      data-phase={turn?.phase}
    >
      {turn ? <LiveTurnStatus turn={turn} parts={parts} labels={labels} /> : null}
      {away ? (
        <button type="button" className="tch-jump" data-testid="chat-jump-latest" onClick={onJump}>
          <span aria-hidden="true">↓ </span>
          {label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A clock that re-renders its owner once a second while `running`, and not
 * at all otherwise — a stopped or failed row is frozen, and must not keep a
 * timer alive for a number that no longer changes.
 */
function useSecondTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

/**
 * The status region's text, calmed: a change of `key` (a phase change, the
 * 90s escalation) is spoken at once; any other change waits until
 * `ANNOUNCE_MIN_MS` has passed since the last one and then says the LATEST
 * words, so a burst of steps is one announcement, not five.
 */
function useCalmAnnouncement(sentence: string, key: string): string {
  const [spoken, setSpoken] = useState(sentence);
  const lastRef = useRef({ at: Date.now(), key });
  useEffect(() => {
    if (sentence === spoken) return undefined;
    const say = () => {
      lastRef.current = { at: Date.now(), key };
      setSpoken(sentence);
    };
    const waited = Date.now() - lastRef.current.at;
    if (key !== lastRef.current.key || waited >= ANNOUNCE_MIN_MS) {
      say();
      return undefined;
    }
    const id = window.setTimeout(say, ANNOUNCE_MIN_MS - waited);
    return () => window.clearTimeout(id);
  }, [sentence, key, spoken]);
  return spoken;
}

/**
 * ── INTERIM — DELETE WHEN LANE 1's `turn-in-progress.ts` IS ON MAIN ────────
 *
 * OWNER of this value: lane 1 (`useTurnInProgress`, fed by the pipeline's own
 * clock in the frame handler). Merge order is lane 1 first, so on the rebase
 * the one call site in `ChatHomeScreen` becomes
 * `useTurnInProgress({ phase, detail, clock: turnClock })` and this function
 * goes. It exists only so this lane's row can be exercised before then, and
 * it deliberately covers only what today's state can say honestly —
 * `sending`, `waiting`, `streaming`. `stopping` / `stopped` / `failed` need
 * lane 1's clock, and are not faked here.
 */
export function useInterimTurnInProgress({
  phase,
  detail,
}: {
  phase: string;
  detail: ChatThreadDetail | null;
}): TurnInProgress | null {
  const sending = phase === 'posting-root' || phase === 'configuring' || phase === 'posting-turn';
  const streaming = phase === 'streaming' && detail !== null;
  const last = detail?.turns[detail.turns.length - 1];
  const agent =
    streaming && last?.role === 'assistant' && !last.parts.some((part) => part.kind === 'usage')
      && (last.turnInFlight === true || last.parts.length > 0)
      ? last
      : null;
  const key = sending || streaming ? (detail?.summary.rootId ?? 'new') : null;
  const partCount = agent?.parts.length ?? 0;
  const [clock, setClock] = useState<{
    key: string;
    startedAt: number;
    lastFrameAt: number | null;
    seen: number;
  } | null>(null);
  useLayoutEffect(() => {
    setClock((current) => {
      if (key === null) return null;
      const now = Date.now();
      if (!current || current.key !== key) {
        const claimed = agent ? Date.parse(agent.createdAt) : Number.NaN;
        return {
          key,
          startedAt: Number.isFinite(claimed) && claimed <= now ? claimed : now,
          lastFrameAt: partCount > 0 ? now : null,
          seen: partCount,
        };
      }
      return partCount === current.seen ? current : { ...current, lastFrameAt: now, seen: partCount };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by turn identity + part count
  }, [key, partCount]);
  if (key === null || !clock || clock.key !== key) {
    return key === null
      ? null
      : { phase: sending ? 'sending' : 'waiting', chatId: detail?.summary.rootId ?? null, messageId: agent?.messageId ?? null, startedAt: Date.now(), lastFrameAt: null };
  }
  return {
    phase: sending ? 'sending' : agent && projectTurnParts(agent.parts).length > 0 ? 'streaming' : 'waiting',
    chatId: detail?.summary.rootId ?? null,
    messageId: agent?.messageId ?? null,
    startedAt: clock.startedAt,
    lastFrameAt: clock.lastFrameAt,
  };
}
