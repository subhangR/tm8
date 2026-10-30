import type { BridgeConnectionStatus, BridgeStatus, BridgeTargetKind, BridgeView } from '@tm8/contract';
import type { PillTone } from '../kit';

/*
 * The words every bridge surface shares, so the Settings row, the panel header
 * and the Health tab can never name one state two ways. Status is ALWAYS
 * colour and word (tokens.css), so each status carries both.
 */

export const STATUS_WORD: Record<BridgeStatus, string> = {
  live: 'live',
  degraded: 'degraded',
  paused: 'paused',
  ended: 'removed',
};

export const STATUS_TONE: Record<BridgeStatus, PillTone> = {
  live: 'run',
  degraded: 'block',
  paused: 'wait',
  ended: 'idle',
};

export const CONNECTION_WORD: Record<BridgeConnectionStatus, string> = {
  linked: 'linked',
  connecting: 'connecting',
  logged_out: 'needs sign-in',
  offline: 'offline',
};

export const CONNECTION_TONE: Record<BridgeConnectionStatus, PillTone> = {
  linked: 'run',
  connecting: 'wait',
  logged_out: 'block',
  offline: 'block',
};

export const TARGET_WORD: Record<BridgeTargetKind, string> = {
  chat: 'chat',
  work_session: 'session',
  channel: 'channel',
};

export const TARGET_GLYPH: Record<BridgeTargetKind, string> = {
  chat: '💬',
  work_session: '▶',
  channel: '#',
};

/** `Infra (group, 14)` — the conversation as the list reads it. */
export function conversationLine(view: Pick<BridgeView, 'conversation'>): string {
  const { kind, title, memberCount } = view.conversation;
  const what = kind === 'dm' ? 'DM' : kind;
  return memberCount == null ? `${title} (${what})` : `${title} (${what}, ${memberCount})`;
}

/** `9 · 3 linked`, or a dash when nobody has written yet. */
export function peopleLine(view: Pick<BridgeView, 'people'>): string {
  const { participants, linked } = view.people;
  return participants === 0 ? '—' : `${participants} · ${linked} linked`;
}

/** The status word with its reason, the way a row says it: `degraded: The runtime has not checked in…`. */
export function statusLine(view: Pick<BridgeView, 'status' | 'health'>): string {
  const word = STATUS_WORD[view.status];
  return view.status === 'degraded' && view.health.detail ? `${word}: ${view.health.detail}` : word;
}

/** The words for a failed call. A `forbidden` always reads as a refusal. */
export function bridgeFailureOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'forbidden') return `Refused: ${message}`;
  if (code === 'version_conflict') return 'The bridge changed since this page read it. Reload and try again.';
  return message;
}
