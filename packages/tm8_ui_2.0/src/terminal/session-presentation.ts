import type { WorkSessionStatus } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';

/**
 * SESSION PRESENTATION — the single place a liveness verdict becomes pixels.
 *
 * TWO SOURCES, ONE RULE (LLD §2.2, §9.2, R-UI-5):
 *   · liveness classification is SEAM-owned — `seam.liveness.statusOf` is the
 *     only thing that may say whether a PTY is alive. The UI never derives it,
 *     and specifically never infers it from `activityAt` recency (D6's named
 *     forbidden inference).
 *   · byte-activity ("streaming") is POOL-owned — the §9.2 activity signal.
 *
 * They compose in exactly one direction: activity may only REFINE a `live`
 * verdict into `streaming`. It can never promote a non-live verdict, because
 * a pulse that outranked liveness would be the precise lie this whole
 * vocabulary exists to prevent. The gate is enforced HERE rather than at each
 * call site, so no caller can forget it.
 *
 * A THIRD, DIFFERENT FACT: the record's own `status`. Distinguishing exited
 * from failed from spawning among not-running sessions is contract data about
 * what happened, NOT a liveness claim, so consulting it is legal and
 * necessary — "failed" and "exited" are different things to tell a user.
 */

export type SessionPresentation =
  /** Live verdict AND bytes moving right now. */
  | 'streaming'
  /** Live verdict, quiet. Proven alive. */
  | 'running'
  /** Blocked on the user. Designed-but-dormant (R8) — no detector ships. */
  | 'needs-you'
  /** Record says running; the node does not list it. Amber, never green. */
  | 'stale'
  /** Proven not running, and the record agrees it ended. */
  | 'exited'
  /** Proven not running, and the record says it died badly. */
  | 'failed'
  /** Proven not running, and the record says it has not started yet. */
  | 'spawning'
  /**
   * NO FRESH SNAPSHOT. We do not know. Renders neutral — never live, never
   * exited — because claiming either would be inventing a measurement.
   */
  | 'unknown';

export interface PresentationInput {
  /** THE verdict. From seam.liveness.statusOf, never computed here. */
  liveness: SessionLiveness;
  /** The record's own status, from the contract EntityState. */
  recordedStatus?: WorkSessionStatus | null;
  /** Pool activity signal. Honored ONLY when the verdict is 'live'. */
  streaming?: boolean;
  /** R8-dormant attention predicate result. Honored only when alive. */
  needsAttention?: boolean;
}

export function presentSession(input: PresentationInput): SessionPresentation {
  const { liveness, recordedStatus, streaming, needsAttention } = input;

  switch (liveness) {
    case 'live':
      // Attention outranks streaming: an agent waiting on you is the more
      // actionable fact than an agent producing output.
      if (needsAttention) return 'needs-you';
      return streaming ? 'streaming' : 'running';

    case 'stale':
      return 'stale';

    case 'not-running':
      // The verdict settles "is there a PTY" (no). The record says which kind
      // of no this is.
      if (recordedStatus === 'failed') return 'failed';
      if (recordedStatus === 'spawning') return 'spawning';
      return 'exited';

    case 'unknown':
    default:
      return 'unknown';
  }
}

export type LivenessTone = 'run' | 'wait' | 'idle' | 'block';

export interface PresentationStyle {
  /** The WORD. Status is always color + word — never color alone (L10). */
  word: string;
  /** Longer form for tooltips/aria where the pill has no room for it. */
  full: string;
  tone: LivenessTone;
  /** Dot geometry: solid fill, hollow ring, or solid + pulse. */
  dot: 'solid' | 'hollow';
  pulse: boolean;
  /** True only for verdicts that actually PROVE a live PTY. */
  isLive: boolean;
}

const STYLES: Record<SessionPresentation, PresentationStyle> = {
  streaming: { word: 'streaming', full: 'streaming', tone: 'run', dot: 'solid', pulse: true, isLive: true },
  running: { word: 'running', full: 'running', tone: 'run', dot: 'solid', pulse: false, isLive: true },
  'needs-you': { word: 'needs you', full: 'needs you', tone: 'wait', dot: 'solid', pulse: true, isLive: true },
  stale: {
    word: 'stale',
    // NOT 'stale — node restarted'. That sentence is a VERDICT sentence and
    // the registry owns it (liveTreatment('stale').label); callers thread it
    // in as `statusDetail`. Carrying a copy here was the same drift A1a found
    // in the `unknown` fallback — I fixed the reported instance and left its
    // twin, which is why the class needed a grep rather than a memory.
    full: 'stale',
    tone: 'wait',
    dot: 'solid',
    pulse: false,
    isLive: false,
  },
  exited: { word: 'exited', full: 'exited', tone: 'idle', dot: 'hollow', pulse: false, isLive: false },
  failed: { word: 'failed', full: 'failed', tone: 'block', dot: 'solid', pulse: false, isLive: false },
  spawning: { word: 'spawning', full: 'spawning', tone: 'wait', dot: 'hollow', pulse: false, isLive: false },
  unknown: {
    // Deliberately not 'running' and not 'exited'. The pill states the record's
    // claim and immediately withdraws the guarantee.
    word: 'unverified',
    // NOT the registry's sentence restated. `liveTreatment('unknown').label`
    // owns the long form; this is only the pill's own minimal expansion, and
    // callers that have the registry row pass `statusDetail` so the tooltip
    // carries the authored sentence instead of this one.
    full: 'unverified',
    tone: 'idle',
    dot: 'hollow',
    pulse: false,
    isLive: false,
  },
};

export function presentationStyle(p: SessionPresentation): PresentationStyle {
  return STYLES[p];
}

/** Convenience: verdict + signals straight to style. */
export function sessionStyle(input: PresentationInput): PresentationStyle {
  return presentationStyle(presentSession(input));
}
