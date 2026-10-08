import type { EntitySummary } from '@tm8/contract';

export type StatusTone = 'run' | 'done' | 'todo' | 'block' | 'info' | 'merged' | 'idle';

export interface PeerStatus {
  label: string;
  tone: StatusTone;
}

const TASK_STATUS: Record<string, PeerStatus> = {
  open: { label: 'open', tone: 'todo' },
  pulled: { label: 'pulled', tone: 'todo' },
  working: { label: 'working', tone: 'run' },
  in_review: { label: 'in review', tone: 'info' },
  done: { label: 'done', tone: 'done' },
  blocked: { label: 'blocked', tone: 'block' },
  cancelled: { label: 'cancelled', tone: 'idle' },
};

const SESSION_STATUS: Record<string, PeerStatus> = {
  spawning: { label: 'starting', tone: 'info' },
  running: { label: 'live', tone: 'run' },
  idle: { label: 'idle', tone: 'todo' },
  exited: { label: 'exited', tone: 'idle' },
  failed: { label: 'failed', tone: 'block' },
};

const PR_STATE: Record<string, PeerStatus> = {
  open: { label: 'open', tone: 'run' },
  merged: { label: 'merged', tone: 'merged' },
  closed: { label: 'closed', tone: 'idle' },
  draft: { label: 'draft', tone: 'todo' },
};

/**
 * The status a peer's summary already carries — task status, session state,
 * pull-request state. Null for kinds that have no status, rather than a
 * placeholder: the row simply draws none.
 */
export function peerStatus(peer: EntitySummary): PeerStatus | null {
  const state = peer.state as { kind?: string; status?: unknown; state?: unknown } | undefined;
  if (!state || state.kind !== peer.kind) return null;
  if (peer.kind === 'task' && typeof state.status === 'string') return TASK_STATUS[state.status] ?? null;
  if (peer.kind === 'work_session' && typeof state.status === 'string') return SESSION_STATUS[state.status] ?? null;
  if (peer.kind === 'pull_request' && typeof state.state === 'string') return PR_STATE[state.state] ?? null;
  return null;
}

/** A pull request's CI verdict, or a commit's short sha — the one forge fact a row adds. */
export function forgeFact(peer: EntitySummary): string | null {
  const state = peer.state as { kind?: string; ciStatus?: unknown; sha?: unknown; number?: unknown } | undefined;
  if (!state || state.kind !== peer.kind) return null;
  if (peer.kind === 'pull_request') {
    const parts: string[] = [];
    if (typeof state.number === 'number' && state.number > 0) parts.push(`#${state.number}`);
    if (state.ciStatus === 'passing') parts.push('CI passing');
    if (state.ciStatus === 'failing') parts.push('CI failing');
    if (state.ciStatus === 'pending') parts.push('CI running');
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (peer.kind === 'commit' && typeof state.sha === 'string' && state.sha.length > 0) return state.sha.slice(0, 7);
  return null;
}


export const isPullRequest = (peer: EntitySummary): boolean => peer.kind === 'pull_request';
export const messageCountLabel = (count: number): string => count === 1 ? 'message' : 'messages';
