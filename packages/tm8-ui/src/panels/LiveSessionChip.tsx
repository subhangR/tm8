import type { TaskLiveSession } from '@tm8/contract';
import { relativeTime } from '../messages/messages-model';

/**
 * The "no live session" flag on a working or blocked task (task P0g). The
 * server derives `badges.liveSession` on every read; the owner's policy (form
 * 01a111ba-85b5, 6 Oct 2026) is FLAG ONLY, so this chip is the whole signal.
 * Nothing renders while someone is on the task (`live`, `person`).
 */
const CHIP: Record<TaskLiveSession['state'], { label: string; tone: 'block' | 'wait' | 'fyi'; why: string } | null> = {
  live: null,
  person: null,
  session_down: {
    label: 'Session crashed',
    tone: 'block',
    why: 'The session working on this task lost its process. Resume it, or stop it to free the task.',
  },
  no_session: {
    label: 'No live session',
    tone: 'wait',
    why: 'Nobody is working on this task. Claim it, or move it to the status it is really in.',
  },
  person_idle: {
    label: 'No activity 7d',
    tone: 'fyi',
    why: 'The person holding this task has not acted on it for 7 days.',
  },
};

export function liveSessionChipOf(live: TaskLiveSession | undefined): { label: string; tone: string; why: string } | null {
  return live ? CHIP[live.state] : null;
}

export function LiveSessionChip({ live, now = new Date() }: { live: TaskLiveSession | undefined; now?: Date }) {
  const chip = liveSessionChipOf(live);
  if (!live || !chip) return null;
  const age = live.since ? relativeTime(live.since, now) : '';
  const since = age === '' ? '' : age === 'now' ? ' Just now.' : ` For ${age}.`;
  return (
    <span
      className={`att-chip att-chip--${chip.tone}`}
      data-testid="live-session-chip"
      data-state={live.state}
      title={`${chip.why}${since}`}
    >
      <span className="att-chip__b" aria-hidden />
      <span>{chip.label}</span>
    </span>
  );
}
