/**
 * Pill — the status token. Always color + WORD (never color alone), with an
 * optional live-pulse dot for agents at work.
 */
import type { ReactNode } from 'react';
import type { WorkStatus } from '../types/contract';

export type PillTone =
  | 'working' | 'done' | 'blocked' | 'review' | 'stale' | 'waiting'
  | 'idle' | 'open' | 'neutral' | 'brand';

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  /** Show the leading status dot (default true — the color carrier). */
  dot?: boolean;
  /** Pulse the dot (live work). */
  pulse?: boolean;
  title?: string;
}

export function Pill({ tone = 'neutral', children, dot = true, pulse = false, title }: PillProps) {
  return (
    <span
      className={`cv2-pill cv2-pill--${tone}${pulse ? ' cv2-pill--pulse' : ''}`}
      title={title}
      data-tone={tone}
    >
      {dot && <span className="cv2-pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Canonical WorkStatus → tone mapping so every surface agrees. */
export function toneForWorkStatus(status: WorkStatus): PillTone {
  switch (status) {
    case 'working': return 'working';
    case 'done': return 'done';
    case 'blocked': return 'blocked';
    case 'in_review': return 'review';
    case 'pulled': return 'waiting';
    case 'cancelled': return 'idle';
    case 'open':
    default: return 'open';
  }
}

/** Human word for a WorkStatus (status is always color + word). */
export function labelForWorkStatus(status: WorkStatus): string {
  return status === 'in_review' ? 'in review' : status;
}
